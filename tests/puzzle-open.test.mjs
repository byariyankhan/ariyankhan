// The opening: one surface from the app's splash to home, the line typed with keys under it, the terms on a first
// open, and the app's own splash that has to hand over to it unseen. Pure checks on the exact production code:
// the two inline scripts in puzzle/index.html, the opening and the sounds in js/puzzle.js, the service worker's
// way into the game, and the Android shell's resources and splash wiring.
// Run: node tests/puzzle-open.test.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
const root = path.resolve(new URL('.', import.meta.url).pathname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const js = read('js/puzzle.js'), html = read('puzzle/index.html'), css = read('css/puzzle.css'), sw = read('puzzle/sw.js');
const RES = 'android/app/src/main/res/';
const colorsXml = read(RES + 'values/colors.xml'), themesXml = read(RES + 'values/themes.xml'), layoutXml = read(RES + 'layout/activity_main.xml');
const keepXml = read(RES + 'raw/keep.xml'), manifestXml = read('android/app/src/main/AndroidManifest.xml'), gradle = read('android/app/build.gradle');
const mainJava = read('android/app/src/main/java/com/ariyankhan/puzzle/MainActivity.java'), ciYml = read('.github/workflows/android-build.yml');
const assets = read('games/build-android-assets.mjs'), webmanifest = JSON.parse(read('puzzle/app.webmanifest'));
const markSvg = read('images/puzzle-brain-mark.svg');
const grab = (src, re) => { const m = src.match(re); if (!m) throw new Error('could not find ' + re); return m[0]; };
let tests = 0;
const test = (name, fn) => { tests++; try { fn(); console.log('  ✓ ' + name); } catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; } };
const later = [];
const atest = (name, fn) => later.push([name, fn]);

// The two inline scripts: the plan (in <head>) and the typing (after #aaSplash).
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const [HEAD, TYPING] = inline;
const openingPlan = new Function(grab(HEAD, /function openingPlan\(s\) \{[\s\S]*?\n      \}\n/) + 'return openingPlan;')();
const typeSchedule = new Function(grab(TYPING, /function typeSchedule\(text, opt\) \{[\s\S]*?\n      \}\n/) + 'return typeSchedule;')();
const QUOTES = new Function(grab(TYPING, /var QUOTES = \[[\s\S]*?\];/) + 'return QUOTES;')();
const T = new Function('var o = {};' + grab(TYPING, /var T = o\.T = \{[^}]*\};/) + 'return T;')();

// The head script, run whole against a stand-in page, as the browser runs it before the first paint.
const UA_WEB = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const UA_APP1 = UA_WEB.replace('Pixel 7)', 'Pixel 7; wv)') + ' PuzzleApp/1';
const UA_APP2 = UA_APP1.replace('PuzzleApp/1', 'PuzzleApp/2');
function runHead({ hash = '', search = '', ua = UA_WEB, ls = {}, ss = {}, calm = false, now = null, broken = false } = {}) {
  const store = new Map(Object.entries(ls).map(([k, v]) => ['aa:v1:' + k, JSON.stringify(v)])), session = new Map(Object.entries(ss));
  const meta = { content: '#F4EDE0', setAttribute(k, v) { this[k] = v; } };
  const rootEl = { className: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const win = {};
  const local = broken ? { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } } : { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)) };
  const sess = broken ? { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } } : { getItem: k => session.has(k) ? session.get(k) : null, setItem: (k, v) => session.set(k, String(v)) };
  const FixedDate = now ? class extends Date { constructor(...a) { super(...(a.length ? a : [now])); } } : Date;
  new Function('window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage', 'matchMedia', 'Date', HEAD)(
    win, { documentElement: rootEl, querySelector: () => meta }, { userAgent: ua }, { hash, search }, local, sess, () => ({ matches: calm }), FixedDate);
  return { o: win.aaOpening, cls: rootEl.className.trim().split(/\s+/).filter(Boolean), theme: rootEl.attrs['data-theme'], meta: meta.content, store, session };
}
const dayOf = d => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

