// The home tour and the tutorial fixes: the exact production code, pulled out of js/puzzle.js and run with
// stand-ins for the page around it. Run: node tests/puzzle-tour.test.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
const root = path.resolve(new URL('.', import.meta.url).pathname, '..');
const js = fs.readFileSync(path.join(root, 'js/puzzle.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'puzzle/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css/puzzle.css'), 'utf8');
const grab = re => { const m = js.match(re); if (!m) throw new Error('could not find ' + re); return m[0]; };
let tests = 0;
const test = (name, fn) => { tests++; try { fn(); console.log('  ✓ ' + name); } catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; } };

const NUMS = [grab(/const NUM_WORDS = [^\n]+/), grab(/const numWord = [^\n]+/), grab(/const capFirst = [^\n]+/), grab(/const perBoard = [^\n]+/)].join('\n');
const TIERS = [grab(/const HINTS_OF = [^\n]+/), grab(/const LIVES_OF = [^\n]+/), grab(/const HINTS_PER_LEVEL = [^\n]+/), grab(/const LIVES = [^\n]+/), grab(/const CHECKS_PER_LEVEL = [^\n]+/), grab(/const CHECK_WORD = [^\n]+/), grab(/const hintsFor = [^\n]+/), grab(/const livesFor = [^\n]+/)].join('\n');
const RANKS_SRC = grab(/const RANKS = \[[\s\S]*?\]\];/);

// ── The home tour's steps ──
const HOME_TOUR_SRC = grab(/const HOME_TOUR = \[[\s\S]*?\n  \];/);
const tourWith = ({ coached = null, leagueShown = true, rounds = 4, prizes = 10 } = {}) => new Function('el', '$', 'store', 'TRAIN_ROUNDS', 'league', NUMS + '\n' + RANKS_SRC + '\n' + HOME_TOUR_SRC + '\nreturn HOME_TOUR;')(
  { deckTrack: { parentElement: { id: 'view' } }, trainBtn: { id: 'aaTrainBtn' }, league: { id: 'aaLeague', hidden: !leagueShown }, friends: { id: 'aaFriends' }, play: { id: 'aaPlay' } },
  sel => ({ id: sel.slice(1) }),
  { get: (k, fb) => k === 'coached' ? (coached ?? fb) : fb },
  Array.from({ length: rounds }, (_, i) => ({ id: 'rfge'[i] || 'x' + i })),
  { data: prizes ? { prizes: Array(prizes).fill(1) } : null });
test('the home tour is seven steps (six without the league chip), the brain first and Play & Discover last', () => {
  const T = tourWith();
  assert.equal(T.length, 7);
  assert.deepEqual(T.map(s => s.id), ['brain', 'world', 'train', 'league', 'friends', 'settings', 'play']);
  assert.equal(new Set(T.map(s => s.id)).size, T.length, 'ids are unique');
  assert.ok(T.at(-1).last && T.filter(s => s.last).length === 1, 'only the last step is last');
  assert.deepEqual(T.filter(s => s.when).map(s => s.id), ['league'], 'only the league step depends on what is on the screen');
  assert.equal(T.find(s => s.id === 'league').when(), true);
  assert.equal(tourWith({ leagueShown: false }).filter(s => !s.when || s.when()).length, 6);
  assert.deepEqual(T.filter(s => s.slide != null).map(s => [s.id, s.slide]), [['brain', 0], ['world', 1]], 'the deck is turned to the card each deck step is about');
});
test('every step points at a thing that is in the page', () => {
  const T = tourWith();
  const ids = T.map(s => s.target()?.id).map(id => id === 'view' ? 'aaDeckTrack' : id);
  for (const id of ids) assert.ok(new RegExp(`id="${id}"`).test(html), `#${id} is in puzzle/index.html`);
  assert.ok(/class="aa-deck-view"[\s\S]*?id="aaDeckTrack"/.test(html), 'the deck steps light the deck view, the track\'s parent');
});
test('every line is one short sentence or two, and says nothing about advertisements', () => {
  for (const opts of [{}, { coached: true }, { rounds: 5 }, { prizes: 0 }]) for (const s of tourWith(opts)) {
    const b = s.body();
    assert.ok(b.length >= 30 && b.length <= 100, `${s.id}: ${b.length} chars: ${b}`);
    assert.ok(!/\bads?\b|advert/i.test(b), `${s.id} mentions an advertisement: ${b}`);
    assert.ok(/[.!]$/.test(b) && !/undefined|NaN|null/.test(b), `${s.id}: ${b}`);
    assert.ok(s.title && s.title.length <= 24, s.id);
  }
  const T = tourWith();
  assert.match(T.find(s => s.id === 'brain').body(), /Newbie to GOAT/, 'the ranks are the real first and last');
  assert.match(T.find(s => s.id === 'train').body(), /^Four /, 'the rounds are counted, not assumed');
  assert.match(tourWith({ rounds: 5 }).find(s => s.id === 'train').body(), /^Five /);
  assert.match(T.find(s => s.id === 'league').body(), /top ten are paid/);
  assert.match(T.find(s => s.id === 'friends').body(), /sign-in/, 'friends says it needs an account');
  assert.match(T.find(s => s.id === 'play').body(), /first board shows you how/, 'a new player is told the board teaches itself');
  assert.doesNotMatch(tourWith({ coached: true }).find(s => s.id === 'play').body(), /shows you how/, 'a player who has had the arrow tutorial is not promised it again');
  assert.match(T.find(s => s.id === 'settings').body(), /under Help/, 'the tour says where it can be found again');
});

