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
/**
 * Boards one account may hold: every country, its discovery board, every focus and scene board and years of
 * laps round the scenes fit many times over. A push past it still updates the boards already held; only new
 * ids beyond the line are dropped. Without it every push could add six hundred invented ids, every push was
 * answered with all of them, and an account could be grown until reading it ran the server out of memory.
 */
export const MAX_LEVEL_ROWS = 5_000;
/** Devices whose counts one account keeps in level_stats; a new one past this replaces the one quietest longest. */
export const MAX_STAT_DEVICES = 16;

/**
 * Could this be a board of the game? A country from the tour's own list (the file the server deals matches
 * from), or one of the boards that live beside the tour: a discovery board (d:<country>), a focus board
 * (f:), a scene board (s:, with an optional ~lap when the tour has gone round the scenes again) or n:. Those
 * are checked by shape rather than by list, because a new one ships in the client's data before this list
 * could know it, and a board a player cleared must not be refused for being new. With no country list at all
 * (the file could not be read) a country is three digits, which is what every one of them is.
 */
const SIDE_BOARD = /^(?:[fn]:[A-Za-z0-9_-]{1,40}|s:[A-Za-z0-9_-]{1,40}(?:~[1-9]\d{0,3})?)$/;
export function levelIdOk(id: string, countries: ReadonlySet<string>): boolean {
  if (typeof id !== 'string' || !id || id.length > MAX_LEVEL_ID) return false;
  if (SIDE_BOARD.test(id)) return true;
  const country = id.startsWith('d:') ? id.slice(2) : id;
  return countries.size ? countries.has(country) : /^(?:\d{3}|n:[A-Za-z0-9_-]{1,40})$/.test(country);   // n: boards have discovery boards too (d:n:kosovo)
}
// What a push may carry as its settings blob before it is refused outright. The blob is sanitised key by key
// below, so this is only the line past which nothing a real client sends could reach -- a device sends its
// last STATE_SEND_DAYS days of daily boards and training, a few hundred bytes a day.
const MAX_STATE_BYTES = 128 * 1024;
/** What one push to the tour may weigh: a whole tour of 600 boards with its counts is about 115 KB. */
export const PROGRESS_BODY_LIMIT = 256 * 1024;

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
// What one device can believably have counted on one board: ten thousand starts of the same board is years of
// doing nothing else. Anything past it is not a count, and is dropped the way a negative one is -- these rows
// are summed into the board-tuning report, and one invented million would outweigh every honest player.
const MAX_STAT = 10_000;
// An hour a clear, on average, is the most time a device's clears can have cost: past that it is not a time.
const MAX_MS_PER_CLEAR = 3_600_000;

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
      hearts: int(r.l ?? r.hearts, 0, MAX_STAT, 0), ms: 0,
    };
    s.ms = int(r.ms, 0, Math.max(1, s.clears) * MAX_MS_PER_CLEAR, 0);
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
  // A device id is whatever the phone made up, so a script could send a new one with every push and grow the
  // account by six hundred rows a time. Past MAX_STAT_DEVICES, the device the account has heard from least
  // recently makes room: a new phone replaces the one in a drawer, and the rows stay bounded.
  const devs = await query<{ device: string }>(c,
    `SELECT device FROM level_stats WHERE user_id = $1 GROUP BY device ORDER BY max(updated_at) DESC, device`, [userId]);
  const known = devs.rows.map(d => d.device);
  if (!known.includes(device) && known.length >= MAX_STAT_DEVICES) {
    await query(c, `DELETE FROM level_stats WHERE user_id = $1 AND device = ANY($2::text[])`,
      [userId, known.slice(MAX_STAT_DEVICES - 1)]);
  }
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

