// Build the focus boards for Puzzle – Train Your Brain: the boards a new player clears before the world tour
// ever starts. A country board says something about a place; these say something about the game. They are the
// game's own language — a brain, a lightbulb, a key, a gear, a puzzle piece — so the first thing a player taps
// looks like the thing the game is called.
//
// Two rules decide every shape here.
//
//   1. M/L/Z only, absolute, in the same 0–100 box as a country outline, because that is the one path form the
//      game's parser reads (parsePath in js/puzzle.js). Curves are sampled into straight runs here, at build
//      time, so nothing in the game has to change.
//   2. Solid and chunky. The generator fills a silhouette with arrows: a shape made of thin strokes rasterises
//      into specks, and specks are dropped. Holes are fine — a hole is wide — but a band has to stay a few
//      cells thick at the coarsest tier.
//
// Every ring is traced without crossing itself, because the mask test (insidePath) is even-odd: two rings that
// overlap punch a hole out of each other. Rings that only touch are fine, and a ring inside another ring is how
// a hole is made (the gear's hub, the padlock's keyhole, the eye's pupil).
//
// Usage (from the repo root, no dependencies): node games/build-focus-boards.mjs
// Then bump FOCUS_VERSION in js/puzzle.js so edges drop the old file.
import fs from 'node:fs';

const OUT = new URL('./data/focus-boards.json', import.meta.url).pathname;
const js = fs.readFileSync(new URL('../js/puzzle.js', import.meta.url), 'utf8');
const grab = re => { const m = js.match(re); if (!m) throw new Error('could not find ' + re); return m[0]; };
// The scales are chosen with the game's own rasteriser, lifted out of the game, so a board is the same here as
// it is under a player's finger.
const { rasterise, REF } = new Function([grab(/const REF = \d+;/), grab(/function parsePath\(d\) \{[\s\S]*?\n  \}\n/), grab(/function insidePath\([\s\S]*?\n  \}\n/), grab(/function rasterise\([\s\S]*?\n  \}\n/)].join('\n') + '\nreturn { rasterise, REF };')();
const TARGETS = [110, 240, 400, 700, 900], MAX_DIM_OF = [32, 32, 32, 40, 44], MAX_TALL_OF = [46, 46, 46, 54, 58], MAX_WIDE_OF = [38, 38, 38, 46, 50];

