import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PostgresStore } from '../src/postgres-store.js';
import { CloudRegistry } from '../src/cloud-registry.js';
import { cloudFixture, embeddedPool } from '../support/postgres.js';

test('categories distinguish availability from preloading without returning bodies', async () => {
  const { reader } = await cloudFixture();
  const categories = await reader.categories();
  assert.deepEqual(categories.categories.map((row) => row.ref), ['fentaris', 'general']);
  assert.equal(categories.categories.find((row) => row.ref === 'general').default, true);
  assert.equal(categories.categories.find((row) => row.ref === 'fentaris').default, undefined);
  assert.deepEqual((await reader.tree()).skills.map((row) => row.ref), ['general/git']);
  assert.deepEqual((await reader.tree({ categoryIds: ['fentaris'] })).skills.map((row) => row.ref), ['fentaris/coordination', 'general/git']);
  assert.equal(JSON.stringify(categories).includes('# Git'), false);
  await assert.rejects(reader.read({ ref: 'fentaris/coordination' }), { code: 'CATEGORY_NOT_ACTIVE' });
  assert.equal((await reader.read({ ref: 'fentaris/coordination', categoryIds: ['fentaris'] })).markdown, '# Fentaris\n');
});

test('durable sessions isolate agent identities, resume by ID and support versioned configuration', async () => {
  const { store, reader, readerToken, admin } = await cloudFixture();
  const bToken = await store.createToken({ accountId: readerToken.accountId, agentId: 'agent-b' });
  const b = new CloudRegistry(store, await store.authenticate(bToken.token));
  const opened = await reader.context({ action: 'open', categories: ['fentaris'], label: 'agent-a', discovery: { query: 'coordination' } });
  const id = opened.session.sessionId;
  assert.match(id, /^[a-f0-9-]{36}$/);
  assert.equal(opened.discovery.skills[0].ref, 'fentaris/coordination');
  assert.deepEqual((await reader.context({ action: 'open', sessionId: id })).session, opened.session);
  await assert.rejects(b.tree({ sessionId: id }), { code: 'SESSION_NOT_FOUND' });
  await assert.rejects(admin.context({ action: 'open', sessionId: id }), { code: 'SESSION_NOT_FOUND' });
  assert.deepEqual((await b.context({ action: 'list' })).sessions, []);
  await assert.rejects(reader.context({ action: 'configure', sessionId: id, categories: [], expectedVersion: 0 }), { code: 'VERSION_CONFLICT' });
  const changed = await reader.context({ action: 'configure', sessionId: id, mode: 'remove', categories: ['fentaris'], expectedVersion: 1 });
  assert.equal(changed.session.version, 2);
  assert.deepEqual((await reader.tree({ sessionId: id })).skills.map((row) => row.ref), ['general/git']);
  const rotated = await store.createToken({ accountId: readerToken.accountId, agentId: 'agent-a' });
  const resumed = new CloudRegistry(store, await store.authenticate(rotated.token));
  assert.equal((await resumed.context({ action: 'open', sessionId: id })).session.version, 2);
  await resumed.context({ action: 'close', sessionId: id, expectedVersion: 2 });
  await assert.rejects(reader.context({ action: 'open', sessionId: id }), { code: 'SESSION_NOT_FOUND' });
});

test('catalog and sessions persist across database restarts', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'skillgesture-postgres-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new PostgresStore({ pool: await embeddedPool(directory) });
  await store.initialize();
  const token = await store.createToken({ agentId: 'persistent-agent', admin: true });
  const principal = await store.authenticate(token.token);
  const registry = new CloudRegistry(store, principal);
  await registry.categoryManage({ action: 'upsert', id: 'persisted', name: 'Persisted' });
  await registry.skillManage({ action: 'upsert', ref: 'persisted/test', name: 'Test', markdown: '# Persisted' });
  const { session } = await registry.context({ action: 'open', categories: ['persisted'] });
  await store.close();
  const reopened = new PostgresStore({ pool: await embeddedPool(directory) });
  t.after(() => reopened.close());
  await reopened.initialize();
  const resumed = new CloudRegistry(reopened, await reopened.authenticate(token.token));
  assert.equal((await resumed.read({ sessionId: session.sessionId, ref: 'persisted/test' })).markdown, '# Persisted');
});

