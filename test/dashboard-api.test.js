import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { cloudFixture } from '../support/postgres.js';
import { createHttpServer } from '../src/http-server.js';

async function fixture(t) {
  const f = await cloudFixture();
  const server = createHttpServer({ store: f.store, publicUrl: 'http://127.0.0.1:0/mcp',
    allowInsecureLocalhost: true, allowedOrigins: ['http://127.0.0.1:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, token = f.token.token, headers = {}) => fetch(`${base}/api/admin/${path}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  });
  return { ...f, server, base, get };
}

test('admin HTTP reads authenticate every request and isolate account identity, catalog and content', async (t) => {
  const f = await fixture(t);
  const other = await f.store.createToken({ agentId: 'other', admin: true });
  for (const path of ['overview', 'activity', 'content?ref=general/git']) {
    assert.equal((await f.get(path, null)).status, 401);
    assert.equal((await f.get(path, f.readerToken.token)).status, 403);
  }
  const overview = await (await f.get('overview')).json();
  assert.deepEqual(overview.identity, { accountId: f.token.accountId, agentId: 'admin', admin: true });
  assert.equal(overview.revision, '4');
  const foreign = await (await f.get('overview', other.token)).json();
  assert.equal(foreign.counts.skills.total, 0);
  assert.deepEqual((await (await f.get('activity', other.token)).json()).events, []);
  assert.equal((await f.get('content?ref=general/git', other.token)).status, 404);
  await f.store.revokeToken(f.token.id);
  assert.equal((await f.get('overview')).status, 401);
  await f.store.pool.query("UPDATE sg_tokens SET expires_at=now()-interval '1 second' WHERE id=$1", [other.id]);
  assert.equal((await f.get('activity', other.token)).status, 401);
});

test('overview partitions effective ancestor states and counts only current resources', async (t) => {
  const f = await fixture(t);
  await f.admin.skillManage({ action: 'upsert', ref: 'general/git/child', name: 'Child', markdown: '# Child' });
  await f.admin.resourceManage({ action: 'upsert', ref: 'general/git/child', path: 'notes.txt', content: 'one', expectedVersion: 1 });
  await f.admin.resourceManage({ action: 'upsert', ref: 'general/git/child', path: 'notes.txt', content: 'two', expectedVersion: 2 });
  await f.admin.skillManage({ action: 'upsert', ref: 'general/git', enabled: false, expectedVersion: 1 });
  await f.admin.categoryManage({ action: 'delete', id: 'fentaris', expectedVersion: 1 });
  const result = await (await f.get('overview')).json();
  assert.deepEqual(result.counts.categories, { active: 1, disabled: 0, archived: 1, total: 2 });
  assert.deepEqual(result.counts.skills, { active: 0, disabled: 1, archived: 1, total: 2 });
  assert.deepEqual(result.counts.subskills, { active: 0, disabled: 1, archived: 0, total: 1 });
  assert.deepEqual(result.counts.resources, { active: 0, disabled: 1, archived: 0, total: 1 });
  await f.admin.skillManage({ action: 'delete', ref: 'general/git', expectedVersion: 2 });
  const archived = await (await f.get('overview')).json();
  assert.equal(archived.counts.subskills.archived, 1);
  assert.equal(archived.counts.resources.archived, 1);
});

test('admin content reads current disabled and archived Markdown and binary resources without widening runtime scope', async (t) => {
  const f = await fixture(t);
  await f.admin.resourceManage({ action: 'upsert', ref: 'general/git', path: 'asset.bin',
    content: 'AAEC/w==', encoding: 'base64', mimeType: 'application/octet-stream', expectedVersion: 1 });
  await f.admin.skillManage({ action: 'upsert', ref: 'general/git', enabled: false, markdown: '# New', expectedVersion: 2 });
  assert.equal((await (await f.get('content?ref=general/git')).json()).markdown, '# New');
  await assert.rejects(f.reader.read({ ref: 'general/git' }), { code: 'SKILL_NOT_ACTIVE' });
  await f.admin.skillManage({ action: 'delete', ref: 'general/git', expectedVersion: 3 });
  await f.admin.categoryManage({ action: 'delete', id: 'general', expectedVersion: 1 });
  const content = await (await f.get('content?ref=general/git')).json();
  assert.equal(content.version, 4);
  assert.deepEqual(content.resources, [{ path: 'asset.bin', mimeType: 'application/octet-stream', encoding: 'base64', size: 4 }]);
  const binary = await (await f.get('content?ref=general/git&resourcePath=asset.bin')).json();
  assert.deepEqual(binary.resource, { mimeType: 'application/octet-stream', encoding: 'base64', size: 4, content: 'AAEC/w==' });
  assert.equal((await f.get('content?ref=general/git&resourcePath=missing.txt')).status, 404);
  assert.equal((await f.get('content?ref=general/git&resourcePath=../secret')).status, 400);
  assert.equal((await f.get('content?ref=invalid')).status, 400);
  assert.equal((await f.get('content?ref=general/git&ref=fentaris/coordination')).status, 400);
});

test('audit uses descending keyset pages with stable filters and account-bound cursors', async (t) => {
  const f = await fixture(t);
  const first = await (await f.get('activity?limit=2')).json();
  assert.equal(first.events.length, 2);
  assert.equal(first.truncated, true);
  assert.ok(BigInt(first.events[0].id) > BigInt(first.events[1].id));
  await f.admin.skillManage({ action: 'upsert', ref: 'general/git', markdown: '# Later', expectedVersion: 1 });
  const second = await (await f.get(`activity?limit=2&cursor=${first.nextCursor}`)).json();
  assert.equal(second.events.length, 2);
  assert.equal(second.truncated, false);
  assert.ok(BigInt(second.events[0].id) < BigInt(first.events[1].id));
  assert.equal(new Set([...first.events, ...second.events].map((e) => e.id)).size, 4);
  const filtered = await (await f.get('activity?agent=admin&operation=skill.upsert&ref=general/git')).json();
  assert.equal(filtered.events.length, 2);
  assert.ok(filtered.events.every((e) => e.agentId === 'admin' && e.operation === 'skill.upsert' && e.ref === 'general/git'));
  assert.ok(filtered.events[0].createdAt);
  assert.equal(filtered.events[0].version, 2);
  assert.equal((await f.get(`activity?limit=3&cursor=${first.nextCursor}`)).status, 400);
  const other = await f.store.createToken({ agentId: 'other', admin: true });
  assert.equal((await f.get(`activity?limit=2&cursor=${first.nextCursor}`, other.token)).status, 400);
  for (const query of ['limit=51', 'limit=0', 'cursor=invalid', 'unexpected=x']) {
    assert.equal((await f.get(`activity?${query}`)).status, 400);
  }
  await f.store.pool.query(`INSERT INTO sg_audit(id,account_id,agent_id,action,ref,version) OVERRIDING SYSTEM VALUE
    SELECT 999980 + value,$1,'bulk-agent','skill.upsert','general/git',1 FROM generate_series(1,55) AS value`, [f.token.accountId]);
  const capped = await (await f.get('activity?agent=bulk-agent')).json();
  assert.equal(capped.events.length, 50);
  assert.equal(capped.truncated, true);
  const tail = await (await f.get(`activity?agent=bulk-agent&cursor=${capped.nextCursor}`)).json();
  assert.equal(tail.events.length, 5);
  assert.equal(tail.truncated, false);
});

test('admin GET routes reuse CORS, host, HTTPS, methods and safe errors', async (t) => {
  const f = await fixture(t);
  const origin = 'http://127.0.0.1:5173';
  const res = await f.get('overview', f.token.token, { Origin: origin });
  assert.equal(res.headers.get('access-control-allow-origin'), origin);
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal((await f.get('overview', f.token.token, { Origin: 'https://evil.example' })).status, 403);
  const preflight = await fetch(`${f.base}/api/admin/content`, { method: 'OPTIONS', headers: { Origin: origin,
    'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
  assert.equal((await fetch(`${f.base}/api/admin/overview`, { method: 'POST', headers: { Authorization: `Bearer ${f.token.token}` } })).status, 405);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = http.get(`${f.base}/api/admin/activity`, { headers: { Host: 'evil.example' } }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    }); req.on('error', reject);
  });
  assert.equal(hostStatus, 403);
  const strict = createHttpServer({ store: f.store, publicUrl: 'https://127.0.0.1:0/mcp' });
  await new Promise((resolve) => strict.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => strict.close(resolve)));
  assert.equal((await fetch(`http://127.0.0.1:${strict.address().port}/api/admin/overview`)).status, 426);
  const transaction = f.store.transaction;
  f.store.transaction = async () => { throw new Error('private database URL and token'); };
  try {
    const failed = await f.get('overview');
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { error: 'SERVICE_UNAVAILABLE' });
  } finally { f.store.transaction = transaction; }
});
