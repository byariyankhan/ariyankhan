// Validates Arrow Atlas data and the puzzle generator (every level generates and is solvable).
// Run: node tests/arrow-atlas.test.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
const root = path.resolve(new URL('.', import.meta.url).pathname, '..');
const js = fs.readFileSync(path.join(root, 'js/arrow-atlas.js'), 'utf8');
const data = JSON.parse(fs.readFileSync(path.join(root, 'games/data/arrow-atlas.json'), 'utf8'));
const html = fs.readFileSync(path.join(root, 'arrow-atlas.html'), 'utf8');
// Pull the pure pieces of the engine out of the IIFE so the exact production code is tested.
const grab = re => { const m = js.match(re); if (!m) throw new Error('could not find ' + re); return m[0]; };
const src = [grab(/const REF = \d+;/), grab(/function parsePath\(d\) \{[\s\S]*?\n  \}\n/), grab(/function insidePath\([\s\S]*?\n  \}\n/), grab(/function rasterise\([\s\S]*?\n  \}\n/), grab(/const DIRS = [^\n]+/), grab(/const PALETTE = [^\n]+/), grab(/const STEP_POINTS = [^\n]+/), grab(/const FAST_SEC_PER_ARROW = [^\n]+/), grab(/const clampTier = [^\n]+/), grab(/const clearPoints = [^\n]+/), grab(/const FORM0 = [^\n]+/), grab(/const nextForm = [\s\S]*?\n  \};\n/), grab(/const MAXLEN_OF = [^\n]+/), grab(/const NARROW_OF = [^\n]+/), grab(/const FAR_OF = [^\n]+/), grab(/const RAIL_OF = [^\n]+/), grab(/const HOLE_OF = [^\n]+/), grab(/const LANE_OF = [^\n]+/), grab(/const TIGHTEN_OF = [^\n]+/), grab(/const GEN_OPTS = [^\n]+/), grab(/function mulberry32[^\n]+/), grab(/function generate\(mask, maxLen, seed[^)]*\) \{[\s\S]*?\n  \}\n/)].join('\n');
const { generate, rasterise, nextForm, FORM0, MAXLEN_OF, GEN_OPTS, DIRS } = new Function(src + '\nreturn { generate, rasterise, nextForm, FORM0, MAXLEN_OF, GEN_OPTS, DIRS };')();
// a sampling ramp for the board tests (the game itself picks the tier from the player's form, not the level)
const BASE_TIER = i => i < 5 ? 0 : i < 15 ? 1 : i < 40 ? 2 : i < 80 ? 3 : 4;
const maskCache = new Map(); const maskFor = (L, t) => { const key = L.id + ':' + t; if (!maskCache.has(key)) maskCache.set(key, rasterise(L.d, L.k[t])); return maskCache.get(key); };
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
test('rasterised tiers grow in cell count and stay within the per-tier caps (32/32/32/40/44, long side 46/46/46/54/58)', () => {
  const DIM = [32, 32, 32, 40, 44], LONG = [46, 46, 46, 54, 58];
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
test('boards are dense: Hard tour levels average over 55 arrows, Normal over 35 (long snakes on ~28-cell boards)', () => {
  const avg = tier => { const idx = data.levels.map((_, i) => i).filter(i => BASE_TIER(i) === tier); return idx.reduce((n, i) => n + generate(maskFor(data.levels[i], tier), MAXLEN_OF[tier], (i + 1) * 1000).pieces.length, 0) / idx.length; };
  assert.ok(avg(1) > 35, `Normal averages ${avg(1)}`); assert.ok(avg(2) > 55, `Hard averages ${avg(2)}`);
});
test('difficulty follows form, not the level: a flawless fast clear steps up at once, two first-try clears step up, two losses step down, a retry clear resets', () => {
  const flawless = { firstTry: true, heartsLost: 0, hints: 0, secPerArrow: 0.9 }, scrappy = { firstTry: true, heartsLost: 3, hints: 3, secPerArrow: 2.5 }, slow = { firstTry: true, heartsLost: 0, hints: 0, secPerArrow: 2 }, retry = { firstTry: false, heartsLost: 0, hints: 0, secPerArrow: 0.9 };
  let f = { ...FORM0 };
  f = nextForm(f, true, flawless); assert.deepEqual(f, { tier: 1, wins: 0, losses: 0 }, 'level 1 flawless and fast: level 2 is already Normal');
  f = nextForm(f, true, scrappy); assert.deepEqual(f, { tier: 1, wins: 1, losses: 0 }, 'a scrappy first-try clear is half a step');
  f = nextForm(f, true, slow); assert.deepEqual(f, { tier: 2, wins: 0, losses: 0 }, 'two first-try clears in a row step up, hearts and hints spent or not');
  f = nextForm(f, true, scrappy); f = nextForm(f, false, null); assert.deepEqual(f, { tier: 2, wins: 0, losses: 1 }, 'one loss keeps the tier and breaks the run');
  f = nextForm(f, true, retry); assert.deepEqual(f, { tier: 2, wins: 0, losses: 0 }, 'a clear after a retry resets both counters');
  f = nextForm(f, false, null); f = nextForm(f, false, null); assert.deepEqual(f, { tier: 1, wins: 0, losses: 0 }, 'two losses in a row step down');
  for (let k = 0; k < 6; k++) f = nextForm(f, false, null); assert.equal(f.tier, 0, 'never below Easy');
  for (let k = 0; k < 6; k++) f = nextForm(f, true, flawless); assert.equal(f.tier, 4, 'never above Master');
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
test('data file stays under 200 KB', () => assert.ok(fs.statSync(path.join(root, 'games/data/arrow-atlas.json')).size < 200 * 1024));
test('page copy quotes the level count and keeps the no-inline-style rule', () => { assert.ok(html.includes(`${data.levels.length} countries`)); assert.ok(!/\b70 (countries|levels)\b/.test(html)); assert.ok(!/<[a-z][^>]*\sstyle="/i.test(html)); });
console.log(process.exitCode ? `\nsome of ${tests} tests failed` : `\nall ${tests} tests passed`);
