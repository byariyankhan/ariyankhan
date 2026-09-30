// The rules that decide who holds gold. If any of these fail, somebody has been paid twice or not at all.
import { pool, query, tx } from '../backend/src/db.js';
import { config } from '../backend/src/config.js';
import * as R from '../backend/src/rooms.js';
import { adClaim, give, idem, move, subHashSql } from '../backend/src/gold.js';
import { deleteUser, tombstoneHash, upsertUser } from '../backend/src/auth.js';
import { adTicketSpend, adTicketStart } from '../backend/src/adticket.js';
import { k, redis } from '../backend/src/redis.js';
import { begun, eq, finish, goldOf, ok, player, reset, section, stake } from './helpers.js';


await reset();
const S = stake();

section('A stake leaves the purse and the pot holds it');
{
  const a = await player('alice');
  const before = await goldOf(a.id);
  const made = await R.createMatch(a, S, false, 2);
  ok(made.ok, 'a room opens');
  eq(await goldOf(a.id), before - S, 'the stake has left the purse');
  const m = (await R.matchRow(pool, (made as { code: string }).code))!;
  eq(m.stakes_in, 1, 'the room counts one stake in');
  eq(m.state, 'open', 'and it is waiting for company');
}

section('Two players, one winner, one pot');
{
  const a = await player('ann'), b = await player('bob');
  const made = await R.createMatch(a, S, false, 2) as { ok: true; code: string };
  await tx(c => R.joinRoomTx(c, b.id, made.code, 2));
  const goldA = await goldOf(a.id), goldB = await goldOf(b.id);
  await tx(c => R.startRoom(c, made.code));
  await begun(made.code);                 // past the floor on how fast a board can be cleared

  await tx(async c => { await R.submitResult(c, made.code, b.id, 4_000, true); await R.settleMatch(c, made.code); });
  eq(await goldOf(b.id), goldB + S * 2, 'the first to clear it takes the whole pot at once');
  eq(await goldOf(a.id), goldA, 'the other player is not paid, and not charged again');

  const mid = (await R.matchRow(pool, made.code))!;
  eq(mid.state, 'playing', 'the match stays open until everyone has reported');
  eq(mid.winner_id, b.id, 'but the winner is already named');

  await tx(async c => { await R.submitResult(c, made.code, a.id, 9_000, true); await R.settleMatch(c, made.code); });
  const end = (await R.matchRow(pool, made.code))!;
  eq(end.state, 'done', 'once everyone reports the match closes');
  eq(end.winner_id, b.id, 'and the winner does not change on a later, slower clear');
  eq(await goldOf(b.id), goldB + S * 2, 'the pot is not paid a second time');
}

section('A result that arrives twice pays once');
{
  const a = await player('carl'), b = await player('dina');
  const made = await R.createMatch(a, S, false, 2) as { ok: true; code: string };
  await tx(c => R.joinRoomTx(c, b.id, made.code, 2));
  await tx(c => R.startRoom(c, made.code));
  await begun(made.code);                 // past the floor on how fast a board can be cleared
  const goldB = await goldOf(b.id);
  for (let i = 0; i < 5; i++) {
    await tx(async c => { await R.submitResult(c, made.code, b.id, 3_000, true); await R.settleMatch(c, made.code); });
  }
  eq(await goldOf(b.id), goldB + S * 2, 'five identical results still pay exactly one pot');
  const rows = await query<{ n: number }>(pool,
    `SELECT COUNT(*)::bigint AS n FROM gold_ledger WHERE match_code = $1 AND reason = 'payout'`, [made.code]);
  eq(Number(rows.rows[0]!.n), 1, 'and the ledger holds exactly one payout row');
}

