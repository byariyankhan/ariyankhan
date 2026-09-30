// A player's tour, and the one property that makes syncing it safe: nothing a device pushes can ever take
// something away. Two phones, opened in any order, converge on the better of what each has seen.
import { pool, query } from '../backend/src/db.js';
import { cleanDevice, cleanLevels, cleanState, cleanStats, cleanStreak, combineState, difficulty, levelIdOk, MAX_BLOB_BYTES, MAX_SERIALS, MAX_STAT_DEVICES, mergeLevels, mergeState, mergeStats, mergeStreak, nextDay, playedIn, readAll, readLevels, readState, STATE_KEEP_DAYS } from '../backend/src/progress.js';
import { deleteUser } from '../backend/src/auth.js';
import { boardIdSet, releasePlayer } from '../backend/src/rooms.js';
import { eq, finish, ok, player, reset, section } from './helpers.js';

await reset();

const rec = (o: Record<string, unknown> = {}) => ({ cleared: true, stars: 2, ms: 60_000, tier: 1, arrows: 40, quiz: false, ...o });

section('A board cleared on one device is on the account');
{
  const p = await player('progOne');
  await mergeLevels(pool, p.id, cleanLevels({ bd: rec({ stars: 3, ms: 42_000 }) }));
  const got = await readLevels(pool, p.id);
  eq(Object.keys(got).length, 1, 'one board is stored');
  eq(got.bd?.stars, 3, 'with its stars');
  eq(got.bd?.ms, 42_000, 'and its time');
  eq(got.bd?.cleared, true, 'marked cleared');
}

section('Pushing the same thing twice changes nothing the second time');
{
  const p = await player('progIdem');
  const batch = cleanLevels({ np: rec(), lk: rec({ stars: 1 }) });
  const first = await mergeLevels(pool, p.id, batch);
  const second = await mergeLevels(pool, p.id, batch);
  eq(first, 2, 'the first push moves both boards');
  eq(second, 0, 'the second moves nothing');
}

section('The better run wins, whichever order the two devices sync in');
{
  // The same board, played well on one phone and badly on the other.
  const good = { in: rec({ stars: 3, ms: 30_000, tier: 3 }) };
  const poor = { in: rec({ stars: 1, ms: 90_000, tier: 0 }) };

  const a = await player('progOrderA');
  await mergeLevels(pool, a.id, cleanLevels(good));
  await mergeLevels(pool, a.id, cleanLevels(poor));
  const afterA = await readLevels(pool, a.id);

  const b = await player('progOrderB');
  await mergeLevels(pool, b.id, cleanLevels(poor));
  await mergeLevels(pool, b.id, cleanLevels(good));
  const afterB = await readLevels(pool, b.id);

  eq(afterA.in?.stars, 3, 'good then poor keeps three stars');
  eq(afterA.in?.ms, 30_000, 'and the faster time');
  eq(afterB.in?.stars, 3, 'poor then good reaches three stars');
  eq(afterB.in?.ms, 30_000, 'and the same faster time');
  eq(afterA.in?.tier, afterB.in?.tier, 'both orders agree on the tier as well');
  ok(JSON.stringify({ ...afterA.in, at: 0 }) === JSON.stringify({ ...afterB.in, at: 0 }), 'the two orders land on the same record');
}

section('A stale device cannot undo a better run');
{
  const p = await player('progStale');
  await mergeLevels(pool, p.id, cleanLevels({ jp: rec({ stars: 3, ms: 25_000, quiz: true }) }));
  // an old phone, opened a month later, still remembers the first clumsy attempt
  const moved = await mergeLevels(pool, p.id, cleanLevels({ jp: rec({ stars: 0, ms: 300_000, quiz: false }) }));
  const got = await readLevels(pool, p.id);
  eq(moved, 0, 'the stale push reports that it moved nothing');
  eq(got.jp?.stars, 3, 'the stars stand');
  eq(got.jp?.ms, 25_000, 'the time stands');
  eq(got.jp?.quiz, true, 'and the quiz stays answered');
}

section('At equal stars the faster time wins');
{
  const p = await player('progTie');
  await mergeLevels(pool, p.id, cleanLevels({ fr: rec({ stars: 2, ms: 80_000 }) }));
  await mergeLevels(pool, p.id, cleanLevels({ fr: rec({ stars: 2, ms: 55_000 }) }));
  eq((await readLevels(pool, p.id)).fr?.ms, 55_000, 'the faster of two two-star runs');
}

section('More stars beats a faster time');
{
  // A three-star run that took longer is still the better result: stars are the goal, the clock is the tiebreak.
  const p = await player('progStars');
  await mergeLevels(pool, p.id, cleanLevels({ de: rec({ stars: 1, ms: 20_000 }) }));
  await mergeLevels(pool, p.id, cleanLevels({ de: rec({ stars: 3, ms: 70_000 }) }));
  const got = await readLevels(pool, p.id);
  eq(got.de?.stars, 3, 'three stars');
  eq(got.de?.ms, 70_000, 'and that run’s time, not the faster one-star time');
}

