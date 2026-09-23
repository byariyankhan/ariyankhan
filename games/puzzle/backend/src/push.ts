// Reaching a player who is not looking at the game.
//
// Two things in this game happen to somebody who is not there to see them: a friend asks them to a match, and
// the league pays out on Sunday night. Everything else the game has to say, it says on a screen the player is
// already looking at. So this layer exists for exactly those two, and it is built to be silent in every other
// case — including when it is not configured at all.
//
// Web Push, not a service of anybody's: the browser hands the page an endpoint at its own push service
// (Google's, Mozilla's, Apple's) plus two keys, the message is encrypted to those keys, and the push service
// delivers it without ever being able to read it. What this service holds is what the browser gave it, and it
// is deleted the moment the browser says the subscription is gone.
//
// The VAPID keypair identifies this server to the push services. The private half comes from the environment
// and is never written down anywhere else; with no keys configured, `enabled` is false, every send is a no-op
// and the endpoints below answer "off" rather than failing. That is deliberate: a deploy that has not had its
// keys set yet is a game without notifications, not a game that is broken.
import webpush from 'web-push';
import { config } from './config.js';
import { pool, query, type Sql } from './db.js';
import { log } from './log.js';
import * as fcm from './fcm.js';

export interface PushSub { endpoint: string; keys: { p256dh: string; auth: string } }

/** What a notification says. `url` is where tapping it lands, relative to the site. */
export interface PushNote {
  kind: 'invited' | 'league' | 'daily';
  title: string;
  body: string;
  url: string;
  /** Notifications sharing a tag replace each other, so ten invites are one line and not ten. */
  tag: string;
}

const vapid = { public: config.push.publicKey, private: config.push.privateKey, subject: config.push.subject };
export const enabled = Boolean(vapid.public && vapid.private);

if (enabled) {
  webpush.setVapidDetails(vapid.subject, vapid.public, vapid.private);
  log.info('push notifications are configured', { subject: vapid.subject });
} else {
  log.info('push notifications are off (no VAPID keys configured)');
}

/** The half of the keypair the browser needs in order to subscribe. Public by definition. */
export const publicKey = (): string => (enabled ? vapid.public : '');

/**
 * Whether a phone with the app can be reached at all. The app has no Push API, so its notifications go
 * through Firebase Cloud Messaging (fcm.ts), which is configured or not independently of the browser's keys.
 */
export const appEnabled = fcm.enabled;

// ── Phones ──

/**
 * A time zone as a device reported it, or the default for one that reported nothing Intl recognises. Kept
 * because seven in the evening is a local fact (reminder.ts), and checked because it is used in a query and
 * handed back to Intl.
 */
export function cleanTz(raw: unknown): string {
  const tz = String(raw ?? '').trim();
  if (!tz || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return config.reminder.defaultTz;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; } catch { return config.reminder.defaultTz; }
}

/** Whether this account wants the evening nudge. Invitations and the league are not affected by it. */
export async function setReminder(sql: Sql, userId: number, on: boolean): Promise<void> {
  await query(sql, `UPDATE users SET reminder = $2 WHERE id = $1`, [userId, on]);
}

/**
 * Remember where to reach this phone. One row per token; a token that changes hands follows the sign-in.
 * A phone with no account (`userId` null) has a row too: the evening nudge needs no account, and most
 * players never sign in. `reminder` is that phone's own answer to the nudge, read only while the row has no
 * account; signed in, users.reminder decides.
 */
export async function saveToken(sql: Sql, userId: number | null, token: string, agent: string, tz = config.reminder.defaultTz, reminder = true): Promise<void> {
  await query(sql, `
    INSERT INTO push_tokens (user_id, token, agent, tz, reminder)
         VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (token) DO UPDATE
            SET user_id = EXCLUDED.user_id, agent = EXCLUDED.agent, tz = EXCLUDED.tz, reminder = EXCLUDED.reminder, seen_at = now(), fails = 0`,
    [userId, token, agent.slice(0, 200), tz, reminder]);
}