section('Three at a table: first takes the rest, second its stake back, third a tenth');
{
  const a = await player('pl-a'), b = await player('pl-b'), c3 = await player('pl-c');
  const made = await R.createMatch(a, S, false, 2) as { ok: true; code: string };
  await tx(c => R.joinRoomTx(c, b.id, made.code, 2));
  await tx(c => R.joinRoomTx(c, c3.id, made.code, 2));
  const g = { a: await goldOf(a.id), b: await goldOf(b.id), c: await goldOf(c3.id) };
  await tx(c => R.startRoom(c, made.code));
  await begun(made.code);                 // past the floor on how fast a board can be cleared

  const third = Math.floor(S / 10);
  await tx(async c => { await R.submitResult(c, made.code, a.id, 4_000, true); await R.settleMatch(c, made.code); });
  eq(await goldOf(a.id), g.a + S * 3 - S - third, 'first takes the pot less what the other two places hold');
  eq(await goldOf(b.id), g.b, 'and nobody else is paid yet');

  await tx(async c => { await R.submitResult(c, made.code, b.id, 6_000, true); await R.settleMatch(c, made.code); });
  eq(await goldOf(b.id), g.b + S, 'second gets its stake back, so the board cost it nothing');

  await tx(async c => { await R.submitResult(c, made.code, c3.id, 9_000, true); await R.settleMatch(c, made.code); });
  eq(await goldOf(c3.id), g.c + third, 'third gets a tenth of its stake');

  const m = (await R.matchRow(pool, made.code))!;
  eq(m.state, 'done', 'and the room closes with everybody in');
  eq(m.winner_id, a.id, 'the first to clear it is still the winner');
  eq((await goldOf(a.id)) + (await goldOf(b.id)) + (await goldOf(c3.id)), g.a + g.b + g.c + S * 3,
    'and the three prizes add up to exactly the pot');
}

section('A place nobody claims goes to first, and only once the room has closed');
{
  const a = await player('un-a'), b = await player('un-b'), c3 = await player('un-c');
  const made = await R.createMatch(a, S, false, 2) as { ok: true; code: string };
  await tx(c => R.joinRoomTx(c, b.id, made.code, 2));
  await tx(c => R.joinRoomTx(c, c3.id, made.code, 2));
  const g = { a: await goldOf(a.id), b: await goldOf(b.id), c: await goldOf(c3.id) };
  await tx(c => R.startRoom(c, made.code));
  await begun(made.code);                 // past the floor on how fast a board can be cleared

  const third = Math.floor(S / 10);
  await tx(async c => { await R.submitResult(c, made.code, a.id, 4_000, true); await R.settleMatch(c, made.code); });
  eq(await goldOf(a.id), g.a + S * 3 - S - third, 'first is paid its share the moment it clears');

  // the other two give the board up rather than clearing it
  await tx(async c => { await R.submitResult(c, made.code, b.id, 0, false, true); await R.settleMatch(c, made.code); });
  eq(await goldOf(b.id), g.b, 'giving the board up is not second place');
  await tx(async c => { await R.submitResult(c, made.code, c3.id, 0, false); await R.settleMatch(c, made.code); });
  eq(await goldOf(c3.id), g.c, 'nor is running out of hearts');
  eq(await goldOf(a.id), g.a + S * 3, 'and the places nobody claimed go to first when the room closes');
  const rows = await query<{ n: string }>(pool,
    `SELECT COUNT(*)::bigint AS n FROM gold_ledger WHERE match_code = $1 AND reason = 'payout'`, [made.code]);
  eq(Number(rows.rows[0]!.n), 2, 'as one more ledger row, not a second pot');
}

section('Two players is still a duel: the winner takes everything');
{
  const a = await player('du-a'), b = await player('du-b');
  const made = await R.createMatch(a, S, false, 2) as { ok: true; code: string };
  await tx(c => R.joinRoomTx(c, b.id, made.code, 2));
  const g = { a: await goldOf(a.id), b: await goldOf(b.id) };
  await tx(c => R.startRoom(c, made.code));
  await begun(made.code);                 // past the floor on how fast a board can be cleared
  await tx(async c => { await R.submitResult(c, made.code, a.id, 4_000, true); await R.settleMatch(c, made.code); });
  eq(await goldOf(a.id), g.a + S * 2, 'first takes the whole pot');
  await tx(async c => { await R.submitResult(c, made.code, b.id, 7_000, true); await R.settleMatch(c, made.code); });
  eq(await goldOf(b.id), g.b, 'and second place pays nothing at a table of two');
}