section('A skip unlocks without claiming a clear');
{
  const p = await player('progSkip');
  await mergeLevels(pool, p.id, cleanLevels({ mn: { skipped: true, cleared: false } }));
  const got = await readLevels(pool, p.id);
  eq(got.mn?.skipped, true, 'the skip is recorded');
  eq(got.mn?.cleared, false, 'and it does not say the board was cleared');
  // clearing it later turns the flag on without losing the skip
  await mergeLevels(pool, p.id, cleanLevels({ mn: rec({ stars: 2 }) }));
  const after = await readLevels(pool, p.id);
  eq(after.mn?.cleared, true, 'clearing it afterwards is recorded');
  eq(after.mn?.skipped, true, 'and the skip is still true');
}

section('Playing signed out, then signing in, keeps the play');
{
  // Nothing on the server yet: the whole tour arrives in one push, which is the first-sign-in case.
  const p = await player('progFirst');
  const tour: Record<string, unknown> = {};
  for (let i = 0; i < 84; i++) tour['c' + i] = rec({ stars: (i % 3) + 1, ms: 30_000 + i });
  const moved = await mergeLevels(pool, p.id, cleanLevels(tour));
  eq(moved, 84, 'all eighty-four boards go up');
  eq(Object.keys(await readLevels(pool, p.id)).length, 84, 'and are all on the account');
}

section('The settings blob merges rather than replaces');
{
  const p = await player('progState');
  await mergeState(pool, p.id, { home: 'bd', form: { tier: 2, wins: 1, losses: 0 } });
  // a second device that has never heard of `form` pushes only what it knows
  await mergeState(pool, p.id, { home: 'in' });
  const st = await readState(pool, p.id) as Record<string, unknown>;
  eq(st.home, 'in', 'the key it sent is updated');
  ok(!!st.form, 'and the key it did not send survives');
}

section('What a client sends is not what gets stored');
{
  const p = await player('progClean');
  const dirty = cleanLevels({
    ok: rec({ stars: 3 }),
    bad1: rec({ stars: 99 }),                                  // out of range
    bad2: rec({ ms: -5 }),                                     // impossible time
    bad3: rec({ ms: 9_000_000_000 }),                          // longer than a day on one board
    bad4: 'not an object',
    bad5: { cleared: false, skipped: false },                  // says nothing happened
    ['x'.repeat(200)]: rec(),                                  // a level id nobody could have
  });
  eq(dirty.bad1?.stars, 0, 'ninety-nine stars becomes zero');
  eq(dirty.bad2?.ms, null, 'a negative time becomes no time');
  eq(dirty.bad3?.ms, null, 'and so does a time longer than a day');
  ok(!('bad4' in dirty), 'a row that is not an object is dropped');
  ok(!('bad5' in dirty), 'a row claiming nothing happened is dropped');
  ok(!Object.keys(dirty).some(k => k.length > 64), 'an absurd level id is dropped');
  ok('ok' in dirty, 'and the good row in the same batch survives');

  await mergeLevels(pool, p.id, dirty);
  const stored = await readLevels(pool, p.id);
  ok(Object.values(stored).every(r => (r.stars ?? 0) <= 3 && (r.ms === null || (r.ms ?? 0) > 0)), 'nothing out of range reached the table');
}

section('The settings blob cannot become a filing cabinet');
{
  eq(cleanState({ a: 'x'.repeat(200_000) }), null, 'a blob far past anything a client sends is refused');
  eq(cleanState('not an object'), null, 'and so is something that is not an object');
  ok(!!cleanState({ home: 'bd' }), 'an ordinary one is fine');
  eq(cleanState({ home: 'bd', junk: 'x'.repeat(20_000) }), { home: 'bd' }, 'one oversized setting is dropped, not the whole blob');
}

// ── Two devices, one account: the records of play are merged, not overwritten ──
const today = new Date().toISOString().slice(0, 10);
// PostgreSQL keeps a jsonb object's keys in its own order, so these compare what a record holds, not its key order
const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, canon((v as Record<string, unknown>)[k])])) : v;
const same = (got: unknown, want: unknown, what: string) => eq(canon(got), canon(want), what);
const back = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

