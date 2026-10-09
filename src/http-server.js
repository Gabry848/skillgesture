import http from 'node:http';
import https from 'node:https';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CloudRegistry } from './cloud-registry.js';
import { createCloudMcpServer } from './cloud-server.js';
import { AdminQueries } from './admin-queries.js';
import { SkillgestureError } from './errors.js';

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
function reply(res, status, code, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify({ error: code }));
}
async function readBody(req) {
  if (Number(req.headers['content-length']) > MAX_REQUEST_BYTES) return { tooLarge: true };
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) return { tooLarge: true };
    chunks.push(chunk);
  }
  try { return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; }
  catch { return { invalid: true }; }
}

export function createHttpServer({ store, publicUrl, tls, trustProxy = false,
  allowInsecureLocalhost = false, allowedOrigins = [], structuredOutput = false } = {}) {
  const url = new URL(publicUrl);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/mcp') {
    throw new Error('PUBLIC_URL must be the canonical /mcp URL without credentials, query or fragment');
  }
  if (url.protocol !== 'https:' && !(allowInsecureLocalhost && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new Error('PUBLIC_URL requires HTTPS (HTTP is allowed only for explicit loopback development)');
  }
  const allowed = new Set(allowedOrigins.map((origin) => new URL(origin).origin));
  const handler = async (req, res) => {
    let mcpServer;
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (req.url === '/health' && req.method === 'GET') {
        await store.pool.query('SELECT 1');
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return;
      }
      const path = req.url?.split('?')[0];
      const adminRead = ['/api/admin/overview', '/api/admin/activity', '/api/admin/content'].includes(path);
      if (!adminRead && (!['/mcp', '/mcp/admin'].includes(path) || req.url !== path)) return reply(res, 404, 'NOT_FOUND');
      const expectedHost = url.port === '0' && LOOPBACK_HOSTS.has(url.hostname)
        ? `${url.hostname}:${server.address().port}` : url.host;
      if (req.headers.host !== expectedHost) return reply(res, 403, 'INVALID_HOST');
      const loopbackDevelopment = allowInsecureLocalhost && LOOPBACK_HOSTS.has(url.hostname)
        && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      const secure = req.socket.encrypted || (trustProxy && req.headers['x-forwarded-proto'] === 'https');
      if (!secure && !loopbackDevelopment) return reply(res, 426, 'HTTPS_REQUIRED');
      if (req.headers.origin) {
        if (!allowed.has(req.headers.origin)) return reply(res, 403, 'INVALID_ORIGIN');
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, MCP-Protocol-Version');
        res.setHeader('Access-Control-Allow-Methods', adminRead ? 'GET, OPTIONS' : 'POST, OPTIONS');
      }
      if (req.method === 'OPTIONS') {
        if (!req.headers.origin) return reply(res, 405, 'METHOD_NOT_ALLOWED', { Allow: adminRead ? 'GET' : 'POST' });
        res.writeHead(204); res.end(); return;
      }
      const match = /^Bearer (sg_[A-Za-z0-9_-]{43})$/i.exec(req.headers.authorization ?? '');
      const principal = match ? await store.authenticate(match[1]) : null;
      if (!principal) return reply(res, 401, 'UNAUTHORIZED', { 'WWW-Authenticate': 'Bearer realm="skillgesture"' });
      const admin = path === '/mcp/admin' || adminRead;
      if (admin && !principal.admin) return reply(res, 403, 'FORBIDDEN');
      if (adminRead) {
        if (req.method !== 'GET') return reply(res, 405, 'METHOD_NOT_ALLOWED', { Allow: 'GET' });
        const params = new URL(req.url, publicUrl).searchParams;
        const keys = path.endsWith('/overview') ? [] : path.endsWith('/activity')
          ? ['agent', 'operation', 'ref', 'limit', 'cursor'] : ['ref', 'resourcePath'];
        if ([...params.keys()].some((key) => !keys.includes(key) || params.getAll(key).length !== 1)) {
          return reply(res, 400, 'INVALID_INPUT');
        }
        const queries = new AdminQueries(store, principal);
        const result = await queries[path.split('/').at(-1)](Object.fromEntries(params));
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); return;
      }
      if (req.method !== 'POST') return reply(res, 405, 'METHOD_NOT_ALLOWED', { Allow: 'POST' });
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return reply(res, 415, 'UNSUPPORTED_MEDIA_TYPE');
      const { body, invalid, tooLarge } = await readBody(req);
      if (tooLarge) {
        req.resume();
        return reply(res, 413, 'REQUEST_TOO_LARGE', { Connection: 'close' });
      }
      if (invalid) return reply(res, 400, 'INVALID_JSON');
      mcpServer = createCloudMcpServer(new CloudRegistry(store, principal), { admin, structuredOutput });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await mcpServer.connect(transport);
      // Transport instances are request-local; agent sessions live in Postgres.
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) {
        const status = error.name === 'ZodError' ? 400 : error instanceof SkillgestureError
          ? ({ FORBIDDEN: 403, UNAUTHORIZED: 401, SKILL_NOT_FOUND: 404, RESOURCE_NOT_FOUND: 404 }[error.code] ?? 400) : 503;
        reply(res, status, error.name === 'ZodError' ? 'INVALID_INPUT' : error instanceof SkillgestureError ? error.code : 'SERVICE_UNAVAILABLE');
      }
      else if (!res.writableEnded) res.end();
    } finally { await mcpServer?.close().catch(() => {}); }
  };
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}
