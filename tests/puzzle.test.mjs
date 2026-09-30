// Validates Arrow Atlas data and the puzzle generator (every level generates and is solvable).
// Run: node tests/puzzle.test.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
const root = path.resolve(new URL('.', import.meta.url).pathname, '..');
const js = fs.readFileSync(path.join(root, 'js/puzzle.js'), 'utf8');
const data = JSON.parse(fs.readFileSync(path.join(root, 'games/data/puzzle.json'), 'utf8'));
const html = fs.readFileSync(path.join(root, 'puzzle/index.html'), 'utf8');
// Pull the pure pieces of the engine out of the IIFE so the exact production code is tested.
const grab = re => { const m = js.match(re); if (!m) throw new Error('could not find ' + re); return m[0]; };
const src = [grab(/const REF = \d+;/), grab(/function parsePath\(d\) \{[\s\S]*?\n  \}\n/), grab(/function insidePath\([\s\S]*?\n  \}\n/), grab(/function rasterise\([\s\S]*?\n  \}\n/), grab(/const DIRS = [^\n]+/), grab(/const PALETTE = [^\n]+/), grab(/const GRADE_UP = [^\n]+/), grab(/const FAST_SEC_PER_ARROW = [^\n]+/), grab(/const clampTier = [^\n]+/), grab(/const clampGrade = [^\n]+/), grab(/const clearPoints = [^\n]+/), grab(/const FORM0 = [^\n]+/), grab(/const gradeOf = [^\n]+/), grab(/const formOf = [^\n]+/), grab(/const nextForm = [\s\S]*?\n  \};\n/), grab(/const MAXLEN_OF = [^\n]+/), grab(/const KSCALE_OF = [^\n]+/), grab(/const CELL_CAP_OF = [^\n]+/), grab(/const SIDE_CAP = [^\n]+/), grab(/const NARROW_OF = [^\n]+/), grab(/const FAR_OF = [^\n]+/), grab(/const RAIL_OF = [^\n]+/), grab(/const HOLE_OF = [^\n]+/), grab(/const LANE_OF = [^\n]+/), grab(/const TIGHTEN_OF = [^\n]+/), grab(/const TRAP_OF = [^\n]+/), grab(/const GEN_OPTS = [^\n]+/), grab(/function mulberry32[^\n]+/), grab(/function generate\(mask, maxLen, seed[^)]*\) \{[\s\S]*?\n  \}\n/)].join('\n');
const { generate, rasterise, nextForm, gradeOf, FORM0, MAXLEN_OF, GEN_OPTS, DIRS, KSCALE_OF, CELL_CAP_OF, SIDE_CAP } = new Function(src + '\nreturn { generate, rasterise, nextForm, gradeOf, FORM0, MAXLEN_OF, GEN_OPTS, DIRS, KSCALE_OF, CELL_CAP_OF, SIDE_CAP };')();
// a sampling ramp for the board tests (the game itself picks the tier from the player's form, not the level)
const BASE_TIER = i => i < 5 ? 0 : i < 15 ? 1 : i < 40 ? 2 : i < 80 ? 3 : 4;
// the mask the game plays, finer grid of the top tiers included (see maskFor in the engine)
const maskCache = new Map(); const maskFor = (L, t) => { const key = L.id + ':' + t; if (!maskCache.has(key)) { const k = L.k[t]; let scale = KSCALE_OF[t]; if (scale !== 1) { const base = rasterise(L.d, k); scale = Math.max(1, Math.min(scale, Math.sqrt(CELL_CAP_OF[t] / Math.max(1, base.count)), SIDE_CAP / Math.max(1, base.w, base.h))); } let m = scale === 1 ? rasterise(L.d, k) : rasterise(L.d, k * scale); if (t > 0) { const below = maskFor(L, t - 1); if (below.count > m.count) m = below; } maskCache.set(key, m); } return maskCache.get(key); };
const TIER_OF = i => BASE_TIER(i);
let tests = 0;
const test = (name, fn) => { tests++; try { fn(); console.log('  ✓ ' + name); } catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; } };