section('A board keeps the most arrows it has ever paid');
{
  // The rank is the sum of these. Cleared at Master on the phone (145 arrows), replayed faster at Easy on the
  // tablet (22): the replay is the better run and wins the time and the tier, and the arrows stay at 145.
  const p = await player('progArrows');
  await mergeLevels(pool, p.id, cleanLevels({ br: rec({ stars: 3, ms: 90_000, tier: 4, arrows: 145 }) }));
  const moved = await mergeLevels(pool, p.id, cleanLevels({ br: rec({ stars: 3, ms: 30_000, tier: 0, arrows: 22 }) }));
  const got = (await readLevels(pool, p.id)).br;
  eq(moved, 1, 'the faster replay is a better run and moves the row');
  eq(got?.ms, 30_000, 'its time is kept');
  eq(got?.tier, 0, 'with the tier it was cleared at');
  eq(got?.arrows, 145, 'and the arrows stay at the most the board ever paid');

  // The other way round: a worse run that paid more still raises the arrows, and only the arrows.
  const q = await player('progArrowsUp');
  await mergeLevels(pool, q.id, cleanLevels({ ar: rec({ stars: 3, ms: 20_000, tier: 0, arrows: 22 }) }));
  const up = await mergeLevels(pool, q.id, cleanLevels({ ar: rec({ stars: 1, ms: 200_000, tier: 4, arrows: 150 }) }));
  const after = (await readLevels(pool, q.id)).ar;
  eq(up, 1, 'a worse run that paid more arrows moves the row');
  eq(after?.arrows, 150, 'to the greater arrows');
  eq(after?.stars, 3, 'while the better run keeps its stars');
  eq(after?.ms, 20_000, 'its time');
  eq(after?.tier, 0, 'and its tier');
  eq(await mergeLevels(pool, q.id, cleanLevels({ ar: rec({ stars: 1, ms: 200_000, tier: 4, arrows: 150 }) })), 0, 'the same push again moves nothing');
  eq(await mergeLevels(pool, q.id, cleanLevels({ ar: rec({ stars: 3, ms: 20_000, tier: 0, arrows: 22 }) })), 0, 'nor does the first run pushed again');

  // Whichever order two devices sync in, they land on the same record.
  const a = await player('progArrowsA'), b = await player('progArrowsB');
  const hi = { x: rec({ stars: 2, ms: 60_000, arrows: 120 }) }, lo = { x: rec({ stars: 3, ms: 50_000, arrows: 40 }) };
  await mergeLevels(pool, a.id, cleanLevels(hi)); await mergeLevels(pool, a.id, cleanLevels(lo));
  await mergeLevels(pool, b.id, cleanLevels(lo)); await mergeLevels(pool, b.id, cleanLevels(hi));
  const ra = (await readLevels(pool, a.id)).x, rb = (await readLevels(pool, b.id)).x;
  ok(JSON.stringify({ ...ra, at: 0 }) === JSON.stringify({ ...rb, at: 0 }), 'both orders land on the same record');
  eq(ra?.arrows, 120, 'with the greater arrows');
  eq(ra?.stars, 3, 'and the better run');
}

section('A Master board is stored');
{
  // The fifth tier broke every push that carried one: the table said 0..3 and the whole batch failed.
  const p = await player('progMaster');
  const moved = await mergeLevels(pool, p.id, cleanLevels({ it: rec({ stars: 3, tier: 4 }), fr: rec({ tier: 2 }) }));
  eq(moved, 2, 'both boards of a batch that holds a Master board go up');
  eq((await readLevels(pool, p.id)).it?.tier, 4, 'and the Master board keeps its tier');
}

section('Daily training played on two devices is on both');
{
  const p = await player('progTrain');
  // the website played the Forgery, the phone the Curator's Eye, the same day
  await mergeState(pool, p.id, { train: { [today]: { f: 39, p: 1, pp: { f: 1 }, at: 1 } } });
  await mergeState(pool, p.id, { train: { [today]: { e: 100, p: 1, pp: { e: 1 }, nx: { e: 1 }, at: 2 } } });
  const st = await readState(pool, p.id) as Record<string, any>;
  eq(st.train?.[today]?.f, 39, 'the website’s round is still there after the phone pushed');
  eq(st.train?.[today]?.e, 100, 'and the phone’s is there too');
  same(st.train?.[today]?.pp, { f: 1, e: 1 }, 'each round’s plays are kept');
  eq(st.train?.[today]?.nx, { e: 1 }, 'and the new puzzles asked for');
  // the same round on both: the better score stands, whichever pushes last
  await mergeState(pool, p.id, { train: { [today]: { f: 20 } } });
  eq(((await readState(pool, p.id)) as Record<string, any>).train?.[today]?.f, 39, 'a worse score pushed later takes nothing away');
}

