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
import type { Sql } from './db.js';
import { query } from './db.js';
import { online } from './presence.js';

export interface RecentPlayer {
  id: number;
  name: string;
  pic: string;
  last_at: number;                       // when the two of you last shared a table
  matches: number;                       // how many times, which is what makes "played once" look different
  status: 'playing' | 'online' | 'offline';
}

/** How many rooms back to look. Deep enough to remember last week, short enough to stay one index scan. */
const ROOMS_BACK = 300;

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
      JOIN matches m       ON m.code = mine.code
      JOIN users u         ON u.id = p.user_id
     GROUP BY u.id, u.name, u.pic
     ORDER BY last_at DESC
     LIMIT $2`,
    [userId, Math.max(1, Math.min(100, limit))]);
  if (!r.rowCount) return [];

  const ids = r.rows.map(x => x.id);
  // In a room that has not finished, and has not reported a result: that is "playing" rather than "online",
  // and it is worth saying, because inviting somebody mid-match is how you get ignored.
  const busy = await query<{ user_id: number }>(sql, `
    SELECT DISTINCT p.user_id FROM match_players p JOIN matches m ON m.code = p.code
     WHERE p.user_id = ANY($1::bigint[]) AND p.ms IS NULL AND m.state IN ('open', 'playing')`, [ids]);
  const playing = new Set(busy.rows.map(x => x.user_id));
  const here = new Set<number>();
  // One Redis key each, in parallel: the list is at most a hundred names and each read is a single EXISTS.
  await Promise.all(ids.map(async id => { if (await online.is(id)) here.add(id); }));

  return r.rows.map(x => ({
    id: x.id,
    name: x.name,
    pic: x.pic ?? '',
    last_at: x.last_at.getTime(),
    matches: Number(x.matches),
    status: playing.has(x.id) ? 'playing' : here.has(x.id) ? 'online' : 'offline',
  }));
}

/**
 * May this player send that player an invitation?
 *
 * Only if they have shared a table before. An invitation is a notification on somebody else's screen, so the
 * right to send one has to be earned by something they took part in — and playing a match together is exactly
 * that. It also means no account list, no search by name, and nothing for a stranger to harvest.
 */
export async function havePlayedTogether(sql: Sql, a: number, b: number): Promise<boolean> {
  const r = await query<{ ok: boolean }>(sql, `
    SELECT EXISTS (
      SELECT 1 FROM match_players me
       JOIN match_players them ON them.code = me.code AND them.user_id = $2
      WHERE me.user_id = $1
    ) AS ok`, [a, b]);
  return !!r.rows[0]?.ok;
}
