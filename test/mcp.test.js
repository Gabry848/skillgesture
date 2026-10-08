import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SkillRegistry } from '../src/registry.js';
import { createMcpServer } from '../src/server.js';
import { JsonStore } from '../src/store.js';

async function connect(t, options) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skillgesture-mcp-'));
  const registry = new SkillRegistry(new JsonStore(root));
  await registry.initialize();
  const server = createMcpServer(registry, options);
  const client = new Client({ name: 'skillgesture-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  return client;
}

function toolValue(result) {
  return result.structuredContent ?? JSON.parse(result.content.find((item) => item.type === 'text').text);
}

async function call(client, action, data = {}) {
  const result = await client.callTool({ name: 'skill_manage', arguments: { action, data } });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return toolValue(result);
}

test('advertises exactly three text-only tools without structured output schemas', async (t) => {
  const client = await connect(t);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ['skill_manage', 'skill_read', 'skill_tree']);
  for (const tool of listed.tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal('outputSchema' in tool, false);
  }
  const manage = listed.tools.find((tool) => tool.name === 'skill_manage');
  assert.deepEqual(manage.inputSchema.required, ['action']);
  assert.ok(manage.inputSchema.properties.action);
  assert.ok(manage.inputSchema.properties.data);
});

test('supports session, lightweight tree, and on-demand read over MCP', async (t) => {
  const client = await connect(t);
  await call(client, 'group.upsert', { id: 'general', name: 'General' });
  await call(client, 'skill.upsert', {
    groupId: 'general',
    id: 'always',
    name: 'Always available',
    description: 'A global skill',
    global: true,
    markdown: '# Secret body\n\nRead `references/example.md` when needed.',
    resources: [{
      path: 'references/example.md',
      content: '# Supporting reference\n\nLoaded separately.',
      encoding: 'utf8',
      mimeType: 'text/markdown',
    }],
  });
  const opened = await call(client, 'session.open', { label: 'mcp-agent' });
  const sessionId = opened.session.sessionId;

  const treeResult = await client.callTool({ name: 'skill_tree', arguments: { sessionId, format: 'legacy' } });
  assert.notEqual(treeResult.isError, true, JSON.stringify(treeResult));
  assert.equal(JSON.stringify(toolValue(treeResult)).includes('Secret body'), false);

  const readResult = await client.callTool({
    name: 'skill_read',
    arguments: { sessionId, groupId: 'general', skillId: 'always' },
  });
  assert.notEqual(readResult.isError, true, JSON.stringify(readResult));
  assert.match(toolValue(readResult).markdown, /references\/example\.md/);
  assert.deepEqual(toolValue(readResult).resources.map((item) => item.path), ['references/example.md']);

  const resourceResult = await client.callTool({
    name: 'skill_read',
    arguments: {
      sessionId,
      groupId: 'general',
      skillId: 'always',
      resourcePath: 'references/example.md',
    },
  });
  assert.notEqual(resourceResult.isError, true, JSON.stringify(resourceResult));
  assert.match(toolValue(resourceResult).resource.content, /Loaded separately/);
});

test('supports sessionless global discovery and reads over MCP', async (t) => {
  const client = await connect(t);
  await call(client, 'group.upsert', { id: 'general', name: 'General' });
  await call(client, 'skill.upsert', {
    groupId: 'general', id: 'global', name: 'Global', global: true, markdown: '# Global',
  });
  await call(client, 'skill.upsert', {
    groupId: 'general', id: 'scoped', name: 'Scoped', markdown: '# Scoped',
  });

  const tree = await client.callTool({ name: 'skill_tree', arguments: { format: 'legacy' } });
  assert.notEqual(tree.isError, true, JSON.stringify(tree));
  assert.deepEqual(toolValue(tree).context, { scope: 'global-only', session: null });
  assert.deepEqual(toolValue(tree).groups[0].skills.map((skill) => skill.id), ['global']);

  const read = await client.callTool({
    name: 'skill_read', arguments: { groupId: 'general', skillId: 'global' },
  });
  assert.notEqual(read.isError, true, JSON.stringify(read));
  const scoped = await client.callTool({
    name: 'skill_read', arguments: { groupId: 'general', skillId: 'scoped' },
  });
  assert.equal(scoped.isError, true);
  assert.equal(toolValue(scoped).error.code, 'SESSION_REQUIRED');
});

