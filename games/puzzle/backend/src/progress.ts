// A player's tour, kept by the account rather than by the phone.
//
// Two devices sync in whatever order they happen to be opened, so the merge has to be commutative: pushing A
// then B must land where pushing B then A lands, and pushing the same thing twice must change nothing the
// second time. Every field here only improves — more stars wins, equal stars means the faster time wins, and
// the three flags go from false to true and never back. An old phone opened after a month uploads a worse run
// and moves nothing, which is the behaviour a player expects and the one they never think about.
//
// The merge is done by the database, in the ON CONFLICT clause, not read-modify-written here. Two of this
// player's devices pushing at the same moment would otherwise interleave and one would lose.
import type { Sql } from './db.js';
import { query } from './db.js';

/** One board, as the client keeps it and as the client gets it back. */
export interface LevelRec {
  cleared?: boolean;
  skipped?: boolean;
  quiz?: boolean;
  ms?: number | null;
  stars?: number;
  tier?: number;
  arrows?: number;
  at?: number;          // epoch ms, for the client's own display only
}
export type Levels = Record<string, LevelRec>;
/** Home country, difficulty ladder, daily boards: shaped by the client, so it is carried rather than modelled. */
export type PlayerState = Record<string, unknown>;

export const MAX_LEVELS_PER_PUSH = 600;   // the whole tour is 197 countries plus their discovery boards
const MAX_LEVEL_ID = 64;
const MAX_STATE_BYTES = 16 * 1024;

const int = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = typeof v === 'number' ? Math.round(v) : NaN;
  return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
};

/**
 * What a client sent, reduced to what this service is willing to store. Anything malformed is dropped rather
 * than rejected: one bad row in a batch of two hundred should not cost a player the other one hundred and
 * ninety-nine, and none of this is worth an error the game would have to explain.
 */
export function cleanLevels(raw: unknown, known?: (id: string) => boolean): Levels {
  const out: Levels = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  let n = 0;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_LEVELS_PER_PUSH) break;
    if (!id || id.length > MAX_LEVEL_ID) continue;
    if (known && !known(id)) continue;          // a board this build has never heard of
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const r = v as Record<string, unknown>;
    const cleared = r.cleared === undefined ? true : !!r.cleared;   // the client's older records are all clears
    const skipped = !!r.skipped;
    if (!cleared && !skipped) continue;                             // a row that says nothing happened
    const msRaw = typeof r.ms === 'number' ? Math.round(r.ms) : typeof r.t === 'number' ? Math.round(r.t as number) : 0;
    out[id] = {
      cleared, skipped,
      quiz: !!r.quiz,
      ms: msRaw > 0 && msRaw <= 86_400_000 ? msRaw : null,          // over a day on one board is not a time
      stars: int(r.stars, 0, 3, 0),
      tier: int(r.tier, 0, 4, 0),          // five tiers, Master is 4
      arrows: int(r.arrows, 0, 10_000, 0),
    };
    n++;
  }
  return out;
}

/** What one device has counted on one board: starts, clears, hearts run out, and what the clears cost. */
export interface LevelStat { plays: number; clears: number; fails: number; hints: number; hearts: number; ms: number }
export type Stats = Record<string, LevelStat>;
const MAX_STAT = 1_000_000;

/** A device's own id, made once on the phone: letters and digits, short. */
export function cleanDevice(raw: unknown): string {
  const d = String(raw ?? '').trim();
  return /^[A-Za-z0-9_-]{4,40}$/.test(d) ? d : '';
}

/** The counts a device sent, bounded; a board with nothing counted is dropped. */
export function cleanStats(raw: unknown, known?: (id: string) => boolean): Stats {
  const out: Stats = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  let n = 0;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_LEVELS_PER_PUSH) break;
    if (!id || id.length > MAX_LEVEL_ID) continue;
    if (known && !known(id)) continue;
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const r = v as Record<string, unknown>;
    const s: LevelStat = {
      plays: int(r.p ?? r.plays, 0, MAX_STAT, 0), clears: int(r.c ?? r.clears, 0, MAX_STAT, 0),
      fails: int(r.f ?? r.fails, 0, MAX_STAT, 0), hints: int(r.h ?? r.hints, 0, MAX_STAT, 0),
      hearts: int(r.l ?? r.hearts, 0, MAX_STAT, 0), ms: int(r.ms, 0, 1_000_000_000_000, 0),
    };
    if (!s.plays && !s.clears && !s.fails) continue;
    out[id] = s;
    n++;
  }
  return out;
}

/**
 * A device's totals, merged: every count only grows, so the row keeps the larger of what it has and what
 * arrived, and a batch posted twice changes nothing the second time.
 */
