// Build the flag boards for Arrow Atlas: every level's flag (flag-icons, MIT, 4:3 SVGs) rendered to a 32x24 grid
// of palette indices, so the game can lay a flag under a rectangular board and reveal it as the arrows leave.
// Usage (from the repo root, one-off): npm i --no-save sharp flag-icons && node games/build-flags.mjs
// Then bump FLAGS_VERSION in js/arrow-atlas.js so edges drop the old file.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require('sharp');
const FLAGS = new URL('../' + (process.env.FLAG_DIR || 'node_modules/flag-icons/flags/4x3/'), import.meta.url).pathname;
const data = JSON.parse(fs.readFileSync(new URL('./data/arrow-atlas.json', import.meta.url), 'utf8'));
const OUT = new URL('./data/flags.json', import.meta.url).pathname;
const W = 32, H = 24, MAXCOL = 8;
const hex = ([r, g, b]) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const flags = {};
for (const L of data.levels) {
  const file = FLAGS + L.a2.toLowerCase() + '.svg';
  if (!fs.existsSync(file)) throw new Error('no flag for ' + L.name + ' (' + L.a2 + ')');
  // render at 8x the grid and average each cell (a plain point sample would miss thin stripes and emblems)
  const S = 8; const { data: px, info } = await sharp(file).resize(W * S, H * S, { fit: 'fill' }).flatten({ background: '#ffffff' }).raw().toBuffer({ resolveWithObject: true });
  const cells = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // the most common colour in the cell (quantised to 32 levels), not the mean: keeps emblem colours crisp
    const count = new Map();
    for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) { const i = ((y * S + dy) * info.width + (x * S + dx)) * info.channels; const key = ((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3); count.set(key, (count.get(key) || 0) + 1); }
    let best = null, n = 0; for (const [k, c] of count) if (c > n) { n = c; best = k; }
    cells.push([((best >> 10) & 31) * 8 + 4, ((best >> 5) & 31) * 8 + 4, (best & 31) * 8 + 4]);
  }
  // palette: cluster the cell colours (merge anything within 48), most used first, at most MAXCOL
  const clusters = [];
  for (const c of cells) { const k = clusters.find(cl => dist(cl.c, c) < 48); if (k) { k.n++; } else clusters.push({ c, n: 1 }); }
  clusters.sort((a, b) => b.n - a.n);
  const pal = clusters.slice(0, MAXCOL).map(cl => cl.c);
  const idx = c => { let best = 0, d = Infinity; pal.forEach((p, i) => { const e = dist(p, c); if (e < d) { d = e; best = i; } }); return best; };
  const rows = []; for (let y = 0; y < H; y++) rows.push(cells.slice(y * W, (y + 1) * W).map(idx).join(''));
  flags[L.a2] = { p: pal.map(hex), r: rows };
}
fs.writeFileSync(OUT, JSON.stringify({ version: 1, w: W, h: H, flags }));
console.log(Object.keys(flags).length, 'flags, bytes', fs.statSync(OUT).size);
// a quick look at a few
for (const a2 of ['BD', 'US', 'JP', 'NP', 'BR']) { const f = flags[a2]; console.log(a2, f.p.join(' ')); console.log(f.r.slice(0, 24).map(r => r.replace(/0/g, '.').replace(/1/g, '#').replace(/2/g, 'o').replace(/3/g, '+')).join('\n')); }
