// Schema migrations. Numbered .sql files, applied once each, in order, inside a transaction.
//
// Two API containers starting together would otherwise race to create the same tables, so the whole run is
// wrapped in a PostgreSQL advisory lock: the second one waits, then finds there is nothing left to do.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, tx } from './db.js';
import { log } from './log.js';

const LOCK_ID = 0x4141_0001;   // "AA" + 1: this product's migration lock, not shared with any other game

export function migrationsDir(): string {
  if (process.env.ARROW_ATLAS_MIGRATIONS_DIR) return process.env.ARROW_ATLAS_MIGRATIONS_DIR;
  // src/ at dev time, dist/ once built: the migrations sit beside the backend either way
  return join(dirname(dirname(fileURLToPath(import.meta.url))), '..', 'migrations');
}

export async function migrate(dir = migrationsDir()): Promise<string[]> {
  const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort();
  const applied: string[] = [];

  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Set((await c.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(r => r.name));

    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(join(dir, f), 'utf8');
      await tx(async t => {
        await t.query(sql);
        await t.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      });
      applied.push(f);
      log.info('migration applied', { file: f });
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    c.release();
  }
  if (!applied.length) log.info('schema up to date', { migrations: files.length });
  return applied;
}

// `npm run migrate` runs this file directly; the server imports migrate() and calls it on boot.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '\0')) {
  migrate()
    .then(a => { console.log(a.length ? `applied: ${a.join(', ')}` : 'nothing to apply'); return pool.end(); })
    .then(() => process.exit(0))
    .catch(e => { log.err('migration failed', e); process.exit(1); });
}