test('supports open-with-discovery and ordered batch reads over MCP', async (t) => {
  const client = await connect(t);
  await call(client, 'group.upsert', { id: 'general', name: 'General' });
  await call(client, 'skill.upsert', {
    groupId: 'general', id: 'one', name: 'One', global: true, markdown: '# One',
  });
  await call(client, 'skill.upsert', {
    groupId: 'general', id: 'two', name: 'Two', global: true, markdown: '# Two',
  });
  const opened = await call(client, 'session.open', {
    discovery: { format: 'compact-v1', query: 'one', limit: 1 },
  });
  assert.equal(opened.discovery.format, 'compact-v1');
  assert.equal(opened.discovery.groups[0].skills[0].id, 'one');

  const batch = await client.callTool({
    name: 'skill_read',
    arguments: {
      items: [
        { groupId: 'general', skillId: 'two' },
        { groupId: 'general', skillId: 'missing' },
        { groupId: 'general', skillId: 'one' },
      ],
    },
  });
  assert.notEqual(batch.isError, true, JSON.stringify(batch));
  assert.deepEqual(toolValue(batch).items.map((item) => item.ok), [true, false, true]);
  assert.equal(toolValue(batch).items[1].error.code, 'SKILL_NOT_FOUND');

  const tooMany = await client.callTool({
    name: 'skill_read',
    arguments: { items: Array(9).fill({ groupId: 'general', skillId: 'one' }) },
  });
  assert.equal(tooMany.isError, true);
});

test('rejects malformed action payloads through the MCP schema', async (t) => {
  const client = await connect(t);
  const result = await client.callTool({
    name: 'skill_manage',
    arguments: { action: 'session.open', data: { foldres: [] } },
  });
  assert.equal(result.isError, true);
});

test('defaults to minimal discovery and reads with a single representation of unchanged Markdown', async (t) => {
  const client = await connect(t);
  await call(client, 'group.upsert', { id: 'general', name: 'General' });
  const markdown = '# Instructions\n\nPreserve `literal text` and Unicode: è ✓.\n';
  await call(client, 'skill.upsert', {
    groupId: 'general', id: 'guide', name: 'guide', description: 'Choose this for guidance',
    global: true, markdown,
  });
  const tree = await client.callTool({ name: 'skill_tree', arguments: {} });
  assert.equal('structuredContent' in tree, false);
  assert.equal(tree.content.length, 1);
  assert.deepEqual(toolValue(tree).skills, [{ ref: 'general/guide', description: 'Choose this for guidance' }]);
  const minimal = await client.callTool({ name: 'skill_read', arguments: { groupId: 'general', skillId: 'guide' } });
  assert.equal('structuredContent' in minimal, false);
  assert.deepEqual(toolValue(minimal), { ok: true, markdown });
  const legacy = await client.callTool({
    name: 'skill_read', arguments: { groupId: 'general', skillId: 'guide', format: 'legacy' },
  });
  assert.equal(toolValue(legacy).markdown, markdown);
  assert.equal(toolValue(legacy).description, 'Choose this for guidance');
  assert.ok(JSON.stringify(minimal).length < JSON.stringify(legacy).length);
});