// ── Drawing ──────────────────────────────────────────────────────────────────────────────────────
// Angles are degrees and y runs down the screen, so 0° points right, 90° down, 270° up. An arc sweeps from a0
// to a1 the short way round the numbers: to go over the top of a circle, sweep through 270 (or through -90).
const f = v => String(Math.round(v * 10) / 10);
const ring = pts => 'M ' + pts.map(([x, y]) => `${f(x)} ${f(y)}`).join(' L ') + ' Z';
const arc = (cx, cy, r, a0, a1, n = 24) => Array.from({ length: n + 1 }, (_, i) => { const a = (a0 + (a1 - a0) * i / n) * Math.PI / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; });
const disc = (cx, cy, r, n = 40) => ring(arc(cx, cy, r, 0, 360 - 360 / n, n - 1));
const box = (x0, y0, x1, y1) => ring([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
const poly = (...xy) => ring(xy);

// The brain, seen from the side, the way an anatomy plate draws it — and traced by hand rather than generated.
// Every procedural fold (evenly spaced bumps on the outline, however tuned) comes out as a flower or a
// cauliflower, because what makes a cortex read is that the gyri are all different sizes and the sulci between
// them cut in at their own angles. So the vertices below are placed one at a time: out for a gyrus, in for a
// sulcus, up the front, over the top, down the back; then the fissure over the cerebellum, the cerebellum's
// finer folia, the stem, the underside of the temporal lobe, and the lateral fissure back to the frontal pole.
//
// Two of those are slits rather than wedges — the lateral fissure and the one over the cerebellum — which the
// rasteriser cannot hold at board sizes and does not need to: the home screen draws this path itself, under the
// arrows (renderBrain in js/puzzle.js), so the folds and the fissures are carried at the size they were drawn
// at. What the raster keeps is the silhouette, which is what a board is.
//
// Chaikin twice turns the traced corners into folds. It is done here because the game's parser reads straight
// segments only, and a corner-cutting pass is a curve in the one form it can read.
function chaikin(pts, passes = 2) {
  let p = pts;
  for (let n = 0; n < passes; n++) {
    const out = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    p = out;
  }
  return p;
}

function brain() {
  const traced = [
    [8, 45], [4, 38], [11, 34], [5, 28], [13, 24], [11, 18],                              // up the front
    [18, 16], [16, 9], [23, 14], [30, 6], [35, 13], [41, 4], [46, 12],                     // over the top: gyrus, sulcus, gyrus
    [52, 4], [57, 12], [64, 5], [69, 13], [76, 9], [80, 18],
    [86, 16], [87, 25], [93, 27], [88, 34], [95, 40], [89, 46], [92, 53],                  // down the back to the occipital pole
    [80, 57], [74, 58.5], [82, 58], [88, 58.5],                                            // the fissure over the cerebellum, in and out
    [90, 63], [86, 65], [89, 70], [84, 72], [86, 77], [80, 78], [80, 82], [73, 81], [71, 85], [64, 84], [60, 80],
    [57, 74], [57, 83], [56, 90], [44, 90], [43, 81], [45, 72],                            // the stem, which is smooth in life too
    [41, 77], [37, 72], [31, 77], [27, 72], [21, 71], [17, 65], [15, 60],                  // forward along the temporal lobe
    [14, 56], [26, 51.5], [32, 48.5], [36, 46.5], [30, 48], [22, 50], [11, 51],            // the lateral fissure, in and back out
  ];
  // A brain is half again as wide as it is tall; traced upright it comes out too round.
  return ring(chaikin(traced.map(([x, y]) => [x, 50 + (y - 47) * 0.86])));
}

// A cog: ten teeth on a ring, one closed outline, with the hub punched out.
function gear(cx = 50, cy = 50, rOut = 48, rIn = 36, teeth = 10, hub = 14) {
  const half = Math.PI / teeth, pts = [];
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2 - Math.PI / 2;
    const at = (r, t) => [cx + r * Math.cos(t), cy + r * Math.sin(t)];
    pts.push(at(rIn, a - half * 0.58), at(rOut, a - half * 0.36), at(rOut, a + half * 0.36), at(rIn, a + half * 0.58));
  }
  return ring(pts) + ' ' + disc(cx, cy, hub, 28);
}

// A five-pointed star, points out and the notches at 0.42 of the radius.
function star(cx, cy, rOut, rIn, arms = 5) {
  const pts = [];
  for (let i = 0; i < arms * 2; i++) { const a = (i / (arms * 2)) * Math.PI * 2 - Math.PI / 2, r = i % 2 ? rIn : rOut; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return ring(pts);
}

// Concentric square bands: the labyrinth. The bands are wide on purpose — at the easiest tier the whole board is
// only about sixteen cells across, and a band any thinner than this would rasterise into dots.
function labyrinth(insets = [1, 15, 29, 43]) {
  return insets.map(i => box(i, i, REF - i, REF - i)).join(' ');
}

// ── The shapes ───────────────────────────────────────────────────────────────────────────────────
// The order is the order a new player meets them: what the game is about first (a brain, a light, a key, a cog,
// a piece), then the rest of the same vocabulary.
const SHAPES = [
  { id: 'brain', name: 'Brain', d: brain() },

  // A bulb: the glass in one arc over the top, a short neck, a wide screw base. One ring, no thin parts.
  { id: 'bulb', name: 'Lightbulb', d: ring([
    ...arc(50, 36, 31, 130, 410, 48),
    [64, 62], [64, 69], [67, 73], [67, 79], [33, 79], [33, 73], [36, 69], [36, 62],
  ]) + ' ' + box(34, 82, 66, 90) + ' ' + poly([37, 93], [63, 93], [58, 99], [42, 99]) },

  // A key: a round bow with its hole, a shaft, two teeth hanging off the end.
  { id: 'key', name: 'Key', d: ring([
    ...arc(28, 50, 25, 20, 340, 40),
    [94, 40], [94, 60], [87, 60], [87, 78], [78, 78], [78, 60], [69, 60], [69, 78], [60, 78], [60, 60],
  ]) + ' ' + disc(28, 50, 9, 24) },

  { id: 'gear', name: 'Gear', d: gear() },

  // A jigsaw piece: a tab bulging off the top edge, a socket pressed into the left one. The tab sits low enough
  // that the bulge is inside the box — anything above the top edge would simply be cut off the board.
  { id: 'piece', name: 'Puzzle piece', d: ring([
    [16, 16], [37, 16], ...arc(50, 16, 13, 180, 360, 20), [88, 16], [88, 90], [16, 90],
    [16, 64], ...arc(16, 51, 13, 90, -90, 20), [16, 16],
  ]) },

  // The face of a puzzle cube: nine blocks, each its own ring, touching nowhere.
  { id: 'cube', name: 'Puzzle cube', d: [0, 1, 2].flatMap(r => [0, 1, 2].map(c => box(4 + c * 32, 4 + r * 32, 32 + c * 32, 32 + r * 32))).join(' ') },

  // A magnifier: a thick lens ring and a handle out of the bottom right.
  { id: 'glass', name: 'Magnifying glass', d: ring([
    ...arc(42, 40, 38, 52, 412, 48), [86, 74], [98, 86], [88, 96], [76, 84],
  ]) + ' ' + disc(42, 40, 19, 30) },

  { id: 'maze', name: 'Labyrinth', d: labyrinth() },

  // A padlock: the body, the shackle over it, the gap under the shackle and the keyhole as holes.
  { id: 'lock', name: 'Padlock', d: ring([
    [14, 94], [86, 94], [86, 44], [77, 44], ...arc(50, 44, 27, 0, -180, 26), [14, 44],
  ]) + ' ' + ring([...arc(50, 44, 15, 0, -180, 20)]) + ' ' + disc(50, 62, 8, 24) + ' ' + poly([46, 68], [54, 68], [57, 84], [43, 84]) },

  // A book held open: two solid pages, a gap down the spine.
  { id: 'book', name: 'Open book', d: poly([6, 14], [26, 8], [46, 16], [46, 92], [26, 84], [6, 90])
    + ' ' + poly([54, 16], [74, 8], [94, 14], [94, 90], [74, 84], [54, 92]) },

  // A pencil: the sharpened point, the body, and the eraser under the ferrule.
  { id: 'pencil', name: 'Pencil', d: poly([50, 2], [67, 28], [67, 72], [33, 72], [33, 28])
    + ' ' + box(33, 75, 67, 82) + ' ' + poly([34, 85], [66, 85], [66, 94], [60, 99], [40, 99], [34, 94]) },

  { id: 'star', name: 'Star', d: star(50, 52, 49, 25) },

  // An eye, wide open: the two lids are arcs of the same circle, mirrored, meeting at the corners; the pupil is
  // a hole. Wide and shallow, the way an eye is — a rounder one reads as a lens.
  { id: 'eye', name: 'Eye', d: ring([...arc(50, 64.1, 48.1, 197, 343, 44), ...arc(50, 35.9, 48.1, 17, 163, 44)])
    + ' ' + disc(50, 50, 15, 28) },

  { id: 'bolt', name: 'Lightning', d: poly([62, 2], [24, 54], [45, 54], [34, 98], [78, 40], [54, 40], [70, 2]) },

  // A stopwatch: the case, the crown and two buttons, the hands punched out of the dial.
  { id: 'clock', name: 'Stopwatch', d: ring([...arc(50, 56, 42, 0, 359, 48)])
    + ' ' + box(42, 4, 58, 16) + ' ' + poly([24, 14], [34, 22], [26, 30], [17, 21])
    + ' ' + poly([76, 14], [83, 21], [74, 30], [66, 22])
    + ' ' + poly([46, 26], [54, 26], [54, 56], [46, 60]) + ' ' + poly([54, 52], [78, 52], [78, 60], [54, 60]) },

  { id: 'hourglass', name: 'Hourglass', d: ring([
    [12, 4], [88, 4], [88, 17], [74, 17], [74, 30], [56, 48], [56, 52], [74, 70], [74, 83], [88, 83], [88, 96],
    [12, 96], [12, 83], [26, 83], [26, 70], [44, 52], [44, 48], [26, 30], [26, 17], [12, 17],
  ]) },

  // Three bars, each taller than the last: the shape of getting better at something.
  { id: 'chart', name: 'Progress', d: box(6, 62, 32, 96) + ' ' + box(37, 36, 63, 96) + ' ' + box(68, 8, 94, 96) },

  { id: 'weight', name: 'Dumbbell', d: box(4, 34, 19, 66) + ' ' + box(21, 26, 38, 74) + ' ' + box(40, 42, 60, 58)
    + ' ' + box(62, 26, 79, 74) + ' ' + box(81, 34, 96, 66) },

  { id: 'ladder', name: 'Ladder', d: box(8, 2, 26, 98) + ' ' + box(74, 2, 92, 98)
    + ' ' + box(28, 12, 72, 26) + ' ' + box(28, 38, 72, 52) + ' ' + box(28, 64, 72, 78) },

  // A die showing five: the pips are holes.
  { id: 'dice', name: 'Dice', d: box(4, 4, 96, 96) + ' ' + [[27, 27], [73, 27], [50, 50], [27, 73], [73, 73]].map(([x, y]) => disc(x, y, 10, 22)).join(' ') },

  { id: 'flask', name: 'Flask', d: ring([
    [38, 4], [62, 4], [62, 34], [92, 92], [88, 98], [12, 98], [8, 92], [38, 34],
  ]) },

  // A chess knight, facing left: ears, muzzle, mane and the plinth it stands on.
  { id: 'knight', name: 'Knight', d: ring([
    [58, 4], [66, 16], [62, 20], [70, 24], [78, 36], [82, 52], [80, 68], [76, 80], [86, 86], [88, 96], [18, 96],
    [22, 84], [32, 74], [38, 62], [34, 56], [22, 60], [12, 58], [8, 48], [16, 34], [30, 24], [42, 18], [40, 6], [48, 14],
  ]) },

  // A medal on its ribbon: the ribbon stops where the disc starts, so nothing overlaps.
  { id: 'medal', name: 'Medal', d: poly([20, 2], [38, 2], [56, 40], [38, 44], [20, 40])
    + ' ' + poly([62, 2], [80, 2], [80, 40], [62, 44], [44, 40])
    + ' ' + ring([...arc(50, 68, 30, 0, 359, 40)]) + ' ' + star(50, 68, 18, 8) },

  { id: 'trophy', name: 'Trophy', d: ring([
    [24, 6], [76, 6], [76, 30], [72, 46], [58, 56], [58, 70], [70, 70], [74, 80], [78, 94], [22, 94], [26, 80], [30, 70], [42, 70], [42, 56], [28, 46], [24, 30],
  ]) + ' ' + poly([6, 10], [20, 10], [20, 36], [10, 30], [6, 20])
    + ' ' + poly([80, 10], [94, 10], [94, 20], [90, 30], [80, 36]) },

  // A rocket, nose to flame in one ring: the fins grow out of the body rather than floating beside it.
  { id: 'rocket', name: 'Rocket', d: ring([
    [50, 2], [61, 16], [68, 36], [69, 58], [88, 74], [90, 90], [69, 79], [66, 88], [58, 96], [42, 96], [34, 88],
    [31, 79], [10, 90], [12, 74], [31, 58], [32, 36], [39, 16],
  ]) },

  // A head in profile with a cog where the thinking happens.
  { id: 'head', name: 'Thinking head', d: ring([
    [56, 4], [72, 10], [82, 22], [86, 38], [84, 50], [92, 58], [88, 64], [80, 66], [78, 78], [70, 84], [70, 96],
    [30, 96], [30, 76], [18, 62], [12, 44], [16, 26], [28, 12], [42, 5],
  ]) + ' ' + gear(50, 42, 22, 16, 8, 6) },
];

// ── Scales ───────────────────────────────────────────────────────────────────────────────────────
// One scale per tier, chosen the same way the discovery boards choose theirs: the smallest grid that reaches the
// tier's arrow count without growing past the tier's board size.
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
  masks.forEach((m, t) => { if (!m || m.count < 60) note.push(`tier ${t}: ${m ? m.count : 'no'} cells`); });
  for (let t = 1; t < 5; t++) if (masks[t] && masks[t - 1] && masks[t].count < masks[t - 1].count) note.push(`tier ${t} smaller than ${t - 1}`);
  console.log(String(s.id).padEnd(10), masks.map(m => m ? `${String(m.count).padStart(3)} ${m.w}x${m.h}` : '—').join(' | '), note.length ? '  ⚠ ' + note.join(', ') : '');
  if (note.length) { bad++; continue; }
  boards.push({ id: s.id, name: s.name, d: s.d, k: masks.map(m => m.k) });
}
if (bad) throw new Error(bad + ' shape(s) do not make a playable board at every tier');

// ── The emblem ───────────────────────────────────────────────────────────────────────────────────
// The brain on the home screen is the same brain, drawn by the same generator, at its own five scales: a
// board nobody plays, so it is coarser than one that is dealt (thirty-odd arrows at Easy, ninety at Master).
// What it says is the player's own difficulty — the better they get, the finer their brain is drawn.
const EMBLEM_TARGETS = [150, 220, 300, 400, 520], EMBLEM_MAX = 34;
const brainShape = SHAPES.find(s => s.id === 'brain');
const emblemMasks = EMBLEM_TARGETS.map(t => {
  let lo = 0.06, hi = EMBLEM_MAX / REF, best = null;
  for (let i = 0; i < 18; i++) {
    const k = Math.round((lo + hi) / 2 * 1000) / 1000, m = rasterise(brainShape.d, k);
    if (m.count < t) lo = k; else hi = k;
    if (m.w <= EMBLEM_MAX && m.h <= EMBLEM_MAX && (!best || Math.abs(m.count - t) < Math.abs(best.count - t))) best = m;
    if (hi - lo < 0.0015) break;
  }
  return best;
});
console.log('emblem    ', emblemMasks.map(m => `${m.count} ${m.w}x${m.h}`).join(' | '));
const emblem = { d: brainShape.d, k: emblemMasks.map(m => m.k) };

fs.writeFileSync(OUT, JSON.stringify({ version: 2, boards, emblem }));
console.log(boards.length, 'focus boards, bytes', fs.statSync(OUT).size);
