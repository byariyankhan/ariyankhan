// One live match per account, and what happens to a board nobody came back to.
//
// The thing being tested is a real fault a player found: the same account can be signed in on a phone and in
// a browser at once, and a challenge started in one of them was invisible to the other. The code lived in
// whichever client had opened the room, so closing a tab lost the room while the seat, and the stake sitting
// in it, stayed exactly where they were. The account could then start a second match, and from there its
// result went to whichever board it happened to be looking at.
//
// Two rules fix it and both are here: an account is in one match at a time and can always find which, and a
// board nobody has been heard from on is cleared rather than held until tomorrow.
import { pool, query, tx } from '../backend/src/db.js';
import { config } from '../backend/src/config.js';
import * as R from '../backend/src/rooms.js';
import { eq, finish, goldOf, ok, player, reset, section, stake } from './helpers.js';

await reset();
const S = stake();

/** A started match with these players in it, in the state a real one reaches on its second player. */
async function playing(...who: { id: number }[]): Promise<string> {
  const made = await R.createMatch(who[0]!, S, false, 2) as { ok: true; code: string };
  for (const p of who.slice(1)) await tx(c => R.joinRoomTx(c, p.id, made.code, 2));
  await tx(c => R.startRoom(c, made.code));
  return made.code;
}

/** Wind a room's clocks back, which is the only way to test a sweep without waiting for it. */
async function age(code: string, minutes: number): Promise<void> {
  await query(pool,
    `UPDATE matches SET started_at = started_at - ($2 || ' minutes')::interval WHERE code = $1`, [code, String(minutes)]);
  await query(pool,
    `UPDATE match_players SET last_seen_at = last_seen_at - ($2 || ' minutes')::interval WHERE code = $1`, [code, String(minutes)]);
}

const IDLE = config.game.idleMinutes;

section('An account is in one match at a time');
{
  const a = await player('one-a'), b = await player('one-b');
  const code = await playing(a, b);

  const live = await R.liveMatchOf(pool, a.id);
  eq(live?.code, code, 'the match an account is in can be found without being told the code');
  eq(live?.state, 'playing', 'and it says what state it is in');

  const again = await R.createMatch(a, S, false, 2);
  eq(again.ok, false, 'a second match cannot be started while the first is live');
  eq((again as { error: string }).error, 'in_match', 'and the refusal says why');
  eq((again as { code: string }).code, code, 'and hands back the room already held, so there is a way into it');

  // An invitation from somebody else is refused the same way, and for the same reason.
  const c3 = await player('one-c');
  const other = await R.createMatch(c3, S, false, 2) as { ok: true; code: string };
  const joined = await tx(c => R.joinRoomTx(c, a.id, other.code, 2));
  eq(joined.ok, false, 'an invitation cannot be accepted while a match is live');
  eq((joined as { error: string }).error, 'in_match', 'with the same refusal');

  // The room the account is already in is not a second match, however many times the link is opened.
  const openCode = (await R.createMatch(await player('one-d'), S, false, 2) as { ok: true; code: string }).code;
  const d2 = await query<{ id: number }>(pool, `SELECT user_id AS id FROM match_players WHERE code = $1`, [openCode]);
  const host = { id: d2.rows[0]!.id };
  const twice = await tx(c => R.joinRoomTx(c, host.id, openCode, 2));
  eq(twice.ok && twice.already, true, 'opening your own room again is not a second match');
}

section('Finishing or leaving frees the account');
{
  const a = await player('free-a'), b = await player('free-b');
  const code = await playing(a, b);
  await tx(c => R.submitResult(c, code, a.id, 4_000, true));
  eq(await R.liveMatchOf(pool, a.id), null, 'handing in a run frees the account, before the match even settles');
  eq((await R.liveMatchOf(pool, b.id))?.code, code, 'and leaves the player who is still on the board in it');

  const next = await R.createMatch(a, S, false, 2);
  eq(next.ok, true, 'so the next match can be started at once');
  // Tidy up: leave it, so the sweep tests below see only what they made.
  await tx(c => R.leaveRoom(c, (next as { code: string }).code, a.id));
  eq(await R.liveMatchOf(pool, a.id), null, 'and leaving a room that has not started frees the account too');
}

