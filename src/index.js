#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { PostgresStore } from './postgres-store.js';
import { createHttpServer } from './http-server.js';
import { databaseConfig } from './database-config.js';

export async function main({ env = process.env } = {}) {
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
  if (!env.PUBLIC_URL) throw new Error('PUBLIC_URL is required');
  if (Boolean(env.TLS_CERT) !== Boolean(env.TLS_KEY)) throw new Error('Provide both TLS_CERT and TLS_KEY');
  const tls = env.TLS_CERT ? { cert: await readFile(env.TLS_CERT), key: await readFile(env.TLS_KEY) } : undefined;
  const store = new PostgresStore(await databaseConfig(env));
  try {
    await store.initialize();
    const server = createHttpServer({ store, publicUrl: env.PUBLIC_URL, tls,
      trustProxy: env.TRUST_PROXY === '1', allowInsecureLocalhost: env.ALLOW_INSECURE_LOCALHOST === '1',
      allowedOrigins: env.ALLOWED_ORIGINS?.split(',').filter(Boolean) ?? [],
      structuredOutput: env.SKILLGESTURE_STRUCTURED_OUTPUT === '1' });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, env.HOST ?? '127.0.0.1', resolve);
    });
    console.error('Skillgesture cloud MCP ready');
    const close = () => { server.close(() => store.close()); };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    return { server, store };
  } catch (error) { await store.close(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Skillgesture startup failed; check database and HTTPS configuration');
    process.exitCode = 1;
  });
}
