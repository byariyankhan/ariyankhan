// What search engines and AI crawlers are told about the game, held to what the game is.
// The round names come out of TRAIN_ROUNDS in js/puzzle.js itself, so renaming a round without the page, the
// FAQ, the llms files and the home card following fails here, and so does a round that no longer exists.
// Run: node tests/puzzle-seo.test.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
const root = path.resolve(new URL('.', import.meta.url).pathname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const js = read('js/puzzle.js');
const html = read('puzzle/index.html');
const shown = html.replace(/<!--[\s\S]*?-->/g, '');   // the page without its comments, which talk about the app freely
const home = read('index.html');
const llms = read('llms.txt');
const llmsFull = read('llms-full.txt');
const sitemap = read('sitemap.xml');
const htaccess = read('.htaccess');
const manifest = JSON.parse(read('puzzle/app.webmanifest'));
const css = read('css/puzzle.css');
const grab = re => { const m = js.match(re); if (!m) throw new Error('could not find ' + re); return m[0]; };
const TRAIN_ROUNDS = new Function(grab(/const TRAIN_ROUNDS = \[[\s\S]*?\n  \];/) + '\nreturn TRAIN_ROUNDS;')();
const ROUNDS = TRAIN_ROUNDS.map(r => r.name);
let tests = 0;
const test = (name, fn) => { tests++; try { fn(); console.log('  ✓ ' + name); } catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; } };

// what a reader sees of a piece of markup: tags out, entities decoded, white space as the browser collapses it
const text = s => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const meta = (attr, name) => { const m = html.match(new RegExp(`<meta\\s+${attr}="${name}"\\s+content="([^"]*)"`)); assert.ok(m, `no ${name}`); return text(m[1]); };
const title = text(html.match(/<title>([^<]*)<\/title>/)[1]);
const desc = meta('name', 'description');
const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => m[1]);
const ld = blocks.map(b => JSON.parse(b));
const graph = ld[0]?.['@graph'] || [];
const node = type => graph.find(n => [].concat(n['@type']).includes(type));
// the visible block: Settings > About > About Puzzle & FAQ
const about = (html.match(/<details class="aa-about-credit aa-about-game" id="aaAboutGame">([\s\S]*?)<\/details>/) || [])[1] || '';
const settings = html.slice(html.indexOf('id="aaSheet"'), html.indexOf('<script src="/js/puzzle.js'));
// every removed round, and the counts and claims the game no longer backs
const GONE = /flag memory|flag match|capital sprint|three short rounds|over 450|tap[- ]away/i;

console.log('The head');
test('the title fits a results page (60 characters at most) and says what the game is', () => {
  assert.ok(title.length <= 60, `title is ${title.length} characters`);
  assert.match(title, /^Puzzle – Train Your Brain/);
  assert.match(title, /brain training/i);
});
test('the description fits (160 characters at most) and names all four Daily Training rounds', () => {
  assert.ok(desc.length <= 160, `description is ${desc.length} characters`);
  assert.equal(ROUNDS.length, 4, 'four rounds in TRAIN_ROUNDS');
  for (const r of ROUNDS) assert.ok(desc.includes(r), `the description names ${r}`);
  assert.ok(desc.includes(`${JSON.parse(read('games/data/puzzle.json')).levels.length} countries`));
});
test('Open Graph and Twitter say the same thing, with a locale', () => {
  for (const r of ROUNDS) assert.ok(meta('property', 'og:description').includes(r), `og:description names ${r}`);
  assert.equal(meta('property', 'og:locale'), 'en_US');
  assert.match(meta('property', 'og:title'), /Daily Brain Training/);
  assert.match(meta('name', 'twitter:description'), /brain-training/);
});
test('the keywords are a handful of real phrases, not a list of variants', () => {
  const k = meta('name', 'keywords').split(',').map(s => s.trim());
  assert.ok(k.length <= 10, `${k.length} keywords`);
  assert.equal(new Set(k.map(s => s.toLowerCase())).size, k.length, 'no repeats');
});

