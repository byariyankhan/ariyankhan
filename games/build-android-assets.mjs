// The Android app's icons and splash, drawn from the same mark the game already has rather than exported by
// hand from anywhere. Run it after games/build-puzzle-icon.mjs, which is where the mark itself comes from.
//
//   node games/build-android-assets.mjs
//
// Writes into android/app/src/main/res: the launcher icon at every density, the adaptive-icon pair Android 8
// and up composes itself, and the splash Chrome holds up while the game paints.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');
const PAPER = '#F4EDE0';

// The densities Android asks for, and what a launcher icon measures at each.
const DENSITIES = [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]];

const shot = async (page, svgPath, size, out, pad = 0) => {
  const svg = fs.readFileSync(svgPath, 'utf8');
  const inner = Math.round(size * (1 - pad * 2));
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;width:${size}px;height:${size}px;background:${PAPER};
    display:grid;place-items:center;overflow:hidden}svg{width:${inner}px;height:${inner}px;display:block}</style>${svg}`);
  await page.waitForTimeout(80);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out, omitBackground: false });
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext({ deviceScaleFactor: 1 })).newPage();
const mark = path.join(ROOT, 'images', 'puzzle-brain-mark.svg');

// 1. The launcher icon, one per density.
for (const [d, px] of DENSITIES) await shot(page, mark, px, path.join(RES, `mipmap-${d}`, 'ic_launcher.png'), 0.08);

// 2. The adaptive icon: Android composes a background and a foreground and crops the pair to whatever shape
//    the launcher uses, so the mark has to sit inside the safe circle — 66% of the canvas — or a round
//    launcher will cut its edges off.
for (const [d, px] of DENSITIES) {
  const big = Math.round(px * 108 / 48);
  await shot(page, mark, big, path.join(RES, `mipmap-${d}`, 'ic_launcher_foreground.png'), 0.26);
}

// 3. The splash. Chrome holds this up, centred on the same paper, until the game has painted. 512 is plenty:
//    it is shown at the mark's own size, not stretched across the screen.
await shot(page, mark, 512, path.join(RES, 'drawable-xxhdpi', 'splash.png'), 0.22);
await browser.close();

// 4. The two XML files that tie the adaptive icon together, and the one-line drawable the splash is named by.
fs.mkdirSync(path.join(RES, 'mipmap-anydpi-v26'), { recursive: true });
fs.writeFileSync(path.join(RES, 'mipmap-anydpi-v26', 'ic_launcher.xml'),
`<?xml version="1.0" encoding="utf-8"?>
<!-- Android 8 and up composes the icon itself: our paper behind, the mark in front, cropped to whatever shape
     the launcher prefers. The mark is drawn at 66% of the canvas so a round crop does not clip it. -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/paper" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`);
fs.writeFileSync(path.join(RES, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'),
`<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/paper" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`);
const made = [];
for (const [d] of DENSITIES) made.push(`mipmap-${d}/ic_launcher.png`, `mipmap-${d}/ic_launcher_foreground.png`);
console.log(made.length + 2, 'files written under android/app/src/main/res, plus the splash');
