// Player accounts. Signing in is only needed to play with other people; the single-player game never asks.
//
// The token model is the one the PHP service used, because it was already the right one: a long random opaque
// token, stored only as a SHA-256 hash, carrying no claims of its own. What is new is how it travels. A browser
// keeps using an HttpOnly cookie. A phone app sends the same token as `Authorization: Bearer <token>` and gets
// it back in the sign-in response body. No JWT: this game has one backend, so a token it can revoke instantly
// beats one it has to wait out.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool, query, tx } from './db.js';
import { config } from './config.js';
import { give, idem } from './gold.js';
import { log } from './log.js';
import { k, redis, soft } from './redis.js';

export interface User { id: number; name: string; provider: string; pic: string; gold: number; reminder: boolean; }
export interface GoogleClaims { sub: string; name: string; pic: string; }

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
export const newToken = (): string => randomBytes(32).toString('hex');

/** A display name the other players will see: no control characters, no tildes, 24 characters at most. */
export function cleanName(raw: string): string {
  const stripped = (raw ?? '').replace(/[\p{C}~]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return [...stripped].slice(0, 24).join('');
}

/**
 * A profile picture is shown to the other players, so only Google's own host is ever stored. A stolen or forged
 * token cannot talk this game into displaying an image from anywhere else.
 */
export function cleanPic(url: string): string {
  if (!url || url.length > 512) return '';
  let u: URL;
  try { u = new URL(url); } catch { return ''; }
  if (u.protocol !== 'https:') return '';
  const host = u.hostname.toLowerCase();
  return host === 'googleusercontent.com' || host.endsWith('.googleusercontent.com') ? url : '';
}

export const providers = () => ({ google: config.auth.googleClientId || null });

// ── Google sign-in ──

/** Fetch Google's verdict on an ID token. Split out so the checks below can be tested without the network. */
export async function googleFetch(idToken: string): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6_000);
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { signal: ctl.signal });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Is this ID token real, meant for this site, and still valid? Returns the claims we keep, or null. */
export async function googleVerify(
  idToken: string, clientId: string, fetcher: (t: string) => Promise<string | null> = googleFetch,
): Promise<GoogleClaims | null> {
  if (!idToken || idToken.length > 4096 || !clientId) return null;
  const body = await fetcher(idToken);
  if (!body) return null;
  let d: Record<string, unknown>;
  try { d = JSON.parse(body); } catch { return null; }
  if (typeof d !== 'object' || d === null) return null;

  // aud is compared in constant time: it is the check that decides whether a token minted for somebody else's
  // site is accepted here, and it is worth not leaking a byte-by-byte answer to anyone timing it.
  const aud = String(d.aud ?? '');
  if (aud.length !== clientId.length || !timingSafeEqual(Buffer.from(aud), Buffer.from(clientId))) return null;
  const iss = String(d.iss ?? '');
  if (iss !== 'accounts.google.com' && iss !== 'https://accounts.google.com') return null;
  if (Number(d.exp ?? 0) * 1000 <= Date.now()) return null;
  if ('email_verified' in d && (d.email_verified === false || d.email_verified === 'false')) return null;
  const sub = String(d.sub ?? '');
  if (!sub) return null;
  return { sub, name: cleanName(String(d.name ?? '')), pic: cleanPic(String(d.picture ?? '')) };
}

// ── Accounts ──

/**
 * The one-way key a deleted account leaves in account_tombstones: the provider and its id, hashed with a fixed
 * prefix and nothing secret. Enough to know the same Google account when it signs in again; not the id.
 * gold.ts's subHashSql is the same function in SQL.
 */
export const tombstoneHash = (provider: string, sub: string): string =>
  createHash('sha256').update(`puzzle-tombstone:${provider}:${sub}`).digest('hex');

/** Has an account on this provider id been deleted before? Then it has had its welcome gold. */
export async function hasTombstone(c: PoolClient, provider: string, sub: string): Promise<boolean> {
  const r = await query(c, 'SELECT 1 FROM account_tombstones WHERE provider = $1 AND sub_hash = $2', [provider, tombstoneHash(provider, sub)]);
  return (r.rowCount ?? 0) > 0;
}

