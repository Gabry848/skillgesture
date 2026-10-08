#!/usr/bin/env node
// Compatibility entry point for local clients and migration tests.
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SkillRegistry } from './registry.js';
import { createMcpServer } from './server.js';
import { JsonStore } from './store.js';

export async function main({ root, structuredOutput = process.env.SKILLGESTURE_STRUCTURED_OUTPUT === '1' } = {}) {
  const store = new JsonStore(root);
  const registry = new SkillRegistry(store);
  await registry.initialize();
  const server = createMcpServer(registry, { structuredOutput });
  await server.connect(new StdioServerTransport());
  console.error('Skillgesture legacy stdio server ready');
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Skillgesture local startup failed'); process.exitCode = 1; });
}