test('openingPlan: a first open gets the terms, and the quote typed', () => {
  assert.deepEqual(openingPlan({ welcomed: false }), { show: true, first: true, line: 'quote', typing: true });
});
test('openingPlan: a first open through a link or a reload gets the terms and nothing typed', () => {
  assert.deepEqual(openingPlan({ welcomed: false, deep: true }), { show: true, first: true, line: '', typing: false });
  assert.deepEqual(openingPlan({ welcomed: false, seen: true }), { show: true, first: true, line: '', typing: false });
});
test('openingPlan: a first open with reduced motion gets the whole block at once', () => {
  assert.deepEqual(openingPlan({ welcomed: false, calm: true }), { show: true, first: true, line: 'quote', typing: false });
});
test('openingPlan: a later open types the quote once a day and the tagline otherwise', () => {
  assert.equal(openingPlan({ welcomed: 1, day: '2026-9-24', quoteDay: '2026-9-23' }).line, 'quote');
  assert.equal(openingPlan({ welcomed: 1, day: '2026-9-24', quoteDay: null }).line, 'quote');
  const p = openingPlan({ welcomed: 1, day: '2026-9-24', quoteDay: '2026-9-24' });
  assert.deepEqual(p, { show: true, first: false, line: 'tagline', typing: true });
});
test('openingPlan: a later open through a link, a reload or with reduced motion has no opening', () => {
  for (const k of ['deep', 'seen', 'calm']) assert.equal(openingPlan({ welcomed: 1, [k]: true }).show, false, k);
});
test('head script: every link into the game skips the opening, #handoff= and ?handoff= included', () => {
  const links = ['#m=ABC123', '#b-380', '#b-disc:panda', '#daily', '#league', '#level-3', '#handoff=' + 'a1'.repeat(32)];
  for (const hash of links) assert.equal(runHead({ hash, ls: { welcomed: 1 } }).o.plan.show, false, hash);
  assert.equal(runHead({ search: '?handoff=Zx_9-abcdefghijklmn', ls: { welcomed: 1 } }).o.plan.show, false, '?handoff=');
  for (const hash of ['', '#', '#top', '#m=']) assert.equal(runHead({ hash, ls: { welcomed: 1 } }).o.plan.show, true, hash || '(none)');
  const first = runHead({ hash: '#m=ABC123' });
  assert.deepEqual([first.o.plan.first, first.o.plan.line, first.o.plan.typing], [true, '', false]);
});
test('head script: once per session, and the session is marked', () => {
  const a = runHead({ ls: { welcomed: 1 } });
  assert.equal(a.o.plan.show, true); assert.equal(a.session.get('aa:splash'), '1');
  assert.equal(runHead({ ls: { welcomed: 1 }, ss: { 'aa:splash': '1' } }).o.plan.show, false);
});
test('head script: the quote once a day, across midnight, with the rotation moving on', () => {
  const eve = new Date(2026, 8, 24, 23, 59, 50), morning = new Date(2026, 8, 25, 0, 0, 5);
  const a = runHead({ ls: { welcomed: 1, launches: 6, quoteDay: '2026-9-23' }, now: eve });
  assert.equal(a.o.plan.line, 'quote'); assert.equal(a.o.quote, 6);
  assert.equal(a.store.get('aa:v1:launches'), '7'); assert.equal(a.store.get('aa:v1:quoteDay'), JSON.stringify(dayOf(eve)));
  const b = runHead({ ls: { welcomed: 1, launches: 7, quoteDay: dayOf(eve) }, now: eve });
  assert.equal(b.o.plan.line, 'tagline'); assert.equal(b.store.get('aa:v1:launches'), '7', 'the tagline does not move the rotation');
  assert.equal(runHead({ ls: { welcomed: 1, launches: 7, quoteDay: dayOf(eve) }, now: morning }).o.plan.line, 'quote');
});
test('head script: classes for the first paint, and nothing at all without an opening', () => {
  assert.deepEqual(runHead().cls, ['is-opening', 'is-first']);
  assert.deepEqual(runHead({ ls: { welcomed: 1 } }).cls, ['is-opening']);
  assert.deepEqual(runHead({ ls: { welcomed: 1 }, hash: '#daily' }).cls, []);
});
test('head script: a browser that refuses storage opens like a first visit, and does not throw', () => {
  const r = runHead({ broken: true });
  assert.equal(r.o.plan.first, true); assert.equal(r.theme, 'paper');
});
test('head script: the theme from the first frame; on a paper native splash the opening stays paper', () => {
  const night = { welcomed: 1, theme: 'night' };
  const web = runHead({ ls: night });
  assert.deepEqual([web.theme, web.meta, web.cls.includes('is-paper-first')], ['night', '#0E0E10', false]);
  const app1 = runHead({ ls: night, ua: UA_APP1 });
  assert.deepEqual([app1.theme, app1.meta, app1.cls.includes('is-paper-first')], ['night', '#F4EDE0', true], 'build 1 always drew paper: the bars stay paper until the opening fades');
  const app2 = runHead({ ls: night, ua: UA_APP2 });
  assert.equal(app2.cls.includes('is-paper-first'), false, 'build 2 on Android 14 drew night');
  const app2old = runHead({ ls: night, ua: UA_APP2.replace('Android 14', 'Android 12') });
  assert.equal(app2old.cls.includes('is-paper-first'), true, 'build 2 on Android 12 cannot theme its splash');
  assert.equal(runHead({ ls: { welcomed: 1, theme: 'mint' }, ua: UA_APP1 }).meta, '#F4EDE0', 'mint on a paper splash: paper bars first');
  assert.equal(runHead({ ls: { welcomed: 1, theme: 'mint' } }).meta, '#E6F2EC', 'mint on the web from the first frame');
  assert.equal(runHead({ ls: { welcomed: 1, theme: 'paper' }, ua: UA_APP1 }).cls.includes('is-paper-first'), false);
  assert.equal(runHead({ ls: { welcomed: 1, theme: 'plaid' } }).theme, 'paper', 'an unknown theme is paper');
  assert.equal(runHead({ ls: { welcomed: 1, theme: 'night' }, ua: UA_APP1, hash: '#daily' }).cls.includes('is-paper-first'), false, 'no opening, nothing to keep on paper');
});

