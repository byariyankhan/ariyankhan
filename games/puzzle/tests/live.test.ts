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

section('The board travels with the seat');
{
  // The other half of resuming. A match found on a second device used to come up as a fresh board: the
  // server knew the percentage and nothing else. The run is a snapshot the client posts with its progress,
  // and it is replaced only by a snapshot with at least as many moves -- so a tab left open on a stale board
  // cannot put back the arrows a phone has since cleared.
  const a = await player('run-a'), b = await player('run-b');
  const code = await playing(a, b);
  const runOf = async (id: number) => (await query<{ run: R.RunState | null }>(pool,
    `SELECT run FROM match_players WHERE code = $1 AND user_id = $2`, [code, id])).rows[0]!.run;

  const early = { moves: 3, gone: [4, 1, 9], lives: 3, wrong: 1, hintsUsed: 0, hintsMax: 3, checksUsed: 0, checksMax: 4 };
  await tx(c => R.saveProgress(c, code, a.id, 16, R.cleanRun(early)));
  eq((await runOf(a.id))?.moves, 3, 'a snapshot posted with progress is kept');
  eq(JSON.stringify((await runOf(a.id))?.gone), '[1,4,9]', 'with the arrows that have gone, in order');

  const later = { ...early, moves: 7, gone: [1, 4, 9, 12, 20], lives: 2, wrong: 2 };
  await tx(c => R.saveProgress(c, code, a.id, 30, R.cleanRun(later)));
  eq((await runOf(a.id))?.moves, 7, 'a snapshot with more moves replaces it');
  eq((await runOf(a.id))?.lives, 2, 'hearts included');

  // The tab on the desk, still posting the board as it saw it twenty minutes ago.
  await tx(c => R.saveProgress(c, code, a.id, 16, R.cleanRun(early)));
  eq((await runOf(a.id))?.moves, 7, 'a snapshot with fewer moves is refused');
  eq((await runOf(a.id))?.gone.length, 5, 'and puts no arrow back on the board');

  await tx(c => R.saveProgress(c, code, a.id, 30, R.cleanRun(later)));
  eq((await runOf(a.id))?.moves, 7, 'the same snapshot again is the ordinary case, not a conflict');

  await tx(c => R.saveProgress(c, code, a.id, 31));
  eq((await runOf(a.id))?.moves, 7, 'progress posted without a snapshot leaves the one held alone');

  // The view hands it back to its owner, and to nobody else.
  const m = (await R.matchRow(pool, code))!;
  const mine = await R.matchView(pool, m, a.id);
  eq(mine.your_run?.moves, 7, 'the owner is handed their run with the match');
  const theirs = await R.matchView(pool, m, b.id);
  eq(theirs.your_run, null, 'a seat that has not moved has no run yet');
  ok(!JSON.stringify(theirs.players).includes('"gone"'), 'and nobody is handed anybody else\u2019s board');

  // Whatever a client sends that is not a board is dropped without touching the seat.
  eq(R.cleanRun({ moves: 1, gone: 'all of them', lives: 3, wrong: 0, hintsUsed: 0, hintsMax: 3, checksUsed: 0, checksMax: 4 }), null, 'a run whose arrows are not a list is not a run');
  eq(R.cleanRun({ moves: -1, gone: [], lives: 3, wrong: 0, hintsUsed: 0, hintsMax: 3, checksUsed: 0, checksMax: 4 }), null, 'nor one with a negative counter');
  eq(R.cleanRun({ moves: 1, gone: [1, 1, 2], lives: 3, wrong: 0, hintsUsed: 0, hintsMax: 3, checksUsed: 0, checksMax: 4 })?.gone.length, 2, 'a repeated arrow is counted once');
  eq(R.cleanRun({ moves: 1, gone: new Array(5000).fill(1).map((_, i) => i), lives: 3, wrong: 0, hintsUsed: 0, hintsMax: 3, checksUsed: 0, checksMax: 4 }), null, 'and a board of five thousand arrows is not a board');
  eq(R.cleanRun(null), null, 'nothing is nothing');
  await tx(c => R.saveProgress(c, code, a.id, 32, R.cleanRun({ junk: true })));
  eq((await runOf(a.id))?.moves, 7, 'and none of it reaches the seat');

  // A finished seat is closed to all of it.
  await tx(c => R.submitResult(c, code, a.id, 8_000, true));
  await tx(c => R.saveProgress(c, code, a.id, 100, R.cleanRun({ ...later, moves: 99 })));
  eq((await runOf(a.id))?.moves, 7, 'a run handed in is not rewritten afterwards');
}

section('A match is a run of boards');
{
  const a = await player('twist-a'), b = await player('twist-b');
  const made = await R.createMatch(a, S, false, 2, 3) as { ok: true; code: string };
  const open = await R.matchView(pool, (await R.matchRow(pool, made.code))!, a.id);
  eq(open.boards_n, 3, 'the room says how long it is before it starts');
  eq(open.boards, undefined, 'but not which boards, until it does');
  await tx(c => R.joinRoomTx(c, b.id, made.code, 2));
  await tx(c => R.startRoom(c, made.code));
  const m = (await R.matchRow(pool, made.code))!;
  const v = await R.matchView(pool, m, b.id);
  eq(v.boards?.length, 3, 'three boards once it starts');
  eq(new Set(v.boards).size, 3, 'all different');
  eq(v.board, v.boards?.[0], 'and board is the first of them, for a client from before there was a list');

  const plain = await R.createMatch(await player('twist-c'), S, false, 2) as { ok: true; code: string };
  eq((await R.matchView(pool, (await R.matchRow(pool, plain.code))!, null)).boards_n, 1, 'a match asked for with no length is one board, as before');
  eq((await R.createMatch(await player('twist-d'), S, false, 2, 4)).ok, false, 'a length the server does not offer is refused');

  // The run carries which board it is on; the guard on it is the same.
  const run = R.cleanRun({ moves: 9, gone: [1, 2], lives: 3, wrong: 1, hintsUsed: 0, hintsMax: 3, checksUsed: 0, checksMax: 4, bi: 1 });
  eq(run?.bi, 1, 'the board index rides with the run');
  eq(R.cleanRun({ moves: 1, gone: [], lives: 3, wrong: 0, hintsUsed: 0, hintsMax: 3, checksUsed: 0, checksMax: 4 })?.bi, undefined, 'a one-board run has no index');
  eq(R.cleanRun({ moves: 1, gone: [], lives: 3, wrong: 0, hintsUsed: 0, hintsMax: 3, checksUsed: 0, checksMax: 4, bi: 40 }), null, 'an index off the end is not a run');
  await tx(c => R.saveProgress(c, made.code, b.id, 40, run));
  eq((await R.matchView(pool, (await R.matchRow(pool, made.code))!, b.id)).your_run?.bi, 1, 'and comes back to the seat that posted it');
}

await finish();
