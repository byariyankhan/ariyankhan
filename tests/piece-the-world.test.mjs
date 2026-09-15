// Validates the Piece the World level data against what the game and page promise.
// Run: node tests/piece-the-world.test.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..');
const js = fs.readFileSync(path.join(root, 'js/piece-the-world.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'piece-the-world.html'), 'utf8');
const levelsInJs = [...js.matchAll(/\{ id: '([a-z-]+)', name: '([^']+)', pieces: (\d+)/g)].map(m => ({ id: m[1], name: m[2], pieces: +m[3] }));
let tests = 0;
const test = (name, fn) => { tests++; try { fn(); console.log('  ✓ ' + name); } catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; } };

test('game lists 7 levels', () => assert.equal(levelsInJs.length, 7));
let total = 0;
for (const L of levelsInJs) {
  const file = path.join(root, 'games/data', `${L.id}.json`);
  test(`${L.id}: data file exists and parses`, () => assert.ok(fs.existsSync(file)));
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  total += d.pieces.length;
  test(`${L.id}: piece count matches the level card (${L.pieces})`, () => assert.equal(d.pieces.length, L.pieces));
  test(`${L.id}: board is 1000 wide with a sane height`, () => { assert.equal(d.board.w, 1000); assert.ok(d.board.h > 300 && d.board.h < 1600, `h=${d.board.h}`); });
  test(`${L.id}: every piece has id, name, path, centroid, bbox inside the board`, () => {
    const ids = new Set();
    for (const p of [...d.pieces, ...d.auto]) {
      assert.ok(p.id && !ids.has(p.id), `duplicate/missing id ${p.id}`); ids.add(p.id);
      assert.ok(p.name && p.d.startsWith('M'), `bad path for ${p.name}`);
      assert.ok(p.cx >= 0 && p.cx <= d.board.w && p.cy >= 0 && p.cy <= d.board.h, `${p.name} centroid off-board`);
      assert.ok(p.bbox[0] >= -0.5 && p.bbox[1] >= -0.5 && p.bbox[2] <= d.board.w + 0.5 && p.bbox[3] <= d.board.h + 0.5, `${p.name} bbox off-board ${p.bbox}`);
      assert.ok(p.area >= 0, `${p.name} has no area`);
    }
  });
  test(`${L.id}: draggable pieces are at least 14 units in both directions`, () => {
    for (const p of d.pieces) { assert.ok(p.area > 0, `${p.name} has no area`); assert.ok(p.bbox[2] - p.bbox[0] >= 14 && p.bbox[3] - p.bbox[1] >= 14, `${p.name} too small to drag`); }
  });
  test(`${L.id}: pieces are sorted largest first`, () => { for (let i = 1; i < d.pieces.length; i++) assert.ok(d.pieces[i - 1].area >= d.pieces[i].area); });
  test(`${L.id}: file stays under 300 KB`, () => assert.ok(fs.statSync(file).size < 300 * 1024));
}
test('world level has the sphere outline and exactly the 7 continents', () => {
  const d = JSON.parse(fs.readFileSync(path.join(root, 'games/data/world.json'), 'utf8'));
  assert.ok(d.sphere?.startsWith('M'));
  assert.deepEqual(d.pieces.map(p => p.name).sort(), ['Africa', 'Antarctica', 'Asia', 'Europe', 'North America', 'Oceania', 'South America']);
});
test('transcontinental countries sit with their capital', () => {
  const names = id => JSON.parse(fs.readFileSync(path.join(root, 'games/data', `${id}.json`), 'utf8')).pieces.map(p => p.name);
  const eu = names('europe'), asia = names('asia'), af = names('africa'), na = names('north-america');
  assert.ok(eu.includes('Russia') && !asia.includes('Russia'));
  for (const c of ['Turkey', 'Kazakhstan', 'Georgia', 'Azerbaijan', 'Indonesia']) assert.ok(asia.includes(c) && !eu.includes(c), c);
  assert.ok(af.includes('Egypt') && !asia.includes('Egypt'));
  assert.ok(na.includes('Panama') && na.includes('Greenland'));
});
test(`page copy quotes the real total (${total} pieces)`, () => assert.ok(html.includes(`${total} pieces`), `expected "${total} pieces" in piece-the-world.html`));
test('page keeps the no-inline-style rule (CSP)', () => assert.ok(!/<[a-z][^>]*\sstyle="/i.test(html)));
test('page bumps to the shared asset versions', () => {
  for (const [f, v] of [['css/style.css', 18], ['js/site-nav.js', 11], ['js/site-footer.js', 12]]) assert.ok(html.includes(`${f}?v=${v}`), `${f}?v=${v}`);
});
console.log(process.exitCode ? `\nsome of ${tests} tests failed` : `\nall ${tests} tests passed`);