// ── The typing ──
const LINES = QUOTES.map(q => q + '\n— Puzzle');
const sched = (text, budget, step = 34, calm = false) => typeSchedule(text, { budget, step, gap: 45, calm });
test('the quotes are the eight the splash already showed, each typed with "— Puzzle"', () => {
  assert.equal(QUOTES.length, 8);
  assert.ok(QUOTES.every(q => q.length >= 50 && q.length <= 120 && !q.includes('\n')));
});
test('budgets: a first open types every quote in 1.8 s, a later one in 1.5 s, the tagline in 0.4 s', () => {
  for (const l of LINES) { assert.ok(sched(l, T.first).end <= T.first, l); assert.ok(sched(l, T.quote).end <= T.quote, l); }
  assert.ok(sched('Train your brain.', T.tagline, 22).end <= T.tagline);
  assert.ok(sched(LINES[4], T.quote).end >= T.quote - 2, 'a line longer than its budget is squeezed to fill it, not cut');
});
test('the later opens never take longer than the old splash (2.64 s), every wait included', () => {
  assert.ok(T.cap + T.fade <= 2640 && T.capShort + T.fade <= 1300);
  assert.ok(T.quote + T.hold <= T.cap && T.tagline + T.holdShort <= T.capShort, 'the typing and the hold fit inside the cap');
  assert.ok(T.font + T.js <= T.cap - T.quote, 'the waits before the typing are taken out of it, and there is room for them');
  const def = new Function('return ' + grab(js, /\{ hold: \d+, holdShort: [^}]*\}/).replace(', ...o.T }', ' }'))();
  for (const k of Object.keys(def)) assert.equal(def[k], T[k], `js/puzzle.js falls back to the page's own ${k}`);
});
test('keys: none on a space, at most one every 45 ms, the return is the thud, one bell at the end', () => {
  for (const [text, budget, step] of [...LINES.map(l => [l, T.first, 34]), ...LINES.map(l => [l, T.quote, 34]), ['Train your brain.', T.tagline, 22]]) {
    const s = sched(text, budget, step);
    for (const c of s.clicks) if (c.kind !== 'ding') assert.notEqual(text[c.i], ' ', 'a key on a space');
    for (const c of s.clicks) assert.equal(c.kind === 'space', text[c.i] === '\n', 'the thud is the return and only the return');
    for (let k = 1; k < s.clicks.length; k++) assert.ok(s.clicks[k].at - s.clicks[k - 1].at >= 45, `${s.clicks[k].at - s.clicks[k - 1].at} ms apart`);
    assert.equal(s.clicks.filter(c => c.kind === 'ding').length, 1); assert.equal(s.clicks.at(-1).kind, 'ding'); assert.equal(s.clicks.at(-1).at, s.end + 120);
    assert.equal(s.at.length, text.length); assert.equal(s.at[0], 0); assert.equal(s.end, s.at.at(-1));
    for (let k = 1; k < s.at.length; k++) assert.ok(s.at[k] >= s.at[k - 1]);
    const keys = s.clicks.filter(c => c.kind === 'key');
    assert.ok(keys[0].at === 0 && keys.at(-1).at >= s.end - 60 && keys.length >= s.end / 90, 'keys all the way through');
  }
});
test('keys: a breath after punctuation, and a letter every 34 ms when there is time', () => {
  const s = sched('Look. Now', 5000);
  assert.equal(s.at[1] - s.at[0], 34); assert.equal(s.at[5] - s.at[4], 34 + 160);
});
test('reduced motion: one step, no keys', () => {
  const s = sched(LINES[0], T.first, 34, true);
  assert.ok(s.at.every(t => t === 0)); assert.equal(s.clicks.length, 0); assert.equal(s.end, 0);
});
test('a very late start squeezes the line to nothing rather than running past the cap', () => {
  const s = sched(LINES[0], -300);
  assert.equal(s.end, 0); assert.ok(s.clicks.length <= 2);
});