section('A board nobody played is handed back');
{
  const a = await player('idle-a'), b = await player('idle-b');
  const before = { a: await goldOf(a.id), b: await goldOf(b.id) };
  const code = await playing(a, b);
  eq(await goldOf(a.id), before.a - S, 'the stake is taken when the board is drawn');

  await R.sweep();
  eq((await R.matchRow(pool, code))?.state, 'playing', 'a board that has just begun is left alone');

  await age(code, IDLE + 1);
  const report = await R.sweep();
  ok(report.voided.includes(code), 'a board nobody has been heard from on is cleared');
  eq((await R.matchRow(pool, code))?.state, 'void', 'the room is closed rather than settled');
  eq(await goldOf(a.id), before.a, 'and both stakes go back: taking gold for a board that was never a contest is a fine for closing a tab');
  eq(await goldOf(b.id), before.b, 'the second stake as well');
  eq(await R.liveMatchOf(pool, a.id), null, 'the account is free to play again');
}

section('A board somebody played is settled, not handed back');
{
  const a = await player('half-a'), b = await player('half-b');
  const before = { a: await goldOf(a.id), b: await goldOf(b.id) };
  const code = await playing(a, b);
  await tx(c => R.submitResult(c, code, a.id, 5_000, true));   // a cleared it; b walked away

  await age(code, IDLE + 1);
  const report = await R.sweep();
  ok(report.settled.includes(code), 'the board is settled');
  const m = await R.matchRow(pool, code);
  eq(m?.state, 'done', 'and finished rather than voided');
  eq(m?.winner_id, a.id, 'the player who actually cleared it won it');
  eq(await goldOf(a.id), before.a + S, 'and is paid the pot');
  eq(await goldOf(b.id), before.b - S, 'while the one who never came back is counted as a loss, as they would have been had they stayed');
}

section('Being heard from holds the room');
{
  const a = await player('seen-a'), b = await player('seen-b');
  const code = await playing(a, b);
  await age(code, IDLE + 5);

  // The client posts its progress on a timer whether or not the number has moved. That is the heartbeat, and
  // a player staring at a hard board must count as present: the write used to be refused when the percentage
  // had not grown, which made thinking look exactly like leaving.
  await tx(c => R.saveProgress(c, code, a.id, 0));
  await tx(c => R.saveProgress(c, code, b.id, 0));
  await R.sweep();
  eq((await R.matchRow(pool, code))?.state, 'playing', 'a board somebody is still on is not swept, even with no progress at all');

  const seen = await query<{ pct: number }>(pool,
    `SELECT pct FROM match_players WHERE code = $1 AND user_id = $2`, [code, a.id]);
  eq(seen.rows[0]?.pct, 0, 'and a heartbeat never drags the percentage backwards');

  await tx(c => R.saveProgress(c, code, a.id, 40));
  await tx(c => R.saveProgress(c, code, a.id, 10));
  const kept = await query<{ pct: number }>(pool,
    `SELECT pct FROM match_players WHERE code = $1 AND user_id = $2`, [code, a.id]);
  eq(kept.rows[0]?.pct, 40, 'nor forwards to a number behind the one already reported');
}

section('A room that waited a long time before it began');
{
  // An invitation can sit open for a day before a friend accepts it. The seat that has been waiting all that
  // time was last heard from when it sat down, so without the clocks being restarted at the start the sweeper
  // would look at a board one second old and see a room nobody had visited since yesterday.
  const a = await player('wait-a'), b = await player('wait-b');
  const made = await R.createMatch(a, S, false, 2) as { ok: true; code: string };
  await tx(c => R.joinRoomTx(c, b.id, made.code, 2));
  await query(pool,
    `UPDATE match_players SET last_seen_at = now() - ($2 || ' minutes')::interval WHERE code = $1`,
    [made.code, String(IDLE + 30)]);
  await tx(c => R.startRoom(c, made.code));

  await R.sweep();
  eq((await R.matchRow(pool, made.code))?.state, 'playing', 'the board that has only just begun is left alone');
}

await finish();