/** Is there an account on this provider id now? Asked before a sign-in that would make one is let through. */
export async function userExists(c: PoolClient | typeof pool, provider: string, sub: string): Promise<boolean> {
  const r = await query(c, 'SELECT 1 FROM users WHERE provider = $1 AND sub = $2', [provider, sub]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * One account per provider id. Creates the row the first time someone signs in and grants the welcome gold
 * through the ledger, so signing in again can never top it up: the idempotency key is the account itself.
 * Once per Google account, not once per account row: an id that had an account before, deleted since, comes
 * back with a new account and no gold (`granted` 0), or deleting and signing in again would print money.
 */
export async function upsertUser(c: PoolClient, provider: string, claims: GoogleClaims): Promise<{ user: User; created: boolean; granted: number }> {
  const found = await query<{ id: number }>(c, 'SELECT id FROM users WHERE provider = $1 AND sub = $2', [provider, claims.sub]);
  let id: number, created = false, granted = 0;

  if (found.rowCount) {
    id = found.rows[0]!.id;
    // the name is theirs to change, the picture is not: it follows the Google account on every sign-in
    await query(c, `UPDATE users SET seen_at = now(), pic = $2,
                    name = CASE WHEN name = '' THEN $3 ELSE name END WHERE id = $1`, [id, claims.pic, claims.name]);
  } else {
    // The same new account signing in twice at once -- a double tap, the app and a tab -- races here, and
    // the loser must find the row the winner made rather than fall over its unique key.
    const ins = await query<{ id: number }>(c,
      'INSERT INTO users (provider, sub, name, pic, gold) VALUES ($1, $2, $3, $4, 0) ON CONFLICT (provider, sub) DO NOTHING RETURNING id',
      [provider, claims.sub, claims.name, claims.pic]);
    if (ins.rowCount) {
      id = ins.rows[0]!.id;
      created = true;
      if (!(await hasTombstone(c, provider, claims.sub))) {
        const moved = await give(c, id, config.game.signupGold, 'signup', idem.signup(id));
        granted = moved?.applied ? config.game.signupGold : 0;
      }
    } else {
      id = (await query<{ id: number }>(c, 'SELECT id FROM users WHERE provider = $1 AND sub = $2', [provider, claims.sub])).rows[0]!.id;
    }
  }
  const row = await query<User>(c, 'SELECT id, name, provider, pic, gold, reminder FROM users WHERE id = $1', [id]);
  return { user: row.rows[0]!, created, granted };
}

/**
 * Sign-in handed from a browser to the app.
 *
 * Google will not sign a WebView in, and the native way needs every certificate the app is ever signed with
 * registered with Google beforehand. When that fails — a key Play rotated, a phone whose Play services
 * disagree — the app opens the game in the phone's browser, where Google's own button works, and the browser
 * hands the account back: the app makes a nonce and opens /puzzle/?handoff=<nonce>; the browser, signed in,
 * posts the nonce to handoffStart and gets a code; it opens puzzle://signin?code=<code>, which is the app;
 * the app posts code and nonce to handoffRedeem and gets a session of its own.
 *
 * A code is one account, five minutes, one use, and spendable only with the nonce that asked for it. The
 * nonce never leaves the app's own storage and the browser's address bar, so an app that hijacked the
 * puzzle: scheme would hold a code it cannot spend. Both are kept hashed, the way session tokens are.
 */
export const HANDOFF_SECONDS = 300;
export const validNonce = (n: string): boolean => /^[A-Za-z0-9_-]{16,64}$/.test(n);
export const validCode = (c: string): boolean => /^[a-f0-9]{64}$/.test(c);
export async function handoffStart(userId: number, nonce: string): Promise<string | null> {
  const code = newToken();
  const ok = await soft(() => redis.set(k('handoff', hashToken(code)), JSON.stringify({ user: userId, nonce: hashToken(nonce) }), 'EX', HANDOFF_SECONDS, 'NX'), null);
  return ok === 'OK' ? code : null;
}
export async function handoffRedeem(code: string, nonce: string): Promise<User | null> {
  // GETDEL: read and burn in one step, so two redeems of one code cannot both win
  const raw = await soft(() => redis.getdel(k('handoff', hashToken(code))), null);
  if (!raw) return null;
  let rec: { user?: unknown; nonce?: unknown };
  try { rec = JSON.parse(raw) as { user?: unknown; nonce?: unknown }; } catch { return null; }
  if (typeof rec.user !== 'number' || typeof rec.nonce !== 'string') return null;
  const want = Buffer.from(rec.nonce, 'hex'), got = Buffer.from(hashToken(nonce), 'hex');
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const r = await query<User>(pool, 'SELECT id, name, provider, pic, gold, reminder FROM users WHERE id = $1', [rec.user]);
  return r.rows[0] ?? null;
}

export async function startSession(c: PoolClient, userId: number, client: 'web' | 'app'): Promise<string> {
  const token = newToken();
  await query(c, `INSERT INTO sessions (token_hash, user_id, expires_at, client)
                  VALUES ($1, $2, now() + ($3 || ' days')::interval, $4)`,
    [hashToken(token), userId, String(config.auth.sessionDays), client]);
  return token;
}

/** Who is this? Returns null for no token, an unknown token or an expired one (which is swept as we go). */
export async function userForToken(token: string | null): Promise<User | null> {
  if (!token || token.length < 20 || token.length > 256) return null;
  const h = hashToken(token);
  const r = await query<User & { expired: boolean }>(pool,
    `SELECT u.id, u.name, u.provider, u.pic, u.gold, u.reminder, s.expires_at <= now() AS expired
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1`, [h]);
  const row = r.rows[0];
  if (!row) return null;
  if (row.expired) { await query(pool, 'DELETE FROM sessions WHERE token_hash = $1', [h]).catch(() => {}); return null; }
  return { id: row.id, name: row.name, provider: row.provider, pic: row.pic, gold: row.gold, reminder: row.reminder };
}

export const endSession = (token: string | null) =>
  token ? query(pool, 'DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]) : Promise.resolve(null);

/** Sweep sessions nobody can use any more. Cheap, indexed, and keeps the table from growing without end. */
export async function pruneSessions(): Promise<number> {
  const r = await query(pool, 'DELETE FROM sessions WHERE expires_at <= now()');
  if (r.rowCount) log.info('expired sessions pruned', { count: r.rowCount });
  return r.rowCount ?? 0;
}

/**
 * Delete an account and everything attached to it.
 *
 * Rooms that have not started are left properly first, which hands the stake back and passes the crown on; the
 * cascades then take the sessions, the seats and the ledger. A match already being played keeps its stakes_in,
 * so the winner is still paid the pot that was actually staked into it.
 *
 * One thing stays: a tombstone, a one-way hash of the provider's id (see tombstoneHash), so the same Google
 * account signing in again is not handed the welcome gold a second time, and the advertisements it claimed
 * today still count against today's cap.
 */
export async function deleteUser(userId: number, releaseRooms: (c: PoolClient, userId: number) => Promise<void>): Promise<void> {
  await tx(async c => {
    await releaseRooms(c, userId);
    const who = await query<{ provider: string; sub: string; ads: string }>(c,
      `SELECT provider, sub, (SELECT count(*) FROM gold_ledger
                                WHERE user_id = $1 AND reason = 'ad_reward'
                                  AND created_at >= date_trunc('day', now(), 'UTC')) AS ads
         FROM users WHERE id = $1`, [userId]);
    const u = who.rows[0];
    if (u) {
      // Today's claims are added to what the tombstone already carries for today: an account deleted, made
      // again and deleted again the same day has had both lots.
      await query(c,
        `INSERT INTO account_tombstones (provider, sub_hash, deleted_at, ads_day, ads_used)
              VALUES ($1, $2, now(), (now() AT TIME ZONE 'utc')::date, $3)
         ON CONFLICT (provider, sub_hash) DO UPDATE
               SET deleted_at = now(),
                   ads_used = CASE WHEN account_tombstones.ads_day = EXCLUDED.ads_day
                                   THEN account_tombstones.ads_used + EXCLUDED.ads_used ELSE EXCLUDED.ads_used END,
                   ads_day = EXCLUDED.ads_day`,
        [u.provider, tombstoneHash(u.provider, u.sub), Number(u.ads)]);
    }
    await query(c, 'DELETE FROM users WHERE id = $1', [userId]);
  });
}
