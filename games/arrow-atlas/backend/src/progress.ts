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
      tier: int(r.tier, 0, 3, 0),
      arrows: int(r.arrows, 0, 10_000, 0),
    };
    n++;
  }
  return out;
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
