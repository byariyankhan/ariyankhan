// Build the scene boards for Puzzle – Train Your Brain: big, plain shapes that exist to be full of arrows.
//
// A country board is the size the country is; a focus board is the size an object is. These are the size a
// long game is. The reference for them is a tall page packed edge to edge with long winding arrows -- a tower,
// a pair of towers with a gap between, an arena, a cross -- shapes whose only job is to hold as many arrows
// as a phone can show, so that one board takes a while to clear. They sit in the tour every few countries,
// one tier harder than the player's own, and a match may deal them too.
//
// The same two rules as the focus boards: M/L/Z only in the 0–100 box, and solid, because thin strokes
// rasterise into specks. Bigger targets than the focus boards, because the point is the size.
//
// Usage (from the repo root, no dependencies): node games/build-scene-boards.mjs
// Then bump SCENE_VERSION in js/puzzle.js so edges drop the old file.
import fs from 'node:fs';

const OUT = new URL('./data/scene-boards.json', import.meta.url).pathname;
const js = fs.readFileSync(new URL('../js/puzzle.js', import.meta.url), 'utf8');
const grab = re => { const m = js.match(re); if (!m) throw new Error('could not find ' + re); return m[0]; };
const { rasterise, REF } = new Function([grab(/const REF = \d+;/), grab(/function parsePath\(d\) \{[\s\S]*?\n  \}\n/), grab(/function insidePath\([\s\S]*?\n  \}\n/), grab(/function rasterise\([\s\S]*?\n  \}\n/), 'return { rasterise, REF };'].join('\n'))();

// Cells per tier: a good deal more than a focus board, and the frame a phone can still show. A tall board is
// allowed to be taller than it is wide, which is the shape of a phone.
const TARGETS = [160, 330, 540, 950, 1250];
const MAX_DIM_OF = [34, 34, 38, 46, 50], MAX_TALL_OF = [50, 50, 54, 62, 68], MAX_WIDE_OF = [40, 40, 44, 50, 54];

const f = v => String(Math.round(v * 10) / 10);
const ring = pts => 'M ' + pts.map(([x, y]) => `${f(x)} ${f(y)}`).join(' L ') + ' Z';
const arc = (cx, cy, r, a0, a1, n = 24) => Array.from({ length: n + 1 }, (_, i) => { const a = (a0 + (a1 - a0) * i / n) * Math.PI / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; });
const disc = (cx, cy, r, n = 48) => ring(arc(cx, cy, r, 0, 360 - 360 / n, n - 1));
const box = (x0, y0, x1, y1) => ring([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
const poly = (...xy) => ring(xy);
const join = (...ds) => ds.join(' ');

const SHAPES = [
  // The reference itself: one tall page of arrows.
  { id: 'tower', name: 'The Tower', d: box(22, 2, 78, 98) },
  // Two towers with a lane between them, which is the picture that started this.
  { id: 'towers', name: 'Twin Towers', d: join(box(6, 2, 46, 98), box(54, 6, 94, 98)) },
  // A ring: the outer disc with the inner one punched out of it.
  { id: 'arena', name: 'The Arena', d: join(disc(50, 50, 48), disc(50, 50, 20)) },
  { id: 'cross', name: 'The Cross', d: poly([36, 2], [64, 2], [64, 36], [98, 36], [98, 64], [64, 64], [64, 98], [36, 98], [36, 64], [2, 64], [2, 36], [36, 36]) },
  { id: 'diamond', name: 'The Diamond', d: poly([50, 1], [99, 50], [50, 99], [1, 50]) },
  // A stepped pyramid: wide at the foot, three steps up.
  { id: 'ziggurat', name: 'The Ziggurat', d: poly([2, 98], [2, 74], [16, 74], [16, 50], [30, 50], [30, 26], [42, 26], [42, 4], [58, 4], [58, 26], [70, 26], [70, 50], [84, 50], [84, 74], [98, 74], [98, 98]) },
  { id: 'hex', name: 'The Hexagon', d: ring(arc(50, 50, 49, 30, 330, 5)) },
  // A square frame, thick enough to be a board on every side.
  { id: 'frame', name: 'The Frame', d: join(box(2, 2, 98, 98), box(30, 30, 70, 70)) },
  // A bridge: a slab with an arch taken out from below.
  { id: 'bridge', name: 'The Bridge', d: join(box(2, 12, 98, 98), poly(...arc(50, 98, 30, 180, 360, 20).map(([x, y]) => [x, Math.min(y, 98.5)]))) },
  // Three bars on one foot: the comb.
  { id: 'comb', name: 'The Comb', d: poly([2, 98], [2, 2], [26, 2], [26, 68], [38, 68], [38, 2], [62, 2], [62, 68], [74, 68], [74, 2], [98, 2], [98, 98]) },
  // A tall H: two towers joined across the middle.
  { id: 'gate', name: 'The Gate', d: poly([4, 2], [30, 2], [30, 40], [70, 40], [70, 2], [96, 2], [96, 98], [70, 98], [70, 60], [30, 60], [30, 98], [4, 98]) },
  // A spiral square: a wide path that turns in on itself.
  { id: 'spiral', name: 'The Spiral', d: poly([2, 2], [98, 2], [98, 98], [26, 98], [26, 26], [74, 26], [74, 74], [50, 74], [50, 50], [62, 50], [62, 38], [38, 38], [38, 86], [86, 86], [86, 14], [2, 14]) },
];

function scaleFor(d, target, tier) {
  const probe = rasterise(d, 0.3);
  const tall = probe.h > probe.w * 1.5, wide = probe.w > probe.h * 1.5;
  const maxW = wide ? MAX_WIDE_OF[tier] : MAX_DIM_OF[tier], maxH = tall ? MAX_TALL_OF[tier] : MAX_DIM_OF[tier];
  let lo = 0.06, hi = Math.max(maxW, maxH) / REF, best = null;
  for (let i = 0; i < 18; i++) {
    const k = Math.round((lo + hi) / 2 * 1000) / 1000, m = rasterise(d, k);
    if (m.count < target) lo = k; else hi = k;
    if (m.w <= maxW && m.h <= maxH && (!best || Math.abs(m.count - target) < Math.abs(best.count - target))) best = m;
    if (hi - lo < 0.0015) break;
  }
  return best;
}

const boards = []; let bad = 0;
for (const s of SHAPES) {
  if (!/^[MLZ0-9 .-]+$/.test(s.d)) throw new Error(s.id + ': path is not M/L/Z');
  const masks = TARGETS.map((t, tier) => scaleFor(s.d, t, tier));
  const note = [];
  masks.forEach((m, t) => { if (!m || m.count < 100) note.push(`tier ${t}: ${m ? m.count : 'no'} cells`); });
  for (let t = 1; t < 5; t++) if (masks[t] && masks[t - 1] && masks[t].count < masks[t - 1].count) note.push(`tier ${t} smaller than ${t - 1}`);
  console.log(String(s.id).padEnd(10), masks.map(m => m ? `${String(m.count).padStart(4)} ${m.w}x${m.h}` : '—').join(' | '), note.length ? '  ⚠ ' + note.join(', ') : '');
  if (note.length) { bad++; continue; }
  boards.push({ id: s.id, name: s.name, d: s.d, k: masks.map(m => m.k) });
}
if (bad) throw new Error(bad + ' shape(s) do not make a playable board at every tier');
fs.writeFileSync(OUT, JSON.stringify({ version: 1, boards }));
console.log(`wrote ${boards.length} scene boards to ${OUT}`);