section('Two settlements racing pay one pot');
{
  const a = await player('eve'), b = await player('finn');
  const made = await R.createMatch(a, S, false, 2) as { ok: true; code: string };
  await tx(c => R.joinRoomTx(c, b.id, made.code, 2));
  await tx(c => R.startRoom(c, made.code));
  await begun(made.code);                 // past the floor on how fast a board can be cleared
  const goldB = await goldOf(b.id);
  await tx(c => R.submitResult(c, made.code, b.id, 2_500, true));
  // the same settlement from two connections at once, which is what two API containers would do
  await Promise.all([
    tx(c => R.settleMatch(c, made.code)),
    tx(c => R.settleMatch(c, made.code)),
    tx(c => R.settleMatch(c, made.code)),
  ]);
  eq(await goldOf(b.id), goldB + S * 2, 'three concurrent settlements pay one pot');
}

section('Nobody clears it: every stake goes back');
{
  const a = await player('gus'), b = await player('hana');
  const made = await R.createMatch(a, S, false, 2) as { ok: true; code: string };
  await tx(c => R.joinRoomTx(c, b.id, made.code, 2));
  const goldA = await goldOf(a.id), goldB = await goldOf(b.id);
  await tx(c => R.startRoom(c, made.code));
  await begun(made.code);                 // past the floor on how fast a board can be cleared
  await tx(async c => { await R.submitResult(c, made.code, a.id, -1, false); await R.settleMatch(c, made.code); });
  await tx(async c => { await R.submitResult(c, made.code, b.id, -1, false); await R.settleMatch(c, made.code); });
  const end = (await R.matchRow(pool, made.code))!;
  eq(end.state, 'done', 'the match closes');
  eq(end.winner_id, null, 'with no winner');
  eq(await goldOf(a.id), goldA + S, 'the first stake is handed back');
  eq(await goldOf(b.id), goldB + S, 'and so is the second');
}

section('Walking out takes your own stake and nothing else');
{
  const a = await player('ivan'), b = await player('jo');
  const made = await R.createMatch(a, S, false, 2) as { ok: true; code: string };
  await tx(c => R.joinRoomTx(c, b.id, made.code, 2));
  const goldB = await goldOf(b.id);
  await tx(c => R.leaveRoom(c, made.code, b.id));
  eq(await goldOf(b.id), goldB + S, 'the stake comes back');
  const m = (await R.matchRow(pool, made.code))!;
  eq(m.stakes_in, 1, 'and the pot shrinks to match');
  eq(m.state, 'open', 'the room carries on for the player still in it');
}

section('The crown passes when the host walks out');
{
  const a = await player('kate'), b = await player('liam'), c2 = await player('mo');
  const made = await R.createMatch(a, S, false, 2) as { ok: true; code: string };
  await tx(c => R.joinRoomTx(c, b.id, made.code, 2));
  await tx(c => R.joinRoomTx(c, c2.id, made.code, 2));
  await tx(c => R.leaveRoom(c, made.code, a.id));
  const m = (await R.matchRow(pool, made.code))!;
  eq(m.state, 'open', 'the room survives losing its host');
  eq(m.host_id, b.id, 'and the next player by joining order takes the crown');
}

section('The last one out closes the room');
{
  const a = await player('nina');
  const made = await R.createMatch(a, S, false, 2) as { ok: true; code: string };
  const goldA = await goldOf(a.id);
  await tx(c => R.leaveRoom(c, made.code, a.id));
  eq((await R.matchRow(pool, made.code))!.state, 'void', 'the empty room closes');
  eq(await goldOf(a.id), goldA + S, 'and the stake goes home');
}

section('A purse that cannot cover the stake opens nothing');
{
  const poor = await player('opal', Math.floor(S / 2));
  const made = await R.createMatch(poor, S, false, 2);
  eq(made.ok, false, 'the room is refused');
  eq((made as { error: string }).error, 'not_enough_gold', 'for the honest reason');
  eq(await goldOf(poor.id), Math.floor(S / 2), 'and nothing was taken on the way');
}

section('Gold cannot be conjured by asking twice');
{
  const a = await player('pip');
  const before = await goldOf(a.id);
  await tx(c => give(c, a.id, 5_000, 'admin', idem.admin('same-key')));
  await tx(c => give(c, a.id, 5_000, 'admin', idem.admin('same-key')));
  await tx(c => give(c, a.id, 5_000, 'admin', idem.admin('same-key')));
  eq(await goldOf(a.id), before + 5_000, 'the same key pays once, however often it is used');
}

