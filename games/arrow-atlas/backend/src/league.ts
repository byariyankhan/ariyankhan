// The weekly league. Play at the gold tables, and what you win over the week is your place in it.
//
// Three things decide how this behaves, and each one is a decision worth knowing about:
//
// 1. **Earning is net, not gross.** A week's earning is every movement of gold a table caused — stakes paid,
//    pots won, refunds — added up. Gross winnings would reward two accounts passing the same gold back and
//    forth: each pass would add to the winner's total out of nothing. Netting makes that pointless, because
//    the pair together always nets zero. Signup gold, admin corrections and last week's prize are left out,
//    so a prize never counts towards the next league.
//
// 2. **The standings are a query, not a counter.** gold_ledger already records every movement with the time
//    it happened, so the table can be derived at any moment for any week. A second running total kept beside
//    the ledger would be one more thing that can drift away from the balances.
//
// 3. **A season is paid exactly once.** The row is locked, the prizes go through gold.move() with keys of
//    their own, and settled_at is stamped in the same transaction. Two containers sweeping together, a
//    restart mid-settlement, a retry — all of them end with one payment.
import type { Sql } from './db.js';
import { pool, query, tx } from './db.js';
import { config } from './config.js';
import { give, idem } from './gold.js';
import { log } from './log.js';

/** The reasons that count as playing for gold. A prize (`league`), the signup grant and `admin` do not. */
const PLAY_REASONS = ['stake', 'payout', 'leave_refund', 'expire_refund', 'draw_refund'];

/**
 * Seasons are counted from a Monday, so week boundaries land where a player expects them and no season can
 * ever be half a week long because the service restarted. Anchor and length are both configurable; the
 * default is one week from Monday 00:00 UTC.
 */
const ANCHOR_MS = Date.UTC(2024, 0, 1);      // Monday 1 January 2024, 00:00 UTC

export interface Season { key: string; startsAt: Date; endsAt: Date; }

export const seasonLengthMs = (): number => Math.max(3600_000, config.league.hours * 3600_000);

/** Which season a moment falls in. Pure arithmetic: no database, and the same answer in every process. */
export function seasonAt(when: Date | number = Date.now()): Season {
  const t = typeof when === 'number' ? when : when.getTime();
  const len = seasonLengthMs();
  const n = Math.floor((t - ANCHOR_MS) / len);
  const startsAt = new Date(ANCHOR_MS + n * len);
  const endsAt = new Date(ANCHOR_MS + (n + 1) * len);
  return { key: keyOf(startsAt), startsAt, endsAt };
}

export const previousSeason = (s: Season = seasonAt()): Season => seasonAt(s.startsAt.getTime() - 1);

/** The day the season opens, as a date. Readable in a URL and in a log line, and it sorts. */
function keyOf(startsAt: Date): string {
  const iso = startsAt.toISOString();
  // A season shorter than a day (tests, and nothing else) needs the hour in the key to stay unique.
  return seasonLengthMs() >= 86_400_000 ? iso.slice(0, 10) : `${iso.slice(0, 13)}Z`;
}

/**
 * What each rank is paid. The tenth place is the base and every place above it doubles, so with the default
 * ten ranks and a base of 10,000: 10th 10K, 9th 20K … 1st 5.12M.
 */
export function prizeFor(rank: number): number {
  const { ranks, baseGold } = config.league;
  if (!Number.isInteger(rank) || rank < 1 || rank > ranks) return 0;
  return baseGold * 2 ** (ranks - rank);
}
export const prizeLadder = (): number[] =>
  Array.from({ length: config.league.ranks }, (_, i) => prizeFor(i + 1));

export interface Standing {
  rank: number;
  user_id: number;
  name: string;
  pic: string;
  earning: number;
}

/**
 * The table for one season.
 *
 * Only players in front are ranked: a week where you lost more than you won is not a placing, and without
 * that rule a quiet week would pay five million gold to whoever lost the least. The tie-break is who got
 * there first — equal earnings, and the one who stopped earlier is ahead — then the older account, so the
 * order is total and the same every time it is asked for.
 */
