#!/usr/bin/env node

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
  console.error(`Skillgesture MCP server ready; storage: ${store.root}`);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('Skillgesture failed to start:', error);
    process.exitCode = 1;
  });
}
