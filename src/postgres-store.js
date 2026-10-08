import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { fail } from './errors.js';

export const tokenHash = (token) => createHash('sha256').update(token).digest('hex');

export class PostgresStore {
  constructor({ connectionString = process.env.DATABASE_URL, config, pool, max = 10 } = {}) {
    if (!pool && !connectionString && !config?.host) throw new Error('Database configuration is required');
    this.pool = pool ?? new pg.Pool({ ...config, connectionString, max, connectionTimeoutMillis: 5000 });
    // Background idle-client errors must not crash the process or disclose credentials.
    this.pool.on?.('error', () => console.error('Skillgesture database connection failed'));
  }

  async initialize() {
    await this.transaction(async (client) => {
      await client.query('CREATE TABLE IF NOT EXISTS sg_schema (version integer PRIMARY KEY)');
      await client.query('LOCK TABLE sg_schema IN EXCLUSIVE MODE');
      const { rows } = await client.query('SELECT version FROM sg_schema ORDER BY version');
      if (rows.some(({ version }) => version > 1)) throw new Error('Unsupported database schema version');
      if (rows.length === 0) {
        await client.query(await readFile(new URL('../db/001_cloud.sql', import.meta.url), 'utf8'));
        await client.query('INSERT INTO sg_schema (version) VALUES (1)');
      }
    });
  }

  async transaction(operation, { readOnly = false, snapshot = false } = {}) {
    const client = await this.pool.connect();
    try {
      await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
        : snapshot ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.code === '40001') fail('VERSION_CONFLICT', 'Concurrent update; read the current version and retry');
      throw error;
    } finally {
      client.release();
    }
  }

  async mutate(principal, action, operation, ref = null) {
    return this.transaction(async (client) => {
      // Serialize writes within this account, never across unrelated accounts.
      const { rowCount } = await client.query('SELECT id FROM sg_accounts WHERE id = $1 FOR UPDATE', [principal.accountId]);
      if (!rowCount) fail('UNAUTHORIZED', 'Account is unavailable');
      const result = await operation(client);
      await client.query('UPDATE sg_accounts SET revision = revision + 1 WHERE id = $1', [principal.accountId]);
      await client.query('INSERT INTO sg_audit(account_id, agent_id, action, ref, version) VALUES ($1,$2,$3,$4,$5)',
        [principal.accountId, principal.agentId, action, ref, result.version ?? null]);
      return result;
    });
  }

  async createToken({ accountId = randomUUID(), agentId, admin = false, expiresInDays = 30 } = {}) {
    if (typeof agentId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,119}$/.test(agentId)) {
      fail('INVALID_INPUT', 'agentId must be a lowercase slug of up to 120 characters');
    }
    if (typeof admin !== 'boolean' || !Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) {
      fail('INVALID_INPUT', 'Token expiry must be between 1 and 365 days');
    }
    const token = `sg_${randomBytes(32).toString('base64url')}`;
    const id = randomUUID();
    await this.transaction(async (client) => {
      await client.query('INSERT INTO sg_accounts(id) VALUES ($1) ON CONFLICT DO NOTHING', [accountId]);
      await client.query(`INSERT INTO sg_tokens(id,account_id,agent_id,token_hash,admin,expires_at)
        VALUES ($1,$2,$3,$4,$5,now() + $6 * interval '1 day')`,
      [id, accountId, agentId, tokenHash(token), admin, expiresInDays]);
    });
    return { token, id, accountId, agentId, admin };
  }

  async authenticate(token) {
    if (typeof token !== 'string' || !/^sg_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const { rows } = await this.pool.query(`SELECT id, account_id, agent_id, admin FROM sg_tokens
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`, [tokenHash(token)]);
    const row = rows[0];
    return row ? { tokenId: row.id, accountId: row.account_id, agentId: row.agent_id, admin: row.admin } : null;
  }

  async revokeToken(id) {
    const { rowCount } = await this.pool.query('UPDATE sg_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]);
    return { revoked: rowCount > 0 };
  }

  close() { return this.pool.end(); }
}