// ── Who gets it ──
const WHO = [grab(/function playedHere\(\) \{[\s\S]*?\n  \}\n/), grab(/const tourDue = [^\n]+/)].join('\n');
const who = (keys, { app = true, broken = false } = {}) => {
  const ls = Object.fromEntries(keys.map(k => [k, '1']));
  const localStorage = broken ? new Proxy({}, { ownKeys() { throw new Error('denied'); } }) : ls;
  const store = { get: (k, fb) => { const v = ls['aa:v1:' + k]; return v == null ? fb : JSON.parse(v); } };
  return new Function('localStorage', 'STORE', 'shell', 'store', WHO + '\nreturn { playedHere, tourDue };')(localStorage, 'aa:v1:', { on: app }, store);
};
test('the tour runs by itself only in the app, only on a phone that has played nothing, and only once', () => {
  const fresh = ['aa:v1:welcomed', 'aa:v1:launches', 'aa:v1:theme', 'aa:v1:pushAsked', 'aa:v1:form', 'aa:v1:dailyStreak', 'aa:v1:trainHow:r', 'aa:v1:coached', 'other:lv:1'];
  assert.equal(who(fresh).tourDue(), true, 'a fresh install');
  assert.equal(who(fresh, { app: false }).tourDue(), false, 'never by itself on the website');
  for (const k of ['aa:v1:lv:380', 'aa:v1:skip:380', 'aa:v1:daily:2026-09-20', 'aa:v1:train:2026-09-20']) assert.equal(who([...fresh, k]).tourDue(), false, `${k} is something played`);
  assert.equal(new Function('localStorage', 'STORE', 'shell', 'store', WHO + '\nreturn tourDue();')({}, 'aa:v1:', { on: true }, { get: k => k === 'homeTour' ? 'done' : undefined }), false, 'once done, never by itself again');
  assert.equal(who(fresh, { broken: true }).playedHere(), true, 'storage that cannot be read counts as played: a tour that cannot be remembered as done would come back every launch');
});

// ── The board tutorial's words ──
const COACH_SRC = grab(/const COACH_STEPS = \[[\s\S]*?\n  \];/);
const coachWith = (tier, { on = true, give = 'ad' } = {}) => new Function('state', 'el', 'coach', 'adCanOffer', 'ads', TIERS + '\n' + NUMS + '\n' + COACH_SRC + '\nreturn { COACH_STEPS, LIVES_OF, HINTS_OF, CHECKS_PER_LEVEL };')(
  { tier }, {}, {}, () => on, { isAd: () => give === 'ad' });
