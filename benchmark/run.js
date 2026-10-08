import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SkillRegistry } from '../src/registry.js';
import { createMcpServer } from '../src/server.js';
import { JsonStore } from '../src/store.js';
import { benchmarkSkillId, generateBenchmarkStore } from './generate.js';

const DEFAULT_SIZES = [10, 100, 1_000, 10_000];
const SMOKE_SIZES = [10, 100];

function sizesFromArguments(arguments_) {
  const option = arguments_.find((argument) => argument.startsWith('--sizes='));
  if (!option) return arguments_.includes('--smoke') ? SMOKE_SIZES : DEFAULT_SIZES;
  const sizes = option.slice('--sizes='.length).split(',').map(Number);
  if (sizes.length === 0 || sizes.some((size) => !Number.isInteger(size) || size < 1)) {
    throw new TypeError('--sizes must be a comma-separated list of positive integers');
  }
  return sizes;
}

async function timed(operation) {
  const started = performance.now();
  const value = await operation();
  return { milliseconds: performance.now() - started, value };
}

function payload(value) {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  return { bytes, estimatedTokens: Math.ceil(bytes / 4) };
}

function rounded(milliseconds) {
  return Math.round(milliseconds * 1_000) / 1_000;
}

function reduction(legacy, compact) {
  const bytes = legacy.bytes - compact.bytes;
  const estimatedTokens = legacy.estimatedTokens - compact.estimatedTokens;
  return {
    bytes,
    estimatedTokens,
    percent: Math.round((bytes / legacy.bytes) * 100_000) / 1_000,
  };
}

function requireToolSuccess(result) {
  if (result.isError) throw new Error(`Benchmark tool call failed: ${JSON.stringify(result.structuredContent)}`);
  return result;
}

async function callCounts(root, size) {
  const registry = new SkillRegistry(new JsonStore(root));
  let registryCalls = 0;
  const countedRegistry = {
    read(...arguments_) {
      registryCalls += 1;
      return registry.read(...arguments_);
    },
    readMany(...arguments_) {
      registryCalls += 1;
      return registry.readMany(...arguments_);
    },
  };
  const server = createMcpServer(countedRegistry);
  const client = new Client({ name: 'skillgesture-benchmark', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = {};
    for (const count of [1, 3, 8]) {
      const items = Array.from({ length: count }, (_, index) => ({
        groupId: 'benchmark', skillId: benchmarkSkillId(index, size),
      }));
      registryCalls = 0;
      let mcpCalls = 0;
      for (const item of items) {
        mcpCalls += 1;
        requireToolSuccess(await client.callTool({ name: 'skill_read', arguments: item }));
      }
      const singles = { mcpCalls, registryCalls };
      registryCalls = 0;
      mcpCalls = 1;
      requireToolSuccess(await client.callTool({ name: 'skill_read', arguments: { items } }));
      result[count] = { singles, batch: { mcpCalls, registryCalls } };
    }
    return result;
  } finally {
    await client.close();
    await server.close();
  }
}

async function benchmarkSize(base, size) {
  const root = path.join(base, String(size));
  const heapBeforeGeneration = process.memoryUsage().heapUsed;
  const generated = await timed(() => generateBenchmarkStore(root, size));
  const heapAfterGeneration = process.memoryUsage().heapUsed;

  const discoveryRegistry = new SkillRegistry(new JsonStore(root));
  const heapBeforeDiscovery = process.memoryUsage().heapUsed;
  const discoveryCold = await timed(() => discoveryRegistry.tree(undefined, { format: 'compact-v1' }));
  const heapAfterDiscovery = process.memoryUsage().heapUsed;
  const discoveryWarm = await timed(() => discoveryRegistry.tree(undefined, { format: 'compact-v1' }));
  const legacy = await discoveryRegistry.tree();
  const notModified = await discoveryRegistry.tree(undefined, {
    format: 'compact-v1', knownIndexVersion: discoveryWarm.value.indexVersion,
  });

  const query = benchmarkSkillId(size - 1, size);
  const searchRegistry = new SkillRegistry(new JsonStore(root));
  const searchCold = await timed(() => searchRegistry.tree(undefined, { format: 'compact-v1', query }));
  const searchWarm = await timed(() => searchRegistry.tree(undefined, { format: 'compact-v1', query }));

  const readRegistry = new SkillRegistry(new JsonStore(root));
  const ref = { groupId: 'benchmark', skillId: benchmarkSkillId(0, size) };
  const readCold = await timed(() => readRegistry.read(undefined, ref));
  const readWarm = await timed(() => readRegistry.read(undefined, ref));
  const legacyPayload = payload(legacy);
  const compactPayload = payload(discoveryWarm.value);

  return {
    skills: size,
    payload: {
      legacy: legacyPayload,
      compact: compactPayload,
      compactVsLegacyReduction: reduction(legacyPayload, compactPayload),
      search: payload(searchWarm.value),
      notModified: payload(notModified),
    },
    latencyMs: {
      generation: rounded(generated.milliseconds),
      discoveryCold: rounded(discoveryCold.milliseconds),
      discoveryWarm: rounded(discoveryWarm.milliseconds),
      searchCold: rounded(searchCold.milliseconds),
      searchWarm: rounded(searchWarm.milliseconds),
      readCold: rounded(readCold.milliseconds),
      readWarm: rounded(readWarm.milliseconds),
    },
    memory: {
      generationHeapDeltaBytes: heapAfterGeneration - heapBeforeGeneration,
      coldProjectionHeapDeltaBytes: heapAfterDiscovery - heapBeforeDiscovery,
      indexLifetime: 'request-local',
    },
    discovery: {
      complete: discoveryWarm.value.complete,
      returned: discoveryWarm.value.counts.returned,
      matched: discoveryWarm.value.counts.matched,
    },
    ...(size >= 8 ? { loadCallCounts: await callCounts(root, size) } : {}),
  };
}

const sizes = sizesFromArguments(process.argv.slice(2));
const base = await mkdtemp(path.join(os.tmpdir(), 'skillgesture-benchmark-'));
try {
  const results = [];
  for (const size of sizes) results.push(await benchmarkSize(base, size));
  console.log(JSON.stringify({
    note: 'Timing and heap figures are informational and are not CI assertions.',
    sizes,
    results,
  }, null, 2));
} finally {
  await rm(base, { recursive: true, force: true });
}