test('separate accounts cannot discover, edit, read or resume each other’s data', async () => {
  const { store, token, reader } = await cloudFixture();
  const otherToken = await store.createToken({ agentId: 'agent-a', admin: true });
  assert.notEqual(token.accountId, otherToken.accountId);
  const other = new CloudRegistry(store, await store.authenticate(otherToken.token));
  assert.deepEqual((await other.categories()).categories, []);
  await assert.rejects(other.skillManage({ action: 'get', ref: 'general/git' }), { code: 'SKILL_NOT_FOUND' });
  await assert.rejects(other.read({ ref: 'general/git', categoryIds: ['general'] }), { code: 'CATEGORY_NOT_AVAILABLE' });
  const { session } = await reader.context({ action: 'open' });
  await assert.rejects(other.context({ action: 'close', sessionId: session.sessionId, expectedVersion: 1 }), { code: 'SESSION_NOT_FOUND' });
});

test('tokens expire, revoke and never persist in plaintext; readers cannot administer', async () => {
  const { store, token, reader, readerToken } = await cloudFixture();
  const { rows } = await store.pool.query('SELECT token_hash FROM sg_tokens WHERE id=$1', [readerToken.id]);
  assert.equal(rows[0].token_hash.length, 64);
  assert.notEqual(rows[0].token_hash, readerToken.token);
  await assert.rejects(reader.categoryManage({ action: 'list' }), { code: 'FORBIDDEN' });
  await assert.rejects(reader.skillManage({ action: 'list' }), { code: 'FORBIDDEN' });
  await store.pool.query("UPDATE sg_tokens SET expires_at=now()-interval '1 second' WHERE id=$1", [readerToken.id]);
  assert.equal(await store.authenticate(readerToken.token), null);
  assert.deepEqual(await store.revokeToken(token.id), { revoked: true });
  assert.equal(await store.authenticate(token.token), null);
  assert.equal(await store.authenticate('invalid'), null);
});

test('concurrent catalog writes reject stale versions and retain immutable content', async () => {
  const { store, admin } = await cloudFixture();
  const attempts = await Promise.allSettled([
    admin.skillManage({ action: 'upsert', ref: 'general/git', markdown: '# A', expectedVersion: 1 }),
    admin.skillManage({ action: 'upsert', ref: 'general/git', markdown: '# B', expectedVersion: 1 }),
  ]);
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.find((result) => result.status === 'rejected').reason.code, 'VERSION_CONFLICT');
  const { rows } = await store.pool.query('SELECT version,markdown FROM sg_versions WHERE account_id=$1 AND ref=$2 ORDER BY version',
    [admin.principal.accountId, 'general/git']);
  assert.deepEqual(rows.map((row) => row.version), [1, 2]);
  assert.equal(rows[0].markdown, '# Git\n');
});