section('Training puzzles finished on two devices are all on the account, each with its first time');
{
  // every puzzle finished is a level on the main count, so a clear on the phone must reach the website
  const a = { train: { [today]: { r: 90, cl: { r: { '0': 1000, '1': 3000 } } } } };
  const b = { train: { [today]: { f: 40, cl: { r: { '1': 2000 }, f: { '0': 1500 } } } } };
  const ab = combineState(combineState({}, a), b) as Record<string, any>, ba = combineState(combineState({}, b), a);
  same(ab.train[today].cl, { r: { '0': 1000, '1': 2000 }, f: { '0': 1500 } }, 'the union of both, the earliest time of a puzzle both finished');
  same(ab, ba, 'in either order');
  same(combineState(ab, a), ab, 'and again changes nothing');
  const dirty = cleanState({ train: { [today]: { cl: { r: { '0': 5, x: 9, '12345': 9, '007': 9, '2': -1 }, z: { '0': 5 } } } } }) as Record<string, any>;
  same(dirty.train[today], { cl: { r: { '0': 5 } } }, 'a serial that is not a small number (or is written with a leading zero), a time that is not a time and a round that is not a round are dropped');
  const many = (from: number) => Object.fromEntries(Array.from({ length: MAX_SERIALS }, (_, i) => [String(from + i), 1000 + i]));
  const capped = combineState({ train: { [today]: { cl: { r: many(MAX_SERIALS / 2) } } } }, { train: { [today]: { cl: { r: many(0) } } } }) as Record<string, any>;
  eq(Object.keys(capped.train[today].cl.r).length, MAX_SERIALS, `the union of two full rounds keeps ${MAX_SERIALS} puzzles`);
  ok('0' in capped.train[today].cl.r && !(String(MAX_SERIALS) in capped.train[today].cl.r), 'the lowest of them, whichever device pushed first');
  const flood = cleanState({ train: { [today]: { cl: { r: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [String(i), 1000 + i])) } } } }) as Record<string, any>;
  eq(Object.keys(flood.train[today].cl.r).length, MAX_SERIALS, `two hundred puzzles of one round in one day are cut to ${MAX_SERIALS}, a believable day`);
  const p = await player('progClears');
  await mergeState(pool, p.id, a); await mergeState(pool, p.id, b);
  same(((await readState(pool, p.id)) as Record<string, any>).train?.[today]?.cl, { r: { '0': 1000, '1': 2000 }, f: { '0': 1500 } }, 'on the account as well');
}

section('Each round’s first score of the day is kept, the lower of two devices’');
{
  // the difficulty step reads the first finish of the free puzzle, so a replay learned by heart cannot climb it
  const a = { train: { [today]: { r: 95, f1: { r: 40, f: 90 } } } };
  const b = { train: { [today]: { r: 70, f1: { r: 70, g: 30 } } } };
  const ab = combineState(combineState({}, a), b) as Record<string, any>, ba = combineState(combineState({}, b), a);
  same(ab.train[today].f1, { r: 40, f: 90, g: 30 }, 'per round, the lower of the two');
  eq(ab.train[today].r, 95, 'while the day’s best is still the higher');
  same(ab, ba, 'in either order');
  same(combineState(ab, b), ab, 'and again changes nothing');
  const dirty = cleanState({ train: { [today]: { f1: { r: 49.6, f: 250, g: -1, e: 'x', z: 5 } } } }) as Record<string, any>;
  same(dirty.train[today], { f1: { r: 50 } }, 'a score that is not a score, and a round that is not a round, are dropped; a day with only a first score is still a day');
  eq((cleanState({ train: { [today]: { f1: 'x', r: 60 } } }) as Record<string, any>).train[today].f1, undefined, 'a first score that is not a map is dropped');
  const p = await player('progFirstScore');
  await mergeState(pool, p.id, a); await mergeState(pool, p.id, b);
  same(((await readState(pool, p.id)) as Record<string, any>).train?.[today]?.f1, { r: 40, f: 90, g: 30 }, 'on the account as well');
}