export async function mergeStats(c: Sql, userId: number, device: string, stats: Stats): Promise<number> {
  const ids = Object.keys(stats);
  if (!ids.length || !device) return 0;
  const r = await query<{ moved: boolean }>(c, `
    INSERT INTO level_stats (user_id, device, level_id, plays, clears, fails, hints, hearts, ms)
    SELECT $1, $2, u.level_id, u.plays, u.clears, u.fails, u.hints, u.hearts, u.ms
      FROM unnest($3::text[], $4::int[], $5::int[], $6::int[], $7::int[], $8::int[], $9::bigint[])
        AS u(level_id, plays, clears, fails, hints, hearts, ms)
    ON CONFLICT (user_id, device, level_id) DO UPDATE SET
      plays = GREATEST(level_stats.plays, EXCLUDED.plays), clears = GREATEST(level_stats.clears, EXCLUDED.clears),
      fails = GREATEST(level_stats.fails, EXCLUDED.fails), hints = GREATEST(level_stats.hints, EXCLUDED.hints),
      hearts = GREATEST(level_stats.hearts, EXCLUDED.hearts), ms = GREATEST(level_stats.ms, EXCLUDED.ms),
      updated_at = now()
    WHERE (level_stats.plays, level_stats.clears, level_stats.fails, level_stats.hints, level_stats.hearts, level_stats.ms)
       IS DISTINCT FROM
          (GREATEST(level_stats.plays, EXCLUDED.plays), GREATEST(level_stats.clears, EXCLUDED.clears),
           GREATEST(level_stats.fails, EXCLUDED.fails), GREATEST(level_stats.hints, EXCLUDED.hints),
           GREATEST(level_stats.hearts, EXCLUDED.hearts), GREATEST(level_stats.ms, EXCLUDED.ms))
    RETURNING true AS moved`,
    [userId, device, ids,
      ids.map(i => stats[i]!.plays), ids.map(i => stats[i]!.clears), ids.map(i => stats[i]!.fails),
      ids.map(i => stats[i]!.hints), ids.map(i => stats[i]!.hearts), ids.map(i => stats[i]!.ms)]);
  return r.rowCount ?? 0;
}

/** One row of the level_difficulty view. */
export interface Difficulty {
  level_id: string; players: number; plays: number; clears: number; fails: number;
  fail_rate: number | null; hints_per_clear: number | null; hearts_per_clear: number | null; seconds_per_clear: number | null;
}
export async function difficulty(c: Sql, minPlayers = 1): Promise<Difficulty[]> {
  const r = await query<Record<string, string | null>>(c, `
    SELECT * FROM level_difficulty WHERE players >= $1
     ORDER BY fail_rate DESC NULLS LAST, seconds_per_clear DESC NULLS LAST, level_id`, [minPlayers]);
  const num = (v: string | null | undefined) => (v == null ? null : Number(v));
  return r.rows.map(x => ({
    level_id: String(x.level_id), players: Number(x.players), plays: Number(x.plays), clears: Number(x.clears), fails: Number(x.fails),
    fail_rate: num(x.fail_rate), hints_per_clear: num(x.hints_per_clear), hearts_per_clear: num(x.hearts_per_clear), seconds_per_clear: num(x.seconds_per_clear),
  }));
}

/** The small settings blob, capped so one account cannot become a place to keep things. */
export function cleanState(raw: unknown): PlayerState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let text: string;
  try { text = JSON.stringify(raw); } catch { return null; }
  if (!text || text.length > MAX_STATE_BYTES) return null;
  return raw as PlayerState;
}

export async function readLevels(c: Sql, userId: number): Promise<Levels> {
  const r = await query<{
    level_id: string; cleared: boolean; skipped: boolean; quiz: boolean;
    ms: number | null; stars: number; tier: number; arrows: number; at: Date;
  }>(c, `SELECT level_id, cleared, skipped, quiz, ms, stars, tier, arrows, at FROM progress WHERE user_id = $1`, [userId]);
  const out: Levels = {};
  for (const row of r.rows) {
    out[row.level_id] = {
      cleared: row.cleared, skipped: row.skipped, quiz: row.quiz,
      ms: row.ms, stars: row.stars, tier: row.tier, arrows: row.arrows,
      at: row.at.getTime(),
    };
  }
  return out;
}

/**
 * How this run compares with everybody else's on the same board.
 *
 * The result card used to say nothing about anyone but the player. A time on its own means little — is a
 * minute and a half good on a board of ninety arrows? — and the one comparison that answers it is the rest of
 * the people who have cleared that same board at that same difficulty.
 *
 * It is only offered once enough of them exist. A percentage worked out from four clears is a made-up number
 * dressed as a fact, and the game would rather say nothing than flatter somebody with arithmetic. Below the
 * floor the answer carries the count alone, and the card falls back to the player's own history.
 *
 * Nobody is named and nothing identifies a row: what comes back is a count and a percentage.
 */
export const PACE_FLOOR = 20;

export interface BoardPace {
  n: number;                 // recorded clears of this board at this difficulty, this player's own excluded
  beats_pct?: number;        // how many of them were slower, as a percentage — only above the floor
}

