import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { cloudFixture } from '../support/postgres.js';
import { createHttpServer } from '../src/http-server.js';

const value = (result) => result.structuredContent ?? JSON.parse(result.content[0].text);
async function fixture(t, options = {}) {
  const f = await cloudFixture();
  const server = createHttpServer({ store: f.store, publicUrl: 'http://127.0.0.1:0/mcp', allowInsecureLocalhost: true, ...options });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return { ...f, server, url: `${options.tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}/mcp` };
}
async function connect(t, url, token, options = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } }, ...options });
  const client = new Client({ name: 'cloud-test', version: '1' });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

test('HTTP MCP exposes four runtime tools and seven admin tools with discoverable read schemas', async (t) => {
  const f = await fixture(t);
  const reader = await connect(t, f.url, f.readerToken.token);
  const admin = await connect(t, `${f.url}/admin`, f.token.token);
  const runtime = await reader.listTools();
  assert.deepEqual(runtime.tools.map((tool) => tool.name), ['skill_categories', 'skill_tree', 'skill_read', 'skill_context']);
  const listed = await admin.listTools();
  assert.equal(listed.tools.length, 7);
  assert.ok(listed.tools.find((tool) => tool.name === 'skill_manage').inputSchema.properties.previousRef);
  const read = runtime.tools.find((tool) => tool.name === 'skill_read');
  assert.ok(read.inputSchema.properties.ref);
  assert.ok(read.inputSchema.properties.items.items.properties.resourcePath);
  assert.equal(runtime.tools.some((tool) => tool.outputSchema), false);
  assert.ok(Buffer.byteLength(JSON.stringify(runtime)) <= 5 * 1024, 'Runtime tool schemas exceed their 5 KiB budget');
  const result = await reader.callTool({ name: 'skill_read', arguments: { ref: 'general/git' } });
  assert.deepEqual(value(result), { ok: true, markdown: '# Git\n' });
  assert.equal('structuredContent' in result, false);
  const denied = await reader.callTool({ name: 'skill_manage', arguments: { action: 'list' } });
  assert.equal(denied.isError, true);
  const opened = value(await reader.callTool({ name: 'skill_context', arguments: { action: 'open', categories: ['fentaris'], discovery: { query: 'coordination' } } }));
  assert.equal(opened.discovery.skills[0].ref, 'fentaris/coordination');
  const readScoped = value(await reader.callTool({ name: 'skill_read', arguments: { sessionId: opened.session.sessionId, ref: 'fentaris/coordination' } }));
  assert.equal(readScoped.markdown, '# Fentaris\n');
  const inspected = value(await admin.callTool({ name: 'skill_manage', arguments: { action: 'get', ref: 'general/git' } }));
  assert.equal(inspected.skill.version, 1);
  const written = value(await admin.callTool({ name: 'skill_manage', arguments: { action: 'upsert', ref: 'general/git', markdown: '# Updated', expectedVersion: 1 } }));
  assert.deepEqual(written, { ok: true, version: 2 });
  const moved = value(await admin.callTool({ name: 'skill_manage', arguments: { action: 'upsert', previousRef: 'general/git', ref: 'general/source-control', expectedVersion: 2 } }));
  assert.deepEqual(moved, { ok: true, version: 3 });
  assert.equal(value(await reader.callTool({ name: 'skill_read', arguments: { ref: 'general/source-control' } })).markdown, '# Updated');
  assert.equal(value(await reader.callTool({ name: 'skill_read', arguments: { ref: 'general/git' } })).error.code, 'SKILL_NOT_ACTIVE');
});

test('every HTTP request authenticates, including tools/list; expiry and revocation affect connected clients', async (t) => {
  const f = await fixture(t);
  const post = (url, token) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  const unauth = await post(f.url);
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate'), /Bearer/);
  assert.equal((await post(`${f.url}/admin`, f.readerToken.token)).status, 403);
  const client = await connect(t, f.url, f.readerToken.token);
  await f.store.revokeToken(f.readerToken.id);
  await assert.rejects(client.listTools());
  assert.equal((await post(f.url, f.readerToken.token)).status, 401);
  await f.store.pool.query("UPDATE sg_tokens SET expires_at=now()-interval '1 second' WHERE id=$1", [f.token.id]);
  assert.equal((await post(`${f.url}/admin`, f.token.token)).status, 401);
});

