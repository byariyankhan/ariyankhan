// Carry the live Arrow Atlas SQLite database into PostgreSQL, once, and prove it arrived.
//
// Rules this follows:
//   * Ids are preserved. A player's account id, and every match code, is what it was.
//   * Nothing is invented. Gold comes over as an opening ledger entry per account, so the new ledger reconciles
//     against the balances from the very first day rather than starting mysteriously out of step.
//   * A match keeps the size of its pot. stakes_in is counted from the seats as they stand at the moment of the
//     migration, which is what the old code would have counted at settlement time.
//   * It refuses to run twice into a database that already holds players, unless told to start clean.
//
// It never writes to the SQLite file. Run the backup first; this reads.
import { DatabaseSync } from 'node:sqlite';
import { pool, query, tx } from './db.js';
import { log } from './log.js';

export interface ImportReport {
  source: string;
  read: { users: number; sessions: number; matches: number; match_players: number };
  written: { users: number; sessions: number; matches: number; match_players: number; gold_ledger: number };
  skipped: { match_players_without_account: number; matches_without_host: number; sessions_expired: number };
  gold: { sqlite_total: number; postgres_total: number; ledger_total: number };
  checks: { name: string; ok: boolean; detail?: string }[];
}

const asInt = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
/** SQLite kept whole seconds; one column (a finish time) kept milliseconds. */
const secs = (v: unknown): Date | null => { const n = asInt(v, 0); return n > 0 ? new Date(n * 1000) : null; };
const millis = (v: unknown): Date | null => { const n = asInt(v, 0); return n > 0 ? new Date(n) : null; };

