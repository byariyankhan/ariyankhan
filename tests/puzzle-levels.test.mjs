// Levels, records and the board flow: the scene laps, the frontier, the header number, the win that cannot be
// taken back by a Back tap, what a lost board costs, a board that will not draw, and a board left mid-play.
// Run: node tests/puzzle-levels.test.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
const root = path.resolve(new URL('.', import.meta.url).pathname, '..');
const js = fs.readFileSync(path.join(root, 'js/puzzle.js'), 'utf8');
const json = f => JSON.parse(fs.readFileSync(path.join(root, 'games/data', f), 'utf8'));
const data = json('puzzle.json'), DISC = json('discover-boards.json'), FOCUSB = json('focus-boards.json'), SCENEB = json('scene-boards.json');
// Pull the exact production code out of the IIFE, the way tests/puzzle.test.mjs does.
const grab = re => { const m = js.match(re); if (!m) throw new Error('could not find ' + re); return m[0]; };
const fn = name => grab(new RegExp(`  (?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n`));
const one = name => grab(new RegExp(`  const ${name} = [^\\n]+`));
const body = name => fn(name);   // the source of one function, for the checks that read it
let tests = 0;
const test = (name, f) => { tests++; try { f(); console.log('  ✓ ' + name); } catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; } };

// A localStorage and a store over it, as the page has them (prefix aa:v1:). Keys are own properties, because
// the engine walks Object.keys(localStorage).
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

// ── The tour, replayed on the real data files ──
const TOUR_SRC = [STORE_SRC, one('baseId'), one('frontierOf'), one('kmBetween'), fn('orderFor'), one('discCache'), fn('discLevelFor'),
  one('focusCache'), fn('focusLevels'), one('sceneCache'), one('SCENE_EVERY'), fn('sceneLevelFor'), fn('tourFor')].join('\n');
const tourKit = () => {
  const localStorage = fakeStorage();
  const kit = new Function('localStorage', 'DISCB', 'FOCUS', 'SCENES', TOUR_SRC + '\nreturn { store, tourFor, baseId, frontierOf };')(localStorage, DISC, FOCUSB, SCENEB);
  return { ...kit, localStorage };
};
const canonData = () => ({ ...data, canon: data.levels.slice() });