// ── The settings blob ──
//
// Home country, difficulty ladder, daily boards, daily training, streaks, what each device took off the rank.
// It used to be merged one level deep (`state || incoming`), which is right for a key only one device ever
// writes and wrong for every key two devices both keep: each push replaced the whole `train` map, the whole
// `daily` map and the streaks with the pushing device's own copy, and handed that copy straight back. The phone
// and the website each saw only their own training and their own streak, forever. So the keys that are records
// of play are merged here the way the boards are: commutative, idempotent, never taking anything away.
//
//   train   day -> { r, f, g, e, h, p, pp, nx, cl, f1, at }  each round's best score; plays, hints and counts
//           the larger; cl, the puzzles cleared (round -> serial -> when), the union with the earliest time of
//           each; f1, each round's first score of its free puzzle (what its difficulty reads), the lower
//   daily   day -> { t, stars, quiz, tier, arrows, at } the better run: more stars, then the faster time
//   loss    device -> arrows                            the larger per device (each device's count only grows)
//   playStreak, dailyStreak  { count, last }           the later day; two runs that meet are joined
//
// Anything else (home, form) is a setting and the last device to say it wins, as before.

/** Days of daily boards and training a client sends with each push; older ones are already on the account. */
export const STATE_SEND_DAYS = 120;
/**
 * Days of each the account keeps, the newest. Not a window of time: the rank adds up the arrows of every daily
 * board ever cleared and a round's goal counts every day it was played, so nothing is dropped for being old --
 * only past this many, which is years of play and keeps the blob bounded (about 215 bytes a day of both).
 */
export const STATE_KEEP_DAYS = 1000;
const MAX_OTHER_KEYS = 16;               // settings other than the records of play
const MAX_OTHER_BYTES = 4 * 1024;        // each
// Puzzles of one round finished in one day. A round's puzzle takes the better part of a minute, so sixty is an
// hour of one round, every round, in a day -- more than anybody plays, and small enough that a thousand days
// of it cannot make the blob a burden to read.
export const MAX_SERIALS = 200;
// What the account keeps of the whole blob, merged. Each push is capped on the way in (MAX_STATE_BYTES), but
// the merge takes the union of every day ever sent, and a script sending a different week each time could
// grow it to megabytes that every push then parses and writes back. Past this the oldest days are dropped
// first: the newest are the ones another device is missing, if any.
export const MAX_BLOB_BYTES = 512 * 1024;
const MAX_DEVICES = 256;                 // entries in `loss`: every browser and every install is a device, for years
const TRAIN_IDS = ['r', 'f', 'g', 'e'] as const;
const PLAY_KEYS = new Set(['train', 'daily', 'loss', 'playStreak', 'dailyStreak']);

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (d: Date) => d.toISOString().slice(0, 10);
/** The day after `day`, both as YYYY-MM-DD; empty for anything that is not a day. */
export function nextDay(day: string): string {
  if (!DAY.test(day)) return '';
  const d = new Date(day + 'T00:00:00Z'); if (Number.isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + 1);
  return dayOf(d);
}
/** The last day a record may carry: the UTC date plus one, since no time zone is more than a day ahead of UTC. */
function dayWindow(now: Date): { to: string } {
  const to = new Date(now); to.setUTCDate(to.getUTCDate() + 1);
  return { to: dayOf(to) };
}
const inWindow = (day: string, w: { to: string }) => DAY.test(day) && dayNum(day) !== null && day <= w.to;
/** A day as a whole number of days, for arithmetic on dates without a clock or a time zone in it. */
function dayNum(day: string): number | null {
  if (!DAY.test(day)) return null;
  const t = Date.parse(day + 'T00:00:00Z');
  return Number.isNaN(t) || dayOf(new Date(t)) !== day ? null : Math.round(t / 86_400_000);
}
const num = (v: unknown, lo: number, hi: number): number | undefined => {
  const n = typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n >= lo && n <= hi ? n : undefined;
};
const cnt = (v: unknown) => { const n = num(v, 0, 1_000_000); return n === undefined ? undefined : Math.floor(n); };
const EPOCH_MAX = 4_102_444_800_000;     // 2100

