// The league: who is ranked, what they are paid, and the promise that a season is paid exactly once.
//
// Every row these tests count is a real gold movement written by gold.move(), backdated into the week being
// tested. That matters: the suite finishes by checking the ledger still accounts for every balance, so a
// league that paid twice, or paid out of nowhere, fails here rather than in production.
import { pool, query } from '../backend/src/db.js';
import { config } from '../backend/src/config.js';
import * as L from '../backend/src/league.js';
import { give, idem, move } from '../backend/src/gold.js';
import { eq, finish, goldOf, ok, player, reset, section } from './helpers.js';

await reset();

const HOUR = 3600_000;
const now = new Date();
const thisWeek = L.seasonAt(now);
const lastWeek = L.previousSeason(thisWeek);

/** A gold movement that happened at a particular moment. The balance moves now; the row is dated then. */
async function moved(userId: number, delta: number, reason: Parameters<typeof move>[3], key: string, at: Date, code: string | null = null): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await move(client, userId, delta, reason, key, code);
    if (!r?.applied) throw new Error(`could not move ${delta} for ${userId}`);
    await client.query('UPDATE gold_ledger SET created_at = $2 WHERE idem_key = $1', [key, at]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

/** A room opened (and played) at `at`: the league counts a match in the week its room was opened. */
let rooms = 0;
async function room(at: Date, started = true): Promise<string> {
  const code = `LG${String(++rooms).padStart(4, '0')}`;
  await query(pool, `INSERT INTO matches (code, stake, board, tier, seed, state, created_at, started_at)
                     VALUES ($1, 1000, '050', 2, 1, $2, $3, $4)`, [code, started ? 'done' : 'void', at, started ? at : null]);
  return code;
}

/**
 * A match, as the ledger records one: everybody stakes, and the winner is paid what the others lost. `losers`
 * are who paid for it, each with what they lost, so the league can see whose gold a win was.
 */
async function match(winner: number, losers: [number, number][], at: Date, tag: string): Promise<void> {
  const code = await room(at);
  const won = losers.reduce((a, [, lost]) => a + lost, 0);
  await moved(winner, -1_000, 'stake', `t-stake:${tag}:${winner}`, at, code);
  await moved(winner, 1_000 + won, 'payout', `t-payout:${tag}`, at, code);
  for (const [id, lost] of losers) if (lost > 0) await moved(id, -lost, 'stake', `t-stake:${tag}:${id}`, at, code);
}

/** Three accounts to lose to the players a test is about, with a deep purse, named so a test can leave them out. */
const sparring = async (tag: string) => [await player(`foe-${tag}-1`, 50_000_000), await player(`foe-${tag}-2`, 50_000_000), await player(`foe-${tag}-3`, 50_000_000)];
const notFoe = (r: { name: string }) => !r.name.startsWith('foe-');

/** A week's win of `netGold`, taken from three different opponents in one room: a win the league can pay. */
async function played(id: number, netGold: number, at: Date, tag: string, foes: { id: number }[] = FOES): Promise<void> {
  const share = (i: number) => Math.floor(netGold / foes.length) + (i < netGold % foes.length ? 1 : 0);
  await match(id, foes.map((f, i) => [f.id, netGold > 0 ? share(i) : 0] as [number, number]), at, tag);
}
// the opponents `played` takes a week's winnings from; made again after every reset() that wipes them
let FOES = await sparring('top');

section('A season is a week, and it starts on a Monday');
{
  eq(thisWeek.endsAt.getTime() - thisWeek.startsAt.getTime(), config.league.hours * HOUR, 'a season is as long as the setting says');
  eq(config.league.hours, 168, 'and the setting is one week');
  eq(thisWeek.startsAt.getUTCDay(), 1, 'seasons open on a Monday');
  eq(thisWeek.startsAt.getUTCHours(), 0, 'at midnight UTC');
  eq(lastWeek.endsAt.getTime(), thisWeek.startsAt.getTime(), 'last week ends exactly where this one begins');
  eq(thisWeek.key, thisWeek.startsAt.toISOString().slice(0, 10), 'the key is the day it opened');
  ok(L.seasonAt(thisWeek.startsAt).key === thisWeek.key, 'the first instant of a season is inside it');
  ok(L.seasonAt(new Date(thisWeek.endsAt.getTime() - 1)).key === thisWeek.key, 'and the last one is too');
  ok(L.seasonAt(thisWeek.endsAt).key !== thisWeek.key, 'the instant it ends belongs to the next season');
}

section('The prize ladder doubles from tenth place to first');
{
  const ladder = L.prizeLadder();
  eq(ladder.length, 10, 'ten places are paid');
  eq(L.prizeFor(10), 10_000, 'tenth takes the base');
  eq(L.prizeFor(9), 20_000, 'ninth takes twice that');
  eq(L.prizeFor(8), 40_000, 'eighth twice again');
  eq(L.prizeFor(1), 5_120_000, 'and first takes the base doubled nine times');
  eq(ladder.reduce((a, b) => a + b, 0), 10_230_000, 'the whole ladder is 10.23M gold a week');
  eq(L.prizeFor(11), 0, 'eleventh place is not a prize');
  eq(L.prizeFor(0), 0, 'nor is a rank that does not exist');
  eq(L.prizeFor(1.5), 0, 'nor half a rank');
}

section('Earning is what you won at the tables, netted');
{
  const a = await player('lea-net');
  const before = await goldOf(a.id);
  await played(a.id, 4_000, new Date(thisWeek.startsAt.getTime() + HOUR), 'net-a');
  await moved(a.id, -1_000, 'stake', 't-stake:net-lost', new Date(thisWeek.startsAt.getTime() + 2 * HOUR));

  const mine = await L.placeOf(pool, thisWeek, a.id);
  eq(mine.earning, 3_000, 'a 4,000 win and a 1,000 stake lost is 3,000 earned');
  eq(await goldOf(a.id), before + 3_000, 'and the purse agrees');
}

section('Gold that is not winnings is not earning');
{
  const a = await player('lea-gift');
  // The signup grant, an admin correction and last season's league prize all land in the same week.
  await moved(a.id, 50_000, 'admin', 't-admin:gift', new Date(thisWeek.startsAt.getTime() + HOUR));
  await moved(a.id, 5_120_000, 'league', 't-league:gift', new Date(thisWeek.startsAt.getTime() + HOUR));
  eq((await L.placeOf(pool, thisWeek, a.id)).earning, 0, 'given gold does not count towards the league');
  eq((await L.placeOf(pool, thisWeek, a.id)).rank, null, 'so it is no place at all');

  await played(a.id, 500, new Date(thisWeek.startsAt.getTime() + 3 * HOUR), 'gift-play');
  eq((await L.placeOf(pool, thisWeek, a.id)).earning, 500, 'only what was won at a table counts');
}

section('Play outside the week is another week');
{
  const a = await player('lea-when');
  await played(a.id, 9_000, new Date(lastWeek.startsAt.getTime() + HOUR), 'when-last');
  eq((await L.placeOf(pool, thisWeek, a.id)).earning, 0, 'last week does not show up in this week');
  eq((await L.placeOf(pool, lastWeek, a.id)).earning, 9_000, 'it shows up in its own');
}

section('The table is ordered by earning, and a tie goes to whoever got there first');
{
  await reset();
  const mid = lastWeek.startsAt.getTime() + 24 * HOUR;
  FOES = await sparring(String(++rooms));
  const big = await player('rank-big'), early = await player('rank-early'), late = await player('rank-late'), small = await player('rank-small');
  await played(big.id, 30_000, new Date(mid), 'r-big');
  await played(early.id, 20_000, new Date(mid), 'r-early');
  await played(late.id, 20_000, new Date(mid + HOUR), 'r-late');
  await played(small.id, 5_000, new Date(mid), 'r-small');
  // A losing week and a week that broke even: both are places, at the bottom where they belong.
  const lost = await player('rank-lost'), even = await player('rank-even');
  await moved(lost.id, -1_000, 'stake', 't-stake:r-lost', new Date(mid));
  await played(even.id, 0, new Date(mid), 'r-even');

  const table = (await L.standings(pool, lastWeek)).filter(notFoe);   // the sparring accounts lost it all, below everybody
  eq(table.map(r => r.name), ['rank-big', 'rank-early', 'rank-late', 'rank-small', 'rank-even', 'rank-lost'],
    'most won is first, and everyone who played is on the board');
  eq(table.map(r => r.earning), [30_000, 20_000, 20_000, 5_000, 0, -1_000], 'with what each of them is up over the week');
  eq(table.map(r => r.rank), [1, 2, 3, 4, 5, 6], 'ranked from one, straight down');

  eq((await L.placeOf(pool, lastWeek, late.id)).rank, 3, 'a tie is broken by who stopped earning first, not by chance');
  eq((await L.placeOf(pool, lastWeek, even.id)).rank, 5, 'breaking even is a placing');
  eq((await L.placeOf(pool, lastWeek, lost.id)).rank, 6, 'and so is losing: a bad week is a low place, not the door');
  eq((await L.placeOf(pool, lastWeek, lost.id)).earning, -1_000, 'ranked on the earning it actually has, which is negative');
  eq((await L.placeOf(pool, lastWeek, lost.id)).rank, table.find(r => r.name === 'rank-lost')!.rank,
    'and their own line agrees with the row the table shows them in');

  // Nothing to do with the league: a player who has not played this week is not in the table at all.
  const idle = await player('rank-idle');
  eq((await L.placeOf(pool, lastWeek, idle.id)).rank, null, 'a week you sat out is no place');
}

section('A finished season is ranked, paid and frozen');
{
  await reset();
  const mid = lastWeek.startsAt.getTime() + 24 * HOUR;
  FOES = await sparring(String(++rooms));
  const players = [];
  for (let i = 0; i < 12; i++) {
    const p = await player(`league-${String(i).padStart(2, '0')}`);
    // i = 0 wins the most; the last two win nothing at all
    if (i < 10) await played(p.id, (12 - i) * 1_000, new Date(mid + i * 60_000), `s-${i}`);
    players.push(p);
  }
  const before = await Promise.all(players.map(p => goldOf(p.id)));

  await L.ensureSeason(pool, lastWeek);
  const done = await L.settleDue(now);
  ok(!!done, 'the season that has ended is settled');
  eq(done!.key, lastWeek.key, 'and it is last week, not this one');
  eq(done!.paid.length, 10, 'ten places are paid');
  eq(done!.paid.map(p => p.gold), L.prizeLadder(), 'each of them the ladder amount');
  eq(done!.paid[0]!.name, 'league-00', 'the player who won the most takes first');

  const after = await Promise.all(players.map(p => goldOf(p.id)));
  eq(after[0]! - before[0]!, 5_120_000, 'first place is paid 5.12M');
  eq(after[9]! - before[9]!, 10_000, 'tenth place is paid 10K');
  eq(after[10]! - before[10]!, 0, 'eleventh place is paid nothing');
  eq(after[11]! - before[11]!, 0, 'and so is everyone below');

  section('  settling again pays nothing');
  {
    const again = await L.settleDue(now);
    eq(again, null, 'there is nothing left due');
    const twice = await Promise.all(players.map(p => goldOf(p.id)));
    eq(twice, after, 'and no balance moved');
    const rows = await query<{ n: number }>(pool,
      `SELECT COUNT(*)::bigint AS n FROM gold_ledger WHERE reason = 'league'`);
    eq(Number(rows.rows[0]!.n), 10, 'the ledger holds exactly ten prize rows');
  }

  section('  and the result reads the same afterwards');
  {
    const saved = await L.resultOf(pool, lastWeek.key);
    eq(saved!.paid.length, 10, 'the finished table is kept');
    eq(saved!.paid[0]!.name, 'league-00', 'with the names as they stood');
    const last = await L.lastSettled(pool);
    eq(last!.key, lastWeek.key, 'and it is the one the game shows as last week');

    await query(pool, 'DELETE FROM users WHERE id = $1', [players[0]!.id]);
    const afterGone = await L.resultOf(pool, lastWeek.key);
    eq(afterGone!.paid[0]!.name, 'league-00', 'a winner who deletes their account does not erase the result');
    eq(afterGone!.paid[0]!.user_id, null, 'the row simply stops pointing at an account');
  }
}

section('The table is a hundred places long');
{
  await reset();
  const mid = thisWeek.startsAt.getTime() + 6 * HOUR;
  FOES = await sparring('deep');
  for (let i = 0; i < 105; i++) {
    const p = await player(`deep-${String(i).padStart(3, '0')}`);
    await played(p.id, (200 - i) * 100, new Date(mid + i * 1000), `d-${i}`);
  }
  const table = await L.standings(pool, thisWeek, L.TABLE_SIZE);
  eq(table.length, 100, 'a hundred rows come back, not fifty');
  eq(table[0]!.name, 'deep-000', 'the best week is first');
  eq(table[99]!.rank, 100, 'and the last row is the hundredth place');

  // and a player past the end of it is still told where they stand
  const beyond = await L.placeOf(pool, thisWeek, (await query<{ id: number }>(pool,
    `SELECT id FROM users WHERE name = 'deep-104'`)).rows[0]!.id);
  eq(beyond.rank, 105, 'a player outside the hundred still has a rank of their own');
  ok(beyond.earning > 0, 'and an earning to go with it');
}

section('A league nobody won pays nobody');
{
  await reset();
  const a = await player('quiet');
  await moved(a.id, -1_000, 'stake', 't-stake:quiet', new Date(lastWeek.startsAt.getTime() + HOUR));
  eq((await L.standings(pool, lastWeek)).map(r => r.name), ['quiet'], 'the one player who turned up is in the table');
  await L.ensureSeason(pool, lastWeek);
  const done = await L.settleDue(now);
  ok(!!done, 'the season still closes');
  eq(done!.paid.length, 0, 'but a player who ended the week down is not paid for being on the board');
  const rows = await query<{ n: number }>(pool, `SELECT COUNT(*)::bigint AS n FROM gold_ledger WHERE reason = 'league'`);
  eq(Number(rows.rows[0]!.n), 0, 'and no prize row is written');
}

section('Fewer players than places');
{
  await reset();
  const mid = lastWeek.startsAt.getTime() + 12 * HOUR;
  FOES = await sparring('few');
  const a = await player('few-a'), b = await player('few-b'), c = await player('few-down');
  await played(a.id, 8_000, new Date(mid), 'f-a');
  await played(b.id, 3_000, new Date(mid + 60_000), 'f-b');
  await moved(c.id, -2_000, 'stake', 't-stake:f-down', new Date(mid + 120_000));   // third on the board, down on the week
  const before = [await goldOf(a.id), await goldOf(b.id), await goldOf(c.id)];

  await L.ensureSeason(pool, lastWeek);
  const done = await L.settleDue(now);
  eq(done!.paid.map(p => p.rank), [1, 2], 'only the places that were played for are paid');
  eq(await goldOf(c.id) - before[2]!, 0, 'third place on a losing week is paid nothing, prize ladder or not');
  eq(await goldOf(a.id) - before[0]!, 5_120_000, 'first place is still first place');
  eq(await goldOf(b.id) - before[1]!, 2_560_000, 'and second is second, however few turned up');
}

section('A gap in the seasons is filled rather than skipped');
{
  await reset();
  const old = L.seasonAt(thisWeek.startsAt.getTime() - 4 * 168 * HOUR);
  await L.ensureSeason(pool, old);
  const made = await L.ensureSeasonsThrough(pool, now);
  ok(made >= 4, 'the weeks between the last one on record and now are created');
  const rows = await query<{ key: string }>(pool, 'SELECT key FROM league_seasons ORDER BY starts_at');
  eq(rows.rows[0]!.key, old.key, 'starting where the record left off');
  eq(rows.rows[rows.rows.length - 1]!.key, thisWeek.key, 'and ending with the week we are in');

  // Every one of them has ended except this one, and they settle oldest first, paying nothing.
  const settled = await L.leagueSweep(now);
  eq(settled.length, rows.rowCount! - 1, 'every finished season is settled, and the running one is not');
  eq(await L.leagueSweep(now), [], 'a second sweep finds nothing to do');
}

// One prize row must never be able to exist twice, whatever the caller does.
section('The ledger refuses a second prize for the same season');
{
  await reset();
  const a = await player('twice');
  const before = await goldOf(a.id);
  await give(pool as never, a.id, 1_000, 'league', idem.league('2026-01-05', a.id));
  const second = await give(pool as never, a.id, 1_000, 'league', idem.league('2026-01-05', a.id));
  eq(second?.applied, false, 'the same season and player cannot be paid twice');
  eq(await goldOf(a.id), before + 1_000, 'and the purse only moved once');
}

// ── Whose gold a win was ──
// Netting stops two accounts gaining together, but the table ranks people one at a time: the account that
// loses does not care. Each Google account brings 10,000 gold, so a prize could be bought with accounts made
// to lose to one player in a friends' room. A prize needs several different opponents, and gold whose loser no
// longer exists is nobody's to credit. What one opponent hands over is not capped: a win counts as much as the loss.

section('What one opponent hands over counts in full: no cap');
{
  await reset();
  const mid = thisWeek.startsAt.getTime() + 2 * HOUR;
  const main = await player('cap-main'), feeder = await player('cap-feeder', 50_000_000), other = await player('cap-other');
  // Three big wins from the same person, then a small one from somebody else.
  for (let i = 0; i < 3; i++) await match(main.id, [[feeder.id, 1_000_000]], new Date(mid + i * 60_000), `cap-${i}`);
  await match(main.id, [[other.id, 5_000]], new Date(mid + 5 * 60_000), 'cap-other');
  const me = await L.placeOf(pool, thisWeek, main.id);
  eq(me.earning, 3_000_000 + 5_000, 'three million won from one opponent counts as three million, plus what came from somebody else');
  eq((await L.placeOf(pool, thisWeek, feeder.id)).earning, -3_000_000, 'the same as the loss it came from');
  eq(me.opponents, 2, 'and two different people were played');

  // Friends who trade wins are netted pair by pair: up 50,000 and down 30,000 to the same person is 20,000.
  const f1 = await player('cap-friend-1'), f2 = await player('cap-friend-2');
  await match(f1.id, [[f2.id, 50_000]], new Date(mid + 10 * 60_000), 'friends-1');
  await match(f2.id, [[f1.id, 30_000]], new Date(mid + 11 * 60_000), 'friends-2');
  eq([(await L.placeOf(pool, thisWeek, f1.id)).earning, (await L.placeOf(pool, thisWeek, f2.id)).earning], [20_000, -20_000],
    'two friends trading wins are netted, and a friends’ room counts');

  const rows = await L.standings(pool, thisWeek);
  eq(rows.find(r => r.user_id === main.id)?.earning, me.earning, 'the table and the player’s own line agree');
}

section('A prize needs three different opponents');
{
  await reset();
  const mid = lastWeek.startsAt.getTime() + 30 * HOUR;
  const foes = await sparring('elig');
  const pair = await player('elig-pair'), wide = await player('elig-wide');
  // Two opponents, a big week: on the board, and not paid.
  await match(pair.id, [[foes[0]!.id, 40_000]], new Date(mid), 'elig-1');
  await match(pair.id, [[foes[1]!.id, 40_000]], new Date(mid + 60_000), 'elig-2');
  // Three opponents, a small week: paid first.
  await match(wide.id, [[foes[0]!.id, 400], [foes[1]!.id, 300], [foes[2]!.id, 300]], new Date(mid + 120_000), 'elig-3');
  const table = await L.standings(pool, lastWeek);
  eq(table.slice(0, 2).map(r => [r.name, r.earning, r.opponents, r.eligible]), [['elig-wide', 1_000, 3, true], ['elig-pair', 80_000, 2, false]],
    'the lines that can be paid rank first, so the ranks are the prize places');
  const before = [await goldOf(pair.id), await goldOf(wide.id)];
  await L.ensureSeason(pool, lastWeek);
  const done = await L.settleDue(now);
  eq(done!.paid.map(p => p.name), ['elig-wide'], 'only the week played against three people is paid');
  eq([await goldOf(pair.id) - before[0]!, await goldOf(wide.id) - before[1]!], [0, L.prizeFor(1)], 'and the two-opponent week gets nothing');
  const idle = await player('elig-idle');
  eq(await L.placeOf(pool, lastWeek, idle.id), { rank: null, earning: 0, opponents: 0, eligible: false }, 'a player who sat the week out has no line');

  // A room somebody sat down in and left before it started is not a table shared.
  const code = await room(new Date(mid), false);
  const sat = await player('elig-sat');
  await moved(sat.id, -1_000, 'stake', 't-stake:sat-1', new Date(mid), code);
  await moved(sat.id, 1_000, 'leave_refund', 't-refund:sat-1', new Date(mid), code);
  await moved(foes[2]!.id, -1_000, 'stake', 't-stake:sat-2', new Date(mid), code);
  await moved(foes[2]!.id, 1_000, 'leave_refund', 't-refund:sat-2', new Date(mid), code);
  eq((await L.placeOf(pool, lastWeek, sat.id)).opponents, 0, 'a room that never started makes nobody an opponent');
}

section('Gold whose loser has deleted their account is nobody’s');
{
  await reset();
  const mid = thisWeek.startsAt.getTime() + 3 * HOUR;
  const main = await player('gone-main'), stays = await player('gone-stays'), leaves = await player('gone-leaves');
  await match(main.id, [[stays.id, 5_000]], new Date(mid), 'gone-1');
  await match(main.id, [[leaves.id, 20_000]], new Date(mid + 60_000), 'gone-2');
  eq((await L.placeOf(pool, thisWeek, main.id)).earning, 25_000, 'two wins, from two people');
  await query(pool, 'DELETE FROM users WHERE id = $1', [leaves.id]);
  const after = await L.placeOf(pool, thisWeek, main.id);
  eq(after.earning, 5_000, 'the loser deletes their account, their stake goes with it, and so does the credit for it');
  eq(after.opponents, 1, 'and they are no longer an opponent');

  // The other way round: a winner who deletes their account does not wipe out what the loser lost.
  const winner = await player('gone-winner'), loser = await player('gone-loser');
  await match(winner.id, [[loser.id, 7_000]], new Date(mid + 120_000), 'gone-3');
  await query(pool, 'DELETE FROM users WHERE id = $1', [winner.id]);
  eq((await L.placeOf(pool, thisWeek, loser.id)).earning, -7_000, 'a loss to somebody since deleted is still a loss');
}

await finish();
