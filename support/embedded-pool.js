import { PGlite } from '@electric-sql/pglite';

// A pg-compatible adapter for tests and benchmarks. Transactions hold a single
// connection until release; production uses pg.Pool and independent connections.
export async function embeddedPool(dataDir) {
  const database = await PGlite.create(dataDir);
  let tail = Promise.resolve();
  const pool = {
    async connect() {
      const previous = tail;
      let release;
      tail = new Promise((resolve) => { release = resolve; });
      await previous;
      return {
        async query(sql, params) {
          if (params === undefined && sql.includes(';')) {
            const result = await database.exec(sql);
            return result.at(-1) ?? { rows: [], rowCount: 0 };
          }
          const result = await database.query(sql, params);
          return { ...result, rowCount: result.rowCount ?? result.affectedRows ?? result.rows.length };
        },
        release,
      };
    },
    async query(sql, params) {
      const client = await pool.connect();
      try { return await client.query(sql, params); } finally { client.release(); }
    },
    async end() { await tail; await database.close(); },
  };
  return pool;
}