section('Streaks from two devices join up');
{
  eq(nextDay('2026-02-28'), '2026-03-01', 'the day after is a calendar day');
  eq(nextDay('2028-02-28'), '2028-02-29', 'leap years included');
  const s = (count: number, last: string) => ({ count, last });
  eq(mergeStreak(s(2, '2026-09-22'), s(1, '2026-09-23')), s(3, '2026-09-23'), 'the phone played two days, the website the next: three in a row');
  eq(mergeStreak(s(1, '2026-09-23'), s(2, '2026-09-22')), s(3, '2026-09-23'), 'in either order');
  eq(mergeStreak(s(3, '2026-09-23'), s(1, '2026-09-23')), s(3, '2026-09-23'), 'the same day: the longer count');
  eq(mergeStreak(s(5, '2026-09-18'), s(1, '2026-09-23')), s(1, '2026-09-23'), 'a gap between them: the later run alone');
  eq(mergeStreak(s(5, '2026-09-05'), s(6, '2026-09-08')), s(8, '2026-09-08'), 'the 1st to the 5th and the 3rd to the 8th overlap: eight days');
  eq(mergeStreak(s(6, '2026-09-08'), s(5, '2026-09-05')), s(8, '2026-09-08'), 'in either order');
  eq(mergeStreak(s(10, '2026-09-08'), s(2, '2026-09-05')), s(10, '2026-09-08'), 'a run inside a longer one adds nothing');
  eq(mergeStreak(s(3, '2026-03-01'), s(2, '2026-02-26')), s(5, '2026-03-01'), 'across the end of a month');
  eq(cleanStreak({ count: 3, last: '2099-01-01' }), undefined, 'a day from a clock that runs ahead is not a streak');
  eq(cleanStreak({ count: 0, last: today }), undefined, 'and neither is a run of no days');
  eq(mergeStreak(mergeStreak(s(2, '2026-09-22'), s(1, '2026-09-23')), s(2, '2026-09-22')), s(3, '2026-09-23'), 'merging again changes nothing');
  const p = await player('progStreak');
  await mergeState(pool, p.id, { playStreak: s(2, back(1)) });
  await mergeState(pool, p.id, { playStreak: s(1, today) });
  same(((await readState(pool, p.id)) as Record<string, any>).playStreak, s(3, today), 'on the account as well');
}

section('Streak freezes travel with the streak');
{
  const f = (count: number, last: string, freeze?: number) => (freeze ? { count, last, freeze } : { count, last });
  eq(cleanStreak({ count: 4, last: today, freeze: 1 }), f(4, today, 1), 'a freeze held is kept');
  eq(cleanStreak({ count: 4, last: today, freeze: 9 }), f(4, today, 2), 'two at most');
  eq(cleanStreak({ count: 4, last: today, freeze: -1 }), f(4, today), 'nothing that is not a count');
  eq(cleanStreak({ count: 4, last: today, freeze: 0 }), f(4, today), 'and none held is no field at all, as a streak always read');
  eq(mergeStreak(f(2, '2026-09-20', 1), f(4, '2026-09-23')), f(5, '2026-09-23'), 'the device that played later spent it: none held, the run joined');
  eq(mergeStreak(f(5, '2026-09-23'), f(3, '2026-09-23', 2)), f(5, '2026-09-23', 2), 'the same last day: the more held');
  eq(mergeStreak(f(3, '2026-09-10', 2), f(1, '2026-09-23')), f(1, '2026-09-23'), 'a later streak on a device that never heard of them: the later day decides');
  const runs = [f(2, '2026-09-20', 1), f(4, '2026-09-23'), f(3, '2026-09-23', 2), f(6, '2026-09-22', 1), f(1, '2026-09-18', 2)];
  for (const a of runs) for (const b of runs) {
    const ab = mergeStreak(a, b);
    same(ab, mergeStreak(b, a), `order does not matter: ${JSON.stringify([a, b])}`);
    same(mergeStreak(ab, a), ab, `merging again changes nothing: ${JSON.stringify([a, b])}`);
  }
  const p = await player('progFreeze');
  await mergeState(pool, p.id, { playStreak: f(6, back(2), 1) });
  await mergeState(pool, p.id, { playStreak: f(8, today) });
  same(((await readState(pool, p.id)) as Record<string, any>).playStreak, f(8, today), 'on the account: the phone came back after a missed day and spent the freeze');
  await mergeState(pool, p.id, { playStreak: f(8, today, 1) });
  same(((await readState(pool, p.id)) as Record<string, any>).playStreak, f(8, today, 1), 'and the website earned one the same day');
}

section('What counts as having played, for the evening nudge');
{
  const was = { train: { [today]: { r: 60, p: 1, pp: { r: 1 }, at: 5 } }, playStreak: { count: 2, last: today }, home: 'BD' };
  const again = combineState(was, { train: { [today]: { at: 5, pp: { r: 1 }, p: 1, r: 60 } }, playStreak: { count: 1, last: today }, home: 'IN' });
  ok(!playedIn(was, again), 'the same records sent back again, in another order, and a setting changed: not play');
  ok(playedIn(was, combineState(was, { train: { [today]: { r: 60, f: 40 } } })), 'a round scored is');
  ok(playedIn(was, combineState(was, { playStreak: { count: 3, last: today, freeze: 1 } })), 'a freeze earned is');
  ok(playedIn(was, combineState(was, { loss: { dev1: 12 } })), 'a board lost is');
  ok(playedIn({}, combineState({}, { daily: { [today]: { t: 50_000, stars: 2 } } })), 'a daily board is');
}

