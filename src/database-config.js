import { readFile } from 'node:fs/promises';

export async function databaseConfig(env = process.env) {
  if (env.DATABASE_URL) return { connectionString: env.DATABASE_URL };
  if (!env.PGHOST) throw new Error('Provide DATABASE_URL or PGHOST');
  const password = env.DATABASE_PASSWORD_FILE
    ? (await readFile(env.DATABASE_PASSWORD_FILE, 'utf8')).trimEnd() : env.PGPASSWORD;
  return { config: { host: env.PGHOST, port: Number(env.PGPORT ?? 5432),
    user: env.PGUSER, database: env.PGDATABASE, password } };
}