test('changing a reference moves the skill, subskills, immutable versions and resources in one account revision', async () => {
  const { store, admin, reader } = await cloudFixture();
  await admin.resourceManage({ action: 'upsert', ref: 'general/git', path: 'binary.bin', content: 'AAEC/w==', encoding: 'base64', expectedVersion: 1 });
  await admin.skillManage({ action: 'upsert', ref: 'general/git', markdown: '# Latest', expectedVersion: 2 });
  await admin.skillManage({ action: 'upsert', ref: 'general/git/review', name: 'Review', markdown: '# Review' });
  await admin.resourceManage({ action: 'upsert', ref: 'general/git/review', path: 'guide.md', content: 'Child guide', expectedVersion: 1 });
  await admin.skillManage({ action: 'upsert', ref: 'general/git/archived', name: 'Archived', markdown: '# Archived', enabled: false });
  await admin.skillManage({ action: 'delete', ref: 'general/git/archived', expectedVersion: 1 });
  const accountId = admin.principal.accountId;
  const initial = await reader.tree({ categoryIds: ['fentaris'] });
  const { rows: before } = await store.pool.query('SELECT revision FROM sg_accounts WHERE id=$1', [accountId]);
  const moved = await admin.skillManage({ action: 'upsert', previousRef: 'general/git', ref: 'fentaris/source-control',
    name: 'Source control', markdown: '# Renamed', expectedVersion: 3 });
  assert.deepEqual(moved, { version: 4 });
  await assert.rejects(admin.skillManage({ action: 'get', ref: 'general/git' }), { code: 'SKILL_NOT_FOUND' });
  assert.equal((await reader.read({ ref: 'fentaris/source-control', categoryIds: ['fentaris'] })).markdown, '# Renamed');
  assert.equal((await reader.read({ ref: 'fentaris/source-control/review', categoryIds: ['fentaris'] })).markdown, '# Review');
  assert.equal((await admin.skillManage({ action: 'get', ref: 'fentaris/source-control/review' })).skill.version, 3);
  assert.deepEqual((await reader.read({ ref: 'fentaris/source-control', categoryIds: ['fentaris'], resourcePath: 'binary.bin' })).resource.content, 'AAEC/w==');
  assert.equal((await reader.read({ ref: 'fentaris/source-control/review', categoryIds: ['fentaris'], resourcePath: 'guide.md' })).resource.content, 'Child guide');
  const archived = (await admin.skillManage({ action: 'get', ref: 'fentaris/source-control/archived', includeDeleted: true })).skill;
  assert.equal(archived.deleted, true); assert.equal(archived.enabled, false); assert.equal(archived.version, 3);
  const { rows: history } = await store.pool.query('SELECT version,markdown FROM sg_versions WHERE account_id=$1 AND ref=$2 ORDER BY version',
    [accountId, 'fentaris/source-control']);
  assert.deepEqual(history, [{ version: 1, markdown: '# Git\n' }, { version: 2, markdown: '# Git\n' }, { version: 3, markdown: '# Latest' }, { version: 4, markdown: '# Renamed' }]);
  const { rows: manifests } = await store.pool.query('SELECT version,path FROM sg_resources WHERE account_id=$1 AND ref=$2 ORDER BY version', [accountId, 'fentaris/source-control']);
  assert.deepEqual(manifests.map((row) => row.version), [2, 3, 4]);
  const { rows: after } = await store.pool.query('SELECT revision FROM sg_accounts WHERE id=$1', [accountId]);
  assert.equal(BigInt(after[0].revision), BigInt(before[0].revision) + 1n);
  assert.equal((await reader.tree({ categoryIds: ['fentaris'], knownIndexVersion: initial.indexVersion })).notModified, undefined);
  const { rows: old } = await store.pool.query("SELECT ref FROM sg_nodes WHERE account_id=$1 AND (ref='general/git' OR parent_ref='general/git')", [accountId]);
  assert.deepEqual(old, []);
});

