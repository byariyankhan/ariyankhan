// The people you have played with, and whether they are about.
//
// Sharing a link works, but it is the only way in and it is one step too many every single time: open the
// share sheet, pick an app, paste, wait. Most matches are with the same few people, and the game already knows
// who they are — every seat anybody has ever taken is in match_players. So this reads that back: who you have
// sat at a table with, most recent first, with enough about each of them to draw a row and send them an
// invitation without leaving the game.
//
// Nothing here is a friends list. There is no request to accept, nothing to manage, and no way to appear on
// somebody's list except by playing with them — which also makes it the spam rule: an invitation may only be
// sent to somebody you have actually played with.
//
// What it will not say is when somebody was last seen. The order of the list is decided here from that time,
// but the time itself never leaves the server: "played at 3am, then again at 6" is a diary of a person's
// night, and the only thing a player needs in order to decide whether to invite somebody is whether they are
// there now.
import type { Sql } from './db.js';
import { query } from './db.js';
import { online } from './presence.js';
import { redis, k, soft } from './redis.js';

export interface RecentPlayer {
  id: number;
  name: string;
  pic: string;
  matches: number;                       // how many times, which is what makes "played once" look different
  status: 'playing' | 'online' | 'offline';
}

/** How many rooms back to look. Deep enough to remember last week, short enough to stay one index scan. */
const ROOMS_BACK = 300;

/** How fresh a room has to be for a seat in it to mean somebody is at a table. A race is over in minutes. */
const AT_A_TABLE_MINUTES = 30;

/**
 * Who this player has played with lately.
 *
 * The seats are read from the newest rooms this player sat in rather than from a date window: somebody who
 * plays once a month should still find their opponents here, and somebody who plays all day should not have
 * the list grow without bound. Status comes from Redis (who has a socket open) and from the database (who is
 * sitting in a room that has not finished), because "online" and "in a match" are different things to a player
 * deciding whether to invite somebody.
 */
export async function recentPlayers(sql: Sql, userId: number, limit = 24): Promise<RecentPlayer[]> {
  const r = await query<{ id: number; name: string; pic: string | null; last_at: Date; matches: string }>(sql, `
    WITH mine AS (
      SELECT code FROM match_players WHERE user_id = $1 ORDER BY seat_id DESC LIMIT ${ROOMS_BACK}
    )
    SELECT u.id, u.name, u.pic, MAX(m.created_at) AS last_at, COUNT(DISTINCT m.code) AS matches
      FROM mine
      JOIN match_players p ON p.code = mine.code AND p.user_id <> $1
      JOIN matches m       ON m.code = mine.code AND m.started_at IS NOT NULL
      JOIN users u         ON u.id = p.user_id
     WHERE p.user_id NOT IN (SELECT muted_id FROM mutes WHERE user_id = $1)
     GROUP BY u.id, u.name, u.pic
     ORDER BY last_at DESC
     LIMIT $2`,
    [userId, Math.max(1, Math.min(100, limit))]);
  if (!r.rowCount) return [];

  const ids = r.rows.map(x => x.id);
  // In the middle of a race: a match that has started, a result not reported yet, recent enough to still be
  // running. Waiting in a room that has not started is not this — those players are simply here, and asking
  // them to come to your table instead is a fair thing to do. It is the same question the invite route asks
  // before it refuses to interrupt somebody, so the row and the rule cannot disagree. Neither counts a room
  // somebody walked out of hours ago: one stays open by design until the sweeper refunds it.
  const busy = await query<{ user_id: number }>(sql, `
    SELECT DISTINCT p.user_id FROM match_players p JOIN matches m ON m.code = p.code
     WHERE p.user_id = ANY($1::bigint[]) AND p.ms IS NULL AND m.state = 'playing'
       AND m.started_at > now() - ($2 || ' minutes')::interval`, [ids, String(AT_A_TABLE_MINUTES)]);
  const busySeat = new Set(busy.rows.map(x => x.user_id));
  const here = new Set<number>();
  // One Redis key each, in parallel: the list is at most a hundred names and each read is a single EXISTS.
  await Promise.all(ids.map(async id => { if (await online.is(id)) here.add(id); }));

  return r.rows.map(x => ({
    id: x.id,
    name: x.name,
    pic: x.pic ?? '',
    matches: Number(x.matches),
    // The other half: a live socket. Somebody with the game closed is not playing, whatever a half-finished
    // row says, so presence decides first and the seat only chooses between "online" and "in a match".
    status: here.has(x.id) ? (busySeat.has(x.id) ? 'playing' : 'online') : 'offline',
  }));
}

/**
 * Is this player in the middle of a race?
 *
 * Not "has a seat somewhere" — racing: a match that has started, a result they have not reported yet, and
 * recent enough to still be going. Somebody with a board in front of them and a clock running is the one
 * person an invitation must not reach: it is a notification over a game they are being timed on.
 */
export async function isRacing(sql: Sql, userId: number): Promise<boolean> {
  const r = await query<{ ok: boolean }>(sql, `
    SELECT EXISTS (
      SELECT 1 FROM match_players p JOIN matches m ON m.code = p.code
       WHERE p.user_id = $1 AND p.ms IS NULL AND m.state = 'playing'
         AND m.started_at > now() - ($2 || ' minutes')::interval
    ) AS ok`, [userId, String(AT_A_TABLE_MINUTES)]);
  return !!r.rows[0]?.ok;
}

