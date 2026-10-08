import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PostgresStore } from '../src/postgres-store.js';
import { CloudRegistry } from '../src/cloud-registry.js';
import { createCloudMcpServer } from '../src/cloud-server.js';
import { SkillRegistry } from '../src/registry.js';
import { embeddedPool } from '../support/embedded-pool.js';

const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const payload = (value) => ({ bytes: bytes(value), estimatedTokens: Math.ceil(bytes(value) / 4) });
const argument = process.argv.slice(2).find((value) => value.startsWith('--sizes='));
const sizes = argument ? argument.slice(8).split(',').map(Number) : process.argv.includes('--smoke') ? [10, 100] : [10, 100, 1000, 10000];
if (sizes.some((size) => !Number.isInteger(size) || size < 1 || size > 100000)) throw new Error('Invalid benchmark sizes');
const store = new PostgresStore({ pool: await embeddedPool() });
try {
  await store.initialize();
  const results = [];
  for (const size of sizes) {
    const accountId = randomUUID();
    const principal = { accountId, agentId: 'benchmark', admin: true };
    const skills = Array.from({ length: size }, (_, i) => ({ id: `skill-${String(i).padStart(5, '0')}`,
      name: `Skill ${i}`, description: `Development guidance ${i}`, enabled: true, global: true, subskills: [] }));
    await store.transaction(async (client) => {
      await client.query('INSERT INTO sg_accounts(id) VALUES ($1)', [accountId]);
      await client.query("INSERT INTO sg_categories(account_id,id,name,preload,version) VALUES ($1,'benchmark','Benchmark',true,1)", [accountId]);
      for (const skill of skills) {
        const ref = `benchmark/${skill.id}`;
        await client.query(`INSERT INTO sg_nodes(account_id,ref,category_id,skill_id,name,description,version)
          VALUES ($1,$2,'benchmark',$3,$4,$5,1)`, [accountId, ref, skill.id, skill.name, skill.description]);
        await client.query('INSERT INTO sg_versions(account_id,ref,version,markdown) VALUES ($1,$2,1,$3)', [accountId, ref, `# ${skill.name}`]);
      }
    });
    const registry = new CloudRegistry(store, principal);
    const start = performance.now();
    const discovery = await registry.tree({ limit: 50 });
    const milliseconds = performance.now() - start;
    const unchanged = await registry.tree({ limit: 50, knownIndexVersion: discovery.indexVersion });
    const legacy = new SkillRegistry({ readCatalog: async () => ({ revision: 0,
      groups: [{ id: 'benchmark', name: 'Benchmark', description: '', enabled: true, skills }] }),
    readAssociations: async () => ({ revision: 0, folders: {} }) });
    const matchedControl = await legacy.tree(undefined, { format: 'compact-v2', limit: 50 });
    if (JSON.stringify(discovery.skills) !== JSON.stringify(matchedControl.skills)) throw new Error('Control entries differ');
    const server = createCloudMcpServer(registry);
    const client = new Client({ name: 'cloud-benchmark', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b); await client.connect(a);
    try {
      const read = await client.callTool({ name: 'skill_read', arguments: { ref: 'benchmark/skill-00000' } });
      const items = skills.slice(0, 8).map((skill) => ({ ref: `benchmark/${skill.id}` }));
      const batch = await client.callTool({ name: 'skill_read', arguments: { items } });
      results.push({ size, returned: discovery.skills.length, truncated: discovery.truncated,
        discovery: payload(discovery), matchedLocalCompactV2: payload(matchedControl),
        notModified: payload(unchanged), runtimeToolDefinitions: payload(await client.listTools()),
        readEnvelope: payload(read), batchEnvelope: payload(batch), batchCalls: 1, individualCalls: items.length,
        discoveryMs: Math.round(milliseconds * 1000) / 1000 });
    } finally { await client.close(); await server.close(); }
  }
  console.log(JSON.stringify({ backend: 'embedded Postgres', note: 'Tokens use ceil(bytes/4); latency is informational. Local control returns identical entries.', results }, null, 2));
} finally { await store.close(); }
