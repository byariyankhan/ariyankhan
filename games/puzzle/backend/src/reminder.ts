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
//
// Who is told, and what: nobody who has played today (a board cleared or a training round scored, as the
// account's own records say). A streak still alive is told it ends at midnight; anybody else, what is waiting.
// And it backs off: every evening for the first three days away, then every third day, then at a fortnight one
// last note to say the reminders stop -- and then nothing until the player plays again. A channel that nags
// somebody who has left is a channel they switch off, and the switch is the one way back.
import { config } from './config.js';
import { pool, query } from './db.js';
import { log } from './log.js';
import { cleanStreak, type Streak } from './progress.js';
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

// ── When to say it ──
/** Days from one YYYY-MM-DD to another (to - from); NaN for anything that is not a day. */
export function daysBetween(from: string, to: string): number {
  const t = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? Date.parse(d + 'T00:00:00Z') : NaN);
  return Math.round((t(to) - t(from)) / 86_400_000);
}
/** Every evening for this many days away; after that, every NUDGE_EVERY-th day; one last note in the window. */
export const NUDGE_DAILY = 3, NUDGE_EVERY = 3, NUDGE_FINAL_FROM = 15, NUDGE_FINAL_TO = 21;
/**
 * Whether tonight is an evening to be told, and what: `away` is days since the last day played (1 = yesterday),
 * `alive` whether a streak is still there to lose. The final note is offered on each evening of its window
 * until one is sent (the sweep remembers it per absence); past the window, nothing.
 */
export function nudgeKind(away: number, alive: boolean): push.NudgeKind | null {
  if (!Number.isFinite(away) || away < 1) return null;
  if (away <= NUDGE_DAILY) return alive ? 'streak' : 'back';
  if (away < NUDGE_FINAL_FROM) return away % NUDGE_EVERY === 0 ? 'back' : null;
  return away <= NUDGE_FINAL_TO ? 'final' : null;
}
/**
 * A streak still to lose tonight, as the game counts it: played yesterday, or the day before with a freeze
 * that covers yesterday once the player plays today. Its count as it would stand (the covered day included);
 * 0 for none.
 */
