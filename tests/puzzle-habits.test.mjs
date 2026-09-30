// Habits: the ladder aimed at three clears in four (grades and the candidate deal), a new player's ceiling, the
// focus boards dealt in among the tour, the out-of-hearts card's honest progress and ways on, one streak with
// freezes and milestones, and the phone's notification question after the first result -- the exact production
// code, pulled out of js/puzzle.js the way tests/puzzle.test.mjs does it.
// Run: node tests/puzzle-habits.test.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
const root = path.resolve(new URL('.', import.meta.url).pathname, '..');
const js = fs.readFileSync(path.join(root, 'js/puzzle.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'puzzle/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css/puzzle.css'), 'utf8');
const json = f => JSON.parse(fs.readFileSync(path.join(root, 'games/data', f), 'utf8'));
const data = json('puzzle.json'), DISC = json('discover-boards.json'), FOCUSB = json('focus-boards.json'), SCENEB = json('scene-boards.json');
const grab = re => { const m = js.match(re); if (!m) throw new Error('could not find ' + re); return m[0]; };
const fn = name => grab(new RegExp(`  (?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n`));
const one = name => grab(new RegExp(`  const ${name} = [^\\n]+`));
const multi = name => grab(new RegExp(`  const ${name} = [\\s\\S]*?\\n  \\};\\n`));
const fnx = name => grab(new RegExp(`  function ${name}\\([\\s\\S]*?\\n  \\}\\n`));   // a signature with defaults in it
let tests = 0;
const test = (name, f) => { tests++; try { f(); console.log('  ✓ ' + name); } catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; } };

// A localStorage and a store over it, as the page has them (prefix aa:v1:).
function fakeStorage() {
  const ls = {};
  Object.defineProperties(ls, {
    getItem: { value: k => (Object.prototype.hasOwnProperty.call(ls, k) ? ls[k] : null) },
    setItem: { value: (k, v) => { ls[k] = String(v); } },
    removeItem: { value: k => { delete ls[k]; } },
  });
  return ls;
}
const STORE_SRC = `const STORE = 'aa:v1:';\n` + grab(/  const store = \{[\s\S]*?\n  \};\n/);
const LADDER_SRC = [one('GRADE_UP'), one('LOCKED_IN'), one('FAST_SEC_PER_ARROW'), one('clampTier'), one('clampGrade'), one('clearPoints'), one('FORM0'), one('gradeOf'), one('formOf'), multi('nextForm')].join('\n');
const ladder = new Function(LADDER_SRC + '\nreturn { nextForm, clearPoints, gradeOf, FORM0, GRADES };')();
const mulberry32 = new Function(grab(/function mulberry32[^\n]+/) + '\nreturn mulberry32;')();

// ── 1. The ladder ──
// The rule before this change, as it was: two points up (a flawless fast first try is both), two losses in a
// row down, a scrappy first try still a point, and every board the hardest deal of its tier.
const oldNext = (f, won, r) => {
  if (won) { const pts = !r.firstTry ? 0 : r.heartsLost === 0 && r.hints === 0 && r.secPerArrow <= 1.2 ? 2 : 1, wins = pts ? f.wins + pts : 0; return wins >= 2 ? { tier: Math.min(4, f.tier + 1), wins: 0, losses: 0 } : { tier: f.tier, wins, losses: 0 }; }
  const losses = f.losses + 1; return losses >= 2 ? { tier: Math.max(0, f.tier - 1), wins: 0, losses: 0 } : { tier: f.tier, wins: 0, losses };
};
// Three players, as the research simulated them (scratchpad/ladder3.mjs): the chance of clearing a tier's
// hardest deal, and of doing it flawless and fast. A board's difficulty runs on grades, the hardest deal of each
// tier (grade 3t + 2) at the tier's own chance and the grades between interpolated: the easiest deal of Hard is
// a third of the way from Normal's hardest to Hard's. Easy's easier deals are counted as hard as its hardest.
const PLAYERS = {
  casual: { p: [0.92, 0.80, 0.55, 0.35, 0.20], f: [0.25, 0.10, 0.03, 0.01, 0.0] },
  average: { p: [0.97, 0.90, 0.70, 0.50, 0.35], f: [0.40, 0.20, 0.06, 0.02, 0.01] },
  strong: { p: [0.99, 0.97, 0.88, 0.72, 0.55], f: [0.60, 0.40, 0.15, 0.05, 0.02] },
};
const pAt = (P, g) => { const x = Math.max(0, (g - 2) / 3), i = Math.min(4, Math.floor(x)), fr = x - i; return i >= 4 ? P.p[4] : P.p[i] * (1 - fr) + P.p[i + 1] * fr; };
const fAt = (P, g) => P.f[Math.min(4, Math.floor(g / 3))];
// One run of play, board after board: a clear is flawless and fast now and then, scrappy (two hearts or hints
// gone) more often the closer the board is to the player's limit. Old: Try again deals the same board, always.
// New: Try again once, then a new layout at the grade the ladder has stepped down to.
function simulate(P, rule, boards = 20000, seed = 11) {
  const rnd = mulberry32(seed);
  let f = rule === 'new' ? { ...ladder.FORM0 } : { tier: 0, wins: 0, losses: 0 };
  let attempts = 0, fails = 0, run = 0, runs3 = 0, worst = 0;
  const gradeNow = () => (rule === 'new' ? ladder.gradeOf(f) : f.tier * 3 + 2);
  for (let b = 0; b < boards; b++) {
    let g = gradeNow(), tries = 0;
    for (;;) {
      attempts++; tries++;
      const p = pAt(P, g);
      if (rnd() < p) {
        const flaw = rnd() < fAt(P, g) / p, scrappy = !flaw && rnd() < 1 - p;
        const r = { firstTry: tries === 1, heartsLost: flaw ? 0 : scrappy ? 2 : 1, hints: flaw ? 0 : scrappy ? 1 : 0, secPerArrow: flaw ? 0.9 : 2 };
        f = rule === 'new' ? ladder.nextForm(f, true, r) : oldNext(f, true, r);
        run = 0; worst = Math.max(worst, tries); break;
      }
      fails++; run++; if (run === 3) runs3++;
      f = rule === 'new' ? ladder.nextForm(f, false, null) : oldNext(f, false, null);
      if (rule === 'new' && tries >= 2) g = gradeNow();   // New layout, dealt as the ladder stands now
    }
  }
  return { failRate: fails / attempts, runs3: 100 * runs3 / boards, worst };
}
test('the ladder settles near three clears in four: the attempt failure rate drops for casual, average and strong players', () => {
  const rows = [];
  for (const [name, P] of Object.entries(PLAYERS)) {
    const was = simulate(P, 'old'), now = simulate(P, 'new');
    rows.push(`${name.padEnd(8)} failed attempts ${(100 * was.failRate).toFixed(1)}% -> ${(100 * now.failRate).toFixed(1)}%   three losses in a row per 100 boards ${was.runs3.toFixed(1)} -> ${now.runs3.toFixed(1)}   most tries on one board ${was.worst} -> ${now.worst}`);
    assert.ok(was.failRate > 0.34, `${name}: the old rule was near a coin flip (${was.failRate.toFixed(3)})`);
    assert.ok(now.failRate < 0.32 && now.failRate > 0.12, `${name}: about one try in four fails now (${now.failRate.toFixed(3)})`);
    assert.ok(now.failRate < was.failRate - 0.08, `${name}: clearly fewer failed tries`);
    assert.ok(now.runs3 < was.runs3 / 2, `${name}: far fewer runs of three losses`);
    assert.ok(now.worst < was.worst, `${name}: no board takes as many tries as the worst did`);
  }
  console.log('    ' + rows.join('\n    '));
});
test('a heart-out is three grades, a clear one or two, a scrappy clear none: the staircase aims at 3 in 4', () => {
  const { nextForm, clearPoints } = ladder;
  assert.equal(clearPoints({ firstTry: true, heartsLost: 0, hints: 0, secPerArrow: 1.2 }), 2, 'flawless and fast');
  assert.equal(clearPoints({ firstTry: true, heartsLost: 0, hints: 0, secPerArrow: 1.3 }), 1, 'flawless, not fast');
  assert.equal(clearPoints({ firstTry: true, heartsLost: 1, hints: 1, secPerArrow: 0.5 }), 1);
  assert.equal(clearPoints({ firstTry: true, heartsLost: 2, hints: 0, secPerArrow: 0.5 }), 0, 'two hearts: scrappy');
  assert.equal(clearPoints({ firstTry: true, heartsLost: 0, hints: 2, secPerArrow: 0.5 }), 0, 'two hints: scrappy');
  assert.equal(clearPoints({ firstTry: false, heartsLost: 0, hints: 0, secPerArrow: 0.5 }), 0, 'after a retry');
  // the card's Focus reading: Locked in (85 and up) is a whole tier, and a Locked-in retry is a step
  assert.equal(clearPoints({ firstTry: true, heartsLost: 0, hints: 0, secPerArrow: 0.5, focus: 92 }), 3, 'Locked in: a whole tier');
  assert.equal(clearPoints({ firstTry: true, heartsLost: 1, hints: 0, secPerArrow: 0.5, focus: 88 }), 3, 'Locked in with a heart gone');
  assert.equal(clearPoints({ firstTry: true, heartsLost: 2, hints: 0, secPerArrow: 0.5, focus: 90 }), 0, 'two hearts is still scrappy');
  assert.equal(clearPoints({ firstTry: false, heartsLost: 0, hints: 0, secPerArrow: 0.5, focus: 90 }), 1, 'a Locked-in retry: a step');
  assert.equal(clearPoints({ firstTry: false, heartsLost: 0, hints: 0, secPerArrow: 0.5, focus: 80 }), 0, 'any other retry holds');
  assert.deepEqual(nextForm({ grade: 7, tier: 2 }, false, null), { grade: 4, tier: 1 });
  assert.deepEqual(nextForm({ grade: 7, tier: 2 }, true, { firstTry: true, heartsLost: 2, hints: 2, secPerArrow: 9 }), { grade: 7, tier: 2 }, 'no reset: the grade stays');
});

// ── 2. The deal: the ladder's pick among the candidates ──
const GEN_SRC = [grab(/const REF = \d+;/), grab(/function parsePath\(d\) \{[\s\S]*?\n  \}\n/), grab(/function insidePath\([\s\S]*?\n  \}\n/), grab(/function rasterise\([\s\S]*?\n  \}\n/), grab(/const DIRS = [^\n]+/), grab(/const PALETTE = [^\n]+/),
  grab(/const MAXLEN_OF = [^\n]+/), grab(/const NARROW_OF = [^\n]+/), grab(/const FAR_OF = [^\n]+/), grab(/const RAIL_OF = [^\n]+/), grab(/const HOLE_OF = [^\n]+/), grab(/const LANE_OF = [^\n]+/), grab(/const TIGHTEN_OF = [^\n]+/), grab(/const TRAP_OF = [^\n]+/), grab(/const GEN_OPTS = [^\n]+/),
  grab(/function mulberry32[^\n]+/), grab(/function generate\(mask, maxLen, seed[^)]*\) \{[\s\S]*?\n  \}\n/), one('CANDIDATES_OF'), fn('boardScore'), one('PICK_HARDEST'), fn('bestBoard')].join('\n');
