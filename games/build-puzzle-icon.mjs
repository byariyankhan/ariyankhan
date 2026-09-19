// The game's icon, drawn rather than stored: the brain the game already puts on its focus bar, with two of its
// own arrows inside it. The name is "Puzzle – Train Your Brain"; the picture says both halves of that.
//
// Run:  node games/build-puzzle-icon.mjs
// Writes puzzle/icons/: the two SVG sources and every size the manifest, the tab and iOS ask for.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'puzzle', 'icons');
const PAPER = '#F4EDE0', INK = '#2E2016', ORANGE = '#D9782A', PURPLE = '#8446C2';

// The game's own brain, in its 32-unit box: two lobes and the line between them.
const LOBE_L = 'M15 7.5c-2.2-2-5.6-1.6-6.8.7-2.4.3-3.7 2.4-3 4.4-1.8 1.5-1.5 4.2.5 5.2-.4 2.3 1.5 4.2 3.8 4 .8 2 3.5 2.6 5.3 1.1';
const LOBE_R = 'M17 7.5c2.2-2 5.6-1.6 6.8.7 2.4.3 3.7 2.4 3 4.4 1.8 1.5 1.5 4.2-.5 5.2.4 2.3-1.5 4.2-3.8 4-.8 2-3.5 2.6-5.3 1.1';
const SPLIT  = 'M16 7.4v15.6';

// One of the board's arrows: a stem and the same triangular head, pointing along `deg`.
const arrow = (x, y, len, w, deg, colour) => {
  const head = w * 1.6;
  return `<g transform="translate(${x} ${y}) rotate(${deg})" stroke="${colour}" stroke-linecap="round" stroke-linejoin="round">
    <path d="M${-len / 2} 0 H${len / 2 - head}" stroke-width="${w}" fill="none"/>
    <path d="M${len / 2 - head} ${-head * 0.8} L${len / 2} 0 L${len / 2 - head} ${head * 0.8} Z" fill="${colour}" stroke-width="${w * 0.6}"/>
  </g>`;
};

// `shrink` pulls the drawing away from the edges for the maskable icon, whose corners the platform crops.
function icon({ shrink = 1, round = 96 } = {}) {
  const k = shrink, c = 256, s = n => (c + (n - c) * k).toFixed(1);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${round}" fill="${PAPER}"/>
  <g transform="translate(${(c * (1 - k)).toFixed(1)} ${(c * (1 - k)).toFixed(1)}) scale(${(16 * k).toFixed(3)})"
     fill="none" stroke="${INK}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
    <path d="${LOBE_L}"/><path d="${LOBE_R}"/><path d="${SPLIT}"/>
  </g>
  ${arrow(+s(176), +s(232), 104 * k, 26 * k, 0, ORANGE)}
  ${arrow(+s(336), +s(300), 104 * k, 26 * k, 180, PURPLE)}
</svg>`;
}

fs.mkdirSync(OUT, { recursive: true });
const sources = [['icon.svg', icon(), [96, 180, 192, 512]], ['icon-maskable.svg', icon({ shrink: 0.74, round: 0 }), [512]]];
for (const [name, src] of sources) fs.writeFileSync(path.join(OUT, name), src);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
for (const [name, src, sizes] of sources) {
  for (const size of sizes) {
    const ctx = await browser.newContext({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.setContent(`<body style="margin:0">${src.replace('width="512" height="512"', `width="${size}" height="${size}"`)}</body>`);
    await page.waitForTimeout(120);
    const file = name === 'icon.svg' ? `puzzle-${size}.png` : `puzzle-maskable-${size}.png`;
    await page.screenshot({ path: path.join(OUT, file) });
    await ctx.close();
    console.log('  ' + file);
  }
}
await browser.close();
