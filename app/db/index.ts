// One small database interface for the whole app. Production uses PostgreSQL through `pg`; the tests
// use PGlite (Postgres in WebAssembly) with the same SQL. Always pass values as $1, $2… parameters.
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** First row or null. */
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  /** Several statements, no parameters (migrations only). */
  exec(sql: string): Promise<void>;
  /** Run `fn` in a transaction; it commits when `fn` resolves and rolls back when it throws. */
  tx<R>(fn: (db: Db) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

type Querier = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };

const noNested = (): never => { throw new Error('nested transactions are not supported'); };

function wrap(q: Querier, exec: (sql: string) => Promise<unknown>, tx: Db['tx'], close: () => Promise<void>): Db {
  return {
    async query<T>(sql: string, params: unknown[] = []) { return (await q.query(sql, params)).rows as T[]; },
    async one<T>(sql: string, params: unknown[] = []) { return ((await q.query(sql, params)).rows[0] as T) ?? null; },
    async exec(sql: string) { await exec(sql); },
    tx,
    close,
  };
}

export async function connectPg(url: string): Promise<Db> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  const tx: Db['tx'] = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(wrap(client, (s) => client.query(s), noNested, async () => {}));
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  };
  return wrap(pool, (s) => pool.query(s), tx, () => pool.end());
}

/** An empty in-memory Postgres for tests. */
export async function memoryDb(): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  const tx: Db['tx'] = (fn) => pg.transaction((t) => fn(wrap(t, (s) => t.exec(s), noNested, async () => {})));
  return wrap(pg, (s) => pg.exec(s), tx, () => pg.close());
}