export async function boardPace(c: Sql, levelId: string, tier: number, ms: number, exceptUser: number | null): Promise<BoardPace> {
  const r = await query<{ n: string; slower: string }>(c, `
    SELECT count(*) AS n, count(*) FILTER (WHERE ms > $3) AS slower
      FROM progress
     WHERE level_id = $1 AND tier = $2 AND cleared AND ms IS NOT NULL
       AND ($4::bigint IS NULL OR user_id <> $4)`, [levelId, tier, ms, exceptUser]);
  const n = Number(r.rows[0]?.n ?? 0);
  if (n < PACE_FLOOR) return { n };
  return { n, beats_pct: Math.round((Number(r.rows[0]!.slower) / n) * 100) };
}

export async function readState(c: Sql, userId: number): Promise<PlayerState> {
  const r = await query<{ state: PlayerState }>(c, `SELECT state FROM users WHERE id = $1`, [userId]);
  return r.rows[0]?.state ?? {};
}

/**
 * Merge a batch in. Returns how many rows the push actually moved, which is what the tests assert on: pushing
 * the same batch twice must report a change the first time and none the second.
 */
export async function mergeLevels(c: Sql, userId: number, levels: Levels): Promise<number> {
  const ids = Object.keys(levels);
  if (ids.length === 0) return 0;

  // One statement for the whole batch: unnest turns the arrays into rows, and the ON CONFLICT decides, per
  // row, whether what arrived is better than what is there. `IS DISTINCT FROM` counts the rows that moved.
  const r = await query<{ moved: boolean }>(c, `
    INSERT INTO progress (user_id, level_id, cleared, skipped, quiz, ms, stars, tier, arrows)
    SELECT $1, u.level_id, u.cleared, u.skipped, u.quiz, u.ms, u.stars, u.tier, u.arrows
      FROM unnest($2::text[], $3::bool[], $4::bool[], $5::bool[], $6::int[], $7::smallint[], $8::smallint[], $9::int[])
        AS u(level_id, cleared, skipped, quiz, ms, stars, tier, arrows)
    ON CONFLICT (user_id, level_id) DO UPDATE SET
      -- a flag only ever turns on
      cleared = progress.cleared OR EXCLUDED.cleared,
      skipped = progress.skipped OR EXCLUDED.skipped,
      quiz    = progress.quiz    OR EXCLUDED.quiz,
      -- the best run wins: more stars, then the faster time. A row with no time never displaces one with a time.
      stars   = GREATEST(progress.stars, EXCLUDED.stars),
      ms      = CASE
                  WHEN EXCLUDED.ms IS NULL THEN progress.ms
                  WHEN progress.ms IS NULL THEN EXCLUDED.ms
                  WHEN EXCLUDED.stars > progress.stars THEN EXCLUDED.ms
                  WHEN EXCLUDED.stars < progress.stars THEN progress.ms
                  ELSE LEAST(progress.ms, EXCLUDED.ms)
                END,
      -- these two describe the better run, so they follow whichever run won on stars then time
      tier    = CASE WHEN EXCLUDED.stars > progress.stars
                       OR (EXCLUDED.stars = progress.stars AND progress.ms IS NOT NULL AND EXCLUDED.ms IS NOT NULL AND EXCLUDED.ms < progress.ms)
                     THEN EXCLUDED.tier ELSE progress.tier END,
      arrows  = CASE WHEN progress.arrows = 0 THEN EXCLUDED.arrows ELSE progress.arrows END,
      at      = now()
    WHERE (progress.cleared, progress.skipped, progress.quiz, progress.stars, progress.ms)
       IS DISTINCT FROM
          (progress.cleared OR EXCLUDED.cleared, progress.skipped OR EXCLUDED.skipped, progress.quiz OR EXCLUDED.quiz,
           GREATEST(progress.stars, EXCLUDED.stars),
           CASE
             WHEN EXCLUDED.ms IS NULL THEN progress.ms
             WHEN progress.ms IS NULL THEN EXCLUDED.ms
             WHEN EXCLUDED.stars > progress.stars THEN EXCLUDED.ms
             WHEN EXCLUDED.stars < progress.stars THEN progress.ms
             ELSE LEAST(progress.ms, EXCLUDED.ms)
           END)
    RETURNING true AS moved`,
    [
      userId,
      ids,
      ids.map(i => !!levels[i]!.cleared),
      ids.map(i => !!levels[i]!.skipped),
      ids.map(i => !!levels[i]!.quiz),
      ids.map(i => levels[i]!.ms ?? null),
      ids.map(i => levels[i]!.stars ?? 0),
      ids.map(i => levels[i]!.tier ?? 0),
      ids.map(i => levels[i]!.arrows ?? 0),
    ]);
  return r.rowCount ?? 0;
}

/**
 * The settings blob. Shallow merge, so a device that knows nothing about a key the other one set does not
 * delete it by pushing without it — the same rule as the levels, one level up.
 */
export async function mergeState(c: Sql, userId: number, state: PlayerState): Promise<void> {
  if (!state || Object.keys(state).length === 0) return;
  await query(c, `UPDATE users SET state = state || $2::jsonb WHERE id = $1`, [userId, JSON.stringify(state)]);
}

/** Everything a device needs to show this player's tour. */
export async function readAll(c: Sql, userId: number): Promise<{ levels: Levels; state: PlayerState }> {
  return { levels: await readLevels(c, userId), state: await readState(c, userId) };
}