export async function standings(sql: Sql, s: Season, limit = 100): Promise<Standing[]> {
  const r = await query<{ user_id: number; name: string; pic: string; earning: number }>(sql, `
    SELECT g.user_id, u.name, u.pic, SUM(g.delta)::bigint AS earning
      FROM gold_ledger g
      JOIN users u ON u.id = g.user_id
     WHERE g.created_at >= $1 AND g.created_at < $2
       AND g.reason = ANY($3::text[])
     GROUP BY g.user_id, u.name, u.pic
    HAVING SUM(g.delta) > 0
     ORDER BY SUM(g.delta) DESC, MAX(g.created_at) ASC, g.user_id ASC
     LIMIT $4`,
    [s.startsAt, s.endsAt, PLAY_REASONS, Math.max(1, Math.min(500, limit))]);
  return r.rows.map((row, i) => ({ rank: i + 1, ...row, earning: Number(row.earning) }));
}

/**
 * One player's own line. Counted over the whole season rather than over the page of the table they can see,
 * so somebody in 340th place is still told where they stand and what they have won.
 */
export async function placeOf(sql: Sql, s: Season, userId: number): Promise<{ rank: number | null; earning: number }> {
  const r = await query<{ rank: number | null; earning: number }>(sql, `
    WITH play AS (
      SELECT user_id, SUM(delta) AS earning, MAX(created_at) AS last_at
        FROM gold_ledger
       WHERE created_at >= $1 AND created_at < $2 AND reason = ANY($3::text[])
       GROUP BY user_id
    ), mine AS (SELECT * FROM play WHERE user_id = $4)
    SELECT COALESCE((SELECT earning FROM mine), 0)::bigint AS earning,
           CASE WHEN (SELECT earning FROM mine) > 0 THEN (
             SELECT 1 + count(*) FROM play p, mine m
              WHERE p.earning > 0
                AND (p.earning > m.earning
                  OR (p.earning = m.earning AND (p.last_at < m.last_at
                  OR (p.last_at = m.last_at AND p.user_id < m.user_id))))
           ) END::int AS rank`,
    [s.startsAt, s.endsAt, PLAY_REASONS, userId]);
  const row = r.rows[0];
  return { rank: row?.rank ?? null, earning: Number(row?.earning ?? 0) };
}

/** The season row has to exist before it can be settled. Cheap, idempotent, called from the sweep and the read. */
export async function ensureSeason(sql: Sql, s: Season = seasonAt()): Promise<void> {
  await query(sql,
    `INSERT INTO league_seasons (key, starts_at, ends_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING`,
    [s.key, s.startsAt, s.endsAt]);
}

/**
 * Every season from the last one on record up to the one running now.
 *
 * A season with no row is a season that can never be settled, and the row is written by whoever is running at
 * the time — so a service that was off over a weekend would leave a hole. This fills it. The seasons in the
 * hole are empty by definition (nobody could play while the service was down), so they settle paying nothing,
 * which is exactly right and keeps the run of seasons unbroken for the Results view.
 */
export async function ensureSeasonsThrough(sql: Sql, now: Date = new Date()): Promise<number> {
  const here = seasonAt(now);
  const last = await query<{ ends_at: Date }>(sql, `SELECT max(ends_at) AS ends_at FROM league_seasons`);
  const from = last.rows[0]?.ends_at ? seasonAt(last.rows[0].ends_at.getTime()) : here;
  let made = 0;
  for (let s = from; s.startsAt <= here.startsAt && made < 60; s = seasonAt(s.endsAt.getTime())) {
    await ensureSeason(sql, s);
    made++;
  }
  return made;
}

export interface SettledSeason {
  key: string;
  ends_at: Date;
  paid: { rank: number; user_id: number | null; name: string; pic: string; earning: number; gold: number }[];
}

/** A season that has been paid, read back for the Results view. Comes from the snapshot, never recomputed. */
export async function resultOf(sql: Sql, key: string): Promise<SettledSeason | null> {
  const s = await query<{ key: string; ends_at: Date }>(sql,
    `SELECT key, ends_at FROM league_seasons WHERE key = $1 AND settled_at IS NOT NULL`, [key]);
  if (!s.rowCount) return null;
  const p = await query<SettledSeason['paid'][number]>(sql,
    `SELECT rank, user_id, name, pic, earning, gold FROM league_prizes WHERE season_key = $1 ORDER BY rank`, [key]);
  return { key: s.rows[0]!.key, ends_at: s.rows[0]!.ends_at, paid: p.rows.map(r => ({ ...r, earning: Number(r.earning), gold: Number(r.gold) })) };
}

/** The most recently paid season, whichever it is. What the game shows under "Last week". */
export async function lastSettled(sql: Sql): Promise<SettledSeason | null> {
  const r = await query<{ key: string }>(sql,
    `SELECT key FROM league_seasons WHERE settled_at IS NOT NULL ORDER BY ends_at DESC LIMIT 1`);
  return r.rowCount ? resultOf(sql, r.rows[0]!.key) : null;
}

