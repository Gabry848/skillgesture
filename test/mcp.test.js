import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SkillRegistry } from '../src/registry.js';
import { createMcpServer } from '../src/server.js';
import { JsonStore } from '../src/store.js';

async function connect(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skillgesture-mcp-'));
  const registry = new SkillRegistry(new JsonStore(root));
  await registry.initialize();
  const server = createMcpServer(registry);
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

async function call(client, action, data = {}) {
  const result = await client.callTool({ name: 'skill_manage', arguments: { action, data } });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return result.structuredContent;
}

test('advertises exactly three tools with input and output schemas', async (t) => {
  const client = await connect(t);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ['skill_manage', 'skill_read', 'skill_tree']);
  for (const tool of listed.tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.outputSchema.type, 'object');
  }
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
    markdown: '# Secret body\n\nLoaded only by skill_read.',
  });
  const opened = await call(client, 'session.open', { label: 'mcp-agent' });
  const sessionId = opened.session.sessionId;

  const treeResult = await client.callTool({ name: 'skill_tree', arguments: { sessionId } });
  assert.notEqual(treeResult.isError, true, JSON.stringify(treeResult));
  assert.equal(JSON.stringify(treeResult.structuredContent).includes('Secret body'), false);

  const readResult = await client.callTool({
    name: 'skill_read',
    arguments: { sessionId, groupId: 'general', skillId: 'always' },
  });
  assert.notEqual(readResult.isError, true, JSON.stringify(readResult));
  assert.match(readResult.structuredContent.markdown, /Loaded only by skill_read/);
});

test('rejects malformed action payloads through the MCP schema', async (t) => {
  const client = await connect(t);
  const result = await client.callTool({
    name: 'skill_manage',
    arguments: { action: 'session.open', data: { foldres: [] } },
  });
  assert.equal(result.isError, true);
});
