// The one-way trip: a legacy SQLite database in, PostgreSQL out, and proof that nothing was lost on the way.
//
// The fixture is built here rather than copied from production, so this suite runs anywhere — but it is built
// to the legacy schema exactly, including the awkward rows the real database holds: a seat belonging to an
// account that has since been deleted, a match nobody won, and a live session that must keep working.
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pool, query } from '../backend/src/db.js';
import { importSqlite } from '../backend/src/import-sqlite.js';
import { userForToken } from '../backend/src/auth.js';
import { migrate } from '../backend/src/migrate.js';
import { eq, finish, ok, section } from './helpers.js';

const dir = mkdtempSync(join(tmpdir(), 'aa-legacy-'));
const file = join(dir, 'arrow-atlas.sqlite');
const KNOWN_TOKEN = 'a'.repeat(64);          // a session that must survive the move
const now = Math.floor(Date.now() / 1000);

// ── Build the legacy database, to the old schema ──
{
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, sub TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '', pic TEXT NOT NULL DEFAULT '', gold INTEGER NOT NULL DEFAULT 10000,
    created INTEGER NOT NULL, seen INTEGER NOT NULL, UNIQUE(provider, sub))`);
  db.exec(`CREATE TABLE sessions (hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE matches (code TEXT PRIMARY KEY, host_id INTEGER NOT NULL, stake INTEGER NOT NULL, board TEXT NOT NULL,
    tier INTEGER NOT NULL, seed INTEGER NOT NULL, state TEXT NOT NULL, winner_id INTEGER, created INTEGER NOT NULL,
    started INTEGER, settled INTEGER, open_to_all INTEGER NOT NULL DEFAULT 0, fills_at INTEGER)`);
  db.exec(`CREATE TABLE match_players (code TEXT NOT NULL, user_id INTEGER NOT NULL, joined INTEGER NOT NULL,
    tier INTEGER NOT NULL DEFAULT 2, pct INTEGER NOT NULL DEFAULT 0, ms INTEGER, done INTEGER, PRIMARY KEY (code, user_id))`);

  const u = db.prepare('INSERT INTO users (id,provider,sub,name,pic,gold,created,seen) VALUES (?,?,?,?,?,?,?,?)');
  u.run(1, 'google', 'sub-a', 'Ariyan', 'https://lh3.googleusercontent.com/a', 50_000, now - 9000, now);
  u.run(2, 'google', 'sub-b', 'Rafi', '', 12_500, now - 8000, now);
  u.run(7, 'google', 'sub-c', 'Sumi', '', 900, now - 7000, now);   // a gap in the ids, as deletions leave

  db.prepare('INSERT INTO sessions (hash,user_id,created,expires) VALUES (?,?,?,?)')
    .run(createHash('sha256').update(KNOWN_TOKEN).digest('hex'), 1, now - 100, now + 86_400 * 30);
  db.prepare('INSERT INTO sessions (hash,user_id,created,expires) VALUES (?,?,?,?)')
    .run('expired'.padEnd(64, '0'), 2, now - 99_999, now - 10);    // already lapsed: must not come over

  const m = db.prepare(`INSERT INTO matches (code,host_id,stake,board,tier,seed,state,winner_id,created,started,settled,open_to_all,fills_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  m.run('OPEN01', 1, 500, 'FRA', 2, 1234, 'open', null, now - 30, null, null, 1, now + 40);
  m.run('DONE01', 1, 7000, 'DEU', 2, 999, 'done', 1, now - 600, now - 590, now - 500, 0, null);
  m.run('GONE01', 2, 1000, 'CAN', 2, 222, 'playing', null, now - 400, now - 390, null, 0, null);

  const p = db.prepare('INSERT INTO match_players (code,user_id,joined,tier,pct,ms,done) VALUES (?,?,?,?,?,?,?)');
  p.run('OPEN01', 1, now - 30, 2, 0, null, null);
  p.run('OPEN01', 7, now - 20, 3, 0, null, null);
  p.run('DONE01', 1, now - 600, 2, 100, 3100, (now - 500) * 1000);
  p.run('DONE01', 2, now - 600, 2, 100, 6200, (now - 495) * 1000);
  p.run('GONE01', 2, now - 400, 2, 45, null, null);
  p.run('GONE01', 99, now - 400, 2, 10, null, null);   // the seat of an account that has since been deleted
  db.close();
}

await migrate();
const report = await importSqlite(file, { fresh: true });

section('Everything that should have come over, came over');
eq(report.written.users, 3, 'every account arrived');
eq(report.written.matches, 3, 'every match arrived');
eq(report.written.match_players, 5, 'five of the six seats arrived');
eq(report.skipped.match_players_without_account, 1, 'and the sixth is the one whose account is gone');
eq(report.written.sessions, 1, 'the live session came over');
eq(report.skipped.sessions_expired, 1, 'the lapsed one did not');

section('Not a coin was created or destroyed');
eq(report.gold.sqlite_total, 63_400, 'the old total is what we expect');
eq(report.gold.postgres_total, report.gold.sqlite_total, 'and the new total matches it');
eq(report.gold.ledger_total, report.gold.postgres_total, 'with a ledger that adds up to the same');

section('Every built-in check passed');
for (const c of report.checks) ok(c.ok, `${c.name}${c.detail ? ` — ${c.detail}` : ''}`);

section('Ids are preserved, gaps and all');
{
  const rows = await query<{ id: number; name: string }>(pool, 'SELECT id, name FROM users ORDER BY id');
  eq(rows.rows.map(r => r.id), [1, 2, 7], 'the account ids are exactly the ones from before');
  eq(rows.rows[2]!.name, 'Sumi', 'and they still belong to the right people');
}

section('A pot keeps the stakes that went into it');
{
  const g = await query<{ stakes_in: number; live: number }>(pool,
    `SELECT stakes_in, (SELECT COUNT(*)::int FROM match_players p WHERE p.code='GONE01') AS live
       FROM matches WHERE code = 'GONE01'`);
  eq(g.rows[0]!.stakes_in, 2, 'two stakes went into the room');
  eq(g.rows[0]!.live, 1, 'even though only one player is left to name');
}

section('A player who was signed in is still signed in');
{
  const who = await userForToken(KNOWN_TOKEN);
  ok(who !== null, 'the old session token is accepted by the new service');
  eq(who?.id, 1, 'and it is still the same account');
  eq(who?.gold, 50_000, 'with the gold they had');
}

section('The next sign-up does not land on somebody');
{
  await query(pool, `INSERT INTO users (provider, sub, name, gold) VALUES ('google','sub-new','New', 0)`);
  const max = await query<{ id: number }>(pool, `SELECT id FROM users WHERE sub = 'sub-new'`);
  ok(max.rows[0]!.id > 7, `a new account gets a fresh id (${max.rows[0]!.id})`);
}

section('Running it again into a live database is refused');
{
  let refused = false;
  try { await importSqlite(file); } catch { refused = true; }
  ok(refused, 'the importer will not quietly double-import over real players');
}

rmSync(dir, { recursive: true, force: true });
await finish();
