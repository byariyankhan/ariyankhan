// The rules that decide who holds gold. If any of these fail, somebody has been paid twice or not at all.
import { pool, query, tx } from '../backend/src/db.js';
import { config } from '../backend/src/config.js';
import * as R from '../backend/src/rooms.js';
import { give, idem, move } from '../backend/src/gold.js';
import { deleteUser } from '../backend/src/auth.js';
import { eq, finish, goldOf, ok, player, reset, section, stake } from './helpers.js';


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
  const goldB = await goldOf(b.id);
  for (let i = 0; i < 5; i++) {
    await tx(async c => { await R.submitResult(c, made.code, b.id, 3_000, true); await R.settleMatch(c, made.code); });
  }
  eq(await goldOf(b.id), goldB + S * 2, 'five identical results still pay exactly one pot');
  const rows = await query<{ n: number }>(pool,
    `SELECT COUNT(*)::bigint AS n FROM gold_ledger WHERE match_code = $1 AND reason = 'payout'`, [made.code]);
  eq(Number(rows.rows[0]!.n), 1, 'and the ledger holds exactly one payout row');
}

section('Two settlements racing pay one pot');
{
  const a = await player('eve'), b = await player('finn');
  const made = await R.createMatch(a, S, false, 2) as { ok: true; code: string };
  await tx(c => R.joinRoomTx(c, b.id, made.code, 2));
  await tx(c => R.startRoom(c, made.code));
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

  const goldA = await goldOf(a.id);
  await tx(async t => { await R.submitResult(t, made.code, a.id, 2_000, true); await R.settleMatch(t, made.code); });
  eq(await goldOf(a.id), goldA + S * 3, 'the first to clear it takes the pot of three');

  const paidOut = (await query<{ n: number }>(pool,
    `SELECT COALESCE(SUM(delta),0)::bigint AS n FROM gold_ledger WHERE match_code = $1 AND reason = 'payout'`,
    [made.code])).rows[0]!.n;

  // now the winner deletes their account while the other two are still racing
  await deleteUser(a.id, R.releasePlayer);

  const goldB = await goldOf(b.id);
  await tx(async t => { await R.submitResult(t, made.code, b.id, 5_000, true); await R.settleMatch(t, made.code); });
  eq(await goldOf(b.id), goldB, 'the second finisher is not paid a pot that is already gone');

  const payoutRows = (await query<{ n: number }>(pool,
    `SELECT COUNT(*)::int AS n FROM gold_ledger WHERE match_code = $1 AND reason = 'payout'`,
    [made.code])).rows[0]!.n;
  eq(payoutRows, 0, 'the only payout row went with the account that was deleted, and no new one replaced it');
  ok(paidOut > 0, 'the pot really had been paid before the deletion');

  // and the last player still going must not be handed a draw refund either
  const goldC = await goldOf(c2.id);
  await tx(async t => { await R.submitResult(t, made.code, c2.id, -1, false); await R.settleMatch(t, made.code); });
  eq(await goldOf(c2.id), goldC, 'nor is the last one out refunded a stake that was won');
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
  await tx(async t => { await R.submitResult(t, made.code, a.id, 1_500, true); await R.settleMatch(t, made.code); });
  await tx(async t => { await R.submitResult(t, made.code, b.id, -1, false); await R.settleMatch(t, made.code); });
  await deleteUser(a.id, R.releasePlayer);
  const m = (await R.matchRow(pool, made.code))!;
  const view = await R.matchView(pool, m, b.id);
  eq(view.draw, false, 'the result is not rewritten as a draw');
  eq(view.winner, 'zara', 'and it still names the winner');
}

await finish();