section('A balance can never go below zero');
{
  const a = await player('quinn', 100);
  const r = await tx(c => move(c, a.id, -500, 'stake', idem.admin('overdraft')));
  eq(r, null, 'an overdraft is refused');
  eq(await goldOf(a.id), 100, 'and the balance is untouched');
  const again = await tx(c => move(c, a.id, -50, 'stake', idem.admin('overdraft')));
  ok(again !== null, 'and the key is free to use again afterwards');
}

section('Two strangers at the same stake meet in one room, not two');
{
  // Nothing else may be waiting at this stake, or they would join that instead: use the stake no other
  // section touches, and prove the second player lands in the first one's room rather than opening their own.
  const lonelyStake = config.game.stakes[2]!;
  const a = await player('rosa'), b = await player('sami');
  const first = await R.createMatch(a, lonelyStake, true, 2) as { ok: true; code: string };
  const second = await R.createMatch(b, lonelyStake, true, 2) as { ok: true; code: string; joined?: string };
  eq(second.code, first.code, 'the second player walks into the room already waiting');
  eq(second.joined, first.code, 'and the result says so');
  const m = (await R.matchRow(pool, first.code))!;
  eq(m.stakes_in, 2, 'two stakes are in the pot');
  eq((await R.room(pool, first.code)).length, 2, 'and two players are sitting in it');
  ok(m.fills_at !== null, 'the second player starts the countdown');
}

section('A room of one walks into an older room when one turns up');
{
  const lonelyStake = config.game.stakes[1]!;
  const a = await player('tara'), b = await player('umar');
  const older = await R.createMatch(a, lonelyStake, true, 2) as { ok: true; code: string };
  // b opens their own room first (as if they had tapped at the same moment and missed each other)
  const younger = await tx(async c => {
    const code = 'ZZZ' + Math.random().toString(36).slice(2, 5).toUpperCase();
    await query(c, `INSERT INTO matches (code, host_id, stake, board, tier, seed, state, open_to_all, created_at)
                    VALUES ($1, $2, $3, 'FRA', 2, 1, 'open', true, now() + interval '1 second')`, [code, b.id, lonelyStake]);
    const m = (await R.matchRowLocked(c, code))!;
    await query(c, `INSERT INTO match_players (code, user_id, tier) VALUES ($1, $2, 2)`, [code, b.id]);
    await query(c, 'UPDATE matches SET stakes_in = 1 WHERE code = $1', [code]);
    await give(c, b.id, -lonelyStake, 'stake', idem.admin(`manual:${code}:${b.id}`), code);
    return m.code;
  });
  const moved = await tx(async c => R.requeue(c, (await R.matchRowLocked(c, younger))!, b.id));
  eq(moved, older.code, 'the newer room of one moves into the older one');
  eq((await R.matchRow(pool, younger))!.state, 'void', 'and the room left behind closes');
  eq((await R.room(pool, older.code)).length, 2, 'both players are now in the same room');
}

