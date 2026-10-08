import { randomUUID } from 'node:crypto';
import { SkillgestureError, fail, errorPayload } from './errors.js';
import { indexVersion, encodeCursor, decodeCursor, lexicalRank } from './registry.js';
import {
  CategoryListInput, CloudTreeInput, CloudReadInput, ContextInput,
  CategoryManageInput, SkillManageInput, ResourceManageInput,
} from './cloud-contracts.js';
import { tokenHash } from './postgres-store.js';

const INDEX_BUDGET = 32 * 1024 - 64;
const READ_BUDGET = 1024 * 1024 - 64;

function checkVersion(row, expectedVersion) {
  if (row ? expectedVersion !== row.version : expectedVersion !== undefined && expectedVersion !== 0) {
    fail('VERSION_CONFLICT', row ? `Supply expectedVersion ${row.version}` : 'New nodes require expectedVersion 0',
      { currentVersion: row?.version ?? 0 });
  }
}

function describe(row, admin = false) {
  const ref = row.ref ?? row.id;
  const id = row.subskill_id ?? row.skill_id ?? row.id;
  return {
    ref,
    ...(row.name === id ? {} : { name: row.name }),
    ...(row.description ? { description: row.description } : {}),
    ...(row.enabled ? {} : { enabled: false }),
    ...(row.preload ? { default: true } : {}),
    ...(admin ? { version: row.version, ...(row.deleted_at ? { deleted: true } : {}) } : {}),
  };
}

function page(entries, key, version, options) {
  if (!options.cursor && options.knownIndexVersion === version) return { indexVersion: version, notModified: true };
  const offset = options.cursor ? decodeCursor(options.cursor, version) : 0;
  if (offset > entries.length) fail('INVALID_CURSOR', 'Cursor is outside this index');
  const build = (items) => ({
    indexVersion: version, truncated: offset + items.length < entries.length, [key]: items,
    ...(offset + items.length < entries.length
      ? { nextCursor: encodeCursor({ v: 1, indexVersion: version, offset: offset + items.length }) } : {}),
  });
  const selected = [];
  for (const entry of entries.slice(offset, offset + options.limit)) {
    if (Buffer.byteLength(JSON.stringify(build([...selected, entry]))) > INDEX_BUDGET) break;
    selected.push(entry);
  }
  if (!selected.length && offset < entries.length) fail('DISCOVERY_ITEM_TOO_LARGE', 'An entry exceeds the discovery budget');
  return build(selected);
}

function filterCategories(rows, query) {
  if (!query) return rows;
  const terms = query.toLowerCase().split(/\s+/);
  return rows.filter((row) => terms.every((term) => `${row.id} ${row.name} ${row.description}`.toLowerCase().includes(term)));
}

function sessionValue(row) {
  return { sessionId: row.id, version: row.version, ...(row.label ? { label: row.label } : {}),
    ...(row.categories.length ? { categories: row.categories } : {}) };
}

export class CloudRegistry {
  constructor(store, principal) {
    this.store = store;
    this.principal = Object.freeze({ ...principal });
  }

  admin() {
    if (!this.principal.admin) fail('FORBIDDEN', 'Administrative access is required');
  }

  async session(client, sessionId, lock = false) {
    const { rows } = await client.query(`SELECT * FROM sg_sessions
      WHERE id=$1 AND account_id=$2 AND agent_id=$3${lock ? ' FOR UPDATE' : ''}`,
    [sessionId, this.principal.accountId, this.principal.agentId]);
    if (!rows[0]) fail('SESSION_NOT_FOUND', 'Session does not exist for this agent');
    return rows[0];
  }

  async scope(client, { sessionId, categoryIds = [] } = {}) {
    const accountId = this.principal.accountId;
    const session = sessionId ? await this.session(client, sessionId) : null;
    const { rows: categories } = await client.query(`SELECT * FROM sg_categories
      WHERE account_id=$1 AND enabled AND deleted_at IS NULL ORDER BY id`, [accountId]);
    const available = new Set(categories.map((row) => row.id));
    if (categoryIds.some((id) => !available.has(id))) fail('CATEGORY_NOT_AVAILABLE', 'A requested category is unavailable');
    const active = [...new Set([
      ...categories.filter((row) => row.preload).map((row) => row.id),
      ...(session?.categories ?? []).filter((id) => available.has(id)), ...categoryIds,
    ])].sort();
    const { rows: accounts } = await client.query('SELECT revision FROM sg_accounts WHERE id=$1', [accountId]);
    if (!accounts[0]) fail('UNAUTHORIZED', 'Account is unavailable');
    return { categories, active, session,
      context: { accountId, agentId: this.principal.agentId, revision: accounts[0].revision,
        sessionId: session?.id ?? null, sessionVersion: session?.version ?? null, active } };
  }