/**
 * Pay one finished season, if there is one waiting.
 *
 * The row is taken with FOR UPDATE SKIP LOCKED, so a second container sweeping at the same moment finds
 * nothing to do rather than paying the same league twice. Each prize is a gold movement keyed
 * `league:<season>:<user>`, which means even a settlement that somehow ran twice outside the lock would write
 * its second attempt into a unique violation and move nothing.
 *
 * Returns the season it paid, or null when nothing was due.
 */
export async function settleDue(now: Date = new Date()): Promise<SettledSeason | null> {
  return tx(async c => {
    const due = await query<{ key: string; starts_at: Date; ends_at: Date }>(c, `
      SELECT key, starts_at, ends_at FROM league_seasons
       WHERE settled_at IS NULL AND ends_at <= $1
       ORDER BY ends_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`, [now]);
    const row = due.rows[0];
    if (!row) return null;

    const season: Season = { key: row.key, startsAt: row.starts_at, endsAt: row.ends_at };
    const table = await standings(c, season, config.league.ranks);
    const paid: SettledSeason['paid'] = [];

    for (const p of table) {
      const gold = prizeFor(p.rank);
      if (gold <= 0) continue;
      const moved = await give(c, p.user_id, gold, 'league', idem.league(season.key, p.user_id));
      // A player who deleted their account between the league ending and this sweep has no balance to pay
      // into. Their rank is still recorded, so the table reads the way it was won.
      if (moved === null) log.warn('league prize could not be paid', { season: season.key, rank: p.rank, user_id: p.user_id });
      paid.push({ rank: p.rank, user_id: p.user_id, name: p.name, pic: p.pic, earning: p.earning, gold });
    }

    if (paid.length) {
      await query(c, `
        INSERT INTO league_prizes (season_key, rank, user_id, name, pic, earning, gold)
        SELECT $1, u.rank, u.user_id, u.name, u.pic, u.earning, u.gold
          FROM unnest($2::int[], $3::bigint[], $4::text[], $5::text[], $6::bigint[], $7::bigint[])
            AS u(rank, user_id, name, pic, earning, gold)
        ON CONFLICT (season_key, rank) DO NOTHING`,
        [season.key, paid.map(p => p.rank), paid.map(p => p.user_id), paid.map(p => p.name),
         paid.map(p => p.pic), paid.map(p => p.earning), paid.map(p => p.gold)]);
    }

    await query(c, `UPDATE league_seasons SET settled_at = $2 WHERE key = $1`, [season.key, now]);
    log.info('league settled', { season: season.key, paid: paid.length, gold: paid.reduce((a, p) => a + p.gold, 0) });
    return { key: season.key, ends_at: season.endsAt, paid };
  });
}

/**
 * The housekeeping step: make sure every season up to this one exists, and pay anything that has finished.
 *
 * A service that was off for a fortnight comes back with two seasons waiting; the loop pays them oldest
 * first. It is bounded so a very long outage cannot hold the timer open.
 */
export async function leagueSweep(now: Date = new Date()): Promise<string[]> {
  const settled: string[] = [];
  await ensureSeasonsThrough(pool, now);
  for (let i = 0; i < 8; i++) {
    const done = await settleDue(now);
    if (!done) break;
    settled.push(done.key);
  }
  return settled;
}

// A league boundary comes round once a week, so this is checked once a minute rather than in the two-second
// room sweep: the prizes land within a minute of the week ending, and the ledger is not scanned for nothing
// thirty times a minute in between.
let leagueTimer: NodeJS.Timeout | null = null;
export function startLeagueTimer(everyMs = 60_000): void {
  if (leagueTimer) return;
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    leagueSweep()
      .then(keys => { if (keys.length) log.info('leagues settled', { seasons: keys }); })
      .catch(e => log.err('league sweep failed', e))
      .finally(() => { running = false; });
  };
  tick();                                   // settle anything that ended while the service was down
  leagueTimer = setInterval(tick, Math.max(1_000, everyMs));
  leagueTimer.unref?.();
  log.info('league timer started', { every_ms: Math.max(1_000, everyMs), season_hours: config.league.hours });
}
export function stopLeagueTimer(): void { if (leagueTimer) { clearInterval(leagueTimer); leagueTimer = null; } }