/** One day of training, reduced to what the game keeps. Undefined if nothing in it is a record of play. */
function cleanTrainDay(raw: unknown): Rec | undefined {
  if (!isObj(raw)) return undefined;
  const out: Rec = {};
  for (const id of TRAIN_IDS) { const v = num(raw[id], 0, 100); if (v !== undefined) out[id] = Math.round(v); }
  for (const k of ['h', 'p'] as const) { const v = cnt(raw[k]); if (v) out[k] = v; }
  for (const k of ['pp', 'nx'] as const) {
    if (!isObj(raw[k])) continue;
    const m: Rec = {};
    for (const id of TRAIN_IDS) { const v = cnt((raw[k] as Rec)[id]); if (v) m[id] = v; }
    if (Object.keys(m).length) out[k] = m;
  }
  // the puzzles of each round finished that day: serial -> when. Each is a level on the player's main count.
  if (isObj(raw.cl)) {
    const cl: Rec = {};
    for (const id of TRAIN_IDS) {
      const m = (raw.cl as Rec)[id]; if (!isObj(m)) continue;
      const o: Rec = {};
      for (const [x, v] of Object.entries(m)) {
        if (Object.keys(o).length >= MAX_SERIALS) break;
        const when = num(v, 1, EPOCH_MAX); if (/^(0|[1-9]\d{0,3})$/.test(x) && when !== undefined) o[x] = Math.floor(when);
      }
      if (Object.keys(o).length) cl[id] = o;
    }
    if (Object.keys(cl).length) out.cl = cl;
  }
  // the first finish of each round's free puzzle that day, whatever it scored: the client's difficulty step
  // reads it (trainTier) instead of the day's best, which replays can push up
  if (isObj(raw.f1)) {
    const f1: Rec = {};
    for (const id of TRAIN_IDS) { const v = num((raw.f1 as Rec)[id], 0, 100); if (v !== undefined) f1[id] = Math.round(v); }
    if (Object.keys(f1).length) out.f1 = f1;
  }
  const at = num(raw.at, 0, EPOCH_MAX); if (at !== undefined) out.at = Math.floor(at);
  return Object.keys(out).some(k => k !== 'at') ? out : undefined;
}
function mergeTrainDay(a: Rec | undefined, b: Rec | undefined): Rec | undefined {
  if (!a) return b; if (!b) return a;
  const out: Rec = {};
  for (const id of TRAIN_IDS) { const x = a[id] as number | undefined, y = b[id] as number | undefined; if (x !== undefined || y !== undefined) out[id] = Math.max(x ?? -1, y ?? -1); }
  for (const k of ['h', 'p', 'at'] as const) { const x = (a[k] as number | undefined) ?? 0, y = (b[k] as number | undefined) ?? 0; if (x || y) out[k] = Math.max(x, y); }
  for (const k of ['pp', 'nx'] as const) {
    const x = (a[k] as Rec | undefined) ?? {}, y = (b[k] as Rec | undefined) ?? {}, m: Rec = {};
    for (const id of TRAIN_IDS) { const v = Math.max((x[id] as number | undefined) ?? 0, (y[id] as number | undefined) ?? 0); if (v) m[id] = v; }
    if (Object.keys(m).length) out[k] = m;
  }
  const ca = (a.cl as Rec | undefined) ?? {}, cb = (b.cl as Rec | undefined) ?? {}, cl: Rec = {};
  for (const id of TRAIN_IDS) {
    const o: Record<string, number> = { ...((ca[id] as Record<string, number> | undefined) ?? {}) };
    for (const [x, v] of Object.entries((cb[id] as Record<string, number> | undefined) ?? {})) o[x] = x in o ? Math.min(o[x]!, v) : v;
    // the lowest MAX_SERIALS, as cleanTrainDay keeps: the union of two capped maps can pass the cap, and "the
    // lowest k of the union" stays commutative and idempotent where "whatever came first" would not
    const keep = Object.keys(o).sort((m, n) => Number(m) - Number(n)).slice(0, MAX_SERIALS);
    if (keep.length) cl[id] = Object.fromEntries(keep.map(x => [x, o[x]!]));
  }
  if (Object.keys(cl).length) out.cl = cl;
  // the first scores: the lower of the two, per round -- the same whichever way round, and again if merged twice
  const fa = (a.f1 as Rec | undefined) ?? {}, fb = (b.f1 as Rec | undefined) ?? {}, f1: Rec = {};
  for (const id of TRAIN_IDS) { const x = fa[id] as number | undefined, y = fb[id] as number | undefined; if (x !== undefined || y !== undefined) f1[id] = Math.min(x ?? 101, y ?? 101); }
  if (Object.keys(f1).length) out.f1 = f1;
  return out;
}