const gen = new Function(GEN_SRC + '\nreturn { rasterise, generate, boardScore, bestBoard, CANDIDATES_OF, MAXLEN_OF, GEN_OPTS };')();
test('bestBoard deals the ladder\'s pick: 2 is the narrowest candidate (the board every race and daily board has always been), 1 the middle one, 0 the widest', () => {
  const { rasterise, generate, boardScore, bestBoard, CANDIDATES_OF, MAXLEN_OF, GEN_OPTS } = gen;
  // the rule before picks, as it was: keep the first candidate with the lowest score
  const oldBest = (mask, tier, seed) => { let best = null, bs = Infinity; for (let k = 0; k < CANDIDATES_OF[tier]; k++) { const b = generate(mask, MAXLEN_OF[tier], seed + k * 97, GEN_OPTS(tier)); const sc = boardScore(b); if (sc < bs) { best = b; bs = sc; } } return best; };
  const sig = b => JSON.stringify(b.pieces.map(p => [p.cells, p.dir]));
  for (const [L, tier] of [[data.levels[0], 0], [data.levels[5], 1], [data.levels[40], 1], [FOCUSB.boards[0], 0]]) {
    const mask = rasterise(L.d, L.k[tier]), seed = 7000;
    const hard = bestBoard(mask, tier, seed, 2), mid = bestBoard(mask, tier, seed, 1), easy = bestBoard(mask, tier, seed, 0);
    assert.equal(sig(hard), sig(oldBest(mask, tier, seed)), `${L.name}: pick 2 is exactly the board dealt before`);
    assert.equal(sig(bestBoard(mask, tier, seed)), sig(hard), 'and it is what no pick means');
    assert.ok(boardScore(easy) >= boardScore(mid) && boardScore(mid) >= boardScore(hard), `${L.name}: the widest, the middle, the narrowest`);
    assert.ok(boardScore(easy) > boardScore(hard), `${L.name}: the easiest deal is really easier`);
  }
  const deal = fn('dealBoard'), safe = fn('dealSafe'), start = fn('startLevel');
  assert.ok(/const key = `\$\{L\.id\}:\$\{tier\}:\$\{seed\}:\$\{pick\}`/.test(deal), 'the kept deal is keyed by its pick too');
  assert.ok(/dealBoard\(L, t, sd, pick\)/.test(safe), 'a fallback deal keeps the pick');
  assert.ok(/state\.pick = daily \? PICK_HARDEST : kept \? kept\.pick : again \? state\.pick \?\? PICK_HARDEST : pickFor\(i\);/.test(start), 'a race and the daily board are the hardest deal for everybody; a board left mid-play and Try again keep their deal; anything else is the ladder\'s');
  assert.ok(/const kept = !daily && keepTier < 0 \? keptDeal\(state\.level, \(i \+ 1\) \* 1000 \+ state\.seedBump\) : null;\n\s+if \(kept\) keepTier = kept\.tier;/.test(start), 'a kept run is dealt again at its own tier, whatever the ladder did since (a heart-out, then a free life)');
  const keptDeal = new Function('store', 'runKey', multi('keptDeal') + '\nreturn keptDeal;')({ get: k => ({ 'run:050': { tier: 3, seed: 51000, pick: 1 }, 'run:356': { tier: 9, seed: 1 }, 'run:004': { tier: 2, seed: 5000 } })[k] ?? null }, id => 'run:' + id);
  assert.deepEqual(keptDeal({ id: '050' }, 51000), { tier: 3, pick: 1 }); assert.equal(keptDeal({ id: '050' }, 51001), null, 'another seed is another board');
  assert.equal(keptDeal({ id: '356' }, 1), null, 'junk is no deal'); assert.deepEqual(keptDeal({ id: '004' }, 5000), { tier: 2, pick: 2 }, 'a run from before picks was the hardest deal');
  assert.ok(/dealSafe\(state\.level, state\.tier, [^\n]*, state\.pick\)/.test(start));
  assert.ok(/pick: state\.pick/.test(fn('keepRun')) && /\(r\.pick \?\? 2\) === \(state\.pick \?\? 2\)/.test(fn('resumeRun')), 'a kept run is resumed on the same deal only (an old run was the hardest)');
  assert.ok(/if \(\(run\.pick \?\? PICK_HARDEST\) === PICK_HARDEST\) showPace\(/.test(fn('showResult')), 'the pace is compared only on the hardest deal, like with like');
});

// ── 3. The grade a board is dealt at: scenes, breathers, a new player's ceiling ──
const DEAL_SRC = [STORE_SRC, LADDER_SRC, one('formNow'), one('GRADE_CAP'), one('gradeNow'), one('TIER_OF'), multi('gradeFor'), one('tierFor'), one('pickFor')].join('\n');
const dealKit = (levels, done = 20) => {
  const localStorage = fakeStorage(), DATA = { levels };
  const k = new Function('localStorage', 'DATA', 'boardsDone', DEAL_SRC + '\nreturn { store, gradeNow, TIER_OF, gradeFor, tierFor, pickFor };')(localStorage, DATA, () => done);
  return k;
};
test('a scene is a whole tier up, the board after it the easiest deal of the player\'s own tier', () => {
  const levels = [{ id: '050' }, { id: 's:tower', scene: true }, { id: '356' }];
  const k = dealKit(levels);
  k.store.set('form', { grade: 7, tier: 2 });
  assert.deepEqual([k.gradeFor(0), k.tierFor(0), k.pickFor(0)], [7, 2, 1], 'Hard, the middle deal');
  assert.deepEqual([k.tierFor(1), k.pickFor(1)], [3, 1], 'the scene: Expert, the same deal');
  k.store.set('breather', true);
  assert.deepEqual([k.tierFor(2), k.pickFor(2)], [2, 0], 'the breather: Hard, the easiest deal');
  assert.deepEqual([k.tierFor(1), k.pickFor(1)], [3, 1], 'a scene is never a breather');
  k.store.set('form', { grade: 13, tier: 4 });
  assert.equal(k.gradeFor(1), 14, 'Master\'s scene is the hardest deal there is');
  const keep = fn('keepWin');
  assert.ok(/if \(!prev\) \{ if \(L\.scene && !\(run\.learn\?\.points >= GRADE_UP_TIER\)\) store\.set\('breather', true\); else store\.del\('breather'\); \}/.test(keep), 'a scene cleared sets the breather unless it was Locked in, and the next new clear spends it');
  assert.ok(/if \(state\.level\?\.scene\) store\.set\('breather', true\);/.test(js), 'a scene skipped earns one too');
  assert.ok(/One step harder: this scene is \$\{state\.diff\}\./.test(fn('startLevel')), 'a scene says on start that it is one step harder');
});
test('a new player: never past Normal before five boards, never past Hard before twelve, whatever the ladder says', () => {
  const levels = [{ id: '050' }, { id: 's:tower', scene: true }];
  for (const [done, tier] of [[0, 1], [4, 1], [5, 2], [11, 2], [12, 4]]) {
    const k = dealKit(levels, done); k.store.set('form', { grade: 14, tier: 4 });
    assert.equal(k.TIER_OF(), tier, `${done} boards cleared: tier ${tier}`);
  }
  const k = dealKit(levels, 3); k.store.set('form', { grade: 14, tier: 4 });
  assert.equal(k.gradeNow(), 5, 'the ceiling is the hardest deal of Normal');
  assert.equal(k.tierFor(1), 2, 'a scene is still a step above it');
  // the ladder itself is held at the ceiling, so the climb past it starts from its top, not from Master
  const FORM_SRC = [STORE_SRC, LADDER_SRC, one('formNow'), one('GRADE_CAP'), one('PAR_SEC_PER_ARROW'), one('FOCUS_FLOOR'), fn('focusOf'), fn('learnFrom')].join('\n');
  const learn = done => { const localStorage = fakeStorage(); return new Function('localStorage', 'boardsDone', FORM_SRC + '\nreturn { store, learnFrom, formNow };')(localStorage, () => done); };
  const flawless = { fails: 0, lost: 0, hints: 0, t: 10_000, arrows: 22 };
  const a = learn(3); for (let n = 0; n < 6; n++) a.learnFrom(true, flawless);
  assert.deepEqual(a.formNow(), { grade: 5, tier: 1 }, 'six flawless clears among the first five boards: the top of Normal');
  const b = learn(5); b.store.set('form', { grade: 5, tier: 1 }); b.learnFrom(true, flawless);
  assert.deepEqual(b.formNow(), { grade: 8, tier: 2 }, 'the sixth board goes on from there: Locked in, a whole tier');
  const c = learn(3); c.store.set('form', { grade: 14, tier: 4 }); c.learnFrom(false, {});
  assert.deepEqual(c.formNow(), { grade: 2, tier: 0 }, 'a heart-out counts down from the grade as dealt');
  const d = learn(3); d.store.set('form', { tier: 4, wins: 0, losses: 0 }); d.learnFrom(true, flawless);
  assert.deepEqual(d.formNow(), { grade: 14, tier: 4 }, 'a win under the ceiling leaves a grade from elsewhere (a reinstall before the sync, the old ladder) where it was');
  assert.ok(/levelNo\(-1\); return numCache\.boards;/.test(one('boardsDone')) && /const boards = done\.length;/.test(fn('levelNo')), 'boards cleared are counted with the level numbers, each id once, training not counted');
});

// ── 4. The tour: focus boards dealt in among the countries ──
const TOUR_SRC = [STORE_SRC, one('baseId'), one('frontierOf'), one('kmBetween'), fn('orderFor'), one('discCache'), fn('discLevelFor'),
  one('focusCache'), fn('focusLevels'), one('sceneCache'), one('SCENE_EVERY'), fn('sceneLevelFor'), fn('tourFor')].join('\n');
const tourKit = () => { const localStorage = fakeStorage(); return new Function('localStorage', 'DISCB', 'FOCUS', 'SCENES', TOUR_SRC + '\nreturn { store, tourFor, frontierOf };')(localStorage, DISC, FOCUSB, SCENEB); };
const canonData = () => ({ ...data, canon: data.levels.slice() });
test('a new player: the brain, then the home country and its discovery, then a focus board after every two tour boards', () => {
  const { tourFor } = tourKit();
  const tour = tourFor(canonData(), 'BD'), ids = tour.map(L => L.id), F = FOCUSB.boards.map(b => 'f:' + b.id);
  const home = data.levels.find(L => L.a2 === 'BD').id;
  assert.deepEqual(ids.slice(0, 4), [F[0], home, 'd:' + home, F[1]], 'brain, Bangladesh, its discovery, the second focus board');
  assert.equal(new Set(ids).size, ids.length, 'every board once');
  assert.equal(ids.length, 197 + new Set(Object.values(DISC.boards).map(b => b.hex)).size + SCENEB.boards.length + F.length, 'none lost: every country, one discovery board per shape, each scene once');
  const at = F.map(id => ids.indexOf(id));
  assert.ok(at.every((j, n) => j === 3 * n), 'focus board n sits at slot 3n: two tour boards between each');
  assert.equal(tour.slice(0, at[F.length - 1]).filter(L => !L.focus).length, 2 * (F.length - 1), 'they run out after 2 x 25 tour boards');
});
test('a player who has passed them meets the tour as before; one part-way through goes on where they were', () => {
  const kit = tourKit(), old = (tour, focus, at) => tour.slice(0, at).concat(focus, tour.slice(at));
  const bare = kit.tourFor(canonData(), 'BD').filter(L => !L.focus), focus = FOCUSB.boards.map(b => 'f:' + b.id);
  // all 26 cleared as the old block, then eleven tour boards
  focus.forEach((id, n) => kit.store.set('lv:' + id, { at: n + 1 }));
  bare.slice(0, 11).forEach((L, n) => kit.store.set('lv:' + L.id, { at: 100 + n }));
  const tour = kit.tourFor(canonData(), 'BD').map(L => L.id);
  const at = kit.frontierOf(bare, L => !!kit.store.get('lv:' + L.id));
  assert.deepEqual(tour, old(bare.map(L => L.id), focus, at), 'exactly the old layout: nothing moves for a player who passed them');
  // part-way: three of them cleared as the old block, nothing else -- they stay behind, the rhythm goes on
  const k2 = tourKit(); focus.slice(0, 3).forEach((id, n) => k2.store.set('lv:' + id, { at: n + 1 }));
  const t2 = k2.tourFor(canonData(), 'BD').map(L => L.id);
  assert.deepEqual(t2.slice(0, 6), [...focus.slice(0, 3), bare[0].id, bare[1].id, focus[3]], 'the three cleared behind the frontier, then two tour boards, then the fourth');
  assert.equal(k2.frontierOf(t2, id => !!k2.store.get('lv:' + id)), 3, 'the frontier is right after them');
});
test('the order holds when the list is built again (every load, every sync): the next board is the one it was', () => {
  const kit = tourKit(); let t = 0;
  let tour = kit.tourFor(canonData(), 'BD');
  const played = [];
  for (let n = 0; n < 80; n++) {
    const f = kit.frontierOf(tour, L => !!kit.store.get('lv:' + L.id)), next = tour[f];
    played.push(next.id); kit.store.set('lv:' + next.id, { at: ++t });
    const again = kit.tourFor(canonData(), 'BD');
    const f2 = kit.frontierOf(again, L => !!kit.store.get('lv:' + L.id)), f1 = kit.frontierOf(tour, L => !!kit.store.get('lv:' + L.id));
    assert.equal(again[f2]?.id, tour[f1]?.id, `after ${n + 1} boards (${next.id}) a rebuild deals the same next board`);
    tour = again;
  }
  const F = FOCUSB.boards.map(b => 'f:' + b.id);
  assert.deepEqual(played.slice(0, 7), [F[0], '050', 'd:050', F[1], played[4], played[5], F[2]], 'brain, Bangladesh, its discovery, a focus board, two more, a focus board');
  assert.equal(played.filter(id => id.startsWith('f:')).length, 26, 'all 26 by board 80');
  // a focus board put off with Skip for now comes after the other focus boards
  const k3 = tourKit(); k3.store.set('focusLater', [F[0]]);
  const t3 = k3.tourFor(canonData(), 'BD').map(L => L.id);
  assert.equal(t3[0], F[1], 'the brain put off: the lightbulb leads'); assert.ok(t3.indexOf(F[0]) > t3.indexOf(F[25]), 'the brain after the last of them');
  assert.ok(/if \(state\.level\?\.focus\) \{ const later = store\.get\('focusLater', \[\]\) \|\| \[\]; if \(!later\.includes\(state\.level\.id\)\) store\.set\('focusLater', later\.concat\(state\.level\.id\)\); \}/.test(js), 'Skip for now on a focus board puts it off');
});

// ── 5. The out-of-hearts card ──
test('out of hearts: the true share cleared and the arrows to go; a new layout from the second heart-out, skip from the third', () => {
  const fail = fn('failLevel');
  assert.ok(/const n = state\.pieces\.length, pct = n \? Math\.floor\(100 \* \(n - state\.left\) \/ n\) : 0;/.test(fail), 'the share is rounded down, never up to a near miss');
  assert.ok(/\$\{pct\}% cleared · \$\{fmtN\(state\.left\)\} arrow\$\{state\.left === 1 \? '' : 's'\} to go/.test(fail), '"91% cleared · 12 arrows to go"');
  assert.ok(/aa-fail-bar/.test(fail) && /style\.setProperty\('--at', `\$\{pct\}%`\)/.test(fail), 'with a bar, set from script (no inline style in the markup)');
  assert.ok(/const easier = DIFF_OF\(tierFor\(state\.idx\)\);/.test(fail) && /tour && state\.fails >= 2 \? `<button type="button" class="aa-btn" data-act="shuffle" aria-label="New layout, \$\{easier\}">\$\{ICON_SHUFFLE\}<span class="aa-alt-label">New layout<small>\$\{easier\}<\/small>/.test(fail), 'New layout from the second, with the tier it will be dealt at under it');
  assert.ok(/canSkip = tour && !state\.replay && state\.fails >= 3 && state\.idx \+ 1 < DATA\.levels\.length && !cleared\(state\.idx\)/.test(fail), 'Skip from the third, on a tour board not cleared, never past the last slot');
  assert.ok(fail.indexOf('learnFrom(false') < fail.indexOf('New layout'), 'the ladder steps down before the card names the tier');
  assert.ok(!/0 of \$\{state\.pieces\.length\}|arrows were still on the board/.test(fail), 'the old count is gone');
  assert.ok(/else if \(act === 'shuffle'\) \{ if \(!state\.daily\) dropRun\(state\.level\.id\); startLevel\(state\.idx, true, state\.daily\); \}/.test(js), 'New layout re-deals the board at the ladder\'s grade');
  assert.ok(/const id = DATA\.levels\[state\.idx \+ 1\]\?\.id; if \(!id\) \{ goToLevels\(\); return; \}/.test(js), 'Skip guards the end of the tour');
  assert.ok(/\.aa-actions--alt\{/.test(css) && /\.aa-fail-bar\{/.test(css));
});

// ── 6. One streak ──
const DAY_SRC = [STORE_SRC, one('dayKeyOf'), one('dayKey'), one('dayKeyBack'), one('dayNo'), one('FREEZE_MAX'), one('STREAK_MILESTONES'), one('freezeOf'), multi('streakOf'), one('streakRec'), fn('stepStreak'), fnx('streakNow'), fnx('bumpDay'), one('okStreak'), fn('mergeStreak')].join('\n');
const dayKit = () => { const localStorage = fakeStorage(); let drawn = 0; const k = new Function('localStorage', 'renderStreak', DAY_SRC + '\nreturn { store, stepStreak, streakNow, bumpDay, mergeStreak, dayKeyBack, dayKey };')(localStorage, () => { drawn++; }); return { ...k, drawn: () => drawn }; };
const D = n => { const d = new Date(Date.UTC(2026, 8, 1 + n)); return d.toISOString().slice(0, 10); };
test('a day played: the next day adds one, the same day nothing, a missed day ends it', () => {
  const { stepStreak } = dayKit();
  let s = stepStreak(null, D(0)); assert.deepEqual(s.rec, { count: 1, last: D(0), freeze: 0 }); assert.equal(s.counted, true);
  s = stepStreak(s.rec, D(1)); assert.deepEqual(s.rec, { count: 2, last: D(1), freeze: 0 });
  const same = stepStreak(s.rec, D(1)); assert.equal(same.counted, false); assert.deepEqual(same.rec, s.rec, 'the same day twice is one day');
  const back = stepStreak(s.rec, D(0)); assert.equal(back.counted, false, 'a round from before midnight finished after a later day changes nothing');
  assert.deepEqual(stepStreak(s.rec, D(3)).rec, { count: 1, last: D(3), freeze: 0 }, 'a missed day with no freeze: a new streak');
});
test('freezes: earned by the seventh day and by all four rounds, held two at most, spent by themselves on exactly one missed day', () => {
  const { stepStreak } = dayKit();
  let s = { count: 6, last: D(5), freeze: 0 };
  let r = stepStreak(s, D(6)); assert.deepEqual([r.rec.count, r.rec.freeze, r.earned, r.milestone], [7, 1, 1, 7], 'day seven: a freeze and the week\'s milestone');
  r = stepStreak(r.rec, D(8)); assert.deepEqual([r.rec.count, r.rec.freeze, r.bridged], [9, 0, true], 'one missed day: the freeze covers it, and the day it covered counts');
  r = stepStreak({ count: 9, last: D(8), freeze: 1 }, D(11)); assert.deepEqual([r.rec.count, r.rec.freeze, r.bridged], [1, 1, false], 'two missed days: the streak ends and the freeze is kept, not wasted');
  r = stepStreak({ count: 3, last: D(2), freeze: 2 }, D(3), true); assert.deepEqual([r.rec.freeze, r.earned], [2, 0], 'never more than two held');
  r = stepStreak({ count: 3, last: D(3), freeze: 0 }, D(3), true); assert.deepEqual([r.rec.freeze, r.earned, r.counted], [1, 1, false], 'all four rounds on a day already counted still earn one');
  r = stepStreak({ count: 13, last: D(12), freeze: 1 }, D(14)); assert.deepEqual([r.rec.count, r.milestone, r.earned, r.rec.freeze], [15, 14, 1, 1], 'a covered day that carries the count past 14: the milestone and the second week\'s freeze');
  const ms = []; let t = { count: 0, last: '', freeze: 0 };
  for (let n = 0; n < 101; n++) { const x = stepStreak(t, D(n)); if (x.milestone) ms.push(x.milestone); t = { ...x.rec, freeze: 0 }; }
  assert.deepEqual(ms, [3, 7, 14, 30, 50, 100], 'the milestones');
});
test('the streak as it stands today: alive yesterday, alive the day before with a freeze to cover yesterday, else nothing', () => {
  const { streakNow, dayKeyBack, dayKey } = dayKit();
  assert.deepEqual(streakNow({ count: 4, last: dayKey() }), { count: 4, done: true, freeze: 0, covering: false });
  assert.deepEqual(streakNow({ count: 4, last: dayKeyBack(1), freeze: 1 }), { count: 4, done: false, freeze: 1, covering: false });
  assert.deepEqual(streakNow({ count: 4, last: dayKeyBack(2), freeze: 1 }), { count: 5, done: false, freeze: 1, covering: true }, 'a freeze about to cover yesterday');
  assert.equal(streakNow({ count: 4, last: dayKeyBack(2) }).count, 0, 'without one, gone');
  assert.equal(streakNow({ count: 4, last: dayKeyBack(3), freeze: 2 }).count, 0, 'two days missed: gone, whatever is held');
  assert.equal(streakNow(null).count, 0); assert.equal(streakNow({ count: 'x', last: 5 }).count, 0);
});
test('bumpDay keeps playStreak, the key the sync already carries, and the flame is redrawn', () => {
  const k = dayKit();
  k.store.set('playStreak', { count: 3, last: k.dayKeyBack(2), freeze: 1 });
  const r = k.bumpDay();
  assert.deepEqual(k.store.get('playStreak'), { count: 5, last: k.dayKey() }, 'the freeze covered yesterday; none is kept once none is held');
  assert.equal(r.bridged, true); assert.equal(k.drawn(), 1);
  k.bumpDay(); assert.equal(k.drawn(), 1, 'the same day again writes nothing');
  assert.deepEqual(k.bumpDay(k.dayKey(), true).rec.freeze, 1, 'all four rounds');
  assert.deepEqual(k.store.get('playStreak'), { count: 5, last: k.dayKey(), freeze: 1 });
});
test('two devices\' streaks: joined as before, the freezes the later day\'s; in any order, and merging twice changes nothing', () => {
  const { mergeStreak } = dayKit();
  const s = (count, last, freeze) => (freeze ? { count, last, freeze } : { count, last });
  const cases = [[s(2, D(0), 1), s(1, D(1))], [s(5, D(4)), s(3, D(4), 2)], [s(3, D(2), 2), s(9, D(8), 1)], [s(4, D(3), 1), s(4, D(3), 1)], [null, s(2, D(1), 2)]];
  for (const [a, b] of cases) {
    const ab = mergeStreak(a, b), ba = mergeStreak(b, a);
    assert.deepEqual(ab, ba, `order does not matter: ${JSON.stringify([a, b])}`);
    assert.deepEqual(mergeStreak(ab, a), ab, 'merging again changes nothing'); assert.deepEqual(mergeStreak(ab, b), ab);
    assert.deepEqual(mergeStreak(ab, ab), ab);
  }
  assert.deepEqual(mergeStreak(s(2, D(0), 1), s(1, D(1))), s(3, D(1)), 'the later day played after the freeze was spent: none held');
  assert.deepEqual(mergeStreak(s(5, D(4)), s(3, D(4), 2)), s(5, D(4), 2), 'the same day: the more held');
  assert.deepEqual(mergeStreak(s(2, D(1)), { count: 3, last: D(1), freeze: 9 }), s(3, D(1), 2), 'never more than two');
});
test('one streak everywhere: a board and a training round both count it, the training sheet and home read the same number', () => {
  const keep = fn('keepWin'), save = fn('trainSave'), tally = fn('renderTrain'), fin = fn('trainFinish');
  assert.ok(/run\.day = bumpDay\(\);/.test(keep) && !/store\.set\('playStreak'/.test(keep), 'a board cleared counts the day through bumpDay');
  assert.ok(/const allFour = typeof t\[k\] !== 'number' && TRAIN_ROUNDS\.every\(r => r\.id === k \|\| typeof t\[r\.id\] === 'number'\);\n\s+train\.news = bumpDay\(day, allFour\);/.test(save), 'a round scored counts the round\'s own day, and the fourth round earns a freeze');
  assert.ok(save.indexOf('bumpDay(') < save.indexOf('return false'), 'counted before a lower replay score returns');
  assert.ok(!/trainStreak/.test(js), 'the training\'s own streak is gone');
  assert.ok(/sk = streakNow\(\), streak = sk\.count/.test(tally) && /trainTally\(t, streakNow\(\)\.count, true, dayWord\(day\)\)/.test(fin), 'the sheet and the result read the one streak');
  assert.ok(/\$\{streakNews\(run\.day\)\}/.test(fn('showResult')) && /\$\{streakNews\(news\)\}/.test(fin), 'milestones and freezes on the board card and the training result');
  assert.ok(/renderStreak\(\);/.test(fn('renderHomeStats')) && /if \(el\.statStreak\) el\.statStreak\.textContent = String\(s\.count\);/.test(fn('renderStreak')), 'the home tile too, redrawn with the flame');
  // the flame in the home bar
  assert.ok(/<button type="button" class="aa-chip aa-chip--streak" id="aaStreak" hidden/.test(html) && /id="aaStreakNo"/.test(html) && /id="aaStreakFz" hidden/.test(html));
  assert.ok(html.indexOf('id="aaStreak"') < html.indexOf('id="aaTrainBtn"'), 'beside the training button');
  assert.ok(!/<[a-z][^>]*\sstyle="/i.test(html), 'no inline style in the page');
  const r = fn('renderStreak');
  assert.ok(/el\.streak\.hidden = s\.count < 1;/.test(r) && /classList\.toggle\('is-due', !s\.done\)/.test(r), 'shown while alive, rose until today is played');
  assert.ok(/\.aa-chip--streak\.is-due \.aa-flame\{ fill:var\(--accent2\); \}/.test(css), 'rose is the training dot\'s colour');
});
test('the streak news line: a milestone, a freeze spent, a freeze earned; an ordinary day says nothing', () => {
  const news = new Function(one('FLAME') + '\n' + fn('streakNews') + '\nreturn streakNews;')();
  assert.equal(news(null), ''); assert.equal(news({ counted: true, count: 5, milestone: 0, bridged: false, earned: 0 }), '');
  assert.match(news({ count: 7, milestone: 7, bridged: false, earned: 1 }), /<b>7-day streak!<\/b> Streak freeze earned: it covers a day you miss\./);
  assert.match(news({ count: 9, milestone: 0, bridged: true, earned: 0 }), /<b>9-day streak\.<\/b> A freeze covered the day you missed\./);
  assert.match(news({ count: 8, milestone: 7, bridged: true, earned: 1 }), /<b>8-day streak!<\/b> A freeze covered the day you missed\. Streak freeze earned/, 'a covered day that carried it past seven: the count as it is');
});

// ── 7. The phone's question ──
test('the notification question: after the first result, a board\'s or a round\'s, never on the way in', () => {
  const calls = [...js.matchAll(/notifyFirstAsk\(\)/g)].length;
  const ask = fnx('askAfterResult');
  assert.ok(/void notifyFirstAsk\(\)/.test(ask) && /if \(!appPush\(\) \|\| store\.get\('pushAsked'\)\) return;/.test(ask), 'askAfterResult asks, in the app, until it has');
  assert.ok(/setTimeout\(\(\) => \{ if \(onScreen\(\)\) void notifyFirstAsk\(\); \}, 1200\);/.test(ask), 'a moment after the result, and only while it is still up');
  assert.ok(/askAfterResult\(\);/.test(fn('showResult')), 'after a board\'s card');
  assert.ok(/askAfterResult\(\(\) => !!\$\('\.aa-train-res', el\.trainBody\) && !el\.trainSheet\.hidden\);/.test(fn('trainFinish')), 'after a round\'s result');
  assert.equal(js.split('void notifyFirstAsk()').length - 1, 1, 'from nowhere else');
  assert.ok(calls >= 1);
  const show = fn('showResult'), raceEnd = show.indexOf('if (R) {'), raceClose = show.indexOf('const n = run.n');
  assert.ok(show.indexOf('askAfterResult') > raceClose && raceClose > raceEnd, 'not on a race\'s card');
});

console.log(process.exitCode ? `\nsome of ${tests} tests failed` : `\nall ${tests} tests passed`);
