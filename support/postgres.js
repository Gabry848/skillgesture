import { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { embeddedPool } from './embedded-pool.js';
import pg from 'pg';
import { PostgresStore } from '../src/postgres-store.js';
import { CloudRegistry } from '../src/cloud-registry.js';

// Execute production SQL in embedded Postgres by default, or through the real
// pg wire driver against a dedicated external test database when configured.
export { embeddedPool };

let shared;
async function testStore() {
  if (!shared) shared = (async () => {
    let pool;
    if (process.env.SKILLGESTURE_TEST_DATABASE_URL) {
      const bootstrap = new pg.Pool({ connectionString: process.env.SKILLGESTURE_TEST_DATABASE_URL });
      const schema = `sg_test_${randomUUID().replaceAll('-', '')}`;
      await bootstrap.query(`CREATE SCHEMA ${schema}`);
      pool = new pg.Pool({ connectionString: process.env.SKILLGESTURE_TEST_DATABASE_URL, options: `-c search_path=${schema}` });
      const end = pool.end.bind(pool);
      pool.end = async () => { await end(); await bootstrap.query(`DROP SCHEMA ${schema} CASCADE`); await bootstrap.end(); };
    } else pool = await embeddedPool();
    const store = new PostgresStore({ pool });
    await store.initialize();
    return store;
  })();
  return shared;
}
after(async () => { if (shared) await (await shared).close(); });

export async function cloudFixture() {
  const store = await testStore();
  const token = await store.createToken({ agentId: 'admin', admin: true });
  const principal = await store.authenticate(token.token);
  const admin = new CloudRegistry(store, principal);
  const readerToken = await store.createToken({ accountId: token.accountId, agentId: 'agent-a' });
  const reader = new CloudRegistry(store, await store.authenticate(readerToken.token));
  await admin.categoryManage({ action: 'upsert', id: 'general', name: 'general', default: true });
  await admin.categoryManage({ action: 'upsert', id: 'fentaris', name: 'Fentaris', description: 'Coordination skills' });
  await admin.skillManage({ action: 'upsert', ref: 'general/git', name: 'git', description: 'Version control', markdown: '# Git\n' });
  await admin.skillManage({ action: 'upsert', ref: 'fentaris/coordination', name: 'coordination', description: 'Agent coordination', markdown: '# Fentaris\n' });
  return { store, token, principal, admin, readerToken, reader };
}