// ── The sounds ──
const sfxSrc = ['tap', 'key', 'space', 'ding'].map(k => grab(js, new RegExp(`\\n    ${k}: [^\\n]+`)).trim());
const makeSfx = live => { const calls = []; const SFX = new Function('beep', 'soundLive', `return { ${sfxSrc.join('\n')} };`)((notes, out) => calls.push({ notes, out }), () => live); return { SFX, calls }; };
test('SFX.key, SFX.space and SFX.ding are quieter than a tap', () => {
  const { SFX, calls } = makeSfx(true);
  SFX.tap(); const tapMax = Math.max(...calls[0].notes.map(n => n[4]));
  for (let i = 0; i < 8; i++) SFX.key(i); SFX.space(); SFX.ding();
  for (const c of calls.slice(1)) for (const n of c.notes) assert.ok(n[4] < tapMax, `gain ${n[4]} ≥ ${tapMax}`);
});
test('SFX.key: its pitch is nudged a few per cent letter by letter', () => {
  const { SFX, calls } = makeSfx(true);
  for (let i = 0; i < 8; i++) SFX.key(i);
  const f = calls.map(c => c.notes[0][0]);
  assert.ok(new Set(f).size >= 6); assert.ok(f.every(x => Math.abs(x / 2300 - 1) <= 0.05 + 1e-9));
});
test('SFX keys go on the audio clock at a given moment and to a given bus, and not at all when sound cannot play', () => {
  const { SFX, calls } = makeSfx(true);
  const bus = {}; SFX.key(3, 0.25, bus); SFX.ding(0, 1.5, bus);
  assert.equal(calls[0].out, bus); assert.equal(calls[0].notes[0][1], 0.25); assert.ok(Math.abs(calls[0].notes[1][1] - 0.254) < 1e-9);
  assert.equal(calls[1].notes[0][1], 1.5);
  const quiet = makeSfx(false); quiet.SFX.key(0); quiet.SFX.space(); quiet.SFX.ding();
  assert.equal(quiet.calls.length, 0);
});
test('soundLive: silent rather than late, and never makes a context in a browser nobody has touched', () => {
  const src = grab(js, /const wake = [^\n]+/) + '\n' + grab(js, /function soundLive\(\) \{[\s\S]*?\n  \}\n/);
  const run = ({ muted = false, app = false, active = false, audio = null, ctxState = 'running' }) => {
    let made = 0, resumed = 0;
    const AC = function () { made++; this.state = ctxState; this.resume = () => { resumed++; return Promise.resolve(); }; };
    // soundLive reads and writes `audio` from the enclosing scope, as in the game
    const g = new Function('state', 'shell', 'navigator', 'window', 'audio0', `let audio = audio0;\n${src}\nconst live = soundLive(); return { live, audio };`);
    const r = g({ muted }, { on: app }, { userActivation: { hasBeenActive: active } }, { AudioContext: AC }, audio);
    return { ...r, made, resumed };
  };
  assert.equal(run({ muted: true, app: true }).live, false);
  const web = run({}); assert.deepEqual([web.live, web.made], [false, 0]);
  const app = run({ app: true }); assert.deepEqual([app.live, app.made], [true, 1]);
  const asleep = run({ app: true, ctxState: 'suspended' }); assert.deepEqual([asleep.live, asleep.resumed], [false, 1]);
  const touched = run({ active: true }); assert.deepEqual([touched.live, touched.made], [true, 1]);
});
test('the unlock listens to what counts as a gesture, and wakes a context that is not running', () => {
  assert.match(js, /for \(const t of \['pointerup', 'touchend', 'keydown', 'click'\]\) document\.addEventListener\(t, unlock, \{ capture: true, passive: true \}\)/);
  assert.match(grab(js, /const wake = [^\n]+/), /audio\.state !== 'running'/);
  assert.ok(!/audio\.state === 'suspended'\) audio\.resume\(\)/.test(js), 'every resume goes through wake()');
});

