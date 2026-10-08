import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  LooseOutputSchema,
  ManageInputSchema,
  ManageToolInputSchema,
  ReadInputSchema,
  TreeInputSchema,
} from './contracts.js';
import { errorPayload } from './errors.js';
import { minimalManage, minimalRead } from './presentation.js';

function response(payload, structuredOutput, isError = false) {
  return {
    content: structuredOutput ? [] : [{ type: 'text', text: JSON.stringify(payload) }],
    ...(structuredOutput ? { structuredContent: payload } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

function toolHandler(handler, structuredOutput) {
  return async (input) => {
    try {
      const result = await handler(input);
      return response({ ok: true, ...result }, structuredOutput);
    } catch (error) {
      // Keep errors readable even for structured clients that display only text.
      return response(errorPayload(error), false, true);
    }
  };
}

export function createMcpServer(registry, { structuredOutput = false } = {}) {
  const server = new McpServer({ name: 'skillgesture', version: '1.0.0' });
  const output = structuredOutput ? { outputSchema: LooseOutputSchema } : {};

  server.registerTool(
    'skill_tree',
    {
      title: 'List active skill tree',
      description: 'Discover enabled skill metadata. Default compact-v2 returns skill refs and descriptions with bounded search, pagination and cache checks. Omit sessionId for globals. Legacy and compact-v1 remain available.',
      inputSchema: TreeInputSchema,
      ...output,
    },
    toolHandler(({ sessionId, ...options }) => registry.tree(sessionId, options), structuredOutput),
  );

  server.registerTool(
    'skill_read',
    {
      title: 'Read active skills',
      description: 'Read one or up to eight skills or resources. Minimal output keeps contents, resource paths and per-item errors. Batches preserve order. Split discovery refs on / into groupId, skillId and optional subskillId. Omit sessionId for globals; format legacy restores metadata.',
      inputSchema: ReadInputSchema,
      ...output,
    },
    toolHandler(async ({ sessionId, items, format, ...item }) => {
      const result = items === undefined
        ? await registry.read(sessionId, item) : await registry.readMany(sessionId, items);
      return format === 'legacy' ? result : minimalRead(result);
    }, structuredOutput),
  );

  server.registerTool(
    'skill_manage',
    {
      title: 'Manage Skillgesture',
      description: [
        'Create/resume/configure durable sessions and manage the central skill catalog.',
        'Actions: session.open, session.configure, session.list, group.upsert, skill.upsert, subskill.upsert, node.setEnabled, association.set.',
        'Use session.open with canonical folders and optional discovery for scoped skills. Save sessionId and version. Minimal output returns identifiers and concurrency versions; format legacy restores metadata.',
      ].join(' '),
      inputSchema: ManageToolInputSchema,
      ...output,
    },
    toolHandler(async ({ format, ...input }) => {
      const { action, data } = ManageInputSchema.parse(input);
      const result = await registry.manage(action, data);
      return format === 'legacy' ? result : minimalManage(action, result);
    }, structuredOutput),
  );

  return server;
}
