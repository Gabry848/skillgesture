import { createHash, randomUUID } from 'node:crypto';
import { SCHEMA_VERSION } from './store.js';
import { errorPayload, fail } from './errors.js';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const COMPACT_BYTE_BUDGET = 32 * 1024;
const BATCH_BYTE_BUDGET = 1024 * 1024;

function requireObject(value, name = 'data') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', `${name} must be an object`);
  return value;
}

function requireId(value, name = 'id') {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail('INVALID_INPUT', `${name} must be a lowercase slug of up to 64 characters`);
  }
  return value;
}

function optionalText(value, name, maximum) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > maximum || (name === 'name' && value.trim().length === 0)) {
    fail('INVALID_INPUT', `${name} must be text of at most ${maximum} characters`);
  }
  return value.trim();
}

function requireBoolean(value, name) {
  if (typeof value !== 'boolean') fail('INVALID_INPUT', `${name} must be a boolean`);
  return value;
}

function checkVersion(node, expectedVersion) {
  if (expectedVersion !== undefined && node.version !== expectedVersion) {
    fail('VERSION_CONFLICT', `Expected version ${expectedVersion}, found ${node.version}`, {
      expectedVersion,
      currentVersion: node.version,
    });
  }
}

function findGroup(catalog, groupId) {
  const group = catalog.groups.find((candidate) => candidate.id === groupId);
  if (!group) fail('GROUP_NOT_FOUND', `Group ${groupId} does not exist`);
  return group;
}

function findSkill(catalog, groupId, skillId) {
  const group = findGroup(catalog, groupId);
  const skill = group.skills.find((candidate) => candidate.id === skillId);
  if (!skill) fail('SKILL_NOT_FOUND', `Skill ${groupId}/${skillId} does not exist`);
  return { group, skill };
}

function findSubskill(catalog, groupId, skillId, subskillId) {
  const { group, skill } = findSkill(catalog, groupId, skillId);
  const subskill = skill.subskills.find((candidate) => candidate.id === subskillId);
  if (!subskill) fail('SUBSKILL_NOT_FOUND', `Subskill ${groupId}/${skillId}/${subskillId} does not exist`);
  return { group, skill, subskill };
}

function skillKey(groupId, skillId) {
  return `${groupId}/${skillId}`;
}

function indexVersion(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(cursor, expectedVersion) {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      !value || typeof value !== 'object' || Array.isArray(value)
      || value.v !== 1 || value.indexVersion !== expectedVersion
      || !Number.isSafeInteger(value.offset) || value.offset < 0
      || Object.keys(value).sort().join(',') !== 'indexVersion,offset,v'
    ) throw new Error('invalid');
    return value.offset;
  } catch {
    fail('INVALID_CURSOR', 'Cursor is invalid or does not match this discovery index');
  }
}