/** One daily board, as the client saves it. */
function cleanDailyDay(raw: unknown): Rec | undefined {
  if (!isObj(raw)) return undefined;
  const t = num(raw.t, 1, 86_400_000), stars = num(raw.stars, 0, 3), tier = num(raw.tier, 0, 4), arrows = num(raw.arrows, 0, 10_000), at = num(raw.at, 0, EPOCH_MAX);
  if (t === undefined) return undefined;   // every board the client saves has its time; one without is not a run
  const out: Rec = { t: Math.round(t), stars: stars === undefined ? 0 : Math.round(stars), quiz: !!raw.quiz };
  if (tier !== undefined) out.tier = Math.round(tier);
  if (arrows !== undefined) out.arrows = Math.round(arrows);
  if (at !== undefined) out.at = Math.floor(at);
  return out;
}
/** The better of two runs of the same daily board: more stars, then the faster time; the answered quiz is kept. */
function mergeDailyDay(a: Rec | undefined, b: Rec | undefined): Rec | undefined {
  if (!a) return b; if (!b) return a;
  const sa = a.stars as number, sb = b.stars as number, ta = a.t as number, tb = b.t as number;
  const bWins = sb !== sa ? sb > sa : tb < ta;
  const win = bWins ? b : a;
  return { ...win, quiz: !!a.quiz || !!b.quiz };
}

/** A map of days, cleaned day by day: real days, none in the future, the newest STATE_KEEP_DAYS of them. */
function cleanDays(raw: unknown, clean: (v: unknown) => Rec | undefined, w: { to: string }): Record<string, Rec> {
  const out: Record<string, Rec> = {};
  if (!isObj(raw)) return out;
  const days = Object.keys(raw).filter(d => inWindow(d, w)).sort().slice(-STATE_KEEP_DAYS);
  for (const day of days) { const r = clean(raw[day]); if (r) out[day] = r; }
  return out;
}
function mergeDays(a: Record<string, Rec>, b: Record<string, Rec>, merge: (x: Rec | undefined, y: Rec | undefined) => Rec | undefined): Record<string, Rec> {
  const out: Record<string, Rec> = { ...a };
  for (const [day, r] of Object.entries(b)) { const m = merge(out[day], r); if (m) out[day] = m; }
  return out;
}

/**
 * What each device took off the rank. Past MAX_DEVICES entries the largest are kept: a new device's count still
 * gets in, and what makes room is the smallest, a browser long cleared. Chosen by count, then id, so the same
 * entries survive whichever order the devices pushed in.
 */
function topLoss(m: Record<string, number>): Record<string, number> {
  const ids = Object.keys(m);
  if (ids.length <= MAX_DEVICES) return m;
  ids.sort((x, y) => m[y]! - m[x]! || (x < y ? -1 : 1));
  return Object.fromEntries(ids.slice(0, MAX_DEVICES).map(id => [id, m[id]!]));
}
function cleanLoss(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObj(raw)) return out;
  for (const [dev, v] of Object.entries(raw)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(dev)) continue;
    const n = cnt(v); if (n) out[dev] = n;
  }
  return topLoss(out);
}

/** A streak: how many days in a row, and the last of them. */
export interface Streak { count: number; last: string }
export function cleanStreak(raw: unknown, now = new Date()): Streak | undefined {
  if (!isObj(raw) || typeof raw.last !== 'string' || !inWindow(raw.last, dayWindow(now))) return undefined;   // no day ahead of the calendar
  const count = cnt(raw.count); if (!count) return undefined;
  return { count, last: raw.last };
}
/**
 * Two devices' streaks of the same player, as one. A streak is a run of days, `count` of them ending on `last`,
 * so two of them are two runs on the calendar: if they overlap or meet, they are one run from the earlier start
 * to the later end -- the phone played Monday and Tuesday, the website Tuesday to Thursday, and that is four
 * days in a row. If there is a gap between them, the later run is the streak.
 */
