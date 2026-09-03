import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LooseOutputSchema, ManageInputSchema, ReadInputSchema, TreeInputSchema } from './contracts.js';
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
      description: 'Return a lightweight group → skill → subskill index for a durable session. Markdown bodies are never included.',
      inputSchema: TreeInputSchema,
      outputSchema: LooseOutputSchema,
    },
    toolHandler(({ sessionId, includeDisabled }) => registry.tree(sessionId, includeDisabled)),
  );

  server.registerTool(
    'skill_read',
    {
      title: 'Read one active skill',
      description: 'Load one Markdown skill body on demand. The skill must be enabled and active for the session.',
      inputSchema: ReadInputSchema,
      outputSchema: LooseOutputSchema,
    },
    toolHandler(({ sessionId, groupId, skillId, subskillId }) => registry.read(sessionId, {
      groupId,
      skillId,
      ...(subskillId === undefined ? {} : { subskillId }),
    })),
  );

  server.registerTool(
    'skill_manage',
    {
      title: 'Manage Skillgesture',
      description: [
        'Create/resume/configure durable sessions and manage the central skill catalog.',
        'Actions: session.open, session.configure, session.list, group.upsert, skill.upsert, subskill.upsert, node.setEnabled, association.set.',
        'Use session.open without sessionId once, persist its returned UUID, then reuse it in skill_tree and skill_read. Folder associations use exact canonical paths.',
      ].join(' '),
      inputSchema: ManageInputSchema,
      outputSchema: LooseOutputSchema,
    },
    toolHandler(({ action, data }) => registry.manage(action, data)),
  );

  return server;
}