test('reference changes reject collisions and invalid parents and roll back partial copies', async () => {
  const { store, admin } = await cloudFixture();
  const accountId = admin.principal.accountId;
  await admin.skillManage({ action: 'upsert', ref: 'general/git/review', name: 'Review' });
  const { rows: before } = await store.pool.query('SELECT revision FROM sg_accounts WHERE id=$1', [accountId]);
  for (const [ref, code] of [['fentaris/coordination', 'REF_ALREADY_EXISTS'], ['missing/git', 'CATEGORY_NOT_FOUND'],
    ['fentaris/missing/review', 'REF_HAS_SUBSKILLS'], ['general/git/review', 'REF_HAS_SUBSKILLS']]) {
    await assert.rejects(admin.skillManage({ action: 'upsert', previousRef: 'general/git', ref, expectedVersion: 1 }), { code });
  }
  await assert.rejects(admin.skillManage({ action: 'get', ref: 'general/git', previousRef: 'general/git' }), { code: 'INVALID_INPUT' });
  const newVersion = admin.newVersion;
  admin.newVersion = async () => { throw new Error('Injected copy failure'); };
  try {
    await assert.rejects(admin.skillManage({ action: 'upsert', previousRef: 'general/git', ref: 'fentaris/new-git', expectedVersion: 1 }), /Injected copy failure/);
  } finally { admin.newVersion = newVersion; }
  assert.equal((await admin.skillManage({ action: 'get', ref: 'general/git' })).skill.version, 1);
  assert.equal((await admin.skillManage({ action: 'get', ref: 'general/git/review' })).skill.version, 1);
  await assert.rejects(admin.skillManage({ action: 'get', ref: 'fentaris/new-git' }), { code: 'SKILL_NOT_FOUND' });
  const { rows: after } = await store.pool.query('SELECT revision FROM sg_accounts WHERE id=$1', [accountId]);
  assert.deepEqual(after, before);
});

test('a subskill can change parent or become a top-level skill without moving its old parent', async () => {
  const { admin, reader } = await cloudFixture();
  await admin.skillManage({ action: 'upsert', ref: 'general/git/review', name: 'Review', markdown: '# Review' });
  await assert.rejects(admin.skillManage({ action: 'upsert', previousRef: 'general/git/review', ref: 'fentaris/missing/review', expectedVersion: 1 }), { code: 'SKILL_NOT_FOUND' });
  await admin.skillManage({ action: 'upsert', previousRef: 'general/git/review', ref: 'fentaris/coordination/review', expectedVersion: 1 });
  assert.equal((await reader.read({ ref: 'fentaris/coordination/review', categoryIds: ['fentaris'] })).markdown, '# Review');
  await admin.skillManage({ action: 'upsert', previousRef: 'fentaris/coordination/review', ref: 'general/review', expectedVersion: 2 });
  assert.equal((await reader.read({ ref: 'general/review' })).markdown, '# Review');
  assert.equal((await admin.skillManage({ action: 'get', ref: 'general/git' })).skill.version, 1);
  assert.equal((await admin.skillManage({ action: 'get', ref: 'fentaris/coordination' })).skill.version, 1);
  await assert.rejects(admin.skillManage({ action: 'upsert', previousRef: 'general/review', ref: 'general/review/child', expectedVersion: 3 }), { code: 'INVALID_INPUT' });
});

test('reference changes require admin ownership and a current version, including simultaneous moves', async () => {
  const { store, admin, reader } = await cloudFixture();
  const change = { action: 'upsert', previousRef: 'general/git', ref: 'general/renamed', expectedVersion: 1 };
  await assert.rejects(reader.skillManage(change), { code: 'FORBIDDEN' });
  const otherToken = await store.createToken({ agentId: 'other', admin: true });
  const other = new CloudRegistry(store, await store.authenticate(otherToken.token));
  await other.categoryManage({ action: 'upsert', id: 'general', name: 'Other general' });
  await assert.rejects(other.skillManage(change), { code: 'SKILL_NOT_FOUND' });
  await assert.rejects(admin.skillManage({ ...change, expectedVersion: 0 }), { code: 'VERSION_CONFLICT' });
  const attempts = await Promise.allSettled([admin.skillManage(change), admin.skillManage({ ...change, ref: 'general/second' })]);
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.find((result) => result.status === 'rejected').reason.code, 'SKILL_NOT_FOUND');
  const skills = (await admin.skillManage({ action: 'list', categoryId: 'general' })).skills;
  assert.equal(skills.length, 1); assert.equal(skills[0].version, 2);
});

