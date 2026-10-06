/**
 * Minimal database abstraction: one interface, two engines.
 *  - PGlite (in-process Postgres) for tests and MODE=mock
 *  - node-postgres Pool for the self-hosted Postgres container
 * ALL queries must be parameterised ($1, $2...). Never interpolate values into SQL.
 * CONTRACT FILE: owned by the foundation.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface QueryResult<T> {
  rows: T[];
}

export interface Queryable {
  /** One parameterised statement. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Multi-statement script WITHOUT parameters (migrations only). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  /** Runs fn inside a transaction; commits on success, rolls back on throw. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  // PGlite is a single connection: serialise every operation so a transaction never interleaves
  // with statements from other callers.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.catch(() => undefined);
    return run;
  };
  return {
    query<T>(sql: string, params: unknown[] = []) {
      return serial(async () => ({ rows: (await pg.query<T>(sql, params as any[])).rows }));
    },
    exec(sql: string) {
      return serial(async () => {
        await pg.exec(sql);
      });
    },
    tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
      return serial(() =>
        pg.transaction(async (t) => {
          const tq: Queryable = {
            async query<R>(sql: string, params: unknown[] = []) {
              return { rows: (await t.query<R>(sql, params as any[])).rows };
            },
            async exec(sql: string) {
              await t.exec(sql);
            },
          };
          return fn(tq);
        }),
      ) as Promise<T>;
    },
    async close() {
      await chain;
      await pg.close();
    },
  };
}

export async function createPgDb(connectionString: string): Promise<Db> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString, max: 5 });
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await pool.query(sql, params);
      return { rows: res.rows as T[] };
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tq: Queryable = {
          async query<R>(sql: string, params: unknown[] = []) {
            const res = await client.query(sql, params);
            return { rows: res.rows as R[] };
          },
          async exec(sql: string) {
            await client.query(sql);
          },
        };
        const out = await fn(tq);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Applies every migrations/*.sql file not yet recorded, in name order. Idempotent. */
export async function migrate(db: Db): Promise<string[]> {
  await db.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const applied = new Set(
    (await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    await db.tx(async (q) => {
      await q.exec(sql);
      await q.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    ran.push(file);
  }
  return ran;
}