export function aliveStreak(s: Streak | undefined, today: string): number {
  if (!s) return 0;
  const gap = daysBetween(s.last, today);
  return gap === 1 ? s.count : gap === 2 && (s.freeze ?? 0) > 0 ? s.count + 1 : 0;
}
export interface Target { id: number; name: string; streak: Streak | undefined; lastDay: string }
/** What an account's evening is: nothing, or a kind of nudge, the streak it names, and the absence it is for. */
export function planFor(u: Target, today: string): { kind: push.NudgeKind; streak: number; since: string } | null {
  const streak = aliveStreak(u.streak, today), kind = nudgeKind(daysBetween(u.lastDay, today), streak > 0);
  return kind ? { kind, streak, since: u.lastDay } : null;
}
const latest = (...days: (string | null | undefined)[]): string => days.filter((d): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().pop() ?? '';

/**
 * Who in a zone may be told: an account that wants the nudge, has a device in that zone, has not been seen
 * playing for a few hours, and has not played today -- no streak day and no training round scored on the
 * zone's date `today` (users.state, the records the game syncs). The name rides along, because the nudge says
 * it; the streak and the last day played, because they decide what it says and whether tonight is an evening
 * for it at all (planFor). The last day played is the latest of the streak's, the last training day's and the
 * date of last_played_at in the zone.
 */
export async function targets(tz: string, quietHours = config.reminder.quietHours, today = localClock(new Date(), tz)?.date ?? ''): Promise<Target[]> {
  const r = await query<{ id: number; name: string; streak: unknown; train_last: string | null; played_on: string | null }>(pool, `
    SELECT u.id, u.name, u.state->'playStreak' AS streak,
           (SELECT max(d.key) FROM jsonb_each(CASE WHEN jsonb_typeof(u.state->'train') = 'object' THEN u.state->'train' ELSE '{}'::jsonb END) d
             WHERE jsonb_typeof(d.value) = 'object' AND d.value ?| array['r','f','g','e']) AS train_last,
           to_char(u.last_played_at AT TIME ZONE $1, 'YYYY-MM-DD') AS played_on
      FROM users u
     WHERE u.reminder
       AND u.last_played_at < now() - ($2 || ' hours')::interval
       AND COALESCE(u.state->'playStreak'->>'last', '') < $3
       AND NOT COALESCE(jsonb_typeof(u.state->'train'->$3) = 'object' AND (u.state->'train'->$3) ?| array['r','f','g','e'], false)
       AND (EXISTS (SELECT 1 FROM push_tokens t WHERE t.user_id = u.id AND t.tz = $1)
         OR EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = u.id AND s.tz = $1))`,
    [tz, String(quietHours), today]);
  return r.rows.map(x => {
    const streak = cleanStreak(x.streak);
    return { id: x.id, name: x.name, streak, lastDay: latest(streak?.last, x.train_last, x.played_on) };
  });
}

/** One pass. Returns the zones it was seven o'clock in and how many players each was told. */
/**
 * Devices in the zone that belong to no account: the nudge on for that row, and the game not opened in the
 * quiet hours. `seen_at` is when the device last posted its token or subscription, which it does on every
 * open, so it stands in for the last_played_at that a device with no account does not have; `seen_on` is its
 * date in the zone, what the back-off counts from.
 */
export async function deviceTargets(tz: string, quietHours = config.reminder.quietHours): Promise<{ tokens: (push.TokenRow & { seen_on: string })[]; subs: (push.SubRow & { seen_on: string })[] }> {
  const tokens = await query<push.TokenRow & { seen_on: string }>(pool, `
    SELECT id, token, to_char(seen_at AT TIME ZONE $1, 'YYYY-MM-DD') AS seen_on FROM push_tokens
     WHERE user_id IS NULL AND reminder AND tz = $1 AND seen_at < now() - ($2 || ' hours')::interval`, [tz, String(quietHours)]);
  const subs = await query<push.SubRow & { seen_on: string }>(pool, `
    SELECT id, endpoint, p256dh, auth, to_char(seen_at AT TIME ZONE $1, 'YYYY-MM-DD') AS seen_on FROM push_subscriptions
     WHERE user_id IS NULL AND reminder AND tz = $1 AND seen_at < now() - ($2 || ' hours')::interval`, [tz, String(quietHours)]);
  return { tokens: tokens.rows, subs: subs.rows };
}

/** The wording to use tonight for one target, taken in turn after the last one it was sent (kept 60 days). */
async function wording(key: string, kind: push.NudgeKind): Promise<number> {
  const next = push.nextTemplate(kind, await soft(() => redis.get(key), null));
  await soft(() => redis.set(key, `${kind}:${next}`, 'EX', 60 * 86_400), null);
  return next;
}
/** The last note goes once an absence: remembered by the day the absence began, for longer than its window. */
const finalOnce = async (...parts: (string | number)[]): Promise<boolean> =>
  (await soft(() => redis.set(k('nudgebye', ...parts), '1', 'EX', 40 * 86_400, 'NX'), null)) === 'OK';

export async function reminderSweep(now = new Date()): Promise<{ zone: string; told: number }[]> {
  const out: { zone: string; told: number }[] = [];
  for (const tz of await zones()) {
    const clock = localClock(now, tz);
    if (!clock || !isDue(clock)) continue;
    const first = await soft(() => redis.set(k('reminder', tz, clock.date), '1', 'EX', 36 * 3600, 'NX'), null);
    if (first !== 'OK') continue;
    let told = 0;
    for (const u of await targets(tz, config.reminder.quietHours, clock.date)) {
      const plan = planFor(u, clock.date);
      if (!plan) continue;   // an evening the back-off skips, or past the last note: nothing, and nothing marked
      const mine = await soft(() => redis.set(k('reminded', u.id), '1', 'EX', 20 * 3600, 'NX'), null);
      if (mine !== 'OK') continue;
      if (plan.kind === 'final' && !(await finalOnce(u.id, plan.since))) continue;
      const tmpl = await wording(k('tmpl', u.id), plan.kind);
      if (await push.sendToUser(u.id, push.dailyNote(u.name, { kind: plan.kind, streak: plan.streak, tmpl })) > 0) told++;
    }
    // Devices with no account, one by one, each marked so a second service (or a restart) does not tell the
    // same phone twice. The note carries no name and no streak: there is none to carry. Days away count from
    // the last time the device opened the game.
    const dev = await deviceTargets(tz);
    for (const [kind, rows] of [['tok', dev.tokens], ['sub', dev.subs]] as const) {
      for (const row of rows) {
        const what = nudgeKind(daysBetween(row.seen_on, clock.date), false);
        if (!what) continue;
        const mine = await soft(() => redis.set(k('reminded', kind, row.id), '1', 'EX', 20 * 3600, 'NX'), null);
        if (mine !== 'OK') continue;
        if (what === 'final' && !(await finalOnce(kind, row.id, row.seen_on))) continue;
        const note = push.dailyNote('', { kind: what, tmpl: await wording(k('tmpl', kind, row.id), what) });
        const sent = kind === 'tok' ? await push.sendToTokens([row as push.TokenRow], note) : await push.sendToSubs([row as push.SubRow], note);
        if (sent > 0) told++;
      }
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
