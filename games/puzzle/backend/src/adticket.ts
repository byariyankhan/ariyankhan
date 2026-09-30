// The ticket an advertisement's gold is claimed with.
//
// A rewarded advertisement on the web cannot be verified: the network tells the page, the page tells us, and
// nothing in between is signed. So the gold was always a bound rather than proof (gold.ts, adClaim) -- and the
// bound was only the daily cap: ten empty POSTs a day paid 5,000 gold with nothing watched at all.
//
// Now a claim needs a ticket, asked for before the advertisement is shown: one per account at a time (asking
// again replaces it), good for ten minutes, spent by the claim that uses it, and not spendable until
// config.game.adMinSeconds have passed since it was issued. A script still gets its ten claims a day, but each
// one costs it a round trip and a wait as long as an advertisement, and no claim can arrive without one being
// asked for first. The ticket lives in Redis; without Redis there is no ticket and no advertisement gold, which
// is the safe way for this to fail.
import { createHash, randomBytes } from 'node:crypto';
import { redis, k } from './redis.js';
import { config } from './config.js';

export const AD_TICKET_SECONDS = 600;

const keyOf = (userId: number): string => k('adticket', userId);
const hashOf = (ticket: string): string => createHash('sha256').update(ticket).digest('hex');
export const validTicket = (t: string): boolean => /^[A-Za-z0-9_-]{16,64}$/.test(t);

/** A fresh ticket for this account, replacing any it had. Null when Redis cannot keep it. */
export async function adTicketStart(userId: number, now = Date.now()): Promise<string | null> {
  const ticket = randomBytes(24).toString('base64url');
  try {
    await redis.set(keyOf(userId), JSON.stringify({ h: hashOf(ticket), at: now }), 'EX', AD_TICKET_SECONDS);
    return ticket;
  } catch { return null; }
}

export type TicketVerdict =
  | { ok: true }
  | { ok: false; why: 'no_ticket' | 'unavailable' }
  | { ok: false; why: 'too_early'; retryMs: number };

// Compare and delete in one step, so two claims racing with the same ticket spend it once between them.
const SPEND = `if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) return 1 end return 0`;

/**
 * Spend a ticket. Too early leaves it where it is, so the same claim sent again once the wait is over goes
 * through; anything else that is not this account's open ticket is `no_ticket`.
 */
export async function adTicketSpend(userId: number, ticket: string, minMs = config.game.adMinSeconds * 1000, now = Date.now()): Promise<TicketVerdict> {
  if (!validTicket(ticket)) return { ok: false, why: 'no_ticket' };
  let raw: string | null;
  try { raw = await redis.get(keyOf(userId)); } catch { return { ok: false, why: 'unavailable' }; }
  let rec: { h?: unknown; at?: unknown } | null = null;
  try { rec = raw ? JSON.parse(raw) as { h?: unknown; at?: unknown } : null; } catch { rec = null; }
  if (!rec || rec.h !== hashOf(ticket) || typeof rec.at !== 'number') return { ok: false, why: 'no_ticket' };
  const age = now - rec.at;
  if (age < minMs) return { ok: false, why: 'too_early', retryMs: Math.ceil(minMs - age) };
  let spent: unknown;
  try { spent = await redis.eval(SPEND, 1, keyOf(userId), raw!); } catch { return { ok: false, why: 'unavailable' }; }
  return Number(spent) === 1 ? { ok: true } : { ok: false, why: 'no_ticket' };
}

/**
 * A claim from a page opened before tickets existed: it sends no ticket at all, and the app keeps a page open
 * for days (it is not reloaded on resume). For a while after the change such a page is still paid -- under the
 * same daily cap, and never twice within adMinSeconds, which one key set only if absent enforces -- so a player
 * who has just watched a real advertisement on it is not told "try again" for ever. After
 * config.game.adLegacyUntil (or without Redis) it is not.
 */
export async function adLegacyOk(userId: number, now = Date.now()): Promise<boolean> {
  const until = Date.parse(config.game.adLegacyUntil);
  if (!Number.isFinite(until) || now >= until) return false;
  try {
    const set = await redis.set(k('adlegacy', userId), '1', 'EX', Math.max(1, Math.round(config.game.adMinSeconds)), 'NX');
    return set === 'OK';
  } catch { return false; }
}
