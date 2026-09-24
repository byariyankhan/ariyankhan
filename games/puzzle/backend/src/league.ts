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
import * as push from './push.js';

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

/** How many places the game shows. A hundred is a table worth climbing, and it is one query either way. */
export const TABLE_SIZE = 100;

export interface Standing {
  rank: number;
  user_id: number;
  name: string;
  pic: string;
  earning: number;
  /** how many different people this player sat at a started table with this week */
  opponents: number;
  /** whether this line can be paid a prize: in front on the week, and against enough different people */
  eligible: boolean;
}

/**
 * The whole table for one season, every player in order. standings() is its first page, placeOf() one line
 * of it, settleDue() pays from it, so the three can never disagree.
 *
 * Everyone who played is in it. Playing a gold match is what puts you on the board — a friend's room counts
 * the same as a room filled from the world, because both stake gold and both pay a pot — and a week you are
 * down on is a place near the bottom rather than no place at all. A table you fall out of the moment you lose
 * is a table nobody can read their own progress in.
 *
 * **What a week earns is gold taken from other people, and only so much from any one of them.** Netting alone
 * (see the top of this file) stops two accounts gaining together, but the table ranks people one at a time:
 * the account that loses does not care that it lost. So a win is credited against the opponents who paid for
 * it. In each match every winner's gain is shared out over the losers in proportion to what each lost; per
 * pair of players those amounts are netted over the week; and what one player can take from any single
 * opponent is capped (config.league.opponentCap). A loss always counts in full. Gold whose loser no longer
 * exists -- an account deleted, its stake gone from the ledger with it -- was paid by nobody, and is not
 * credited to anybody.
 *
 * A match counts in the week its room was opened, whole, so one played across midnight on a Monday is not a
 * stake in one week and a pot in the next.
 *
 * What losing does cost is the prize: settleDue pays only the players who are in front (see below), so a
 * quiet week still cannot pay five million gold to whoever lost the least, and only players who have played at
 * least config.league.minOpponents different people -- so a prize cannot be two accounts and a friends' room.
 * The lines that can be paid are ranked first, so the ranks 1, 2, 3 on the table are the prize places, the
 * same numbers settlement pays; then everybody else by earning.
 *
 * The tie-break is who got there first — equal earnings, and the one who stopped earlier is ahead — then the
 * older account, so the order is total and the same every time it is asked for.
 */
export async function table(sql: Sql, s: Season): Promise<Standing[]> {
  const { opponentCap, minOpponents } = config.league;
  const r = await query<{ user_id: number; name: string; pic: string; earning: string; opponents: number; eligible: boolean }>(sql, `
    WITH rows AS (
      SELECT g.user_id, g.match_code AS mk, g.delta, g.created_at, m.started_at IS NOT NULL AS played
        FROM gold_ledger g JOIN matches m ON m.code = g.match_code
       WHERE m.created_at >= $1 AND m.created_at < $2 AND g.reason = ANY($3::text[])
      UNION ALL
      -- play with no room to it (nothing writes one now) stands alone: its loss counts, and a gain is nobody's
      SELECT g.user_id, 'row:' || g.id, g.delta, g.created_at, false
        FROM gold_ledger g
       WHERE g.match_code IS NULL AND g.created_at >= $1 AND g.created_at < $2 AND g.reason = ANY($3::text[])
    ), net AS (
      SELECT user_id, mk, SUM(delta)::numeric AS n, MAX(created_at) AS last_at, bool_or(played) AS played
        FROM rows GROUP BY user_id, mk
    ), side AS (
      SELECT mk, COALESCE(SUM(n) FILTER (WHERE n > 0), 0) AS won, COALESCE(-SUM(n) FILTER (WHERE n < 0), 0) AS lost
        FROM net GROUP BY mk
    ), flow AS (
      SELECT w.user_id AS p, l.user_id AS o, w.n * (-l.n) / GREATEST(s.won, s.lost) AS a
        FROM net w JOIN side s ON s.mk = w.mk JOIN net l ON l.mk = w.mk AND l.n < 0
       WHERE w.n > 0
    ), pair AS (
      SELECT p, o, SUM(a) AS a FROM (SELECT p, o, a FROM flow UNION ALL SELECT o, p, -a FROM flow) x GROUP BY p, o
    ), credit AS (
      SELECT p AS user_id, SUM(LEAST(a, $4)) AS c FROM pair GROUP BY p
    ), stray AS (
      -- a loss nobody still here won: a match not over yet, or a winner since deleted
      SELECT n.user_id, SUM(-n.n * GREATEST(s.lost - s.won, 0) / s.lost) AS lost
        FROM net n JOIN side s ON s.mk = n.mk WHERE n.n < 0 GROUP BY n.user_id
    ), foes AS (
      SELECT a.user_id, COUNT(DISTINCT b.user_id)::int AS n
        FROM net a JOIN net b ON b.mk = a.mk AND b.user_id <> a.user_id
       WHERE a.played GROUP BY a.user_id
    ), line AS (
      SELECT p.user_id, MAX(p.last_at) AS last_at FROM net p GROUP BY p.user_id
    ), scored AS (
      SELECT l.user_id, u.name, u.pic, l.last_at,
             ROUND(COALESCE(c.c, 0) - COALESCE(st.lost, 0))::bigint AS earning,
             COALESCE(f.n, 0) AS opponents
        FROM line l JOIN users u ON u.id = l.user_id
        LEFT JOIN credit c ON c.user_id = l.user_id
        LEFT JOIN stray st ON st.user_id = l.user_id
        LEFT JOIN foes f ON f.user_id = l.user_id
    )
    SELECT user_id, name, pic, earning, opponents, (earning > 0 AND opponents >= $5) AS eligible
      FROM scored
     ORDER BY (earning > 0 AND opponents >= $5) DESC, earning DESC, last_at ASC, user_id ASC`,
    [s.startsAt, s.endsAt, PLAY_REASONS, Math.max(0, opponentCap), Math.max(0, minOpponents)]);
  return r.rows.map((row, i) => ({ rank: i + 1, ...row, earning: Number(row.earning) }));
}

