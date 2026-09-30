// What the notification layer promises about the devices it remembers.
//
// The sending itself is not tested here: it is an HTTPS request to somebody else's push service, and a suite
// that mocks that tests the mock. What matters on this side is the table — one row per browser, following the
// account that is signed in on it, disposable — and the words a notification arrives with.
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { pool, query } from '../backend/src/db.js';
import { appEnabled, cleanTz, dailyNote, dropSubscription, dropToken, hasSubscription, invitedNote, leagueNote, nextTemplate, NUDGES, saveSubscription, saveToken, setDeviceReminder, setReminder } from '../backend/src/push.js';
import { aliveStreak, daysBetween, deviceTargets, isDue, localClock, nudgeKind, planFor, reminderSweep, targets } from '../backend/src/reminder.js';
import { k, redis } from '../backend/src/redis.js';
import { assertion, enabled as fcmEnabled, messageFor, parseAccount } from '../backend/src/fcm.js';
import { eq, finish, ok, player, reset, section } from './helpers.js';

const sub = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: `p${n}`, auth: `a${n}` } });
const rowsFor = async (userId: number) =>
  (await query<{ endpoint: string }>(pool, `SELECT endpoint FROM push_subscriptions WHERE user_id = $1 ORDER BY id`, [userId])).rows.map(r => r.endpoint);
const tokensFor = async (userId: number) =>
  (await query<{ token: string }>(pool, `SELECT token FROM push_tokens WHERE user_id = $1 ORDER BY id`, [userId])).rows.map(r => r.token);
const fcmToken = (c: string) => `fcm:${c.repeat(40)}`;

await reset();

section('Remembering a device');
{
  const a = await player('pusher-a');
  await saveSubscription(pool, a.id, sub(1), 'Chrome on Android');
  eq(await rowsFor(a.id), ['https://fcm.googleapis.com/fcm/send/1'], 'a subscription is kept');
  ok(await hasSubscription(pool, a.id), 'and the player has one');

  // A browser re-subscribing hands over the same endpoint with fresh keys. That is the same device saying the
  // same thing twice, and two rows would mean one invitation arriving twice on one phone.
  await saveSubscription(pool, a.id, { endpoint: sub(1).endpoint, keys: { p256dh: 'p1-new', auth: 'a1-new' } }, 'Chrome on Android');
  eq(await rowsFor(a.id), ['https://fcm.googleapis.com/fcm/send/1'], 'subscribing again with the same endpoint does not add a second row');
  const keys = await query<{ p256dh: string; auth: string }>(pool, `SELECT p256dh, auth FROM push_subscriptions WHERE endpoint = $1`, [sub(1).endpoint]);
  eq([keys.rows[0]?.p256dh, keys.rows[0]?.auth], ['p1-new', 'a1-new'], 'and the new keys replace the old ones');

  // The same person on a second device is a second row: both are told.
  await saveSubscription(pool, a.id, sub(2), 'Safari on iPhone');
  eq((await rowsFor(a.id)).length, 2, 'a second browser is a second row');
}

section('A device that changes hands');
{
  const a = await player('pusher-b');
  const b = await player('pusher-c');
  await saveSubscription(pool, a.id, sub(3), 'a shared laptop');
  await saveSubscription(pool, b.id, sub(3), 'a shared laptop');
  eq(await rowsFor(a.id), [], 'the endpoint leaves the account that signed out of it');
  eq(await rowsFor(b.id), ['https://fcm.googleapis.com/fcm/send/3'], 'and follows the one signed in on it now');
  ok(!(await hasSubscription(pool, a.id)), 'so the first account has nothing listening');
}

section('Letting go');
{
  const a = await player('pusher-d');
  await saveSubscription(pool, a.id, sub(4), 'Chrome');
  await saveSubscription(pool, a.id, sub(5), 'Firefox');
  await dropSubscription(pool, a.id, sub(4).endpoint);
  eq(await rowsFor(a.id), ['https://fcm.googleapis.com/fcm/send/5'], 'turning it off on one device leaves the other alone');

  // Somebody else's endpoint is not this player's to drop.
  const b = await player('pusher-e');
  await dropSubscription(pool, b.id, sub(5).endpoint);
  eq(await rowsFor(a.id), ['https://fcm.googleapis.com/fcm/send/5'], 'and a player cannot unsubscribe somebody else');

  await query(pool, `DELETE FROM users WHERE id = $1`, [a.id]);
  eq((await query(pool, `SELECT 1 FROM push_subscriptions WHERE endpoint = $1`, [sub(5).endpoint])).rowCount, 0,
    'a deleted account takes its devices with it');
}

