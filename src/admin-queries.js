import * as z from 'zod/v4';
import { CloudReadInput } from './cloud-contracts.js';
import { IdSchema } from './contracts.js';
import { indexVersion, lexicalRank } from './registry.js';
import { fail } from './errors.js';

const ActivityInput = z.strictObject({
  agent: z.string().min(1).max(120).optional(),
  operation: z.string().min(1).max(64).optional(),
  ref: z.string().min(1).max(194).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
  cursor: z.string().min(1).max(2048).optional(),
});
const CatalogInput = z.strictObject({
  kind: z.enum(['skill', 'category']).default('skill'),
  query: z.string().trim().min(1).max(200).optional(),
  categoryId: IdSchema.optional(),
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  includeDeleted: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  includeDisabled: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
});

// Ancestor state determines availability. Counts partition the current catalog;
// historical resource versions never inflate the resource count.
const NODE_STATE = `CASE WHEN c.deleted_at IS NOT NULL OR n.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL
  THEN 'archived' WHEN NOT c.enabled OR NOT n.enabled OR (p.ref IS NOT NULL AND NOT p.enabled)
  THEN 'disabled' ELSE 'active' END`;

export class AdminQueries {
  constructor(store, principal) { this.store = store; this.principal = principal; }
  admin() { if (!this.principal.admin) fail('FORBIDDEN', 'Administrative access is required'); }

  async catalog(raw) {
    this.admin();
    const input = CatalogInput.parse(raw);
    return this.store.transaction(async (client) => {
      const params = [this.principal.accountId, input.includeDeleted, input.includeDisabled];
      let rows;
      if (input.kind === 'category') {
        ({ rows } = await client.query(`SELECT c.*,
          CASE WHEN c.deleted_at IS NOT NULL THEN 'archived' WHEN NOT c.enabled THEN 'disabled' ELSE 'active' END AS state,
          (SELECT count(*)::integer FROM sg_nodes n
            LEFT JOIN sg_nodes p ON p.account_id=n.account_id AND p.ref=n.parent_ref
            WHERE n.account_id=c.account_id AND n.category_id=c.id
              AND ($2 OR (${NODE_STATE}) <> 'archived') AND ($3 OR (${NODE_STATE}) <> 'disabled')) AS "skillCount"
          FROM sg_categories c WHERE c.account_id=$1 AND ($2 OR c.deleted_at IS NULL)
            AND ($3 OR c.enabled) ORDER BY c.id`, params));
        const terms = input.query?.toLowerCase().split(/\s+/) ?? [];
        rows = rows.filter((row) => terms.every((term) => `${row.id} ${row.name} ${row.description}`.toLowerCase().includes(term)));
      } else {
        ({ rows } = await client.query(`SELECT * FROM (
          SELECT n.*,c.name AS "categoryName",c.description AS category_description,${NODE_STATE} AS state
          FROM sg_nodes n JOIN sg_categories c ON c.account_id=n.account_id AND c.id=n.category_id
            LEFT JOIN sg_nodes p ON p.account_id=n.account_id AND p.ref=n.parent_ref
          WHERE n.account_id=$1 AND ($4::text IS NULL OR n.category_id=$4)
        ) catalog WHERE ($2 OR state <> 'archived') AND ($3 OR state <> 'disabled') ORDER BY ref`,
        [...params, input.categoryId ?? null]));
        const ranked = rows.map((row) => ({ row, rank: lexicalRank({ id: row.category_id, description: row.category_description },
          { id: row.skill_id, name: row.name, description: row.description,
            subskills: row.subskill_id ? [{ id: row.subskill_id, name: row.name, description: row.description }] : [] }, input.query) }))
          .filter(({ rank }) => Number.isFinite(rank));
        if (input.query) ranked.sort((a, b) => a.rank - b.rank || a.row.ref.localeCompare(b.row.ref));
        rows = ranked.map(({ row }) => row);
      }
      const total = rows.length;
      const totalPages = Math.max(1, Math.ceil(total / input.limit));
      const currentPage = Math.min(input.page, totalPages);
      const items = rows.slice((currentPage - 1) * input.limit, currentPage * input.limit).map((row) => ({
        ref: row.ref ?? row.id, name: row.name, description: row.description, enabled: row.enabled,
        version: row.version, state: row.state, ...(row.deleted_at ? { deleted: true } : {}),
        ...(input.kind === 'category' ? { default: row.preload, skillCount: row.skillCount } : { categoryName: row.categoryName }),
      }));
      return { items, total, totalPages, page: currentPage, limit: input.limit };
    }, { readOnly: true });
  }

