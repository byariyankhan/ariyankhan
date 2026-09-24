// The Android app's icons and splash, drawn from the same mark the game already has rather than exported by
// hand from anywhere. Run it after games/build-puzzle-icon.mjs, which is where the mark itself comes from.
//
//   node games/build-android-assets.mjs
//
// Writes into android/app/src/main/res: the launcher icon at every density, the adaptive-icon pair Android 8
// and up composes itself, and the brain Android's splash screen draws (one per theme).
//
//   node games/build-android-assets.mjs --splash   only the splash brains, which need no browser
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

// 0. The splash brain, as a vector, in the ink of each theme (colors.xml). Android draws a splash icon on a
//    288 dp canvas (no icon background) and shows the middle 192 dp of it; the brain's own 512-unit box is put in
//    the middle 96 dp of that canvas, which is exactly how big and where the web opening draws the same drawing
//    (.aa-splash-mark in css/puzzle.css: 96 px, centred). A CSS pixel is a dp in the WebView, so when the page
//    takes over from the phone's splash, the brain does not move by a pixel. The paths are the mark's own, the
//    strokes as one path and the arrowheads as another, as the page draws them.
const svgMark = fs.readFileSync(path.join(ROOT, 'images', 'puzzle-brain-mark.svg'), 'utf8');
const marks = [...svgMark.matchAll(/<path d="([^"]+)"( fill="#2E2016" stroke="none")?\/>/g)];
const strokeD = marks.filter(m => !m[2]).map(m => m[1]).join('');
const fillD = marks.filter(m => m[2]).map(m => m[1].replace(/ /g, '')).join('');
const strokeW = (/stroke-width="([\d.]+)"/.exec(svgMark) || [])[1];
if (!strokeD || !fillD || !strokeW) throw new Error('images/puzzle-brain-mark.svg is not the shape this expects');
for (const [name, ink] of [['splash_mark', 'ink'], ['splash_mark_night', 'ink_night'], ['splash_mark_mint', 'ink_mint']]) {
  fs.mkdirSync(path.join(RES, 'drawable'), { recursive: true });
  fs.writeFileSync(path.join(RES, 'drawable', name + '.xml'),
`<?xml version="1.0" encoding="utf-8"?>
<!-- Written by games/build-android-assets.mjs from images/puzzle-brain-mark.svg; edit that, not this.
     The splash screen's brain: a 288 dp canvas with the mark's 512-unit box in the middle 96 dp, which is where
     and how big the web opening draws it (.aa-splash-mark in css/puzzle.css). -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="288dp"
    android:height="288dp"
    android:viewportWidth="1536"
    android:viewportHeight="1536">
    <group android:translateX="512" android:translateY="512">
        <path
            android:pathData="${strokeD}"
            android:strokeColor="@color/${ink}"
            android:strokeWidth="${strokeW}"
            android:strokeLineCap="round"
            android:strokeLineJoin="round" />
        <path
            android:pathData="${fillD}"
            android:fillColor="@color/${ink}" />
    </group>
</vector>
`);
}
if (process.argv.includes('--splash')) { console.log('3 splash brains written under android/app/src/main/res/drawable'); process.exit(0); }

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

await browser.close();

// 3. The two XML files that tie the adaptive icon together. (The splash is step 0: a vector, no browser needed.)
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
console.log(made.length + 2, 'files written under android/app/src/main/res, plus the 3 splash brains');
