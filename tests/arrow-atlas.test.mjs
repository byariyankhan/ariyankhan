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
const src = [grab(/const DIRS = [^\n]+/), grab(/const PALETTE = [^\n]+/), grab(/const TIER_OF = [^\n]+/), grab(/const MAXLEN_OF = [^\n]+/), grab(/function mulberry32[^\n]+/), grab(/function generate\(mask, maxLen, seed\) \{[\s\S]*?\n  \}\n/)].join('\n');
const { generate, TIER_OF, MAXLEN_OF, DIRS } = new Function(src + '\nreturn { generate, TIER_OF, MAXLEN_OF, DIRS };')();
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

test('70 levels with name, capital, outline and 5 tiers', () => {
  assert.equal(data.levels.length, 70);
  for (const L of data.levels) { assert.ok(L.name && L.cap && L.d.startsWith('M'), L.name); assert.equal(L.tiers.length, 5); assert.ok(L.cont, `${L.name} has no continent`); }
});
test('every level id is unique', () => assert.equal(new Set(data.levels.map(l => l.id)).size, data.levels.length));
test('tiers grow in cell count and stay within 40 cells', () => {
  for (const L of data.levels) {
    for (let t = 0; t < 5; t++) { const m = L.tiers[t]; assert.ok(m.count >= 20, `${L.name} tier ${t} has only ${m.count} cells`); assert.ok(m.w <= 40 && m.h <= 40, `${L.name} tier ${t} is ${m.w}x${m.h}`); assert.equal(m.rows.length, m.h); assert.ok(m.rows.every(r => r.length === m.w)); }
    for (let t = 1; t < 5; t++) assert.ok(L.tiers[t].count >= L.tiers[t - 1].count, `${L.name} tier ${t} smaller than tier ${t - 1}`);
  }
});
test('every level generates a solvable board at its tour tier (fixed seed) and covers every land cell', () => {
  data.levels.forEach((L, i) => {
    const tier = TIER_OF(i); const mask = L.tiers[tier];
    const b = generate(mask, MAXLEN_OF[tier], (i + 1) * 1000);
    assert.ok(solvable(b), `${L.name} unsolvable`);
    const land = mask.rows.join('').split('1').length - 1;
    assert.equal(b.pieces.reduce((n, p) => n + p.cells.length, 0), land, `${L.name} pieces do not cover the mask`);
    assert.ok(b.pieces.every(p => p.cells.length <= MAXLEN_OF[tier] + 6), 'piece too long');
  });
});
test('generation is deterministic for a seed', () => {
  const m = data.levels[3].tiers[2];
  assert.deepEqual(JSON.stringify(generate(m, 3, 42).pieces.map(p => [p.cells, p.dir])), JSON.stringify(generate(m, 3, 42).pieces.map(p => [p.cells, p.dir])));
});
test('100 random seeds on the hardest boards all generate', () => {
  for (let s = 0; s < 100; s++) { const L = data.levels[s % data.levels.length]; assert.ok(solvable(generate(L.tiers[4], 4, 5000 + s))); }
});
test('data file stays under 600 KB', () => assert.ok(fs.statSync(path.join(root, 'games/data/arrow-atlas.json')).size < 600 * 1024));
test('page copy quotes 70 levels and keeps the no-inline-style rule', () => { assert.ok(html.includes('70 countries')); assert.ok(!/<[a-z][^>]*\sstyle="/i.test(html)); });
console.log(process.exitCode ? `\nsome of ${tests} tests failed` : `\nall ${tests} tests passed`);
