// What the notification layer promises about the devices it remembers.
//
// The sending itself is not tested here: it is an HTTPS request to somebody else's push service, and a suite
// that mocks that tests the mock. What matters on this side is the table — one row per browser, following the
// account that is signed in on it, disposable — and the words a notification arrives with.
import { pool, query } from '../backend/src/db.js';
import { dropSubscription, hasSubscription, invitedNote, leagueNote, saveSubscription } from '../backend/src/push.js';
import { eq, finish, ok, player, reset, section } from './helpers.js';

const sub = (n: number) => ({ endpoint: `https://push.example.com/e/${n}`, keys: { p256dh: `p${n}`, auth: `a${n}` } });
const rowsFor = async (userId: number) =>
  (await query<{ endpoint: string }>(pool, `SELECT endpoint FROM push_subscriptions WHERE user_id = $1 ORDER BY id`, [userId])).rows.map(r => r.endpoint);

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

await finish();
