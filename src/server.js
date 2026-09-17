import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  LooseOutputSchema,
  ManageInputSchema,
  ManageToolInputSchema,
  ReadInputSchema,
  TreeInputSchema,
} from './contracts.js';
import { errorPayload } from './errors.js';

function response(payload, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

function toolHandler(handler) {
  return async (input) => {
    try {
      const result = await handler(input);
      return response({ ok: true, ...result });
    } catch (error) {
      return response(errorPayload(error), true);
    }
  };
}

export function createMcpServer(registry) {
  const server = new McpServer({ name: 'skillgesture', version: '1.0.0' });

  server.registerTool(
    'skill_tree',
    {
      title: 'List active skill tree',
      description: 'Discover skill metadata without Markdown. Sessionless calls expose enabled globals. Legacy is default; compact-v1 adds bounded lexical search, cursors, truncation status, and notModified checks.',
      inputSchema: TreeInputSchema,
      outputSchema: LooseOutputSchema,
    },
    toolHandler(({ sessionId, ...options }) => registry.tree(sessionId, options)),
  );

  server.registerTool(
    'skill_read',
    {
      title: 'Read active skills',
      description: 'Load one or up to eight Markdown skill bodies or bundled resources. Batches preserve order with per-item status. Sessionless reads permit enabled global content only.',
      inputSchema: ReadInputSchema,
      outputSchema: LooseOutputSchema,
    },
    toolHandler(({ sessionId, items, ...item }) => (
      items === undefined ? registry.read(sessionId, item) : registry.readMany(sessionId, items)
    )),
  );

  server.registerTool(
    'skill_manage',
    {
      title: 'Manage Skillgesture',
      description: [
        'Create/resume/configure durable sessions and manage the central skill catalog.',
        'Actions: session.open, session.configure, session.list, group.upsert, skill.upsert, subskill.upsert, node.setEnabled, association.set.',
        'Sessionless discovery/read supports globals. Use session.open for exact canonical-folder scope and optionally include compact discovery in the same response. Persist returned session IDs.',
      ].join(' '),
      inputSchema: ManageToolInputSchema,
      outputSchema: LooseOutputSchema,
    },
    toolHandler((input) => {
      const { action, data } = ManageInputSchema.parse(input);
      return registry.manage(action, data);
    }),
  );

  return server;
}