test('the board tutorial names this board\'s hearts, hints and checks, at every tier', () => {
  const W = ['no', 'one', 'two', 'three', 'four', 'five'];
  for (let tier = 0; tier < 5; tier++) {
    const { COACH_STEPS, LIVES_OF, HINTS_OF, CHECKS_PER_LEVEL } = coachWith(tier);
    const [, hearts, hints, checks] = COACH_STEPS.map(s => s.body());
    assert.match(hearts, new RegExp(`${W[LIVES_OF[tier]]} hearts? on this board\\.$`, 'i'), `tier ${tier}: ${hearts}`);
    assert.match(hints, new RegExp(`${W[HINTS_OF[tier]]} hints? on this board\\.$`, 'i'), `tier ${tier}: ${hints}`);
    assert.match(checks, new RegExp(`${W[CHECKS_PER_LEVEL]} checks on this board\\.$`, 'i'), `tier ${tier}: ${checks}`);
    assert.doesNotMatch(COACH_STEPS.map(s => s.body()).join(' '), /per board/, 'no "per board": the numbers change with the tier');
  }
  assert.match(coachWith(4).COACH_STEPS[2].body(), /One hint on this board\./, 'the singular');
});
test('the lifeline is called an advertisement only where one plays', () => {
  const last = o => coachWith(0, o).COACH_STEPS.at(-1).body();
  assert.match(last({ give: 'ad' }), /watch a short ad/, 'the app: a real advertisement');
  assert.doesNotMatch(last({ give: 'free' }), /\bads?\b|advert/i, 'the website: free, and never called one');
  assert.match(last({ give: 'free' }), /free life/);
  assert.equal(last({ on: false }), 'Shoot every arrow and the shape reveals itself. Out of hearts? Try again.', 'no offer at all: nothing promised');
});