section('The daily board, the rank and the settings merge by their own rules');
{
  const p = await player('progDaily');
  await mergeState(pool, p.id, { daily: { [today]: { t: 90_000, stars: 2, quiz: true, tier: 2, arrows: 80, at: 1 } }, loss: { phone1: 40 }, home: 'bd' });
  await mergeState(pool, p.id, { daily: { [today]: { t: 60_000, stars: 2, quiz: false, tier: 2, arrows: 80, at: 2 }, [back(1)]: { t: 70_000, stars: 3, tier: 1, arrows: 60, at: 3 } }, loss: { web1: 12, phone1: 10 }, home: 'in' });
  const st = await readState(pool, p.id) as Record<string, any>;
  eq(st.daily?.[today]?.t, 60_000, 'the faster run of two with the same stars');
  eq(st.daily?.[today]?.quiz, true, 'and the quiz stays answered');
  eq(st.daily?.[back(1)]?.stars, 3, 'a day only one device played arrives');
  same(st.loss, { phone1: 40, web1: 12 }, 'each device’s count kept, the larger of two for the same device');
  eq(st.home, 'in', 'a setting: the last device to say it wins');
}

section('Two devices land on the same account whichever pushes first');
{
  const a = { train: { [today]: { r: 88, h: 1, p: 2, pp: { r: 2 } } }, playStreak: { count: 4, last: back(1) }, loss: { dev1: 5 }, daily: { [today]: { t: 50_000, stars: 1, at: 1 } } };
  const b = { train: { [today]: { r: 70, g: 90, p: 1, pp: { g: 1 } }, [back(2)]: { e: 55 } }, playStreak: { count: 1, last: today }, loss: { dev2: 9 }, daily: { [today]: { t: 80_000, stars: 3, at: 2 } } };
  const ab = combineState(combineState({}, a), b), ba = combineState(combineState({}, b), a);
  same(ab, ba, 'A then B is B then A');
  same(combineState(ab, a), ab, 'and pushing A again changes nothing');
  eq((ab as any).train[today], { r: 88, g: 90, h: 1, p: 2, pp: { r: 2, g: 1 } }, 'the day holds the best of both');
  eq((ab as any).playStreak, { count: 5, last: today }, 'the streaks joined');
  eq((ab as any).daily[today].stars, 3, 'the three-star daily run, though slower');
}

section('What the account keeps is cleaned and kept in bounds');
{
  const devs: Record<string, number> = {};
  for (let i = 0; i < 300; i++) devs['dev' + i] = 1 + i;
  const lossKept = (combineState({ loss: devs }, { loss: { freshPhone: 5000 } }) as Record<string, any>).loss;
  eq(Object.keys(lossKept).length, 256, 'the rank remembers a bounded number of devices');
  eq(lossKept.freshPhone, 5000, 'and a new device still gets in');
  ok(!('dev0' in lossKept), 'making room by the smallest, a device long gone');
  same(combineState({ loss: { freshPhone: 5000 } }, { loss: devs }), combineState({ loss: devs }, { loss: { freshPhone: 5000 } }), 'the same devices survive whichever pushed first');
  const many: Record<string, unknown> = {};
  for (let i = 0; i < STATE_KEEP_DAYS + 100; i++) { const d = new Date(); d.setUTCDate(d.getUTCDate() - i); many[d.toISOString().slice(0, 10)] = { t: 60_000, stars: 1 }; }
  const kept = Object.keys((combineState({ daily: many }, {}) as Record<string, any>).daily).sort();
  eq(kept.length, STATE_KEEP_DAYS, 'the account keeps a bounded number of days');
  eq(kept[kept.length - 1], today, 'the newest of them');
  const st = cleanState({
    train: { '2019-01-01': { r: 90 }, '2099-01-01': { r: 90 }, '2026-02-30': { r: 90 }, 'not-a-day': { r: 90 }, [today]: { r: 250, f: 'x', g: 70, pp: { g: -3, e: 2 } } },
    daily: { [today]: { stars: 3 } },
    playStreak: { count: -1, last: today }, dailyStreak: { count: 2, last: 'yesterday' },
    loss: { 'a b': 5, ok1: 7, neg: -2 },
  }) as Record<string, any>;
  eq(Object.keys(st.train).sort(), ['2019-01-01', today], 'an old day is kept (the rank and the goals count every one); a future day, an impossible date or no day at all is dropped');
  eq(st.train[today], { g: 70, pp: { e: 2 } }, 'an impossible score or count is dropped, the rest of the day kept');
  ok(!('daily' in st), 'a daily board with no time is not a run');
  ok(!('playStreak' in st) && !('dailyStreak' in st), 'a streak with a negative count or no date is dropped');
  eq(st.loss, { ok1: 7 }, 'and only a real device with a real count stays in the rank');
}

