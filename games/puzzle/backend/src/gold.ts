// The game economy. Nothing anywhere else in this service may write users.gold: every movement goes
// through move(), which writes a ledger row and adjusts the balance in the same transaction.
//
// The ledger's idem_key carries the safety. Ask to pay pot ABC123 twice and the second INSERT hits a unique
// index, writes nothing, and reports back that it was already done — so a retried request, a double-clicked
// button and two API processes racing all settle the pot exactly once. This is the property the old service
// had only by luck, from a `WHERE winner_id IS NULL` guard that a second connection could still slip past.
import type { PoolClient } from 'pg';
import { query } from './db.js';

export type GoldReason = 'signup' | 'stake' | 'leave_refund' | 'expire_refund' | 'draw_refund' | 'payout' | 'league' | 'ad_reward' | 'admin';

/** Keys are deterministic, so the same real-world event always produces the same key. */
export const idem = {
  signup: (userId: number) => `signup:${userId}`,
  stake: (seatId: number) => `stake:${seatId}`,
  leaveRefund: (seatId: number) => `leave_refund:${seatId}`,
  expireRefund: (code: string, userId: number) => `expire_refund:${code}:${userId}`,
  drawRefund: (code: string, userId: number) => `draw_refund:${code}:${userId}`,
  payout: (code: string) => `payout:${code}`,
  // Second and third place, one key each; and what first takes of a place nobody turned up to claim, once the
  // room has closed and it is certain nobody will.
  place: (code: string, userId: number) => `place:${code}:${userId}`,
  placesLeft: (code: string) => `rest:${code}`,
  league: (season: string, userId: number) => `league:${season}:${userId}`,
  // The day and the claim's number within it. Two requests racing for the same nth claim of the same day
  // collide on the unique index, so a double-tapped button mints once -- and the key doubles as the counter
  // the daily cap reads back.
  adReward: (userId: number, day: string, n: number) => `ad:${userId}:${day}:${n}`,
  admin: (ref: string) => `admin:${ref}`,
};

export interface MoveResult {
  /** false when this exact movement had already been recorded: nothing changed, and that is success. */
  applied: boolean;
  /** the balance after the movement, or the untouched balance when it had already been applied */
  gold: number;
}

/**
 * Move gold and record why.
 *
 * `delta` may be negative. A negative move that would take the balance below zero is refused (returns null),
 * which is how a stake fails when a player cannot afford it — the CHECK on users.gold is the backstop, this is
 * the polite path.
 */
export async function move(
  c: PoolClient, userId: number, delta: number, reason: GoldReason, idemKey: string, matchCode: string | null = null,
): Promise<MoveResult | null> {
  const claim = await query<{ id: number }>(c,
    `INSERT INTO gold_ledger (user_id, delta, reason, match_code, idem_key)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (idem_key) DO NOTHING RETURNING id`,
    [userId, delta, reason, matchCode, idemKey]);

  if (claim.rowCount === 0) {
    // Already recorded. Report the balance as it stands so the caller can answer the player.
    const cur = await query<{ gold: number }>(c, 'SELECT gold FROM users WHERE id = $1', [userId]);
    return { applied: false, gold: cur.rows[0]?.gold ?? 0 };
  }

  const upd = await query<{ gold: number }>(c,
    `UPDATE users SET gold = gold + $2 WHERE id = $1 AND gold + $2 >= 0 RETURNING gold`, [userId, delta]);

  if (upd.rowCount === 0) {
    // Not enough gold (or the account vanished). Undo the claim so the key is free if they try again later.
    await query(c, 'DELETE FROM gold_ledger WHERE idem_key = $1', [idemKey]);
    return null;
  }
  return { applied: true, gold: upd.rows[0]!.gold };
}

/** Take a stake. Returns null when the purse cannot cover it, so a match is never created on credit. */
export const take = (c: PoolClient, userId: number, amount: number, idemKey: string, code: string | null = null) =>
  move(c, userId, -Math.abs(amount), 'stake', idemKey, code);

export const give = (c: PoolClient, userId: number, amount: number, reason: GoldReason, idemKey: string, code: string | null = null) =>
  move(c, userId, Math.abs(amount), reason, idemKey, code);