section('A winner who deletes their account does not hand the pot to somebody else');
{
  // Reported by a review bot on PR #82, and real: winner_id is a foreign key with ON DELETE SET NULL, and the
  // payout's ledger row cascades away with the account. Together they made a settled match look unsettled, so
  // the next player to clear it was paid the same pot a second time — gold created out of a deletion.
  const a = await player('vera'), b = await player('wasim'), c2 = await player('yusuf');
  const made = await R.createMatch(a, S, false, 2) as { ok: true; code: string };
  await tx(t => R.joinRoomTx(t, b.id, made.code, 2));
  await tx(t => R.joinRoomTx(t, c2.id, made.code, 2));
  await tx(t => R.startRoom(t, made.code));
  await begun(made.code);                 // past the floor on how fast a board can be cleared

  const goldA = await goldOf(a.id);
  await tx(async t => { await R.submitResult(t, made.code, a.id, 2_000, true); await R.settleMatch(t, made.code); });
  eq(await goldOf(a.id), goldA + S * 3 - S - Math.floor(S / 10), 'the first to clear it takes the pot less the two places behind it');

  const paidOut = (await query<{ n: number }>(pool,
    `SELECT COALESCE(SUM(delta),0)::bigint AS n FROM gold_ledger WHERE match_code = $1 AND reason = 'payout'`,
    [made.code])).rows[0]!.n;

  // now the winner deletes their account while the other two are still racing
  await deleteUser(a.id, R.releasePlayer);

  const goldB = await goldOf(b.id);
  await tx(async t => { await R.submitResult(t, made.code, b.id, 5_000, true); await R.settleMatch(t, made.code); });
  // Second place is owed its stake back whatever became of first — but only its stake back. The bug this
  // guards against is the pot being paid a second time, not the places behind it going unpaid.
  eq(await goldOf(b.id), goldB + S, 'the second finisher is paid second place, and not the pot again');

  const paidSince = (await query<{ n: number }>(pool,
    `SELECT COALESCE(SUM(delta),0)::bigint AS n FROM gold_ledger WHERE match_code = $1 AND reason = 'payout'`,
    [made.code])).rows[0]!.n;
  eq(Number(paidSince), S, 'the pot\'s own row went with the deleted account and nothing replaced it');
  ok(paidOut > 0, 'the pot really had been paid before the deletion');

  // and the last player still going must not be handed a draw refund either
  const goldC = await goldOf(c2.id);
  await tx(async t => { await R.submitResult(t, made.code, c2.id, -1, false); await R.settleMatch(t, made.code); });
  eq(await goldOf(c2.id), goldC, 'nor is the last one out refunded a stake that was won');
  const endPaid = (await query<{ n: number }>(pool,
    `SELECT COALESCE(SUM(delta),0)::bigint AS n FROM gold_ledger WHERE match_code = $1 AND reason = 'payout'`,
    [made.code])).rows[0]!.n;
  eq(Number(endPaid), S, 'and third place, unclaimed, is not invented for a winner who no longer exists');
  const end = (await R.matchRow(pool, made.code))!;
  eq(end.state, 'done', 'the match still closes');
  ok(end.paid_at !== null, 'and it still remembers that it was won, with the winner gone');
}

section('A finished match remembers who won it after they leave');
{
  const a = await player('zara'), b = await player('amin');
  const made = await R.createMatch(a, S, false, 2) as { ok: true; code: string };
  await tx(t => R.joinRoomTx(t, b.id, made.code, 2));
  await tx(t => R.startRoom(t, made.code));
  await begun(made.code);                 // past the floor on how fast a board can be cleared
  await tx(async t => { await R.submitResult(t, made.code, a.id, 1_500, true); await R.settleMatch(t, made.code); });
  await tx(async t => { await R.submitResult(t, made.code, b.id, -1, false); await R.settleMatch(t, made.code); });
  await deleteUser(a.id, R.releasePlayer);
  const m = (await R.matchRow(pool, made.code))!;
  const view = await R.matchView(pool, m, b.id);
  eq(view.draw, false, 'the result is not rewritten as a draw');
  eq(view.winner, 'zara', 'and it still names the winner');
}

section('Gold for an advertisement is bounded, not trusted');
{
  const AMOUNT = 500, PER_DAY = 3;
  const a = await player('adam');
  const before = await goldOf(a.id);

  const first = await tx(c => adClaim(c, a.id, AMOUNT, PER_DAY));
  eq(first.capped, false, 'the first claim of the day is allowed');
  eq(first.granted, AMOUNT, 'and it grants exactly what an ad is worth');
  eq(await goldOf(a.id), before + AMOUNT, 'the purse has it');
  eq(first.left, PER_DAY - 1, 'and the day has one fewer left');
}

{
  // The deterministic key is what protects a double-tapped button and two requests racing: both compute the
  // same claim number for the same day, and only one of them can write the row.
  const b = await player('bea');
  const before = await goldOf(b.id);
  const key = idem.adReward(b.id, new Date().toISOString().slice(0, 10), 1);
  const one = await tx(c => give(c, b.id, 500, 'ad_reward', key));
  const two = await tx(c => give(c, b.id, 500, 'ad_reward', key));
  eq(one?.applied, true, 'the first of two racing claims is the one that lands');
  eq(two?.applied, false, 'the second finds the key taken and grants nothing');
  eq(await goldOf(b.id), before + 500, 'so the purse moved exactly once');
}