export type InviteVerdict = { ok: true } | { ok: false; why: 'too_soon' | 'enough_today'; retryAfter: number };

// ── How often one person can reach another ──
//
// Asking is never refused (see the invite route): what is bounded is how often the asking lands on somebody.
// It used to be bounded per room, and a room costs nothing -- open one, invite, leave with the stake, open the
// next -- so a single sender could ring a phone twenty times a minute. Both limits are per sender and
// recipient now, whatever room it is for, and both fail closed: with Redis away nothing rings and nothing
// pops up, which is a missed invitation rather than a flood nobody can stop.
export const RING_EVERY_SECONDS = 600;       // a phone rings at most once in ten minutes for one sender
export const RINGS_PER_DAY = 6;              // and at most this many times a day
export const POPS_PER_TEN_MINUTES = 5;       // a card on an open screen, a few times in ten minutes

/** May this invitation ring the recipient's phone? Counts the ring when it may. */
export async function inviteRings(from: number, to: number): Promise<boolean> {
  const first = await soft(() => redis.set(k('invring', from, to), '1', 'EX', RING_EVERY_SECONDS, 'NX'), null);
  if (first !== 'OK') return false;
  const day = new Date().toISOString().slice(0, 10);
  const n = await soft(async () => {
    const [[, count]] = await redis.multi().incr(k('invringday', from, to, day)).expire(k('invringday', from, to, day), 86_400 + 60).exec() as [[Error | null, number], unknown];
    return Number(count);
  }, Infinity);
  return n <= RINGS_PER_DAY;
}

/**
 * May this invitation pop up on the recipient's open screen? The same room again within a minute is the same
 * card already showing, and a sender gets a few cards in ten minutes, not one for every room they can open.
 */
export async function invitePopsUp(from: number, to: number, code: string): Promise<boolean> {
  const fresh = await soft(() => redis.set(k('invpop', from, to, code), '1', 'EX', 60, 'NX'), null);
  if (fresh !== 'OK') return false;
  const n = await soft(async () => {
    const key = k('invpops', from, to);
    const [[, count]] = await redis.multi().incr(key).expire(key, 600, 'NX').exec() as [[Error | null, number], unknown];
    return Number(count);
  }, Infinity);
  return n <= POPS_PER_TEN_MINUTES;
}

/** Seconds until the day's count starts over, which is midnight UTC: a plain answer to "when can I ask again". */
// ── Muting ──
//
// The one answer a player gives about somebody: their invitations are not wanted. Nothing is counted and
// nothing is rate-limited beyond the ordinary request limit, because a limit on asking was in the way of
// people who wanted to be asked; this is in the way of exactly one person, chosen by the one being asked.

export async function mute(sql: Sql, userId: number, mutedId: number): Promise<void> {
  if (userId === mutedId) return;
  await query(sql, `INSERT INTO mutes (user_id, muted_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, mutedId]);
}
export async function unmute(sql: Sql, userId: number, mutedId: number): Promise<void> {
  await query(sql, `DELETE FROM mutes WHERE user_id = $1 AND muted_id = $2`, [userId, mutedId]);
}
/** Has `to` muted `from`? Read before an invitation goes anywhere. */
export async function isMuted(sql: Sql, to: number, from: number): Promise<boolean> {
  const r = await query(sql, `SELECT 1 FROM mutes WHERE user_id = $1 AND muted_id = $2`, [to, from]);
  return (r.rowCount ?? 0) > 0;
}
export async function mutedList(sql: Sql, userId: number): Promise<{ id: number; name: string; pic: string }[]> {
  const r = await query<{ id: number; name: string; pic: string | null }>(sql, `
    SELECT u.id, u.name, u.pic FROM mutes m JOIN users u ON u.id = m.muted_id
     WHERE m.user_id = $1 ORDER BY m.created_at DESC LIMIT 200`, [userId]);
  return r.rows.map(x => ({ id: x.id, name: x.name, pic: x.pic ?? '' }));
}

/**
 * May this player send that player an invitation?
 *
 * Only if they have shared a table before. An invitation is a notification on somebody else's screen, so the
 * right to send one has to be earned by something they took part in — and playing a match together is exactly
 * that. It also means no account list, no search by name, and nothing for a stranger to harvest. A match that
 * never started -- a room somebody sat in for a minute and left, or one the sweeper voided -- is not a table
 * shared, and gives nobody the right to ring a phone.
 */
export async function havePlayedTogether(sql: Sql, a: number, b: number): Promise<boolean> {
  const r = await query<{ ok: boolean }>(sql, `
    SELECT EXISTS (
      SELECT 1 FROM match_players me
       JOIN match_players them ON them.code = me.code AND them.user_id = $2
       JOIN matches m ON m.code = me.code AND m.started_at IS NOT NULL
      WHERE me.user_id = $1
    ) AS ok`, [a, b]);
  return !!r.rows[0]?.ok;
}
