import { pathToFileURL } from 'node:url';
import { PostgresStore } from '../../src/postgres-store.js';
import { databaseConfig } from '../../src/database-config.js';

// The caller holds a database advisory lock while selecting the account and
// saving the credential. Return only metadata that is safe to log.
export async function provisionAdminAccess({ store, client = store.pool, readSecret, writeSecret }) {
  const secret = await readSecret();
  if (secret) {
    const principal = await store.authenticate(secret.value);
    if (!principal?.admin) throw new Error('Stored admin token expired or revoked; rotate it explicitly');
    return { initialized: true, accountId: principal.accountId, reused: true };
  }
  const accounts = await client.query('SELECT id FROM sg_accounts LIMIT 2');
  if (accounts.rows.length > 1) throw new Error('Choose an account explicitly before bootstrapping');
  const token = await store.createToken({ accountId: accounts.rows[0]?.id, agentId: 'catalog-admin', admin: true, expiresInDays: 30 });
  try {
    await writeSecret({ value: token.token, tags: { accountId: token.accountId, agentId: token.agentId, tokenId: token.id } });
  } catch {
    // A failed or ambiguous network response must not leave a usable orphan.
    await store.revokeToken(token.id);
    throw new Error('Cannot save admin token; the new token was revoked');
  }
  return { initialized: true, accountId: token.accountId, reused: false };
}

async function main() {
  let store;
  try {
    const vault = new URL(process.env.KEY_VAULT_URL);
    if (vault.protocol !== 'https:' || !vault.hostname.endsWith('.vault.azure.net')) throw new Error('Invalid vault');
    const identityUrl = new URL(process.env.IDENTITY_ENDPOINT);
    identityUrl.searchParams.set('api-version', '2019-08-01');
    identityUrl.searchParams.set('resource', 'https://vault.azure.net');
    identityUrl.searchParams.set('client_id', process.env.AZURE_CLIENT_ID);
    const identity = await fetch(identityUrl, { headers: { 'X-IDENTITY-HEADER': process.env.IDENTITY_HEADER }, signal: AbortSignal.timeout(30_000) });
    if (!identity.ok) throw new Error('Managed identity authentication failed');
    const { access_token: accessToken } = await identity.json();
    if (!accessToken) throw new Error('Managed identity token is unavailable');
    const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
    const tokenUrl = new URL('secrets/catalog-admin-token?api-version=7.4', vault);
    const readSecret = async () => {
      const response = await fetch(tokenUrl, { headers, signal: AbortSignal.timeout(30_000) });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error('Cannot read bootstrap secret');
      return response.json();
    };
    const writeSecret = async (secret) => {
      const response = await fetch(tokenUrl, { method: 'PUT', headers, body: JSON.stringify(secret), signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error('Cannot save bootstrap secret');
    };
    store = new PostgresStore(await databaseConfig());
    await store.initialize();
    const client = await store.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext('skillgesture-azure-bootstrap'))");
      console.log(JSON.stringify(await provisionAdminAccess({ store, client, readSecret, writeSecret })));
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('skillgesture-azure-bootstrap'))").catch(() => {});
      client.release();
    }
  } catch {
    console.error('Bootstrap failed; inspect database readiness and Key Vault access. No credentials were logged.');
    process.exitCode = 1;
  } finally { await store?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
