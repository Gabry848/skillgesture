import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { SkillRegistry } from '../src/registry.js';
import { CloudRegistry } from '../src/cloud-registry.js';
import { importLocalCatalog } from '../src/import-local.js';
import { cloudFixture } from '../support/postgres.js';

async function fixture(t) {
  const { store } = await cloudFixture();
  const token = await store.createToken({ agentId: 'importer', admin: true });
  const principal = await store.authenticate(token.token);
  const root = await mkdtemp(path.join(os.tmpdir(), 'skillgesture-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = new JsonStore(root);
  const legacy = new SkillRegistry(source);
  await legacy.initialize();
  await legacy.manage('group.upsert', { id: 'coding', name: 'Coding' });
  await legacy.manage('skill.upsert', { groupId: 'coding', id: 'git', name: 'Git', global: true, markdown: '# Old',
    resources: [{ path: 'old.txt', content: 'Historical resource' }] });
  await legacy.manage('skill.upsert', { groupId: 'coding', id: 'git', markdown: '# Current',
    resources: [{ path: 'binary.bin', content: 'AAEC/w==', encoding: 'base64', mimeType: 'application/octet-stream' }] });
  await legacy.manage('subskill.upsert', { groupId: 'coding', skillId: 'git', id: 'advanced', name: 'Advanced', markdown: '# Advanced' });
  return { store, principal, root, source, legacy, registry: new CloudRegistry(store, principal) };
}

test('local import preserves active versions, bodies, binary resources and original artifacts without changing the source', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.source.catalogPath);
  const result = await importLocalCatalog(f);
  assert.deepEqual(result, { categories: 1, skills: 1, subskills: 1, resources: 1 });
  assert.deepEqual(await readFile(f.source.catalogPath), before);
  assert.equal((await f.registry.skillManage({ action: 'get', ref: 'coding/git' })).skill.version, 2);
  assert.equal((await f.registry.read({ ref: 'coding/git' })).markdown, '# Current\n');
  const binary = await f.registry.read({ ref: 'coding/git', resourcePath: 'binary.bin' });
  assert.deepEqual(Buffer.from(binary.resource.content, 'base64'), Buffer.from([0, 1, 2, 255]));
  const { rows } = await f.store.pool.query('SELECT markdown FROM sg_versions WHERE account_id=$1 AND ref=$2 AND version=1', [f.principal.accountId, 'coding/git']);
  assert.equal(rows[0].markdown, '# Old\n');
  const archive = await f.store.pool.query(`SELECT b.bytes FROM sg_import_files f JOIN sg_blobs b
    ON b.account_id=f.account_id AND b.hash=f.blob_hash WHERE f.account_id=$1 AND f.path=$2`,
  [f.principal.accountId, 'skills/coding/git/versions/1/resources/old.txt']);
  assert.equal(Buffer.from(archive.rows[0].bytes).toString(), 'Historical resource');
  await assert.rejects(importLocalCatalog(f), { code: 'IMPORT_TARGET_NOT_EMPTY' });
});

test('mixed global/folder groups require explicit category defaults, and failed imports leave no partial catalog', async (t) => {
  const f = await fixture(t);
  await f.legacy.manage('skill.upsert', { groupId: 'coding', id: 'local', name: 'Local', markdown: '# Local' });
  await assert.rejects(importLocalCatalog(f), { code: 'MIGRATION_SCOPE_AMBIGUOUS' });
  assert.deepEqual((await f.registry.categories()).categories, []);
  await importLocalCatalog({ ...f, defaultCategories: [] });
  assert.deepEqual((await f.registry.tree()).skills, []);
  assert.equal((await f.registry.read({ ref: 'coding/local', categoryIds: ['coding'] })).markdown, '# Local\n');
});

test('missing immutable source content aborts the import transaction', async (t) => {
  const f = await fixture(t);
  const catalog = await f.source.readCatalog();
  await rm(f.source.resolveSkillPath(catalog.groups[0].skills[0].markdownPath));
  await assert.rejects(importLocalCatalog(f));
  assert.deepEqual((await f.registry.categoryManage({ action: 'list' })).categories, []);
  const { rows } = await f.store.pool.query('SELECT count(*)::integer AS count FROM sg_nodes WHERE account_id=$1', [f.principal.accountId]);
  assert.equal(rows[0].count, 0);
});