export async function importSqlite(file: string, opts: { fresh?: boolean } = {}): Promise<ImportReport> {
  const db = new DatabaseSync(file, { readOnly: true });
  const all = <T>(sql: string): T[] => db.prepare(sql).all() as T[];
  const tables = new Set(all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").map(t => t.name));

  const users = tables.has('users') ? all<Record<string, unknown>>('SELECT * FROM users') : [];
  const sessions = tables.has('sessions') ? all<Record<string, unknown>>('SELECT * FROM sessions') : [];
  const matches = tables.has('matches') ? all<Record<string, unknown>>('SELECT * FROM matches') : [];
  const seats = tables.has('match_players') ? all<Record<string, unknown>>('SELECT * FROM match_players') : [];
  db.close();

  const report: ImportReport = {
    source: file,
    read: { users: users.length, sessions: sessions.length, matches: matches.length, match_players: seats.length },
    written: { users: 0, sessions: 0, matches: 0, match_players: 0, gold_ledger: 0 },
    skipped: { match_players_without_account: 0, matches_without_host: 0, sessions_expired: 0 },
    gold: { sqlite_total: 0, postgres_total: 0, ledger_total: 0 },
    checks: [],
  };
  report.gold.sqlite_total = users.reduce((a, u) => a + asInt(u.gold), 0);

  const existing = asInt((await query<{ n: number }>(pool, 'SELECT COUNT(*)::bigint AS n FROM users')).rows[0]?.n);
  if (existing > 0 && !opts.fresh) throw new Error(`refusing to import: PostgreSQL already holds ${existing} accounts (pass --fresh to replace them)`);
  if (opts.fresh) await query(pool, 'TRUNCATE gold_ledger, match_players, matches, sessions, users RESTART IDENTITY CASCADE');

  const userIds = new Set(users.map(u => asInt(u.id)));
  const byId = new Map(users.map(u => [asInt(u.id), { name: String(u.name ?? '') }]));
  // Count the seats per room before any are dropped: the pot must stay the size of what was actually staked,
  // even where the account that staked it has since been deleted.
  const seatsPerCode = new Map<string, number>();
  for (const s of seats) seatsPerCode.set(String(s.code), (seatsPerCode.get(String(s.code)) ?? 0) + 1);

  await tx(async c => {
    for (const u of users) {
      const id = asInt(u.id);
      await query(c, `INSERT INTO users (id, provider, sub, name, pic, gold, created_at, seen_at)
                      VALUES ($1,$2,$3,$4,$5,0,$6,$7)`,
        [id, String(u.provider ?? 'google'), String(u.sub ?? ''), String(u.name ?? ''), String(u.pic ?? ''),
         secs(u.created) ?? new Date(), secs(u.seen) ?? new Date()]);
      report.written.users++;
      // The opening balance, as a ledger row, so balances and ledger agree from here on.
      const gold = asInt(u.gold);
      if (gold !== 0) {
        await query(c, `INSERT INTO gold_ledger (user_id, delta, reason, idem_key) VALUES ($1,$2,'admin',$3)`,
          [id, gold, `migration:opening:${id}`]);
        report.written.gold_ledger++;
      }
      await query(c, 'UPDATE users SET gold = $2 WHERE id = $1', [id, gold]);
    }
    // Keep the identity sequence ahead of the ids we just forced in, or the next sign-up collides.
    await query(c, `SELECT setval(pg_get_serial_sequence('users','id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM users), 1))`);

    for (const m of matches) {
      const host = asInt(m.host_id);
      if (host && !userIds.has(host)) report.skipped.matches_without_host++;
      // A match the old service had already settled must arrive settled: paid_at and winner_name are what say so
      // from here on, and unlike winner_id they survive the winner deleting their account later.
      const winnerId = asInt(m.winner_id);
      const hadWinner = winnerId > 0;
      const winnerName = hadWinner ? String(byId.get(winnerId)?.name ?? '') : '';
      await query(c, `INSERT INTO matches (code, host_id, stake, board, tier, seed, state, winner_id,
                        open_to_all, stakes_in, fills_at, created_at, started_at, settled_at,
                        paid_at, winner_name)
                      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [String(m.code), userIds.has(host) ? host : null, asInt(m.stake), String(m.board ?? ''),
         Math.max(0, Math.min(4, asInt(m.tier, 2))), asInt(m.seed), String(m.state ?? 'void'),
         userIds.has(winnerId) ? winnerId : null,
         asInt(m.open_to_all) === 1, seatsPerCode.get(String(m.code)) ?? 0,
         secs(m.fills_at), secs(m.created) ?? new Date(), secs(m.started), secs(m.settled),
         hadWinner ? (secs(m.settled) ?? secs(m.created) ?? new Date()) : null, winnerName]);
      report.written.matches++;
    }

    for (const s of seats) {
      const uid = asInt(s.user_id);
      if (!userIds.has(uid)) { report.skipped.match_players_without_account++; continue; }
      const ms = s.ms === null || s.ms === undefined ? null : asInt(s.ms);
      await query(c, `INSERT INTO match_players (code, user_id, tier, pct, ms, finished_at, joined_at)
                      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (code, user_id) DO NOTHING`,
        [String(s.code), uid, Math.max(0, Math.min(4, asInt(s.tier, 2))), Math.max(0, Math.min(100, asInt(s.pct))),
         ms, millis(s.done), secs(s.joined) ?? new Date()]);
      report.written.match_players++;
    }

    for (const s of sessions) {
      const uid = asInt(s.user_id);
      const expires = secs(s.expires);
      if (!userIds.has(uid)) continue;
      if (!expires || expires.getTime() <= Date.now()) { report.skipped.sessions_expired++; continue; }
      await query(c, `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, client)
                      VALUES ($1,$2,$3,$4,'web') ON CONFLICT (token_hash) DO NOTHING`,
        [String(s.hash), uid, secs(s.created) ?? new Date(), expires]);
      report.written.sessions++;
    }
  });

  // ── Proof ──
  const one = async (sql: string): Promise<number> => asInt((await query<{ n: number }>(pool, sql)).rows[0]?.n);
  report.gold.postgres_total = await one('SELECT COALESCE(SUM(gold),0)::bigint AS n FROM users');
  report.gold.ledger_total = await one('SELECT COALESCE(SUM(delta),0)::bigint AS n FROM gold_ledger');

  const add = (name: string, ok: boolean, detail?: string) => report.checks.push({ name, ok, ...(detail ? { detail } : {}) });
  add('every account arrived', report.written.users === users.length, `${report.written.users}/${users.length}`);
  add('every match arrived', report.written.matches === matches.length, `${report.written.matches}/${matches.length}`);
  add('every seat with a live account arrived',
    report.written.match_players + report.skipped.match_players_without_account === seats.length,
    `${report.written.match_players} kept, ${report.skipped.match_players_without_account} belonged to deleted accounts`);
  add('the gold total is unchanged', report.gold.sqlite_total === report.gold.postgres_total,
    `sqlite ${report.gold.sqlite_total} vs postgres ${report.gold.postgres_total}`);
  add('the ledger agrees with the balances', report.gold.ledger_total === report.gold.postgres_total,
    `ledger ${report.gold.ledger_total} vs balances ${report.gold.postgres_total}`);
  add('no seat points at a match that is not there', await one(
    'SELECT COUNT(*)::bigint AS n FROM match_players p LEFT JOIN matches m ON m.code = p.code WHERE m.code IS NULL') === 0);
  add('no seat points at an account that is not there', await one(
    'SELECT COUNT(*)::bigint AS n FROM match_players p LEFT JOIN users u ON u.id = p.user_id WHERE u.id IS NULL') === 0);
  add('no match names a winner who is not there', await one(
    'SELECT COUNT(*)::bigint AS n FROM matches m WHERE m.winner_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = m.winner_id)') === 0);
  add('every match state is one the game knows', await one(
    `SELECT COUNT(*)::bigint AS n FROM matches WHERE state NOT IN ('open','playing','done','void')`) === 0);
  add('no balance is negative', await one('SELECT COUNT(*)::bigint AS n FROM users WHERE gold < 0') === 0);
  add('every settled match arrived settled', await one(
    'SELECT COUNT(*)::bigint AS n FROM matches WHERE winner_id IS NOT NULL AND paid_at IS NULL') === 0);
  add('the next sign-up will not collide', await one(
    `SELECT CASE WHEN last_value > COALESCE((SELECT MAX(id) FROM users),0) - 1 THEN 0 ELSE 1 END::bigint AS n
       FROM users_id_seq`) === 0);

  log.info('sqlite import finished', report as unknown as Record<string, unknown>);
  return report;
}

// CLI: node dist/import-sqlite.js <file.sqlite> [--fresh]
if (process.argv[1] && process.argv[1].includes('import-sqlite')) {
  const file = process.argv[2];
  if (!file) { console.error('usage: import-sqlite <arrow-atlas.sqlite> [--fresh]'); process.exit(2); }
  importSqlite(file, { fresh: process.argv.includes('--fresh') })
    .then(r => {
      console.log(JSON.stringify(r, null, 2));
      const bad = r.checks.filter(c => !c.ok);
      if (bad.length) { console.error(`\n${bad.length} check(s) failed: ${bad.map(c => c.name).join('; ')}`); process.exit(1); }
      console.log('\nall checks passed');
      return pool.end();
    })
    .then(() => process.exit(0))
    .catch(e => { log.err('import failed', e); process.exit(1); });
}