{
  // And the day runs out.
  const c2 = await player('cass');
  const before = await goldOf(c2.id);
  const AMOUNT = 500, PER_DAY = 3;
  let granted = 0;
  for (let i = 0; i < PER_DAY + 2; i++) {
    const r = await tx(c => adClaim(c, c2.id, AMOUNT, PER_DAY));
    if (!r.capped) { granted += r.granted; continue; }
    eq(r.granted, 0, 'a claim past the cap grants nothing');
    eq(r.left, 0, 'with nothing left to claim');
  }
  eq(granted, AMOUNT * PER_DAY, 'a day is worth exactly the cap and no more');
  eq(await goldOf(c2.id), before + AMOUNT * PER_DAY, 'and that is what the purse holds');

  const rows = await query<{ n: string }>(pool,
    `SELECT count(*) AS n FROM gold_ledger WHERE user_id = $1 AND reason = 'ad_reward'`, [c2.id]);
  eq(Number(rows.rows[0]!.n), PER_DAY, 'one ledger row per claim the cap allowed, and no more');

  // An advertisement is not play, so it must never be able to climb the league.
  const asPlay = await query<{ n: string }>(pool,
    `SELECT count(*) AS n FROM gold_ledger
      WHERE user_id = $1 AND reason IN ('stake', 'payout', 'leave_refund', 'expire_refund', 'draw_refund')`, [c2.id]);
  eq(Number(asPlay.rows[0]!.n), 0, 'and none of it counts as a match played');
}

section('A clear sooner than the board could be cleared is not a clear yet');
{
  // The fault: the client's word decides the pot, and "cleared" posted the instant the board was dealt took it
  // from everybody at the table. A clear is now believed only once the server's own clock says the match has
  // run for as long as the fastest honest clear takes -- and until then nothing at all is written.
  eq(R.clearFloorMs(1), config.game.minBoardMs, 'the floor is the fastest believable clear of one board');
  eq(R.clearFloorMs(3), 3 * config.game.minBoardMs, 'and of three boards, three of them');
  const a = await player('floor-a'), b = await player('floor-b');
  const made = await R.createMatch(a, S, false, 2, 3) as { ok: true; code: string };
  await tx(c => R.joinRoomTx(c, b.id, made.code, 2));
  await tx(c => R.startRoom(c, made.code));
  const g = { a: await goldOf(a.id), b: await goldOf(b.id) };

  const early = await tx(async c => R.submitResult(c, made.code, a.id, 1, true));
  eq(early.ok, false, 'a clear the moment the match starts is refused');
  ok(!early.ok && early.why === 'too_early' && early.retryMs > 2 * config.game.minBoardMs && early.retryMs <= 3 * config.game.minBoardMs,
    `with how long until it would count (${!early.ok ? early.retryMs : 0} ms of a ${3 * config.game.minBoardMs} ms floor)`);
  const seat = await query<{ ms: number | null; finished_at: Date | null }>(pool,
    `SELECT ms, finished_at FROM match_players WHERE code = $1 AND user_id = $2`, [made.code, a.id]);
  eq([seat.rows[0]!.ms, seat.rows[0]!.finished_at], [null, null], 'and nothing is written: the seat is still racing');
  await tx(c => R.settleMatch(c, made.code));
  eq([await goldOf(a.id), await goldOf(b.id)], [g.a, g.b], 'nobody is paid');

  // A loss is a loss at any moment: running out of hearts in the first second is a thing that happens.
  const out = await tx(c => R.submitResult(c, made.code, b.id, -1, false));
  eq(out.ok, true, 'a board lost is taken at once');

  await begun(made.code, Math.ceil(R.clearFloorMs(3) / 1000) + 1);
  const later = await tx(async c => { const v = await R.submitResult(c, made.code, a.id, 1, true); await R.settleMatch(c, made.code); return v; });
  eq(later.ok, true, 'the same clear, sent again once the floor has passed, counts');
  eq(await goldOf(a.id), g.a + S * 2, 'and wins the pot');
}

