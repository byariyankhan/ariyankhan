// The Arrow Atlas economy. Nothing anywhere else in this service may write users.gold: every movement goes
// through move(), which writes a ledger row and adjusts the balance in the same transaction.
//
// The ledger's idem_key carries the safety. Ask to pay pot ABC123 twice and the second INSERT hits a unique
// index, writes nothing, and reports back that it was already done — so a retried request, a double-clicked
// button and two API processes racing all settle the pot exactly once. This is the property the old service
// had only by luck, from a `WHERE winner_id IS NULL` guard that a second connection could still slip past.
import type { PoolClient } from 'pg';
import { query } from './db.js';

export type GoldReason = 'signup' | 'stake' | 'leave_refund' | 'expire_refund' | 'draw_refund' | 'payout' | 'league' | 'admin';

/** Keys are deterministic, so the same real-world event always produces the same key. */
export const idem = {
  signup: (userId: number) => `signup:${userId}`,
  stake: (seatId: number) => `stake:${seatId}`,
  leaveRefund: (seatId: number) => `leave_refund:${seatId}`,
  expireRefund: (code: string, userId: number) => `expire_refund:${code}:${userId}`,
  drawRefund: (code: string, userId: number) => `draw_refund:${code}:${userId}`,
  payout: (code: string) => `payout:${code}`,
  league: (season: string, userId: number) => `league:${season}:${userId}`,
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
