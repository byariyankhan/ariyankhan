// Daily Training: the count-in, the holds, the hint, the clear at 50, the first score, the day's paintings,
// the lies that show and the room's last three seconds -- the exact production code, pulled out of js/puzzle.js.
// Run: node tests/puzzle-train.test.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
const root = path.resolve(new URL('.', import.meta.url).pathname, '..');
const js = fs.readFileSync(path.join(root, 'js/puzzle.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css/puzzle.css'), 'utf8');
const grab = re => { const m = js.match(re); if (!m) throw new Error('could not find ' + re); return m[0]; };
const fn = name => grab(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n  \\}\\n`));
const one = name => grab(new RegExp(`const ${name} = [^\\n]+`));
let tests = 0;
const test = (name, f) => { tests++; try { f(); console.log('  ✓ ' + name); } catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; } };
// a store over a plain map, the way store.get/set sit over localStorage (prefix aa:v1:)
const makeStore = () => {
  const m = new Map();
  const localStorage = { get length() { return m.size; }, key: i => [...m.keys()][i] };
  const ls = new Proxy(localStorage, { ownKeys: () => [...m.keys()], getOwnPropertyDescriptor: (_, k) => m.has(k) ? { enumerable: true, configurable: true, value: m.get(k) } : undefined });
  const store = { get: (k, d = null) => m.has('aa:v1:' + k) ? JSON.parse(m.get('aa:v1:' + k)) : d, set: (k, v) => m.set('aa:v1:' + k, JSON.stringify(v)) };
  return { m, ls, store };
};
const common = [one('clamp100'), grab(/const TRAIN_ROUNDS = \[[\s\S]*?\n  \];/).replace(/how: \[[^\]]*\]/g, 'how: []'), one('dayKeyOf'), one('dayKey'), one('dayKeyBack'), one('trainKey'), one('trainDay'), one('trainFirst'), one('trainCleared'), one('trainLegacy'), one('trainLegacyAt'), grab(/const trainMergeF1 = [\s\S]*?\n  \};/)].join('\n');
const TODAY = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const BACK = n => { const d = new Date(); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

test('the tier reads each day\'s first score of its free puzzle, not a best pushed up by replays', () => {
  const { m, ls, store } = makeStore();
  const f = new Function('store', 'localStorage', 'STORE', common + '\n' + one('TRAIN_TIERS') + '\n' + fn('trainTier') + '\nreturn { trainTier };')(store, ls, 'aa:v1:');
  for (let i = 1; i <= 3; i++) m.set('aa:v1:train:' + BACK(i), JSON.stringify({ r: 95, f1: { r: 40 }, g: 90 }));
  assert.equal(f.trainTier('r'), 0, 'three days of 95 best but 40 first: stays at the bottom');
  assert.equal(f.trainTier('g'), 3, 'a day kept before first scores were is read by its best, as before');
  m.set('aa:v1:train:' + TODAY(), JSON.stringify({ r: 100, f1: { r: 100 } }));
  assert.equal(f.trainTier('r'), 0, 'today never counts');
});
test('first scores merge by the lower per round: commutative, idempotent, junk dropped', () => {
  const { trainMergeF1 } = new Function(common + '\nreturn { trainMergeF1 };')();
  const a = { r: 40, f: 90 }, b = { r: 70, g: 30, e: 'x', z: 5 };
  assert.deepEqual(trainMergeF1(a, b), { r: 40, f: 90, g: 30 });
  assert.deepEqual(trainMergeF1(a, b), trainMergeF1(b, a));
  assert.deepEqual(trainMergeF1(trainMergeF1(a, b), b), trainMergeF1(a, b));
  assert.deepEqual(trainMergeF1(undefined, { r: 250 }), { r: 100 });
  assert.deepEqual(trainMergeF1(null, null), {});
});
test('a finish under 50 is kept and is not a clear; 50 is; the first score of the free puzzle stays the first', () => {
  const { m, ls, store } = makeStore();
  const env = { store, localStorage: ls, STORE: 'aa:v1:', train: { day: '', serial: 0 }, renderTrainPill() {}, renderBrain() {}, forgetNums() {}, syncTour: () => Promise.resolve(), syncOwed: false };
  const f = new Function(...Object.keys(env), common + '\n' + grab(/const TRAIN_PASS = \d+;/) + '\n' + fn('trainSave') + '\n' + fn('trainClearTimes') + '\nreturn { trainSave, trainClearTimes, TRAIN_PASS };')(...Object.values(env));
  assert.equal(f.TRAIN_PASS, 50);
  env.train.day = TODAY();
  assert.equal(f.trainSave('e', 30), false, 'a 30 is no clear');
  let t = JSON.parse(m.get('aa:v1:train:' + TODAY()));
  assert.equal(t.e, 30); assert.deepEqual(t.f1, { e: 30 }); assert.ok(!(t.cl && t.cl.e), 'no clear written');
  assert.equal(f.trainClearTimes().length, 0, 'and it is no level on the main count');
  assert.equal(f.trainSave('e', 49.4), false, '49 is still under');
  assert.equal(f.trainSave('e', 80), true, 'the replay at 80 clears it');
  t = JSON.parse(m.get('aa:v1:train:' + TODAY()));
  assert.equal(t.e, 80); assert.equal(t.f1.e, 30, 'the first score stays the first'); assert.ok('0' in t.cl.e);
  assert.equal(f.trainSave('e', 100), false, 'played again: never a second clear');
  assert.equal(f.trainClearTimes().length, 1);
  // a day from before clears were kept still counts its free puzzle, and a new save there keeps it
  m.set('aa:v1:train:' + BACK(2), JSON.stringify({ r: 20, g: 90 }));
  assert.equal(f.trainClearTimes().length, 3, 'legacy rounds are clears, whatever they scored');
  // the Play next serial: no first score from it
  env.train.serial = 1; assert.equal(f.trainSave('f', 60), true);
  t = JSON.parse(m.get('aa:v1:train:' + TODAY())); assert.ok(!('f' in t.f1), 'serial 1 is not the free puzzle'); assert.ok('1' in t.cl.f);
});
test('artPatch: a separate vertical fraction, so a square close-up of a wide or tall painting is not squashed', () => {
  const { artPatch } = new Function(one('artPatch') + '\nreturn { artPatch };')();
  const style = artPatch({ file: 'x.jpg' }, 0.1, 0.2, 0.25, '', '', '', 0.5);
  assert.match(style, /background-size:400\.00% 200\.00%/);
  assert.match(style, /background-position:13\.33% 40\.00%/);
  assert.match(artPatch({ file: 'x.jpg' }, 0.1, 0.2, 0.25), /background-size:400\.00% 400\.00%/, 'the Forgery keeps one fraction');
});
// a sample image: W x H pixels from a colour function
const img = (W, H, px) => { const d = new Uint8ClampedArray(W * H * 4); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const [r, g, b] = px(x, y); d.set([r, g, b, 255], (y * W + x) * 4); } return { W, H, d }; };
const lieSrc = [fn('patchPix'), one('patchSd'), one('patchDiff'), fn('patchHue'), fn('lieSeen'), grab(/const LIE_SEEN = [^\n]+/), fn('forgeLies'), grab(/const DETAIL_SEEN = [^\n]+/), fn('curatorPatch'), grab(/function mulberry32[^\n]+/)].join('\n');
const L = new Function(lieSrc + '\nreturn { patchPix, patchSd, patchDiff, patchHue, lieSeen, forgeLies, curatorPatch, mulberry32, LIE_SEEN, DETAIL_SEEN };')();
test('a lie on a plain wall cannot be seen; on a painted one it can', () => {
  const flat = img(48, 64, () => [120, 120, 120]);
  const busy = img(48, 64, (x, y) => [(x * 37 + y * 11) % 256, (x * 13 + y * 29) % 256, (x * 7 + y * 53) % 256]);
  const q = { px: 0.3, py: 0.3, from: { px: 0.7, py: 0.7 } };
  for (const k of [0, 1, 2]) assert.ok(L.lieSeen(flat, q, k, 0.2, 45) < 1e-6, `kind ${k} on grey`);
  for (const k of [0, 1, 2]) assert.ok(L.lieSeen(busy, q, k, 0.2, 45) >= L.LIE_SEEN[k], `kind ${k} on a painted patch`);
  assert.equal(L.patchSd(L.patchPix(flat, 0.2, 0.2, 0.3)), 0);
  // the recolouring matrix leaves grey alone and moves red
  assert.deepEqual(L.patchHue([[100, 100, 100]], 45)[0].map(Math.round), [100, 100, 100]);
  assert.ok(L.patchDiff([[200, 40, 40]], L.patchHue([[200, 40, 40]], 45)) > 20);
});
test('the forgery\'s lies: apart, visible where the painting allows, "from elsewhere" at least 1.5 patches away', () => {
  // the top half plain grey, the bottom half painted: a mirrored or recoloured lie goes where it can be seen
  // (a patch from elsewhere may cover the grey: a painted patch on a plain wall is plain to see)
  const half = img(48, 64, (x, y) => y < 32 ? [100, 100, 100] : [(x * 37 + y * 11) % 256, (x * 13 + y * 29) % 256, (x * 7 + y * 53) % 256]);
  for (let seed = 1; seed <= 40; seed++) {
    const s = 0.13 + (seed % 5) * 0.015, lies = L.forgeLies(half, L.mulberry32(seed), 3 + seed % 3, s, 40);
    assert.equal(lies.length, 3 + seed % 3, 'every lie placed');
    lies.forEach((q, i) => {
      assert.ok(q.px >= 0.05 && q.px <= 0.95 - s + 1e-9 && q.py >= 0.05 && q.py <= 0.95 - s + 1e-9, 'inside the frame');
      if (q.from) assert.ok(Math.hypot(q.from.px - q.px, q.from.py - q.py) >= 1.5 * s - 1e-9, 'from far enough');
      for (const o of lies.slice(i + 1)) assert.ok(Math.abs(o.px - q.px) > s * 1.2 || Math.abs(o.py - q.py) > s * 1.2, 'apart');
      if (!q.from) assert.ok(q.py + s > 0.5 - 1e-9, `seed ${seed}: lie ${i} sits on the plain half`);
    });
    assert.equal(lies[0].extra, 'transform:scaleX(-1)'); assert.match(lies[1].extra, /hue-rotate\(40deg\)/); if (lies[2]) assert.ok(lies[2].from);
  }
  // no canvas to read: every spot will do, and the lies are still placed
  assert.equal(L.forgeLies(null, L.mulberry32(3), 5, 0.13, 25).length, 5);
});
test('the curator\'s close-ups are square on the painting and inside it', () => {
  const rnd = L.mulberry32(9);
  for (const [w, h] of [[800, 520], [520, 800], [800, 800], [1000, 400]]) {
    const c = L.curatorPatch({ w, h }, 0.34, rnd, null);
    assert.ok(Math.abs(c.s * w - c.sy * h) < 1e-6, `${w}x${h}: square in pixels`);
    assert.ok(c.sy <= 0.9 + 1e-9 && c.px + c.s <= 0.95 + 1e-9 && c.py + c.sy <= 0.95 + 1e-9 && c.px >= 0.05 && c.py >= 0.05, `${w}x${h}: inside`);
  }
});
test('the day\'s paintings: no painting twice in a day while the gallery has others; a puzzle hangs the same ones every time', () => {
  const works = Array.from({ length: 247 }, (_, i) => ({ id: 'w' + i }));
  const env = { store: { get: () => '' }, artRanked: () => works.slice(), trainDays: () => 1, tierParams: () => ({ n: 6 }) };
  const src = [grab(/function mulberry32[^\n]+/), one('hashStr'), one('shuffleBy'), grab(/let artDayMemo = null;/), fn('artDay'), fn('artMains'), fn('artOthers')].join('\n');
  const f = new Function(...Object.keys(env), src + '\nreturn { artDay, artMains, artOthers };')(...Object.values(env));
  const day = '2026-09-24', seen = new Set();
  for (let s = 0; s < 8; s++) {
    const m = f.artMains(day, s);
    for (const w of [m.r, m.f, m.e, ...m.g]) { assert.ok(!seen.has(w), `serial ${s}: ${w.id} again`); seen.add(w); }
    const o = f.artOthers(day, s, 15, m.e, '');
    assert.equal(new Set(o).size, 15); assert.ok(!o.includes(m.e), 'the right painting is not among the others');
    for (let t = 0; t <= s; t++) { const mt = f.artMains(day, t); for (const w of [mt.r, mt.f, mt.e, ...mt.g]) assert.ok(!o.includes(w), 'no work shown whole so far is a distractor'); }
  }
  assert.deepEqual(f.artMains(day, 3), f.artMains(day, 3), 'the same puzzle, the same paintings');
  const first = f.artMains(day, 0);
  assert.ok(works.slice(0, 14).includes(first.r) && works.slice(0, 14).includes(first.f) && works.slice(0, 14).includes(first.e), 'the day starts inside the window');
  assert.notDeepEqual(f.artOthers(day, 0, 9, first.e, ''), f.artOthers(day, 0, 9, first.e, '-a2'), 'a replay has other options');
});
test('holds: the clocks move on by the time held, and only when the last hold comes off', () => {
  let now = 1000;
  const env = { performance: { now: () => now }, train: { holds: new Set(), paused: false, heldAt: 0, game: null }, tcoach: { box: null }, trainCoachPlace() {}, trainHintSync() {}, trainHintDone() {} };
  const f = new Function(...Object.keys(env), fn('trainHold') + fn('trainRelease') + '\nreturn { trainHold, trainRelease };')(...Object.values(env));
  const g = env.train.game = { t0: 900, showUntil: 5000, showFrom: 1000, canHint: () => false };
  f.trainHold('leave'); assert.equal(env.train.paused, true);
  now = 3000; f.trainHold('away');
  now = 4000; f.trainRelease('leave'); assert.equal(g.t0, 900, 'still held'); assert.equal(env.train.paused, true);
  now = 6000; f.trainRelease('away');
  assert.equal(env.train.paused, false); assert.equal(g.t0, 900 + 5000); assert.equal(g.showUntil, 5000 + 5000);
  f.trainRelease('away'); assert.equal(g.t0, 5900, 'a second release is nothing');
  // a clock started during the hold is moved on by the part of the hold it ran for
  f.trainHold('count'); now = 7000; g.t0 = 7000; g.showFrom = 7000; g.showUntil = 11000; now = 9000; f.trainRelease('count');
  assert.equal(g.t0, 9000); assert.equal(g.showUntil, 13000);
});
test('the hint spends nothing when it would do nothing', () => {
  const { m, store } = makeStore(); let ads = 0;
  const env = { store, train: { day: '2026-09-24', game: null, holds: new Set() }, trainHintsLeft: () => 1, trainDay: d => store.get('train:' + d, {}), trainKey: d => 'train:' + d, trainHintSync() {}, trainHintDone() {}, trainHold() {}, trainRelease() {}, adOffer: async () => { ads++; return true; }, el: { trainSheet: { classList: { contains: () => true } } }, musicBegin() {}, dayKey: () => '2026-09-24' };
  const f = new Function(...Object.keys(env), fn('trainHint') + '\nreturn { trainHint };')(...Object.values(env));
  let acted = 0; const g = env.train.game = { canHint: () => false, hint: () => { acted++; return true; } };
  f.trainHint(); assert.equal(acted, 0); assert.equal(store.get('train:2026-09-24'), null, 'the day\'s free hint is not spent');
  g.canHint = () => true; f.trainHint(); assert.equal(acted, 1); assert.equal(store.get('train:2026-09-24').h, 1); assert.equal(g.hints, 1);
  g.hint = () => false; f.trainHint(); assert.equal(store.get('train:2026-09-24').h, 1, 'a hint that did not act is not charged'); assert.equal(g.hints, 1);
  let during = 0; g.hint = () => { during = g.hints; return true; }; f.trainHint();
  assert.equal(during, 2, 'counted before it acts: a hint that finishes the round is in that round\'s score');
  env.trainHintsLeft = () => 0; assert.equal(ads, 0);
});
test('the count-in: 3, 2, 1 tick and Go goes, like the online room; it holds the round and hides it', () => {
  const src = fn('trainCount');
  assert.match(src, /SFX\.tick\(\)/); assert.match(src, /SFX\.go\(\)/); assert.match(src, /trainHold\('count'\)/); assert.match(src, /trainRelease\('count'\)/);
  assert.match(src, /calmer\(\)/, 'no pop under reduced motion');
  assert.match(grab(/const TRAIN_COUNT = [^\n]+/), /TRAIN_COUNT = 3/);
  for (const id of ['canvasStart', 'forgeryStart', 'galleryStart', 'curatorStart']) {
    const s = fn(id);
    assert.match(s, /await artReady\(/, `${id} waits for its paintings`);
    assert.match(s, /await trainCount\(g\)/, `${id} counts in`);
    const awaits = s.match(/await /g).length, checks = (s.match(/train\.run !== run|return;|\) return;/g) || []).length;
    assert.ok(checks >= awaits, `${id}: a check after every await`);
    assert.ok(s.indexOf('trainCount(g)') < s.indexOf('g.t0 = performance.now()') || !/g\.t0 = performance\.now\(\)/.test(s), `${id}: no clock before Go`);
  }
  assert.match(css, /\.aa-train-count\{[^}]*position:absolute[^}]*background:var\(--bg\)/, 'an opaque veil over the round');
  assert.match(css, /prefers-reduced-motion:reduce\)\{ \.aa-train-count-n\.is-pop/);
});
test('the online room: the socket\'s count ticks the last three, once each, and says "Get ready" at nought', () => {
  const block = grab(/if \(ev\.type === 'countdown_tick'\) \{[\s\S]*?return;\n      \}/);
  assert.match(block, /fillShow\(/, 'the socket path goes through fillShow');
  // fillShow against a tiny card: a span with a number in it
  const mk = () => { const n = { textContent: '5', classList: { add() {}, remove() {} }, offsetWidth: 0 }; const span = { _html: '', textContent: 'Starting in 5s', querySelector: s => (s === '#aaFillIn' && span.hasN ? n : null), set innerHTML(v) { span.hasN = true; }, hasN: true }; return { span, n }; };
  const { span, n } = mk(); let ticks = 0;
  const env = { $: (s, r) => (s === '.aa-wait > span' ? span : r && r.querySelector ? r.querySelector(s) : null), el: { card: {} }, state: { ticked: null }, SFX: { tick: () => ticks++ }, calmer: () => true };
  const f = new Function(...Object.keys(env), fn('fillShow') + '\nreturn { fillShow };')(...Object.values(env));
  for (const v of [5, 4, 3, 3, 2, 3, 2, 1, 1]) f.fillShow(v);
  assert.equal(ticks, 3, 'three numbers, three ticks, however many times each arrives');
  assert.equal(n.textContent, '1');
  f.fillShow(0); assert.equal(span.textContent, 'Get ready…');
  f.fillShow(9); f.fillShow(3); assert.equal(ticks, 4, 'a count that went back up ticks its last three again');
  assert.match(fn('playMatch'), /if \(!back\) \{ SFX\.go\(\)/, 'no GO for a race already under way');
});
test('Back and Escape close the rules card first; a tap beside a round asks', () => {
  assert.match(fn('backPressed'), /trainHowClose\(\)/);
  assert.match(grab(/if \(e\.key !== 'Escape'\) return;[\s\S]{0,200}/), /trainHowClose\(\)/);
  assert.match(grab(/\$\$\('\.aa-sheet'\)\.forEach\(sh => [^\n]+/), /trainBack\(\)/);
});
console.log(process.exitCode ? `\nsome of ${tests} tests failed` : `\nall ${tests} tests passed`);