test('request boundaries reject foreign hosts/origins, insecure deployment and malformed or oversized bodies', async (t) => {
  const f = await fixture(t);
  assert.throws(() => createHttpServer({ store: f.store, publicUrl: 'http://example.com/mcp' }), /HTTPS/);
  assert.throws(() => createHttpServer({ store: f.store, publicUrl: 'https://example.com/mcp?token=x' }), /canonical/);
  const headers = { Authorization: `Bearer ${f.readerToken.token}`, 'Content-Type': 'application/json' };
  const wrongHost = await new Promise((resolve, reject) => {
    const req = http.request(f.url, { method: 'POST', headers: { ...headers, Host: 'evil.example' } }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end('{}');
  });
  assert.equal(wrongHost, 403);
  assert.equal((await fetch(f.url, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  assert.equal((await fetch(f.url, { method: 'POST', headers, body: '{invalid' })).status, 400);
  // A client may stop uploading immediately after a 413 response. Sending an
  // oversized declared length verifies admission without an EPIPE upload race.
  const oversized = await new Promise((resolve, reject) => {
    const req = http.request(f.url, { method: 'POST', headers: { ...headers, 'Content-Length': 8 * 1024 * 1024 + 1 } }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(oversized, 413);
  assert.equal((await fetch(f.url, { headers })).status, 405);
  assert.equal((await fetch(`${f.url}?token=x`, { headers })).status, 404);
  assert.equal((await fetch(f.url.replace('/mcp', '/health'))).status, 200);
  const strict = await fixture(t, { publicUrl: 'https://127.0.0.1:0/mcp', allowInsecureLocalhost: false });
  assert.equal((await fetch(strict.url, { method: 'POST', headers, body: '{}' })).status, 426);
  assert.equal((await fetch(strict.url, { method: 'POST', headers: { ...headers, 'X-Forwarded-Proto': 'https' }, body: '{}' })).status, 426);
});

test('structured cloud responses keep exactly one payload and hide internal database errors', async (t) => {
  const f = await fixture(t, { structuredOutput: true });
  const client = await connect(t, f.url, f.readerToken.token);
  const result = await client.callTool({ name: 'skill_read', arguments: { ref: 'general/git' } });
  assert.deepEqual(result.content, []);
  assert.equal(result.structuredContent.markdown, '# Git\n');
  assert.ok((await client.listTools()).tools.every((tool) => tool.outputSchema));
  const failed = await client.callTool({ name: 'skill_read', arguments: { ref: 'general/git', items: [{ ref: 'general/git' }] } });
  assert.equal(failed.isError, true);
  assert.equal('structuredContent' in failed, false);
  const transaction = f.store.transaction;
  f.store.transaction = async () => { throw new Error('database credentials: secret-value'); };
  let internal;
  try { internal = await client.callTool({ name: 'skill_read', arguments: { ref: 'general/git' } }); }
  finally { f.store.transaction = transaction; }
  assert.equal(value(internal).error.code, 'INTERNAL_ERROR');
  assert.equal(JSON.stringify(internal).includes('secret-value'), false);
});

test('native HTTPS serves the real MCP client using certificate verification', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'skillgesture-tls-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyPath = path.join(directory, 'key.pem'); const certPath = path.join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath,
    '-out', certPath, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const tls = { key: await readFile(keyPath), cert: await readFile(certPath) };
  const f = await fixture(t, { publicUrl: 'https://127.0.0.1:0/mcp', allowInsecureLocalhost: false, tls });
  const verifiedFetch = (url, options = {}) => new Promise((resolve, reject) => {
    const req = https.request(url, { method: options.method, headers: Object.fromEntries(new Headers(options.headers)), ca: tls.cert }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(new Response(res.statusCode === 204 ? null : Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
    });
    req.on('error', reject); req.end(options.body);
  });
  const client = await connect(t, f.url, f.readerToken.token, { fetch: verifiedFetch });
  assert.equal((await client.listTools()).tools.length, 4);
  assert.equal(value(await client.callTool({ name: 'skill_read', arguments: { ref: 'general/git' } })).markdown, '# Git\n');
});