section('Deleting the account takes the tour with it');
{
  const p = await player('progGone');
  await mergeLevels(pool, p.id, cleanLevels({ es: rec(), pt: rec() }));
  eq(Object.keys(await readLevels(pool, p.id)).length, 2, 'two boards to start with');
  await deleteUser(p.id, releasePlayer);   // the same call the delete route makes
  const left = await query<{ n: number }>(pool, 'SELECT COUNT(*)::int AS n FROM progress WHERE user_id = $1', [p.id]);
  eq(left.rows[0]!.n, 0, 'and none afterwards');
}

section('One read hands a device everything it needs');
{
  const p = await player('progAll');
  await mergeLevels(pool, p.id, cleanLevels({ it: rec({ stars: 3 }) }));
  await mergeState(pool, p.id, { home: 'bd' });
  const all = await readAll(pool, p.id);
  eq(all.levels.it?.stars, 3, 'the boards');
  eq((all.state as Record<string, unknown>).home, 'bd', 'and the settings, in one answer');
}

section('What a board costs is counted per device, and only ever grows');
{
  eq(cleanDevice('ab12cd34ef'), 'ab12cd34ef', 'a device id is letters and digits');
  eq(cleanDevice('x'), '', 'too short is nothing');
  eq(cleanDevice('a b c d e'), '', 'and so is anything with a space in it');
  const st = cleanStats({ bd: { p: 5, c: 2, f: 3, h: 4, l: 3, ms: 240_000 }, np: { p: 0, c: 0, f: 0 }, junk: 'no', lk: { plays: 2, clears: 1, fails: 1, hints: 0, hearts: 1, ms: 90_000 } });
  eq(Object.keys(st).sort(), ['bd', 'lk'], 'a board with nothing counted is dropped, and so is junk');
  eq(st.bd, { plays: 5, clears: 2, fails: 3, hints: 4, hearts: 3, ms: 240_000 }, 'the short keys the client sends are read');
  eq(st.lk?.plays, 2, 'and the long ones');
  eq(cleanStats({ bd: { p: -1, c: 99_999_999 } }).bd, undefined, 'a negative count or an absurd one is not a count');

  const p = await player('statsOne');
  eq(await mergeStats(pool, p.id, 'phone1', st), 2, 'the first post lands both boards');
  eq(await mergeStats(pool, p.id, 'phone1', st), 0, 'the same totals again change nothing');
  eq(await mergeStats(pool, p.id, 'phone1', cleanStats({ bd: { p: 6, c: 3, f: 3, h: 4, l: 3, ms: 300_000 } })), 1, 'bigger totals from the same phone replace');
  eq(await mergeStats(pool, p.id, 'phone1', cleanStats({ bd: { p: 1, c: 1, f: 0, h: 0, l: 0, ms: 1 } })), 0, 'smaller ones -- a phone that was reset -- never take anything away');
  eq(await mergeStats(pool, p.id, 'phone2', cleanStats({ bd: { p: 4, c: 0, f: 4, h: 0, l: 0, ms: 0 } })), 1, 'a second phone on the same account is a second row');

  const q = await player('statsTwo');
  await mergeStats(pool, q.id, 'tab', cleanStats({ bd: { p: 2, c: 2, f: 0, h: 0, l: 0, ms: 100_000 }, lk: { p: 3, c: 0, f: 3, h: 0, l: 0, ms: 0 } }));
  const d = await difficulty(pool, 1);
  const bd = d.find(x => x.level_id === 'bd')!, lk = d.find(x => x.level_id === 'lk')!;
  eq([bd.players, bd.plays, bd.clears, bd.fails], [2, 12, 5, 7], 'the view adds every device of every player');
  eq(bd.fail_rate, 0.583, 'and says how often the board wins');
  eq(bd.hints_per_clear, 0.8, 'what a clear costs in hints');
  eq(bd.seconds_per_clear, 80, 'and how long one takes');
  eq([lk.players, lk.fail_rate, lk.seconds_per_clear], [2, 0.8, 90], 'a board of two players, one of whom never cleared it');
  eq(d[0]?.level_id, 'lk', 'ordered hardest first');
  eq((await difficulty(pool, 3)).length, 0, 'and a floor on players keeps small numbers from posing as facts');

  await query(pool, `DELETE FROM users WHERE id = $1`, [q.id]);
  eq((await difficulty(pool, 1)).find(x => x.level_id === 'lk')?.players ?? 0, 1, 'a deleted account takes its counts with it');
}