test('minimal management preserves concurrency versions and scoped discovery sessions', async (t) => {
  const client = await connect(t);
  const created = await call(client, 'group.upsert', { id: 'general', name: 'General' });
  assert.deepEqual(created, { ok: true, version: 1 });
  const updated = await call(client, 'group.upsert', {
    id: 'general', description: 'Updated', expectedVersion: created.version,
  });
  assert.equal(updated.version, 2);
  const stale = await client.callTool({ name: 'skill_manage', arguments: {
    action: 'group.upsert', data: { id: 'general', expectedVersion: created.version },
  } });
  assert.equal(stale.isError, true);
  assert.equal(toolValue(stale).error.code, 'VERSION_CONFLICT');
  assert.equal(toolValue(stale).error.details.currentVersion, 2);
  const opened = await call(client, 'session.open', { discovery: {} });
  assert.match(opened.session.sessionId, /^[a-f0-9-]{36}$/);
  assert.equal(opened.session.version, 1);
  assert.deepEqual(opened.discovery.skills, []);
  assert.equal('createdAt' in opened.session, false);
  const listed = await call(client, 'session.list');
  assert.deepEqual(listed.sessions, [opened.session]);
  const legacy = await client.callTool({ name: 'skill_manage', arguments: {
    action: 'session.open', data: { sessionId: opened.session.sessionId }, format: 'legacy',
  } });
  assert.equal(toolValue(legacy).resumed, true);
  assert.ok(toolValue(legacy).session.createdAt);
});

test('minimal resource indices remain usable and binary decoding metadata survives', async (t) => {
  const client = await connect(t);
  await call(client, 'group.upsert', { id: 'general', name: 'General' });
  await call(client, 'skill.upsert', {
    groupId: 'general', id: 'binary', name: 'Binary', global: true, markdown: '# Binary',
    resources: [{ path: 'reference.bin', content: 'AAEC/w==', encoding: 'base64', mimeType: 'application/octet-stream' }],
  });
  const skill = toolValue(await client.callTool({ name: 'skill_read', arguments: { groupId: 'general', skillId: 'binary' } }));
  assert.deepEqual(skill.resources, [{ path: 'reference.bin' }]);
  const loaded = toolValue(await client.callTool({ name: 'skill_read', arguments: {
    groupId: 'general', skillId: 'binary', resourcePath: skill.resources[0].path,
  } }));
  assert.equal(loaded.resource.encoding, 'base64');
  assert.equal(loaded.resource.mimeType, 'application/octet-stream');
  assert.deepEqual(Buffer.from(loaded.resource.content, loaded.resource.encoding), Buffer.from([0, 1, 2, 255]));
  const traversal = await client.callTool({ name: 'skill_read', arguments: {
    groupId: 'general', skillId: 'binary', resourcePath: '../secret',
  } });
  assert.equal(traversal.isError, true);
});

test('structured clients receive valid schemas and a single structured payload', async (t) => {
  const client = await connect(t, { structuredOutput: true });
  const listed = await client.listTools();
  assert.ok(listed.tools.every((tool) => tool.outputSchema.type === 'object'));
  const result = await client.callTool({ name: 'skill_tree', arguments: {} });
  assert.deepEqual(result.content, []);
  assert.deepEqual(result.structuredContent.skills, []);
  const failed = await client.callTool({ name: 'skill_read', arguments: { groupId: 'missing', skillId: 'missing' } });
  assert.equal(failed.isError, true);
  assert.equal('structuredContent' in failed, false);
  assert.equal(toolValue(failed).error.code, 'GROUP_NOT_FOUND');
});

test('stdio entry point applies text and structured response modes without duplicate payloads', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skillgesture-stdio-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const structured of [false, true]) {
    const client = new Client({ name: 'stdio-verification', version: '1' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
      env: { ...process.env, SKILLGESTURE_HOME: root, SKILLGESTURE_STRUCTURED_OUTPUT: structured ? '1' : '0' },
      stderr: 'pipe',
    });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      assert.equal(listed.tools.some((tool) => tool.outputSchema), structured);
      const result = await client.callTool({ name: 'skill_tree', arguments: {} });
      assert.deepEqual(toolValue(result).skills, []);
      assert.equal('structuredContent' in result, structured);
      assert.equal(result.content.length, structured ? 0 : 1);
    } finally {
      await client.close();
      await transport.close();
    }
  }
});