  async categories(raw = {}) {
    const options = CategoryListInput.parse(raw);
    return this.store.transaction(async (client) => {
      const scope = await this.scope(client);
      const version = indexVersion({ ...scope.context, kind: 'categories', query: options.query, limit: options.limit });
      return page(filterCategories(scope.categories, options.query).map((row) => describe(row)), 'categories', version, options);
    }, { readOnly: true });
  }

  async tree(raw = {}) {
    const options = CloudTreeInput.parse(raw);
    return this.store.transaction(async (client) => {
      const scope = await this.scope(client, options);
      return this.treeInSnapshot(client, scope, options);
    }, { readOnly: true });
  }

  async treeInSnapshot(client, scope, options) {
    const categories = options.categoryId ? scope.active.filter((id) => id === options.categoryId) : scope.active;
    const { rows } = await client.query(`SELECT ref,category_id,skill_id,subskill_id,parent_ref,name,description,enabled,version
      FROM sg_nodes WHERE account_id=$1 AND category_id=ANY($2::text[]) AND deleted_at IS NULL AND enabled ORDER BY ref`,
    [this.principal.accountId, categories]);
    const children = new Map();
    for (const row of rows.filter((node) => node.parent_ref)) {
      if (!children.has(row.parent_ref)) children.set(row.parent_ref, []);
      children.get(row.parent_ref).push(row);
    }
    const byId = new Map(scope.categories.map((row) => [row.id, row]));
    const entries = rows.filter((node) => !node.parent_ref).map((node) => {
      const subskills = children.get(node.ref) ?? [];
      const group = byId.get(node.category_id);
      const rank = lexicalRank({ ...group, id: node.category_id },
        { ...node, id: node.skill_id, subskills: subskills.map((row) => ({ ...row, id: row.subskill_id })) }, options.query);
      return { node, subskills, rank };
    }).filter(({ rank }) => Number.isFinite(rank));
    if (options.query) entries.sort((a, b) => a.rank - b.rank || a.node.ref.localeCompare(b.node.ref));
    const version = indexVersion({ ...scope.context, kind: 'skills', categoryId: options.categoryId,
      query: options.query, limit: options.limit });
    return page(entries.map(({ node, subskills }) => ({ ...describe(node),
      ...(subskills.length ? { subskills: subskills.map((row) => describe(row)) } : {}) })), 'skills', version, options);
  }

  async readItem(client, scope, { ref, resourcePath }) {
    const [categoryId] = ref.split('/');
    if (!scope.active.includes(categoryId)) fail('CATEGORY_NOT_ACTIVE', 'Select this category in categoryIds or an agent session');
    const { rows } = await client.query(`SELECT n.* FROM sg_nodes n LEFT JOIN sg_nodes p
      ON p.account_id=n.account_id AND p.ref=n.parent_ref
      WHERE n.account_id=$1 AND n.ref=$2 AND n.enabled AND n.deleted_at IS NULL
        AND (n.parent_ref IS NULL OR (p.enabled AND p.deleted_at IS NULL))`, [this.principal.accountId, ref]);
    const node = rows[0];
    if (!node) fail('SKILL_NOT_ACTIVE', 'Skill is unavailable');
    if (resourcePath !== undefined) {
      const { rows: resources } = await client.query(`SELECT r.encoding,r.mime_type,b.bytes FROM sg_resources r
        JOIN sg_blobs b ON b.account_id=r.account_id AND b.hash=r.blob_hash
        WHERE r.account_id=$1 AND r.ref=$2 AND r.version=$3 AND r.path=$4`,
      [this.principal.accountId, ref, node.version, resourcePath]);
      if (!resources[0]) fail('RESOURCE_NOT_FOUND', 'Resource is not bundled with this skill');
      const resource = resources[0];
      return { resource: { content: Buffer.from(resource.bytes).toString(resource.encoding),
        encoding: resource.encoding, mimeType: resource.mime_type } };
    }
    const { rows: versions } = await client.query('SELECT markdown FROM sg_versions WHERE account_id=$1 AND ref=$2 AND version=$3',
      [this.principal.accountId, ref, node.version]);
    const { rows: resources } = await client.query('SELECT path FROM sg_resources WHERE account_id=$1 AND ref=$2 AND version=$3 ORDER BY path',
      [this.principal.accountId, ref, node.version]);
    return { markdown: versions[0].markdown, ...(resources.length ? { resources } : {}) };
  }

