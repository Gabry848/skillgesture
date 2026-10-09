import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresStore } from '../../src/postgres-store.js';
import { embeddedPool } from '../../support/embedded-pool.js';
import { provisionAdminAccess } from './bootstrap.mjs';

// Exercise credential policy against the real schema and token implementation.
// PGlite is single-connection; the operator's cross-connection advisory lock is
// a PostgreSQL runtime concern and is not simulated here.
async function database(t) {
  const store = new PostgresStore({ pool: await embeddedPool() });
  await store.initialize();
  t.after(() => store.close());
  return store;
}

test('first access saves an authentic admin token; reruns reuse it without disclosure', async (t) => {
  const store = await database(t);
  let secret;
  const options = { store, readSecret: async () => secret, writeSecret: async (value) => { secret = value; } };
  const initial = await provisionAdminAccess(options);
  assert.equal(initial.reused, false);
  assert.equal((await store.authenticate(secret.value)).admin, true);
  assert.equal(secret.tags.accountId, initial.accountId);
  assert.deepEqual(await provisionAdminAccess(options), { ...initial, reused: true });
  const { rows } = await store.pool.query('SELECT count(*)::integer AS count FROM sg_tokens');
  assert.equal(rows[0].count, 1);
  assert.equal(JSON.stringify(initial).includes(secret.value), false);
});

test('bootstrap preserves the one existing account', async (t) => {
  const store = await database(t);
  const agent = await store.createToken({ agentId: 'existing-agent' });
  let secret;
  const result = await provisionAdminAccess({ store, readSecret: async () => null, writeSecret: async (value) => { secret = value; } });
  assert.equal(result.accountId, agent.accountId);
  assert.equal((await store.authenticate(secret.value)).accountId, agent.accountId);
});

test('an ambiguous Key Vault network failure revokes the newly created credential', async (t) => {
  const store = await database(t);
  let submitted;
  await assert.rejects(provisionAdminAccess({ store, readSecret: async () => null, writeSecret: async (value) => {
    submitted = value;
    throw new Error('Connection closed after sending the request');
  } }), /revoked/);
  assert.equal(await store.authenticate(submitted.value), null);
});

test('existing revoked or non-admin secrets fail without issuing another token', async (t) => {
  const store = await database(t);
  const revoked = await store.createToken({ agentId: 'revoked-admin', admin: true });
  await store.revokeToken(revoked.id);
  const nonAdmin = await store.createToken({ accountId: revoked.accountId, agentId: 'consumer' });
  for (const token of [revoked, nonAdmin]) {
    await assert.rejects(provisionAdminAccess({ store, readSecret: async () => ({ value: token.token }), writeSecret: async () => assert.fail('Must not replace an existing secret') }), /rotate it explicitly/);
  }
  const { rows } = await store.pool.query('SELECT count(*)::integer AS count FROM sg_tokens');
  assert.equal(rows[0].count, 2);
});

test('multiple accounts require an explicit choice and create no bootstrap credential', async (t) => {
  const store = await database(t);
  await store.createToken({ agentId: 'account-one' });
  await store.createToken({ agentId: 'account-two' });
  await assert.rejects(provisionAdminAccess({ store, readSecret: async () => null, writeSecret: async () => assert.fail('Must not save an ambiguous account') }), /Choose an account/);
  const { rows } = await store.pool.query('SELECT count(*)::integer AS count FROM sg_tokens');
  assert.equal(rows[0].count, 2);
});
