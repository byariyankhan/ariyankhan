// What the notification layer promises about the devices it remembers.
//
// The sending itself is not tested here: it is an HTTPS request to somebody else's push service, and a suite
// that mocks that tests the mock. What matters on this side is the table — one row per browser, following the
// account that is signed in on it, disposable — and the words a notification arrives with.
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { pool, query } from '../backend/src/db.js';
import { appEnabled, dropSubscription, dropToken, hasSubscription, invitedNote, leagueNote, saveSubscription, saveToken } from '../backend/src/push.js';
import { assertion, enabled as fcmEnabled, messageFor, parseAccount } from '../backend/src/fcm.js';
import { eq, finish, ok, player, reset, section } from './helpers.js';

const sub = (n: number) => ({ endpoint: `https://push.example.com/e/${n}`, keys: { p256dh: `p${n}`, auth: `a${n}` } });
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
  eq(await rowsFor(a.id), ['https://push.example.com/e/1'], 'a subscription is kept');
  ok(await hasSubscription(pool, a.id), 'and the player has one');

  // A browser re-subscribing hands over the same endpoint with fresh keys. That is the same device saying the
  // same thing twice, and two rows would mean one invitation arriving twice on one phone.
  await saveSubscription(pool, a.id, { endpoint: sub(1).endpoint, keys: { p256dh: 'p1-new', auth: 'a1-new' } }, 'Chrome on Android');
  eq(await rowsFor(a.id), ['https://push.example.com/e/1'], 'subscribing again with the same endpoint does not add a second row');
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
  eq(await rowsFor(b.id), ['https://push.example.com/e/3'], 'and follows the one signed in on it now');
  ok(!(await hasSubscription(pool, a.id)), 'so the first account has nothing listening');
}

section('Letting go');
{
  const a = await player('pusher-d');
  await saveSubscription(pool, a.id, sub(4), 'Chrome');
  await saveSubscription(pool, a.id, sub(5), 'Firefox');
  await dropSubscription(pool, a.id, sub(4).endpoint);
  eq(await rowsFor(a.id), ['https://push.example.com/e/5'], 'turning it off on one device leaves the other alone');

  // Somebody else's endpoint is not this player's to drop.
  const b = await player('pusher-e');
  await dropSubscription(pool, b.id, sub(5).endpoint);
  eq(await rowsFor(a.id), ['https://push.example.com/e/5'], 'and a player cannot unsubscribe somebody else');

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

await finish();