  async read(raw) {
    const input = CloudReadInput.parse(raw);
    return this.store.transaction(async (client) => {
      const scope = await this.scope(client, input);
      if (!input.items) return this.readItem(client, scope, input);
      const items = [];
      for (const item of input.items) {
        let result;
        try { result = { ok: true, ...await this.readItem(client, scope, item) }; }
        catch (error) {
          if (!(error instanceof SkillgestureError)) throw error;
          result = errorPayload(error);
        }
        if (Buffer.byteLength(JSON.stringify({ items: [...items, result] })) > READ_BUDGET) {
          result = { ok: false, error: { code: 'RESPONSE_TOO_LARGE', message: 'Request this item separately' } };
        }
        items.push(result);
      }
      return { items };
    }, { readOnly: true });
  }

  async context(raw) {
    const input = ContextInput.parse(raw);
    if (['configure', 'close'].includes(input.action) && !input.sessionId) fail('INVALID_INPUT', 'sessionId is required');
    if (input.action === 'list') {
      return this.store.transaction(async (client) => {
        const { rows: revision } = await client.query('SELECT revision FROM sg_accounts WHERE id=$1', [this.principal.accountId]);
        const { rows } = await client.query('SELECT * FROM sg_sessions WHERE account_id=$1 AND agent_id=$2 ORDER BY id',
          [this.principal.accountId, this.principal.agentId]);
        const version = indexVersion({ accountId: this.principal.accountId, agentId: this.principal.agentId,
          kind: 'sessions', revision: revision[0].revision, sessions: rows.map((row) => [row.id, row.version]),
          query: input.query, limit: input.limit });
        const filtered = input.query ? rows.filter((row) => row.label.toLowerCase().includes(input.query.toLowerCase())) : rows;
        return page(filtered.map(sessionValue), 'sessions', version, input);
      }, { readOnly: true });
    }
    return this.store.transaction(async (client) => {
      let row;
      if (input.action === 'open' && input.sessionId) {
        if (input.categories !== undefined || input.label !== undefined) fail('INVALID_INPUT', 'Use configure to change a resumed session');
        row = await this.session(client, input.sessionId, true);
      } else if (input.action === 'open') {
        const categories = await this.validateCategories(client, input.categories ?? []);
        const { rows } = await client.query(`INSERT INTO sg_sessions(id,account_id,agent_id,label,categories)
          VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [randomUUID(), this.principal.accountId, this.principal.agentId, input.label ?? '', categories]);
        row = rows[0];
      } else {
        row = await this.session(client, input.sessionId, true);
        checkVersion(row, input.expectedVersion);
        if (input.action === 'close') {
          await client.query('DELETE FROM sg_sessions WHERE id=$1 AND account_id=$2 AND agent_id=$3',
            [row.id, this.principal.accountId, this.principal.agentId]);
          return { closed: true };
        }
        if (input.categories === undefined && input.label === undefined) fail('INVALID_INPUT', 'Supply categories or label');
        // Removing a category must remain possible after an administrator disables it.
        const requested = input.mode === 'remove' ? (input.categories ?? [])
          : await this.validateCategories(client, input.categories ?? []);
        const categories = input.categories === undefined ? row.categories : input.mode === 'replace' ? requested
          : input.mode === 'add' ? [...new Set([...row.categories, ...requested])].sort()
            : row.categories.filter((id) => !requested.includes(id));
        const { rows } = await client.query(`UPDATE sg_sessions SET categories=$1,label=$2,version=version+1,updated_at=now()
          WHERE id=$3 AND account_id=$4 AND agent_id=$5 RETURNING *`,
        [categories, input.label ?? row.label, row.id, this.principal.accountId, this.principal.agentId]);
        row = rows[0];
      }
      const result = { session: sessionValue(row) };
      if (input.discovery) {
        const scope = await this.scope(client, { sessionId: row.id });
        result.discovery = await this.treeInSnapshot(client, scope, input.discovery);
      }
      return result;
    }, { snapshot: true });
  }

  async validateCategories(client, categories) {
    const unique = [...new Set(categories)].sort();
    const { rows } = await client.query(`SELECT id FROM sg_categories
      WHERE account_id=$1 AND id=ANY($2::text[]) AND enabled AND deleted_at IS NULL`, [this.principal.accountId, unique]);
    if (rows.length !== unique.length) fail('CATEGORY_NOT_AVAILABLE', 'A requested category is unavailable');
    return unique;
  }

  async categoryManage(raw) {
    this.admin();
    const input = CategoryManageInput.parse(raw);
    if (input.action !== 'upsert' && ['name', 'description', 'enabled', 'default'].some((key) => input[key] !== undefined)) {
      fail('INVALID_INPUT', 'Only upsert accepts category fields');
    }
    if (input.action !== 'list' && !input.id) fail('INVALID_INPUT', 'id is required');
    if (input.action === 'list' || input.action === 'get') {
      return this.store.transaction(async (client) => {
        const { rows } = await client.query(`SELECT * FROM sg_categories WHERE account_id=$1
          AND ($2::text IS NULL OR id=$2) AND ($3 OR deleted_at IS NULL) ORDER BY id`,
        [this.principal.accountId, input.action === 'get' ? input.id : null, input.includeDeleted]);
        if (input.action === 'get') {
          if (!rows[0]) fail('CATEGORY_NOT_FOUND', 'Category does not exist');
          return { category: { ...describe(rows[0], true), default: rows[0].preload, enabled: rows[0].enabled } };
        }
        const { rows: account } = await client.query('SELECT revision FROM sg_accounts WHERE id=$1', [this.principal.accountId]);
        const version = indexVersion({ accountId: this.principal.accountId, kind: 'admin-categories', revision: account[0].revision,
          includeDeleted: input.includeDeleted, query: input.query, limit: input.limit });
        return page(filterCategories(rows, input.query).map((row) => describe(row, true)), 'categories', version, input);
      }, { readOnly: true });
    }
    return this.store.mutate(this.principal, `category.${input.action}`, async (client) => {
      const { rows } = await client.query('SELECT * FROM sg_categories WHERE account_id=$1 AND id=$2', [this.principal.accountId, input.id]);
      const previous = rows[0];
      if (input.action !== 'upsert' && !previous) fail('CATEGORY_NOT_FOUND', 'Category does not exist');
      if (input.action === 'upsert' && previous?.deleted_at) fail('NODE_DELETED', 'Restore this category before editing');
      checkVersion(previous, input.expectedVersion);
      const version = (previous?.version ?? 0) + 1;
      if (input.action === 'upsert') {
        if (!previous && !input.name) fail('INVALID_INPUT', 'name is required for a new category');
        await client.query(`INSERT INTO sg_categories(account_id,id,name,description,enabled,preload,version)
          VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (account_id,id) DO UPDATE SET
          name=EXCLUDED.name,description=EXCLUDED.description,enabled=EXCLUDED.enabled,preload=EXCLUDED.preload,version=EXCLUDED.version`,
        [this.principal.accountId, input.id, input.name ?? previous.name, input.description ?? previous?.description ?? '',
          input.enabled ?? previous?.enabled ?? true, input.default ?? previous?.preload ?? false, version]);
      } else {
        await client.query('UPDATE sg_categories SET deleted_at=$1,version=$2 WHERE account_id=$3 AND id=$4',
          [input.action === 'delete' ? new Date() : null, version, this.principal.accountId, input.id]);
      }
      return { version };
    }, input.id);
  }

  async node(client, ref, { includeDeleted = false } = {}) {
    const { rows } = await client.query(`SELECT * FROM sg_nodes WHERE account_id=$1 AND ref=$2
      AND ($3 OR deleted_at IS NULL)`, [this.principal.accountId, ref, includeDeleted]);
    if (!rows[0]) fail('SKILL_NOT_FOUND', 'Skill does not exist');
    return rows[0];
  }

  async skillManage(raw) {
    this.admin();
    const input = SkillManageInput.parse(raw);
    if (input.action !== 'upsert' && ['name', 'description', 'enabled', 'markdown'].some((key) => input[key] !== undefined)) {
      fail('INVALID_INPUT', 'Only upsert accepts skill fields');
    }
    if (input.markdown !== undefined && (input.markdown.includes('\0') || Buffer.byteLength(input.markdown) > 256 * 1024)) {
      fail('INVALID_INPUT', 'Markdown must be valid text no larger than 256 KiB');
    }
    if (input.action !== 'list' && !input.ref) fail('INVALID_INPUT', 'ref is required');
    if (input.action === 'list' || input.action === 'get') {
      return this.store.transaction(async (client) => {
        if (input.action === 'get') {
          const row = await this.node(client, input.ref, input);
          const { rows: resources } = await client.query(`SELECT path,mime_type AS "mimeType",encoding,size
            FROM sg_resources WHERE account_id=$1 AND ref=$2 AND version=$3 ORDER BY path`,
          [this.principal.accountId, row.ref, row.version]);
          return { skill: { ...describe(row, true), enabled: row.enabled, ...(resources.length ? { resources } : {}) } };
        }
        const { rows } = await client.query(`SELECT n.*,c.description AS category_description FROM sg_nodes n
          JOIN sg_categories c ON c.account_id=n.account_id AND c.id=n.category_id
          WHERE n.account_id=$1 AND ($2::text IS NULL OR n.category_id=$2)
          AND ($3 OR (n.deleted_at IS NULL AND c.deleted_at IS NULL)) ORDER BY n.ref`,
        [this.principal.accountId, input.categoryId ?? null, input.includeDeleted]);
        const entries = rows.map((row) => ({ row, rank: lexicalRank({ id: row.category_id, description: row.category_description },
          { id: row.skill_id, name: row.name, description: row.description,
            subskills: row.subskill_id ? [{ id: row.subskill_id, name: row.name, description: row.description }] : [] }, input.query) }))
          .filter(({ rank }) => Number.isFinite(rank));
        if (input.query) entries.sort((a, b) => a.rank - b.rank || a.row.ref.localeCompare(b.row.ref));
        const { rows: account } = await client.query('SELECT revision FROM sg_accounts WHERE id=$1', [this.principal.accountId]);
        const version = indexVersion({ accountId: this.principal.accountId, kind: 'admin-skills', revision: account[0].revision,
          categoryId: input.categoryId, query: input.query, includeDeleted: input.includeDeleted, limit: input.limit });
        return page(entries.map(({ row }) => describe(row, true)), 'skills', version, input);
      }, { readOnly: true });
    }
    return this.store.mutate(this.principal, `skill.${input.action}`, async (client) => {
      const [categoryId, skillId, subskillId] = input.ref.split('/');
      const { rows: categories } = await client.query('SELECT id FROM sg_categories WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL',
        [this.principal.accountId, categoryId]);
      if (!categories.length) fail('CATEGORY_NOT_FOUND', 'Category does not exist');
      const parentRef = subskillId ? `${categoryId}/${skillId}` : null;
      if (parentRef) await this.node(client, parentRef);
      const { rows } = await client.query('SELECT * FROM sg_nodes WHERE account_id=$1 AND ref=$2', [this.principal.accountId, input.ref]);
      const previous = rows[0];
      if (input.action !== 'upsert' && !previous) fail('SKILL_NOT_FOUND', 'Skill does not exist');
      if (input.action === 'upsert' && previous?.deleted_at) fail('NODE_DELETED', 'Restore this skill before editing');
      checkVersion(previous, input.expectedVersion);
      const version = (previous?.version ?? 0) + 1;
      if (input.action === 'upsert') {
        if (!previous && !input.name) fail('INVALID_INPUT', 'name is required for a new skill');
        await client.query(`INSERT INTO sg_nodes(account_id,ref,category_id,skill_id,subskill_id,parent_ref,name,description,enabled,version)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(account_id,ref) DO UPDATE SET
          name=EXCLUDED.name,description=EXCLUDED.description,enabled=EXCLUDED.enabled,version=EXCLUDED.version`,
        [this.principal.accountId, input.ref, categoryId, skillId, subskillId ?? null, parentRef,
          input.name ?? previous.name, input.description ?? previous?.description ?? '', input.enabled ?? previous?.enabled ?? true, version]);
      } else {
        await client.query('UPDATE sg_nodes SET deleted_at=$1,version=$2 WHERE account_id=$3 AND ref=$4',
          [input.action === 'delete' ? new Date() : null, version, this.principal.accountId, input.ref]);
      }
      await this.newVersion(client, input.ref, previous?.version, version, input.markdown ?? (previous ? undefined : `# ${input.name}\n`));
      return { version };
    }, input.ref);
  }

  async newVersion(client, ref, previousVersion, version, markdown, skipResourcePath) {
    if (markdown !== undefined) {
      await client.query('INSERT INTO sg_versions(account_id,ref,version,markdown) VALUES ($1,$2,$3,$4)',
        [this.principal.accountId, ref, version, markdown]);
    } else {
      await client.query(`INSERT INTO sg_versions(account_id,ref,version,markdown)
        SELECT account_id,ref,$3,markdown FROM sg_versions WHERE account_id=$1 AND ref=$2 AND version=$4`,
      [this.principal.accountId, ref, version, previousVersion]);
    }
    if (previousVersion) {
      await client.query(`INSERT INTO sg_resources(account_id,ref,version,path,mime_type,encoding,size,blob_hash)
        SELECT account_id,ref,$3,path,mime_type,encoding,size,blob_hash FROM sg_resources
        WHERE account_id=$1 AND ref=$2 AND version=$4 AND ($5::text IS NULL OR path<>$5)`,
      [this.principal.accountId, ref, version, previousVersion, skipResourcePath ?? null]);
    }
  }

  async resourceManage(raw) {
    this.admin();
    const input = ResourceManageInput.parse(raw);
    if (input.action === 'upsert' && input.content === undefined) fail('INVALID_INPUT', 'content is required');
    if (input.action === 'delete' && input.content !== undefined) fail('INVALID_INPUT', 'delete does not accept content');
    if (input.encoding === 'base64' && input.content !== undefined
      && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.content)) {
      fail('INVALID_INPUT', 'content must be canonical Base64');
    }
    const buffer = input.content === undefined ? null : Buffer.from(input.content, input.encoding);
    if (buffer && input.encoding === 'base64' && buffer.toString('base64') !== input.content) {
      fail('INVALID_INPUT', 'content must be canonical Base64');
    }
    if (buffer && buffer.byteLength > 5 * 1024 * 1024) fail('INVALID_INPUT', 'A resource cannot exceed 5 MiB');
    return this.store.mutate(this.principal, `resource.${input.action}`, async (client) => {
      const node = await this.node(client, input.ref);
      const { rows: categories } = await client.query('SELECT id FROM sg_categories WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL',
        [this.principal.accountId, node.category_id]);
      if (!categories.length) fail('CATEGORY_NOT_FOUND', 'Category does not exist');
      if (node.parent_ref) await this.node(client, node.parent_ref);
      checkVersion(node, input.expectedVersion);
      const { rows: existing } = await client.query('SELECT path FROM sg_resources WHERE account_id=$1 AND ref=$2 AND version=$3 AND path=$4',
        [this.principal.accountId, input.ref, node.version, input.path]);
      if (input.action === 'delete' && !existing.length) fail('RESOURCE_NOT_FOUND', 'Resource does not exist');
      const version = node.version + 1;
      await this.newVersion(client, input.ref, node.version, version, undefined, input.path);
      if (buffer) {
        const hash = tokenHash(buffer);
        await client.query('INSERT INTO sg_blobs(account_id,hash,bytes) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
          [this.principal.accountId, hash, buffer]);
        await client.query(`INSERT INTO sg_resources(account_id,ref,version,path,mime_type,encoding,size,blob_hash)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [this.principal.accountId, input.ref, version, input.path, input.mimeType, input.encoding, buffer.byteLength, hash]);
      }
      const { rows: sizes } = await client.query('SELECT count(*)::integer AS count,coalesce(sum(size),0) AS size FROM sg_resources WHERE account_id=$1 AND ref=$2 AND version=$3',
        [this.principal.accountId, input.ref, version]);
      if (sizes[0].count > 200 || Number(sizes[0].size) > 20 * 1024 * 1024) fail('INVALID_INPUT', 'Skill resources exceed their count or size budget');
      await client.query('UPDATE sg_nodes SET version=$1 WHERE account_id=$2 AND ref=$3', [version, this.principal.accountId, input.ref]);
      return { version };
    }, input.ref);
  }
}