console.log('\nOne address: https://ariyankhan.com/puzzle/');
test('the canonical has the slash, and nothing on the page points at the bare /puzzle', () => {
  assert.ok(html.includes('<link rel="canonical" href="https://ariyankhan.com/puzzle/" />'));
  assert.ok(!/https:\/\/ariyankhan\.com\/puzzle(?![\/\w.-])/.test(html), 'a self-URL without the slash');
  assert.equal(meta('property', 'og:url'), 'https://ariyankhan.com/puzzle/');
});
test('no hreflang: the page has one language, and the pair pointed at a redirect', () => assert.ok(!/hreflang=/.test(html)));
test('every JSON-LD @id, url and breadcrumb item on the game is under /puzzle/', () => {
  const urls = JSON.stringify(ld).match(/https:\/\/ariyankhan\.com\/puzzle[^"]*/g) || [];
  assert.ok(urls.length >= 8, `${urls.length} self-URLs`);
  for (const u of urls) assert.ok(u.startsWith('https://ariyankhan.com/puzzle/'), u);
});
test('the sitemap lists /puzzle/ with the slash, and the home image is the webp the page shows, without image:title', () => {
  assert.ok(sitemap.includes('<loc>https://ariyankhan.com/puzzle/</loc>'));
  assert.ok(!sitemap.includes('<image:title>'));
  assert.ok(sitemap.includes('<image:loc>https://ariyankhan.com/images/puzzle-og.webp</image:loc>'));
  assert.ok(home.includes('src="images/puzzle-og.webp"'));
});
test('.htaccess sends the bare /puzzle to https …/puzzle/ in one hop, before the missing-path 404', () => {
  const rule = htaccess.indexOf('RewriteRule ^puzzle$                     https://%{HTTP_HOST}/puzzle/ [R=301,L,NE]');
  assert.ok(rule > 0, 'the rule is there');
  assert.ok(rule > htaccess.indexOf('# ── Force HTTPS'), 'after the https rule');
  assert.ok(rule < htaccess.indexOf('## Missing paths'), 'before the 404 rule, which lets directories through to mod_dir');
  // and the redirects that were there still are
  for (const r of ['^arrow-atlas\\.html$', '^arrow-atlas-privacy\\.html$', '^arrow-atlas-terms\\.html$']) assert.ok(htaccess.includes(`RewriteRule ${r}`), r);
});

console.log('\nThe structured data');
test('one JSON-LD block, and it parses', () => { assert.equal(blocks.length, 1); assert.ok(graph.length >= 4); });
test('WebPage, VideoGame + WebApplication, FAQPage and BreadcrumbList; no MobileApplication until the Play listing is public', () => {
  for (const t of ['WebPage', 'VideoGame', 'WebApplication', 'FAQPage', 'BreadcrumbList']) assert.ok(node(t), t);
  assert.ok(!node('MobileApplication'), 'MobileApplication');
  assert.ok(!/android app|google play|play\.google\.com/i.test(shown), 'an Android app or Play claim');
  assert.ok(!/aggregateRating|"review"/.test(html), 'ratings that are not on the page');
});
test('the game is single player and multiplayer, free, and dated', () => {
  const g = node('VideoGame');
  assert.deepEqual(g.playMode, ['SinglePlayer', 'MultiPlayer']);
  assert.equal(g.isAccessibleForFree, true);
  assert.equal(g.offers.price, '0');
  assert.ok(!('numberOfPlayers' in g) || g.numberOfPlayers.maxValue > 1);
  const w = node('WebPage');
  assert.match(w.dateModified, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(w.dateModified >= w.datePublished);
  assert.equal(w.name, title, 'the WebPage is named like the title');
  assert.equal(w.description, desc, 'and described like the description');
});
test('the game names all four rounds, and its alternate names are names, not keywords', () => {
  const g = node('VideoGame');
  for (const r of ROUNDS) { assert.ok(g.description.includes(r), `description: ${r}`); assert.ok(g.featureList.some(f => f.startsWith(r + ':')), `featureList: ${r}`); }
  assert.ok(g.alternateName.length <= 3, g.alternateName.join(', '));
});
test('the board count claimed is true: "over 400 boards" and there are more than 400', () => {
  const n = f => Object.keys(JSON.parse(read(`games/data/${f}.json`)).boards).length;
  const boards = JSON.parse(read('games/data/puzzle.json')).levels.length + n('discover-boards') + n('scene-boards') + n('focus-boards');
  assert.ok(boards > 400, `${boards} boards`);
  assert.ok(/over 400 boards/i.test(html));
});
test('the paintings count is the gallery\'s', () => {
  const works = JSON.parse(read('games/data/art.json')).works.length;
  assert.ok(html.includes(`${works} public-domain`), `${works} works`);
});

console.log('\nWhat a crawler reads in the page');
test('the FAQPage quotes the visible questions and answers word for word', () => {
  const shown = [...about.matchAll(/<h4>([\s\S]*?)<\/h4>\s*<p>([\s\S]*?)<\/p>/g)].map(m => [text(m[1]), text(m[2])]);
  assert.ok(shown.length >= 5, `${shown.length} questions shown`);
  assert.deepEqual(node('FAQPage').mainEntity.map(q => [q.name, q.acceptedAnswer.text]), shown);
});
test('About Puzzle & FAQ is a folded row of Settings > About: in the markup for every crawler, shut for every player', () => {
  assert.ok(about, 'the block is there');
  assert.ok(settings.includes('id="aaAboutGame"'), 'inside the Settings page');
  assert.ok(!/<details[^>]*\sopen/.test(settings.match(/<details[^>]*id="aaAboutGame"[^>]*>/)[0]), 'folded shut');
  assert.match(about, /<summary class="aa-row aa-row--link">[\s\S]*About Puzzle &amp; FAQ/);
  assert.ok(!/\shidden\b|\sstyle=|sr-only|visually-hidden/.test(about), 'nothing in it is hidden by any other means');
  for (const r of ROUNDS) assert.ok(text(about).includes(r), `it names ${r}`);
  assert.ok(/\.aa-about-credit \+ \.aa-row\{/.test(css), 'the row after it keeps its divider');
});
test('nothing sits under the game: the page foot is still gone', () => {
  const tail = html.slice(html.indexOf('</main>'), html.indexOf('<!-- ── SIGN IN'));
  assert.ok(!/<(p|section|footer|div)\b/.test(tail.replace(/<!--[\s\S]*?-->/g, '')), 'no element between the app and the sheets');
});
test('a script-less reader gets one true sentence', () => {
  const ns = (html.match(/<noscript>([\s\S]*?)<\/noscript>/) || [])[1] || '';
  for (const r of ROUNDS) assert.ok(text(ns).includes(r), `noscript: ${r}`);
});
test('the h1 reads "Puzzle Train your brain." with a space', () => {
  assert.equal(text(html.match(/<h1 class="aa-title">([\s\S]*?)<\/h1>/)[1]), 'Puzzle Train your brain.');
});
test('interface text stays out of snippets: data-nosnippet on the gate, splash, sign-in sheet, session and developer groups, not on Settings', () => {
  for (const id of ['aaGate', 'aaSplash', 'aaSignInSheet', 'aaSessionGroup', 'aaDevGroup']) assert.match(html, new RegExp(`<div[^>]*id="${id}"[^>]*\\sdata-nosnippet[\\s>]`), id);
  assert.ok(!/<div[^>]*id="aaSheet"[^>]*data-nosnippet/.test(html), '#aaSheet holds the FAQ');
  assert.ok(!/data-nosnippet/.test(about), 'nor anything in the FAQ');
});

console.log('\nEverywhere else the game is described');
test('the home card, llms.txt, llms-full.txt and the noscript name all four rounds', () => {
  const card = home.slice(home.indexOf('<a class="game-card" href="/puzzle/">'), home.indexOf('</a>', home.indexOf('<a class="game-card" href="/puzzle/">')));
  for (const [where, s] of [['home card', text(card)], ['llms.txt', llms], ['llms-full.txt', llmsFull]])
    for (const r of ROUNDS) assert.ok(s.replace(/'/g, '’').includes(r.replace(/'/g, '’')), `${where}: ${r}`);
});
test('no removed round, stale count or borrowed name anywhere the game is described', () => {
  for (const [where, s] of [['page', html], ['home', home], ['llms.txt', llms], ['llms-full.txt', llmsFull], ['manifest', manifest.description]])
    assert.ok(!GONE.test(s), `${where}: ${s.match(GONE)?.[0]}`);
});
test('llms-full.txt: the metadata remover\'s paragraph sits under its own line, not under Puzzle\'s', () => {
  const at = llmsFull.indexOf('- AI Metadata Remover: https://ariyankhan.com/ai-metadata-remover.html\n');
  assert.ok(at >= 0);
  assert.ok(llmsFull.slice(at).split('\n')[1].includes('Free, browser-only tool that removes C2PA'));
  const pz = llmsFull.indexOf('- Puzzle – Train Your Brain (daily brain training');
  assert.ok(llmsFull.slice(pz).split('\n')[1].includes('brain-training game'));
});
test('offline is claimed only for the solo boards, and the manifest describes the game of today', () => {
  // Daily Training fetches its paintings and online play needs the network: "offline" comes after "solo"
  for (const [where, s] of [['page', shown], ['home', home], ['manifest', manifest.description]])
    for (const m of s.matchAll(/offline/gi)) assert.match(s.slice(Math.max(0, m.index - 90), m.index), /solo/i, `${where}: …${s.slice(Math.max(0, m.index - 60), m.index + 7)}`);
  assert.match(manifest.description, /brain training/i);
  assert.ok(manifest.description.length <= 300);
});
test('no health or cognitive claims: the Brain Score is a game score', () => {
  const all = [html, home, llms, llmsFull, manifest.description].join('\n');
  assert.ok(!/improves? (your )?(memory|focus|brain)|clinically|proven to|scientifically|\bIQ\b|prevents? (decline|dementia)|cognitive (benefit|decline)/i.test(all));
});
test('The Met is a source, not a partner', () => {
  const all = [html, home, llms, llmsFull].join('\n');
  assert.ok(!/(partner(ship)?|in association|official) (with|of) (the )?(Met|Metropolitan)/i.test(all));
  assert.ok(!/<img[^>]*met(museum)?[-_ ]?logo/i.test(all));
});

console.log(process.exitCode ? `\nsome of ${tests} tests failed` : `\nall ${tests} tests passed`);