/**
 * The player turning notifications off on this phone. Signed in, only their own token is theirs to drop;
 * signed out, the token is the one thing only that phone knows, and knowing it is owning it.
 */
export async function dropToken(sql: Sql, userId: number | null, token: string): Promise<void> {
  if (userId === null) await query(sql, `DELETE FROM push_tokens WHERE token = $1`, [token]);
  else await query(sql, `DELETE FROM push_tokens WHERE user_id = $1 AND token = $2`, [userId, token]);
}

/**
 * Remember where to reach this player.
 *
 * Keyed by endpoint, so the same browser subscribing again updates its row rather than adding another, and a
 * browser that changes hands moves to whoever is signed in on it now.
 */
export async function saveSubscription(sql: Sql, userId: number | null, sub: PushSub, agent: string, tz = config.reminder.defaultTz, reminder = true): Promise<void> {
  await query(sql, `
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, agent, tz, reminder)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (endpoint) DO UPDATE
            SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
                agent = EXCLUDED.agent, tz = EXCLUDED.tz, reminder = EXCLUDED.reminder, seen_at = now(), fails = 0`,
    [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, agent.slice(0, 200), tz, reminder]);
}

/** The player turning notifications off on this browser, or the browser telling us it has dropped them. */
export async function dropSubscription(sql: Sql, userId: number | null, endpoint: string): Promise<void> {
  if (userId === null) await query(sql, `DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
  else await query(sql, `DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`, [userId, endpoint]);
}

/** The nudge switch of a device with no account: set on its own row, found by the token or endpoint only it knows. */
export async function setDeviceReminder(sql: Sql, on: boolean, token: string, endpoint: string): Promise<boolean> {
  let n = 0;
  if (token) n += (await query(sql, `UPDATE push_tokens SET reminder = $2 WHERE token = $1 AND user_id IS NULL`, [token, on])).rowCount ?? 0;
  if (endpoint) n += (await query(sql, `UPDATE push_subscriptions SET reminder = $2 WHERE endpoint = $1 AND user_id IS NULL`, [endpoint, on])).rowCount ?? 0;
  return n > 0;
}

/** Whether this player has any device listening — browser or phone — which is what the client's toggle reads back. */
export async function hasSubscription(sql: Sql, userId: number): Promise<boolean> {
  const r = await query<{ n: number }>(sql, `
    SELECT (SELECT count(*) FROM push_subscriptions WHERE user_id = $1)::int
         + (SELECT count(*) FROM push_tokens        WHERE user_id = $1)::int AS n`, [userId]);
  return (r.rows[0]?.n ?? 0) > 0;
}

const DEAD = new Set([404, 410]);   // the push service saying this subscription no longer exists
const MAX_FAILS = 5;

/**
 * Send one notification to every device a player has.
 *
 * Never throws. A notification that cannot be delivered is a notification that cannot be delivered; the invite
 * it was announcing has already been published to the socket, and the league prize is already in the ledger.
 * Dead endpoints are deleted as the push service reports them, so the table cleans itself.
 */
export async function sendToUser(userId: number, note: PushNote): Promise<number> {
  const [web, app] = await Promise.all([sendToBrowsers(userId, note), sendToPhones(userId, note)]);
  return web + app;
}

/** Every phone this player has the app on, through FCM. The same promises as the browsers: never throws, dead rows go. */
export type TokenRow = { id: number; token: string };
export type SubRow = { id: number; endpoint: string; p256dh: string; auth: string };

async function sendToPhones(userId: number, note: PushNote): Promise<number> {
  const rows = await query<TokenRow>(pool, `SELECT id, token FROM push_tokens WHERE user_id = $1`, [userId]);
  return sendToTokens(rows.rows, note);
}

/** Phones by their rows: what the evening sweep uses for a phone that has no account to be found by. */
export async function sendToTokens(rows: TokenRow[], note: PushNote): Promise<number> {
  if (!appEnabled) return 0;
  let sent = 0;
  try {
    if (!rows.length) return 0;
    await Promise.all(rows.map(async row => {
      const how = await fcm.send(row.token, note, config.push.ttlSeconds);
      if (how === 'sent') {
        sent++;
        await query(pool, `UPDATE push_tokens SET seen_at = now(), fails = 0 WHERE id = $1`, [row.id]);
      } else if (how === 'dead') {
        await query(pool, `DELETE FROM push_tokens WHERE id = $1`, [row.id]);
      } else {
        const r = await query<{ fails: number }>(pool, `UPDATE push_tokens SET fails = fails + 1 WHERE id = $1 RETURNING fails`, [row.id]);
        if ((r.rows[0]?.fails ?? 0) >= MAX_FAILS) await query(pool, `DELETE FROM push_tokens WHERE id = $1`, [row.id]);
      }
    }));
  } catch (e) {
    log.err('fcm send threw', e, { kind: note.kind });
  }
  return sent;
}

async function sendToBrowsers(userId: number, note: PushNote): Promise<number> {
  const rows = await query<SubRow>(pool, `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`, [userId]);
  return sendToSubs(rows.rows, note);
}

/** Browsers by their rows, for the same reason. */
export async function sendToSubs(rows: SubRow[], note: PushNote): Promise<number> {
  if (!enabled) return 0;
  let sent = 0;
  try {
    if (!rows.length) return 0;
    const payload = JSON.stringify(note);
    await Promise.all(rows.map(async row => {
      try {
        await webpush.sendNotification(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          payload,
          { TTL: config.push.ttlSeconds, urgency: 'normal' },
        );
        sent++;
        await query(pool, `UPDATE push_subscriptions SET seen_at = now(), fails = 0 WHERE id = $1`, [row.id]);
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode ?? 0;
        if (DEAD.has(status)) {
          await query(pool, `DELETE FROM push_subscriptions WHERE id = $1`, [row.id]);
          return;
        }
        // Anything else is this once: a push service having a bad minute is not a reason to forget a device,
        // but a device that fails five sends running is one nobody is reading.
        const r = await query<{ fails: number }>(pool,
          `UPDATE push_subscriptions SET fails = fails + 1 WHERE id = $1 RETURNING fails`, [row.id]);
        if ((r.rows[0]?.fails ?? 0) >= MAX_FAILS) await query(pool, `DELETE FROM push_subscriptions WHERE id = $1`, [row.id]);
        log.warn('push send failed', { status, kind: note.kind, fails: r.rows[0]?.fails ?? 0 });
      }
    }));
  } catch (e) {
    log.err('push send threw', e, { kind: note.kind });
  }
  return sent;
}

/** Somebody has been asked to a match. */
export const invitedNote = (from: string, stake: number, code: string): PushNote => ({
  kind: 'invited',
  title: `${from} wants to play`,
  body: stake > 0 ? `A match for ${stake.toLocaleString('en-US')} gold. Tap to take it.` : 'Tap to take the match.',
  url: `/puzzle/#m=${code}`,
  // One tag for all invites: the last person to ask is the one on the screen, not a stack of five.
  tag: 'invited',
});

/** The league has paid. */
export const leagueNote = (rank: number, gold: number): PushNote => ({
  kind: 'league',
  title: `You finished #${rank} this week`,
  body: `${gold.toLocaleString('en-US')} gold is in your purse.`,
  url: '/puzzle/#league',
  tag: 'league',
});

/** Seven in the evening, and the player has not been on a board today. Named, because it is addressed to them. */
// A device with no account gets the nudge without a name in it: the game does not know one, and "Hey there"
// is a stranger pretending to.
export const dailyNote = (name: string): PushNote => ({
  kind: 'daily',
  title: name.trim() ? `Hey ${name.trim()}, it\u2019s time to train your brain` : 'It\u2019s time to train your brain',
  body: 'A fresh board is waiting. A few minutes keeps the streak alive.',
  url: '/puzzle/',
  tag: 'daily',
});
