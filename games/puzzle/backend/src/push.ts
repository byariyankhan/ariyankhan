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
  kind: 'invited' | 'league';
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

/** Remember where to reach this phone. One row per token; a token that changes hands follows the sign-in. */
export async function saveToken(sql: Sql, userId: number, token: string, agent: string): Promise<void> {
  await query(sql, `
    INSERT INTO push_tokens (user_id, token, agent)
         VALUES ($1, $2, $3)
    ON CONFLICT (token) DO UPDATE
            SET user_id = EXCLUDED.user_id, agent = EXCLUDED.agent, seen_at = now(), fails = 0`,
    [userId, token, agent.slice(0, 200)]);
}

/** The player turning notifications off on this phone. Only their own token is theirs to drop. */
export async function dropToken(sql: Sql, userId: number, token: string): Promise<void> {
  await query(sql, `DELETE FROM push_tokens WHERE user_id = $1 AND token = $2`, [userId, token]);
}

/**
 * Remember where to reach this player.
 *
 * Keyed by endpoint, so the same browser subscribing again updates its row rather than adding another, and a
 * browser that changes hands moves to whoever is signed in on it now.
 */
export async function saveSubscription(sql: Sql, userId: number, sub: PushSub, agent: string): Promise<void> {
  await query(sql, `
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, agent)
         VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (endpoint) DO UPDATE
            SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
                agent = EXCLUDED.agent, seen_at = now(), fails = 0`,
    [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, agent.slice(0, 200)]);
}

/** The player turning notifications off on this browser, or the browser telling us it has dropped them. */
export async function dropSubscription(sql: Sql, userId: number, endpoint: string): Promise<void> {
  await query(sql, `DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`, [userId, endpoint]);
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
async function sendToPhones(userId: number, note: PushNote): Promise<number> {
  if (!appEnabled) return 0;
  let sent = 0;
  try {
    const rows = await query<{ id: number; token: string }>(pool, `SELECT id, token FROM push_tokens WHERE user_id = $1`, [userId]);
    if (!rows.rowCount) return 0;
    await Promise.all(rows.rows.map(async row => {
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
  if (!enabled) return 0;
  let sent = 0;
  try {
    const rows = await query<{ id: number; endpoint: string; p256dh: string; auth: string }>(pool,
      `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`, [userId]);
    if (!rows.rowCount) return 0;
    const payload = JSON.stringify(note);
    await Promise.all(rows.rows.map(async row => {
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