test('targeted resource writes preserve other resources and roll back failed mutations', async () => {
  const { store, admin, reader } = await cloudFixture();
  await admin.resourceManage({ action: 'upsert', ref: 'general/git', path: 'reference.txt', content: 'Reference', expectedVersion: 1 });
  await admin.resourceManage({ action: 'upsert', ref: 'general/git', path: 'binary.bin', content: 'AAEC/w==', encoding: 'base64', mimeType: 'application/octet-stream', expectedVersion: 2 });
  const binary = await reader.read({ ref: 'general/git', resourcePath: 'binary.bin' });
  assert.deepEqual(Buffer.from(binary.resource.content, 'base64'), Buffer.from([0, 1, 2, 255]));
  assert.equal(binary.resource.mimeType, 'application/octet-stream');
  await assert.rejects(admin.resourceManage({ action: 'delete', ref: 'general/git', path: 'missing', expectedVersion: 3 }), { code: 'RESOURCE_NOT_FOUND' });
  assert.equal((await admin.skillManage({ action: 'get', ref: 'general/git' })).skill.version, 3);
  await admin.resourceManage({ action: 'delete', ref: 'general/git', path: 'binary.bin', expectedVersion: 3 });
  assert.deepEqual((await reader.read({ ref: 'general/git' })).resources, [{ path: 'reference.txt' }]);
  const { rows } = await store.pool.query('SELECT path FROM sg_resources WHERE account_id=$1 AND ref=$2 AND version=3 ORDER BY path',
    [admin.principal.accountId, 'general/git']);
  assert.equal(rows.length, 2);
  await assert.rejects(reader.read({ ref: 'general/git', resourcePath: '../secret' }));
  await assert.rejects(reader.read({ ref: 'general/git', resourcePath: 'bad\0path' }), { name: 'ZodError' });
  await assert.rejects(admin.resourceManage({ action: 'upsert', ref: 'general/git', path: 'bad', content: '???', encoding: 'base64', expectedVersion: 4 }), { code: 'INVALID_INPUT' });
  await assert.rejects(admin.resourceManage({ action: 'upsert', ref: 'general/git', path: 'bad', content: 'AB==', encoding: 'base64', expectedVersion: 4 }), { code: 'INVALID_INPUT' });
  assert.equal((await admin.skillManage({ action: 'get', ref: 'general/git' })).skill.version, 4);
});

test('disabling/deleting parents hides descendants and invalidates discovery; deletion is reversible', async () => {
  const { admin, reader } = await cloudFixture();
  await admin.skillManage({ action: 'upsert', ref: 'general/git/advanced', name: 'advanced', markdown: '# Advanced' });
  const initial = await reader.tree();
  assert.equal(initial.skills[0].subskills[0].ref, 'general/git/advanced');
  await admin.skillManage({ action: 'upsert', ref: 'general/git', enabled: false, expectedVersion: 1 });
  assert.deepEqual((await reader.tree({ knownIndexVersion: initial.indexVersion })).skills, []);
  await assert.rejects(reader.read({ ref: 'general/git/advanced' }), { code: 'SKILL_NOT_ACTIVE' });
  await admin.skillManage({ action: 'upsert', ref: 'general/git', enabled: true, expectedVersion: 2 });
  await admin.categoryManage({ action: 'delete', id: 'general', expectedVersion: 1 });
  assert.deepEqual((await reader.tree()).skills, []);
  await admin.categoryManage({ action: 'restore', id: 'general', expectedVersion: 2 });
  assert.equal((await reader.read({ ref: 'general/git/advanced' })).markdown, '# Advanced');
  await admin.skillManage({ action: 'delete', ref: 'general/git', expectedVersion: 3 });
  await assert.rejects(reader.read({ ref: 'general/git/advanced' }), { code: 'SKILL_NOT_ACTIVE' });
  await admin.skillManage({ action: 'restore', ref: 'general/git', expectedVersion: 4 });
  assert.equal((await reader.read({ ref: 'general/git' })).markdown, '# Git\n');
});