// ── When the board tutorial counts as seen ──
test('the arrow tutorial counts as seen when finished, skipped or the board is cleared under it, and not when it is lost or left', () => {
  const run = how => {
    const set = {}, toasts = [];
    const coach = { on: true, step: 2, piece: null }, cls = new Set(['is-top']);
    const el = { coach: { hidden: false, classList: { remove: c => cls.delete(c) } } };
    new Function('coach', 'el', 'store', 'toast', 'how', grab(/function coachEnd\(how\) \{[\s\S]*?\n  \}\n/) + '\ncoachEnd(how);')(coach, el, { set: (k, v) => { set[k] = v; } }, m => toasts.push(m), how);
    return { set, toasts, on: coach.on, hidden: el.coach.hidden, top: cls.has('is-top') };
  };
  for (const how of ['done', 'skip', 'won']) assert.equal(run(how).set.coached, true, how);
  for (const how of [undefined, 'left']) assert.equal(run(how).set.coached, undefined, String(how));
  assert.equal(run('done').toasts.length, 1, 'finishing says so'); assert.equal(run('skip').toasts.length, 0);
  const r = run(undefined); assert.ok(!r.on && r.hidden && !r.top, 'closed either way, and the card back at the bottom for next time');
  assert.match(grab(/function winLevel\(\) \{\n[^\n]+/), /coachEnd\('won'\)/);
  assert.match(grab(/function failLevel\(reason\) \{\n[^\n]+/), /coachEnd\(\);/);
  assert.match(grab(/function goToLevels\(\) \{\n[^\n]+/), /coachEnd\(\);/);
  assert.match(grab(/el\.coachSkip\?\.addEventListener[^\n]+/), /coachEnd\('skip'\)/);
});

// ── Back and Escape ──
test('Back and Escape close a tutorial card first: the home tour, the board\'s, a round\'s', () => {
  const log = [];
  const close = new Function('tour', 'coach', 'tcoach', 'tourEnd', 'coachEnd', 'trainCoachEnd', grab(/function closeTutorial\(\) \{[\s\S]*?\n  \}\n/) + '\nreturn closeTutorial;');
  const mk = (a, b, c) => close({ on: a }, { on: b }, { on: c }, h => log.push('tour:' + h), h => log.push('board:' + h), d => log.push('round:' + d));
  assert.equal(mk(true, false, false)(), true); assert.equal(mk(false, true, false)(), true); assert.equal(mk(false, false, true)(), true); assert.equal(mk(false, false, false)(), false);
  assert.deepEqual(log, ['tour:skip', 'board:skip', 'round:true'], 'each closes as its Skip does');
  const back = grab(/function backPressed\(\) \{[\s\S]*?\n  \}\n/);
  assert.ok(back.indexOf('askClose()') < back.indexOf('closeTutorial()') && back.indexOf('closeTutorial()') < back.indexOf('el.homeSheet') && back.indexOf('closeTutorial()') < back.indexOf('el.btnLevels.click()'), 'Back: a question first, then a tutorial card, then sheets and the board');
  const esc = grab(/if \(e\.key !== 'Escape'\) return;\n[^\n]+\n[^\n]+/);
  assert.ok(esc.indexOf('closeTutorial()') > 0 && esc.indexOf('closeTutorial()') < esc.indexOf('trainBack'), 'Escape: a tutorial card before the round\'s "Leave this round?"');
});

// ── A new phone for an old account ──
test('a sync that brings cleared boards and scored rounds marks their tutorials seen, unless they were asked for again', () => {
  const run = (server, preset = {}) => {
    const ls = { ...preset };
    const store = { get: (k, fb) => k in ls ? ls[k] : fb, set: (k, v) => { ls[k] = v; } };
    new Function('store', 'TRAIN_ROUNDS', 'server', grab(/function adoptSeen\(server\) \{[\s\S]*?\n  \}\n/) + '\nadoptSeen(server);')(store, [{ id: 'r' }, { id: 'f' }, { id: 'g' }, { id: 'e' }], server);
    return ls;
  };
  const server = { levels: { 380: { cleared: true }, 12: { skipped: true } }, state: { train: { '2026-09-20': { r: 70, p: 1, h: 1 }, '2026-09-21': { e: 0 }, bad: null } } };
  assert.deepEqual(run(server), { coached: true, 'trainHow:r': 1, 'trainHow:e': 1 });
  assert.deepEqual(run({ levels: { 12: { skipped: true } } }), {}, 'a skipped board is not a cleared one');
  assert.deepEqual(run(server, { coached: false, 'trainHow:r': 0 }), { coached: false, 'trainHow:r': 0, 'trainHow:e': 1 }, 'asked for again in Settings stays asked for');
  assert.deepEqual(run({}), {}); assert.deepEqual(run(null), {});
  assert.match(grab(/function adoptTour\(server, sent = null\) \{\n[^\n]+/), /adoptSeen\(server\);/, 'adoptTour does it on every answer, changed or not');
});
test('the Settings rows: a tips row that asks again with 0 (which a sync leaves alone), and the arrow tutorial named', () => {
  assert.match(grab(/el\.tipsAgain\?\.addEventListener[^\n]+/), /store\.set\('trainHow:' \+ r\.id, 0\)/);
  assert.match(grab(/el\.tipsAgain\?\.addEventListener[^\n]+/), /for \(const r of TRAIN_ROUNDS\)/, 'every round there is, not a list kept by hand');
  assert.match(html, /id="aaTourAgain"[^>]*>[\s\S]*?Tour of the app/);
  assert.match(html, /id="aaCoachAgain"[^>]*>[\s\S]*?Show the arrow tutorial again/);
  assert.match(html, /id="aaTipsAgain"[^>]*>[\s\S]*?Show the Daily Training tips again/);
  const help = html.slice(html.indexOf('<p class="aa-cap">Help</p>'), html.indexOf('<p class="aa-cap">About</p>'));
  assert.ok(help.indexOf('aaTourAgain') < help.indexOf('aaCoachAgain') && help.indexOf('aaCoachAgain') < help.indexOf('aaTipsAgain'), 'all three in Help, the tour first');
  assert.ok(!/<[a-z][^>]*\sstyle="/i.test(html), 'no inline style in the page');
  assert.match(html, /<div class="aa-coach-text" aria-live="polite" aria-atomic="true">\s*<p class="aa-coach-step" id="aaCoachStep">/, 'the board tutorial\'s step is read out when it changes');
  assert.match(grab(/function tourStart\(\) \{[\s\S]*?\n  \}\n/), /class="aa-coach-text" aria-live="polite"/, 'and the home tour\'s');
});

// ── Where the card goes ──
const spotRun = ({ target, dir = 0, bodyScroll = 0 }) => {
  const mkCls = init => { const s = new Set(init); return { add: c => s.add(c), remove: c => s.delete(c), toggle: (c, on) => (on ? s.add(c) : s.delete(c)), contains: c => s.has(c) }; };
  const spot = { classList: mkCls(), style: { left: '5px', top: '5px', width: '5px', height: '5px' } }, card = {}, layer = { classList: mkCls(['is-top']), style: {} };
  const H = 851, CH = 178;
  const rectOf = n => n === layer ? { left: 0, top: 0, right: 393, bottom: H } : n === card ? (layer.classList.contains('is-top') ? { left: 16, top: 16, right: 377, bottom: 16 + CH } : { left: 16, top: H - 16 - CH, right: 377, bottom: H - 16 }) : n.r;
  const $ = sel => sel === '.aa-coach-spot' ? spot : card;
  new Function('$', 'rectOf', 'turn', 'document', 'layer', 't', grab(/function spotOn\(layer, t, pad, measure = rectOf\) \{[\s\S]*?\n  \}\n/) + '\nspotOn(layer, t, 10);')($, rectOf, { dir }, { body: { scrollTop: bodyScroll } }, layer, target);
  return { top: layer.classList.contains('is-top'), none: spot.classList.contains('is-none'), style: spot.style, transform: layer.style.transform };
};
const T = r => ({ isConnected: true, getClientRects: () => [1], r: { ...r, width: r.right - r.left, height: r.bottom - r.top } });
test('the card sits at the bottom unless that covers the thing, and the hole is cut round the thing', () => {
  const head = spotRun({ target: T({ left: 180, top: 10, right: 220, bottom: 52 }) });
  assert.equal(head.top, false, 'a header button: the card at the bottom');
  assert.deepEqual([head.style.left, head.style.top, head.style.width, head.style.height], ['170px', '0px', '60px', '62px']);
  assert.equal(spotRun({ target: T({ left: 16, top: 767, right: 377, bottom: 835 }) }).top, true, 'Play with Friends at the foot of the screen: the card goes to the top');
  assert.equal(spotRun({ target: T({ left: 16, top: 110, right: 377, bottom: 640 }) }).top, false, 'the deck, clear of a bottom card: the bottom');
  assert.equal(spotRun({ target: T({ left: 16, top: 150, right: 377, bottom: 700 }) }).top, false, 'covered a little at the bottom and more at the top: the bottom, which covers less');
  const none = spotRun({ target: null });
  assert.ok(none.none && !none.top && none.style.left === '' && none.style.width === '', 'nothing to point at: the whole screen dims, and no hole is left where the last thing was');
  assert.equal(spotRun({ target: T({ left: 180, top: 10, right: 220, bottom: 52 }), dir: -90, bodyScroll: 56 }).transform, 'translateY(56px)', 'a turned page that has scrolled: the layer is held on the glass');
  assert.equal(spotRun({ target: T({ left: 180, top: 10, right: 220, bottom: 52 }), dir: 0, bodyScroll: 56 }).transform, '', 'upright, the layer is fixed to the glass by itself');
});

// ── A toast over a card ──
test('a toast raised while a tutorial card is open goes over it, at the other end of the screen', () => {
  const run = cards => {
    const cls = new Set();
    const t = { set className(v) { cls.clear(); v.split(' ').forEach(c => cls.add(c)); }, classList: { add: c => cls.add(c) }, hidden: true };
    new Function('el', '$$', 'toastTimer', 'setTimeout', 'clearTimeout', grab(/function toast\(msg, kind = '', ms = 2800\) \{[\s\S]*?\n  \}\n/) + '\ntoast("x", "hint");')({ toast: t }, () => cards, 0, () => 0, () => {});
    return [...cls].sort().join(' ');
  };
  const card = top => ({ hidden: false, classList: { contains: c => c === 'is-top' && top } });
  assert.equal(run([]), 'aa-toast aa-toast--hint');
  assert.equal(run([{ hidden: true, classList: { contains: () => false } }]), 'aa-toast aa-toast--hint', 'a hidden #aaCoach is no card');
  assert.equal(run([card(false)]), 'aa-toast aa-toast--hint is-over', 'card at the bottom: the toast at the top');
  assert.equal(run([card(true)]), 'aa-toast aa-toast--hint is-over-low', 'card at the top: the toast stays at the bottom');
  const z = n => +(css.match(new RegExp(n.replace(/[.]/g, '\\.') + '\\{[^}]*z-index:(\\d+)')) || [])[1];
  const toastZ = +(css.match(/\.aa-toast\.is-over, \.aa-toast\.is-over-low\{ z-index:(\d+)/) || [])[1];
  assert.ok(toastZ > z('.aa-train-coach') && toastZ > z('.aa-coach') && toastZ < z('.aa-ask'), `over every coach layer, under a question (${toastZ})`);
  assert.match(css, /\.aa-toast\.is-over\{ top:calc\(16px \+ env\(safe-area-inset-top, 0px\)\); bottom:auto; \}/);
  assert.match(css, /\.aa-coach\.is-top \.aa-coach-card\{ top:calc\(16px \+ env\(safe-area-inset-top, 0px\)\); bottom:auto; \}/);
});

// ── Wiring ──
test('the tour is wired where the page moves: the deck, the sheets, a board, the header, a turn, a zoom', () => {
  assert.match(grab(/function deckStart\(\) \{\n[^\n]+\n[^\n]+/), /tour\.on\) return;/, 'the deck does not turn itself under the tour');
  assert.match(grab(/const openSheet = [^\n]+/), /tourLeave\(\)/, 'a sheet opening ends it');
  assert.match(grab(/async function openFriends\(\) \{\n[^\n]+/), /tourLeave\(\)/, 'Play with Friends ends it at the tap');
  assert.match(grab(/async function startLevel\([^)]*\) \{[\s\S]*?deckStop\(\);/), /tourLeave\(true\); coachEnd\(\); deckStop\(\);/, 'a board ends it, calls off one still waiting, and closes a tutorial left from the board before');
  assert.match(grab(/function renderSelect\(\) \{[\s\S]*?\n  \}\n/), /homeDrawn = true; tourReplace\(\);/, 'a redraw (a sync) moves the spotlight with the screen');
  assert.match(grab(/function onTurn\(\) \{[\s\S]*?\n  \}\n/), /requestAnimationFrame\(\(\) => \{ coachPlace\(\); tourPlace\(\); \}\)/, 'a turn re-places both, once laid out');
  assert.match(grab(/function applyZoom\(\) \{[\s\S]*?\n  \}\n/), /coachReplace\(\);/, 'a zoom moves the board tutorial\'s hole with the arrow');
  assert.match(grab(/function tourStart\(\) \{[\s\S]*?\n  \}\n/), /new MutationObserver\(tourReplace\)/, 'the header arriving (league, purse, face) moves it');
  assert.match(js, /window\.addEventListener\('aa:opened', \(\) => \{ if \(tourDue\(\)\) tourWait\(\); \}\);/, 'the opening\'s hand-over starts it');
  assert.match(grab(/function tourNext\(\) \{[\s\S]*?\n  \}\n/), /tourEnd\('done'\); el\.play\?\.click\(\);/, 'the last button is Play & Discover itself');
  assert.match(grab(/function goToLevels\(\) \{[\s\S]*?\n  \}\n/), /if \(tour\.again\) \{ tour\.again = false; tourWait\(true\); \}/, 'asked for on a board, it starts back home');
  assert.match(grab(/async function notifyFirstAsk\(\) \{[\s\S]*?\n  \}\n/), /push\.asking = true;[\s\S]*finally \{ push\.asking = false; \}/, 'the phone\'s notification question is waited for');
  const wait = grab(/function tourWait\(replay = false\) \{[\s\S]*?\n  \}\n/);
  assert.match(wait, /setInterval\(tick, 400\)/); assert.match(js, /const TOUR_WAIT_MS = 30000;/);
  assert.match(wait, /\(el\.gate && !el\.gate\.hidden\) \|\| push\.asking \|\| document\.hidden\) tour\.since = Date\.now\(\)/, 'the clock stands still while somebody is reading');
});

console.log(`\n${tests} tests`);