section('What it says');
{
  const inv = invitedNote('Ariyan', 10_000, 'ABC123');
  eq(inv.title, 'Ariyan wants to play', 'an invitation names who is asking');
  ok(inv.body.includes('10,000'), 'and what is on the table');
  eq(inv.url, '/puzzle/#m=ABC123', 'and lands on that match');
  eq(invitedNote('Ariyan', 0, 'ABC123').body, 'Tap to take the match.', 'a free match does not mention gold');
  eq(inv.tag, invitedNote('Somebody else', 500, 'XYZ789').tag,
    'invitations share a tag, so five of them are one line and not five');

  const lg = leagueNote(3, 1_280_000);
  eq(lg.title, 'You finished #3 this week', 'the league says where you came');
  ok(lg.body.includes('1,280,000'), 'and what it paid');
  eq(lg.url, '/puzzle/#league', 'and lands on the table');
}

section('Remembering a phone');
{
  const a = await player('phone-a');
  await saveToken(pool, a.id, fcmToken('x'), 'PuzzleApp/1 on Android 15');
  eq(await tokensFor(a.id), [fcmToken('x')], 'a registration token is kept');
  ok(await hasSubscription(pool, a.id), 'and counts as a device listening, the same as a browser would');

  // The app posts its token every time the game opens with the switch on. The same string is the same phone.
  await saveToken(pool, a.id, fcmToken('x'), 'PuzzleApp/2 on Android 16');
  eq(await tokensFor(a.id), [fcmToken('x')], 'posting it again does not add a second row');
  const row = await query<{ agent: string }>(pool, `SELECT agent FROM push_tokens WHERE token = $1`, [fcmToken('x')]);
  eq(row.rows[0]?.agent, 'PuzzleApp/2 on Android 16', 'and the row says which build posted it last');

  // A phone and a browser are two rows in two tables, and both are told.
  await saveSubscription(pool, a.id, sub(9), 'Chrome');
  ok(await hasSubscription(pool, a.id), 'a phone beside a browser still counts');
  await dropSubscription(pool, a.id, sub(9).endpoint);
  ok(await hasSubscription(pool, a.id), 'and losing the browser leaves the phone listening');
}

section('A phone that changes hands');
{
  const a = await player('phone-b');
  const b = await player('phone-c');
  await saveToken(pool, a.id, fcmToken('y'), 'app');
  await query(pool, `UPDATE push_tokens SET fails = 3 WHERE token = $1`, [fcmToken('y')]);
  await saveToken(pool, b.id, fcmToken('y'), 'app');
  eq(await tokensFor(a.id), [], 'the token leaves the account that signed out of the app');
  eq(await tokensFor(b.id), [fcmToken('y')], 'and follows the one signed in on it now');
  eq((await query<{ fails: number }>(pool, `SELECT fails FROM push_tokens WHERE token = $1`, [fcmToken('y')])).rows[0]?.fails, 0,
    'and a fresh post says the phone is alive, whatever failed before');

  await dropToken(pool, a.id, fcmToken('y'));
  eq(await tokensFor(b.id), [fcmToken('y')], 'the account that left cannot drop it from the one that stayed');
  await dropToken(pool, b.id, fcmToken('y'));
  eq(await tokensFor(b.id), [], 'the one signed in can');
  ok(!(await hasSubscription(pool, b.id)), 'and then nothing is listening');

  const c = await player('phone-d');
  await saveToken(pool, c.id, fcmToken('z'), 'app');
  await query(pool, `DELETE FROM users WHERE id = $1`, [c.id]);
  eq((await query(pool, `SELECT 1 FROM push_tokens WHERE token = $1`, [fcmToken('z')])).rowCount, 0, 'a deleted account takes its phones with it');
}

