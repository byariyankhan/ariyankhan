// Shared scaffolding for the Arrow Atlas test suites: a tiny assertion runner and a clean database per file.
import { pool, query, tx } from '../backend/src/db.js';
import { migrate } from '../backend/src/migrate.js';
import { give, idem, ledgerDrift } from '../backend/src/gold.js';
import { config } from '../backend/src/config.js';

let tests = 0, bad = 0;
const failures: string[] = [];

export function ok(cond: unknown, name: string): void {
  tests++;
  if (cond) { console.log(`  ✓ ${name}`); return; }
  bad++; failures.push(name);
  console.log(`  ✗ ${name}`);
}
export const eq = (a: unknown, b: unknown, name: string) =>
  ok(Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b), `${name}${Object.is(a, b) ? '' : ` (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`}`);

export function section(title: string): void { console.log(`\n${title}`); }

export async function finish(): Promise<never> {
  // No suite may leave gold unaccounted for: the balances must equal the ledger, always.
  const drift = await ledgerDrift(pool);
  ok(drift.length === 0, `the ledger accounts for every balance${drift.length ? ` (${JSON.stringify(drift)})` : ''}`);
  console.log(bad ? `\n${bad} of ${tests} failed: ${failures.join('; ')}` : `\nall ${tests} tests passed`);
  await pool.end().catch(() => {});
  process.exit(bad ? 1 : 0);
}

export async function reset(): Promise<void> {
  await migrate();
  // TRUNCATE rather than DROP: it keeps the schema the migrations built, which is what we mean to test against.
  await query(pool, 'TRUNCATE push_tokens, push_subscriptions, league_prizes, league_seasons, progress, level_stats, mutes, account_tombstones, gold_ledger, match_players, matches, sessions, users RESTART IDENTITY CASCADE');
}

/**
 * Wind a started match's clock back, so a clear posted now is past the floor on how fast a board can be
 * cleared (rooms.ts, submitResult) -- which is the only way to test a result without waiting for real. Five
 * minutes: past the floor of any length of match, and short of anything the sweeper counts as idle, which
 * reads when each seat was last heard from rather than when the match began.
 */
export async function begun(code: string, seconds = 300): Promise<void> {
  await query(pool, `UPDATE matches SET started_at = started_at - ($2 || ' seconds')::interval WHERE code = $1`, [code, String(seconds)]);
}

/** A signed-in player with gold to spend, without going anywhere near Google. */
export async function player(name: string, gold = 100_000): Promise<{ id: number; name: string }> {
  return tx(async c => {
    const r = await query<{ id: number }>(c,
      `INSERT INTO users (provider, sub, name, gold) VALUES ('test', $1, $2, 0) RETURNING id`, [`sub-${name}`, name]);
    const id = r.rows[0]!.id;
    if (gold > 0) await give(c, id, gold, 'admin', idem.admin(`seed:${id}`));
    return { id, name };
  });
}

export const stake = () => config.game.stakes[0]!;
export const goldOf = async (id: number): Promise<number> =>
  (await query<{ gold: number }>(pool, 'SELECT gold FROM users WHERE id = $1', [id])).rows[0]?.gold ?? 0;
