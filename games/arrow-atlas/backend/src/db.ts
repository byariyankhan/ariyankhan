// PostgreSQL is the authoritative store for everything a player would be upset to lose: the account, the gold,
// the match and its result. One pool per process, and one helper that runs a unit of work inside a transaction
// so the economy can never half-happen.
import pg from 'pg';
import { config } from './config.js';
import { log } from './log.js';

// Gold and ids are BIGINT. node-postgres hands BIGINT back as a string to avoid silently losing precision;
// every number this game deals in is far inside Number.MAX_SAFE_INTEGER, so we parse them and keep the code
// honest about it rather than sprinkling Number() over every read.
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => Number(v));

export type Sql = pg.Pool | pg.PoolClient;

export const pool = new pg.Pool({
  host: config.pg.host,
  port: config.pg.port,
  database: config.pg.database,
  user: config.pg.user,
  password: config.pg.password,
  max: config.pg.max,
  idleTimeoutMillis: config.pg.idleTimeoutMillis,
  connectionTimeoutMillis: config.pg.connectionTimeoutMillis,
  // A runaway query holds a row lock that stalls the lobby; better to fail it and answer the player.
  statement_timeout: config.pg.statementTimeoutMillis,
  application_name: 'arrow-atlas-api',
});

pool.on('error', e => log.err('postgres pool error', e));

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: Sql, text: string, params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return sql.query<T>(text, params as never[]);
}

/**
 * Run `fn` inside a transaction, committing on return and rolling back on throw.
 *
 * Serialization failures and deadlocks are retried: two players clearing the same board in the same millisecond
 * is normal here, not exceptional, and the loser of that race should simply run again rather than see an error.
 */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch { /* the connection is going back to the pool either way */ }
      last = e;
      const code = (e as { code?: string }).code;
      if (code === '40001' || code === '40P01') { // serialization_failure, deadlock_detected
        log.warn('transaction retry', { attempt, code });
        continue;
      }
      throw e;
    } finally {
      c.release();
    }
  }
  throw last;
}

export async function dbHealthy(): Promise<{ ok: boolean; detail?: string }> {
  try {
    const r = await pool.query('SELECT 1 AS ok');
    return { ok: r.rows[0]?.ok === 1 };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export async function closeDb(): Promise<void> { await pool.end(); }