function words(value) {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function lexicalRank(group, skill, query) {
  if (!query) return 0;
  const normalized = query.toLowerCase();
  const key = skillKey(group.id, skill.id);
  const refs = [skill.id, key];
  const names = [skill.name];
  const descriptions = [skill.description, group.description];
  for (const subskill of skill.subskills) {
    refs.push(subskill.id, `${key}/${subskill.id}`);
    names.push(subskill.name);
    descriptions.push(subskill.description);
  }
  if (refs.some((ref) => ref.toLowerCase() === normalized)) return 0;
  if (names.some((name) => name.toLowerCase().startsWith(normalized))) return 1;
  if (refs.some((ref) => ref.toLowerCase().startsWith(normalized))) return 2;
  const queryWords = words(normalized);
  if (queryWords.length === 0) return Number.POSITIVE_INFINITY;
  const nameWords = words(names.join(' '));
  if (queryWords.every((word) => nameWords.some((candidate) => candidate.startsWith(word)))) return 3;
  const descriptionWords = words(descriptions.join(' '));
  if (queryWords.every((word) => descriptionWords.some((candidate) => candidate.startsWith(word)))) return 4;
  return Number.POSITIVE_INFINITY;
}

function compactGroups(entries) {
  const groups = [];
  const byId = new Map();
  for (const { group, skill } of entries) {
    let projectedGroup = byId.get(group.id);
    if (!projectedGroup) {
      projectedGroup = {
        ref: group.id,
        id: group.id,
        name: group.name,
        description: group.description,
        skillCount: 0,
        skills: [],
      };
      byId.set(group.id, projectedGroup);
      groups.push(projectedGroup);
    }
    projectedGroup.skills.push({
      ref: skillKey(group.id, skill.id),
      id: skill.id,
      name: skill.name,
      description: skill.description,
      scope: skill.scope,
      subskillCount: skill.subskills.length,
      subskills: skill.subskills.map((subskill) => ({
        ref: `${skillKey(group.id, skill.id)}/${subskill.id}`,
        id: subskill.id,
        name: subskill.name,
        description: subskill.description,
      })),
    });
    projectedGroup.skillCount += 1;
  }
  return groups;
}

function normalizeRef(ref) {
  requireObject(ref, 'ref');
  return {
    groupId: requireId(ref.groupId, 'groupId'),
    skillId: requireId(ref.skillId, 'skillId'),
    ...(ref.subskillId === undefined ? {} : { subskillId: requireId(ref.subskillId, 'subskillId') }),
  };
}

function validateResourcePath(resourcePath) {
  if (
    typeof resourcePath !== 'string'
    || resourcePath.length === 0
    || resourcePath.length > 240
    || resourcePath.startsWith('/')
    || resourcePath.includes('\\')
    || resourcePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    fail('INVALID_INPUT', 'Resource paths must be safe relative POSIX paths');
  }
  return resourcePath;
}

async function writeResources(store, resources, basePath) {
  if (!Array.isArray(resources)) fail('INVALID_INPUT', 'resources must be an array');
  const seen = new Set();
  const stored = [];
  let totalSize = 0;
  for (const resource of resources) {
    requireObject(resource, 'resource');
    const resourcePath = validateResourcePath(resource.path);
    if (seen.has(resourcePath)) fail('INVALID_INPUT', `Duplicate resource path: ${resourcePath}`);
    seen.add(resourcePath);
    const encoding = resource.encoding ?? 'utf8';
    const mimeType = optionalText(resource.mimeType ?? 'text/plain', 'mimeType', 120);
    const storagePath = `${basePath}/resources/${resourcePath}`;
    const size = await store.writeResource(storagePath, resource.content, encoding);
    totalSize += size;
    if (totalSize > 20 * 1024 * 1024) fail('INVALID_INPUT', 'Skill resources cannot exceed 20 MiB in total');
    stored.push({ path: resourcePath, storagePath, mimeType, encoding, size });
  }
  return stored.sort((a, b) => a.path.localeCompare(b.path));
}

export class SkillRegistry {
  constructor(store) {
    this.store = store;
  }

  initialize() {
    return this.store.initialize();
  }

  async manage(action, data = {}) {
    requireObject(data);
    const handlers = {
      'session.open': () => this.openSession(data),
      'session.configure': () => this.configureSession(data),
      'session.list': () => this.listSessions(),
      'group.upsert': () => this.upsertGroup(data),
      'skill.upsert': () => this.upsertSkill(data),
      'subskill.upsert': () => this.upsertSubskill(data),
      'node.setEnabled': () => this.setNodeEnabled(data),
      'association.set': () => this.setAssociation(data),
    };
    const handler = handlers[action];
    if (!handler) fail('INVALID_ACTION', `Unsupported action: ${action}`);
    return handler();
  }

  async openSession(data) {
    if (data.sessionId !== undefined) {
      const session = await this.store.readSession(data.sessionId);
      const result = { session, resumed: true };
      if (data.discovery !== undefined) result.discovery = await this.tree(session.sessionId, data.discovery);
      return result;
    }

    const folders = await this.store.canonicalFolders(data.folders ?? []);
    const label = optionalText(data.label, 'label', 120) ?? '';
    const now = new Date().toISOString();
    const session = {
      schemaVersion: SCHEMA_VERSION,
      sessionId: randomUUID(),
      label,
      version: 1,
      folders,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.withLock(() => this.store.writeSession(session));
    const result = { session, resumed: false };
    if (data.discovery !== undefined) result.discovery = await this.tree(session.sessionId, data.discovery);
    return result;
  }

  async configureSession(data) {
    const sessionId = data.sessionId;
    const mode = data.mode ?? 'replace';
    if (!['replace', 'add', 'remove'].includes(mode)) fail('INVALID_INPUT', 'mode must be replace, add, or remove');
    const requestedFolders = await this.store.canonicalFolders(data.folders ?? []);

    return this.store.withLock(async () => {
      const session = await this.store.readSession(sessionId);
      checkVersion(session, data.expectedVersion);
      const current = new Set(session.folders);
      if (mode === 'replace') {
        session.folders = requestedFolders;
      } else if (mode === 'add') {
        requestedFolders.forEach((folder) => current.add(folder));
        session.folders = [...current].sort();
      } else {
        requestedFolders.forEach((folder) => current.delete(folder));
        session.folders = [...current].sort();
      }
      if (data.label !== undefined) session.label = optionalText(data.label, 'label', 120);
      session.version += 1;
      session.updatedAt = new Date().toISOString();
      await this.store.writeSession(session);
      return { session };
    });
  }

  async listSessions() {
    const sessions = await this.store.listSessions();
    return {
      sessions: sessions.map(({ sessionId, label, version, folders, createdAt, updatedAt }) => ({
        sessionId,
        label,
        version,
        folders,
        createdAt,
        updatedAt,
      })),
    };
  }

  async upsertGroup(data) {
    const id = requireId(data.id);
    return this.#mutateCatalog(async (catalog) => {
      let group = catalog.groups.find((candidate) => candidate.id === id);
      const created = !group;
      if (group) {
        checkVersion(group, data.expectedVersion);
      } else {
        if (data.expectedVersion !== undefined && data.expectedVersion !== 0) {
          fail('VERSION_CONFLICT', 'New groups require expectedVersion 0');
        }
        group = { id, name: id, description: '', enabled: true, version: 0, skills: [] };
        catalog.groups.push(group);
      }
      const name = optionalText(data.name, 'name', 120);
      const description = optionalText(data.description, 'description', 1000);
      if (created && name === undefined) fail('INVALID_INPUT', 'name is required when creating a group');
      if (name !== undefined) group.name = name;
      if (description !== undefined) group.description = description;
      if (data.enabled !== undefined) group.enabled = requireBoolean(data.enabled, 'enabled');
      group.version += 1;
      catalog.groups.sort((a, b) => a.name.localeCompare(b.name));
      return { group: structuredClone(group), created };
    });
  }

  async upsertSkill(data) {
    const groupId = requireId(data.groupId, 'groupId');
    const id = requireId(data.id);
    return this.#mutateCatalog(async (catalog) => {
      const group = findGroup(catalog, groupId);
      let skill = group.skills.find((candidate) => candidate.id === id);
      const created = !skill;
      if (skill) {
        checkVersion(skill, data.expectedVersion);
      } else {
        if (data.expectedVersion !== undefined && data.expectedVersion !== 0) fail('VERSION_CONFLICT', 'New skills require expectedVersion 0');
        skill = {
          id,
          name: id,
          description: '',
          enabled: true,
          global: false,
          version: 0,
          markdownPath: '',
          resources: [],
          subskills: [],
        };
        group.skills.push(skill);
      }
      const name = optionalText(data.name, 'name', 120);
      const description = optionalText(data.description, 'description', 1000);
      if (created && name === undefined) fail('INVALID_INPUT', 'name is required when creating a skill');
      if (name !== undefined) skill.name = name;
      if (description !== undefined) skill.description = description;
      if (data.enabled !== undefined) skill.enabled = requireBoolean(data.enabled, 'enabled');
      if (data.global !== undefined) skill.global = requireBoolean(data.global, 'global');
      const nextVersion = skill.version + 1;
      const versionRoot = `skills/${groupId}/${id}/versions/${nextVersion}`;
      if (data.markdown !== undefined || created) {
        const nextMarkdownPath = `${versionRoot}/SKILL.md`;
        await this.store.writeMarkdown(nextMarkdownPath, data.markdown ?? `# ${skill.name}\n`);
        skill.markdownPath = nextMarkdownPath;
      }
      if (data.resources !== undefined) skill.resources = await writeResources(this.store, data.resources, versionRoot);
      skill.version = nextVersion;
      group.skills.sort((a, b) => a.name.localeCompare(b.name));
      return { skill: structuredClone(skill), groupId, created };
    });
  }

  async upsertSubskill(data) {
    const groupId = requireId(data.groupId, 'groupId');
    const skillId = requireId(data.skillId, 'skillId');
    const id = requireId(data.id);
    return this.#mutateCatalog(async (catalog) => {
      const { skill } = findSkill(catalog, groupId, skillId);
      let subskill = skill.subskills.find((candidate) => candidate.id === id);
      const created = !subskill;
      if (subskill) {
        checkVersion(subskill, data.expectedVersion);
      } else {
        if (data.expectedVersion !== undefined && data.expectedVersion !== 0) fail('VERSION_CONFLICT', 'New subskills require expectedVersion 0');
        subskill = {
          id,
          name: id,
          description: '',
          enabled: true,
          version: 0,
          markdownPath: '',
          resources: [],
        };
        skill.subskills.push(subskill);
      }
      const name = optionalText(data.name, 'name', 120);
      const description = optionalText(data.description, 'description', 1000);
      if (created && name === undefined) fail('INVALID_INPUT', 'name is required when creating a subskill');
      if (name !== undefined) subskill.name = name;
      if (description !== undefined) subskill.description = description;
      if (data.enabled !== undefined) subskill.enabled = requireBoolean(data.enabled, 'enabled');
      const nextVersion = subskill.version + 1;
      const versionRoot = `skills/${groupId}/${skillId}/subskills/${id}/versions/${nextVersion}`;
      if (data.markdown !== undefined || created) {
        const nextMarkdownPath = `${versionRoot}/SKILL.md`;
        await this.store.writeMarkdown(nextMarkdownPath, data.markdown ?? `# ${subskill.name}\n`);
        subskill.markdownPath = nextMarkdownPath;
      }
      if (data.resources !== undefined) subskill.resources = await writeResources(this.store, data.resources, versionRoot);
      subskill.version = nextVersion;
      skill.subskills.sort((a, b) => a.name.localeCompare(b.name));
      return { subskill: structuredClone(subskill), groupId, skillId, created };
    });
  }

  async setNodeEnabled(data) {
    const ref = requireObject(data.ref, 'ref');
    const groupId = requireId(ref.groupId, 'groupId');
    const enabled = requireBoolean(data.enabled, 'enabled');
    return this.#mutateCatalog(async (catalog) => {
      if (ref.subskillId !== undefined && ref.skillId === undefined) {
        fail('INVALID_INPUT', 'subskillId requires skillId');
      }
      let node;
      let kind;
      if (ref.skillId === undefined) {
        node = findGroup(catalog, groupId);
        kind = 'group';
      } else if (ref.subskillId === undefined) {
        node = findSkill(catalog, groupId, requireId(ref.skillId, 'skillId')).skill;
        kind = 'skill';
      } else {
        node = findSubskill(
          catalog,
          groupId,
          requireId(ref.skillId, 'skillId'),
          requireId(ref.subskillId, 'subskillId'),
        ).subskill;
        kind = 'subskill';
      }
      checkVersion(node, data.expectedVersion);
      node.enabled = enabled;
      node.version += 1;
      return { kind, ref, enabled, version: node.version };
    });
  }

  async setAssociation(data) {
    const folder = await this.store.canonicalFolder(data.folder);
    if (!Array.isArray(data.skills)) fail('INVALID_INPUT', 'skills must be an array');
    const refs = data.skills.map(normalizeRef);
    if (refs.some((ref) => ref.subskillId !== undefined)) {
      fail('INVALID_INPUT', 'Associate parent skills; subskills inherit their parent association');
    }

    return this.store.withLock(async () => {
      const catalog = await this.store.readCatalog();
      const associations = await this.store.readAssociations();
      if (data.expectedRevision !== undefined && data.expectedRevision !== associations.revision) {
        fail('VERSION_CONFLICT', `Expected associations revision ${data.expectedRevision}, found ${associations.revision}`);
      }
      const keys = [...new Set(refs.map((ref) => {
        findSkill(catalog, ref.groupId, ref.skillId);
        return skillKey(ref.groupId, ref.skillId);
      }))].sort();
      if (keys.length === 0) delete associations.folders[folder];
      else associations.folders[folder] = keys;
      associations.revision += 1;
      await this.store.writeJsonAtomic(this.store.associationsPath, associations);
      return { folder, skills: keys, associationsRevision: associations.revision };
    });
  }

  async tree(sessionId, rawOptions = {}) {
    const options = typeof rawOptions === 'boolean' ? { includeDisabled: rawOptions } : rawOptions;
    requireObject(options, 'options');
    const format = options.format ?? 'legacy';
    const includeDisabled = options.includeDisabled ?? false;
    const limit = options.limit ?? 50;
    if (typeof includeDisabled !== 'boolean') fail('INVALID_INPUT', 'includeDisabled must be a boolean');
    if (!['legacy', 'compact-v1'].includes(format)) fail('INVALID_INPUT', 'format must be legacy or compact-v1');
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail('INVALID_INPUT', 'limit must be between 1 and 50');
    if (format === 'legacy' && [options.query, options.groupId, options.cursor, options.knownIndexVersion].some((value) => value !== undefined)) {
      fail('INVALID_INPUT', 'query, groupId, cursor, and knownIndexVersion require compact-v1');
    }
    const globalOnly = sessionId === undefined;
    const [session, catalog, associations] = await Promise.all([
      globalOnly ? Promise.resolve({ sessionId: null, version: null, folders: [] }) : this.store.readSession(sessionId),
      this.store.readCatalog(),
      this.store.readAssociations(),
    ]);
    const effectiveIncludeDisabled = globalOnly ? false : includeDisabled;
    const projection = this.#project(catalog, associations, session, effectiveIncludeDisabled);
    const context = { scope: globalOnly ? 'global-only' : 'session', session: session.sessionId };
    if (format === 'legacy') {
      return {
        sessionId: session.sessionId,
        sessionVersion: session.version,
        catalogRevision: catalog.revision,
        associationsRevision: associations.revision,
        folders: session.folders,
        context,
        groups: projection,
      };
    }

    const query = options.query?.trim().toLowerCase();
    const mode = {
      format,
      scope: context.scope,
      sessionId: session.sessionId,
      sessionVersion: session.version,
      catalogRevision: catalog.revision,
      associationsRevision: associations.revision,
      includeDisabled: effectiveIncludeDisabled,
      groupId: options.groupId ?? null,
      query: query ?? null,
    };
    const currentIndexVersion = indexVersion(mode);
    if (options.knownIndexVersion === currentIndexVersion && options.cursor === undefined) {
      return { format, context, indexVersion: currentIndexVersion, notModified: true };
    }
    const offset = options.cursor === undefined ? 0 : decodeCursor(options.cursor, currentIndexVersion);
    const entries = [];
    let available = 0;
    for (const group of projection) {
      if (options.groupId !== undefined && group.id !== options.groupId) continue;
      for (const skill of group.skills) {
        available += 1;
        const rank = lexicalRank(group, skill, query);
        if (Number.isFinite(rank)) entries.push({ group, skill, rank });
      }
    }
    if (query) {
      entries.sort((left, right) => left.rank - right.rank
        || skillKey(left.group.id, left.skill.id).localeCompare(skillKey(right.group.id, right.skill.id)));
    }
    if (offset > entries.length) fail('INVALID_CURSOR', 'Cursor offset is outside this discovery index');

    const build = (selected, nextOffset) => {
      const complete = nextOffset >= entries.length;
      return {
        format,
        context,
        indexVersion: currentIndexVersion,
        notModified: false,
        complete,
        truncated: !complete,
        counts: { matched: entries.length, returned: selected.length, available },
        groups: compactGroups(selected),
        ...(complete ? {} : {
          nextCursor: encodeCursor({ v: 1, indexVersion: currentIndexVersion, offset: nextOffset }),
          guidance: { action: 'continue', field: 'cursor' },
        }),
      };
    };
    const selected = [];
    const pageEnd = Math.min(entries.length, offset + limit);
    for (let position = offset; position < pageEnd; position += 1) {
      const candidate = [...selected, entries[position]];
      const payload = build(candidate, position + 1);
      if (Buffer.byteLength(JSON.stringify(payload)) > COMPACT_BYTE_BUDGET) break;
      selected.push(entries[position]);
    }
    if (selected.length === 0 && offset < entries.length) {
      fail('DISCOVERY_ITEM_TOO_LARGE', `A compact skill exceeds the ${COMPACT_BYTE_BUDGET}-byte discovery budget`);
    }
    return build(selected, offset + selected.length);
  }

  async read(sessionId, rawRef) {
    const ref = normalizeRef(rawRef);
    const requestedResourcePath = rawRef.resourcePath === undefined
      ? undefined
      : validateResourcePath(rawRef.resourcePath);
    const globalOnly = sessionId === undefined;
    const [session, catalog, associations] = await Promise.all([
      globalOnly ? Promise.resolve({ sessionId: null, version: null, folders: [] }) : this.store.readSession(sessionId),
      this.store.readCatalog(),
      this.store.readAssociations(),
    ]);
    const { group, skill } = findSkill(catalog, ref.groupId, ref.skillId);
    if (globalOnly && !skill.global) {
      fail('SESSION_REQUIRED', `Skill ${ref.groupId}/${ref.skillId} requires a session`);
    }
    const matchedFolders = this.#matchedFolders(associations, session, ref.groupId, ref.skillId);
    const active = group.enabled && skill.enabled && (skill.global || matchedFolders.length > 0);
    if (!active) fail('SKILL_NOT_ACTIVE', `Skill ${ref.groupId}/${ref.skillId} is not active in this session`);

    let node = skill;
    let kind = 'skill';
    if (ref.subskillId !== undefined) {
      node = findSubskill(catalog, ref.groupId, ref.skillId, ref.subskillId).subskill;
      kind = 'subskill';
      if (!node.enabled) fail('SKILL_NOT_ACTIVE', `Subskill ${ref.subskillId} is disabled`);
    }
    const common = {
      sessionId: session.sessionId,
      context: { scope: globalOnly ? 'global-only' : 'session', session: session.sessionId },
      catalogRevision: catalog.revision,
      kind,
      ref,
      name: node.name,
      description: node.description,
      scope: skill.global ? 'global' : 'folder',
      matchedFolders,
    };
    if (requestedResourcePath !== undefined) {
      const resource = node.resources.find((candidate) => candidate.path === requestedResourcePath);
      if (!resource) fail('RESOURCE_NOT_FOUND', `Resource ${requestedResourcePath} is not bundled with this skill`);
      const buffer = await this.store.readResource(resource.storagePath);
      return {
        ...common,
        resource: {
          path: resource.path,
          mimeType: resource.mimeType,
          encoding: resource.encoding,
          size: resource.size,
          content: buffer.toString(resource.encoding),
        },
      };
    }
    const markdown = await this.store.readMarkdown(node.markdownPath);
    return {
      ...common,
      markdown,
      resources: node.resources.map(({ path, mimeType, encoding, size }) => ({ path, mimeType, encoding, size })),
    };
  }

  async readMany(sessionId, items) {
    if (!Array.isArray(items) || items.length < 1 || items.length > 8) {
      fail('INVALID_INPUT', 'items must contain between 1 and 8 reads');
    }
    const context = { scope: sessionId === undefined ? 'global-only' : 'session', session: sessionId ?? null };
    const results = [];
    for (const item of items) {
      let candidate;
      try {
        const { context: ignoredContext, sessionId: ignoredSessionId, ...value } = await this.read(sessionId, item);
        candidate = { ok: true, ...value };
      } catch (error) {
        candidate = errorPayload(error);
      }
      if (Buffer.byteLength(JSON.stringify({ context, items: [...results, candidate] })) > BATCH_BYTE_BUDGET - 4096) {
        candidate = {
          ok: false,
          error: {
            code: 'RESPONSE_TOO_LARGE',
            message: `Item exceeds the ${BATCH_BYTE_BUDGET}-byte batch response budget; request it separately`,
          },
        };
      }
      results.push(candidate);
    }
    return { context, items: results };
  }

  #project(catalog, associations, session, includeDisabled) {
    const groups = [];
    for (const group of catalog.groups) {
      const skills = [];
      for (const skill of group.skills) {
        const matchedFolders = this.#matchedFolders(associations, session, group.id, skill.id);
        const applicable = skill.global || matchedFolders.length > 0;
        if (!applicable) continue;
        const active = group.enabled && skill.enabled;
        if (!includeDisabled && !active) continue;
        const subskills = skill.subskills
          .filter((subskill) => includeDisabled || (active && subskill.enabled))
          .map((subskill) => ({
            id: subskill.id,
            name: subskill.name,
            description: subskill.description,
            enabled: active && subskill.enabled,
            version: subskill.version,
          }));
        skills.push({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          enabled: active,
          global: skill.global,
          scope: skill.global ? 'global' : 'folder',
          matchedFolders,
          version: skill.version,
          subskills,
        });
      }
      if (skills.length > 0) {
        groups.push({
          id: group.id,
          name: group.name,
          description: group.description,
          enabled: group.enabled,
          version: group.version,
          skills,
        });
      }
    }
    return groups;
  }

  #matchedFolders(associations, session, groupId, skillId) {
    const key = skillKey(groupId, skillId);
    return session.folders.filter((folder) => associations.folders[folder]?.includes(key));
  }

  async #mutateCatalog(mutator) {
    return this.store.withLock(async () => {
      const catalog = await this.store.readCatalog();
      const result = await mutator(catalog);
      catalog.revision += 1;
      await this.store.writeJsonAtomic(this.store.catalogPath, catalog);
      return { ...result, catalogRevision: catalog.revision };
    });
  }
}

export { ID_PATTERN };