// ── The opening in js/puzzle.js ──
const openingRun = grab(js, /function openingRun\(o\) \{[\s\S]*?\n  \}\n/);
test('the opening is claimed, the keys follow the typing, and aa:opened is dispatched exactly once', () => {
  assert.match(openingRun, /o\.ready\?\.\(\)/);
  assert.equal(js.split("new Event('aa:opened')").length - 1, 1);
  assert.match(js, /const openedSignal = \(\) => \{ if \(openedSent\) return; openedSent = true;/);
  assert.match(js, /homeReady\.then\(openedSignal\)/, 'with no opening it still fires, once home is drawn');
  assert.match(openingRun, /el\.splash\.hidden = true; openedSignal\(\);/, 'after the fade, with #aaSplash hidden');
});
test('the handover waits for home, with a cap; a tap or a key finishes it', () => {
  assert.match(openingRun, /Promise\.all\(\[typed\.then\(\(\) => until\(short \? T\.holdShort : T\.hold\)\), homeReady\]\)\.then\(leave\)/);
  assert.match(openingRun, /timer = setTimeout\(leave, capLeft\(\)\)/);
  assert.match(openingRun, /document\.addEventListener\('keydown', onKey, true\)/);
  assert.match(openingRun, /el\.splash\.addEventListener\('click'/);
  assert.match(js, /renderSelect\(\);\n    homeShown\(\);/);
  assert.match(js, /el\.error\.hidden = false; homeShown\(\); \}\);/, 'a home that could not load still hands over');
  assert.match(js, /if \(entered\) splashSkip\?\.\(\);/, 'resumeLive can still cut it short');
});
test('no notification permission is asked on the way in', () => {
  assert.ok(!openingRun.includes('notifyFirstAsk'), 'not from Accept');
  assert.ok(!/if \(shell\.on\) \{ shellListen\(\);[^\n]*notifyFirstAsk/.test(js), 'not from a timer at boot');
  assert.ok(!/void notifyFirstAsk\(\)/.test(grab(js, /async function notifyInitApp\(\) \{[\s\S]*?\n  \}\n/)), 'not from every open');
  assert.match(js, /async function notifyFirstAsk\(\) \{/, 'the function stays for a later moment');
});
test('the app is recognised by any PuzzleApp/<n>, debug too', () => {
  const on = new Function('return ' + grab(js, /\/ PuzzleApp\\\/\\d\//))(), debug = new Function('return ' + grab(js, /\/ PuzzleApp\\\/\\d\+ debug\\b\//))();
  for (const ua of [UA_APP1, UA_APP2, UA_WEB + ' PuzzleApp/12', UA_APP2 + ' debug']) assert.ok(on.test(ua), ua);
  assert.ok(!on.test(UA_WEB)); assert.ok(debug.test(UA_APP2 + ' debug')); assert.ok(!debug.test(UA_APP2));
  assert.match(mainJava, /" PuzzleApp\/2" \+ \(debuggable \? " debug" : ""\)/);
});

// ── The page, the stylesheet and the colours ──
test('#aaSplash is in the markup, not hidden; the gate is gone; no inline styles', () => {
  const tag = grab(html, /<div class="aa-splash" id="aaSplash"[^>]*>/);
  assert.ok(!/\bhidden\b/.test(tag));
  assert.ok(!html.includes('id="aaGate"'));
  assert.ok(!/<[a-z][^>]*\sstyle="/i.test(html));
  assert.ok(html.includes('id="aaAccept"') && html.includes('href="/puzzle/terms.html"') && html.includes('href="/puzzle/privacy.html"'));
});
test('the opening script comes first: before any stylesheet, and the typing right after #aaSplash', () => {
  const head = html.indexOf(HEAD), sheet = html.search(/<link[^>]+rel="stylesheet"/), inHead = html.indexOf('</head>');
  assert.ok(head > 0 && head < sheet && head < inHead);
  assert.ok(html.indexOf(TYPING) > html.indexOf('id="aaSplash"') && html.indexOf(TYPING) < html.indexOf('<main class="aa-app"'));
  assert.ok(html.indexOf(TYPING) < html.indexOf('src="/js/puzzle.js'));
});
test('the opening layer does not fade in: its first frame is the app splash\'s last', () => {
  const rule = grab(css, /\.aa-splash\{ display:none;[^}]*\}/);
  assert.ok(!/animation/.test(rule));
  assert.match(css, /html\.is-opening \.aa-splash, html\.is-leaving \.aa-splash\{ display:block; \}/);
  assert.match(css, /\.aa-splash-mark\{ position:absolute; left:50%; top:50%; width:96px; height:96px; margin:-48px 0 0 -48px;/);
});
const cssVars = block => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
const paperVars = cssVars(grab(css, /:root\{\n  --bg[\s\S]*?\n\}/)), nightVars = cssVars(grab(css, /:root\[data-theme="night"\]\{[\s\S]*?\n\}/)), mintVars = cssVars(grab(css, /:root\[data-theme="mint"\]\{[\s\S]*?\n\}/));
const xmlColour = n => (new RegExp(`<color name="${n}">(#[0-9A-Fa-f]{6})</color>`).exec(colorsXml) || [])[1];
const headColours = new Function('return ' + grab(HEAD, /\{ paper: '#F4EDE0', night: '#[0-9A-F]{6}', mint: '#[0-9A-F]{6}' \}/))();
const applyTheme = grab(js, /const themeBar = [^\n]+/);   // the colours applyTheme sets the bars to
test('paper is one colour everywhere: colors.xml, the stylesheet, theme-color, the manifest, the asset builder, both scripts', () => {
  const paper = '#F4EDE0';
  for (const [where, v] of [['colors.xml', xmlColour('paper')], ['--bg', paperVars.bg], ['theme-color', grab(html, /<meta name="theme-color" content="[^"]+"/).split('"').at(-2)],
    ['background_color', webmanifest.background_color], ['theme_color', webmanifest.theme_color], ['PAPER', (/const PAPER = '([^']+)'/.exec(assets) || [])[1]],
    ['head script', headColours.paper], ['is-paper-first', cssVars(grab(css, /html\.is-paper-first \.aa-splash\{[^}]*\}/)).bg]]) assert.equal(v?.toUpperCase(), paper, where);
  assert.match(applyTheme, /: '#F4EDE0'\)/);
  assert.match(themesXml, /<style name="Theme\.App" [^>]*>\s*<item name="android:windowBackground">@color\/paper<\/item>/);
  assert.match(grab(themesXml, /<style name="Theme\.App\.Starting" [\s\S]*?<\/style>/), /<item name="windowSplashScreenBackground">@color\/paper<\/item>/);
});
test('night and mint agree too, and so does the brain\'s ink', () => {
  for (const [t, vars] of [['night', nightVars], ['mint', mintVars]]) {
    assert.equal(xmlColour('paper_' + t), vars.bg, t); assert.equal(headColours[t], vars.bg, t);
    assert.ok(applyTheme.includes(`'${vars.bg}'`), t); assert.ok(mainJava.includes(`case "${vars.bg}": return "${t}";`), t);
    assert.equal(xmlColour('ink_' + t), vars.mark, t + ' mark');
    assert.match(grab(themesXml, new RegExp(`<style name="Theme\\.App\\.Starting\\.${t[0].toUpperCase() + t.slice(1)}">[\\s\\S]*?</style>`)), new RegExp(`@color/paper_${t}[\\s\\S]*@drawable/splash_mark_${t}`));
  }
  assert.ok(mainJava.includes(`case "${paperVars.bg}": return "paper";`));
  assert.equal(xmlColour('ink'), paperVars.mark); assert.equal(xmlColour('ink'), '#2E2016');
  assert.ok(markSvg.includes('stroke="#2E2016"'), 'the mark is drawn in that ink');
});

// ── The brain: the same drawing, the same size, the same place, on the phone's splash and on the page ──
const svgPaths = [...markSvg.matchAll(/<path d="([^"]+)"( fill="#2E2016" stroke="none")?\/>/g)];
const strokeD = svgPaths.filter(m => !m[2]).map(m => m[1]).join(''), fillD = svgPaths.filter(m => m[2]).map(m => m[1].replace(/ /g, '')).join('');
test('the page draws the mark\'s own paths, in currentColor, 96 px across', () => {
  const svg = grab(html, /<svg class="aa-splash-mark"[\s\S]*?<\/svg>/);
  assert.match(svg, /viewBox="0 0 512 512" width="96" height="96" aria-hidden="true"/);
  assert.ok(svg.includes(`d="${strokeD}"`) && svg.includes(`d="${fillD}"`));
  assert.ok(svg.includes('stroke="currentColor"') && svg.includes('fill="currentColor"') && !svg.includes('#2E2016'));
});
test('the app\'s splash brains are the same paths, their 512-unit box in the middle 96 dp of the 288 dp canvas', () => {
  for (const [name, ink] of [['splash_mark', 'ink'], ['splash_mark_night', 'ink_night'], ['splash_mark_mint', 'ink_mint']]) {
    const v = read(RES + `drawable/${name}.xml`);
    assert.match(v, /android:width="288dp"\s+android:height="288dp"\s+android:viewportWidth="1536"\s+android:viewportHeight="1536"/, name);
    assert.match(v, /<group android:translateX="512" android:translateY="512">/, name);
    assert.ok(v.includes(`android:pathData="${strokeD}"`) && v.includes(`android:pathData="${fillD}"`), name);
    assert.equal(v.split(`@color/${ink}"`).length - 1, 2, name);
    // 512 viewport units of 1536 on 288 dp: the box is 96 dp, and 512 + 256 = 768 is the canvas's centre
    assert.equal(288 * 512 / 1536, 96); assert.equal(512 + 512 / 2, 1536 / 2);
  }
});

// ── The Android shell ──
test('the splash is Android\'s own: installed before super.onCreate, held until the page has painted, 4 s at most', () => {
  const onCreate = grab(mainJava, /protected void onCreate\(@Nullable Bundle state\) \{[\s\S]*?\n    \}\n/);
  assert.ok(onCreate.indexOf('SplashScreen.installSplashScreen(this)') < onCreate.indexOf('super.onCreate(state)'));
  assert.match(onCreate, /splash\.setKeepOnScreenCondition\(\(\) -> !pageShown\);/);
  assert.match(onCreate, /postDelayed\(this::releaseSplash, SPLASH_MAX_MS\)/);
  assert.match(mainJava, /SPLASH_MAX_MS = 4000;/);
  for (const re of [/onPageCommitVisible\([^)]*\) \{\s*releaseSplash\(\);/, /if \(away\) \{ releaseSplash\(\);/, /boolean isTheGame = "true"\.equals\(value\);\s*releaseSplash\(\);/, /The splash has to go too[^\n]*\n\s*releaseSplash\(\);/]) assert.match(mainJava, re);
  assert.ok(!/hideSplash|import android\.widget\.ImageView|R\.id\.splash\b/.test(mainJava));
  assert.ok(!mainJava.includes('setOnExitAnimationListener'), 'on Android 12 the library\'s exit listener resets decorFitsSystemWindows');
});
test('the theme-aware splash: remembered from the page, handed to Android 13 and up, behind the page from the start', () => {
  assert.match(mainJava, /if \(Build\.VERSION\.SDK_INT < 33\) return;[\s\S]*?getSplashScreen\(\)\.setSplashScreenTheme\(style\)/);
  assert.match(mainJava, /R\.style\.Theme_App_Starting_Night[\s\S]*R\.style\.Theme_App_Starting_Mint[\s\S]*Resources\.ID_NULL/);
  assert.match(mainJava, /web\.setBackgroundColor\(colour\);/);
  assert.match(grab(mainJava, /protected void onPause\(\) \{[\s\S]*?\n    \}\n/), /readThemeColour\(\);[\s\S]*web\.onPause\(\);/);
});
test('the resources: the splash theme on the activity, light bars, the library, no splash.png, and CI checks the new ones', () => {
  assert.match(manifestXml, /android:name="\.MainActivity"\s+android:theme="@style\/Theme\.App\.Starting"/);
  assert.match(grab(themesXml, /<style name="Theme\.App\.Starting" parent="Theme\.SplashScreen">[\s\S]*?<\/style>/), /windowSplashScreenAnimatedIcon">@drawable\/splash_mark<[\s\S]*postSplashScreenTheme">@style\/Theme\.App</);
  const app = grab(themesXml, /<style name="Theme\.App" [\s\S]*?<\/style>/);
  assert.ok(app.includes('<item name="android:windowLightStatusBar">true</item>') && app.includes('<item name="android:windowLightNavigationBar">true</item>'));
  assert.match(gradle, /implementation 'androidx\.core:core-splashscreen:1\.0\.1'/);
  assert.ok(!fs.existsSync(path.join(root, RES, 'drawable-xxhdpi/splash.png')));
  assert.ok(!/<ImageView|@drawable\/splash"|@\+id\/splash"/.test(layoutXml));
  assert.ok(!/@drawable\/splash,/.test(keepXml) && /@drawable\/splash_mark,@drawable\/splash_mark_night,@drawable\/splash_mark_mint/.test(keepXml));
  assert.ok(!ciYml.includes('splash\\.png') && /for mark in splash_mark splash_mark_night splash_mark_mint/.test(ciYml));
  assert.ok(!/Never on the way in\. -->/.test(manifestXml) || /not over the opening/.test(manifestXml));
});
test('XML comments carry no double hyphen (aapt2 refuses the file)', () => {
  for (const f of [RES + 'values/colors.xml', RES + 'values/themes.xml', RES + 'layout/activity_main.xml', RES + 'raw/keep.xml', 'android/app/src/main/AndroidManifest.xml', RES + 'drawable/splash_mark.xml']) {
    for (const c of read(f).matchAll(/<!--([\s\S]*?)-->/g)) assert.ok(!c[1].includes('--'), f);
  }
});

// ── The service worker's way into the game ──
const openGameSrc = grab(sw, /const NAV_WAIT_MS = \d+;/) + '\n' + grab(sw, /async function matchBest\(cache, req\) \{[\s\S]*?\n\}\n/) + grab(sw, /function openGame\(event\) \{[\s\S]*?\n\}\n/);
test('the way into the game waits about 2 s for the network, and only for /puzzle/ navigations', () => {
  assert.match(openGameSrc, /const NAV_WAIT_MS = 2000;/);
  assert.match(sw, /if \(req\.mode === 'navigate' && \(path === '\/puzzle' \|\| path === '\/puzzle\/'\)\) \{ event\.respondWith\(openGame\(event\)\); return; \}/);
});
function runOpenGame({ net, cached, wait = 40 }) {
  const puts = [], waits = [];
  const cache = { put: (req, res) => { puts.push(res.body); return Promise.resolve(); }, match: () => Promise.resolve(cached || undefined) };
  const caches = { open: () => Promise.resolve(cache) };
  const fetch = () => net();
  const openGame = new Function('fetch', 'caches', 'VERSION', openGameSrc.replace(/= \d+;/, `= ${wait};`) + '\nreturn openGame;')(fetch, caches, 'v');
  const event = { request: { url: 'https://x/puzzle/?utm_source=android' }, waitUntil: p => waits.push(p) };
  return { result: openGame(event), puts, waits };
}
const res = (status, body) => ({ status, ok: status >= 200 && status < 300, body, clone() { return res(status, body + ' (copy)'); } });
const after = (ms, v, fail) => () => new Promise((r, j) => setTimeout(() => fail ? j(new Error('offline')) : r(v), ms));
atest('network in time: the network\'s page, and it is cached', async () => {
  const r = runOpenGame({ net: after(5, res(200, 'new')), cached: res(200, 'old') });
  assert.equal((await r.result).body, 'new'); await Promise.all(r.waits); assert.deepEqual(r.puts, ['new (copy)']);
});
atest('network too slow: the cached page now, and the network\'s answer still cached when it comes', async () => {
  const r = runOpenGame({ net: after(150, res(200, 'new')), cached: res(200, 'old') });
  const t = Date.now(); assert.equal((await r.result).body, 'old'); assert.ok(Date.now() - t < 120);
  await Promise.all(r.waits); assert.deepEqual(r.puts, ['new (copy)']);
});
atest('network too slow and nothing cached: the network after all', async () => {
  assert.equal((await runOpenGame({ net: after(120, res(200, 'new')), cached: null }).result).body, 'new');
});
atest('offline: the cached page; offline with nothing cached: the error', async () => {
  assert.equal((await runOpenGame({ net: after(5, null, true), cached: res(200, 'old') }).result).body, 'old');
  await assert.rejects(runOpenGame({ net: after(5, null, true), cached: null }).result);
});
atest('a server error is not a newer game: the cached one over a 5xx, the 5xx when there is none; a 404 passes through', async () => {
  assert.equal((await runOpenGame({ net: after(5, res(503, 'down')), cached: res(200, 'old') }).result).body, 'old');
  assert.equal((await runOpenGame({ net: after(5, res(503, 'down')), cached: null }).result).status, 503);
  const r = runOpenGame({ net: after(5, res(404, 'gone')), cached: res(200, 'old') });
  assert.equal((await r.result).status, 404); await Promise.all(r.waits); assert.deepEqual(r.puts, []);
});

for (const [name, fn] of later) {
  tests++;
  try { await fn(); console.log('  ✓ ' + name); } catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}
console.log(`${tests} tests, ${process.exitCode ? 'some FAILED' : 'all passed'}`);