section('Deleting an account and signing in again is not a second welcome');
{
  // The fault: a deletion cascaded away every ledger row, so nothing remembered that the Google account had
  // been paid its welcome gold. Delete, sign in, repeat -- ten thousand gold a time.
  const claims = { sub: 'google-sub-1234567890123456789', name: 'Tomb Stone', pic: '' };
  const first = await tx(c => upsertUser(c, 'google', claims));
  eq([first.created, first.granted], [true, config.game.signupGold], 'a new Google account is welcomed with gold');
  eq(await goldOf(first.user.id), config.game.signupGold, 'and holds it');
  const again = await tx(c => upsertUser(c, 'google', claims));
  eq([again.created, again.granted, again.user.id], [false, 0, first.user.id], 'signing in again is the same account, and no more gold');

  // Three advertisements claimed today, then the account goes.
  for (let i = 0; i < 3; i++) await tx(c => adClaim(c, first.user.id, 500, 3));
  await deleteUser(first.user.id, R.releasePlayer);
  const stones = await query<{ provider: string; sub_hash: string; ads_used: number }>(pool, `SELECT provider, sub_hash, ads_used FROM account_tombstones WHERE provider = 'google'`);
  eq(stones.rows.length, 1, 'the deletion leaves one tombstone for the Google account');
  eq(stones.rows[0]!.sub_hash, tombstoneHash('google', claims.sub), 'holding a one-way hash of the Google id');
  ok(!JSON.stringify(stones.rows).includes(claims.sub), 'and not the id itself');
  const inSql = await query<{ h: string }>(pool, `SELECT ${subHashSql('$1::text', '$2::text')} AS h`, ['google', claims.sub]);
  eq(inSql.rows[0]!.h, stones.rows[0]!.sub_hash, 'the SQL that looks it up computes the same hash as the code that wrote it');
  eq(stones.rows[0]!.ads_used, 3, 'and the advertisements claimed today');

  const back = await tx(c => upsertUser(c, 'google', claims));
  eq(back.created, true, 'signing in afterwards makes a new account');
  eq(back.granted, 0, 'with no welcome gold');
  eq(await goldOf(back.user.id), 0, 'so it starts with nothing');
  const cap = await tx(c => adClaim(c, back.user.id, 500, 3));
  eq(cap.capped, true, 'and today’s advertisements are still spent: a new account is not a new day');

  // Deleted and made again twice in a day: the tombstone adds the second account's claims to the first's.
  await deleteUser(back.user.id, R.releasePlayer);
  eq((await query<{ n: number }>(pool, `SELECT ads_used AS n FROM account_tombstones WHERE provider = 'google'`)).rows[0]!.n, 3, 'a second deletion keeps the day’s count');
  const other = await tx(c => upsertUser(c, 'google', { ...claims, sub: 'google-sub-somebody-else-000000' }));
  eq(other.granted, config.game.signupGold, 'and somebody else’s Google account is still welcomed');
}

section('Gold for an advertisement needs a ticket asked for first');
{
  const MIN = config.game.adMinSeconds * 1000;
  const a = await player('ticket-a');
  const t0 = Date.now();
  const ticket = await adTicketStart(a.id, t0);
  ok(typeof ticket === 'string' && ticket.length >= 16, 'a ticket is handed out');
  eq((await adTicketSpend(a.id, 'x'.repeat(32), MIN, t0 + MIN)).ok, false, 'a ticket nobody was given is refused');
  eq((await adTicketSpend(a.id, '', MIN, t0 + MIN)).ok, false, 'and so is none at all, which is what a page from before tickets sends');
  const early = await adTicketSpend(a.id, ticket!, MIN, t0 + 1_000);
  ok(!early.ok && early.why === 'too_early' && early.retryMs === MIN - 1_000, 'spent before an advertisement could have run, it is too early, with how long to wait');
  eq((await adTicketSpend(a.id, ticket!, MIN, t0 + MIN)).ok, true, 'once the wait is over it is spent');
  const twice = await adTicketSpend(a.id, ticket!, MIN, t0 + MIN);
  ok(!twice.ok && twice.why === 'no_ticket', 'and a ticket spent is gone');

  const one = await adTicketStart(a.id, t0), two = await adTicketStart(a.id, t0);
  ok(!(await adTicketSpend(a.id, one!, MIN, t0 + MIN)).ok, 'one ticket open at a time: asking again replaces the first');
  eq((await adTicketSpend(a.id, two!, MIN, t0 + MIN)).ok, true, 'and the new one is the one that counts');

  const b = await player('ticket-b');
  const theirs = await adTicketStart(b.id, t0);
  ok(!(await adTicketSpend(a.id, theirs!, MIN, t0 + MIN)).ok, 'a ticket is its own account’s and nobody else’s');
  ok(((await redis.ttl(k('adticket', b.id))) ?? 0) > 500, 'and it lapses by itself, ten minutes on');
}

await finish();