test('no board comes round twice: one discovery board per shape, the scenes once, every id unique', () => {
  const shapes = new Set(Object.values(DISC.boards).map(b => b.hex)).size;
  for (const home of ['BD', 'IN', 'US', 'BR', 'IT', '']) {
    const { tourFor } = tourKit();
    const tour = tourFor(canonData(), home), ids = tour.map(L => L.id);
    assert.equal(new Set(ids).size, ids.length, `home ${home || 'none'}: ${ids.length - new Set(ids).size} ids repeat`);
    assert.equal(ids.length, 197 + shapes + SCENEB.boards.length + FOCUSB.boards.length, `home ${home || 'none'}: ${ids.length} slots`);
    const disc = tour.filter(L => L.disc);
    assert.equal(new Set(disc.map(L => L.hex)).size, disc.length, 'no discovery shape twice');
    const scenes = ids.filter(id => id.startsWith('s:'));
    assert.deepEqual(scenes, SCENEB.boards.map(b => 's:' + b.id), 'each scene once, under the id its clears were saved under');
  }
});
test('a board already cleared stays in the tour, a repeated shape or a later lap alike, so no level count goes down', () => {
  const kit = tourKit(), fresh = kit.tourFor(canonData(), 'BD');
  // a discovery board the new rule would not deal (its shape came earlier), and a scene's third lap, both cleared before
  const shown = new Set(fresh.filter(L => L.disc).map(L => L.id));
  const hidden = canonData().canon.map(C => 'd:' + C.id).find(id => DISC.boards[canonData().canon.find(C => 'd:' + C.id === id).a2] && !shown.has(id));
  assert.ok(hidden, 'there is a repeat to drop');
  kit.store.set('lv:' + hidden, { t: 1, stars: 3, at: 1 }); kit.store.set('lv:s:diamond~3', { t: 1, stars: 3, at: 2 });
  const tour = kit.tourFor(canonData(), 'BD').map(L => L.id);
  assert.ok(tour.includes(hidden), 'the cleared repeat is kept');
  assert.ok(tour.includes('s:diamond~3'), 'the cleared lap is kept');
  assert.ok(!tour.includes('s:diamond~2'), 'a lap never cleared is not dealt');
  assert.equal(new Set(tour).size, tour.length);
  assert.match(js, /const find = F && !DATA\.levels\.includes\(F\)/, 'a country whose find is not dealt tells it on its own card');
});
test('a lap is the same board to look up: baseId drops the lap, the shape is shared', () => {
  const { baseId } = tourKit();
  assert.equal(baseId('s:diamond~3'), 's:diamond'); assert.equal(baseId('s:diamond'), 's:diamond'); assert.equal(baseId('d:050'), 'd:050'); assert.equal(baseId('050'), '050');
  assert.ok(/mb = \/\^#b-\(\[\\w:~\]\+\)\$\//.test(js), 'a #b- link may carry the lap');
  assert.ok(/L\.id === baseId\(mb\[1\]\)/.test(js), 'a lap the tour does not have opens the scene itself');
  assert.ok(/const key = baseId\(L\.id\) \+ ':' \+ tier/.test(js), 'the mask is the shape\'s, whatever the lap');
  assert.ok(/countBoard\(baseId\(state\.level\.id\), \{ p: 1 \}\)/.test(js) && /countBoard\(baseId\(lid\)/.test(js) && /countBoard\(baseId\(state\.level\.id\), \{ f: 1 \}\)/.test(js), 'the stats are the shape\'s');
  assert.ok(/showPace\(baseId\(L\.id\)/.test(js) && /'#b-' \+ baseId\(state\.level\.id\)/.test(js), 'the pace and the shared link are the shape\'s');
  assert.ok(/store\.set\('lv:' \+ lid, rec\)/.test(js), 'the record keeps the full id');
});
test('the focus boards go in at the frontier (after the last clear), not into a scene hole far behind it', () => {
  const { tourFor, store } = tourKit();
  const bare = tourFor(canonData(), 'BD').filter(L => !L.focus);
  // a player who had cleared the first 150 slots, before the scene slots were put in behind them
  bare.slice(0, 150).forEach(L => { if (!L.scene) store.set('lv:' + L.id, { t: 1000, stars: 3, at: 1 }); });
  const tour = tourFor(canonData(), 'BD'), at = tour.findIndex(L => L.focus);
  const last = tour.map(L => !!store.get('lv:' + L.id)).lastIndexOf(true);
  assert.equal(at, last + 1, 'the block starts right after the last cleared board');
  assert.ok(tour.slice(0, at).some(L => L.scene && !store.get('lv:' + L.id)), 'with the scene holes left behind it');
  const { tourFor: fresh } = tourKit();
  assert.ok(fresh(canonData(), 'BD')[0].focus, 'a new player still starts on the brain');
});

// ── The next board, the numbers ──
const FLOW_SRC = [STORE_SRC, one('progressKey'), one('skipKey'), one('baseId'), one('cleared'), one('unlocked'), one('frontierOf'), one('frontierIdx'),
  'let numCache = null;', one('forgetNums'), fn('levelNo'), one('clearedLevels'), fn('nextOpen')].join('\n');
const flowKit = (levels, trainTimes = []) => {
  const localStorage = fakeStorage(), DATA = { levels };
  const kit = new Function('localStorage', 'DATA', 'trainClearTimes', FLOW_SRC + '\nreturn { store, cleared, unlocked, frontierIdx, levelNo, forgetNums, clearedLevels, nextOpen };')(localStorage, DATA, () => trainTimes);
  return { ...kit, DATA };
};
test('Play, the map and Next go forward: the first open board at or after the frontier, holes only when nothing is left ahead', () => {
  const { tourFor } = tourKit();
  const levels = tourFor(canonData(), 'BD').filter(L => !L.focus);
  const k = flowKit(levels);
  // the owner's phone: 148 boards cleared, and the scene holes #230 put in behind them
  let at = 0; levels.slice(0, 160).forEach((L, j) => { if (!L.scene) k.store.set('lv:' + L.id, { t: 1000, stars: 3, at: ++at }); });
  const f = k.frontierIdx();
  assert.equal(f, 160, 'the frontier is the slot after the last clear');
  const holes = levels.slice(0, f).map((L, j) => j).filter(j => !k.cleared(j));
  assert.ok(holes.length >= 5 && holes.every(j => levels[j].scene), 'scene holes lie behind it');
  assert.equal(k.nextOpen(), f, 'Play deals the frontier, not The Diamond ten countries back');
  assert.equal(k.nextOpen(3), f, 'so does Next after any board');
  // nothing left ahead: then the holes, in order
  levels.slice(f).forEach(L => k.store.set('lv:' + L.id, { t: 1000, stars: 3, at: ++at }));
  assert.equal(k.nextOpen(), holes[0], 'only then the first hole');
  holes.forEach(j => k.store.set('lv:' + levels[j].id, { t: 1, stars: 1, at: ++at }));
  assert.equal(k.nextOpen(), -1, 'and nothing once everything is cleared');
  // a skip opens the slot after the stuck board; the stuck board is passed over
  const s = flowKit(levels.slice(0, 10));
  s.store.set('lv:' + levels[0].id, { at: 1 }); s.store.set('skip:' + levels[2].id, true);
  assert.equal(s.nextOpen(), 1, 'the stuck board is next');
  assert.equal(s.nextOpen(1), 2, 'skipping it deals the slot the skip opened');
  assert.ok(/const nextIdx = nextOpen\(\), nextL = DATA\.levels\[nextIdx\]/.test(js), 'the map marks nextOpen()');
  assert.ok(/const nextIdx = nextOpen\(\);\n    el\.play\.dataset\.level/.test(js), 'Play & Discover deals nextOpen()');
  assert.ok(/if \(!daily && !unlocked\(i\)\) i = nextOpen\(\);/.test(js), 'a locked board falls back to nextOpen()');
});
test('level numbers count each board id once, and Daily Training is not counted; the next number is levelNo(-1)', () => {
  // an old tour: one scene id in four slots
  const T = { id: 's:tower', scene: true, name: 'The Tower' };
  const levels = [{ id: 'f:brain' }, { id: '050' }, T, { id: '356' }, T, { id: '524' }, T];
  const k = flowKit(levels, [15, 25]);
  k.store.set('lv:f:brain', { at: 10 }); k.store.set('lv:050', { at: 20 }); k.store.set('lv:s:tower', { at: 30 });
  assert.equal(k.levelNo(-1), 4, 'three boards and two training clears: the next is level 4, training not counted');
  assert.equal(k.levelNo(2), 3, 'The Tower is level 3');
  assert.equal(k.levelNo(4), 3, 'wherever the list holds it');
  assert.equal(k.levelNo(3), 4, 'an open board is the next level');
  assert.ok(!/trainClearTimes/.test(fn('levelNo')), 'levelNo reads the boards only');
  assert.equal(k.clearedLevels().length, 3, 'three boards cleared, not five');
  assert.ok(/el\.statBoards\.textContent = String\(cleared_\.length\)/.test(js) && /const cleared_ = clearedLevels\(\);/.test(js), 'the home count uses the same');
  assert.ok(/const n = new Set\(DATA\.levels\.map\(L => L\.id\)\)\.size, done = clearedLevels\(\)\.length;/.test(js), 'so does the share text');
});

// ── The header ──
test('the header: a fresh board reads Level N with N the training chip\'s number, a replay reads Replay · name', () => {
  const src = grab(/  const hudParts = \(\) => \{[\s\S]*?\n  \};\n/) + one('hudLabel');
  const run = (st, n) => new Function('state', 'levelNo', src + '\nreturn hudLabel();')(st, i => (i === st.idx && st.cleared ? 3 : n));
  assert.equal(run({ idx: 7, level: { name: 'Bhutan' } }, 165), 'Level 165', 'a country keeps its name to itself');
  assert.equal(run({ idx: 7, level: { name: 'The Diamond', scene: true } }, 165), 'Level 165 · The Diamond');
  assert.equal(run({ idx: 7, level: { name: 'The Diamond', scene: true }, replay: true, cleared: true }, 165), 'Replay · The Diamond', 'no old number on a replay');
  assert.equal(run({ idx: 7, level: { name: 'Bhutan' }, daily: { key: 'x' } }, 165), 'Daily');
  assert.ok(/state\.replay = !daily && !!cleared\(i\);/.test(body('startLevel')), 'startLevel decides replay before the header is drawn');
  // the name goes on the second line, before the difficulty: in the big type it was wider than a phone
  const title = body('renderTitle');
  assert.ok(/el\.hudLevel\.textContent = head;/.test(title) && /aa-hud-name/.test(title), 'the header writes the count big and the name small');
  const css = fs.readFileSync(path.join(root, 'css/puzzle.css'), 'utf8');
  assert.ok(/\.aa-gtitle\{[^}]*min-width:0/.test(css) && /\.aa-hud-name\{[^}]*text-overflow:ellipsis/.test(css), 'and a long name gives way rather than the page');
  // after a sync the list is rebuilt: the board in hand keeps its place and the header is read again
  const adopt = body('adoptTour');
  assert.ok(/const j = DATA\.levels\.indexOf\(state\.level\); if \(j >= 0\) state\.idx = j;/.test(adopt), 'adoptTour re-maps state.idx');
  assert.ok(/renderHud\(\);/.test(adopt.slice(adopt.indexOf('DATA.levels = tourFor'))), 'and redraws the HUD');
  // after a win the address moves to the next board, so a relaunch does not reopen the board just cleared
  assert.ok(/setHash\(nextOpen\(i\)\);/.test(body('keepWin')), 'the hash moves on after a win');
  // the card's Next names the tier the board will really be dealt at
  assert.ok(/Next: Level \$\{levelNo\(nj\)\} · \$\{DIFF_OF\(tierFor\(nj\)\)\}/.test(body('showResult')), 'Next names tierFor(nj)');
  assert.ok(/keepTier >= 0 \? keepTier : tierFor\(i\)/.test(body('startLevel')), 'and startLevel deals by tierFor');
});

// ── The win, kept at once ──
// a veteran's ceiling (boardsDone): the new player's cap is tests/puzzle-habits.test.mjs's
const FORM_SRC = [STORE_SRC, one('GRADE_UP'), one('LOCKED_IN'), one('FAST_SEC_PER_ARROW'), one('clampTier'), one('clampGrade'), one('clearPoints'), one('FORM0'), one('gradeOf'), one('formOf'), grab(/  const nextForm = [\s\S]*?\n  \};\n/), one('formNow'), one('GRADE_CAP'), 'const boardsDone = () => 99;', one('PAR_SEC_PER_ARROW'), one('FOCUS_FLOOR'), fn('focusOf'), fn('learnFrom')].join('\n');
const formKit = form => {
  const localStorage = fakeStorage();
  const k = new Function('localStorage', FORM_SRC + '\nreturn { store, learnFrom, formNow };')(localStorage);
  if (form) k.store.set('form', form);
  return k;
};
test('learnFrom reads the run it is handed, never the live board: a Back tap during the confetti cannot fake a flawless 0-second clear', () => {
  assert.ok(!/state\./.test(body('learnFrom')), 'learnFrom does not touch state');
  const k = formKit({ tier: 2, wins: 0, losses: 0 });
  const got = k.learnFrom(true, { fails: 0, lost: 2, hints: 1, t: 120_000, arrows: 40 });
  assert.deepEqual(got.after, { grade: 9, tier: 3 }, 'a scrappy slow clear of Hard (an old Hard form is read as grade 8) is still Expert next');
  // the same call with an emptied board (what clearRun leaves) would have been 2 grades; the run is what counts
  const k2 = formKit({ tier: 2, wins: 0, losses: 0 });
  assert.deepEqual(k2.learnFrom(true, { fails: 0, lost: 0, hints: 0, t: 30_000, arrows: 40 }).after, { grade: 9, tier: 3 }, 'a flawless fast clear: the same, one tier up');
  const k3 = formKit({ grade: 7, tier: 2 });
  assert.deepEqual(k3.learnFrom(true, { fails: 1, lost: 0, hints: 0, t: 30_000, arrows: 40 }).after, { grade: 9, tier: 3 }, 'a clear on the retry is a tier up too');
  const k4 = formKit({ grade: 7, tier: 2 });
  assert.deepEqual(k4.learnFrom(true, { fails: 1, lost: 1, hints: 1, t: 200_000, arrows: 40 }).after, { grade: 9, tier: 3 }, 'however slow');
  assert.equal(k2.learnFrom(true, { daily: { key: 'x' }, fails: 0, lost: 0, hints: 0, t: 1, arrows: 40 }), null, 'the daily board moves nothing');
});
test('a replay never promotes the ladder', () => {
  const k = formKit({ tier: 2, wins: 1, losses: 0 });
  const flawless = { fails: 0, lost: 0, hints: 0, t: 5_000, arrows: 22, replay: true };
  for (let n = 0; n < 5; n++) k.learnFrom(true, flawless);
  assert.deepEqual(k.formNow(), { tier: 2, wins: 1, losses: 0 }, 'five flawless replays leave the form as it was');
  k.learnFrom(true, { ...flawless, replay: false });
  assert.equal(k.formNow().tier, 3, 'a new board still does');
  assert.ok(/run\.replay = !!prev;\n\s+run\.learn = learnFrom\(true, run\);/.test(body('keepWin')), 'keepWin tells learnFrom whether the board was cleared before this run');
});
test('winLevel keeps everything at once; only the card waits, and leaving cancels it', () => {
  const win = body('winLevel'), keep = body('keepWin'), show = body('showResult'), clear = body('clearRun');
  assert.ok(/const run = keepWin\(\);[\s\S]*state\.resultTimer = setTimeout\(\(\) => \{ state\.resultTimer = 0; showResult\(run\); \}, 700\);/.test(win), 'the card is drawn from the kept run, 700 ms later');
  assert.ok(win.indexOf('keepWin()') < win.indexOf('setTimeout'), 'the saving comes first');
  for (const k of ["store.set('lv:' + lid, rec)", 'pushOne(lid, rec)', 'run.day = bumpDay()', 'countBoard(baseId(lid)', 'learnFrom(true, run)', 'finishMatch(true', 'dropRun(lid)'])
    assert.ok(keep.includes(k), `keepWin does ${k}`);
  for (const k of ['store.set(', 'learnFrom(', 'pushOne(', 'countBoard(', 'finishMatch(', 'state.pieces', 'state.elapsed', 'state.lives', 'state.hintsUsed', 'state.daily', 'stars()'])
    assert.ok(!show.includes(k), `showResult no longer reads or saves ${k}`);
  assert.ok(/clearTimeout\(state\.resultTimer\)/.test(clear), 'clearRun cancels a card still on its way');
  assert.ok(/clearTimeout\(state\.resultTimer\)/.test(body('startLevel')), 'and so does dealing another board');
  assert.ok(/if \(state\.finished\) return;/.test(win), 'a second win on the same board does nothing');
  assert.ok(/state\.resultTimer = setTimeout\(\(\) => \{ state\.resultTimer = 0; startLevel\(run\.nextIdx/.test(show), 'a race\'s next board is on the same timer');
});
test('milestones: the count passing a multiple of ten', () => {
  const crossedTen = new Function(one('crossedTen') + '\nreturn crossedTen;')();
  assert.equal(crossedTen(9, 10), true); assert.equal(crossedTen(10, 11), false); assert.equal(crossedTen(38, 41), true, 'a jump over 40 still counts');
  assert.equal(crossedTen(40, 40), false, 'a replay adds nothing'); assert.equal(crossedTen(0, 1), false); assert.equal(crossedTen(99, 100), true);
  assert.ok(!/n % 10 === 0/.test(js), 'not n % 10 any more');
});

// ── The record and the rank ──
const REC_SRC = [one('clampTier'), one('ARROWS_GUESS'), one('recArrows'), grab(/  const betterRun = [\s\S]*?;\n/), fn('mergeRec'), one('crossedTen'), fn('recordFor')].join('\n');
const { recordFor, mergeRec } = new Function(REC_SRC + '\nreturn { recordFor, mergeRec };')();
test('a board\'s record: the best run\'s time, stars and tier, the most arrows it ever paid, the first clear\'s time', () => {
  const first = recordFor(null, { t: 90_000, stars: 2, tier: 4, arrows: 145, at: 100 });
  assert.deepEqual(first, { t: 90_000, stars: 2, quiz: true, tier: 4, arrows: 145, at: 100 });
  const replay = recordFor(first, { t: 20_000, stars: 3, tier: 0, arrows: 22, at: 900 });
  assert.deepEqual(replay, { t: 20_000, stars: 3, quiz: true, tier: 0, arrows: 145, at: 100 }, 'a better replay at Easy wins the time and tier, never the arrows or the place in the count');
  const worse = recordFor(replay, { t: 60_000, stars: 1, tier: 2, arrows: 110, at: 950 });
  assert.deepEqual(worse, replay, 'a worse run changes nothing it did not beat');
  const legacy = recordFor({ t: 50_000, stars: 3, tier: 4 }, { t: 70_000, stars: 2, tier: 0, arrows: 22, at: 5 });
  assert.equal(legacy.arrows, 100, 'a record from before arrows were kept keeps its guess');
  assert.equal(legacy.at, 5, 'and takes this clear as its first');
  // the same, merging a record that came back from the account
  const m = mergeRec({ t: 20_000, stars: 3, tier: 0, arrows: 22, at: 100, quiz: true }, { t: 90_000, stars: 2, tier: 4, arrows: 145, at: 5000, quiz: false });
  assert.deepEqual(m, { t: 20_000, stars: 3, tier: 0, arrows: 145, at: 100, quiz: true }, 'a sync keeps the better run, the greater arrows and the earlier first clear');
  assert.deepEqual(mergeRec(null, { t: 1, stars: 1, at: 7 }), { t: 1, stars: 1, at: 7 });
  const same = { t: 1, stars: 3, quiz: true, tier: 1, arrows: 40, at: 7 };
  assert.equal(JSON.stringify(mergeRec(same, { ...same, at: 9000 })), JSON.stringify(same), 'an answer that is the same run changes nothing');
});
const RANK_SRC = [STORE_SRC, `const DEVICE = 'dev1'; const state = { lossHeld: 0 }; let syncOwed = false; const syncTour = () => Promise.resolve(false);`,
  one('clampTier'), one('ARROWS_GUESS'), one('recArrows'), one('lossMap'), one('lossTotal'), fn('loseArrows'), one('lossFor'), fn('holdLoss'), fn('forgiveLoss'), fn('settleLoss'), fn('arrowsShot')].join('\n');
const rankKit = () => { const localStorage = fakeStorage(); return new Function('localStorage', RANK_SRC + '\nreturn { store, state, lossFor, holdLoss, forgiveLoss, settleLoss, arrowsShot, loseArrows, get owed() { return syncOwed; } };')(localStorage); };
test('a lost board takes nothing: a title, once earned, is kept', () => {
  const { lossFor } = rankKit();
  for (const o of [{ fails: 1, done: false, left: 12, arrows: 140, rank: 900 }, { fails: 1, done: false, left: 100, arrows: 140, rank: 900 }, { fails: 2, done: false, left: 12, arrows: 140, rank: 900 }])
    assert.equal(lossFor(o), 0, JSON.stringify(o));
  const fail = body('failLevel');
  assert.ok(/const take = state\.daily \? 0 : lossFor\(/.test(fail), 'the daily board and races cost nothing');
  assert.ok(!/loseArrows\(state\.left\)/.test(fail), 'the old charge of every arrow left on every loss is gone');
});
test('a free life gives the arrows back; moving on takes them; the count stays one a sync can merge', () => {
  const k = rankKit();
  k.store.set('lv:050', { arrows: 100 });
  k.holdLoss(30);
  assert.equal(k.arrowsShot(), 100, 'held, not taken yet');
  assert.equal(k.store.get('lossHeld'), 30, 'held where a closed app still finds it');
  assert.equal(k.forgiveLoss(), 30, 'the free life gives them back');
  k.settleLoss();
  assert.equal(k.arrowsShot(), 100, 'and nothing is taken afterwards');
  assert.deepEqual(k.store.get('loss', {}), {}, 'the loss count never went up, so no sync can take them again');
  k.holdLoss(30); k.state.lossHeld = 0;   // the app was closed on the card: only the stored hold is left
  k.settleLoss();
  assert.equal(k.arrowsShot(), 70, 'moving on (or the next start) takes them');
  assert.deepEqual(k.store.get('loss'), { dev1: 30 }); assert.equal(k.owed, true, 'and the loss is owed to the account');
  assert.equal(k.store.get('lossHeld', null), null, 'once');
  k.loseArrows(500);
  assert.equal(k.arrowsShot(), 0, 'never below zero'); assert.deepEqual(k.store.get('loss'), { dev1: 100 }, 'and no debt is kept past it');
  assert.ok(/const back = forgiveLoss\(\); if \(back\) state\.lossRedo = true; keepRun\(\);/.test(grab(/    heart: \{[\s\S]*?\n    \},\n/)), 'the heart reward forgives the loss and keeps the run');
  assert.ok(/settleLoss\(\);/.test(body('startLevel')) && /settleLoss\(\);/.test(body('goToLevels')), 'Try again, another board and home settle it');
});

// ── A board that will not draw ──
test('a board that cannot be drawn is drawn from the next seed, then a tier down, then the player is told', () => {
  const calls = [];
  const dealSafe = new Function('dealBoard', 'console', fn('dealSafe') + '\nreturn dealSafe;')((L, t, s) => { calls.push([t, s]); if (calls.length < 3) throw new Error('no'); return { mask: 'm', gen: 'g' }; }, { warn() {} });
  assert.deepEqual(dealSafe({ id: 'x' }, 3, 5000), { tier: 2, seed: 5000, mask: 'm', gen: 'g' });
  assert.deepEqual(calls, [[3, 5000], [3, 5001], [2, 5000]], 'this seed, the next one, one tier down');
  const never = new Function('dealBoard', 'console', fn('dealSafe') + '\nreturn dealSafe;')(() => { throw new Error('no'); }, { warn() {} });
  assert.equal(never({ id: 'x' }, 0, 1), null, 'on Easy there is no tier below, and it says so');
  const start = body('startLevel'), failed = body('boardFailed');
  assert.ok(/if \(!deal\) \{ boardFailed\(\); return; \}/.test(start), 'startLevel stops on the card');
  assert.ok(/busy: false, finished: true/.test(failed) && /data-act="levels"/.test(failed), 'which leads home and leaves nothing stuck');
});
test('Try again does not draw the board again: the last deal is kept and every deal is a copy', () => {
  let drawn = 0;
  const board = () => ({ W: 2, H: 1, land: [[true, true]], occ: [[0, 1]], pieces: [{ idx: 0, dir: 'r', cells: [[0, 0]] }, { idx: 1, dir: 'r', cells: [[0, 1]] }] });
  const k = new Function('maskFor', 'bestBoard', 'let lastDeal = null;\n' + one('copyBoard') + '\n' + fn('dealBoard') + '\nreturn dealBoard;')(() => 'mask', () => { drawn++; return board(); });
  const a = k({ id: 's:tower~2' }, 3, 7000);
  a.gen.pieces[0].gone = true; a.gen.pieces[0].cells[0][1] = 9; a.gen.occ[0][0] = -1;   // played
  const b = k({ id: 's:tower~2' }, 3, 7000);
  assert.equal(drawn, 1, 'the same id, tier and seed is not drawn twice');
  assert.deepEqual(b.gen.pieces, board().pieces, 'and the second deal is whole');
  assert.deepEqual(b.gen.occ, board().occ);
  k({ id: 's:tower~2' }, 3, 7001);
  assert.equal(drawn, 2, 'another seed is drawn');
});

// ── A tour board left mid-play ──
const RUN_SRC = [STORE_SRC, one('MILESTONES'), one('runKey'), one('dropRun'), fn('keepRun'), fn('resumeRun')].join('\n');
const runKit = st => {
  const localStorage = fakeStorage(), applied = [];
  const k = new Function('localStorage', 'state', 'runSnapshot', 'applyRun', 'arm', 'currentElapsed', RUN_SRC + '\nreturn { store, keepRun, resumeRun };')(
    localStorage, st, () => ({ moves: st.moves, gone: st.pieces.filter(p => p.gone).map(p => p.idx), lives: st.lives, hintsUsed: 1 }),
    r => { applied.push(r); for (const p of st.pieces) if (r.gone.includes(p.idx)) { p.gone = true; st.left--; } st.lives = Math.min(st.lives, r.lives); }, p => st.armed.add(p), () => st.elapsed);
  return { ...k, applied };
};
const board = n => Array.from({ length: n }, (_, idx) => ({ idx }));
const playing = (o = {}) => ({ level: { id: '050' }, daily: null, replay: false, finished: false, busy: false, tier: 2, seed: 7000, fails: 1, moves: 9, lives: 1, left: 7, elapsed: 61_000, bestCombo: 4, pieces: board(10), armed: new Set(), shown: new Set(), ...o });
test('a tour board is kept on every move and carries on when dealt again at the same tier and seed', () => {
  const st = playing(); st.pieces[2].gone = st.pieces[5].gone = st.pieces[6].gone = true; st.armed.add(st.pieces[8]);
  const k = runKit(st);
  k.keepRun();
  const kept = k.store.get('run:050');
  assert.deepEqual({ tier: kept.tier, seed: kept.seed, fails: kept.fails, ms: kept.ms, armed: kept.armed, gone: kept.gone, lives: kept.lives }, { tier: 2, seed: 7000, fails: 1, ms: 61_000, armed: [8], gone: [2, 5, 6], lives: 1 });
  const back = playing({ fails: 0, lives: 3, elapsed: 0, bestCombo: 0, moves: 0, left: 10 });
  const k2 = runKit(back); k2.store.set('run:050', kept);
  assert.equal(k2.resumeRun(), true);
  assert.equal(back.lives, 1, 'the hearts are the ones left, not a refill');
  assert.deepEqual(back.pieces.filter(p => p.gone).map(p => p.idx), [2, 5, 6], 'the arrows gone stay gone');
  assert.equal(back.fails, 1, 'the retries carry on'); assert.equal(back.elapsed, 61_000, 'and the clock');
  assert.ok(back.armed.has(back.pieces[8]), 'an arrow paid for stays armed');
  assert.deepEqual([...back.shown], [25], 'the 25% cheer is not said again at 30%');
  for (const [why, o] of [['the daily board', { daily: { key: 'x' } }], ['a replay', { replay: true }], ['a finished board', { finished: true }], ['the last heart gone', { lives: 0 }], ['the last arrow gone', { left: 0 }], ['a board still being dealt', { busy: true }]]) {
    const k3 = runKit(playing(o)); k3.keepRun(); assert.equal(k3.store.get('run:050', null), null, `${why} is not kept`);
  }
});
test('a stale run is ignored and deleted: another tier, another seed, a board cleared since, nothing left to play', () => {
  const kept = { tier: 2, seed: 7000, fails: 1, ms: 5, gone: [1], lives: 2 };
  for (const [why, o, r] of [['another tier', { tier: 1 }, kept], ['another seed', { seed: 8000 }, kept], ['cleared since', { replay: true }, kept],
    ['no hearts', {}, { ...kept, lives: 0 }], ['every arrow gone', { pieces: board(1) }, { ...kept, gone: [0] }], ['an arrow the board does not have', {}, { ...kept, gone: [40] }]]) {
    const k = runKit(playing(o)); k.store.set('run:050', r);
    assert.equal(k.resumeRun(), false, why);
    assert.equal(k.store.get('run:050', null), null, `${why}: deleted`);
    assert.equal(k.applied.length, 0, `${why}: nothing applied`);
  }
  const start = body('startLevel');
  assert.ok(/const resumed = !daily && resumeRun\(\);/.test(start), 'startLevel resumes tour boards only');
  assert.ok(/dropRun\(state\.level\.id\)/.test(body('failLevel')) && /dropRun\(lid\)/.test(body('keepWin')), 'a lost or cleared board\'s run goes');
  assert.ok(/else if \(!state\.daily\) dropRun\(state\.level\.id\); startLevel\(state\.idx/.test(js), 'Try again starts it fresh');
  for (const f of ['shoot', 'blocked', 'hint', 'peek', 'goToLevels']) assert.ok(/keepRun\(\);/.test(body(f)), `${f} keeps the run`);
  assert.ok(/Your progress is kept/.test(js) && /state\.daily \|\| state\.replay \? 'It starts again from the beginning next time/.test(js), 'the leave question says what is kept');
});
test('the board is sized to the room really left on the screen, with a safe margin on all four sides', () => {
  const fit = body('fitBoard');
  assert.ok(/Math\.min\(roomW \/ vb\.width, roomH \/ vb\.height\)/.test(fit), 'the largest the board can be inside the room, at its own proportions');
  assert.ok(/appH - top - px\(ws\.paddingTop\) - px\(ws\.paddingBottom\) - px\(as\.paddingBottom\)/.test(fit), 'the room is measured down to the bottom of the column, less the margins');
  assert.ok(!/svg\.clientHeight|svg\.getBoundingClientRect/.test(fit), 'never read from the board itself');
  assert.ok(/renderBoard\(\); fitBoard\(\); resetZoom\(\);/.test(body('startLevel')), 'every board is fitted as it is drawn');
  assert.ok(/fitBoard\(\); applyZoom\(\);/.test(body('onTurn')), 'and again when the phone is turned');
  const css = fs.readFileSync(path.join(root, 'css/puzzle.css'), 'utf8');
  const wrap = css.match(/\.aa-board-wrap\{[^}]*\}/)[0];
  assert.ok(/padding:52px 16px 20px/.test(wrap) && /overflow:hidden/.test(wrap), 'the safe margin: under the zoom buttons, 16px each side, 20px at the bottom');
  assert.ok(!/aa-board--tall/.test(css), 'no stylesheet guess at the height left');
});

test('the daily board is gone: nothing deals it, and an old #daily link lands on home', () => {
  assert.ok(!/dailyPick/.test(js), 'no dailyPick');
  assert.ok(/else if \(location\.hash === '#daily'\) setHash\(-1\);/.test(js), '#daily clears the address instead of opening a board');
});

console.log(process.exitCode ? `\nsome of ${tests} tests failed` : `\nall ${tests} tests passed`);