/** The first `limit` lines of the table. */
export async function standings(sql: Sql, s: Season, limit = 100): Promise<Standing[]> {
  return (await table(sql, s)).slice(0, Math.max(1, Math.min(500, limit)));
}

export interface Place { rank: number | null; earning: number; opponents: number; eligible: boolean }
/** One player's line in a table already read: no rank and nothing earned if they have not played this week. */
export const lineOf = (rows: Standing[], userId: number): Place => {
  const row = rows.find(r => r.user_id === userId);
  return row ? { rank: row.rank, earning: row.earning, opponents: row.opponents, eligible: row.eligible }
             : { rank: null, earning: 0, opponents: 0, eligible: false };
};

/**
 * One player's own line. Counted over the whole season rather than over the page of the table they can see,
 * so somebody in 340th place is still told where they stand and what they have won.
 *
 * A rank at all means they played this week: a player who has not staked gold since the season opened has no
 * place, and everybody else has one, whichever side of even they are on. It is read from the same table, so
 * the number here and the row there are always the same number.
 */
export async function placeOf(sql: Sql, s: Season, userId: number): Promise<Place> {
  return lineOf(await table(sql, s), userId);
}

// The table a screen reads, kept for a few seconds. Working it out reads the whole week's play, and the league
// screen is open to anybody, signed in or not: without this, every visitor was a full scan of the ledger. A
// result changes what the table says, so the result route drops it (forgetTable) and the next read is fresh.
const TABLE_TTL_MS = 20_000;
let cached: { key: string; at: number; rows: Standing[] } | null = null;
export async function tableCached(sql: Sql, s: Season, now = Date.now()): Promise<Standing[]> {
  if (cached && cached.key === s.key && now - cached.at < TABLE_TTL_MS) return cached.rows;
  const rows = await table(sql, s);
  cached = { key: s.key, at: now, rows };
  return rows;
}
export const forgetTable = (): void => { cached = null; };

/** The season row has to exist before it can be settled. Cheap, idempotent, called from the league's timer. */
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
    // The table now holds everyone who played, so the prizes take only the part of it that can be paid: in
    // front on the week, against enough different people. Those lines sort first, so dropping the rest leaves
    // the ranks running 1, 2, 3 with nothing missing from the middle -- the ranks the table showed all week.
    const paying = (await standings(c, season, config.league.ranks)).filter(p => p.eligible);
    const paid: SettledSeason['paid'] = [];

    for (const p of paying) {
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
    // The gold is in the ledger by now — the transaction above committed before this line — so telling the
    // player is a separate, failable thing that cannot take the payment down with it. A week ends at a time
    // nobody is playing, which is exactly why they are told rather than left to find out.
    // user_id is null for a rank won by an account that has since been deleted: their place is still in the
    // table, but there is nobody left to tell.
    for (const p of done.paid) if (p.gold > 0 && p.user_id) void push.sendToUser(p.user_id, push.leagueNote(p.rank, p.gold));
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