function solvable(board) {
  const { W, H, pieces } = board; const occ = board.occ.map(r => r.slice());
  const gone = new Set();
  const free = p => { const [dr, dc] = DIRS[p.dir]; let [y, x] = p.cells[0]; y += dr; x += dc; while (y >= 0 && y < H && x >= 0 && x < W) { if (occ[y][x] >= 0) return false; y += dr; x += dc; } return true; };
  let progress = true;
  while (gone.size < pieces.length && progress) {
    progress = false;
    for (const p of pieces) if (!gone.has(p.idx) && free(p)) { gone.add(p.idx); for (const [y, x] of p.cells) occ[y][x] = -1; progress = true; }
  }
  return gone.size === pieces.length;
}

test('197 levels with name, capital, outline and 5 tier scales', () => {
  assert.equal(data.levels.length, 197);
  for (const L of data.levels) { assert.ok(L.name && L.cap && L.d.startsWith('M'), L.name); assert.equal(L.k.length, 5); assert.ok(L.k.every(k => k > 0), L.name); assert.ok(L.cont, `${L.name} has no continent`); }
});
test('every level id is unique', () => assert.equal(new Set(data.levels.map(l => l.id)).size, data.levels.length));
test('rasterised tiers grow in cell count and stay within the per-tier caps (32/32 on Easy and Normal, long side 46; the finer grid of Hard and up within SIDE_CAP)', () => {
  const DIM = [32, 32, SIDE_CAP + 2, SIDE_CAP + 2, SIDE_CAP + 2], LONG = [46, 46, SIDE_CAP + 2, SIDE_CAP + 2, SIDE_CAP + 2];   // +2: the scale is trimmed to the cap, the rasteriser rounds
  for (const L of data.levels) {
    for (let t = 0; t < 5; t++) { const m = maskFor(L, t); assert.ok(m.count >= 20, `${L.name} tier ${t} has only ${m.count} cells`); assert.ok(Math.max(m.w, m.h) <= LONG[t] && Math.min(m.w, m.h) <= DIM[t], `${L.name} tier ${t} is ${m.w}x${m.h}`); assert.equal(m.rows.length, m.h); assert.ok(m.rows.every(r => r.length === m.w)); }
    for (let t = 1; t < 5; t++) assert.ok(maskFor(L, t).count >= maskFor(L, t - 1).count, `${L.name} tier ${t} smaller than tier ${t - 1}`);
  }
});
test('every level generates a solvable board at its tour tier (fixed seed), covers every land cell, and gaps are sparse lanes', () => {
  data.levels.forEach((L, i) => {
    const tier = TIER_OF(i); const mask = maskFor(L, tier);
    const b = generate(mask, MAXLEN_OF[tier], (i + 1) * 1000, GEN_OPTS(tier));
    assert.ok(solvable(b), `${L.name} unsolvable`);
    const shapeCells = mask.rows.join('').split('1').length - 1, landCells = b.land.flat().filter(Boolean).length;
    assert.equal(b.pieces.reduce((n, p) => n + p.cells.length, 0), landCells, `${L.name} pieces do not cover the land`);
    assert.ok(landCells >= shapeCells * 0.72 && landCells <= shapeCells, `${L.name} has too many gaps (${shapeCells - landCells} of ${shapeCells})`);
    // gaps are straight lanes: never a 2x2 block of them
    for (let r = 0; r + 1 < b.H; r++) for (let c = 0; c + 1 < b.W; c++) { const g = (y, x) => b.shape[y][x] && !b.land[y][x]; assert.ok(!(g(r, c) && g(r + 1, c) && g(r, c + 1) && g(r + 1, c + 1)), `${L.name} has a 2x2 block of gaps`); }
    assert.ok(b.pieces.every(p => p.cells.length <= MAXLEN_OF[tier] + 6), 'piece too long');
  });
});
test('generation is deterministic for a seed', () => {
  const m = maskFor(data.levels[3], 2);
  assert.deepEqual(JSON.stringify(generate(m, 3, 42).pieces.map(p => [p.cells, p.dir])), JSON.stringify(generate(m, 3, 42).pieces.map(p => [p.cells, p.dir])));
});
test('100 random seeds on the hardest boards all generate', () => {
  for (let s = 0; s < 100; s++) { const L = data.levels[s % data.levels.length]; assert.ok(solvable(generate(maskFor(L, 4), 4, 5000 + s))); }
});
test('boards are dense: Hard tour levels average over 90 arrows on the finer grid, Normal over 35', () => {
  const avg = tier => { const idx = data.levels.map((_, i) => i).filter(i => BASE_TIER(i) === tier); return idx.reduce((n, i) => n + generate(maskFor(data.levels[i], tier), MAXLEN_OF[tier], (i + 1) * 1000).pieces.length, 0) / idx.length; };
  assert.ok(avg(1) > 35, `Normal averages ${avg(1)}`); assert.ok(avg(2) > 90, `Hard averages ${avg(2)}`);
});
test('difficulty follows form, not the level: grades 0-14, a first-try clear one up, a flawless fast one two, a scrappy or retried clear holds, a heart-out three down', () => {
  const flawless = { firstTry: true, heartsLost: 0, hints: 0, secPerArrow: 0.9 }, slow = { firstTry: true, heartsLost: 0, hints: 0, secPerArrow: 2 }, oneEach = { firstTry: true, heartsLost: 1, hints: 1, secPerArrow: 0.9 };
  const twoHearts = { firstTry: true, heartsLost: 2, hints: 0, secPerArrow: 2.5 }, twoHints = { firstTry: true, heartsLost: 0, hints: 2, secPerArrow: 1 }, retry = { firstTry: false, heartsLost: 0, hints: 0, secPerArrow: 0.9 };
  let f = { ...FORM0 };
  assert.deepEqual(f, { grade: 0, tier: 0 }, 'a new player starts on the easiest deal of Easy');
  f = nextForm(f, true, flawless); assert.deepEqual(f, { grade: 2, tier: 0 }, 'flawless and fast: two grades, the hardest deal of Easy');
  f = nextForm(f, true, slow); assert.deepEqual(f, { grade: 3, tier: 1 }, 'any other clean first-try clear: one grade, and grade 3 is Normal');
  f = nextForm(f, true, oneEach); assert.deepEqual(f, { grade: 4, tier: 1 }, 'a heart and a hint gone is still a clear');
  f = nextForm(f, true, twoHearts); assert.deepEqual(f, { grade: 4, tier: 1 }, 'two hearts lost: holds');
  f = nextForm(f, true, twoHints); assert.deepEqual(f, { grade: 4, tier: 1 }, 'two hints: holds');
  f = nextForm(f, true, retry); assert.deepEqual(f, { grade: 4, tier: 1 }, 'a clear after a retry holds, and resets nothing');
  f = nextForm(f, false, null); assert.deepEqual(f, { grade: 1, tier: 0 }, 'a heart-out: three grades down');
  for (let k = 0; k < 6; k++) f = nextForm(f, false, null); assert.deepEqual(f, { grade: 0, tier: 0 }, 'never below Easy');
  for (let k = 0; k < 12; k++) f = nextForm(f, true, flawless); assert.deepEqual(f, { grade: 14, tier: 4 }, 'never above the hardest deal of Master');
  // a form kept before grades (or written since by a device on the old rule) is its tier's hardest deal
  assert.equal(gradeOf({ tier: 2, wins: 1, losses: 0 }), 8); assert.equal(gradeOf({ tier: 0 }), 2); assert.equal(gradeOf({ tier: 4, wins: 0, losses: 1 }), 14);
  assert.equal(gradeOf({ grade: 4, tier: 1 }), 4, 'a grade and its tier agree: the grade');
  assert.equal(gradeOf({ grade: 4, tier: 3 }), 11, 'an old device moved the tier since: the tier wins');
  assert.deepEqual(nextForm({ tier: 3, wins: 1, losses: 0 }, true, slow), { grade: 12, tier: 4 }, 'and the ladder moves on from there');
  assert.deepEqual(nextForm({ grade: 'x', tier: 9 }, false, null), { grade: 11, tier: 3 }, 'junk is read as the nearest tier');
});
test('narrow play: on Hard tour boards fewer than 20% of the arrows are free at the start (the game then keeps the best of 8)', () => {
  const freeAtStart = b => b.pieces.filter(p => { const [dr, dc] = DIRS[p.dir]; let [y, x] = p.cells[0]; y += dr; x += dc; while (y >= 0 && y < b.H && x >= 0 && x < b.W) { if (b.occ[y][x] >= 0) return false; y += dr; x += dc; } return true; }).length;
  const idx = data.levels.map((_, i) => i).filter(i => BASE_TIER(i) === 2);
  const ratio = idx.reduce((n, i) => { const b = generate(maskFor(data.levels[i], 2), MAXLEN_OF[2], (i + 1) * 1000, GEN_OPTS(2)); return n + freeAtStart(b) / b.pieces.length; }, 0) / idx.length;
  assert.ok(ratio < 0.2, `free at start: ${(ratio * 100).toFixed(1)}%`);
});
test('lobby world map has every tour country with a label point and stays under 200 KB', () => {
  const map = JSON.parse(fs.readFileSync(path.join(root, 'games/data/world-map.json'), 'utf8'));
  assert.ok(map.countries.length > 150); const ids = new Set(map.countries.map(c => c.id));
  for (const L of data.levels) assert.ok(ids.has(L.id), `${L.name} missing from the world map`);
  for (const c of map.countries) assert.ok(c.d.startsWith('M') && c.cx >= 0 && c.cx <= map.w && c.cy >= 0 && c.cy <= map.h, c.n);
  assert.ok(fs.statSync(path.join(root, 'games/data/world-map.json')).size < 200 * 1024);
  assert.ok(html.includes('id="aaWorldMap"'));
});
test('every level has a unique ISO code and a centroid (home-country ordering)', () => {
  for (const L of data.levels) { assert.match(L.a2, /^[A-Z]{2}$/, `${L.name} has no ISO code`); assert.ok(Array.isArray(L.c) && L.c.length === 2, `${L.name} has no centroid`); }
  assert.equal(new Set(data.levels.map(L => L.a2)).size, data.levels.length, 'ISO codes are unique');
});
test('discover.json holds an animal, a bird, a place and a dish for every country', () => {
  const disc = JSON.parse(fs.readFileSync(path.join(root, 'games/data/discover.json'), 'utf8'));
  for (const L of data.levels) { const d = disc.items[L.a2]; assert.ok(d, `${L.name} has no discoveries`); for (const k of ['a', 'b', 'p', 'f']) assert.ok(typeof d[k] === 'string' && d[k].length >= 3 && d[k].length <= 80, `${L.name}: ${k} missing or odd`); }
  assert.equal(Object.keys(disc.items).length, data.levels.length, 'no stray entries');
});
test('discover-boards.json: a board for every country, a shape for every board, M/L/Z paths with five scales', () => {
  const b = JSON.parse(fs.readFileSync(path.join(root, 'games/data/discover-boards.json'), 'utf8'));
  for (const L of data.levels) { const bd = b.boards[L.a2]; assert.ok(bd, `${L.name} has no discovery board`); assert.ok(['a', 'b', 'p'].includes(bd.kind), `${L.name}: kind ${bd.kind}`); assert.ok(typeof bd.name === 'string' && bd.name.length >= 2 && bd.name.length <= 40, `${L.name}: board name odd: ${bd.name}`); assert.ok(b.shapes[bd.hex], `${L.name}: shape ${bd.hex} missing`); assert.ok(typeof bd.rel === 'string' && bd.rel.length >= 8 && bd.rel.length <= 90, `${L.name}: relation line odd: ${bd.rel}`); assert.ok(typeof bd.fact === 'string' && bd.fact.length >= 30 && bd.fact.length <= 200 && /\.$/.test(bd.fact), `${L.name}: fact odd: ${bd.fact}`); }
  assert.equal(Object.keys(b.boards).length, data.levels.length, 'no stray boards');
  for (const [hex, sh] of Object.entries(b.shapes)) {
    assert.match(sh.d, /^[MLZ0-9 .-]+$/, `${hex}: path is not M/L/Z`); assert.equal(sh.k.length, 5, `${hex}: five scales`);
    for (let t = 0; t < 5; t++) { const m = rasterise(sh.d, sh.k[t]); assert.ok(m.count >= 60, `${hex} tier ${t}: only ${m.count} cells`); assert.ok(m.w <= 50 && m.h <= 58, `${hex} tier ${t}: ${m.w}x${m.h} too big`); }
  }
  assert.ok(fs.statSync(path.join(root, 'games/data/discover-boards.json')).size < 120 * 1024, 'boards file under 120 KB');
});
test('discovery boards generate and are solvable at every tier (every fifth shape)', () => {
  const b = JSON.parse(fs.readFileSync(path.join(root, 'games/data/discover-boards.json'), 'utf8'));
  Object.entries(b.shapes).filter((_, i) => i % 5 === 0).forEach(([hex, sh]) => {
    for (let t = 0; t < 5; t++) { const board = generate(rasterise(sh.d, sh.k[t]), MAXLEN_OF[t], 1500 + t, GEN_OPTS(t)); assert.ok(board.pieces.length >= 15, `${hex} tier ${t}: ${board.pieces.length} arrows`); assert.ok(solvable(board), `${hex} tier ${t} not solvable`); }
  });
});
test('focus-boards.json: the boards a new player starts on, M/L/Z paths with five scales', () => {
  const fb = JSON.parse(fs.readFileSync(path.join(root, 'games/data/focus-boards.json'), 'utf8'));
  assert.ok(fb.boards.length >= 20, `only ${fb.boards.length} focus boards`);
  assert.equal(new Set(fb.boards.map(b => b.id)).size, fb.boards.length, 'focus board ids are unique');
  for (const b of fb.boards) {
    assert.match(b.id, /^[a-z][a-z0-9]{1,11}$/, `${b.id}: odd id`);
    assert.ok(typeof b.name === 'string' && b.name.length >= 3 && b.name.length <= 24, `${b.id}: name odd: ${b.name}`);
    assert.match(b.d, /^[MLZ0-9 .-]+$/, `${b.id}: path is not M/L/Z`);
    assert.equal(b.k.length, 5, `${b.id}: five scales`);
    for (let t = 0; t < 5; t++) { const m = rasterise(b.d, b.k[t]); assert.ok(m.count >= 60, `${b.id} tier ${t}: only ${m.count} cells`); assert.ok(m.w <= 50 && m.h <= 58, `${b.id} tier ${t}: ${m.w}x${m.h} too big`); if (t) assert.ok(m.count >= rasterise(b.d, b.k[t - 1]).count, `${b.id} tier ${t} smaller than tier ${t - 1}`); }
  }
  assert.ok(fs.statSync(path.join(root, 'games/data/focus-boards.json')).size < 40 * 1024, 'focus boards file under 40 KB');
  // the brain on the home screen: the same shape, its own five scales, coarse enough that nobody waits for it
  const em = fb.emblem;
  assert.ok(em && typeof em.d === 'string', 'no emblem');
  assert.match(em.d, /^[MLZ0-9 .-]+$/, 'emblem path is not M/L/Z');
  assert.equal(em.k.length, 5, 'emblem has five scales');
  let prev = 0;
  for (let t = 0; t < 5; t++) {
    const b = generate(rasterise(em.d, em.k[t]), MAXLEN_OF[t], 7000 + t * 131, GEN_OPTS(t));
    assert.ok(b.pieces.length >= 25 && b.pieces.length <= 140, `emblem tier ${t}: ${b.pieces.length} arrows`);
    const cells = rasterise(em.d, em.k[t]).count;
    assert.ok(cells >= prev, `emblem tier ${t} is not finer than tier ${t - 1}`);   // finer grid; the arrow count also depends on the tier's snake length
    prev = cells;
  }
});
test('focus boards generate and are solvable at every tier', () => {
  const fb = JSON.parse(fs.readFileSync(path.join(root, 'games/data/focus-boards.json'), 'utf8'));
  fb.boards.forEach((b, i) => {
    for (let t = 0; t < 5; t++) { const board = generate(rasterise(b.d, b.k[t]), MAXLEN_OF[t], 2500 + i * 10 + t, GEN_OPTS(t)); assert.ok(board.pieces.length >= 15, `${b.id} tier ${t}: ${board.pieces.length} arrows`); assert.ok(solvable(board), `${b.id} tier ${t} not solvable`); }
  });
});
test('the rank ladder: fourteen steps rising to GOAT at 6,236 arrows, and rankOf places every count', () => {
  const src = [grab(/const clampTier = [^\n]+/), grab(/const RANKS = \[[\s\S]*?\]\];\n/), grab(/const ARROWS_GUESS = [^\n]+/), grab(/const recArrows = [^\n]+/), grab(/function rankOf\(n\) \{[\s\S]*?\n  \}\n/)].join('\n');
  const { RANKS, rankOf, recArrows } = new Function(src + '\nreturn { RANKS, rankOf, recArrows };')();
  assert.equal(RANKS.length, 14);
  assert.equal(RANKS[0][1], 0); assert.equal(RANKS[RANKS.length - 1][0], 'GOAT'); assert.equal(RANKS[RANKS.length - 1][1], 6236);
  for (let i = 1; i < RANKS.length; i++) assert.ok(RANKS[i][1] > RANKS[i - 1][1], `${RANKS[i][0]} is not above ${RANKS[i - 1][0]}`);
  assert.equal(new Set(RANKS.map(r => r[0])).size, RANKS.length, 'rank names repeat');
  assert.deepEqual([rankOf(0).name, rankOf(39).name, rankOf(40).name, rankOf(6235).name, rankOf(6236).name, rankOf(99999).name], ['Newbie', 'Newbie', 'Normal', 'Immortal', 'GOAT', 'GOAT']);
  assert.equal(rankOf(1500).next, 'Master'); assert.equal(rankOf(1500).hi, 1900); assert.equal(rankOf(6236).top, true); assert.equal(rankOf(6236).hi, null);
  // a record from before boards remembered their arrows counts as a typical board of its tier, never as nothing
  assert.equal(recArrows({ arrows: 57, tier: 2 }), 57); assert.equal(recArrows({ tier: 4 }), 100); assert.equal(recArrows({}), 22); assert.equal(recArrows(null), 0);
});
test('data file stays under 200 KB', () => assert.ok(fs.statSync(path.join(root, 'games/data/puzzle.json')).size < 200 * 1024));
test('page copy quotes the level count and keeps the no-inline-style rule', () => { assert.ok(html.includes(`${data.levels.length} countries`)); assert.ok(!/\b70 (countries|levels)\b/.test(html)); assert.ok(!/<[a-z][^>]*\sstyle="/i.test(html)); });
console.log(process.exitCode ? `\nsome of ${tests} tests failed` : `\nall ${tests} tests passed`);