export function mergeStreak(a: Streak | undefined, b: Streak | undefined): Streak | undefined {
  if (!a) return b; if (!b) return a;
  const ea = dayNum(a.last)!, eb = dayNum(b.last)!;
  const [later, le, earlier, ee] = ea >= eb ? [a, ea, b, eb] : [b, eb, a, ea];
  const ls = le - later.count + 1, es = ee - earlier.count + 1;
  const count = ee >= ls - 1 ? le - Math.min(ls, es) + 1 : later.count;
  return { count, last: later.last };
}

/**
 * What a push may store: the records of play cleaned key by key and trimmed to the window, the other settings
 * carried as they came, each of them small. Refused outright (null) only when it is not an object at all or is
 * far past anything a client sends.
 */
export function cleanState(raw: unknown, now = new Date(), capped = true): PlayerState | null {
  if (!isObj(raw)) return null;
  if (capped) {
    let text: string;
    try { text = JSON.stringify(raw); } catch { return null; }
    if (!text || text.length > MAX_STATE_BYTES) return null;
  }
  const w = dayWindow(now);
  const out: PlayerState = {};
  let others = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'train') { const d = cleanDays(v, cleanTrainDay, w); if (Object.keys(d).length) out.train = d; }
    else if (k === 'daily') { const d = cleanDays(v, cleanDailyDay, w); if (Object.keys(d).length) out.daily = d; }
    else if (k === 'loss') { const l = cleanLoss(v); if (Object.keys(l).length) out.loss = l; }
    else if (k === 'playStreak' || k === 'dailyStreak') { const st = cleanStreak(v, now); if (st) out[k] = st; }
    else {
      if (others >= MAX_OTHER_KEYS || !k || k.length > 64 || v === undefined) continue;
      let size = 0; try { size = JSON.stringify(v)?.length ?? 0; } catch { continue; }
      if (size > MAX_OTHER_BYTES) continue;
      out[k] = v; others++;
    }
  }
  return out;
}

/** Two blobs as one: the records of play merged, the other settings taken from `b`, the newer. Pure. */
export function combineState(a: PlayerState, b: PlayerState, now = new Date()): PlayerState {
  const w = dayWindow(now);
  // what the account already holds is cleaned without the size cap: an old blob is trimmed, never thrown away
  const A = cleanState(a, now, false) ?? {}, B = cleanState(b, now) ?? {};
  const out: PlayerState = {};
  for (const [k, v] of Object.entries(A)) if (!PLAY_KEYS.has(k)) out[k] = v;
  for (const [k, v] of Object.entries(B)) if (!PLAY_KEYS.has(k)) out[k] = v;
  const train = mergeDays(cleanDays(A.train, cleanTrainDay, w), cleanDays(B.train, cleanTrainDay, w), mergeTrainDay);
  if (Object.keys(train).length) out.train = train;
  const daily = mergeDays(cleanDays(A.daily, cleanDailyDay, w), cleanDays(B.daily, cleanDailyDay, w), mergeDailyDay);
  if (Object.keys(daily).length) out.daily = daily;
  const la = cleanLoss(A.loss), lb = cleanLoss(B.loss), all: Record<string, number> = { ...la };
  for (const [dev, n] of Object.entries(lb)) if (n > (all[dev] ?? 0)) all[dev] = n;
  const loss = topLoss(all);
  if (Object.keys(loss).length) out.loss = loss;
  for (const k of ['playStreak', 'dailyStreak'] as const) {
    const st = mergeStreak(cleanStreak(A[k], now), cleanStreak(B[k], now)); if (st) out[k] = st;
  }
  return trimBlob(out);
}

