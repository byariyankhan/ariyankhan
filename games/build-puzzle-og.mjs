// The card people see when the game is shared: 1200x630, the name, what it is, and the icon.
//
// Run:  node games/build-puzzle-og.mjs
// Writes images/puzzle-og.jpg and images/puzzle-og.webp. The webp comes out of the browser's own canvas
// encoder, because that is one fewer tool to install on whatever machine happens to be running this.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const ICON = fs.readFileSync(path.join(ROOT, 'puzzle', 'icons', 'icon.svg'), 'utf8')
  .replace('width="512" height="512"', 'width="400" height="400"');

const HTML = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@800;900&display=swap" rel="stylesheet">
<style>
html,body{margin:0;width:1200px;height:630px;background:#F4EDE0;font-family:Nunito,system-ui,sans-serif;color:#5B3F26;overflow:hidden}
.wrap{position:relative;width:1200px;height:630px}
.left{position:absolute;left:72px;top:0;height:630px;width:560px;display:flex;flex-direction:column;justify-content:center;gap:18px}
h1{font-size:104px;line-height:.92;margin:0;font-weight:900;letter-spacing:-2px}
h1 span{display:block;font-size:44px;letter-spacing:-.5px;color:#D9782A;margin-top:12px;font-weight:900}
p{font-size:28px;line-height:1.35;margin:0;color:#8A7358;font-weight:800}
.pill{display:inline-flex;gap:10px;margin-top:10px}
.pill b{background:#8446C2;color:#fff;border-radius:999px;padding:10px 22px;font-size:22px;font-weight:900}
.pill i{background:#fff;color:#5B3F26;border-radius:999px;padding:10px 22px;font-size:22px;font-weight:900;font-style:normal;box-shadow:0 4px 0 rgba(0,0,0,.08)}
.right{position:absolute;right:60px;top:60px;width:480px;height:510px;background:#fff;border-radius:36px;box-shadow:0 20px 50px rgba(0,0,0,.12);display:grid;place-items:center}
.right svg{border-radius:48px}
.brand{position:absolute;left:72px;bottom:36px;font-size:20px;color:#8A7358;font-weight:800}
</style></head><body><div class="wrap">
<div class="left"><h1>Puzzle<span>Train Your Brain</span></h1>
<p>Four brain games a day on real paintings, and arrow puzzles on 197 countries.</p>
<div class="pill"><b>Play free</b><i>No sign-up</i><i>No download</i></div></div>
<div class="right">${ICON}</div>
<div class="brand">ariyankhan.com/puzzle · by Ariyan Khan</div>
</div></body></html>`;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(HTML, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const jpg = path.join(ROOT, 'images', 'puzzle-og.jpg');
await page.screenshot({ path: jpg, type: 'jpeg', quality: 88 });

// Same pixels through the browser's webp encoder.
const dataUrl = await page.evaluate(async b64 => {
  const img = new Image();
  img.src = 'data:image/jpeg;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = 1200; c.height = 630;
  c.getContext('2d').drawImage(img, 0, 0);
  return c.toDataURL('image/webp', 0.9);
}, fs.readFileSync(jpg).toString('base64'));
fs.writeFileSync(path.join(ROOT, 'images', 'puzzle-og.webp'), Buffer.from(dataUrl.split(',')[1], 'base64'));
await browser.close();
for (const f of ['puzzle-og.jpg', 'puzzle-og.webp']) console.log('  images/' + f, fs.statSync(path.join(ROOT, 'images', f)).size + ' bytes');