section('Only boards of the game are synced');
{
  // A push could carry six hundred invented ids a time, and every one became a row on the account and in the
  // public difficulty table. What the route keeps now is what could be a board.
  const countries = await boardIdSet();
  ok(countries.size >= 190 && countries.has('050'), `the country list is the one the server deals from (${countries.size} boards)`);
  for (const id of ['050', 'd:050', 'f:brain', 's:diamond', 's:diamond~2', 'n:anything_1']) ok(levelIdOk(id, countries), `${id} is a board`);
  for (const id of ['bd', 'c1', 'pace-board', 'd:999', 'd:bd', 's:diamond~0', 's:diamond~x', 'z:foo', 'f:', 'f:a b', '0500', 'x'.repeat(65)]) ok(!levelIdOk(id, countries), `${JSON.stringify(id.slice(0, 20))} is not`);
  ok(levelIdOk('999', new Set()) && !levelIdOk('abc', new Set()), 'with no list to read, a country is three digits');
  const known = (id: string) => levelIdOk(id, countries);
  eq(Object.keys(cleanLevels({ '050': rec(), junk1: rec(), 's:tower~3': rec() }, known)).sort(), ['050', 's:tower~3'], 'a push keeps its real boards and drops the rest');
  eq(Object.keys(cleanStats({ '050': { p: 1 }, junk1: { p: 1 } }, known)), ['050'], 'and so do its counts');
}

section('An account holds a bounded number of boards');
{
  const p = await player('progRows');
  eq(await mergeLevels(pool, p.id, cleanLevels({ a1: rec(), a2: rec(), a3: rec() }), 5), 3, 'under the line, every new board lands');
  const moved = await mergeLevels(pool, p.id, cleanLevels({ a1: rec({ stars: 3, ms: 10_000 }), b1: rec(), b2: rec(), b3: rec(), b4: rec() }), 5);
  eq(moved, 3, 'at the line, the board already held still improves and only the room left is filled');
  const got = await readLevels(pool, p.id);
  eq(Object.keys(got).length, 5, 'so the account stops at its line');
  eq(got.a1?.stars, 3, 'and the better run on a board it had was taken');
  eq(await mergeLevels(pool, p.id, cleanLevels({ c1: rec() }), 5), 0, 'a new board past the line is dropped');
}

section('An account keeps the counts of a bounded number of devices');
{
  const p = await player('progDevices');
  for (let i = 0; i < MAX_STAT_DEVICES; i++) {
    await mergeStats(pool, p.id, `dev${String(i).padStart(2, '0')}`, cleanStats({ '050': { p: 1, c: 1, ms: 30_000 } }));
    await query(pool, `UPDATE level_stats SET updated_at = now() - ($2 || ' minutes')::interval WHERE user_id = $1 AND device = $3`,
      [p.id, String(MAX_STAT_DEVICES - i), `dev${String(i).padStart(2, '0')}`]);
  }
  await mergeStats(pool, p.id, 'freshPhone', cleanStats({ '050': { p: 2, c: 1, ms: 30_000 } }));
  const devs = (await query<{ device: string }>(pool, `SELECT DISTINCT device FROM level_stats WHERE user_id = $1`, [p.id])).rows.map(r => r.device);
  eq(devs.length, MAX_STAT_DEVICES, `a new device past ${MAX_STAT_DEVICES} does not grow the account`);
  ok(devs.includes('freshPhone') && !devs.includes('dev00'), 'it takes the place of the one heard from least recently');
  eq(cleanStats({ '050': { p: 50_000, c: 1 } })['050']?.plays, 0, 'and a count past anything believable is not a count');
  eq(cleanStats({ '050': { p: 3, c: 1, ms: 9_000_000 } })['050']?.ms, 0, 'nor more than an hour a clear');
}

section('The settings blob the account keeps is bounded, the oldest days going first');
{
  const heavy: Record<string, unknown> = {};
  const cl = Object.fromEntries(Array.from({ length: MAX_SERIALS }, (_, i) => [String(i), 1_700_000_000_000 + i]));
  for (let i = 0; i < 200; i++) heavy[back(i)] = { r: 90, f: 80, g: 70, e: 60, cl: { r: cl, f: cl, g: cl, e: cl } };
  const merged = combineState({ train: heavy }, { train: { [today]: { r: 99 } } }) as Record<string, any>;
  const size = JSON.stringify(merged).length;
  ok(size <= MAX_BLOB_BYTES, `a year of the heaviest training there could be is kept under ${MAX_BLOB_BYTES / 1024} KB (${Math.round(size / 1024)} KB)`);
  ok(today in merged.train && merged.train[today].r === 99, 'today is kept');
  ok(!(back(199) in merged.train), 'and what made room was the oldest days');
  // What a script would do: a few different days in every push, each one under the per-push limit.
  const p = await player('progBlob');
  const days = Object.keys(heavy).sort();
  for (let i = 0; i < days.length; i += 5) await mergeState(pool, p.id, { train: Object.fromEntries(days.slice(i, i + 5).map(d => [d, heavy[d]])) });   // each push under its own limit
  const stored = JSON.stringify(await readState(pool, p.id)).length;
  ok(stored <= MAX_BLOB_BYTES && stored > MAX_BLOB_BYTES / 2, `and so is what the account stores, however many pushes it took (${Math.round(stored / 1024)} KB)`);
}

await finish();
