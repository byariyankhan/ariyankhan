// The interstitial's rules, tested against the production code: the block is lifted out of js/puzzle.js by
// its own markers and run with stand-ins for the game around it, so what is tested is the exact code that
// ships, not a copy of it.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const js = readFileSync(new URL('../js/puzzle.js', import.meta.url), 'utf8');
const start = js.indexOf('  const INTER_NAME = ');
const end = js.indexOf('\n  }\n', js.indexOf('function adH5Next(name)')) + 4;
assert.ok(start > 0 && end > start, 'the interstitial block is where it was');
const block = js.slice(start, end);

function sandbox({ mode = 'h5', give = 'ad', daily = null, breakStatus = 'shown' } = {}) {
  const mem = new Map();
  const store = { get: (k, fb) => mem.has(k) ? mem.get(k) : fb, set: (k, v) => mem.set(k, v) };
  const ads = { mode, give, showing: false, last: null, on() { return this.mode !== 'off'; }, isAd() { return this.give === 'ad'; } };
  const state = { daily };
  const music = { on: false };
  const notes = [];
  const win = {
    adBreak(o) {
      // the library's shapes: a shown break fires beforeAd, afterAd, then adBreakDone; an empty one fires only adBreakDone
      if (breakStatus === 'shown') { o.beforeAd(); o.afterAd(); o.adBreakDone({ breakStatus: 'viewed' }); }
      else o.adBreakDone({ breakStatus });
    },
  };
  const src = `
    const window = win; const performance = { now: () => Date.now() };
    const musicStop = () => {}; const adTestShow = async () => 'watched';
    function adNote(name, how, why, ms) { notes.push({ name, how, why }); if (name !== INTER_NAME && how !== 'unavailable') inter.rewardAt = Date.now(); }
    ${block}
    return { inter, interDue, interShow, interCount, adNote, INTER_EVERY, INTER_GAP_MS, INTER_WARMUP_MS, INTER_AFTER_REWARD_MS, INTER_RETRY_MS };`;
  const api = new Function('win', 'store', 'ads', 'state', 'music', 'notes', src)(win, store, ads, state, music, notes);
  return { ...api, ads, state, store, notes, mem };
}

test('an interstitial is due on the fourth clear, after the first minute, and not before', async () => {
  const s = sandbox();
  for (let i = 0; i < 3; i++) s.interCount();
  s.inter.since = Date.now() - s.INTER_WARMUP_MS - 1;
  assert.equal(s.interDue(), false, 'three clears are not four');
  s.interCount();
  assert.equal(s.interDue(), true, 'four clears, a minute in: due');
  s.inter.since = Date.now();
  assert.equal(s.interDue(), false, 'not in the first minute of a session');
});

test('never in a challenge, never in free mode, never right after a rewarded advertisement', () => {
  const ready = (o = {}) => { const s = sandbox(o); for (let i = 0; i < 4; i++) s.interCount(); s.inter.since = Date.now() - s.INTER_WARMUP_MS - 1; return s; };
  assert.equal(ready().interDue(), true);
  assert.equal(ready({ daily: { race: true } }).interDue(), false, 'a challenge is not interrupted');
  assert.equal(ready({ give: 'free' }).interDue(), false, 'free lifelines mean no advertisements at all');
  assert.equal(ready({ mode: 'off' }).interDue(), false, 'off is off');
  const s = ready();
  s.adNote('heart', 'watched', '', 0);          // the player just watched one for a heart
  assert.equal(s.interDue(), false, 'not within two minutes of a rewarded one');
  s.inter.rewardAt = Date.now() - s.INTER_AFTER_REWARD_MS - 1;
  assert.equal(s.interDue(), true, 'two minutes later it may');
  s.adNote('next-board', 'shown', '', 0);
  assert.equal(s.interDue(), true, 'an interstitial of its own does not count as a rewarded one');
});

test('a shown break resets the count and starts the three-minute gap', async () => {
  const s = sandbox();
  for (let i = 0; i < 4; i++) s.interCount();
  s.inter.since = Date.now() - s.INTER_WARMUP_MS - 1;
  assert.equal(await s.interShow(), true, 'shown');
  assert.equal(s.inter.clears, 0, 'the count starts again');
  assert.equal(s.mem.get('interClears'), 0, 'and is remembered as zero');
  for (let i = 0; i < 4; i++) s.interCount();
  assert.equal(s.interDue(), false, 'four more clears inside the gap do not earn another');
  s.inter.lastAt = Date.now() - s.INTER_GAP_MS - 1;
  assert.equal(s.interDue(), true, 'after the gap they do');
  assert.equal(s.ads.showing, false, 'the showing flag is put back');
});

test('a break with nothing to show keeps the count and waits two minutes before asking again', async () => {
  const s = sandbox({ breakStatus: 'noAdPreloaded' });
  for (let i = 0; i < 4; i++) s.interCount();
  s.inter.since = Date.now() - s.INTER_WARMUP_MS - 1;
  assert.equal(await s.interShow(), false, 'nothing shown');
  assert.equal(s.inter.clears, 4, 'the clears are still owed');
  assert.equal(s.interDue(), false, 'but the next Next does not ask again at once');
  assert.equal(s.notes.at(-1).why, 'noAdPreloaded', 'and the developer line says why');
  s.inter.retryAt = 0;
  assert.equal(s.interDue(), true, 'two minutes on it asks again');
});

test('the test mode stands in for the library with the same promise', async () => {
  const s = sandbox({ mode: 'test' });
  for (let i = 0; i < 4; i++) s.interCount();
  s.inter.since = Date.now() - s.INTER_WARMUP_MS - 1;
  assert.equal(await s.interShow(), true);
  assert.equal(s.inter.clears, 0);
});

test('when it is not due, interShow resolves at once and shows nothing', async () => {
  const s = sandbox();
  assert.equal(await s.interShow(), false);
  assert.equal(s.notes.length, 0, 'the library was not asked');
});