export interface AdClaim {
  /** true when the day's allowance is already spent: nothing was granted and nothing is wrong */
  capped: boolean;
  gold: number;
  granted: number;
  used: number;
  left: number;
}

/**
 * Gold for having watched an advertisement.
 *
 * There is no server-side verification to be had for rewarded ads on the web: the network tells the page, and
 * the page tells us. So this is not built as proof, it is built as a bound. The day's allowance is counted from
 * the ledger rather than from anything the caller says, the key is derived from the day and the count so a
 * retry or a double-tapped button mints exactly once, and the reason is its own so these rows can be found,
 * kept out of the league, and reversed if the reward is ever withdrawn.
 *
 * The count and the insert are in the caller's transaction, so two requests racing see the same count and the
 * second one collides on the unique index rather than granting twice.
 */
export async function adClaim(c: PoolClient, userId: number, amount: number, perDay: number): Promise<AdClaim> {
  const { day, used } = await adUsed(c, userId);
  if (used >= perDay) return { capped: true, gold: await balance(c, userId), granted: 0, used, left: 0 };

  const moved = await give(c, userId, amount, 'ad_reward', idem.adReward(userId, day, used + 1));
  return {
    capped: false,
    gold: moved?.gold ?? await balance(c, userId),
    granted: moved?.applied ? amount : 0,     // applied === false is a retry of a claim that landed: success
    used: used + 1,
    left: Math.max(0, perDay - used - 1),
  };
}

/** Today's advertisement claims for this account, and the day they are counted in. */
export async function adUsed(c: PoolClient | import('pg').Pool, userId: number): Promise<{ day: string; used: number }> {
  // Midnight UTC as PostgreSQL sees it, so every process agrees on when the day turned -- and as a timestamptz,
  // so the comparison does not depend on the session's time zone. The claims an earlier account on the same
  // Google account made today, before it was deleted, count as well (account_tombstones): a new account is
  // not a new day.
  const r = await query<{ day: string; used: string; carried: string }>(c,
    `SELECT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD') AS day,
            (SELECT count(*) FROM gold_ledger
              WHERE user_id = $1 AND reason = 'ad_reward'
                AND created_at >= date_trunc('day', now(), 'UTC')) AS used,
            (SELECT COALESCE(max(t.ads_used), 0) FROM users u
               JOIN account_tombstones t ON t.provider = u.provider AND t.sub_hash = ${subHashSql('u.provider', 'u.sub')}
              WHERE u.id = $1 AND t.ads_day = (now() AT TIME ZONE 'utc')::date) AS carried`,
    [userId]);
  return { day: r.rows[0]!.day, used: Number(r.rows[0]!.used) + Number(r.rows[0]!.carried) };
}

/**
 * The one-way key a deleted account leaves behind (account_tombstones), as SQL over two text expressions. The
 * same sha256 auth.ts's tombstoneHash computes, written here once so every query that looks a tombstone up
 * agrees with the one that wrote it; the test suite checks the two against each other.
 */
export const subHashSql = (provider: string, sub: string): string =>
  `encode(sha256(convert_to('puzzle-tombstone:' || ${provider} || ':' || ${sub}, 'UTF8')), 'hex')`;

export async function balance(c: PoolClient | import('pg').Pool, userId: number): Promise<number> {
  const r = await query<{ gold: number }>(c, 'SELECT gold FROM users WHERE id = $1', [userId]);
  return r.rows[0]?.gold ?? 0;
}

/**
 * Does the ledger add up to the balances? Used by the migration checks and the test suite: if these ever
 * disagree, gold has been created or destroyed outside move() and that is a bug worth failing a deploy over.
 */
export async function ledgerDrift(sql: PoolClient | import('pg').Pool): Promise<{ user_id: number; gold: number; ledger: number }[]> {
  const r = await query<{ user_id: number; gold: number; ledger: number }>(sql, `
    SELECT u.id AS user_id, u.gold, COALESCE(SUM(g.delta), 0)::bigint AS ledger
      FROM users u LEFT JOIN gold_ledger g ON g.user_id = u.id
     GROUP BY u.id, u.gold
    HAVING u.gold <> COALESCE(SUM(g.delta), 0)`);
  return r.rows;
}