section('Reaching Firebase with no Firebase library');
{
  ok(!fcmEnabled && !appEnabled, 'with no service account configured, phones are simply off');
  eq(parseAccount(''), null, 'nothing is not an account');
  eq(parseAccount('not an account'), null, 'nor is junk');
  eq(parseAccount('{"project_id":"p","client_email":"e@x"}'), null, 'nor a file with no key in it');
  eq(parseAccount('{"project_id":"p","client_email":"e@x","private_key":"nope"}'), null, 'nor one whose key is not a key');

  // A throwaway keypair stands in for the one Firebase generates; the shape of the file is Google's.
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const file = JSON.stringify({ type: 'service_account', project_id: 'puzzle-test', client_email: 'svc@puzzle-test.iam.gserviceaccount.com', private_key: pem, token_uri: 'https://oauth2.googleapis.com/token' });
  const acct = parseAccount(file);
  eq(acct?.project_id, 'puzzle-test', 'the JSON Firebase hands out is read as it is');
  eq(parseAccount(Buffer.from(file).toString('base64'))?.client_email, 'svc@puzzle-test.iam.gserviceaccount.com',
    'and base64 of it, which is how one .env line carries a file with newlines in it');

  const jwt = assertion(acct!, 1_700_000_000);
  const [h, c, s] = jwt.split('.') as [string, string, string];
  eq(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' }, 'the assertion is an RS256 JWT');
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString()) as Record<string, unknown>;
  eq(claims.iss, acct!.client_email, 'issued by the service account');
  eq(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging', 'for messaging and nothing wider');
  eq(claims.aud, 'https://oauth2.googleapis.com/token', "to Google's token endpoint");
  eq([claims.iat, claims.exp], [1_700_000_000, 1_700_003_600], 'good for an hour');
  const v = createVerify('RSA-SHA256'); v.update(`${h}.${c}`);
  ok(v.verify(pair.publicKey, Buffer.from(s, 'base64url')), 'and the signature checks against the matching public key');
  const w = createVerify('RSA-SHA256'); w.update(`${h}.${c}`);
  ok(!w.verify(generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey, Buffer.from(s, 'base64url')), "and against nobody else's");

  const m = messageFor('tok', invitedNote('Ariyan', 500, 'ABC123'), 3600) as {
    message: { token: string; data: Record<string, string>; notification?: unknown; android: { priority: string; ttl: string; collapse_key: string } };
  };
  eq(m.message.token, 'tok', 'the message is addressed to the one phone');
  eq(m.message.data.title, 'Ariyan wants to play', 'and carries the words the browser would get');
  eq(m.message.data.url, '/puzzle/#m=ABC123', 'and the same place to land');
  eq(m.message.notification, undefined, 'as data only, so the app draws it the same way open or closed');
  eq(m.message.android.priority, 'high', 'at high priority, because a room waits minutes');
  eq(m.message.android.ttl, '3600s', "and for as long as the browser's copy would");
  eq(m.message.android.collapse_key, m.message.data.tag, 'collapsing on the tag, so five invitations are one');
}

section('Seven in the evening, wherever the phone is');
{
  eq(cleanTz('Asia/Dhaka'), 'Asia/Dhaka', 'a zone a device reports is kept');
  eq(cleanTz('Europe/London'), 'Europe/London', 'any zone Intl knows');
  eq(cleanTz('Mars/Olympus'), 'Asia/Dhaka', 'one it does not know falls back to Dhaka');
  eq(cleanTz(''), 'Asia/Dhaka', 'and so does a device that says nothing');
  eq(cleanTz("Asia/Dhaka'; DROP TABLE users"), 'Asia/Dhaka', 'and one that is not even the shape of a zone');

  const at = new Date('2026-09-22T13:00:30Z');   // 19:00 in Dhaka, 14:00 in London
  eq(localClock(at, 'Asia/Dhaka'), { date: '2026-09-22', hour: 19, minute: 0 }, 'the clock is read in the zone');
  eq(localClock(at, 'Europe/London')?.hour, 14, 'and a different zone reads differently');
  eq(localClock(at, 'Nowhere/Atall'), null, 'an unknown zone has no clock');
  ok(isDue({ date: '2026-09-22', hour: 19, minute: 0 }), 'seven on the dot is due');
  ok(isDue({ date: '2026-09-22', hour: 19, minute: 9 }), 'and so is nine minutes past, for a service that was restarting at seven');
  ok(!isDue({ date: '2026-09-22', hour: 19, minute: 10 }), 'ten past is not: the evening is missed, not sent late');
  ok(!isDue({ date: '2026-09-22', hour: 7, minute: 0 }), 'and seven in the morning is a different seven');

  const n = dailyNote('Ariyan', { kind: 'back', tmpl: 1 });
  eq(n.kind, 'daily', 'the nudge is its own kind, so the app can give it its own channel');
  ok(n.title.startsWith('Hey Ariyan,') && /train your brain/.test(n.title), 'and it says who it is talking to');
  eq(n.url, '/puzzle/', 'and lands on the game');
  eq(dailyNote('   ', { kind: 'back', tmpl: 1 }).title, 'It\u2019s time to train your brain', 'no name, no greeting: a device with no account is not called "there"');

  // Who is told: an account with a device in the zone, the nudge on, and no board in the last few hours.
  const a = await player('nudge-a'), b = await player('nudge-b'), c = await player('nudge-c'), d = await player('nudge-d');
  await saveToken(pool, a.id, fcmToken('a'), 'app', 'Asia/Dhaka');
  await saveSubscription(pool, b.id, sub(21), 'Chrome', 'Asia/Dhaka');
  await saveToken(pool, c.id, fcmToken('c'), 'app', 'Asia/Dhaka');
  await saveToken(pool, d.id, fcmToken('d'), 'app', 'Europe/London');
  await query(pool, `UPDATE users SET last_played_at = now() - interval '1 day' WHERE id = ANY($1)`, [[a.id, b.id, d.id]]);
  await setReminder(pool, b.id, false);
  const who = (await targets('Asia/Dhaka')).map(u => u.id).sort();
  eq(who, [a.id], 'a phone in Dhaka that has not played today is told; the browser that said no is not, nor the phone that played an hour ago, nor London');
  eq((await targets('Europe/London')).map(u => u.id), [d.id], 'London is told at its own seven');

  await redis.del(k('reminder', 'Asia/Dhaka', '2026-09-22'), k('reminder', 'Europe/London', '2026-09-22'), k('reminded', a.id), k('reminded', d.id));
  const first = await reminderSweep(at);
  eq(first.map(z => z.zone), ['Asia/Dhaka'], 'at 13:00Z it is seven in Dhaka and the sweep goes there, and only there');
  eq(first[0]?.told, 0, 'nobody is actually reached on a box with no keys, and the sweep says so rather than guessing');
  eq(await reminderSweep(new Date('2026-09-22T13:04:00Z')), [], 'four minutes later the same evening is not sent again');
  eq(await reminderSweep(new Date('2026-09-22T18:00:30Z')).then(z => z.map(x => x.zone)), ['Europe/London'], 'and London gets its own at its own seven');
  await redis.del(k('reminder', 'Asia/Dhaka', '2026-09-22'), k('reminder', 'Europe/London', '2026-09-22'), k('reminded', a.id), k('reminded', d.id));
}

section('A phone with no account is nudged too');
{
  // Signed out, a device posts its token or subscription with no user, and the sweep finds it by zone.
  await saveToken(pool, null, fcmToken('x'), 'app', 'Asia/Dhaka');
  await saveSubscription(pool, null, sub(31), 'Chrome', 'Asia/Dhaka');
  await saveToken(pool, null, fcmToken('y'), 'app', 'Asia/Dhaka', false);   // the switch off on that phone
  await saveToken(pool, null, fcmToken('z'), 'app', 'Europe/London');
  const who = (await query<{ token: string; user_id: number | null }>(pool, `SELECT token, user_id FROM push_tokens WHERE token = $1`, [fcmToken('x')])).rows[0];
  eq(who?.user_id, null, 'the row stands with no account');
  await query(pool, `UPDATE push_tokens SET seen_at = now() - interval '1 day' WHERE user_id IS NULL`);
  await query(pool, `UPDATE push_subscriptions SET seen_at = now() - interval '1 day' WHERE user_id IS NULL`);
  let dev = await deviceTargets('Asia/Dhaka');
  eq(dev.tokens.map(t => t.token).sort(), [fcmToken('x')], 'the Dhaka phone with the nudge on is a target; the one that said no is not, nor London');
  eq(dev.subs.map(x => x.endpoint), [sub(31).endpoint], 'and so is the browser');
  eq((await deviceTargets('Europe/London')).tokens.map(t => t.token), [fcmToken('z')], 'London at its own seven');
  // Opened the game an hour ago: not nudged tonight, the same quiet hours an account gets.
  await query(pool, `UPDATE push_tokens SET seen_at = now() WHERE token = $1`, [fcmToken('x')]);
  eq((await deviceTargets('Asia/Dhaka')).tokens.length, 0, 'a phone that opened the game an hour ago is left alone');
  await query(pool, `UPDATE push_tokens SET seen_at = now() - interval '1 day' WHERE token = $1`, [fcmToken('x')]);
  // The switch, with no account: set on the row by the token or endpoint only the device knows.
  ok(await setDeviceReminder(pool, false, fcmToken('x'), ''), 'the phone turns its nudge off');
  eq((await deviceTargets('Asia/Dhaka')).tokens.length, 0, 'and is not a target');
  ok(await setDeviceReminder(pool, true, '', sub(31).endpoint), 'a browser by its endpoint');
  ok(!(await setDeviceReminder(pool, true, fcmToken('nobody'), '')), 'a token nobody posted changes nothing');
  ok(await setDeviceReminder(pool, true, fcmToken('x'), ''), 'and back on');
  // The sweep reaches the accountless devices in the zone and marks each so it is not told twice.
  await redis.del(k('reminder', 'Asia/Dhaka', '2026-09-23'));
  const swept = await reminderSweep(new Date('2026-09-23T13:00:30Z'));
  eq(swept.map(z => z.zone), ['Asia/Dhaka'], 'the sweep goes to Dhaka at its seven');
  eq(swept[0]?.told, 0, 'nobody is actually reached on a box with no keys');
  await redis.del(k('reminder', 'Asia/Dhaka', '2026-09-23'));
  // Signing in on that phone: the same token posted again takes the account, and the account's own switch
  // decides from then on.
  const e = await player('nudge-e');
  await saveToken(pool, e.id, fcmToken('x'), 'app', 'Asia/Dhaka');
  eq((await tokensFor(e.id)), [fcmToken('x')], 'the token moved to the account');
  eq((await deviceTargets('Asia/Dhaka')).tokens.length, 0, 'and is no longer an accountless target');
  ok(!(await setDeviceReminder(pool, false, fcmToken('x'), '')), 'the accountless switch no longer reaches it');
  // Signed out again, the phone can still drop its own token: the token is the one thing only it knows.
  await dropToken(pool, null, fcmToken('x'));
  eq((await tokensFor(e.id)), [], 'dropped by the phone, with no account in hand');
  await dropSubscription(pool, null, sub(31).endpoint);
  eq((await query(pool, `SELECT 1 FROM push_subscriptions WHERE endpoint = $1`, [sub(31).endpoint])).rowCount, 0, 'and so can a browser');
}

section('What the evening says: the streak it would end, or what is waiting');
{
  const s = dailyNote('Ariyan', { kind: 'streak', streak: 12 });
  eq(s.title, 'Your 12-day streak ends at midnight', 'a streak still alive: its count, and when it ends');
  eq(dailyNote('', { kind: 'back' }).title, 'Today’s four rounds are ready', 'a streak gone: what is waiting, not a streak at stake');
  eq(dailyNote('Ariyan', { kind: 'streak', streak: 0 }).title, 'Today’s four rounds are ready', 'a streak kind with no streak says nothing about one');
  eq(dailyNote('', { kind: 'final' }).title, 'We’ll stop reminding you', 'the last note says so');
  ok(NUDGES.streak.length >= 4 && NUDGES.streak.length <= 6 && NUDGES.back.length >= 4 && NUDGES.back.length <= 6, 'four to six wordings of each');
  for (const kind of ['streak', 'back', 'final'] as const) {
    NUDGES[kind].forEach((_, i) => {
      for (const name of ['Ariyan', '']) {
        const x = dailyNote(name, { kind, streak: 9, tmpl: i });
        ok(x.title.length > 0 && x.title.length <= 60 && x.body.length > 0 && x.body.length <= 160 && !/undefined|NaN|^,|\s,/.test(x.title + x.body), `${kind} ${i}${name ? '' : ' (no name)'}: "${x.title}" / "${x.body}"`);
        if (kind === 'streak') ok(/midnight|9 days|make it 10|Day 10/.test(x.title + x.body), `${kind} ${i}: it is about this streak`);
        if (!name) ok(!/Hey|^,/.test(x.title), `${kind} ${i}: no greeting for nobody`);
      }
    });
  }
  // taken in turn: the next of the same kind, the first of another
  eq(nextTemplate('streak', null), 0, 'the first wording first'); eq(nextTemplate('streak', 'streak:0'), 1, 'then the next'); eq(nextTemplate('streak', `streak:${NUDGES.streak.length - 1}`), 0, 'round again');
  eq(nextTemplate('back', 'streak:3'), 0, 'another kind starts at its first'); eq(nextTemplate('back', 'junk'), 0, 'junk remembered: the first'); eq(nextTemplate('final', 'final:0'), 0, 'the last note has one wording');
}

section('The evening backs off: three evenings, then every third, a last note at a fortnight, then quiet');
{
  eq(daysBetween('2026-09-20', '2026-09-23'), 3, 'days between two dates'); eq(daysBetween('2026-02-27', '2026-03-01'), 2, 'across a month'); ok(Number.isNaN(daysBetween('', '2026-09-23')), 'and none from no date');
  const plan = Array.from({ length: 30 }, (_, d) => nudgeKind(d, false) ?? '-');
  eq(plan.join(' '), '- back back back - - back - - back - - back - - final final final final final final final - - - - - - - -',
    'days away 0-29: nothing today, daily for three, every third day, the last note in its window, then nothing');
  eq([1, 2, 3].map(d => nudgeKind(d, true)), ['streak', 'streak', 'streak'], 'a streak alive is what the first evenings are about');
  eq(nudgeKind(6, true), 'back', 'after that there is none');
  eq(aliveStreak({ count: 5, last: '2026-09-22' }, '2026-09-23'), 5, 'played yesterday: alive');
  eq(aliveStreak({ count: 5, last: '2026-09-21', freeze: 1 }, '2026-09-23'), 6, 'the day before, with a freeze to cover yesterday: alive, the covered day counted');
  eq(aliveStreak({ count: 5, last: '2026-09-21' }, '2026-09-23'), 0, 'without one: gone');
  eq(aliveStreak(undefined, '2026-09-23'), 0, 'no streak: none to lose');
  eq(planFor({ id: 1, name: '', streak: { count: 5, last: '2026-09-21', freeze: 1 }, lastDay: '2026-09-21' }, '2026-09-23'), { kind: 'streak', streak: 6, since: '2026-09-21' }, 'the plan: a streak of six to keep, for the absence since the 21st');
  eq(planFor({ id: 1, name: '', streak: undefined, lastDay: '2026-09-18' }, '2026-09-23'), null, 'five days away: a quiet evening');
}

section('The sweep: nobody who played today, the back-off, the wording in turn, one last note');
{
  const zoneDay = '2026-09-10', at = new Date('2026-09-10T13:00:30Z'), next = new Date('2026-09-11T13:00:30Z');   // 19:00 in Dhaka
  const make = async (name: string, state: Record<string, unknown>) => {
    const u = await player(name);
    await saveToken(pool, u.id, fcmToken(name.slice(-1)).replace('fcm:', `fcm${name}:`), 'app', 'Asia/Dhaka');
    await query(pool, `UPDATE users SET state = $2::jsonb, last_played_at = '2026-08-01T00:00:00Z' WHERE id = $1`, [u.id, JSON.stringify(state)]);
    return u.id;
  };
  const alive = await make('sw-alive', { playStreak: { count: 5, last: '2026-09-09' } });
  const today = await make('sw-today', { playStreak: { count: 5, last: zoneDay } });
  const trained = await make('sw-trained', { train: { [zoneDay]: { r: 44, p: 1 } } });
  const opened = await make('sw-opened', { playStreak: { count: 2, last: '2026-09-04' }, train: { [zoneDay]: { pp: { r: 1 } } } });
  const five = await make('sw-five', { playStreak: { count: 2, last: '2026-09-05' } });
  const bye = await make('sw-bye', { train: { '2026-08-26': { g: 70 } } });
  const gone = await make('sw-gone', { playStreak: { count: 9, last: '2026-08-10' } });
  const frozen = await make('sw-frozen', { playStreak: { count: 4, last: '2026-09-08', freeze: 1 } });
  const who = (await targets('Asia/Dhaka', undefined, zoneDay)).map(u => u.id);
  ok(who.includes(alive) && !who.includes(today) && !who.includes(trained), 'a streak day or a round scored today: not a target');
  ok(who.includes(opened), 'a round started and not finished is not a round scored');
  const t = (await targets('Asia/Dhaka', undefined, zoneDay)).find(u => u.id === bye);
  eq(t?.lastDay, '2026-08-26', 'the last day played is the latest of the streak, the training and the last board');
  const ids = [alive, today, trained, opened, five, bye, gone, frozen];
  const clear = async () => { await redis.del(k('reminder', 'Asia/Dhaka', zoneDay), k('reminder', 'Asia/Dhaka', '2026-09-11'), ...ids.map(id => k('reminded', id))); };
  await redis.del(...ids.map(id => k('tmpl', id)), ...ids.map(id => k('nudgebye', id, '2026-08-26')));
  await clear();
  eq((await reminderSweep(at)).map(z => z.zone), ['Asia/Dhaka'], 'the sweep runs at seven in Dhaka');
  const tmpl = async (id: number) => redis.get(k('tmpl', id));
  const marked = async (id: number) => (await redis.exists(k('reminded', id))) === 1;
  eq(await tmpl(alive), 'streak:0', 'a streak alive: told it ends at midnight, the first wording');
  eq(await tmpl(frozen), 'streak:0', 'a freeze that will cover yesterday: still a streak to keep');
  eq(await tmpl(opened), 'back:0', 'six days away: an evening for it');
  ok(!(await marked(five)) && (await tmpl(five)) === null, 'five days away: a quiet evening, nothing sent, nothing marked');
  ok(!(await marked(today)) && !(await marked(trained)), 'nobody who played today');
  eq(await tmpl(bye), 'final:0', 'fifteen days away: the last note');
  ok((await redis.exists(k('nudgebye', bye, '2026-08-26'))) === 1, 'remembered for the whole absence');
  ok(!(await marked(gone)) && (await tmpl(gone)) === null, 'a month away: silence');
  await clear();
  await reminderSweep(next);
  eq(await tmpl(alive), 'back:0', 'the next evening the streak is gone: what is waiting, from the first wording of that kind');
  eq(await tmpl(bye), 'final:0', 'and the last note is not sent twice');
  ok(!(await marked(opened)), 'seven days away: quiet again');
  await clear();
  await reminderSweep(new Date('2026-09-12T13:00:30Z'));
  eq(await tmpl(alive), 'back:1', 'the evening after: the next wording');
  await clear(); await redis.del(k('reminder', 'Asia/Dhaka', '2026-09-12'));
  // a device with no account counts its days from the last time it opened the game
  const tok6 = fcmToken('6').replace('fcm:', 'fcmdev6:'), tok5 = fcmToken('5').replace('fcm:', 'fcmdev5:');
  await saveToken(pool, null, tok6, 'app', 'Asia/Dhaka'); await saveToken(pool, null, tok5, 'app', 'Asia/Dhaka');
  await query(pool, `UPDATE push_tokens SET seen_at = '2026-09-04T12:00:00+06' WHERE token = $1`, [tok6]);
  await query(pool, `UPDATE push_tokens SET seen_at = '2026-09-05T12:00:00+06' WHERE token = $1`, [tok5]);
  const rows = (await deviceTargets('Asia/Dhaka')).tokens;
  const r6 = rows.find(r => r.token === tok6), r5 = rows.find(r => r.token === tok5);
  eq([r6?.seen_on, r5?.seen_on], ['2026-09-04', '2026-09-05'], 'the day it last opened, in its own zone');
  await redis.del(k('tmpl', 'tok', r6!.id), k('tmpl', 'tok', r5!.id), k('reminded', 'tok', r6!.id), k('reminded', 'tok', r5!.id));
  await reminderSweep(at);
  eq(await redis.get(k('tmpl', 'tok', r6!.id)), 'back:0', 'six days since it opened: told');
  eq(await redis.get(k('tmpl', 'tok', r5!.id)), null, 'five: not');
  await clear();
  await dropToken(pool, null, tok6); await dropToken(pool, null, tok5);
}

await finish();
