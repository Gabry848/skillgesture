import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LooseOutputSchema } from './contracts.js';
import { SkillgestureError, fail } from './errors.js';
import { toolHandler } from './server.js';
import { CategoryListInput, CloudTreeInput, CloudReadInput, ContextInput,
  CategoryManageInput, SkillManageInput, ResourceManageInput } from './cloud-contracts.js';

export function createCloudMcpServer(registry, { admin = false, structuredOutput = false } = {}) {
  if (admin) registry.admin();
  const server = new McpServer({ name: admin ? 'skillgesture-admin' : 'skillgesture', version: '2.0.0' });
  const output = structuredOutput ? { outputSchema: LooseOutputSchema } : {};
  const register = (name, description, inputSchema, method, readOnly) => {
    server.registerTool(name, { description, inputSchema, ...output,
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false },
    }, toolHandler(async (input) => {
      try { return await registry[method](input); }
      catch (error) {
        if (error instanceof SkillgestureError) throw error;
        if (error.name === 'ZodError') fail('INVALID_INPUT', 'Invalid tool arguments');
        fail('INTERNAL_ERROR', 'Operation failed');
      }
    }, structuredOutput));
  };
  register('skill_categories', 'List available categories; default categories are active automatically. Search, pagination and cache checks return metadata only.', CategoryListInput, 'categories', true);
  register('skill_tree', 'Find skill refs and descriptions in default or selected categories. Pass categoryIds for this request or sessionId for a durable agent context.', CloudTreeInput, 'tree', true);
  register('skill_read', 'Read ref or up to eight items, with optional resourcePath. Select optional categories via categoryIds or sessionId. Bodies and resources are loaded on demand.', CloudReadInput, 'read', true);
  register('skill_context', 'Open/resume, configure, list or close this agent’s durable sessions. Save sessionId and version; updates require expectedVersion. Open/configure can include discovery.', ContextInput, 'context', false);
  if (admin) {
    register('category_manage', 'List/get or upsert/delete/restore categories. default controls preloading; enabled controls availability. Existing categories require expectedVersion. Deletion is reversible.', CategoryManageInput, 'categoryManage', false);
    register('skill_manage', 'List/get metadata or upsert/delete/restore skills and subskills by category/skill[/subskill] ref. Existing nodes require expectedVersion. Deletion is reversible; responses omit bodies.', SkillManageInput, 'skillManage', false);
    register('resource_manage', 'Upsert or delete one bundled resource without resending the bundle. Requires the parent node’s expectedVersion; returns its new version. Binary contents use Base64.', ResourceManageInput, 'resourceManage', false);
  }
  return server;
}
