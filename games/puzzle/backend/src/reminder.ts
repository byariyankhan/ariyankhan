// The evening nudge: once a day, at seven where the phone is, to anyone who has not played for a while.
//
// The clock is the device's. A browser or a phone says which time zone it is in when it registers for
// notifications (push_subscriptions.tz, push_tokens.tz), and the sweep, once a minute, asks of every zone that
// has a device in it whether it is seven o'clock there yet. The first minute of the hour it is, the zone's
// players are told -- once, because Redis remembers the zone and the local date, and once per player,
// because it remembers the player too, so a laptop in London and a phone in Dhaka on one account do not
// make two evenings. Somebody who has played in the last few hours has trained already and is left alone.
//
// Redis is the memory and it is soft: if it is gone, nothing is sent rather than the same nudge being sent
// every minute for ten minutes. A missed evening is a missed evening; a phone that buzzes ten times is a
// player who turns the switch off.
import { config } from './config.js';
import { pool, query } from './db.js';
import { log } from './log.js';
import * as push from './push.js';
import { k, redis, soft } from './redis.js';

export interface LocalClock { date: string; hour: number; minute: number }

/** The date and time of day it is in a zone, or null for a zone Intl does not know. */
export function localClock(now: Date, tz: string): LocalClock | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now);
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
    const hour = Number(get('hour')), minute = Number(get('minute'));
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: hour % 24, minute };
  } catch {
    return null;
  }
}

/** How far into the hour the sweep still counts as "seven o'clock": a restart at 19:03 still sends. */
export const WINDOW_MINUTES = 10;
export const isDue = (clock: LocalClock, hour = config.reminder.hour): boolean =>
  clock.hour === hour && clock.minute < WINDOW_MINUTES;

/** Every zone that has at least one device in it. */
export async function zones(): Promise<string[]> {
  const r = await query<{ tz: string }>(pool, `SELECT tz FROM push_tokens UNION SELECT tz FROM push_subscriptions`);
  return r.rows.map(x => x.tz);
}

/**
 * Who in a zone is told: an account that wants the nudge, has a device in that zone, and has not been seen
 * playing for a few hours. The name rides along, because the nudge says it.
 */
export async function targets(tz: string, quietHours = config.reminder.quietHours): Promise<{ id: number; name: string }[]> {
  const r = await query<{ id: number; name: string }>(pool, `
    SELECT DISTINCT u.id, u.name
      FROM users u
     WHERE u.reminder
       AND u.last_played_at < now() - ($2 || ' hours')::interval
       AND (EXISTS (SELECT 1 FROM push_tokens t WHERE t.user_id = u.id AND t.tz = $1)
         OR EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = u.id AND s.tz = $1))`,
    [tz, String(quietHours)]);
  return r.rows;
}

/** One pass. Returns the zones it was seven o'clock in and how many players each was told. */
/**
 * Devices in the zone that belong to no account: the nudge on for that row, and the game not opened in the
 * quiet hours. `seen_at` is when the device last posted its token or subscription, which it does on every
 * open, so it stands in for the last_played_at that a device with no account does not have.
 */
export async function deviceTargets(tz: string, quietHours = config.reminder.quietHours): Promise<{ tokens: push.TokenRow[]; subs: push.SubRow[] }> {
  const tokens = await query<push.TokenRow>(pool, `
    SELECT id, token FROM push_tokens
     WHERE user_id IS NULL AND reminder AND tz = $1 AND seen_at < now() - ($2 || ' hours')::interval`, [tz, String(quietHours)]);
  const subs = await query<push.SubRow>(pool, `
    SELECT id, endpoint, p256dh, auth FROM push_subscriptions
     WHERE user_id IS NULL AND reminder AND tz = $1 AND seen_at < now() - ($2 || ' hours')::interval`, [tz, String(quietHours)]);
  return { tokens: tokens.rows, subs: subs.rows };
}

export async function reminderSweep(now = new Date()): Promise<{ zone: string; told: number }[]> {
  const out: { zone: string; told: number }[] = [];
  for (const tz of await zones()) {
    const clock = localClock(now, tz);
    if (!clock || !isDue(clock)) continue;
    const first = await soft(() => redis.set(k('reminder', tz, clock.date), '1', 'EX', 36 * 3600, 'NX'), null);
    if (first !== 'OK') continue;
    let told = 0;
    for (const u of await targets(tz)) {
      const mine = await soft(() => redis.set(k('reminded', u.id), '1', 'EX', 20 * 3600, 'NX'), null);
      if (mine !== 'OK') continue;
      if (await push.sendToUser(u.id, push.dailyNote(u.name)) > 0) told++;
    }
    // Devices with no account, one by one, each marked so a second service (or a restart) does not tell the
    // same phone twice. The note carries no name: there is none to carry.
    const dev = await deviceTargets(tz);
    for (const t of dev.tokens) {
      const mine = await soft(() => redis.set(k('reminded', 'tok', t.id), '1', 'EX', 20 * 3600, 'NX'), null);
      if (mine !== 'OK') continue;
      if (await push.sendToTokens([t], push.dailyNote('')) > 0) told++;
    }
    for (const sub of dev.subs) {
      const mine = await soft(() => redis.set(k('reminded', 'sub', sub.id), '1', 'EX', 20 * 3600, 'NX'), null);
      if (mine !== 'OK') continue;
      if (await push.sendToSubs([sub], push.dailyNote('')) > 0) told++;
    }
    out.push({ zone: tz, told });
  }
  return out;
}

let timer: NodeJS.Timeout | null = null;
export function startReminderTimer(everyMs = 60_000): void {
  if (timer) return;
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    reminderSweep()
      .then(zonesTold => { if (zonesTold.length) log.info('evening reminders sent', { zones: zonesTold }); })
      .catch(e => log.err('reminder sweep failed', e))
      .finally(() => { running = false; });
  };
  tick();
  timer = setInterval(tick, Math.max(1_000, everyMs));
  timer.unref?.();
  log.info('reminder timer started', { hour: config.reminder.hour });
}
export function stopReminderTimer(): void { if (timer) { clearInterval(timer); timer = null; } }
