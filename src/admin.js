#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { PostgresStore } from './postgres-store.js';
import { SessionIdSchema } from './contracts.js';
import { importLocalCatalog } from './import-local.js';
import { databaseConfig } from './database-config.js';

const usage = `Usage:
  skillgesture-admin token create --agent <slug> [--account <uuid>] [--admin] [--days 30]
  skillgesture-admin token revoke --id <uuid>
  skillgesture-admin import --root <local-store> --account <uuid> [--defaults general,coding]
  skillgesture-admin migrate
Database: DATABASE_URL, or PGHOST/PGUSER/PGDATABASE and DATABASE_PASSWORD_FILE.
Token creation outputs the secret once; send it directly to your secret manager.`;

export async function main(args = process.argv.slice(2), env = process.env) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    agent: { type: 'string' }, account: { type: 'string' }, admin: { type: 'boolean' }, days: { type: 'string' },
    id: { type: 'string' }, root: { type: 'string' }, defaults: { type: 'string' }, help: { type: 'boolean' },
  } });
  const command = positionals.join(' ');
  if (values.help || !command) { console.log(usage); return; }
  if (!['token create', 'token revoke', 'import', 'migrate'].includes(command)) throw new Error('Unknown admin command');
  if (values.account) SessionIdSchema.parse(values.account);
  if (command === 'token revoke') SessionIdSchema.parse(values.id);
  if (command === 'import' && (!values.root || !values.account)) throw new Error('Import requires root and account');
  const store = new PostgresStore(await databaseConfig(env));
  try {
    await store.initialize();
    let result;
    if (command === 'token create') result = await store.createToken({ agentId: values.agent, accountId: values.account,
      admin: values.admin ?? false, expiresInDays: Number(values.days ?? 30) });
    else if (command === 'token revoke') result = await store.revokeToken(values.id);
    else if (command === 'import') result = await importLocalCatalog({ store, root: values.root,
      principal: { accountId: values.account, agentId: 'import', admin: true },
      defaultCategories: values.defaults === undefined ? undefined : values.defaults.split(',').filter(Boolean) });
    else result = { migrated: true };
    console.log(JSON.stringify(result));
    return result;
  } finally { await store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Admin command failed; check arguments and database configuration'); process.exitCode = 1; });
}