/** The blob within MAX_BLOB_BYTES, the oldest days of training and daily boards going first. */
function trimBlob(out: PlayerState, max = MAX_BLOB_BYTES): PlayerState {
  let size = JSON.stringify(out).length;
  if (size <= max) return out;
  const train = (out.train ?? {}) as Record<string, Rec>, daily = (out.daily ?? {}) as Record<string, Rec>;
  for (const day of [...new Set([...Object.keys(train), ...Object.keys(daily)])].sort()) {
    if (size <= max) break;
    for (const m of [train, daily]) if (m[day]) { size -= JSON.stringify(m[day]).length + day.length + 4; delete m[day]; }
  }
  if (!Object.keys(train).length) delete out.train;
  if (!Object.keys(daily).length) delete out.daily;
  return out;
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
/**
 * The quickest a board can believably be cleared, per arrow. A run faster than this many milliseconds an arrow
 * is not a run anybody played, and counting it would push every honest player's "you beat X%" down: a record
 * says how many arrows its board had, and a time of one millisecond used to be counted like any other.
 */
export const PACE_MS_PER_ARROW = 150;

export interface BoardPace {
  n: number;                 // recorded clears of this board at this difficulty, this player's own excluded
  beats_pct?: number;        // how many of them were slower, as a percentage — only above the floor
}

export async function boardPace(c: Sql, levelId: string, tier: number, ms: number, exceptUser: number | null): Promise<BoardPace> {
  const r = await query<{ n: string; slower: string }>(c, `
    SELECT count(*) AS n, count(*) FILTER (WHERE ms > $3) AS slower
      FROM progress
     WHERE level_id = $1 AND tier = $2 AND cleared AND ms IS NOT NULL
       AND arrows > 0 AND ms >= arrows * $5
       AND ($4::bigint IS NULL OR user_id <> $4)`, [levelId, tier, ms, exceptUser, PACE_MS_PER_ARROW]);
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
export async function mergeLevels(c: Sql, userId: number, levels: Levels, maxRows = MAX_LEVEL_ROWS): Promise<number> {
  let ids = Object.keys(levels);
  if (ids.length === 0) return 0;
  // Boards already on the account always merge; new ones only while the account is under its line.
  const have = await query<{ n: number; held: string[] | null }>(c,
    `SELECT count(*)::int AS n, array_agg(level_id) FILTER (WHERE level_id = ANY($2::text[])) AS held
       FROM progress WHERE user_id = $1`, [userId, ids]);
  const held = new Set(have.rows[0]?.held ?? []);
  let room = Math.max(0, maxRows - (have.rows[0]?.n ?? 0));
  ids = ids.filter(id => held.has(id) || room-- > 0);
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
      -- the most the board has ever paid, whichever run it was: a replay at a lower tier, or a device that only
      -- saw that replay, must not take arrows off the rank (the rank is the sum of these)
      arrows  = GREATEST(progress.arrows, EXCLUDED.arrows),
      at      = now()
    WHERE (progress.cleared, progress.skipped, progress.quiz, progress.stars, progress.arrows, progress.ms)
       IS DISTINCT FROM
          (progress.cleared OR EXCLUDED.cleared, progress.skipped OR EXCLUDED.skipped, progress.quiz OR EXCLUDED.quiz,
           GREATEST(progress.stars, EXCLUDED.stars), GREATEST(progress.arrows, EXCLUDED.arrows),
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
 * The settings blob, merged in. A key a device did not send is left as it is; a key it did send is combined
 * with what the account has (combineState). Read and written under the row's lock, so two of this player's
 * devices pushing at the same moment take turns rather than each writing over the other; the route runs it
 * inside the push's transaction, which is what holds the lock until the write.
 *
 * FOR NO KEY UPDATE, not FOR UPDATE: the same push has just inserted progress rows, and each insert's foreign
 * key holds a KEY SHARE lock on this user's row. FOR UPDATE conflicts with KEY SHARE, so two devices pushing
 * together would each wait on the other's inserts -- a deadlock. NO KEY UPDATE does not conflict with KEY
 * SHARE and still makes a second push wait for the first, then read what the first one wrote.
 */
export async function mergeState(c: Sql, userId: number, state: PlayerState): Promise<void> {
  if (!state || Object.keys(state).length === 0) return;
  const r = await query<{ state: PlayerState }>(c, `SELECT state FROM users WHERE id = $1 FOR NO KEY UPDATE`, [userId]);
  if (!r.rows[0]) return;
  const merged = combineState(r.rows[0].state ?? {}, state);
  await query(c, `UPDATE users SET state = $2::jsonb WHERE id = $1`, [userId, JSON.stringify(merged)]);
}

/** Everything a device needs to show this player's tour. */
export async function readAll(c: Sql, userId: number): Promise<{ levels: Levels; state: PlayerState }> {
  return { levels: await readLevels(c, userId), state: await readState(c, userId) };
}