test('discovery cache and cursors bind categories, query, session, identity and catalog revision', async () => {
  const { reader, admin } = await cloudFixture();
  await admin.skillManage({ action: 'upsert', ref: 'general/testing', name: 'testing', description: 'Test guidance' });
  const initial = await reader.tree({ limit: 1 });
  assert.equal(initial.truncated, true);
  assert.deepEqual(await reader.tree({ limit: 1, knownIndexVersion: initial.indexVersion }), { indexVersion: initial.indexVersion, notModified: true });
  assert.equal((await reader.tree({ limit: 1, cursor: initial.nextCursor })).skills[0].ref, 'general/testing');
  for (const options of [{ query: 'git' }, { categoryIds: ['fentaris'] }, { limit: 2 }]) {
    await assert.rejects(reader.tree({ limit: 1, cursor: initial.nextCursor, ...options }), { code: 'INVALID_CURSOR' });
  }
  await assert.rejects(admin.tree({ limit: 1, cursor: initial.nextCursor }), { code: 'INVALID_CURSOR' });
  await admin.categoryManage({ action: 'upsert', id: 'general', description: 'Changed', expectedVersion: 1 });
  await assert.rejects(reader.tree({ limit: 1, cursor: initial.nextCursor }), { code: 'INVALID_CURSOR' });
  assert.equal((await reader.tree({ query: 'git' })).skills[0].ref, 'general/git');
});

test('oversized discovery paginates within its byte budget and never omits continuation', async () => {
  const { reader, admin } = await cloudFixture();
  for (let i = 0; i < 40; i++) await admin.skillManage({ action: 'upsert', ref: `general/verbose-${String(i).padStart(2, '0')}`,
    name: `Verbose ${i}`, description: 'x'.repeat(1000) });
  const refs = [];
  let cursor;
  do {
    const result = await reader.tree({ limit: 50, cursor });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32 * 1024);
    assert.equal(result.truncated, result.nextCursor !== undefined);
    refs.push(...result.skills.map((row) => row.ref));
    cursor = result.nextCursor;
  } while (cursor);
  assert.equal(refs.length, 41);
  assert.equal(new Set(refs).size, 41);
});

test('concurrent session edits preserve one winner and report a version conflict', async () => {
  const { reader } = await cloudFixture();
  const { session } = await reader.context({ action: 'open' });
  const edits = await Promise.allSettled([
    reader.context({ action: 'configure', sessionId: session.sessionId, label: 'a', expectedVersion: 1 }),
    reader.context({ action: 'configure', sessionId: session.sessionId, label: 'b', expectedVersion: 1 }),
  ]);
  assert.equal(edits.filter((row) => row.status === 'fulfilled').length, 1);
  assert.equal(edits.find((row) => row.status === 'rejected').reason.code, 'VERSION_CONFLICT');
});

test('batch reads preserve order, isolate item errors and enforce the response byte budget', async () => {
  const { reader, admin } = await cloudFixture();
  const mixed = await reader.read({ items: [{ ref: 'general/git' }, { ref: 'fentaris/coordination' }, { ref: 'general/missing' }] });
  assert.deepEqual(mixed.items.map((row) => row.ok), [true, false, false]);
  assert.equal(mixed.items[1].error.code, 'CATEGORY_NOT_ACTIVE');
  for (let i = 0; i < 5; i++) await admin.skillManage({ action: 'upsert', ref: `general/large-${i}`, name: `large-${i}`, markdown: 'x'.repeat(250 * 1024) });
  const large = await reader.read({ items: Array.from({ length: 5 }, (_, i) => ({ ref: `general/large-${i}` })) });
  assert.ok(large.items.some((row) => row.error?.code === 'RESPONSE_TOO_LARGE'));
  assert.ok(Buffer.byteLength(JSON.stringify(large)) <= 1024 * 1024);
  await assert.rejects(reader.read({ ref: 'general/git', items: [{ ref: 'general/git' }] }));
});