  async overview() {
    this.admin();
    return this.store.transaction(async (client) => {
      const accountId = this.principal.accountId;
      const { rows: accounts } = await client.query('SELECT revision FROM sg_accounts WHERE id=$1', [accountId]);
      if (!accounts[0]) fail('UNAUTHORIZED', 'Account is unavailable');
      const { rows } = await client.query(`
        SELECT 'categories' AS kind, CASE WHEN deleted_at IS NOT NULL THEN 'archived'
          WHEN enabled THEN 'active' ELSE 'disabled' END AS state, count(*)::integer AS count
        FROM sg_categories WHERE account_id=$1 GROUP BY state
        UNION ALL
        SELECT CASE WHEN n.parent_ref IS NULL THEN 'skills' ELSE 'subskills' END AS kind,
          ${NODE_STATE} AS state, count(*)::integer AS count
        FROM sg_nodes n JOIN sg_categories c ON c.account_id=n.account_id AND c.id=n.category_id
          LEFT JOIN sg_nodes p ON p.account_id=n.account_id AND p.ref=n.parent_ref
        WHERE n.account_id=$1 GROUP BY kind,state
        UNION ALL
        SELECT 'resources' AS kind, ${NODE_STATE} AS state, count(*)::integer AS count
        FROM sg_resources r JOIN sg_nodes n ON n.account_id=r.account_id AND n.ref=r.ref AND n.version=r.version
          JOIN sg_categories c ON c.account_id=n.account_id AND c.id=n.category_id
          LEFT JOIN sg_nodes p ON p.account_id=n.account_id AND p.ref=n.parent_ref
        WHERE r.account_id=$1 GROUP BY state`, [accountId]);
      const counts = Object.fromEntries(['categories', 'skills', 'subskills', 'resources']
        .map((kind) => [kind, { active: 0, disabled: 0, archived: 0, total: 0 }]));
      for (const row of rows) { counts[row.kind][row.state] = row.count; counts[row.kind].total += row.count; }
      return { identity: { accountId, agentId: this.principal.agentId, admin: true },
        revision: String(accounts[0].revision), counts, updatedAt: new Date().toISOString() };
    }, { readOnly: true });
  }

  async activity(raw) {
    this.admin();
    const input = ActivityInput.parse(raw);
    const scope = indexVersion({ accountId: this.principal.accountId,
      agent: input.agent, operation: input.operation, ref: input.ref, limit: input.limit });
    let before = null;
    if (input.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
        if (cursor.v !== 1 || cursor.scope !== scope || !/^[1-9][0-9]{0,18}$/.test(cursor.before)
          || BigInt(cursor.before) > 9223372036854775807n) throw new Error();
        before = cursor.before;
      } catch { fail('INVALID_CURSOR', 'Cursor does not match this activity query'); }
    }
    return this.store.transaction(async (client) => {
      const { rows } = await client.query(`SELECT id::text,agent_id AS "agentId",action AS operation,ref,version,created_at AS "createdAt"
        FROM sg_audit WHERE account_id=$1 AND ($2::text IS NULL OR agent_id=$2)
          AND ($3::text IS NULL OR action=$3) AND ($4::text IS NULL OR ref=$4)
          AND ($5::bigint IS NULL OR id<$5) ORDER BY sg_audit.id DESC LIMIT $6`,
      [this.principal.accountId, input.agent ?? null, input.operation ?? null, input.ref ?? null, before, input.limit + 1]);
      const truncated = rows.length > input.limit;
      const events = rows.slice(0, input.limit);
      return { events, truncated, ...(truncated ? { nextCursor: Buffer.from(JSON.stringify({ v: 1, scope,
        before: events.at(-1).id })).toString('base64url') } : {}) };
    }, { readOnly: true });
  }

  async content(raw) {
    this.admin();
    // Only a single current item; no session or runtime-category scope changes.
    const { ref, resourcePath } = CloudReadInput.parse(raw);
    if (!ref) fail('INVALID_INPUT', 'ref is required');
    return this.store.transaction(async (client) => {
      const accountId = this.principal.accountId;
      const { rows: nodes } = await client.query('SELECT version FROM sg_nodes WHERE account_id=$1 AND ref=$2', [accountId, ref]);
      if (!nodes[0]) fail('SKILL_NOT_FOUND', 'Skill does not exist');
      const version = nodes[0].version;
      if (resourcePath !== undefined) {
        const { rows } = await client.query(`SELECT r.encoding,r.mime_type AS "mimeType",r.size,b.bytes
          FROM sg_resources r JOIN sg_blobs b ON b.account_id=r.account_id AND b.hash=r.blob_hash
          WHERE r.account_id=$1 AND r.ref=$2 AND r.version=$3 AND r.path=$4`, [accountId, ref, version, resourcePath]);
        if (!rows[0]) fail('RESOURCE_NOT_FOUND', 'Resource does not exist');
        const { bytes, ...resource } = rows[0];
        return { ref, version, resource: { ...resource, content: Buffer.from(bytes).toString(resource.encoding) } };
      }
      const { rows } = await client.query('SELECT markdown FROM sg_versions WHERE account_id=$1 AND ref=$2 AND version=$3', [accountId, ref, version]);
      const { rows: resources } = await client.query(`SELECT path,mime_type AS "mimeType",encoding,size FROM sg_resources
        WHERE account_id=$1 AND ref=$2 AND version=$3 ORDER BY path`, [accountId, ref, version]);
      return { ref, version, markdown: rows[0].markdown, resources };
    }, { readOnly: true });
  }
}
