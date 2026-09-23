/* ══════════════════════════════════════════════════
   PUZZLE – TRAIN YOUR BRAIN — tap-away arrow puzzle on country maps
   No dependencies. Data: /games/data/puzzle.json
   Each level is a country: a grid mask (land cells) at one of five
   difficulty tiers plus the outline for the reveal. The puzzle itself is
   generated in the browser from a fixed seed, so level 12 is the same
   for everyone. Generation works backwards from an empty board: every
   piece placed has a clear run to the edge past the pieces placed before
   it, so the reverse placement order is always a valid solution, and any
   other valid move order stays solvable (removing pieces only frees cells).
   ══════════════════════════════════════════════════ */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DATA_VERSION = '11';
  const MAP_VERSION = '3';
  const DISCB_VERSION = '4';  // games/data/discover-boards.json: the board shaped like each country's animal, bird or landmark
  const FOCUS_VERSION = '4';  // games/data/focus-boards.json: the brain, the lightbulb, the key — the boards the game opens on
  const SCENE_VERSION = '1';  // games/data/scene-boards.json: the tower, the arena, the cross — the big boards every few countries
  const STORE = 'aa:v1:';

  // ── Where the backend lives ──
  // Puzzle – Train Your Brain talks to its own service, which today answers on this origin and one day may answer on
  // api.arrowatlas.com. Nothing below hardcodes a host: the bases come from a meta tag if the page sets one,
  // so moving the backend is a deploy change and not a client rewrite.
  const metaBase = n => document.querySelector(`meta[name="${n}"]`)?.content?.trim() || '';
  const API_BASE = (metaBase('puzzle-api') || location.origin).replace(/\/$/, '');
  const WS_BASE = (metaBase('puzzle-ws') || API_BASE.replace(/^http/, 'ws')).replace(/\/$/, '');
  const API_V1 = `${API_BASE}/api/puzzle/v1`;
  const WS_URL = `${WS_BASE}/ws/puzzle`;
  // ── Whether the game is running inside the Android app rather than in a browser tab ──
  //
  // The app is a WebView this repository owns (see android/), and it exists because AdMob will not serve an H5
  // game unless the app owns the WebView it runs in. What that ownership costs is two web APIs that cannot be
  // made to work in there however hard this file tries:
  //
  //   Google sign-in   refused outright. Google blocks its OAuth endpoint in embedded WebViews and answers
  //                    disallowed_useragent, and spoofing the agent string to get around it breaks its terms.
  //   Push             not implemented. Service workers run in a WebView; PushManager does not exist.
  //
  // Both come back natively through the shell, through Credential Manager and Firebase Cloud Messaging. Until
  // they do, the game says so in the one place each is offered rather than showing a control that does nothing.
  //
  // The agent string is the signal because there is no JavaScript bridge yet and nothing here needs one. It is
  // also the safer of the two: a suffix the shell appends to its own agent cannot be read by a third-party
  // frame, which an injected object in a WebView can be, and the frames arrive with the advertisements.
  const shell = {
    on: / PuzzleApp\/\d/.test(navigator.userAgent),
    // The debug build of the app says so on its agent string. It is where a developer is; the release build
    // and the site are where players are, and the developer settings do not open there.
    debug: / PuzzleApp\/\d+ debug\b/.test(navigator.userAgent),
    // window.PuzzleShell is put there by the app, and only on this origin: it is injected with
    // addWebMessageListener and an origin rule, not addJavascriptInterface, so an advertisement's iframe
    // cannot reach it. Absent on an old System WebView, where the feature does not exist — hence a function
    // and not a flag, because it appears as the page loads rather than before it.
    bridge: () => window.PuzzleShell || null,
    // what the app said it can do, from its answer to hello: open (the browser, for a sign-in), push
    caps: {},
    /**
     * Ask the app something and wait for its answer. One question at a time, which is all this is ever asked
     * for: signing in is modal, and nothing else uses the bridge yet. Every failure resolves rather than
     * throws, so a caller never has to guess whether a rejection was the app or its own bug, and the timeout
     * is long because the answer is behind a system dialog somebody has to read.
     */
    ask(cmd, ms = 180000) {
      return new Promise(resolve => {
        const b = shell.bridge();
        if (!b) { resolve({ ok: false, error: 'no_bridge' }); return; }
        let done = false;
        const finish = d => { if (done) return; done = true; clearTimeout(timer); if (b.onmessage === onReply) b.onmessage = null; resolve(d); };
        const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), ms);
        // The app also speaks unasked -- its Back button arrives as { event } -- and that is never the answer.
        const onReply = e => { let d; try { d = JSON.parse(e.data); } catch { d = { ok: false, error: 'bad_reply' }; } if (d && d.event) return; finish(d); };
        b.onmessage = onReply;
        try { b.postMessage(cmd); } catch { finish({ ok: false, error: 'no_bridge' }); }
      });
    },
  };
  const store = {
    get(k, fb) { try { const v = localStorage.getItem(STORE + k); return v == null ? fb : JSON.parse(v); } catch { return fb; } },
    set(k, v) { try { localStorage.setItem(STORE + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };
  const LIVES = 4;                 // Classic and Rush; One Life has 1, Deep Focus none
  const DIFF_OF = tier => ['Easy', 'Normal', 'Hard', 'Expert', 'Master'][tier];
  const COMBO_WINDOW_MS = 1800;   // shots closer together than this chain into a combo; a wrong tap breaks it
  const COMBO_WORDS = ['Good!', 'Great!', 'Amazing!', 'Unstoppable!'];
  const comboLevel = n => n >= 12 ? 3 : n >= 8 ? 2 : n >= 5 ? 1 : 0;
  // a cheer only when the combo *reaches* a step (x3, x5, x8, x12, then every fifth), never on every shot
  const comboStep = n => n === 3 || n === 5 || n === 8 || n === 12 || (n > 12 && (n - 12) % 5 === 0);
  const CHEER_HOLD = 3;           // after a cheer, the next three shots stay quiet whatever the combo
  const MILESTONES = [25, 50, 75, 90];
  const HINT_PENALTY_MS = 5000;
  const HINTS_PER_LEVEL = 3;
  // How long an invitation that arrived mid-board is worth offering afterwards. A room waits minutes, not
  // hours, and an invitation to one that has since filled up or been called off is worse than none.
  const INVITE_KEEP_MS = 120_000;
  const HINTS_OF = [3, 3, 2, 2, 1];   // hints per tier: three on Easy and Normal; Hard and up are meant to be lost and taken again
  // Press and hold an arrow and it says whether its lane is clear: green it goes, red it does not. That was free
  // and invisible -- nothing in the game mentioned it, and nothing counted it. Four a level makes it a choice
  // worth making and puts it on the bar where a player can see it, beside the hearts and the lamp.
  // A drawn heart rather than the ♥ character. Nunito draws that one tall and narrow -- a spade that lost an
  // argument -- and it was the only shape on the bar still coming out of a text font. This one is wider than it
  // is high, which is the shape everybody means by a heart.
  const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 20.7c-.42 0-.83-.15-1.15-.44C7.3 17.1 3 13.3 3 9.35 3 6.4 5.26 4.1 8.1 4.1c1.5 0 2.93.66 3.9 1.78A5.16 5.16 0 0 1 15.9 4.1c2.84 0 5.1 2.3 5.1 5.25 0 3.95-4.3 7.75-7.85 10.91-.32.29-.73.44-1.15.44z"/></svg>';
  const CHECKS_PER_LEVEL = 4;
  const CHECK_WORD = 'check';   // the icon is drawn in the markup now, beside the counter's value
  const hintsFor = tier => HINTS_OF[tier] ?? HINTS_PER_LEVEL;
  const LIVES_OF = [4, 4, 3, 2, 2];   // hearts per tier: four on Easy and Normal, three on Hard, two on Expert and Master
  const livesFor = tier => LIVES_OF[tier] ?? LIVES;
  // ── Adaptive difficulty ──
  // Difficulty follows the player, never the level number. One tier (0 Easy … 4 Master) lives on the device and
  // moves on form alone. A cleared board earns points towards the next step: a flawless, fast first-try clear (no
  // heart lost, no hint, quick per arrow) earns the whole step at once, so a strong player leaves Easy after level 1;
  // any other first-try clear earns half (two in a row step up, hearts and hints spent or not); a clear after a
  // retry earns nothing and resets. Two lost boards in a row step down. Nobody stays bored or stuck.
  const STEP_POINTS = 2, STEP_DOWN_LOSSES = 2;
  const FAST_SEC_PER_ARROW = 1.2;   // level 1 (~22 arrows) in under ~26 s counts as fast
  const clampTier = t => Math.max(0, Math.min(4, t));
  const clearPoints = ({ firstTry, heartsLost, hints, secPerArrow }) => !firstTry ? 0 : heartsLost === 0 && hints === 0 && secPerArrow <= FAST_SEC_PER_ARROW ? STEP_POINTS : 1;
  // form = { tier, wins: points towards the next step, losses: lost boards in a row }
  const FORM0 = { tier: 0, wins: 0, losses: 0 };
  const nextForm = (f, won, run) => {
    if (won) { const pts = clearPoints(run), wins = pts ? f.wins + pts : 0; return wins >= STEP_POINTS ? { tier: clampTier(f.tier + 1), wins: 0, losses: 0 } : { tier: f.tier, wins, losses: 0 }; }
    const losses = f.losses + 1; return losses >= STEP_DOWN_LOSSES ? { tier: clampTier(f.tier - 1), wins: 0, losses: 0 } : { tier: f.tier, wins: 0, losses };
  };
  const formNow = () => ({ ...FORM0, ...(store.get('form', null) || {}) });
  const TIER_OF = () => clampTier(formNow().tier);
  const MAXLEN_OF = [7, 9, 14, 16, 18];  // longest body per tier: long snakes, as on the reference boards -- and on Hard and Master, the long winding ones that fill a page
  // Hard and Master boards are drawn on a finer grid than the level data asks for: more cells, so more arrows
  // on the same outline. The scale is the same for everybody, so a match is still the same board for both.
  const KSCALE_OF = [1, 1, 1.5, 1.65, 1.8];
  // ...within a budget. Brazil at 1.5 is two thousand cells, three hundred five-pixel arrows and six seconds
  // of drawing on a phone; so the scale is trimmed to what keeps the board under this many cells and this
  // long a side, and a big country simply stays nearer the size the level data gave it. Small countries,
  // where the extra cells are the point, get the whole scale.
  const CELL_CAP_OF = [0, 0, 900, 1100, 1300];
  const SIDE_CAP = 72;
  // How narrow the play is per tier (see generate()): narrow = prefer the end whose run holds more pieces (blocked
  // longer), far = prefer the end with a gap right ahead (the arrow it frees when it goes is that far away), rail =
  // straighter, longer snakes, holes/lane = share and length of the lanes carved out first.
  const NARROW_OF = [0.5, 0.75, 1, 1, 1];
  const FAR_OF = [0.2, 0.4, 0.9, 0.95, 0.98];
  const RAIL_OF = [0.1, 0.15, 0.32, 0.42, 0.5];    // share of pieces that run long and straight across the board
  const HOLE_OF = [0.1, 0.15, 0.2, 0.2, 0.2];      // share of inland cells carved out as lanes: the gaps an arrow looks free across
  const LANE_OF = [1, 2, 4, 5, 6];                 // longest lane (empty cells between an arrow and its blocker)
  // Tightening iterations per tier (see generate stage 3): a local search that turns arrows to face a blocker so a
  // simulated player has fewer free arrows to pick from at any moment. Hard and up.
  const TIGHTEN_OF = [0, 0, 400, 500, 600];
  // Weight of the traps in the tightening (see generate stage 3): arrows with two or more empty cells before
  // their blocker, which look free and are not. Hard and up, and heaviest on Master.
  const TRAP_OF = [0, 0, 3, 4, 5];
  const GEN_OPTS = tier => ({ narrow: NARROW_OF[tier], far: FAR_OF[tier], rail: RAIL_OF[tier], holes: HOLE_OF[tier], lane: LANE_OF[tier], tighten: TIGHTEN_OF[tier], trapw: TRAP_OF[tier] });
  const DIRS = { r: [0, 1], l: [0, -1], d: [1, 0], u: [-1, 0] };
  const PALETTE = ['#FFED54', '#5CD6FF', '#8CFF7A', '#FF9AD5', '#C79BFF', '#FFB347', '#6EE7B7', '#FDBA74', '#F97373', '#38BDF8'];

  const el = {
    select: $('#aaSelect'), trainBtn: $('#aaTrainBtn'), trainPill: $('#aaTrainPill'), trainSheet: $('#aaTrainSheet'), trainBody: $('#aaTrainBody'), homeRow: $('#aaHomeRow'), homeNow: $('#aaHomeNow'), homeSheet: $('#aaHomeSheet'), homeBack: $('#aaHomeBack'), homeSearch: $('#aaHomeSearch'), homeList: $('#aaHomeList'), purse: $('#aaPurse'), purseNo: $('#aaPurseNo'), goldAd: $('#aaGoldAd'), hudDiff: $('#aaHudDiff'), play: $('#aaPlay'), path: $('#aaPath'), btnVibe: $('#aaVibe'), btnGuides: $('#aaGuides'), btnMusic: $('#aaMusic'),
    sheet: $('#aaSheet'), friends: $('#aaFriends'), signInSheet: $('#aaSignInSheet'), googleBtn: $('#aaGoogleBtn'), signInNote: $('#aaSignInNote'), ranks: $('#aaRanks'), league: $('#aaLeague'), leagueEnds: $('#aaLeagueEnds'), leagueSheet: $('#aaLeagueSheet'), leagueBody: $('#aaLeagueBody'), leagueInfo: $('#aaLeagueInfo'), matchSheet: $('#aaMatchSheet'), matchBody: $('#aaMatchBody'), matchTitle: $('#aaMatchTitle'), accountGroup: $('#aaAccountGroup'), accountCap: $('#aaAccountCap'), accountRow: $('#aaAccountRow'), accountName: $('#aaAccountName'), accountWho: $('#aaAccountWho'), accountGold: $('#aaAccountGold'), accountFace: $('#aaAccountFace'), sessionGroup: $('#aaSessionGroup'), sessionCap: $('#aaSessionCap'), signOutBtn: $('#aaSignOut'), deleteAccBtn: $('#aaDeleteAcc'), settingsBtns: $$('#aaSettings, #aaSettingsG'), themeBtn: $('#aaTheme'), themes: $('#aaThemes'), build: $('#aaBuild'), devCap: $('#aaDevCap'), devGroup: $('#aaDevGroup'), devAds: $('#aaDevAds'), devAdsNote: $('#aaDevAdsNote'), devLast: $('#aaDevLast'), devTools: $('#aaDevTools'), devHide: $('#aaDevHide'),
    game: $('#aaGame'), boardWrap: $('#aaBoardWrap'), board: $('#aaBoard'), toast: $('#aaToast'), confetti: $('#aaConfetti'),
    coach: $('#aaCoach'), coachSpot: $('#aaCoachSpot'), coachStep: $('#aaCoachStep'), coachTitle: $('#aaCoachTitle'), coachBody: $('#aaCoachBody'), coachNext: $('#aaCoachNext'), coachSkip: $('#aaCoachSkip'), coachAgain: $('#aaCoachAgain'), hudLives: $('#aaHudLives'),
    hudLevel: $('#aaHudLevel'), hudTime: $('#aaHudTime'), hudLeft: $('#aaHudLeft'), hudLives: $('#aaHudLives'), hudPct: $('#aaHudPct'), boardBar: $('#aaBoardBar'),
    btnHint: $('#aaHint'), btnCheck: $('#aaCheck'), hintVal: $('#aaHintVal'), checkVal: $('#aaCheckVal'), btnLevels: $('#aaBackToLevels'), btnSound: $('#aaSound'),
    overlay: $('#aaOverlay'), card: $('#aaCard'),
    loading: $('#aaLoading'), error: $('#aaError'),
    gate: $('#aaGate'), accept: $('#aaAccept'), splash: $('#aaSplash'), splashQuote: $('#aaSplashQuote'),
    worldMap: $('#aaWorldMap'), worldCap: $('#aaWorldCap'),
    brainArt: $('#aaBrainArt'), brainLv: $('#aaBrainLv'), brainNote: $('#aaBrainNote'),
    deck: $('#aaDeck'), deckTrack: $('#aaDeckTrack'), deckDots: $('#aaDeckDots'),
    notifyCap: $('#aaNotifyCap'), notifyGroup: $('#aaNotifyGroup'), btnNotify: $('#aaNotify'), notifyNote: $('#aaNotifyNote'), remindRow: $('#aaRemindRow'), btnRemind: $('#aaRemind'), mutedCap: $('#aaMutedCap'), mutedGroup: $('#aaMutedGroup'),
    statBoards: $('#aaStatBoards'), statCountries: $('#aaStatCountries'), statStreak: $('#aaStatStreak'),
  };
  if (!el.board) return;

  let DATA = null;
  const state = {
    mode: 'classic', muted: !!store.get('muted', false), music: store.get('music', true) !== false, vibe: store.get('vibe', true) !== false, guides: !!store.get('guides', false),
    idx: -1, level: null, tier: 0, mask: null, pieces: [], occ: null, W: 0, H: 0, left: 0,
    lives: LIVES, livesMax: LIVES, startedAt: 0, raceBase: 0, elapsed: 0, timerId: 0, finished: false, hintsUsed: 0, checksUsed: 0, checksMax: CHECKS_PER_LEVEL, wrong: 0, fails: 0, seedBump: 0, busy: false, potGone: false,
    combo: 0, bestCombo: 0, lastShot: 0, cheerHold: 0, shown: new Set(), daily: null,
  };

  // ── Helpers ──
  const fmtTime = (ms, tenths) => { const s = Math.max(0, ms) / 1000, m = Math.floor(s / 60), r = s - m * 60; return tenths ? `${m}:${r.toFixed(1).padStart(4, '0')}` : `${m}:${String(Math.floor(r)).padStart(2, '0')}`; };
  const fmtPop = n => !n ? '' : n >= 1e9 ? `${(n / 1e9).toFixed(2)} billion` : n >= 1e6 ? `${Math.round(n / 1e6)} million` : `${Math.round(n / 1e3)}K`;
  // Where a finger is, and where a box is, in the page's own coordinates rather than the screen's. The page
  // is rotated when a phone is held sideways (see "Upright" at the foot of this file), and a rotated page is
  // still handed screen coordinates: a swipe along the column arrives as a sideways delta, and a rectangle
  // arrives with its width and height the wrong way round. These two put both back. While turn.dir is 0 they
  // are the identity, which is every desktop and every phone held upright.
  //
  // The body's own box is the measurement, not a viewport unit: it is exactly what the transform was applied
  // to, so the arithmetic cannot drift from the layout.
  const turn = { dir: 0 };
  const ptOf = e => {
    if (!turn.dir) return { x: e.clientX, y: e.clientY };
    const b = document.body;
    return turn.dir < 0
      ? { x: b.offsetWidth - e.clientY, y: e.clientX }
      : { x: e.clientY, y: b.offsetHeight - e.clientX };
  };
  const rectOf = node => {
    const r = node.getBoundingClientRect();
    if (!turn.dir) return r;
    const b = document.body;
    const left = turn.dir < 0 ? b.offsetWidth - r.bottom : r.top;
    const top = turn.dir < 0 ? r.left : b.offsetHeight - r.right;
    // a quarter turn swaps them, and the box stays a box
    return { left, top, width: r.height, height: r.width, right: left + r.height, bottom: top + r.width };
  };
  const svgEl = (tag, attrs = {}) => { const n = document.createElementNS(SVG_NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
  // progress is keyed by country id (not by level number: the tour order is the player's own, home country first)
  const progressKey = i => 'lv:' + DATA.levels[i].id;
  const skipKey = i => 'skip:' + DATA.levels[i].id;

  // ── What each board costs, counted here ──
  // The tour's record of a board is its best run. It cannot say how many tries that took, how many hearts
  // went, or which boards are started and never cleared -- which is the whole of what "hard" means, and the
  // one thing a level designer needs to know. So every board played counts, on this device, signed in or not,
  // online or not: started, cleared, hearts run out, and what a clear cost in hints, hearts and time. The
  // counts ride along with the tour sync whenever there is one, per device, and only ever grow.
  const DEVICE = (() => {
    let d = store.get('device', '');
    if (!d) { d = Math.random().toString(36).slice(2, 10) + Date.now().toString(36); store.set('device', d); }
    return d;
  })();
  const statKey = id => 'st:' + id;
  function countBoard(id, add) {
    if (!id) return;
    const s = store.get(statKey(id), { p: 0, c: 0, f: 0, h: 0, l: 0, ms: 0 });
    for (const [k, v] of Object.entries(add)) s[k] = (s[k] || 0) + v;
    store.set(statKey(id), s);
  }
  /** Every board this device has counted, for the sync. Focus boards stay here, like their records do. */
  function localStats() {
    const out = {};
    try {
      for (const k of Object.keys(localStorage)) {
        if (!k.startsWith(STORE + 'st:')) continue;
        const id = k.slice(STORE.length + 3); if (isLocalOnly(id)) continue;
        const s = store.get('st:' + id); if (s && (s.p || s.c || s.f)) out[id] = s;
      }
    } catch { /* storage can be unreadable in a private window */ }
    return out;
  }
  const cleared = i => store.get(progressKey(i));
  const unlocked = i => i === 0 || !!cleared(i - 1) || !!store.get(skipKey(i));
  const dayKeyOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dayKey = () => dayKeyOf(new Date());
  const dayKeyBack = n => { const d = new Date(); d.setDate(d.getDate() - n); return dayKeyOf(d); };
  const hashStr = str => { let h = 2166136261; for (const ch of str) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  // the daily board is the same country for everyone: picked from the canonical list, then found in the player's own order
  const dailyPick = () => { const h = hashStr('aa-daily-' + dayKey()); const L = DATA.canon[h % DATA.canon.length]; return { key: dayKey(), idx: DATA.levels.indexOf(L), tier: 1 + (h >> 8) % 4, seed: 900000 + (h % 100000) }; };
  function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function scrollToGame() { window.scrollTo({ top: 0, behavior: 'smooth' }); }
  // the address names the board (#b-<id>), not its place in the list: the list is personal and the numbers are progress
  function setHash(i) { if (history.replaceState) history.replaceState(null, '', location.pathname + location.search + (i >= 0 ? `#b-${DATA.levels[i].id}` : '')); }
  // Level numbers count the player's own journey: cleared boards in the order they were cleared, then the board in
  // hand. The tour list only decides what comes next, so a player who cleared 63 countries before the discovery
  // boards existed is on level 65, not back on level 4 because Bhutan's animal sits fourth in the list. A daily
  // training puzzle finished is a level too, in its place by time among the boards (trainClearTimes), so the
  // count is everything the player has cleared; i < 0 asks for the next level, whatever is played for it.
  let numCache = null;
  const forgetNums = () => { numCache = null; };
  function levelNo(i) {
    if (!numCache) {
      const done = DATA.levels.map((_, j) => ({ j, rec: cleared(j) })).filter(x => x.rec).map(x => ({ j: x.j, at: x.rec.at || 0 }));
      for (const at of trainClearTimes()) done.push({ j: -1, at });
      done.sort((a, b) => (a.at - b.at) || (a.j - b.j));
      const of = new Map(); done.forEach((x, k) => { if (x.j >= 0) of.set(x.j, k + 1); });
      numCache = { n: done.length, of };
    }
    return (i >= 0 && numCache.of.get(i)) || numCache.n + 1;
  }

  // ── Sound ──
  let audio = null;
  function beep(notes) {
    if (state.muted) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      const t0 = audio.currentTime;
      notes.forEach(([freq, start, dur, type = 'sine', gain = 0.07]) => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.type = type; o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t0 + start); g.gain.exponentialRampToValueAtTime(gain, t0 + start + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
        o.connect(g).connect(audio.destination); o.start(t0 + start); o.stop(t0 + start + dur + 0.02);
      });
    } catch { /* silent */ }
  }
  // ── Music: a slow ambient pad synthesised on the device (no audio file, no licence, works offline) ──
  //
  // It is the same pad throughout. What changes is how much of it there is. A board at rest is a low, wide,
  // slow hum under everything; as the board gets harder to be in -- hearts gone, a wrong tap a moment ago, a
  // long stare at nothing, somebody ahead of you in a race -- the filter opens, the movement quickens, the
  // delay tail shortens and a slow pulse comes up underneath. Putting the board right takes all of it back
  // down again, faster than it came up on the way in and slower on the way out, so it breathes rather than
  // flickers.
  //
  // Nothing here gets loud. The ceiling is a little above the one volume the pad used to play at forever, and
  // the whole thing is capped lower again for anyone who has asked their system for less movement.
  const MUSIC = {
    tick: 400,                  // how often intensity is recomputed, ms
    rise: 0.22, fall: 0.08,     // how far it travels toward its target each tick, up and down
    gain: [0.085, 0.13],        // the master, at rest and at full: a whisker over the one volume it used to hold
    cutoff: [520, 1500],        // the pad's lowpass: muffled to present
    lfoHz: [0.05, 0.17], lfoDepth: [180, 80],
    feedback: [0.32, 0.17],     // the delay tail, shorter when it matters
    chord: [14, 9],             // seconds a chord is held: the harmony moves quicker under pressure
    pulseFrom: 0.55,            // below this there is no pulse at all, so a heartbeat always means jeopardy
    pulseBpm: [46, 92],
    idleFrom: 18, idleOver: 90, // a long think is the point of this game: 18s before it tells at all, 41s to the top
    spikeWrong: 0.3, spikeCap: 0.5, spikeDecay: 0.93, spikeFix: 0.55,
    reducedCeiling: 0.55,
    // The heartbeat is a sound, not a chord, and it lives in the same low register the pad does. When it is
    // beating the pad comes down to a little under half, so what the player hears is their own hearts rather
    // than a wash with something buried in it. It is ramped like every other parameter here, so it ducks and
    // lifts over about a second rather than snapping.
    duckHeart: 0.42,
  };
  const music = { ctx: null, master: null, timer: 0, step: 0, on: false, aim: 0, cur: 0, spike: 0, race: 0, raceTo: 0, heartAt: 0, lastMove: 0, tickTimer: 0, pulseTimer: 0 };
  const mix = (r, i) => r[0] + (r[1] - r[0]) * i;
  // Somebody who has asked their system for less movement gets less of this too. Asked once and remembered,
  // rather than on every tick.
  let calmQuery = null;
  const calmer = () => { try { calmQuery = calmQuery || matchMedia('(prefers-reduced-motion: reduce)'); return calmQuery.matches; } catch { return false; } };
  const CHORDS = [[57, 64, 67, 71, 76], [53, 60, 64, 69, 72], [48, 55, 60, 64, 71], [55, 59, 62, 67, 74]]; // Am9 · Fmaj7 · Cmaj7 · G6 (MIDI)
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
  function musicStart() {
    if (!state.music) return;
    // Already playing, because the player went straight from one board to the next: the pad carries on, but
    // whatever the last board was doing to it does not.
    if (music.on) { music.spike = 0; music.race = 0; music.lastMove = performance.now(); return; }
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      const ctx = audio; music.ctx = ctx;
      // Two stages, and the reason is the ticker. The intensity layer ramps the master every 400ms, so a slow
      // fade-in written on the master is overwritten by the first tick 0.64s later -- the eight-second arrival
      // collapses into half a second and the music lands on the player instead of appearing under them. The
      // intro owns the fade; the master owns the intensity; neither writes to the other's parameter.
      const intro = ctx.createGain(); intro.gain.value = 0.0001; intro.connect(ctx.destination);
      const master = ctx.createGain(); master.gain.value = MUSIC.gain[0]; master.connect(intro);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 520; lp.Q.value = 0.6; lp.connect(master);
      const delay = ctx.createDelay(1.2); delay.delayTime.value = 0.52; const fb = ctx.createGain(); fb.gain.value = 0.32;
      const dlp = ctx.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 900;
      lp.connect(delay); delay.connect(dlp); dlp.connect(fb); fb.connect(delay); dlp.connect(master);
      const lfo = ctx.createOscillator(); lfo.frequency.value = MUSIC.lfoHz[0]; const lfoG = ctx.createGain(); lfoG.gain.value = MUSIC.lfoDepth[0]; lfo.connect(lfoG).connect(lp.frequency); lfo.start();
      // The pulse goes straight to the master, not through the pad's lowpass: it is meant to be felt under the
      // harmony rather than washed into it.
      const pulseOut = ctx.createGain(); pulseOut.gain.value = 1; pulseOut.connect(master);
      music.master = master; music.intro = intro; music.lp = lp; music.lfo = lfo; music.lfoG = lfoG; music.fb = fb; music.pulseOut = pulseOut; music.on = true;
      music.cur = 0; music.aim = 0; music.spike = 0; music.lastMove = performance.now();
      // It comes in softly. Eight seconds from nothing to full is slow enough that a player who has just
      // touched their first arrow does not hear it arrive, which is the point of starting it here rather than
      // on the way in through the door.
      intro.gain.exponentialRampToValueAtTime(1, ctx.currentTime + 8);
      musicTick(); musicPulse();
      const playChord = () => {
        if (!music.on) return;
        const notes = CHORDS[music.step % CHORDS.length]; music.step++;
        const t = ctx.currentTime, dur = mix(MUSIC.chord, music.cur);
        notes.forEach((m, i) => {
          for (const det of [-6, 5]) {
            const o = ctx.createOscillator(); o.type = i === 0 ? 'triangle' : 'sine'; o.frequency.value = mtof(m - (i === 0 ? 12 : 0)); o.detune.value = det;
            const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t);
            // The envelope is written in seconds, and the chord is no longer always fourteen of them: hold the
            // sustain until after the attack has actually arrived, or a quick chord sets its level before it
            // has finished climbing to it.
            const peak = i === 0 ? 0.5 : 0.28, rise = 4 + i * 0.6;
            g.gain.exponentialRampToValueAtTime(peak, t + rise);
            g.gain.setValueAtTime(peak, t + Math.max(rise + 0.4, dur - 5));
            g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
            o.connect(g).connect(lp); o.start(t); o.stop(t + dur + 0.1);
          }
        });
        music.timer = setTimeout(playChord, Math.max(3, dur - 4) * 1000);
      };
      playChord();
    } catch { /* no audio, no problem */ }
  }
  function musicStop() {
    if (!music.on) return;
    music.on = false; clearTimeout(music.timer); clearTimeout(music.tickTimer); clearTimeout(music.pulseTimer);
    music.cur = 0; music.aim = 0; music.spike = 0; music.race = 0; music.raceTo = 0; music.heartAt = 0;
    // The fade-out outlives this call by 1.7 seconds, and the nodes it tidies up afterwards must be THESE
    // nodes. Reading them off the shared object when the timer fires was survivable while music only stopped on
    // a hidden tab; now that leaving a board stops it, going back in and starting another one inside those 1.7
    // seconds is an ordinary thing to do -- and it would have disconnected the master of the new graph and
    // stopped its LFO, with music.on left true so nothing could ever start it again. Silence, permanently, from
    // tapping the next level too quickly. They are held in locals now, so the timer can only reach its own.
    const ctx = music.ctx, master = music.master, intro = music.intro, lfo = music.lfo;
    try {
      const t = ctx.currentTime;
      intro.gain.cancelScheduledValues(t);
      intro.gain.setValueAtTime(Math.max(0.0001, intro.gain.value), t);
      intro.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
      setTimeout(() => { try { master.disconnect(); intro.disconnect(); lfo.stop(); } catch { /* ignore */ } }, 1700);
    } catch { /* ignore */ }
  }
  // What the board is asking of the player, as one number between nothing and everything.
  function musicAim() {
    if (!music.on || state.finished) return 0;
    let a = 0.06;                                        // the bed: awake, barely
    const lm = state.livesMax || 0;
    if (lm > 0) {
      a += 0.40 * Math.pow(1 - Math.max(0, state.lives) / lm, 1.6);   // gentle for the first heart, steep for the last
      // Being one heart away is news, and then it is the rest of the board. Reaching it early on eighty arrows
      // would otherwise mean ten minutes at the top of the range, which is how a good idea becomes exhausting.
      if (state.lives === 1) a += (performance.now() - (music.heartAt || 0)) / 1000 < 45 ? 0.16 : 0.06;
    }
    a += music.spike;                                    // a wrong tap, fading
    a += music.race;                                     // somebody ahead of you, or already home
    // Thinking only counts while the board is the thing in front of them. A sheet open over it, or the tab in
    // the background, is not a long stare at arrows, and leaning on somebody reading the settings is unkind.
    const away = document.hidden || (el.overlay && !el.overlay.hidden);
    if (away) music.lastMove = performance.now();
    const idle = (performance.now() - (music.lastMove || 0)) / 1000;
    if (!away && idle > MUSIC.idleFrom) a += Math.min(0.26, (idle - MUSIC.idleFrom) / MUSIC.idleOver);   // a long look at a board that is not moving
    const total = state.pieces?.length || 0;
    if (total && state.left > 0 && (total - state.left) / total > 0.85) a += 0.12;  // the last few, with everything to lose
    // And the thing that keeps an hour of calm play calm. Thinking and being deep into a board are the signals
    // most likely to fire while nothing is actually wrong, so on their own they cannot take it past the middle:
    // the top half of the range is unlocked by losing hearts or being behind in a race, and by nothing else.
    const hurt = lm > 0 ? 1 - Math.max(0, state.lives) / lm : 0;
    const cap = Math.min(1, 0.55 + 0.9 * Math.max(hurt, music.race));
    const ceiling = Math.min(cap, calmer() ? MUSIC.reducedCeiling : 1);
    return Math.max(0, Math.min(ceiling, a));
  }
  function musicTick() {
    if (!music.on) return;
    music.spike *= MUSIC.spikeDecay;
    if (music.spike < 0.01) music.spike = 0;
    music.race += ((music.raceTo || 0) - music.race) * 0.12;
    if (music.race < 0.005) music.race = 0;
    music.aim = musicAim();
    music.cur += (music.aim - music.cur) * (music.aim > music.cur ? MUSIC.rise : MUSIC.fall);
    try {
      const ctx = music.ctx, t = ctx.currentTime, k = MUSIC.tick / 1000 * 1.6, i = music.cur;
      // Every parameter is ramped over longer than a tick, so each one is still travelling when the next tick
      // sets it moving again. Nothing here ever steps.
      music.master.gain.linearRampToValueAtTime(mix(MUSIC.gain, i) * (heart.on ? MUSIC.duckHeart : 1), t + k);
      music.lp.frequency.linearRampToValueAtTime(mix(MUSIC.cutoff, i), t + k);
      music.lfo.frequency.linearRampToValueAtTime(mix(MUSIC.lfoHz, i), t + k);
      music.lfoG.gain.linearRampToValueAtTime(mix(MUSIC.lfoDepth, i), t + k);
      music.fb.gain.linearRampToValueAtTime(mix(MUSIC.feedback, i), t + k);
    } catch { /* the graph went away under us; the next start builds a new one */ }
    music.tickTimer = setTimeout(musicTick, MUSIC.tick);
  }
  // A heartbeat, and only when there is something to have a heartbeat about. It keeps its own time so it can
  // quicken without the pad having to.
  function musicPulse() {
    if (!music.on) return;
    const i = music.cur;
    if (heart.on) { /* the heartbeat is already the pulse: two of them is a muddle, not twice the tension */ }
    else if (i >= MUSIC.pulseFrom) {
      try {
        const ctx = music.ctx, t = ctx.currentTime;
        const depth = Math.min(1, (i - MUSIC.pulseFrom) / (1 - MUSIC.pulseFrom));
        const thump = (at, amp) => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.type = 'sine'; o.frequency.setValueAtTime(66, at); o.frequency.exponentialRampToValueAtTime(42, at + 0.2);
          g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(amp, at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.34);
          o.connect(g).connect(music.pulseOut); o.start(at); o.stop(at + 0.38);
        };
        thump(t, 0.05 + 0.06 * depth);
        if (i > 0.78) thump(t + 0.21, 0.03 + 0.03 * depth);   // the second beat only arrives when it is bad
      } catch { /* ignore */ }
    }
    music.pulseTimer = setTimeout(musicPulse, 60000 / mix(MUSIC.pulseBpm, music.cur));
  }
  // The four things the board can say to the music.
  const musicBegin = () => { if (!music.on) musicStart(); };
  const musicMoved = () => { music.lastMove = performance.now(); };
  const musicWrong = () => { music.spike = Math.min(MUSIC.spikeCap, music.spike + MUSIC.spikeWrong); music.heartAt = performance.now(); musicMoved(); };
  const musicRight = () => { music.spike *= MUSIC.spikeFix; musicMoved(); };   // putting it right takes it back faster than it came
  // renderRanks is called by the socket, by the REST poll and by starting a board, and it can only see places
  // rather than distances -- so the same standing arrives again and again, and can flip on a poll boundary. The
  // target is set here and the value is eased toward it in the ticker, so nothing flaps.
  const musicRace = n => { music.raceTo = n; };

  // ── The heartbeat ──
  //
  // A heart lost is heard as well as seen. A low two-beat thump comes up under the board -- quicker, and a
  // little louder, the fewer hearts are left -- and then it goes away by itself: three seconds for the first
  // heart lost, four for the next, seven for the one after. On the last heart it does not go away. It stays
  // until the board is won, lost or left, because on the last heart there is nothing else left to lose, and a
  // sound that stops there would be the game relaxing at the exact moment the player cannot.
  //
  // Every board gives four hearts today, so the third loss IS the last heart: what plays is three seconds, then
  // four, then the one that does not stop. The seven is the next step of the same ramp, and it is written down
  // here rather than left out so that a five-heart board would sound right the day there is one.
  //
  // Staying is not the same as never letting up, though. After forty-five seconds on one heart it drops back to
  // a quieter beat and holds there -- present, not shouting. A board of eighty arrows can take ten minutes, and
  // ten minutes of full-strength alarm is how a good idea turns into a reason to turn the sound off.
  //
  // This is sound, not music: it answers the sound switch, and it plays whether or not the pad is on. While it
  // is beating, the pad's own pulse stands aside, so there is one heartbeat in the room rather than two.
  const HEART_HOLD = [3000, 4000, 7000];   // the burst, after the first, second and third heart lost
  const HEART_BPM = [74, 132];             // resting, and on the last heart
  const HEART_EASE_MS = 45000;             // how long the last heart is loud before it settles
  const heart = { on: false, timer: 0, until: 0, rate: HEART_BPM[0], amp: 0.06, lastAt: 0 };
  function heartbeatStop() { heart.on = false; heart.until = 0; heart.lastAt = 0; clearTimeout(heart.timer); heart.timer = 0; }
  // One beat: the thud and its echo, straight out to the speakers. Nothing is kept between beats, so the graph
  // cannot be left behind by a board that ended mid-beat.
  function heartBeat() {
    if (!heart.on) return;
    if (heart.until && performance.now() > heart.until) { heartbeatStop(); return; }
    if (!state.muted && !document.hidden) {
      try {
        audio = audio || new (window.AudioContext || window.webkitAudioContext)();
        if (audio.state === 'suspended') audio.resume();
        const t = audio.currentTime;
        // The last heart eases off once the news has landed; everything else is at the level its urgency asked for.
        const settled = !heart.until && heart.lastAt && performance.now() - heart.lastAt > HEART_EASE_MS;
        let amp = heart.amp * (settled ? 0.55 : 1);
        if (calmer()) amp *= 0.7;
        const thump = (at, a, from, to, dur) => {
          const o = audio.createOscillator(), g = audio.createGain();
          o.type = 'sine'; o.frequency.setValueAtTime(from, at); o.frequency.exponentialRampToValueAtTime(to, at + dur * 0.7);
          g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(a, at + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
          o.connect(g).connect(audio.destination); o.start(at); o.stop(at + dur + 0.02);
        };
        thump(t, amp, 62, 38, 0.26);                       // lub
        thump(t + 0.19, amp * 0.62, 52, 32, 0.22);         // dub
      } catch { /* no audio, no heartbeat */ }
    }
    heart.timer = setTimeout(heartBeat, 60000 / heart.rate);
  }
  // A heart just went. How fast it beats and how long it lasts are both read off what is left, so the same call
  // does for the first heart of five and the last of two.
  function heartLost() {
    const max = state.livesMax || 0, left = Math.max(0, state.lives);
    if (state.finished || left <= 0 || max < 2) { heartbeatStop(); return; }   // out of hearts belongs to the fail card, not to this
    const hurt = 1 - (left - 1) / (max - 1);             // 0 with everything still to spare, 1 on the last heart
    heart.rate = mix(HEART_BPM, hurt);
    heart.amp = 0.055 + 0.05 * hurt;
    heart.until = left === 1 ? 0 : performance.now() + HEART_HOLD[Math.min(max - left, HEART_HOLD.length) - 1];
    heart.lastAt = performance.now();
    if (!heart.on) { heart.on = true; heartBeat(); }      // already beating: it carries on, at the new rate
  }

  const SFX = { shoot: () => beep([[880, 0, 0.07], [1320, 0.04, 0.08]]), scatter: () => beep([[1245, 0, 0.05, 'sine', 0.045], [988, 0.05, 0.05, 'sine', 0.045], [784, 0.1, 0.05, 'sine', 0.045], [587, 0.15, 0.06, 'sine', 0.045], [440, 0.21, 0.1, 'triangle', 0.05]]), cheer: lv => { const f = 587 * Math.pow(2, lv * 3 / 12); beep([[f, 0, 0.09], [f * 1.26, 0.07, 0.1], [f * 1.5, 0.14, 0.14], [f * 2, 0.21, 0.22, 'sine', 0.06]]); }, block: () => beep([[220, 0, 0.06, 'square', 0.05], [110, 0.05, 0.22, 'triangle', 0.06]]), win: () => beep([[523, 0, 0.12], [659, 0.1, 0.12], [784, 0.2, 0.12], [1047, 0.3, 0.35]]), lose: () => beep([[300, 0, 0.2, 'triangle'], [220, 0.2, 0.35, 'triangle']]), taken: () => beep([[784, 0, 0.1], [523, 0.09, 0.18, 'triangle', 0.05]]),
    // the room: a tap on anything, somebody arriving, somebody going, the last seconds, and the off
    tap: () => beep([[520, 0, 0.03, 'sine', 0.03], [760, 0.018, 0.035, 'sine', 0.022]]),
    join: () => beep([[523, 0, 0.08], [784, 0.07, 0.13]]),
    left: () => beep([[622, 0, 0.08, 'triangle', 0.055], [392, 0.07, 0.16, 'triangle', 0.05]]),
    tick: () => beep([[880, 0, 0.05, 'square', 0.035]]),
    go: () => beep([[196, 0, 0.2, 'triangle', 0.07], [523, 0.05, 0.1], [784, 0.13, 0.12], [1047, 0.21, 0.26]]),
    // the focus bar filling: a run of small rising blips while it travels, and one note at the end whose pitch
    // is the reading itself — high for a sharp run, low for a long one, so the ear hears what the bar shows
    focus: pct => {
      const step = 0.1, notes = 7, base = 294;
      const seq = Array.from({ length: notes }, (_, k) => [base * Math.pow(2, (k * 2 + (pct / 100) * 3) / 12), k * step, 0.06, 'sine', 0.028]);
      seq.push([base * Math.pow(2, (pct >= 85 ? 16 : pct >= 70 ? 12 : pct >= 50 ? 7 : 3) / 12), notes * step + 0.04, 0.34, 'sine', 0.06]);
      beep(seq);
    } };
  // Every tap answers back. The board's arrows are the one exception: shooting one has its own sound, and a
  // click under it would only blur the shot.
  //
  // What counts as tappable is deliberately not a list of class names. That list went stale the moment a
  // settings row became an <a> instead of a <button>, which is why some things clicked and some did not. The
  // stylesheet has already decided what looks tappable -- cursor:pointer -- so that is what is asked, along
  // with the handful of elements that are tappable by tag whatever the cursor says.
  const TAP_BY_TAG = 'button, a, summary, label, [role="button"], .aa-fill';
  document.addEventListener('pointerdown', e => {
    if (e.target.closest?.('.aa-piece')) return;
    for (let n = e.target, hop = 0; n && n !== document.body && hop < 6; n = n.parentElement, hop++) {
      if (n.disabled) return;                               // a dead control says nothing, at any depth
      if (n.matches?.(TAP_BY_TAG) || getComputedStyle(n).cursor === 'pointer') { SFX.tap(); return; }
    }
  }, true);
  function vibe(ms) { if (state.vibe && navigator.vibrate) { try { navigator.vibrate(ms); } catch { /* ignore */ } } }
  function renderToggles() {
    el.btnMusic?.setAttribute('aria-checked', String(state.music));
    el.btnVibe?.setAttribute('aria-checked', String(state.vibe));
    el.btnGuides?.setAttribute('aria-checked', String(state.guides));
    el.board.classList.toggle('aa-board--guides', state.guides);
  }
  function renderSound() { el.btnSound.setAttribute('aria-checked', String(!state.muted)); el.btnSound.setAttribute('aria-label', state.muted ? 'Sound off' : 'Sound on'); }

  let toastTimer = 0;
  // The coin: one struck gold piece with the world on its face, used everywhere gold is named — the purse,
  // the tables, a stake, the prize ladder and the result sheet — so it reads as one currency, not five icons.
  const COIN = '<img class="aa-coin" src="/images/puzzle-coin.png?v=1" alt="" width="128" height="128" decoding="async">';
  // ── Analytics ──
  // Google Analytics is loaded by the page, not by the HTML: only after the Terms and Privacy gate has been
  // accepted, and never inside the app, whose store listing declares what the app itself collects. The
  // `typeof gtag === 'function'` guards around every event mean a page without it simply sends nothing.
  const GA_ID = 'G-8ZPSNG5X37';
  function analyticsOn() {
    if (shell.on || typeof window.gtag === 'function' || !store.get('welcomed', null)) return;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date()); window.gtag('config', GA_ID);
    const s = document.createElement('script'); s.async = true; s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID; document.head.appendChild(s);
  }

  // A rule is explained while the player is still learning it, and then the game trusts them.
  //
  // "Blocked! It stays red and goes by itself once its lane clears." is true, and it is worth saying -- once.
  // By the twentieth time it is a sentence over the board that the player has to wait out, saying what the red
  // arrow, the lost heart, the shake and the sound have already said. So a teaching line shows every time while
  // the first level is still uncleared, which is where a player meets these rules, and after that it has been
  // said. The record is kept in storage, so it does not come back on the next visit; if storage is unavailable
  // the helper falls back to showing it once per session, which is the safe way to be wrong.
  const TAUGHT = store.get('taught', null) || {};
  const learning = () => { try { return !cleared(0); } catch { return false; } };
  // Should this rule be explained at all, right now? True while the player is still on their first level, and
  // true once ever after that -- and it records that it has been said, so the next time it is false.
  function sayOnce(k) {
    const first = !TAUGHT[k];
    if (first) { TAUGHT[k] = 1; store.set('taught', TAUGHT); }
    return first || learning();
  }
  // ── The tutorial ──
  // Five things, one at a time, on the first board somebody opens: a free arrow to tap (and the step waits for
  // the tap), what a blocked arrow costs, the lamp, the press-and-hold check, and what clearing the board
  // does. A spotlight on each, a card under it, Skip on every step. Shown once (`coached`), and again from
  // Settings for anyone who wants it back; a race or the daily board never shows it.
  const COACH_STEPS = [
    { title: 'Tap a free arrow', body: 'The glowing arrow has a clear path ahead of it. Tap it and it flies off the board.', target: () => coach.piece?.el, wait: 'shot' },
    { title: 'Blocked arrows cost a heart', body: 'If another arrow is in the way, the tap fails and you lose a heart. The arrow turns red and goes by itself once its path clears. Four hearts per board.', target: () => el.hudLives },
    { title: 'Stuck? Use a hint', body: 'The lamp lights up an arrow that can go right now. Three per board.', target: () => el.btnHint },
    { title: 'Check a path first', body: 'Press and hold any arrow: green means it can go, red means it is blocked. Four checks per board.', target: () => el.btnCheck },
    { title: 'Clear the board', body: 'Shoot every arrow and the shape reveals itself. Out of hearts? Try again, or watch a short ad for one more.', target: () => null, last: true },
  ];
  const coach = { on: false, step: -1, piece: null };
  function coachStart() {
    if (!el.coach || coach.on || store.get('coached', false)) return false;
    coach.on = true; coachShow(0);
    return true;
  }
  function coachShow(n) {
    const s = COACH_STEPS[n]; if (!s) { coachEnd(true); return; }
    coach.step = n;
    if (coach.piece) { coach.piece.el?.classList.remove('is-coach'); coach.piece = null; }
    if (s.wait === 'shot') { coach.piece = state.pieces.find(q => !q.gone && !blockerOf(q)) || null; if (!coach.piece) { coachShow(n + 1); return; } coach.piece.el.classList.add('is-coach'); }
    el.coachStep.textContent = `Step ${n + 1} of ${COACH_STEPS.length}`;
    el.coachTitle.textContent = s.title; el.coachBody.textContent = s.body;
    el.coachNext.hidden = s.wait === 'shot';
    el.coachNext.textContent = s.last ? "Let's play" : 'Next';
    el.coachSkip.hidden = !!s.last;
    el.coach.hidden = false;
    coachPlace();
  }
  function coachPlace() {
    if (!coach.on || el.coach.hidden) return;
    const t = COACH_STEPS[coach.step]?.target?.();
    const r = t?.getBoundingClientRect?.();
    if (!r || !r.width) { el.coachSpot.classList.add('is-none'); return; }
    el.coachSpot.classList.remove('is-none');
    const pad = t === el.hudLives || t === el.btnHint || t === el.btnCheck ? 8 : 14;
    el.coachSpot.style.left = `${r.left - pad}px`; el.coachSpot.style.top = `${r.top - pad}px`;
    el.coachSpot.style.width = `${r.width + pad * 2}px`; el.coachSpot.style.height = `${r.height + pad * 2}px`;
  }
  function coachShot() { if (coach.on && COACH_STEPS[coach.step]?.wait === 'shot') setTimeout(() => { if (coach.on && coach.step === 0) coachShow(1); }, 350); }
  function coachEnd(done = false) {
    if (!coach.on) return;
    coach.on = false; coach.step = -1;
    if (coach.piece) { coach.piece.el?.classList.remove('is-coach'); coach.piece = null; }
    if (el.coach) el.coach.hidden = true;
    store.set('coached', true);   // skipped or finished, it is not shown again unless asked for
    if (done) toast('You know everything you need. Enjoy the tour.', 'good');
  }
  el.coachNext?.addEventListener('click', () => coachShow(coach.step + 1));
  el.coachSkip?.addEventListener('click', () => coachEnd(false));
  el.coachAgain?.addEventListener('click', () => { store.set('coached', false); closeSheets(); toast('The tutorial will show on your next board.', 'hint'); });
  window.addEventListener('resize', coachPlace);
  window.addEventListener('scroll', coachPlace, true);
  function teach(k, msg, kind = 'hint', ms = 2800) {
    if (!sayOnce(k)) return false;
    toast(msg, kind, ms);
    return true;
  }
  function toast(msg, kind = '', ms = 2800) { el.toast.textContent = msg; el.toast.className = 'aa-toast' + (kind ? ' aa-toast--' + kind : ''); el.toast.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms); }

  // ── Data ──
  async function loadData() {
    if (DATA) return DATA;
    const [r] = await Promise.all([fetch(`/games/data/puzzle.json?v=${DATA_VERSION}`, { cache: 'force-cache' }), loadDiscBoards(), loadFocusBoards(), loadSceneBoards()]);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json(); d.canon = d.levels.slice();
    migrateProgress(d);
    d.levels = tourFor(d, await homeCountry(d));
    DATA = d;
    return DATA;
  }
  // Progress used to be keyed by level number; it is keyed by country id now (the order is personal). One-off copy.
  function migrateProgress(d) {
    if (store.get('idsMigrated')) return;
    d.canon.forEach((L, i) => { const v = store.get(`lv:${i}`); if (v) store.set(`lv:${L.id}`, v); if (store.get(`skip:${i}`)) store.set(`skip:${L.id}`, true); });
    store.set('idsMigrated', true);
  }
  // The tour: every country in the player's order, each followed by its discovery board, one numbered list.
  // More kinds of board later simply mean more levels.
  function tourFor(d, home) {
    let nth = 0;
    const tour = orderFor(d, home).flatMap((C, k) => [C, discLevelFor(C), (k + 1) % SCENE_EVERY === 0 ? sceneLevelFor(nth++) : null].filter(Boolean));
    // discovery clears were briefly kept under dv:<id> before the boards became levels of their own
    for (const L of tour) if (L.disc && !store.get('lv:' + L.id)) { const v = store.get('dv:' + L.country.id); if (v) store.set('lv:' + L.id, v); }
    // The focus boards go in at the frontier — in front of the first board the player has not cleared. For a new
    // player that is the very start, which is the point: the game is called Train Your Brain and the first thing
    // it hands you is a brain. For a player who has already cleared a hundred countries it is the board they were
    // about to play, so the new boards are the next thing they meet rather than never (appending would be never)
    // and rather than a wall (putting them first would lock the country they were on until all of these were done).
    const focus = focusLevels();
    if (!focus.length) return tour;
    const at = tour.findIndex(L => !store.get('lv:' + L.id));
    return at < 0 ? tour.concat(focus) : tour.slice(0, at).concat(focus, tour.slice(at));
  }
  // ── Home country: the tour starts at the player's own country and spreads out from there ──
  // Cloudflare tells the server which country a connection comes from (games/geo.php passes on the two-letter code,
  // nothing is stored); the browser's language region is the fallback. The first answer is kept, so the order stays
  // put when the player travels; Settings → Home country changes it.
  async function homeCountry(d) {
    const saved = store.get('home', null);
    if (saved != null) return saved;   // '' = keep the canonical order (chosen explicitly)
    let c = '';
    try { const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 2500); const r = await fetch('/games/geo.php', { signal: ctrl.signal, cache: 'no-store' }); clearTimeout(t); if (r.ok) c = ((await r.json()).c || '').toUpperCase(); } catch { /* offline or local: fall back */ }
    if (!c) { const m = /-([A-Za-z]{2})$/.exec(navigator.language || ''); if (m) c = m[1].toUpperCase(); }
    if (!d.canon.some(L => L.a2 === c)) c = '';
    // A guess, not a choice. The distinction matters now that this travels: a new phone that guessed
    // Bangladesh must not overwrite an account whose owner deliberately chose India.
    if (c) { store.set('home', c); store.set('homeAuto', true); }
    return c;
  }
  const kmBetween = (a, b) => { const R = Math.PI / 180, dl = (b[0] - a[0]) * R, dp = (b[1] - a[1]) * R, h = Math.sin(dp / 2) ** 2 + Math.cos(a[1] * R) * Math.cos(b[1] * R) * Math.sin(dl / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };
  function orderFor(d, home) {
    const H = d.canon.find(L => L.a2 === home);
    if (!H) return d.canon.slice();
    return [H].concat(d.canon.filter(L => L !== H).sort((a, b) => kmBetween(H.c, a.c) - kmBetween(H.c, b.c)));
  }
  const isCountry = L => !L.disc && !L.focus && !L.scene;
  const firstCountry = () => DATA.levels.find(isCountry);
  function setHome(a2) { store.set('home', a2); store.set('homeAuto', false); DATA.levels = tourFor(DATA, a2); maskCache.clear(); forgetNums(); renderSelect(); }

  // ── Lobby world map ──
  // Every country faint; the tour countries outlined; cleared ones filled and numbered with their level;
  // the next level pulsing. Tap a country to play its level. Built by games/build-world-map.mjs.
  let MAP = null, mapPromise = null, mapDrawn = false;
  const ART_VERSION = 3;   // games/data/art.json: the gallery, 247 works, tagged by country and tradition, since September 2026
  function loadMap() {
    if (!mapPromise) mapPromise = fetch(`/games/data/world-map.json?v=${MAP_VERSION}`, { cache: 'force-cache' }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }).then(m => { MAP = m; return m; }).catch(e => { mapPromise = null; throw e; });
    return mapPromise;
  }
  function renderWorld() {
    if (!el.worldMap || !DATA) return;
    if (!MAP) { loadMap().then(renderWorld).catch(() => { el.worldMap.hidden = true; }); return; }
    const land = el.worldMap.querySelector('.aa-world-land'), labels = el.worldMap.querySelector('.aa-world-labels');
    const byId = new Map(DATA.levels.map((L, i) => [L.id, i]));
    if (!mapDrawn) {
      mapDrawn = true;
      for (const c of MAP.countries) {
        const p = svgEl('path', { d: c.d, 'data-id': c.id });
        const i = byId.get(c.id);
        // Tapping a country starts that country's board. It used to send a player who tapped one they had
        // already cleared to its discovery board instead, whenever that board was still open — so the tap
        // opened a different board from the one under their finger. A country nobody has reached yet is still
        // locked: the tour is how you get there, and Play & Discover is what walks you along it.
        // The index is looked up on the tap, not kept from this first draw: choosing a home country reorders
        // the whole tour, and a position remembered from before that is some other country's.
        if (i != null) { p.classList.add('is-tour'); p.setAttribute('tabindex', '0'); p.setAttribute('role', 'button'); p.addEventListener('click', () => { const j = DATA.levels.findIndex(L => L.id === c.id); if (j < 0) return; if (!unlocked(j)) { toast(`${DATA.levels[j].name} is locked. Clear the levels before it first.`, 'bad'); return; } startLevel(j); }); p.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.click(); } }); }
        land.appendChild(p);
      }
    }
    labels.innerHTML = '';
    const n = DATA.levels.filter(isCountry).length, done = DATA.levels.filter((L, i) => isCountry(L) && cleared(i)).length;
    const nextIdx = DATA.levels.findIndex((_, j) => !cleared(j) && unlocked(j)), nextL = DATA.levels[nextIdx];
    const nextId = nextL ? (nextL.disc ? nextL.country.id : nextL.id) : null;
    for (const c of MAP.countries) {
      const i = byId.get(c.id); if (i == null) continue;
      const p = land.querySelector(`path[data-id="${c.id}"]`);
      const rec = cleared(i), isNext = c.id === nextId, open = unlocked(i);
      p.classList.toggle('is-done', !!rec); p.classList.toggle('is-next', isNext); p.classList.toggle('is-locked', !open);
      p.setAttribute('aria-label', rec ? `${DATA.levels[i].name}, cleared, replay` : isNext ? `${DATA.levels[i].name}, next, play` : open ? `${DATA.levels[i].name}, play` : `${DATA.levels[i].name}, locked`);
      // no numbers on the map: cleared countries are simply coloured in, only the next one gets a marker
      if (isNext) { const g = svgEl('g', { class: 'is-next' }); g.appendChild(svgEl('circle', { cx: c.cx, cy: c.cy, r: 9 })); labels.appendChild(g); }
    }
    // "discovered", which is what the game calls it everywhere else, and nothing after it: a player looking at
    // their own map does not need to be told a second time that the countries on it can be tapped. One
    // sentence in both states, including the first run — the tour opens on the player's own country, marked
    // and pulsing, so "tap the highlighted country" was explaining something the map already says.
    // Before the world tour starts there is nothing on this map to count, and "0 of 197 discovered" reads like
    // a failure rather than an invitation. It says what is ahead instead, until the first country is cleared.
    el.worldCap.textContent = done ? `${done} of ${n} countries discovered` : `${n} countries ahead of you`;

  }

  // ── The brain on the home screen ──
  // It is a board of this game and nothing else: the same rasteriser, the same generator, the same arrows in
  // the same line weights, at the difficulty the player is actually being dealt. So a player who has got
  // better comes home to a brain that is finer and busier than the one they started with — thirty-odd arrows
  // on Easy, ninety on Master — and the shape of the thing is the reason the game has its name.
  //
  // What fills it is what they have done: every board cleared lights another tenth of it, from the bottom up,
  // and the tenth board lights the lot. Ten is not a number picked for this — it is the game's own milestone.
  // ── Rank ──
  // The brain on the home screen carries a rank, and the rank is earned in arrows: every arrow shot off a board
  // the player cleared, on the tour or on the daily, counted from the records the tour already syncs. So a
  // phone and a tablet agree on it, a fresh device gets it back with the account, and clearing the same board
  // twice does not count it twice. It is not the level. A level says where a player is on the tour; a rank says
  // what they have done, and it is theirs to keep. Fourteen steps, from two Easy boards to GOAT at 6,236 arrows
  // -- about a hundred boards at the difficulty the game deals by then.
  const RANKS = [['Newbie', 0], ['Normal', 40], ['Learner', 120], ['Thinker', 250], ['Solver', 450], ['Skilled', 700], ['Sharp', 1000],
    ['Expert', 1400], ['Master', 1900], ['Genius', 2500], ['Grandmaster', 3300], ['Legend', 4200], ['Immortal', 5200], ['GOAT', 6236]];
  const ARROWS_GUESS = [22, 40, 55, 80, 100];   // a record saved before boards remembered their arrows counts the tier's typical board
  const fmtN = n => Number(n || 0).toLocaleString('en-US');
  const recArrows = r => (r && typeof r === 'object' && (r.arrows || ARROWS_GUESS[clampTier(r.tier || 0)])) || 0;
  // A rank is earned and it is lost. A board cleared adds its arrows; a board lost -- hearts gone -- takes
  // the arrows that were still on it. What is taken is kept per device (`loss`: device id to arrows), because
  // a count that only grows can be merged between devices by taking the larger, and a single shared number
  // could not; the total is the sum. Never below zero: nobody owes arrows.
  const lossMap = () => { const m = store.get('loss', {}); return m && typeof m === 'object' && !Array.isArray(m) ? m : {}; };
  const lossTotal = m => Object.values(m).reduce((a, v) => a + (Number(v) > 0 ? Math.floor(Number(v)) : 0), 0);
  function loseArrows(n) {
    if (!(n > 0)) return;
    const m = lossMap(); m[DEVICE] = (Number(m[DEVICE]) > 0 ? Math.floor(Number(m[DEVICE])) : 0) + Math.floor(n);
    store.set('loss', m);
  }
  function arrowsShot() {
    let n = 0;
    try {
      for (const k of Object.keys(localStorage)) {
        if (!k.startsWith(STORE + 'lv:') && !k.startsWith(STORE + 'daily:')) continue;
        n += recArrows(store.get(k.slice(STORE.length)));
      }
    } catch { /* storage can be unreadable in a private window */ }
    return Math.max(0, n - lossTotal(lossMap()));
  }
  function rankOf(n) {
    let i = 0; while (i + 1 < RANKS.length && n >= RANKS[i + 1][1]) i++;
    const top = i + 1 >= RANKS.length;
    return { i, name: RANKS[i][0], lo: RANKS[i][1], hi: top ? null : RANKS[i + 1][1], next: top ? null : RANKS[i + 1][0], top };
  }
  const emblemCache = new Map();
  function emblemFor(tier) {
    const em = FOCUS?.emblem; if (!em?.d || !em.k?.length) return null;
    if (!emblemCache.has(tier)) {
      const mask = rasterise(em.d, em.k[tier] ?? em.k[0]);
      const b = generate(mask, MAXLEN_OF[tier], 7000 + tier * 131, GEN_OPTS(tier));
      // the order they light in: lowest head first, so the brain fills the way a glass does
      const order = b.pieces.map((_, i) => i).sort((a, c) => b.pieces[c].cells[0][0] - b.pieces[a].cells[0][0]);
      emblemCache.set(tier, { W: b.W, H: b.H, pieces: b.pieces, order, d: em.d, mask });
    }
    return emblemCache.get(tier);
  }
  let brainKey = '';
  function renderBrain() {
    const svg = el.brainArt; if (!svg || !DATA) return;
    const tier = TIER_OF(), em = emblemFor(tier);
    const n = arrowsShot(), rk = rankOf(n), full = rk.top;
    // the brain fills with the arrows of the rank in hand, from the bottom up, and GOAT lights the lot in green
    const frac = full ? 1 : (n - rk.lo) / (rk.hi - rk.lo);
    if (el.brainLv) el.brainLv.textContent = rk.name;
    // Two words and no more: the rank, and the level. How far the next rank is, the brain itself shows; what
    // a board added or cost, the card after it says.
    if (el.brainNote) el.brainNote.textContent = `Level ${levelNo(-1)}`;   // the main count: boards and training clears
    if (!em) { svg.hidden = true; return; }
    svg.hidden = false;
    const lit = full ? em.pieces.length : Math.min(em.pieces.length - 1, Math.round(em.pieces.length * frac));
    const key = `${tier}:${lit}:${full ? 1 : 0}`;
    if (key === brainKey) return;
    brainKey = key;
    const rank = new Map(em.order.map((idx, r) => [idx, r]));
    const litSet = new Set(em.order.slice(0, lit));
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    svg.innerHTML = '';
    svg.setAttribute('viewBox', `-0.6 -0.6 ${em.W + 1.2} ${em.H + 1.2}`);
    svg.classList.toggle('is-drawing', !still);
    // The outline itself, under the arrows. Thirty arrows cannot draw a brain — a fold is smaller than a cell at
    // this size, and what survives the raster is a lumpy blob. So the silhouette is drawn as a path, at the
    // resolution it was designed at, and the arrows fill it. Cell (c, r) has its centre at (c + 0.5) / k in the
    // path's own 0–100 box, and the mask was cropped to its bounding box, which is the whole of the transform.
    svg.appendChild(svgEl('path', { class: 'aa-brain-wash', d: em.d, 'fill-rule': 'evenodd',
      transform: `translate(${-em.mask.x} ${-em.mask.y}) scale(${em.mask.k})` }));
    const g = svgEl('g', { class: 'aa-brain-pieces' });
    em.pieces.forEach((p, i) => {
      const [dr, dc] = DIRS[p.dir], head = p.cells[0];
      const hx = head[1] + 0.5, hy = head[0] + 0.5, tipX = hx + dc * 0.32, tipY = hy + dr * 0.32;
      const body = p.cells.slice().reverse().map(([y, x]) => `${x + 0.5} ${y + 0.5}`).join('L');
      const pg = svgEl('g', { class: 'aa-brain-p' + (litSet.has(i) ? ' is-lit' : '') });
      if (!still) {
        pg.style.transitionDelay = `${Math.min(rank.get(i) ?? 0, 60) * 9}ms`;
        // Once lit, an arrow keeps moving: a small step along its own direction and back, each on its own
        // beat, so the brain reads as alive -- cells firing -- and never as a still drawing.
        pg.style.setProperty('--dx', `${dc * 0.22}px`); pg.style.setProperty('--dy', `${dr * 0.22}px`);
        pg.style.animationDelay = `${((i * 137) % 2600)}ms`;
      }
      pg.appendChild(svgEl('path', { class: 'aa-brain-track', d: `M${body}L${tipX} ${tipY}` }));
      const headG = svgEl('g', { transform: `translate(${tipX} ${tipY}) rotate(${ARROW[p.dir]})` });
      headG.appendChild(svgEl('path', { class: 'aa-brain-head', d: 'M-0.36 -0.3 L0.14 0 L-0.36 0.3 Z' }));
      pg.appendChild(headG);
      g.appendChild(pg);
    });
    svg.appendChild(g);
    if (!still) requestAnimationFrame(() => requestAnimationFrame(() => svg.classList.remove('is-drawing')));
  }

  // The three numbers under the map: everything cleared, the countries among it, and the daily streak. They are
  // counted here rather than inside renderWorld because a map that could not be fetched still leaves a player
  // with a hundred boards behind them, and three zeroes would be a lie about their own game.
  function renderHomeStats() {
    if (!DATA || !el.statBoards) return;
    const cleared_ = DATA.levels.filter((_, i) => cleared(i));
    el.statBoards.textContent = String(cleared_.length);
    el.statCountries.textContent = String(cleared_.filter(isCountry).length);
    // Days played in a row, and nothing decays the stored record, so it counts only while it is still alive:
    // played today, or played yesterday with today still to come.
    const ps = store.get('playStreak', { count: 0, last: '' });
    const alive = ps.last === dayKey() || ps.last === dayKeyBack(1);
    el.statStreak.textContent = String(alive ? ps.count || 0 : 0);
  }

  // ── The home deck ──
  // The brain and the world map used to sit one above the other, which asked the player which of the two they
  // were meant to be looking at and pushed the second button off the bottom of the screen. One card is on
  // screen now. It turns itself every few seconds so both are seen without anybody being asked to do anything;
  // the moment the player turns it themselves — a swipe, a dot, an arrow key — it stops turning on its own and
  // stays where they put it.
  const DECK_EVERY = 4500, DECK_SWIPE = 44, DECK_SLOP = 15;   // 15px: under that a finger is tapping, not swiping
  const deck = { i: 0, n: 2, timer: 0, hide: 0, auto: true, drag: null, swipedAt: 0 };
  let showBrainNext = false;   // set when a board is cleared: the brain has just changed and it is what to come home to
  const deckStop = () => { clearInterval(deck.timer); deck.timer = 0; };
  function deckStart() {
    deckStop();
    if (!el.deckTrack || !deck.auto || document.hidden || el.select?.hidden) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;   // nothing moves on its own here
    deck.timer = setInterval(() => { if (!deck.drag) deckGo(deck.i + 1); }, DECK_EVERY);   // never mid-gesture
  }
  // `manual` is a gesture, a dot or a key, and those stop at the ends: a card that gave way under the finger and
  // then jumped to the far end of the deck is a card that lied about where it was going. The timer wraps.
  function deckGo(i, manual, first) {
    if (!el.deckTrack) return;
    deck.i = manual ? Math.max(0, Math.min(deck.n - 1, i)) : ((i % deck.n) + deck.n) % deck.n;
    el.deckTrack.style.transform = `translateX(${-deck.i * 100}%)`;
    // Somebody reading the card with a keyboard or a screen reader is standing on it: hiding a card with the
    // focus inside it throws that focus back to the top of the document mid-sentence. Move them to the dot for
    // the card they are being shown first, and only then put the other card out of reach.
    const slides = [...el.deckTrack.children];
    if (el.deckTrack.contains(document.activeElement)) el.deckDots?.children[deck.i]?.focus({ preventScroll: true });
    clearTimeout(deck.hide);
    // The card arriving is reachable at once; the one leaving is put out of reach only once it has left, because
    // it is on screen for the length of the slide. aria-hidden also hides it outright in CSS, which is what
    // keeps a browser too old for `inert` from letting the Tab key walk into a card nobody can see.
    slides[deck.i].inert = false; slides[deck.i].setAttribute('aria-hidden', 'false');
    const hide = () => slides.forEach((sl, k) => { if (k !== deck.i) { sl.inert = true; sl.setAttribute('aria-hidden', 'true'); } });
    if (first) hide(); else deck.hide = setTimeout(hide, 420);
    if (el.deckDots) [...el.deckDots.children].forEach((d, k) => { d.classList.toggle('is-on', k === deck.i); if (k === deck.i) d.setAttribute('aria-current', 'true'); else d.removeAttribute('aria-current'); });
    // While it is turning on its own it says nothing — a screen reader reading a card out every four seconds is
    // noise. Once the player has taken it over, the card they asked for is announced.
    el.deckTrack.parentElement?.setAttribute('aria-live', deck.auto ? 'off' : 'polite');
    if (manual) { deck.auto = false; deckStop(); }
  }
  if (el.deck) {
    el.deckDots?.addEventListener('click', e => { const b = e.target.closest('[data-slide]'); if (b) deckGo(+b.dataset.slide, true); });
    // a keyboard or a screen reader arriving in the deck is somebody reading it: it stops turning under them
    el.deck.addEventListener('focusin', () => { deck.auto = false; deckStop(); });
    el.deck.addEventListener('keydown', e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;   // Alt+Arrow is the browser's Back, not ours
      e.preventDefault(); deckGo(deck.i + (e.key === 'ArrowRight' ? 1 : -1), true);
    });
    // A drag decides on its first few pixels whether it is a swipe or the page being scrolled, and never both.
    el.deck.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // A finger on the deck stops the clock: a card that turns itself out from under a tap sends that tap to
      // whatever slid into its place. If the touch turns out to be a plain tap, the clock starts again.
      deckStop();
      deck.swipedAt = 0; { const q = ptOf(e); deck.drag = { x: q.x, y: q.y, dx: 0, lock: null }; }
    });
    el.deck.addEventListener('pointermove', e => {
      const d = deck.drag; if (!d) return;
      const q = ptOf(e);
      d.dx = q.x - d.x; const dy = q.y - d.y;
      if (d.lock === null && (Math.abs(d.dx) > DECK_SLOP || Math.abs(dy) > 8)) d.lock = Math.abs(d.dx) > Math.abs(dy) ? 'x' : 'y';
      if (d.lock !== 'x') return;
      // at the ends the card gives about a third as far, so a swipe that cannot go anywhere says so
      const edge = (deck.i === 0 && d.dx > 0) || (deck.i === deck.n - 1 && d.dx < 0);
      el.deckTrack.classList.add('is-dragging');
      el.deckTrack.style.transform = `translateX(calc(${-deck.i * 100}% + ${Math.round(edge ? d.dx / 3 : d.dx)}px))`;
    });
    const dragEnd = () => {
      const d = deck.drag; deck.drag = null;
      if (!d) return;
      el.deckTrack.classList.remove('is-dragging');
      // A tap that slid a few pixels is still a tap, and so is one that ended up scrolling the page: neither may
      // cost the player the country under their thumb. Only a gesture that took the deck sideways eats its click.
      if (d.lock !== 'x') { deckStart(); return; }
      deck.swipedAt = performance.now();   // a swipe is not a tap: whatever it ended on must not be clicked
      if (Math.abs(d.dx) > DECK_SWIPE) deckGo(deck.i + (d.dx < 0 ? 1 : -1), true);
      else deckGo(deck.i, true);
    };
    el.deck.addEventListener('pointerup', dragEnd);
    el.deck.addEventListener('pointercancel', dragEnd);
    el.deck.addEventListener('pointerleave', dragEnd);
    // the tap that ended a swipe lands on a country: swallow it before the map ever hears about it
    // Only the click that the swipe itself produces, which arrives in the same breath as the release. A flag left
    // standing would eat the next real tap — or the next Enter on a country, which also arrives as a click.
    el.deck.addEventListener('click', e => {
      if (!deck.swipedAt || performance.now() - deck.swipedAt > 400) return;
      if (e.target.closest('.aa-deck-dots')) return;   // the dots are how you undo a swipe; they are never eaten
      deck.swipedAt = 0; e.stopPropagation(); e.preventDefault();
    }, true);
  }

  // ── Level select ──
  function renderSelect() {
    if (!DATA) return;
    renderWorld();
    renderBrain();
    renderHomeStats();
    if (showBrainNext) { showBrainNext = false; deck.i = 0; }
    deckGo(deck.i, false, true);
    deckStart();
    const n = DATA.levels.length;
    renderPurse(); renderTrainPill();
    const nextIdx = DATA.levels.findIndex((_, j) => !cleared(j) && unlocked(j));
    el.play.dataset.level = nextIdx < 0 ? 0 : nextIdx;
    // one button, one label: Play & Discover (no level number or tier: the game picks the next country and its difficulty)
    renderHome();
    if (el.path) { el.path.innerHTML = '';
    const start = Math.max(0, (nextIdx < 0 ? n - 1 : nextIdx) - 1);
    for (let i = start; i < Math.min(n, start + 5); i++) {
      const d = document.createElement('button'); d.type = 'button';
      d.className = 'aa-dot' + (cleared(i) ? ' is-done' : '') + (i === nextIdx ? ' is-current' : '') + (unlocked(i) ? '' : ' is-locked');
      d.textContent = String(levelNo(i)); d.disabled = !unlocked(i); d.setAttribute('aria-label', `Level ${levelNo(i)}`);
      d.addEventListener('click', () => startLevel(i));
      el.path.appendChild(d);
    } }
    renderThemes();
  }

  // Today's Country used to be a row in Settings. The board itself is still here — dailyPick() decides it,
  // a #daily link still opens it, and a cleared one is still recorded and synced — it simply no longer sits in
  // Settings, where a board to play was the odd thing among rows that change a setting.

  // ── Board masks ──
  // A level stores only its outline (`d`, absolute M/L/Z in a REF×REF box) and one scale per tier (`k`, cells per
  // unit). The grid mask is rasterised here with the very same code the build script used to choose k, so every
  // player gets the same board. Even-odd point-in-polygon at cell centres; specks under 4 cells are dropped.
  const REF = 100;
  function parsePath(d) {
    const rings = []; let ring = null; const re = /[MLZ]|-?\d+(?:\.\d+)?/g; let m, pending = [];
    while ((m = re.exec(d))) {
      const t = m[0];
      if (t === 'M') { ring = []; rings.push(ring); pending = []; }
      else if (t === 'L') pending = [];
      else if (t === 'Z') { ring = null; }
      else { pending.push(+t); if (pending.length === 2) { ring.push(pending); pending = []; } }
    }
    return rings.filter(r => r.length >= 3);
  }
  function insidePath(rings, x, y) {
    let c = false;
    for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  }
  function rasterise(d, k, rings = parsePath(d)) {
    const S = Math.ceil(REF * k) + 1;
    const cells = [];
    for (let r = 0; r < S; r++) { const row = new Array(S); for (let c = 0; c < S; c++) row[c] = insidePath(rings, (c + 0.5) / k, (r + 0.5) / k) ? 1 : 0; cells.push(row); }
    const seen = cells.map(row => row.map(() => false));
    for (let r = 0; r < S; r++) for (let c = 0; c < S; c++) {
      if (!cells[r][c] || seen[r][c]) continue;
      const comp = []; const stack = [[r, c]]; seen[r][c] = true;
      while (stack.length) { const [y, x] = stack.pop(); comp.push([y, x]); for (const [dy, dx] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const ny = y + dy, nx = x + dx; if (ny >= 0 && nx >= 0 && ny < S && nx < S && cells[ny][nx] && !seen[ny][nx]) { seen[ny][nx] = true; stack.push([ny, nx]); } } }
      if (comp.length < 4) for (const [y, x] of comp) cells[y][x] = 0;
    }
    let r0 = S, r1 = -1, c0 = S, c1 = -1;
    for (let r = 0; r < S; r++) for (let c = 0; c < S; c++) if (cells[r][c]) { r0 = Math.min(r0, r); r1 = Math.max(r1, r); c0 = Math.min(c0, c); c1 = Math.max(c1, c); }
    if (r1 < 0) return { k, x: 0, y: 0, rows: [], count: 0, w: 0, h: 0 };
    const rows = cells.slice(r0, r1 + 1).map(row => row.slice(c0, c1 + 1).join(''));
    return { k, x: c0, y: r0, rows, count: rows.join('').split('1').length - 1, w: rows[0].length, h: rows.length };
  }
  const maskCache = new Map();
  // ── Discovery boards ──
  // After a country's outline comes a level shaped like something a traveller finds there: its animal, its bird or
  // a landmark (Twemoji silhouettes, see games/build-discover-boards.mjs). Same generator, same tiers, its own quiz;
  // one numbered list with the countries (see tourFor).
  let DISCB = null, discbPromise = null;
  function loadDiscBoards() {
    if (!discbPromise) discbPromise = fetch(`/games/data/discover-boards.json?v=${DISCB_VERSION}`, { cache: 'force-cache' }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }).then(d => { DISCB = d; return d; }).catch(e => { discbPromise = null; throw e; });   // a failure is not remembered: the next Play tries again
    return discbPromise;
  }
  const KIND_WORD = { a: 'animal', b: 'bird', p: 'place' };
  const escapeHtml = str => String(str).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
  const discCache = new Map();
  // the discovery level of country C: a level of its own that borrows the shape's outline and scales
  function discLevelFor(C) {
    const b = DISCB?.boards?.[C.a2], sh = b && DISCB.shapes[b.hex]; if (!sh) return null;
    if (!discCache.has(C.id)) discCache.set(C.id, { id: 'd:' + C.id, name: b.name, kind: b.kind, hex: b.hex, rel: b.rel, fact: b.fact, d: sh.d, k: sh.k, country: C, disc: true });
    return discCache.get(C.id);
  }
  // ── Focus boards ──
  // The boards the game opens on: a brain, a lightbulb, a key, a cog, a puzzle piece — the game's own language
  // rather than a country's (games/build-focus-boards.mjs draws them). Same generator, same tiers, same result
  // card, with one difference that is the whole point of them: a country board has something to tell you when
  // you clear it and one of these has not, so it says nothing (see showResult).
  //
  // Their progress stays on the device. The account's progress is a list of country ids, and a board that is not
  // a country has no place in it; sending one could only be refused. It costs a returning player a replay on a
  // new phone, which is a small price for not putting the whole sync at risk.
  let FOCUS = null, focusPromise = null;
  function loadFocusBoards() {
    // A failure here is not fatal: without them the tour is the world tour, exactly as it was.
    if (!focusPromise) focusPromise = fetch(`/games/data/focus-boards.json?v=${FOCUS_VERSION}`, { cache: 'force-cache' }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }).then(d => { FOCUS = d; return d; }).catch(() => null);
    return focusPromise;
  }
  const focusCache = new Map();
  function focusLevels() {
    if (!Array.isArray(FOCUS?.boards)) return [];
    return FOCUS.boards.map(b => {
      if (!focusCache.has(b.id)) focusCache.set(b.id, { id: 'f:' + b.id, name: b.name, d: b.d, k: b.k, focus: true });
      return focusCache.get(b.id);
    });
  }
  // Every board syncs, the focus boards included. They used to be kept on the device alone, and the account
  // then looked different on every phone: one had cleared the brain and the key and stood on level 106, the
  // other had the same countries from the server but met the brain again at level 81. One tour, one number.
  const isLocalOnly = () => false;
  // ── Scene boards ──
  // Big, plain shapes that exist to be full of arrows -- a tower, a pair of towers, an arena, a cross -- the
  // size a long game is (games/build-scene-boards.mjs draws them). One sits in the tour after every fourth
  // country, one tier harder than the player's own, and is cleared and synced under its own id like any board.
  let SCENES = null, scenePromise = null;
  function loadSceneBoards() {
    if (SCENES) return Promise.resolve(SCENES);
    if (!scenePromise) scenePromise = fetch(`/games/data/scene-boards.json?v=${SCENE_VERSION}`, { cache: 'force-cache' }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }).then(d => { SCENES = d; return d; }).catch(() => null);
    return scenePromise;
  }
  const sceneCache = new Map();
  const SCENE_EVERY = 4;
  function sceneLevelFor(n) {
    const list = Array.isArray(SCENES?.boards) ? SCENES.boards : [];
    if (!list.length) return null;
    const b = list[n % list.length];
    if (!sceneCache.has(b.id)) sceneCache.set(b.id, { id: 's:' + b.id, name: b.name, d: b.d, k: b.k, scene: true });
    return sceneCache.get(b.id);
  }

  // the next board to play after i: the first open one further down the list (cleared boards are skipped, so Next
  // never lands on a replay), else the first open one anywhere, else nothing (-1)
  function nextOpen(i) {
    const open = j => !cleared(j) && unlocked(j);
    for (let j = i + 1; j < DATA.levels.length; j++) if (open(j)) return j;
    for (let j = 0; j <= i && j < DATA.levels.length; j++) if (open(j)) return j;
    return -1;
  }
  const hudLabel = () => {
    if (state.daily?.race) { const R = state.daily; return R.boards && R.boards.length > 1 ? `Board ${(R.bi | 0) + 1} of ${R.boards.length}` : 'Challenge'; }
    if (state.daily) return 'Daily';
    return `Level ${levelNo(state.idx)}${state.level?.scene ? ' · ' + state.level.name : ''}`;
  };
  const maskFor = (L, tier) => {
    const key = L.id + ':' + tier;
    if (!maskCache.has(key)) {
      const k = L.k[tier];
      let scale = KSCALE_OF[tier];   // the finer grid of the top tiers, on the tour and the focus and scene boards alike
      if (scale !== 1) {
        const base = rasterise(L.d, k);
        scale = Math.max(1, Math.min(scale, Math.sqrt(CELL_CAP_OF[tier] / Math.max(1, base.count)), SIDE_CAP / Math.max(1, base.w, base.h)));
      }
      let m = scale === 1 ? rasterise(L.d, k) : rasterise(L.d, k * scale);
      // both top tiers can run into the same cap; a higher tier is never the smaller board for it
      if (tier > 0) { const below = maskFor(L, tier - 1); if (below.count > m.count) m = below; }
      maskCache.set(key, m);
    }
    return maskCache.get(key);
  };

  // ── Puzzle generation ──
  // Two stages, like a maze that is drawn first and signposted after.
  // 1. Layout: the shape is covered with long snakes (a path cover): each walk starts at the most hemmed-in free
  //    cell, prefers straight runs, hugs the coast when it starts there, and steps into any nook it passes, so
  //    almost nothing is left over as a lone cell. A share of inland cells is carved out first as straight lanes.
  // 2. Signposting: every piece gets an order number `ord`; the solution removes pieces newest-first, and two
  //    pairwise rules keep that valid whatever the player does (removing a piece only ever frees cells):
  //    everything on a piece's run must be newer than it, everything whose run crosses one of its cells must be
  //    older. Each snake can carry its head at either end (the head continues the last segment); an end is legal
  //    when a fractional ord fits between the pieces its run crosses and the pieces it points at. Among legal ends
  //    the game prefers, per tier, one that points at pieces (`narrow`: it is then blocked until they go), across
  //    a gap (`far`: the arrow it frees when it goes is that far away), and with more pieces on its run. A snake
  //    with no legal end is split in two and tried again; a lone inland cell that fits nowhere becomes a gap.
  function generate(mask, maxLen, seed, { far = 0.5, hug = 0.6, narrow = 0.8, rail = 0.2, holes = 0.2, lane = 3, tighten = 0, trapw = 0 } = {}) {
    const H = mask.rows.length, W = mask.rows[0].length;
    const land = mask.rows.map(r => r.split('').map(ch => ch === '1'));
    const shape = land.map(r => r.slice());   // the country itself; `land` loses the gaps
    const inb = (y, x) => y >= 0 && y < H && x >= 0 && x < W;
    const isLand = (y, x) => inb(y, x) && land[y][x];
    const dirs = Object.values(DIRS), dirKeys = Object.keys(DIRS);
    const coast = new Set();
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (land[r][c]) { let edge = false; for (let dy = -1; dy <= 1 && !edge; dy++) for (let dx = -1; dx <= 1; dx++) if ((dy || dx) && !isLand(r + dy, c + dx)) { edge = true; break; } if (edge) coast.add(r * W + c); }
    // lanes: straight runs of 1..lane empty cells, inland, never beside another gap, land at both ends
    {
      const rnd0 = mulberry32(seed * 31337 + 5);
      const inland = []; for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (land[r][c] && !coast.has(r * W + c)) inland.push([r, c]);
      for (let i = inland.length - 1; i > 0; i--) { const j = Math.floor(rnd0() * (i + 1)); [inland[i], inland[j]] = [inland[j], inland[i]]; }
      let want = Math.round(inland.length * holes);
      const okHole = (y, x, dy, dx) => isLand(y, x) && !coast.has(y * W + x) && !(dy ? (!isLand(y, x - 1) && shape[y][x - 1]) || (!isLand(y, x + 1) && shape[y][x + 1]) : (!isLand(y - 1, x) && shape[y - 1][x]) || (!isLand(y + 1, x) && shape[y + 1][x]));
      for (const [r, c] of inland) {
        if (want <= 0) break;
        if (!land[r][c]) continue;
        const [dy, dx] = dirs[Math.floor(rnd0() * 4)]; const len = 1 + Math.floor(rnd0() * Math.max(1, lane));
        const run = []; for (let k = 0; k < len; k++) { const y = r + dy * k, x = c + dx * k; if (!okHole(y, x, dy, dx)) break; run.push([y, x]); }
        if (!run.length) continue;
        const [ay, ax] = [run[0][0] - dy, run[0][1] - dx], [by, bx] = [run[run.length - 1][0] + dy, run[run.length - 1][1] + dx];
        if (!isLand(ay, ax) || !isLand(by, bx)) continue;
        for (const [y, x] of run) land[y][x] = false; want -= run.length;
      }
    }
    const landBase = land.map(r => r.slice());
    for (let attempt = 0; attempt < 60; attempt++) {
      const rnd = mulberry32(seed * 7919 + attempt * 104729 + 17);
      for (let r = 0; r < H; r++) land[r] = landBase[r].slice();
      const occ = Array.from({ length: H }, () => new Array(W).fill(-1));
      const freeCell = (y, x) => isLand(y, x) && occ[y][x] < 0;
      const freeNb = (y, x) => dirs.filter(([a, b]) => freeCell(y + a, x + b)).length;
      // ── 1. layout ──
      const paths = [];
      const empty = new Set(); for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (land[r][c]) empty.add(r * W + c);
      const straightP = 0.62 + 0.3 * rail;
      while (empty.size) {
        // start at the most hemmed-in free cell (nooks and dead ends first), ties at random
        let best = null, bestN = 9; const pool = Array.from(empty);
        for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
        for (const cell of pool) { const y = Math.floor(cell / W), x = cell % W; const n = freeNb(y, x); if (n < bestN) { best = [y, x]; bestN = n; if (n <= 1) break; } }
        const [sy, sx] = best;
        const target = Math.max(2, Math.round(maxLen * (0.5 + 0.5 * rnd())));
        const hugging = coast.has(sy * W + sx) && rnd() < hug;
        const path = [[sy, sx]]; let py = sy, px = sx, pdir = null;
        const idx = paths.length; occ[sy][sx] = idx; empty.delete(sy * W + sx);
        while (path.length < target) {
          const opts = dirs.filter(([a, b]) => freeCell(py + a, px + b));
          if (!opts.length) break;
          const nooks = opts.filter(([a, b]) => freeNb(py + a, px + b) === 0);
          const coastOpts = hugging ? opts.filter(([a, b]) => coast.has((py + a) * W + px + b)) : [];
          const from = nooks.length && rnd() < 0.9 ? nooks : coastOpts.length ? coastOpts : opts;
          const straight = pdir && from.find(([a, b]) => a === pdir[0] && b === pdir[1]);
          const step = straight && rnd() < straightP ? straight : from[Math.floor(rnd() * from.length)];
          py += step[0]; px += step[1]; pdir = step; path.push([py, px]); occ[py][px] = idx; empty.delete(py * W + px);
        }
        paths.push(path);
      }
      // lone cells join a neighbouring path at one of its ends
      for (let i = 0; i < paths.length; i++) {
        if (paths[i].length !== 1) continue;
        const [y, x] = paths[i][0]; let done = false;
        for (const [a, b] of dirs) {
          const j = occ[y + a]?.[x + b]; if (j == null || j < 0 || j === i || paths[j].length === 0) continue;
          const P = paths[j]; const [hy, hx] = P[0], [ty, tx] = P[P.length - 1];
          if (ty === y + a && tx === x + b) { P.push([y, x]); done = true; }
          else if (hy === y + a && hx === x + b) { P.unshift([y, x]); done = true; }
          if (done) { occ[y][x] = j; paths[i] = []; break; }
        }
      }
      // ── 2. signposting ──
      // "A blocks B" when A's cells lie on B's run: A must go before B. Orientations are legal as long as that
      // graph stays acyclic; every legal board then has a removal order (a topological order), which is what
      // the ords record at the end. All cells are covered, so the pieces on a run are known before they are
      // signposted: n counts them (n = 0 means free from the start), gap counts the empty cells right ahead.
      const pieces = [];               // { idx, cells, dir }; index = path index
      const blocks = new Map();        // A -> Set of B that A blocks (signposted pieces only)
      const OPP = { r: 'l', l: 'r', u: 'd', d: 'u' };
      const onRay = (r, c, d) => { const [dr, dc] = DIRS[d]; let y = r + dr, x = c + dc; const R = new Set(); let gap = 0, seen = false; while (inb(y, x)) { const i = occ[y][x]; if (i >= 0) { R.add(i); seen = true; } else if (!seen && shape[y][x]) gap++; y += dr; x += dc; } return { R, gap }; };
      // oriented pieces whose run crosses any of these cells (the cells will block them)
      const crossing = (cells, self) => { const L = new Set(); for (const [r, c] of cells) for (const [d, [dr, dc]] of Object.entries(DIRS)) { let y = r + dr, x = c + dc; while (inb(y, x)) { const i = occ[y][x]; if (i >= 0 && i !== self && pieces[i] && pieces[i].cells[0][0] === y && pieces[i].cells[0][1] === x && pieces[i].dir === OPP[d]) L.add(i); y += dr; x += dc; } } return L; };
      const reaches = (from, targets) => { if (!from.size || !targets.size) return false; const seen = new Set(from), stack = [...from]; while (stack.length) { const a = stack.pop(); if (targets.has(a)) return true; for (const b of blocks.get(a) || []) if (!seen.has(b)) { seen.add(b); stack.push(b); } } return false; };
      const onOwnRun = (cells, d) => { const [hy, hx] = cells[0]; return cells.some(([y, x]) => (DIRS[d][0] ? x === hx && Math.sign(y - hy) === DIRS[d][0] : y === hy && Math.sign(x - hx) === DIRS[d][1])); };
      const choices = (path, self) => {
        const out = [];
        const ends = path.length === 1 ? dirKeys.map(d => ({ cells: path, dir: d })) : [{ cells: path, dir: dirKeys.find(k => path[1][0] + DIRS[k][0] === path[0][0] && path[1][1] + DIRS[k][1] === path[0][1]) }, { cells: path.slice().reverse(), dir: dirKeys.find(k => path[path.length - 2][0] + DIRS[k][0] === path[path.length - 1][0] && path[path.length - 2][1] + DIRS[k][1] === path[path.length - 1][1]) }];
        for (const e of ends) {
          if (!e.dir || onOwnRun(e.cells, e.dir)) continue;
          const { R, gap } = onRay(e.cells[0][0], e.cells[0][1], e.dir);
          const L = crossing(e.cells, self);
          const Ro = new Set([...R].filter(i => pieces[i]));      // oriented pieces on the run: they must go first
          if ([...L].some(i => Ro.has(i)) || reaches(L, Ro)) continue;   // a piece it blocks would have to go first: a cycle
          out.push({ ...e, R, L, n: R.size, gap });
        }
        return out;
      };
      // signpost the snake with the fewest legal ends first (ties at random), so choices are not squandered.
      // Counts are cached; a new signpost can only change them for snakes on its run or whose run crosses it,
      // and those all have a cell on one of the four rays from one of its cells.
      let queue = paths.map((p, i) => i).filter(i => paths[i].length);
      const count = new Map(queue.map(j => [j, choices(paths[j], j).length]));
      const refresh = cells => { const touched = new Set(); for (const [r, c] of cells) for (const [dr, dc] of dirs) { let y = r + dr, x = c + dc; while (inb(y, x)) { const j = occ[y][x]; if (j >= 0 && !pieces[j]) touched.add(j); y += dr; x += dc; } } for (const j of touched) if (paths[j].length) count.set(j, choices(paths[j], j).length); };
      let failed = false;
      while (queue.length) {
        let i = -1, bestN = 9, tie = 0;
        for (const j of queue) { const n = count.get(j); if (n < bestN || (n === bestN && rnd() < 1 / ++tie)) { if (n < bestN) tie = 1; i = j; bestN = n; } if (n === 0) break; }
        queue = queue.filter(j => j !== i); const path = paths[i]; const cs = choices(path, i);
        if (cs.length) {
          const wantBlocked = rnd() < narrow, wantFar = rnd() < far;
          cs.sort((a, b) => (((b.n > 0) - (a.n > 0)) || (wantFar ? b.gap - a.gap : 0) || (wantBlocked ? b.n - a.n : 0) || (rnd() - 0.5)));   // never free from the start when the other end can point at something
          const pick = cs[0];
          pieces[i] = { idx: i, cells: pick.cells, dir: pick.dir, color: PALETTE[i % PALETTE.length] };
          // edges only between signposted pieces (a split then leaves nothing stale): the signposted pieces on its
          // run block it; it blocks every signposted piece whose run crosses it. The edge between two pieces is
          // added when the later of the two is signposted, so the graph is complete at the end.
          for (const r of pick.R) if (pieces[r]) { if (!blocks.has(r)) blocks.set(r, new Set()); blocks.get(r).add(i); }
          for (const l of pick.L) { if (!blocks.has(i)) blocks.set(i, new Set()); blocks.get(i).add(l); }
          refresh(pick.cells); continue;
        }
        if (path.length >= 2) {
          const cut = Math.max(1, Math.floor(path.length / 2)); const tail = path.slice(cut); paths[i] = path.slice(0, cut);
          const j = paths.length; paths.push(tail); for (const [y, x] of tail) occ[y][x] = j;
          queue.push(i, j); count.set(i, choices(paths[i], i).length); count.set(j, choices(tail, j).length); continue;
        }
        const [y, x] = path[0];
        if (!coast.has(y * W + x)) { land[y][x] = false; occ[y][x] = -1; paths[i] = []; refresh([[y, x]]); continue; }
        failed = true; break;
      }
      if (!failed && tighten > 0) {
        // ── 3. tightening ──
        // Local search over head ends. Flip one arrow to its other end (and, when that would close a cycle, also
        // one arrow on its new run) whenever a simulated player who always takes the nearest free arrow then sees
        // fewer free arrows on average and at the start. The graph stays acyclic, so every board stays solvable.
        const alive = pieces.filter(Boolean); const N = alive.length; const at = new Map(alive.map((p, k) => [p.idx, k]));
        const endsOf = p => { const c = p.cells; if (c.length === 1) return dirKeys.map(d => ({ cells: c, dir: d })); const r = c.slice().reverse(); return [{ cells: c, dir: dirKeys.find(k => c[1][0] + DIRS[k][0] === c[0][0] && c[1][1] + DIRS[k][1] === c[0][1]) }, { cells: r, dir: dirKeys.find(k => r[1][0] + DIRS[k][0] === r[0][0] && r[1][1] + DIRS[k][1] === r[0][1]) }].filter(e => e.dir && !onOwnRun(e.cells, e.dir)); };
        const ends = alive.map(endsOf);
        const rayOf = e => { const [dr, dc] = DIRS[e.dir]; let [y, x] = e.cells[0]; y += dr; x += dc; const S = []; while (inb(y, x)) { const i = occ[y][x]; if (i >= 0 && at.has(i) && !S.includes(at.get(i))) S.push(at.get(i)); y += dr; x += dc; } return S; };
        const rays = ends.map(es => es.map(rayOf));   // alive indices on each run: they block that end
        // empty cells between an end and the first piece on its run, or -1 when nothing is there: an arrow with
        // two or more looks free at a glance and is not -- the trap a hard board is made of
        const gapOf = e => { const [dr, dc] = DIRS[e.dir]; let [y, x] = e.cells[0]; y += dr; x += dc; let g = 0; while (inb(y, x)) { const i = occ[y][x]; if (i >= 0 && at.has(i)) return g; g++; y += dr; x += dc; } return -1; };
        const gaps = ends.map(es => es.map(gapOf));
        const cur = alive.map((p, k) => ends[k].findIndex(e => e.dir === p.dir && e.cells[0][0] === p.cells[0][0] && e.cells[0][1] === p.cells[0][1]));
        if (cur.every(k => k >= 0)) {
          const bl = Array.from({ length: N }, () => new Set());
          for (let k = 0; k < N; k++) for (const a of rays[k][cur[k]]) bl[a].add(k);
          const reaches = (from, targets) => { const seen = new Uint8Array(N); const stack = [from]; seen[from] = 1; while (stack.length) { const a = stack.pop(); for (const c of bl[a]) { if (targets.includes(c)) return true; if (!seen[c]) { seen[c] = 1; stack.push(c); } } } return false; };
          const acyclic = () => { const indeg = new Int32Array(N); for (let k = 0; k < N; k++) indeg[k] = rays[k][cur[k]].length; const q = []; for (let k = 0; k < N; k++) if (!indeg[k]) q.push(k); let n = 0; while (q.length) { const a = q.pop(); n++; for (const c of bl[a]) if (--indeg[c] === 0) q.push(c); } return n === N; };
          const setEnd = (k, e) => { for (const a of rays[k][cur[k]]) bl[a].delete(k); cur[k] = e; for (const a of rays[k][e]) bl[a].add(k); };
          const width = () => {
            const gone = new Uint8Array(N); let left = N, sum = 0, start = 0, last = null;
            while (left) {
              let pick = -1, best = Infinity, cnt = 0;
              for (let k = 0; k < N; k++) { if (gone[k]) continue; let free = true; for (const a of rays[k][cur[k]]) if (!gone[a]) { free = false; break; } if (!free) continue; cnt++; const h = ends[k][cur[k]].cells[0]; const d = last ? Math.abs(h[0] - last[0]) + Math.abs(h[1] - last[1]) : 0; if (d < best) { best = d; pick = k; } }
              if (pick < 0) return Infinity;
              if (left === N) start = cnt; sum += cnt; gone[pick] = 1; left--; last = ends[pick][cur[pick]].cells[0];
            }
            let traps = 0; if (trapw) for (let k = 0; k < N; k++) if (gaps[k][cur[k]] >= 2) traps++;
            return sum / N + 0.3 * start - trapw * traps / N;
          };
          let score = width();
          for (let it = 0; it < tighten; it++) {
            const k = Math.floor(rnd() * N); if (ends[k].length < 2) continue;
            const e = (cur[k] + 1 + Math.floor(rnd() * (ends[k].length - 1))) % ends[k].length;
            const R = rays[k][e], changed = [[k, cur[k]]];
            setEnd(k, e);
            if (R.length && reaches(k, R)) {
              const qs = R.filter(q => ends[q].length > 1 && reaches(k, [q]));
              if (!qs.length) { setEnd(k, changed[0][1]); continue; }
              const q = qs[Math.floor(rnd() * qs.length)]; const eq = (cur[q] + 1 + Math.floor(rnd() * (ends[q].length - 1))) % ends[q].length;
              changed.push([q, cur[q]]); setEnd(q, eq);
              if (!acyclic()) { for (const [j, kk] of changed.reverse()) setEnd(j, kk); continue; }
            }
            const sc = width();
            if (sc <= score) score = sc; else for (const [j, kk] of changed.reverse()) setEnd(j, kk);
          }
          alive.forEach((p, k) => { p.cells = ends[k][cur[k]].cells; p.dir = ends[k][cur[k]].dir; });
          blocks.clear();
          for (let k = 0; k < N; k++) for (const a of rays[k][cur[k]]) { const ai = alive[a].idx; if (!blocks.has(ai)) blocks.set(ai, new Set()); blocks.get(ai).add(alive[k].idx); }
        }
      }
      if (!failed) {
        // ords from a topological order: pieces with nothing on their run go first (largest ord)
        const alive = pieces.filter(Boolean); const N = alive.length;
        const indeg = new Map(alive.map(p => [p.idx, 0]));
        for (const [a, bs] of blocks) if (pieces[a]) for (const b of bs) if (pieces[b]) indeg.set(b, indeg.get(b) + 1);
        const ready = alive.filter(p => indeg.get(p.idx) === 0).map(p => p.idx); let k = 0;
        while (ready.length) { const a = ready.shift(); pieces[a].ord = N - k++; for (const b of blocks.get(a) || []) if (pieces[b]) { indeg.set(b, indeg.get(b) - 1); if (indeg.get(b) === 0) ready.push(b); } }
        if (k !== N) failed = true;   // a cycle slipped through: try the next attempt
      }
      if (failed) continue;
      const alive = pieces.filter(Boolean);
      alive.forEach((p, k) => { p.idx = k; for (const [y, x] of p.cells) occ[y][x] = k; });
      return { W, H, pieces: alive, occ, land, shape };
    }
    throw new Error('could not generate a solvable board');
  }

  // Generate a few candidate boards from the seed and keep the narrowest (fewest arrows free at the start), so the
  // difficulty a tier promises does not depend on the luck of one seed. Candidates per tier: CANDIDATES_OF.
  const CANDIDATES_OF = [4, 6, 8, 8, 6];
  // Lower is better. A quick simulated player who always takes the free arrow nearest the one just tapped (the
  // way people actually play) measures how many arrows are free at any moment and how often the arrow freed by
  // a tap sits within two cells of it; lone arrowheads count too, and arrows free from the start most of all.
  function boardScore(b) {
    const { W, H, pieces } = b; const occ = b.occ.map(r => r.slice());
    const free = p => { const [dr, dc] = DIRS[p.dir]; let [y, x] = p.cells[0]; y += dr; x += dc; while (y >= 0 && y < H && x >= 0 && x < W) { if (occ[y][x] >= 0) return false; y += dr; x += dc; } return true; };
    let left = pieces.slice(), freeSet = new Set(left.filter(free)), start = freeSet.size, sumFree = 0, near = 0, freed = 0, last = null;
    while (left.length) {
      let p = null, best = Infinity;
      for (const q of freeSet) { const d = last ? Math.abs(last.cells[0][0] - q.cells[0][0]) + Math.abs(last.cells[0][1] - q.cells[0][1]) : 0; if (d < best) { best = d; p = q; } }
      if (!p) return Infinity;
      sumFree += freeSet.size; freeSet.delete(p); left = left.filter(q => q !== p); for (const [y, x] of p.cells) occ[y][x] = -1;
      for (const q of left) if (!freeSet.has(q) && free(q)) { freeSet.add(q); freed++; if (Math.abs(p.cells[0][0] - q.cells[0][0]) + Math.abs(p.cells[0][1] - q.cells[0][1]) <= 2) near++; }
      last = p;
    }
    const singles = pieces.filter(p => p.cells.length === 1).length;
    return sumFree / pieces.length + 2 * near / Math.max(1, freed) + 0.15 * start + 0.03 * singles;
  }
  function bestBoard(mask, tier, seed) {
    let best = null, bestScore = Infinity;
    for (let k = 0; k < CANDIDATES_OF[tier]; k++) {
      const b = generate(mask, MAXLEN_OF[tier], seed + k * 97, GEN_OPTS(tier)); const sc = boardScore(b);
      if (sc < bestScore) { best = b; bestScore = sc; }
    }
    return best;
  }

  // ── Board rendering ──
  const ARROW = { r: 0, d: 90, l: 180, u: 270 };
  function exitDistance(p) {
    const [dr, dc] = DIRS[p.dir]; const head = p.cells[0];
    return dr ? (dr > 0 ? state.H - head[0] : head[0] + 1) : (dc > 0 ? state.W - head[1] : head[1] + 1);
  }
  function renderBoard() {
    const { W, H, pieces } = state;
    const svg = el.board;
    svg.innerHTML = '';
    svg.setAttribute('viewBox', `-0.6 -0.6 ${W + 1.2} ${H + 1.2}`);
    // a three-colour gradient that flows along a shooting arrow: a short diagonal period, repeated,
    // slid continuously by SMIL so the colours stream through the arrow while it travels
    const defs = svgEl('defs');
    const grad = svgEl('linearGradient', { id: 'aaGrad', gradientUnits: 'userSpaceOnUse', spreadMethod: 'repeat', x1: 0, y1: 0, x2: GRAD_PERIOD, y2: GRAD_PERIOD });
    [['0', 'aa-grad-1'], ['0.33', 'aa-grad-2'], ['0.66', 'aa-grad-3'], ['1', 'aa-grad-1']].forEach(([o, c]) => grad.appendChild(svgEl('stop', { offset: o, class: c })));
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      grad.appendChild(svgEl('animateTransform', { attributeName: 'gradientTransform', type: 'translate', from: '0 0', to: `${GRAD_PERIOD} ${GRAD_PERIOD}`, dur: '0.5s', repeatCount: 'indefinite' }));
    }
    defs.appendChild(grad); svg.appendChild(defs);
    svg.classList.toggle('aa-board--tall', H > W * 1.25);
    const t = state.maskInfo;
    const outline = svgEl('path', { d: state.level.d, class: 'aa-outline', transform: `translate(${-t.x} ${-t.y}) scale(${t.k})` });
    svg.appendChild(outline);
    state.outlineEl = outline;
    // Guide dots (Settings → Guideline). The outline itself is made of arrows: see generate() phase 1.
    const land = state.land; const dots = svgEl('g', { class: 'aa-guides' });
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (land[r][c]) dots.appendChild(svgEl('circle', { cx: c + 0.5, cy: r + 0.5, r: 0.09 }));
    svg.appendChild(dots);
    const piecesG = svgEl('g', { class: 'aa-pieces' });
    for (const p of pieces) {
      const g = svgEl('g', { class: 'aa-piece', 'data-i': p.idx, tabindex: '0', role: 'button', 'aria-label': `Arrow pointing ${({ r: 'right', l: 'left', u: 'up', d: 'down' })[p.dir]}` });
      for (const [y, x] of p.cells) g.appendChild(svgEl('rect', { x, y, width: 1, height: 1, class: 'aa-hit' }));
      const [dr, dc] = DIRS[p.dir];
      const head = p.cells[0];
      const hx = head[1] + 0.5, hy = head[0] + 0.5;
      // track: tail → … → head centre → head tip, then straight on to just past the edge (hidden until shot)
      const pts = p.cells.slice().reverse().map(([y, x]) => `${x + 0.5} ${y + 0.5}`);
      const tipX = hx + dc * 0.32, tipY = hy + dr * 0.32;
      const exit = exitDistance(p) + 1;
      const d = `M${pts.join('L')}L${tipX} ${tipY}L${hx + dc * exit} ${hy + dr * exit}`;
      const bodyLen = (p.cells.length - 1) + 0.32, exitLen = exit - 0.32;
      const track = svgEl('path', { d, class: 'aa-track', 'stroke-dasharray': `${bodyLen} ${bodyLen + exitLen + 2}` });
      track.style.strokeDashoffset = '0';
      g.appendChild(track);
      const headG = svgEl('g', { class: 'aa-head-g', transform: `translate(${tipX} ${tipY}) rotate(${ARROW[p.dir]})` });
      headG.appendChild(svgEl('path', { d: 'M-0.36 -0.3 L0.14 0 L-0.36 0.3 Z', class: 'aa-head' }));
      g.appendChild(headG);
      p.bodyLen = bodyLen; p.exitLen = exitLen;
      // a tap shoots (or fails); pressing and holding shows the arrow's lane instead: green if it can go, red if not
      let holdTimer = 0, held = false, down = null;
      g.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse' && e.button !== 0) return; held = false; down = [e.clientX, e.clientY]; g.classList.add('is-pressed'); clearTimeout(holdTimer); holdTimer = setTimeout(() => { held = true; peek(p); }, HOLD_MS); });
      // screen coordinates on purpose, and correct on a turned page too: this is how far the finger moved,
      // and a distance is the same distance whichever way the page is rotated.
      g.addEventListener('pointermove', e => { if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 12) { clearTimeout(holdTimer); down = null; } });
      g.addEventListener('pointerup', () => { clearTimeout(holdTimer); g.classList.remove('is-pressed'); if (!down) return; down = null; if (held) { held = false; return; } tapPiece(p); });
      g.addEventListener('pointercancel', () => { clearTimeout(holdTimer); g.classList.remove('is-pressed'); down = null; });
      // A held mouse that slides off the arrow is no longer holding that arrow. The 12px move-cancel above
      // catches most of it, but a thin arrow can be left without travelling twelve pixels, and a check that
      // spends itself on an arrow the pointer is not over any more is a check taken for nothing. Mouse only:
      // a touch keeps its pointer captured until release, so cancelling there would break the gesture itself.
      g.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { clearTimeout(holdTimer); down = null; } });
      g.addEventListener('pointerleave', () => g.classList.remove('is-pressed'));
      g.addEventListener('contextmenu', e => e.preventDefault());
      g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tapPiece(p); } else if (e.key === 'l' || e.key === 'L') { e.preventDefault(); peek(p); } });
      p.el = g;
      piecesG.appendChild(g);
    }
    svg.appendChild(piecesG);
    state.lanesEl = svgEl('g', { class: 'aa-lanes' }); svg.appendChild(state.lanesEl);
    updateReveal();
  }
  // ── The run, as a thing that can be carried to another device ──
  //
  // A match resumes across devices, and until this the resumed board was a fresh one: the server knew how far
  // a player had got as a percentage and nothing else, so switching from the app to a browser drew the same
  // board with every arrow on it and every heart lit. This is the rest of it -- which arrows have gone, what is
  // left of the lifelines, and a move counter that only climbs, which is what lets the server tell a device
  // that is ahead from one that was left behind.
  function runSnapshot() {
    return {
      moves: state.moves | 0,
      gone: state.pieces.filter(p => p.gone).map(p => p.idx),
      lives: state.lives, wrong: state.wrong,
      hintsUsed: state.hintsUsed, hintsMax: state.hintsMax ?? HINTS_PER_LEVEL,
      checksUsed: state.checksUsed, checksMax: state.checksMax ?? CHECKS_PER_LEVEL,
      ...(state.daily?.race && state.daily.boards ? { bi: state.daily.bi | 0 } : {}),
    };
  }
  /**
   * Put a snapshot onto the board that is on screen. Arrows are removed without the flight, because they left
   * on another device some time ago; counters are taken as read. Never a step backwards: an arrow gone here
   * stays gone, and hearts are the fewer of the two -- so applying the server's copy over a board this device
   * has moved on can only ever add to it. It is called with the board freshly drawn, and again whenever a
   * poll brings back a run that is ahead of this one, which is how a tab left open on a desk catches up with
   * the phone rather than fighting it.
   */
  function applyRun(r) {
    if (!r || !state.pieces.length || state.finished) return false;
    if (state.daily?.boards && Number.isInteger(r.bi) && r.bi !== (state.daily.bi | 0)) return false;   // another board's run
    const gone = new Set(Array.isArray(r.gone) ? r.gone : []);
    let took = false;
    for (const p of state.pieces) {
      if (p.gone || !gone.has(p.idx)) continue;
      p.gone = true; state.left--; took = true;
      if (state.armed.has(p)) disarm(p);
      for (const [y, x] of p.cells) state.occ[y][x] = -1;
      p.el?.remove();
    }
    const n = (v, fb) => (Number.isInteger(v) && v >= 0 ? v : fb);
    state.lives = Math.min(state.lives, n(r.lives, state.lives));
    state.wrong = Math.max(state.wrong, n(r.wrong, state.wrong));
    state.hintsUsed = Math.max(state.hintsUsed, n(r.hintsUsed, state.hintsUsed));
    state.checksUsed = Math.max(state.checksUsed, n(r.checksUsed, state.checksUsed));
    state.hintsMax = Math.max(state.hintsMax ?? HINTS_PER_LEVEL, n(r.hintsMax, 0));
    state.checksMax = Math.max(state.checksMax ?? CHECKS_PER_LEVEL, n(r.checksMax, 0));
    state.moves = Math.max(state.moves | 0, n(r.moves, 0));
    updateReveal(); renderHud();
    if (state.left === 0) { winLevel(); return true; }
    if (state.lives <= 0) { failLevel('Out of hearts.'); return true; }
    return took;
  }
  /** A run that came back from the server is ahead of this board if it has seen more moves than this board. */
  const runAhead = r => !!r && Number.isInteger(r.moves) && (r.moves > (state.moves | 0) || (Number.isInteger(r.bi) && r.bi > (state.daily?.bi | 0)));

  function updateReveal() {
    const total = state.pieces.length;
    const done = total - state.left;
    const k = total ? done / total : 0;
    state.outlineEl?.style.setProperty('fill-opacity', String(0.035 + 0.8 * k * k));
  }

  // ── Game lifecycle ──
  async function startLevel(i, bumpSeed = false, daily = null, keepTier = -1) {
    try { await loadData(); el.error.hidden = true; } catch (err) { el.error.textContent = `Could not load the levels (${err.message}). Check your connection and tap Play again.`; el.error.hidden = false; return; }
    if (i < 0 || i >= DATA.levels.length) i = 0;
    if (!daily && !unlocked(i)) i = DATA.levels.findIndex((_, j) => !cleared(j) && unlocked(j));
    if (i < 0) i = 0;
    stopTimer(); stopProgressPoll(); heartbeatStop(); deckStop();
    if (el.ranks) el.ranks.hidden = true;
    if (daily?.race) state.seedBump = 0;   // a race is that exact board: a stray reshuffle must not change it
    else if (bumpSeed) state.seedBump++; else if (state.idx !== i || !!daily !== !!state.daily) { state.seedBump = 0; state.fails = 0; }
    state.daily = daily; state.level = DATA.levels[i]; state.disc = state.level.disc ? state.level : null;
    // A scene board is one tier harder than the player's own: it is the long game, and the tier is the pace.
    state.idx = i; state.tier = daily ? daily.tier : keepTier >= 0 ? keepTier : state.level.scene ? clampTier(TIER_OF() + 1) : TIER_OF();
    if (!daily) countBoard(state.level.id, { p: 1 });   // a tour board started; a race or a daily is not the tour's
    state.busy = true; el.select.hidden = true; el.game.hidden = false; el.overlay.hidden = true; el.board.innerHTML = '';
    el.hudLevel.textContent = hudLabel(); el.hudLeft.textContent = 'Drawing the board…';
    el.btnLevels.setAttribute('aria-label', daily?.race ? 'Leave the challenge' : 'Back to home');
    await new Promise(r => setTimeout(r, 20));   // let the game screen paint before the (up to ~1 s on phones) generation
    state.maskInfo = maskFor(state.level, state.tier);
    const seed = (daily ? daily.seed : (i + 1) * 1000) + state.seedBump;
    const gen = bestBoard(state.maskInfo, state.tier, seed);
    const livesMax = livesFor(state.tier);
    Object.assign(state, { W: gen.W, H: gen.H, pieces: gen.pieces, occ: gen.occ, land: gen.land, left: gen.pieces.length, hintsMax: hintsFor(state.tier), checksUsed: 0, checksMax: CHECKS_PER_LEVEL, lives: livesMax, livesMax, elapsed: 0, startedAt: 0, raceBase: 0, finished: false, hintsUsed: 0, wrong: 0, moves: 0, busy: false, potGone: false, combo: 0, bestCombo: 0, lastShot: 0, cheerHold: 0, shown: new Set(), armed: new Set(), raceReading: null });
    if (daily?.race) state.moves = daily.moves | 0;   // a later board of the same match carries the count on, so the server's monotonic guard still holds
    el.error.hidden = true; el.loading.hidden = true;
    if (daily) { if (history.replaceState) history.replaceState(null, '', location.pathname + location.search + (daily.hash ?? '#daily')); } else setHash(i);
    scrollToGame();
    const diff = DIFF_OF(state.tier);
    state.diff = diff;
    resetZoom(); renderBoard(); renderHud();
    // Back on a race board is back in the match, on the match's own clock -- and on the board as it was left,
    // wherever it was left: the run the server holds is put back before anybody is told the board is ready.
    if (daily?.race && daily.match) { applyRun(daily.run || daily.match.your_run); renderRanks(daily.match.players); syncRaceClock(daily.match); startProgressPoll(); }
    // A board that has just been drawn is announced by nothing. The level, the difficulty and the arrows left
    // are already on the HUD above it, and a country whose name is the answer has no business being written
    // across the board that asks the question. The one line still said here is the only one that is not a
    // reading of the screen: what to do, once, to somebody who has never played.
    if (!daily && coachStart()) { /* the tutorial says it all, one thing at a time */ }
    else if (i === 0 && !cleared(0) && !daily) teach('tap', 'Tap an arrow to shoot it off the board. If another arrow is in its way, you lose a heart.');
  }

  function renderHud() {
    el.hudLevel.textContent = hudLabel();
    const diffLabel = state.diff || DIFF_OF(state.tier);
    el.hudDiff.textContent = diffLabel;
    el.hudDiff.className = 'aa-hud-diff aa-hud-diff--' + diffLabel.toLowerCase().replace(' ', '-');
    // An empty counter is not the end of the sentence any more. Where an advertisement can still be offered for
    // one, the number becomes a plus and the button stays live: the plus IS the offer, which is why the lamp is
    // no longer switched off at zero -- a disabled button cannot be asked for anything, and that is exactly what
    // it was, so the offer behind it could never be reached.
    const hintsLeft = (state.hintsMax ?? HINTS_PER_LEVEL) - state.hintsUsed;
    const hintAd = hintsLeft <= 0 && !state.finished && adCanOffer('hint');
    // The value only. Writing the whole button would throw away the icon drawn inside it.
    if (el.hintVal) el.hintVal.textContent = hintAd ? '+' : String(Math.max(0, hintsLeft));
    el.btnHint.disabled = state.finished || (hintsLeft <= 0 && !hintAd);
    el.btnHint.classList.toggle('is-ad', !!hintAd);
    el.btnHint.setAttribute('aria-label', hintAd
      ? (ads.isAd() ? 'No hints left. Watch an advertisement for one more.' : 'No hints left. Tap for one more.')
      : `${Math.max(0, hintsLeft)} hint${hintsLeft === 1 ? '' : 's'} left`);
    if (el.btnCheck) {
      const left = checksLeftNow();
      const checkAd = left <= 0 && !state.finished && adCanOffer('check');
      if (el.checkVal) el.checkVal.textContent = checkAd ? '+' : String(Math.max(0, left));
      el.btnCheck.classList.toggle('is-spent', left <= 0 && !checkAd);
      el.btnCheck.classList.toggle('is-ad', !!checkAd);
      el.btnCheck.setAttribute('aria-label', checkAd
        ? (ads.isAd() ? `No ${CHECK_WORD}s left. Watch an advertisement for one more.` : `No ${CHECK_WORD}s left. Tap for one more.`)
        : `${Math.max(0, left)} ${left === 1 ? CHECK_WORD : CHECK_WORD + 's'} left. Press and hold an arrow to check whether its lane is clear.`);
    }
    const pct = state.pieces.length ? Math.round(((state.pieces.length - state.left) / state.pieces.length) * 100) : 0;
    el.hudPct.textContent = `${pct}%`;
    el.boardBar.style.width = `${pct}%`;
    el.hudLeft.textContent = String(state.left);
    const max = Number.isFinite(state.livesMax) ? state.livesMax : 0;
    el.hudLives.innerHTML = Array.from({ length: max }, (_, k) => `<span class="${k < state.lives ? 'is-on' : 'is-off'}">${HEART}</span>`).join('');
    el.hudLives.setAttribute('aria-label', `${state.lives} of ${max} hearts`);
    el.hudLives.classList.toggle('is-last', max > 1 && state.lives === 1 && !state.finished);
    // The clock is shown in a challenge and nowhere else. A race is decided by it, so a player is owed the
    // number they are being judged on; a tour level is not a race against anybody, and a clock ticking away
    // in the corner of one only makes a quiet puzzle feel like an exam.
    el.hudTime.hidden = !state.daily?.race;
    renderTime();
  }
  // A challenge is timed from the moment the match starts, not from the player's first tap: everyone in it is
  // racing the same clock, and the five seconds somebody spends looking at the board before touching it are
  // five seconds of the race. So a race keeps a base — a point on this device's own monotonic clock standing
  // for the instant the match began — and the time shown is simply now minus that. It is set from the age the
  // server reports rather than from a timestamp, so a device whose clock is wrong still shows the right race,
  // and it survives Try again, because restarting the board does not restart the match.
  //
  // Everything else (the tour, the daily board) is still timed from the first tap and still pauses when the
  // tab goes away: there is nobody else in those, and a clock running while the game is not on screen would
  // only punish being interrupted.
  const currentElapsed = () => state.raceBase
    ? performance.now() - state.raceBase
    : state.startedAt ? state.elapsed + (performance.now() - state.startedAt) : state.elapsed;
  function renderTime() {
    const e = currentElapsed();
    el.hudTime.textContent = fmtTime(e);
  }
  function startTimer() {
    // Play has begun. Dealing a board is not that -- a board can sit there untouched for as long as the player
    // likes -- and the race clock takes the early return below without ever reaching the music, so the call
    // goes above the guard.
    musicBegin();
    if (state.startedAt || state.raceBase || state.finished) return;
    state.startedAt = performance.now();
    state.timerId = setInterval(renderTime, 500);
  }
  // The race clock, started from the age the server reports for the match. It is kept beside the board rather
  // than in it, because the board is thrown away and redrawn by Try again while the match — and its clock —
  // carries on. The base only ever moves to make the race older, never younger: the match view held on this
  // device can be minutes out of date, and a stale age must not wind the clock back.
  let raceClock = { code: '', base: 0 };
  function syncRaceClock(m) {
    if (!state.daily?.race || state.finished) return;
    const code = m?.code || state.daily?.match?.code || '';
    if (code && raceClock.code !== code) raceClock = { code, base: 0 };
    const age = Number(m?.age_ms);
    const shown = raceClock.base ? performance.now() - raceClock.base : 0;
    if (Number.isFinite(age) && (!raceClock.base || age > shown + 1500)) raceClock.base = performance.now() - age;
    if (!raceClock.base) return;
    state.raceBase = raceClock.base;
    if (!state.timerId) state.timerId = setInterval(renderTime, 500);
    renderTime();
  }
  function stopTimer() {
    if (state.raceBase) { state.elapsed = performance.now() - state.raceBase; state.raceBase = 0; }
    else if (state.startedAt) { state.elapsed += performance.now() - state.startedAt; state.startedAt = 0; }
    clearInterval(state.timerId); state.timerId = 0;
  }

  // ── Moves ──
  function blockerOf(p) {
    const [dr, dc] = DIRS[p.dir];
    let [y, x] = p.cells[0]; y += dr; x += dc;
    while (y >= 0 && y < state.H && x >= 0 && x < state.W) { const o = state.occ[y][x]; if (o >= 0 && o !== p.idx) return state.pieces[o]; y += dr; x += dc; }
    return null;
  }
  const HOLD_MS = 260;
  const GRAD_PERIOD = 5;      // cells per colour cycle of the shot gradient
  // A blocked arrow lunges forward, hits, and comes back.
  function bounce(p) {
    const [dr, dc] = DIRS[p.dir]; const gap = Math.max(0.2, Math.min(0.55, (laneCells(p) + 0.35)));
    p.el.animate([{ transform: 'translate(0,0)' }, { transform: `translate(${dc * gap}px, ${dr * gap}px)`, offset: 0.4 }, { transform: `translate(${-dc * 0.08}px, ${-dr * 0.08}px)`, offset: 0.75 }, { transform: 'translate(0,0)' }], { duration: 320, easing: 'cubic-bezier(.3,.9,.4,1)' });
  }
  function laneCells(p) { const [dr, dc] = DIRS[p.dir]; let [y, x] = p.cells[0]; y += dr; x += dc; let n = 0; while (y >= 0 && y < state.H && x >= 0 && x < state.W && state.occ[y][x] < 0) { y += dr; x += dc; n++; } return n; }
  // The lane an arrow would travel: from its tip to the board edge, or to the arrow in its way.
  function laneLine(p, cls) {
    const [dr, dc] = DIRS[p.dir]; const [hy, hx] = p.cells[0];
    let y = hy + dr, x = hx + dc, n = 0;
    while (y >= 0 && y < state.H && x >= 0 && x < state.W && state.occ[y][x] < 0) { y += dr; x += dc; n++; }
    const hit = y >= 0 && y < state.H && x >= 0 && x < state.W;   // stopped on a piece rather than the edge
    const len = n + (hit ? 0.5 : 1) - 0.32;
    const x1 = hx + 0.5 + dc * 0.32, y1 = hy + 0.5 + dr * 0.32;
    return svgEl('line', { x1, y1, x2: x1 + dc * Math.max(0, len), y2: y1 + dr * Math.max(0, len), class: 'aa-lane ' + cls, 'data-i': p.idx });
  }
  // Press and hold: show whether this arrow can go. Any tap afterwards clears it.
  //
  // A check is spent only when one actually happens -- not on a hold over an arrow that has already gone, not
  // when the board is finished, and not on the hold that finds the counter empty. Checking the same arrow twice
  // costs twice, which is the point: it is an allowance, not a mode.
  const checksLeftNow = () => (state.checksMax ?? CHECKS_PER_LEVEL) - state.checksUsed;
  function peek(p) {
    if (state.finished || p.gone) return;
    musicBegin();   // a hold is a player playing, the same as a tap is
    if (checksLeftNow() <= 0) {
      clearPeek();
      if (adCanOffer('check')) { adOffer('check'); return; }
      toast(`No ${CHECK_WORD}s left on this level.`, 'bad'); vibe(20); return;
    }
    state.checksUsed++; state.moves++;
    renderHud(); musicMoved();
    clearPeek();
    const free = !blockerOf(p);
    p.el.classList.add(free ? 'is-peek-free' : 'is-peek-blocked');
    state.lanesEl.appendChild(laneLine(p, free ? 'aa-lane--free aa-lane--peek' : 'aa-lane--blocked aa-lane--peek'));
    vibe(8);
  }
  function clearPeek() {
    $$('.aa-piece.is-peek-free, .aa-piece.is-peek-blocked', el.board).forEach(g => g.classList.remove('is-peek-free', 'is-peek-blocked'));
    $$('.aa-lane--peek', el.board).forEach(l => l.remove());
  }
  // A blocked arrow stays armed (red) and goes by itself the moment its lane clears.
  function arm(p) { state.armed.add(p); p.el.classList.add('is-armed'); }
  function disarm(p) { state.armed.delete(p); p.el?.classList.remove('is-armed'); }
  function releaseArmed() {
    if (state.finished) return;
    for (const p of Array.from(state.armed)) if (!p.gone && !blockerOf(p)) { disarm(p); shoot(p, true); return; }   // one at a time, each shot re-checks
  }
  function tapPiece(p) {
    if (state.finished || p.gone || state.busy) return;
    clearPeek();
    startTimer();
    const blocker = blockerOf(p);
    if (blocker) { blocked(p, blocker); return; }
    shoot(p);
  }
  function shoot(p, auto = false) {
    p.gone = true; state.left--; state.moves++;
    if (!auto) coachShot();
    if (state.armed.has(p)) disarm(p);
    for (const [y, x] of p.cells) state.occ[y][x] = -1;
    if (state.armed.size) setTimeout(releaseArmed, auto ? 90 : 160);   // armed arrows whose lane just opened go by themselves
    const travel = p.bodyLen + p.exitLen;
    const dur = Math.min(0.7, 0.15 + travel * 0.03);
    const track = p.el.querySelector('.aa-track'), head = p.el.querySelector('.aa-head');
    p.el.classList.add('is-going');
    track.style.transition = `stroke-dashoffset ${dur}s cubic-bezier(.45,0,1,1)`;
    track.style.strokeDashoffset = String(-travel);
    // the head rides the same curve as the body (same distance, duration and easing) so they never part;
    // it fades once it crosses the board edge and the viewBox clips whatever is left
    head.style.transition = `transform ${dur}s cubic-bezier(.45,0,1,1), opacity .12s ${dur * (p.exitLen / travel)}s`;
    head.style.transform = `translate(${travel}px, 0)`; // local frame: the head group is already rotated to point forward
    head.style.opacity = '0';
    setTimeout(() => p.el.remove(), dur * 1000 + 80);
    SFX.shoot(); vibe(12); musicRight();
    const now = performance.now();
    state.combo = now - state.lastShot < COMBO_WINDOW_MS ? state.combo + 1 : 1; state.lastShot = now; state.bestCombo = Math.max(state.bestCombo, state.combo);
    updateReveal(); renderHud();
    if (auto) { if (state.left === 0) winLevel(); return; }   // no combo or milestone chatter for arrows that went on their own
    const pct = Math.round(((state.pieces.length - state.left) / state.pieces.length) * 100);
    const m = MILESTONES.find(x => pct >= x && !state.shown.has(x));
    // a cheer (confetti from both sides, rising jingle) for a combo of three or more, or for one long shot
    // a cheer only when the combo reaches a step, and never within three shots of the last cheer
    if (state.cheerHold > 0) state.cheerHold--;
    const cheer = state.cheerHold === 0 && comboStep(state.combo) ? comboLevel(state.combo) : -1;
    if (cheer >= 0 && state.left > 0) { state.cheerHold = CHEER_HOLD; sideBurst(cheer); SFX.cheer(cheer); }
    if (state.left === 0) winLevel();
    else if (m) { state.shown.add(m); toast(({ 25: 'Nice start. 25% cleared.', 50: 'Halfway. The shape is showing.', 75: '75% cleared. Keep the rhythm.', 90: 'Almost there!' })[m]); }
    else if (cheer >= 0) toast(`${COMBO_WORDS[cheer]} Combo x${state.combo}`, 'combo', 1400);
  }
  function blocked(p, blocker) {
    if (state.armed.has(p)) { bounce(p); SFX.block(); musicMoved(); teach('armed', 'Still blocked. It will go by itself once its lane clears.'); return; }
    state.lives--; state.wrong++; state.moves++; state.combo = 0;
    arm(p); musicWrong();
    SFX.block(); vibe(60);
    bounce(p);
    blocker.el.classList.add('is-blocker');
    setTimeout(() => blocker.el.classList.remove('is-blocker'), 600);
    renderHud(); heartLost();
    if (state.lives <= 0) failLevel('Out of hearts.');
    else {
      // The explanation is taught. The warning is not: being down to one heart is news every single time.
      const said = teach('blocked', state.lives === 1
        ? 'Blocked! Last heart. It stays red and goes by itself once its lane clears.'
        : 'Blocked! It stays red and goes by itself once its lane clears.', 'bad');
      if (!said && state.lives === 1) toast('Last heart.', 'bad', 2000);
    }
  }
  function hint() {
    if (state.finished) return;
    if (state.hintsUsed >= (state.hintsMax ?? HINTS_PER_LEVEL)) {
      if (adCanOffer('hint')) { adOffer('hint', null, true).then(got => { if (got) hint(); }); return; }
      toast('No hints left on this level.', 'bad'); return;
    }
    const p = state.pieces.find(q => !q.gone && !blockerOf(q));
    if (!p) return;
    startTimer();
    state.hintsUsed++; state.moves++;
    if (!state.daily?.race) state.elapsed += HINT_PENALTY_MS;   // a race is timed by the match, not by this board
    $$('.aa-piece.is-hint', el.board).forEach(g => g.classList.remove('is-hint'));
    p.el.classList.add('is-hint');
    setTimeout(() => p.el.classList.remove('is-hint'), 2500);
    // The same split as everywhere else: what a hint IS gets said while the player is learning, and how many
    // are left gets said every time, because that is the part that changes.
    const hintsLeft = (state.hintsMax ?? HINTS_PER_LEVEL) - state.hintsUsed;
    if (!teach('hint', `Hint: the glowing arrow is free. ${hintsLeft} left.`, 'hint')) toast(`${hintsLeft} hint${hintsLeft === 1 ? '' : 's'} left.`, 'hint', 1600);
    renderHud();
  }

  // ── End of level ──
  // Move the player's form on the finished board (tour levels only; the daily board has a fixed tier).
  function learnFrom(won) {
    if (state.daily) return null;
    const run = { firstTry: won && state.fails === 0, heartsLost: state.livesMax - state.lives, hints: state.hintsUsed, secPerArrow: state.elapsed / 1000 / Math.max(1, state.pieces.length) };
    const before = formNow(), after = nextForm(before, won, run), points = won ? clearPoints(run) : 0;
    store.set('form', after);
    return { before, after, points };
  }
  // ── Focus ──
  //
  // A time on its own says nothing: is a minute and a half good on a board of ninety arrows? So the card reads
  // the run the way a player would judge their own attention — how long each arrow took against the board's
  // par, what it cost in hearts, and whether the board had to be pointed at. The three are weighted the way
  // they matter: pace most, then a clean run, then doing it unaided.
  //
  // Nothing here is a diagnosis. The game cannot see the phone call, the bus, or the first ever Master board,
  // so it says what it measured and leaves the reasons to the person who has them.
  const PAR_SEC_PER_ARROW = FAST_SEC_PER_ARROW;      // the same par the difficulty ladder already judges by
  const FOCUS_FLOOR = PAR_SEC_PER_ARROW * 2.2, FOCUS_CEIL = PAR_SEC_PER_ARROW * 0.8;
  function focusOf(ms, arrows, heartsLost, hints) {
    const per = arrows > 0 ? (ms / 1000) / arrows : FOCUS_FLOOR;
    const pace = Math.max(0, Math.min(1, (FOCUS_FLOOR - per) / (FOCUS_FLOOR - FOCUS_CEIL)));
    const clean = heartsLost <= 0 ? 1 : heartsLost === 1 ? 0.6 : heartsLost === 2 ? 0.3 : 0;
    const unaided = Math.max(0, 1 - hints * 0.25);
    return Math.round(100 * (0.5 * pace + 0.3 * clean + 0.2 * unaided));
  }
  // Four readings. They are not printed any more — a bar that fills in front of you says the same thing to a
  // player who reads English and to one who does not — but the sound is pitched by them and a screen reader
  // is told which one it was.
  const FOCUS_BANDS = [
    { at: 85, name: 'Locked in' },
    { at: 70, name: 'Steady' },
    { at: 50, name: 'Warming up' },
    { at: 0,  name: 'Took a while' },
  ];
  const focusBand = v => FOCUS_BANDS.find(b => v >= b.at) ?? FOCUS_BANDS[FOCUS_BANDS.length - 1];
  // Two lobes and the line between them: a picture of the thing being measured, for the player who cannot
  // read the words beside it. It rides the bar, so how far along it sits is the whole reading.
  const BRAIN = `<svg class="aa-brain" viewBox="0 0 32 32" aria-hidden="true">
      <g fill="none" stroke="currentColor" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M15 7.5c-2.2-2-5.6-1.6-6.8.7-2.4.3-3.7 2.4-3 4.4-1.8 1.5-1.5 4.2.5 5.2-.4 2.3 1.5 4.2 3.8 4 .8 2 3.5 2.6 5.3 1.1"/>
        <path d="M17 7.5c2.2-2 5.6-1.6 6.8.7 2.4.3 3.7 2.4 3 4.4 1.8 1.5 1.5 4.2-.5 5.2.4 2.3-1.5 4.2-3.8 4-.8 2-3.5 2.6-5.3 1.1"/>
        <path d="M16 7.4v15.6"/>
      </g>
    </svg>`;
  // A mark on each button: the card is read at a glance, and an arrow, a loop and a share glyph are read
  // faster than their labels — and by people who cannot read the labels at all.
  const ICO = (d, extra = '') => `<svg class="aa-bi" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">${d}</g>${extra}</svg>`;
  const ICON_NEXT  = ICO('<path d="M4.5 12h14"/><path d="M12.5 6l6 6-6 6"/>');
  const ICON_BACK  = ICO('<path d="M19.5 12h-14"/><path d="M11.5 6l-6 6 6 6"/>');
  const ICON_AGAIN = ICO('<path d="M20 12a8 8 0 1 1-2.5-5.8"/><path d="M20 3.6V9h-5.4"/>');
  const ICON_SHARE = ICO('<circle cx="17.5" cy="5.5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="17.5" cy="18.5" r="2.6"/><path d="M8.4 10.7l6.8-3.9"/><path d="M8.4 13.3l6.8 3.9"/>');
  const ICON_AD    = ICO('<rect x="2.8" y="4.8" width="18.4" height="14.4" rx="2.4"/><path d="M10.2 9.4l4.6 2.6-4.6 2.6z"/>');
  const ICON_FLAG  = ICO('<path d="M6 21V4"/><path d="M6 5h11l-2.2 3.4L17 12H6z"/>');
  // The bar is filled in front of the player rather than handed to them finished: the brain travels, the
  // number counts up with it, and the sound climbs alongside. That second is the whole point of the reading —
  // it is the only part of the card that is worth watching happen.
  function runFocusBar(value, root = el.card, animate = true) {
    const box = $('#aaFocus', root);
    if (!box) return;
    // A sheet that re-renders while it waits for the others to finish must not replay the animation every four
    // seconds: the second time round the bar is simply put where it ended.
    if (!animate) { box.style.setProperty('--at', `${value}%`); const n = $('.aa-focus-num', box); if (n) n.textContent = String(value); box.classList.add('is-done'); return; }
    const mark = $('.aa-focus-mark', box), num = $('.aa-focus-num', box), dim = $('.aa-focus-dim', box);
    const at = pct => { box.style.setProperty('--at', `${pct}%`); };
    at(0);
    if (!state.muted) SFX.focus(value);
    const t0 = performance.now(), ms = 1100;
    const step = now => {
      const k = Math.min(1, (now - t0) / ms), eased = 1 - Math.pow(1 - k, 3);
      const v = Math.round(value * eased);
      at(value * eased);
      if (num) num.textContent = String(v);
      if (k < 1) requestAnimationFrame(step);
      else { box.classList.add('is-done'); vibe(15); }
    };
    void mark; void dim;
    requestAnimationFrame(() => requestAnimationFrame(step));
  }

  function stars() { const lost = state.livesMax - state.lives; return lost === 0 ? 3 : lost === 1 ? 2 : 1; }
  // Every card in the game opens through here, and a card that has just opened cannot be pressed yet.
  //
  // The board is played with pointer events, and the browser still sends a click after them. Losing the last
  // heart on a tap means the fail card appears under the finger that is mid-tap: the click that follows lands on
  // whatever is at those coordinates now, and what is there now is the card's first button. Try again fires, the
  // board comes back with its hearts, and the player never sees the card at all -- from the outside the board
  // simply resets itself. A mouse does exactly the same thing. So a card is deaf for a moment after it appears:
  // nobody presses a button they have not had time to see, and nothing else in the game is slowed by it.
  const CARD_DEAF_MS = 450;
  let cardShownAt = 0;
  function showCard() { cardShownAt = performance.now(); el.overlay.hidden = false; }

  function winLevel() {
    coachEnd();
    stopTimer(); state.finished = true; state.busy = true;
    music.spike = 0; musicRace(0); heartbeatStop();   // it is done: whatever was leaning on the player stops leaning
    state.outlineEl?.style.setProperty('fill-opacity', '0.9');
    SFX.win(); confetti();
    // Every board ends the same way: it tells you what you cleared. It used to stop a country board to ask
    // which country it was, three names to choose from — a test at the end of a puzzle, which is a thing to
    // get wrong in a game nobody is being marked in. The discovery boards never asked, and they read better
    // for it.
    setTimeout(() => showResult(), 700);
  }
  function showResult() {
    const L = state.level, i = state.idx, D = state.disc, C = D ? D.country : L;
    const t = Math.round(state.elapsed), s = stars();
    const learn = learnFrom(true);
    const R = state.daily?.race ? state.daily : null;
    const prev = R ? null : state.daily ? store.get(`daily:${state.daily.key}`) : store.get('lv:' + state.level.id);   // by id: the tour may have been reordered under this board
    const isBest = !prev || t < prev.t;
    // `quiz` is what a board's record used to say about the question at the end. There is no question now, so
    // every cleared board carries it: the name is on the card either way, and a row saved today should not
    // read as poorer than one saved last week.
    const rec = { t: isBest ? t : prev.t, stars: Math.max(s, prev?.stars || 0), quiz: true, tier: state.tier, arrows: state.pieces.length, at: Date.now() };
    const arrowsWas = R ? 0 : arrowsShot();   // the rank before this board is saved, so the card can say if it moved
    // The streak on the home screen is a streak of days this player played. It used to be the daily board's own
    // streak, which is a board most people never open, so somebody who had cleared a hundred boards — several of
    // them that morning — was told their streak was zero. Any cleared board keeps it alive; a day missed ends it.
    if (!R) {
      const ps = store.get('playStreak', { count: 0, last: '' }), today = dayKey();
      if (ps.last !== today) store.set('playStreak', { count: ps.last === dayKeyBack(1) ? (ps.count || 0) + 1 : 1, last: today });
    }
    if (R) { /* a race is not part of the tour: nothing is saved and the difficulty ladder does not move */ }
    else if (state.daily) {
      store.set(`daily:${state.daily.key}`, rec);
      const ds = store.get('dailyStreak', { count: 0, last: '' });
      if (ds.last !== state.daily.key) store.set('dailyStreak', { count: ds.last === dayKeyBack(1) ? ds.count + 1 : 1, last: state.daily.key });
      syncTour({});   // the daily board lives in the state blob, which every push carries
    } else {
      const lid = state.level.id;
      countBoard(lid, { c: 1, h: state.hintsUsed, l: state.livesMax - state.lives, ms: t });
      store.set('lv:' + lid, rec); forgetNums(); pushOne(lid, rec); showBrainNext = true;
    }
    if (R) {
      // How the run went is the player's either way, so the reading goes with them onto the result sheet: the
      // stars, what the board cost, and the focus bar, exactly as a tour board draws them. It is kept here
      // rather than drawn here because the sheet is a second away and two cards in a row is one too many.
      //
      // No number here on purpose: the one that counts is the race time the server works out, and it is on the
      // sheet a second later. Two different times on two screens in a row is how a race stops making sense.
      state.raceReading = { code: R.match?.code, stars: s, lost: state.livesMax - state.lives, hints: state.hintsUsed,
        combo: state.bestCombo, focus: focusOf(t, state.pieces.length, state.livesMax - state.lives, state.hintsUsed) };
      // A match is a run of boards: this one cleared, the next comes up on its own, hearts and hints back,
      // the clock still running. Only the last board ends the race.
      const nb = (R.bi | 0) + 1;
      if (R.boards && nb < R.boards.length) {
        el.card.innerHTML = `<h3>Board ${nb} of ${R.boards.length} cleared!</h3><p class="aa-card-lead">The next one is coming up…</p>`;
        showCard();
        const next = raceFor(R.match, R.boards, nb, (state.moves | 0) + 1, null, (R.elapsedBase || 0) + t);
        const j = matchBoardIndex(next.board);
        if (j >= 0) { setTimeout(() => startLevel(j, false, next, R.tier), 1100); return; }
      }
      el.card.innerHTML = '<h3>Board cleared!</h3><p class="aa-card-lead">Sending your time…</p>';
      showCard();
      finishMatch(true, (R.elapsedBase || 0) + t);
      return;
    }
    // The streak is still counted and still reset by a loss — it is a record of this device's play and throwing
    // it away would throw away every player's, permanently. It is simply not announced on the card any more.
    store.set('streak', store.get('streak', 0) + 1);
    const n = levelNo(i), milestone = !state.daily && n % 10 === 0;
    // What the card has to say about the board, where there is anything to say. A country has its capital,
    // its size and its region; a discovery board has what the find is to that country; a focus board is a brain
    // or a lightbulb and has nothing of the kind, so it is given nothing and the line is left out altogether.
    const facts = D ? escapeHtml(D.rel.charAt(0).toUpperCase() + D.rel.slice(1)) : (L.focus || L.scene) ? '' : [L.cap ? `Capital: <b>${L.cap}</b>` : '', L.pop ? `Population: <b>${fmtPop(L.pop)}</b>` : '', L.sub ? `Region: <b>${L.sub}</b>` : ''].filter(Boolean).join(' · ');
    const nj = nextOpen(i), last = nj < 0;
    // The reading. It is shown, not described: a bar under a caption, with the comparison against everybody
    // else added underneath only when the server has enough players to make it true.
    const focus = focusOf(t, state.pieces.length, state.livesMax - state.lives, state.hintsUsed);
    const band = focusBand(focus);
    // The rank line: what this board added and where that leaves the player. A new rank is the card's news; a
    // board cleared again adds nothing and says so by saying only the rank. A race is not the tour and has none.
    let rankLine = '';
    if (!R) {
      const now = arrowsShot(), rk = rankOf(now), gain = now - arrowsWas;
      const toNext = rk.top ? '' : ` · ${fmtN(rk.hi - now)} to ${rk.next}`;
      rankLine = rk.i > rankOf(arrowsWas).i ? `<p class="aa-card-rank is-up">New rank: <b>${rk.name}</b> · ${fmtN(now)} arrows</p>`
        : gain > 0 ? `<p class="aa-card-rank">+${fmtN(gain)} arrows · <b>${rk.name}</b>${toNext}</p>`
        : `<p class="aa-card-rank"><b>${rk.name}</b> · ${fmtN(now)} arrows${toNext}</p>`;
    }
    el.card.innerHTML = `
      <p class="aa-card-kicker">${milestone ? `Milestone · level ${n} · ` : ''}You cleared</p>
      <h3>${escapeHtml(L.name)}</h3>
      ${facts ? `<p class="aa-facts">${facts}</p>` : ''}
      <p class="aa-stars" aria-label="${s} of 3 stars">${'★'.repeat(s)}${'☆'.repeat(3 - s)}</p>
      <div class="aa-stats"><span><b>${fmtTime(t, true)}</b>time</span><span><b>${state.livesMax - state.lives}</b>hearts lost</span><span><b>${state.hintsUsed}</b>hints</span><span><b>x${state.bestCombo}</b>best combo</span></div>
      ${rankLine}
      <div class="aa-focus" id="aaFocus" role="img" aria-label="Focus ${focus} out of 100 — ${band.name}">
        <p class="aa-focus-cap">Your focus level<b class="aa-focus-num">0</b></p>
        <div class="aa-focus-bar">
          <span class="aa-focus-dim"></span>
          <span class="aa-focus-mark">${BRAIN}</span>
        </div>
        <p class="aa-focus-vs" id="aaFocusVs"></p>
      </div>
      <div class="aa-actions aa-actions--stack">
        ${last || state.daily ? '' : `<button type="button" class="aa-btn aa-btn--primary" data-act="next">Next: Level ${levelNo(nj)} · ${DIFF_OF(TIER_OF())}${ICON_NEXT}</button>`}
        <button type="button" class="aa-btn" data-act="again">${ICON_AGAIN}Play again</button>
        <button type="button" class="aa-btn" data-act="share">${ICON_SHARE}Share</button>
      </div>
      <p class="aa-flash" hidden></p>
      ${(L.focus || L.scene) ? '' : `<p class="aa-yt">Curious about ${escapeHtml(C.name)}? I make geography, history and economy videos: <a href="https://www.youtube.com/@ariyankhan" target="_blank" rel="noopener">youtube.com/@ariyankhan</a></p>`}`;
    showCard();
    $('[data-act]', el.card)?.focus({ preventScroll: true });
    runFocusBar(focus);
    showPace(DATA.levels[i].id, state.tier, t);
    if (typeof gtag === 'function') gtag('event', 'level_complete', { game: 'puzzle', level: n, disc: D ? 1 : 0, mode: state.mode, tier: state.tier, arrows: state.pieces.length, time_ms: t, stars: s, tier_next: learn?.after.tier ?? state.tier });
  }
  // Everybody else who has cleared this board at this difficulty. The server answers with a percentage only
  // once there are enough of them to mean something; until then the line stays empty and the bar speaks for
  // itself.
  async function showPace(levelId, tier, ms) {
    const node = $('#aaFocusVs', el.card);
    if (!node) return;
    try {
      const d = await fetch(`${API_V1}/boards/pace?level_id=${encodeURIComponent(levelId)}&tier=${tier}&ms=${Math.round(ms)}`,
        { credentials: 'include', cache: 'no-store' }).then(r => r.json());
      if (typeof d.beats_pct !== 'number' || !node.isConnected) return;
      node.textContent = d.beats_pct >= 50
        ? `Faster than ${d.beats_pct}% of players`
        : `${100 - d.beats_pct}% of players were quicker`;
    } catch { /* offline, or the server has nothing to say: the line stays empty */ }
  }

  function failLevel(reason) {
    coachEnd();
    if (state.finished) return;
    stopTimer(); state.finished = true; state.busy = true; state.fails++;
    music.spike = 0; musicRace(0); heartbeatStop();
    store.set('streak', 0);
    if (!state.daily) countBoard(state.level.id, { f: 1 });
    SFX.lose(); renderHud();
    learnFrom(false);   // the form moves on a loss, whether or not the card says so
    // The rank: the arrows still on the board come off it. A race is not the tour and costs none.
    let rankLine = '';
    if (!state.daily?.race && state.left > 0) {
      const was = rankOf(arrowsShot());
      loseArrows(state.left);
      const now = arrowsShot(), rk = rankOf(now);
      rankLine = rk.i < was.i ? `<p class="aa-card-rank is-down">Rank down: <b>${rk.name}</b> · ${fmtN(now)} arrows</p>`
        : `<p class="aa-card-rank">−${fmtN(state.left)} arrows · <b>${rk.name}</b></p>`;
      showBrainNext = true;
      syncOwed = true; syncTour({}).catch(() => {});
    }
    el.card.innerHTML = `
      <p class="aa-card-kicker">${state.daily ? (state.daily.race ? `Gold match · ${gpurse(state.daily.match?.stake || 0)}` : 'Daily board') : hudLabel()} · ${DIFF_OF(state.tier)}</p>
      <h3>${reason}</h3>
      <p class="aa-card-lead">${state.left} of ${state.pieces.length} arrows were still on the board.</p>
      ${rankLine}
      ${state.daily?.race && sayOnce('race-retry') ? '<p class="aa-adapt">Try again puts you back on the same board with your hearts back. Nothing is lost until somebody else clears it.</p>' : ''}
      <div class="aa-actions aa-actions--stack aa-actions--out">
        ${adCanOffer('heart') ? `<button type="button" class="aa-btn aa-btn--ad aa-btn--big" data-act="adheart">Get a free life${ads.isAd() ? ICON_AD : ''}</button>` : ''}
        <button type="button" class="aa-btn aa-btn--soft aa-btn--big" data-act="retry">${ICON_AGAIN}Try again</button>
        ${state.daily?.race ? `<button type="button" class="aa-btn aa-btn--big" data-act="giveup">${ICON_FLAG}Give the board up</button>` : ''}
      </div>
      `;   // nothing under the two buttons: the corner arrow is the way back to the tour
    showCard();
    $('[data-act]', el.card)?.focus({ preventScroll: true, focusVisible: false });   // for the keyboard's sake, without a ring drawn on a tap
  }
  // ── Daily Brain Training ──
  // Four short rounds a day, one score, all played on real paintings from the gallery (see below). Each round
  // is scored 0-100 and the day's Brain Score is their mean, kept per day (`train:<day>`, best of the day per
  // round, with `h` hints used and `p` rounds played) and synced with the account like the daily board's
  // record. A day is done when all four are; the streak counts days done. The first round of a day is free;
  // every round after it, and every replay, is an advertisement the player chooses (free where advertising is
  // off), the same as hints after the first. Each round also carries a long game: a 30-day and then a 90-day
  // challenge, counted in consecutive days that round was played (trainRun).
  // Each round's icon is drawn, not an emoji: a line mark in the brain's colour, the same weight as the rest of
  // the interface. `how` is the instruction card shown before the first go at a round, and behind the ? after.
  const TRAIN_ICON = {
    r: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>',
    f: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6.5"/><path d="M15 15l6 6M7.5 10h5M10 7.5v5"/></svg>',
    g: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="5" width="5.5" height="8" rx="1"/><rect x="9.25" y="3" width="5.5" height="10" rx="1"/><rect x="16" y="5" width="5.5" height="8" rx="1"/><path d="M4 20.5h16M12 13v7.5"/></svg>',
    e: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  };
  const TRAIN_ROUNDS = [
    { id: 'r', name: 'Restore the Canvas', blurb: 'A painting in pieces. Put it back together.', how: ['The painting hangs whole for four seconds, then falls into pieces.', 'Drag a piece from the tray into the frame, to the place it belongs. Drop it on another piece and they swap; drag a piece out of the frame to take it back.', 'Every piece home wins the round. Wrong tries and slow time cost points. Higher levels cut the painting into more pieces.'] },
    { id: 'f', name: 'The Forgery', blurb: 'Things are wrong in the copy. Find them.', how: ['The original and a forged copy, side by side or one above the other.', 'Patches of the copy are wrong: mirrored, recoloured, or from elsewhere in the painting.', 'Tap them in the copy. A tap on nothing costs points; slow time does too. Higher levels hide more, smaller, subtler patches.'] },
    { id: 'g', name: 'Gallery Memory', blurb: 'Paintings on a wall for a moment. Hang them back in order.', how: ['The paintings hang in a row, numbered, for a few seconds.', 'Then they come down, shuffled, with the numbered places empty.', 'Drag each painting back to the number it hung at. Once every place is filled, the wrong ones are marked: move them. Every wrong placing costs points. Higher levels hang more paintings for less time.'] },
    { id: 'e', name: 'The Curator\u2019s Eye', blurb: 'One painting, then: which detail was in it?', how: ['One painting, for a few seconds. Look at the corners as well as the middle.', 'Then, several times, four close-ups: one is from that painting, three are from others.', 'Tap the one that is from it. Every right answer is an equal share of the score. Higher levels show the painting for less time and ask more, with smaller close-ups.'] },
  ];
  // Hints: one a day for nothing, the rest for an advertisement the player chooses (adOffer('trainhint');
  // free where advertising is off). A hint costs ten points of the round it is used in.
  const TRAIN_FREE_HINTS = 1;
  const trainHintsLeft = () => Math.max(0, TRAIN_FREE_HINTS - (trainDay().h | 0));
  // Rounds: every round is free once a day. After it, the round's own two choices: play AGAIN, the same
  // puzzle, for nothing, as often as you like; or play NEXT, a new puzzle of the same round (a new painting,
  // a new deal), for an advertisement the player chooses, each time. `pp` counts the day's starts per round,
  // `nx` the day's new puzzles per round (the serial that seeds them). Where advertising is off (the site)
  // Play next is simply free, and nothing is called an advertisement.
  const trainPlayed = (t, id) => ((t.pp && t.pp[id]) | 0) > 0;
  const trainSerial = (t, id) => (t.nx && t.nx[id]) | 0;
  // ── Difficulty ──
  // Each round climbs the way the board does: a good day (85 or more) takes the round up a level, a poor one
  // (under 50) takes it down, five levels in all. The level is read off the days before today, so it holds
  // still within a day and every device that has the same history agrees on it.
  const TRAIN_TIERS = 5;
  function trainTier(id) {
    const today = trainKey();
    let keys = [];
    try { keys = Object.keys(localStorage).filter(k => k.startsWith(STORE + 'train:') && k !== STORE + today).map(k => k.slice(STORE.length + 6)).sort(); } catch { /* none */ }
    let t = 0;
    for (const d of keys) { const v = trainDay(d)[id]; if (typeof v !== 'number') continue; if (v >= 85) t = Math.min(TRAIN_TIERS - 1, t + 1); else if (v < 50) t = Math.max(0, t - 1); }
    return t;
  }
  // what each level asks of each round
  const TIER_OF_ROUND = {
    r: t => ({ n: [3, 3, 4, 4, 5][t], allow: [90, 75, 140, 120, 200][t] }),
    f: t => ({ lies: [3, 3, 4, 4, 5][t], s: [0.2, 0.17, 0.16, 0.14, 0.13][t], hue: [45, 40, 35, 30, 25][t], allow: [60, 60, 75, 75, 90][t] }),
    g: t => ({ n: [5, 6, 6, 7, 8][t], secs: [5, 5, 4, 4, 4][t] }),
    e: t => ({ secs: [6, 5, 5, 4, 4][t], q: [3, 3, 4, 4, 5][t], s: [0.34, 0.3, 0.26, 0.22, 0.2][t] }),
  };
  const tierParams = id => TIER_OF_ROUND[id](trainTier(id));
  // the level, in the round's bar once there is one to speak of: level 1 says nothing
  // The round's bar carries the level on the main count that finishing it will be -- the same number the home
  // screen and the boards show, one more than is cleared -- unless this puzzle was finished already today (Play
  // again), which is no new level. The round's own difficulty step (trainTier) is not shown: it is how hard the
  // round is dealt, not a level anybody plays for.
  const levelChip = id => trainCleared(trainDay(), id, train.serial | 0) ? '' : `<b class="aa-train-lv">Level ${levelNo(-1)}</b>`;
  // free: everywhere advertising is off; the day's round; a round unlocked today; and a round scored today,
  // so "Play again" is never an advertisement, not even for a round started before midnight and finished after
  // a start costs nothing unless it asks for a NEW puzzle where advertising is on
  const trainFree = (id, next) => !ads.isAd() || !next;
  // The long game of a round: consecutive days it was played, ending today or, if today is not played yet,
  // yesterday. 30 days is the first challenge, 90 the second.
  const TRAIN_GOALS = [30, 90];
  // The long game of a round: days it was played, in all. Not in a row: a round is free one day in four, so a
  // run that had to be unbroken would be a bar nobody could fill without paying, and a bar that only ever
  // grows is honest -- the advertisement fills it faster, it never empties it.
  function trainRun(id) {
    let n = 0;
    try { for (const k of Object.keys(localStorage)) if (k.startsWith(STORE + 'train:') && typeof trainDay(k.slice(STORE.length + 6))[id] === 'number') n++; } catch { /* none */ }
    return n;
  }
  const train = { game: null, timer: 0, busy: false, serial: 0 };
  const trainKey = d => 'train:' + (d || dayKey());
  const trainDay = d => { const t = store.get(trainKey(d), null); return t && typeof t === 'object' ? t : {}; };
  // a day is done with one round scored -- the free one, or one the player chose to unlock; all four is a bonus
  const trainDone = t => TRAIN_ROUNDS.some(r => typeof t[r.id] === 'number');
  const trainAll = t => TRAIN_ROUNDS.every(r => typeof t[r.id] === 'number');
  const trainScore = t => { const v = TRAIN_ROUNDS.map(r => t[r.id]).filter(x => typeof x === 'number'); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; };
  const clamp100 = v => Math.max(0, Math.min(100, Math.round(v)));
  // A round finished: its score (the day's best stands), and -- the first time this puzzle is finished -- a
  // clear, which is a level on the main count (trainClearTimes, levelNo). A puzzle is the round's serial of the
  // day: 0 the free one, 1, 2... each "Play next". Play again replays the same serial, so it is never a second
  // level. Returns whether this finish was a new clear.
  function trainSave(k, score) {
    const t = trainDay(); score = clamp100(score);
    const fresh = !trainCleared(t, k, train.serial | 0);
    if (fresh) {
      t.cl = t.cl && typeof t.cl === 'object' ? t.cl : {};
      const m = t.cl[k] && typeof t.cl[k] === 'object' ? t.cl[k] : (t.cl[k] = {});
      m[String(train.serial | 0)] = Date.now();
      forgetNums();
    }
    if (!fresh && typeof t[k] === 'number' && t[k] >= score) return false;
    if (typeof t[k] !== 'number' || t[k] < score) { t[k] = score; t.at = Date.now(); }
    store.set(trainKey(), t);
    renderTrainPill(); if (fresh) renderBrain();   // the home card's level moved
    syncOwed = true; syncTour({}).catch(() => {});
    return fresh;
  }
  // Whether a puzzle of a round was finished that day. A round scored before clears were kept has its free
  // puzzle (serial 0) finished: nothing else could have been played before it.
  const trainCleared = (t, id, serial) => !!(t.cl && t.cl[id] && typeof t.cl[id] === 'object' && String(serial) in t.cl[id]) || (serial === 0 && typeof t[id] === 'number');
  // Every training puzzle ever finished, as the time it was finished: each is a level on the main count, in
  // its place among the boards by time. A clear kept without its time (a round scored before clears were
  // kept) takes the day's last save, or noon of that day.
  function trainClearTimes() {
    const out = [];
    try {
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith(STORE + 'train:')) continue;
        const day = key.slice(STORE.length + 6), t = trainDay(day);
        const noon = Date.parse(day + 'T12:00:00') || 0, dayAt = Number(t.at) > 0 ? Number(t.at) : noon;
        for (const r of TRAIN_ROUNDS) {
          const m = t.cl && t.cl[r.id] && typeof t.cl[r.id] === 'object' ? t.cl[r.id] : {};
          const serials = new Set(Object.keys(m).filter(x => /^\d{1,4}$/.test(x)));
          if (typeof t[r.id] === 'number') serials.add('0');
          for (const x of serials) { const v = Number(m[x]); out.push(Number.isFinite(v) && v > 0 ? v : dayAt); }
        }
      }
    } catch { /* storage can be unreadable in a private window */ }
    return out;
  }
  // Where today stands, in words: how many of the four are done until all of them are -- "done for today"
  // with a round still to play read as if the day were finished -- and the run of days after it. With all
  // four done, the day is congratulated, and the list says how to go on: a new puzzle with an advertisement
  // where they are on, Play next where they are not. Empty when nothing has been played today.
  function trainTally(t, streak, onResult = false) {
    const n = TRAIN_ROUNDS.filter(r => typeof t[r.id] === 'number').length; if (!n) return '';
    if (n === TRAIN_ROUNDS.length) return 'Congratulations! Today\u2019s brain training is done.' + (onResult ? '' : ads.isAd() ? ' You can keep training by watching an ad.' : ' You can keep training with Play next.');
    return `${n} of ${TRAIN_ROUNDS.length} done today${streak > 1 ? ` \u00b7 ${streak} days in a row` : ''}`;
  }
  function trainStreak() { let n = 0; while (trainDone(trainDay(dayKeyBack(n + 1)))) n++; if (trainDone(trainDay())) n++; return n; }
  // What a round's card says, read off its state: a small line above the name (the tag) and the chip at the
  // end (the call to action). Filled rose = do this one; soft rose with the video mark = costs a short
  // advertisement; green with a tick = done today, play again free. Grey is never used: every card is tappable.
  // "AD" only where an advertisement is what will actually be shown (ads.isAd): the free stand-in the site
  // runs until the network approves it is not one, and must not be called one.
  const ICON_PLAY = ICO('<path d="M8 5.5v13l10.5-6.5z"/>');
  // Before a round is played its card has one button: Play. Once it is scored, two: Play again (the same
  // puzzle, free) and Play next (a new one, an advertisement where advertising is on).
  const chipAgain = id => `<button type="button" class="aa-train-got is-again" data-train="${id}" data-train-mode="again">${ICON_AGAIN}Play again</button>`;
  const chipNext = id => `<button type="button" class="aa-train-got is-next" data-train="${id}" data-train-mode="next">Play next${ads.isAd() ? ICON_AD : ICON_NEXT}</button>`;
  function trainCardState(t, id) {
    if (typeof t[id] === 'number') return { cls: 'is-done', tag: `\u2713 ${t[id]}`, chips: chipAgain(id) + chipNext(id) };
    return { cls: '', tag: '', chips: `<span class="aa-train-got">${ICON_PLAY}Play</span>` };
  }
  const runLine = id => {
    const run = trainRun(id), goal = TRAIN_GOALS.find(g => run < g);
    if (!goal) return `<span class="aa-train-goal is-done"><i style="width:100%"></i></span><em>${run} days \u2713</em>`;
    return `<span class="aa-train-goal"><i style="width:${Math.round(100 * run / goal)}%"></i></span><em>${run}/${goal} days</em>`;
  };
  function renderTrainPill() {
    if (!el.trainPill) return;
    const t = trainDay(), done = trainDone(t);
    el.trainPill.textContent = done ? String(trainScore(t)) : '';
    el.trainPill.classList.toggle('is-done', done);
    el.trainPill.classList.toggle('is-dot', !done);
  }
  function openTrain() {
    if (!el.trainSheet || !DATA) return;
    trainLeave();
    renderTrain();
    openSheet(el.trainSheet);
  }
  // A round is a game: the sheet becomes the whole screen, the lobby behind it gone, and the music comes on
  // the way it does for a board. The list is a sheet again when the round is over.
  function trainScreen(on) {
    if (!el.trainSheet) return;
    el.trainSheet.classList.toggle('aa-sheet--page', on);
    el.trainSheet.classList.toggle('is-playing', on);
    // in a round the corner button is the way back to the list, not out of the sheet
    const x = $('[data-close-sheet]', el.trainSheet); if (x) { x.innerHTML = on ? ICON_BACK : '\u2715'; x.setAttribute('aria-label', on ? 'Back to the rounds' : 'Close'); }
    if (on) musicBegin(); else if (el.game.hidden) musicStop();
  }
  // stop: the round in hand ends (its result stays on the full screen); leave: back to the list, or out
  function trainStop() { clearInterval(train.timer); train.timer = 0; train.game = null; trainCoachEnd(false); }
  function trainLeave() { trainStop(); trainScreen(false); train.serial = 0; }
  // Back out of a round (the corner arrow, the app's Back): asked about while a round is being played, the way
  // leaving a board is, since what was done on it is not kept; from a result it just goes back to the list.
  // The round's clock does not count the time the question was open.
  async function trainBack() {
    const g = train.game;
    if (g) {
      const asked = performance.now();
      const leave = await ask({ title: 'Leave this round?', body: 'It is not scored, and it starts again from the beginning next time.', ok: 'Leave the round', cancel: 'Keep playing' });
      if (!leave) { if (train.game === g && typeof g.t0 === 'number') g.t0 += performance.now() - asked; return; }
    }
    trainLeave(); renderTrain();
  }
  function renderTrain() {
    const t = trainDay(), score = trainScore(t), done = trainDone(t), all = trainAll(t), streak = trainStreak();
    // seven days of bars, today on the right; a day with no score is an empty bar
    const days = Array.from({ length: 7 }, (_, i) => { const k = dayKeyBack(6 - i); const v = trainScore(trainDay(k)); return { k, v, today: i === 6 }; });
    const bars = days.map(d => `<span class="aa-train-bar${d.today ? ' is-today' : ''}${d.v == null ? ' is-none' : ''}" title="${d.k}${d.v == null ? '' : ' · ' + d.v}"><i style="height:${d.v == null ? 6 : Math.max(6, d.v)}%"></i></span>`).join('');
    el.trainBody.innerHTML = `
      <div class="aa-train-top">
        <div class="aa-train-score"><b>${score == null ? '—' : score}</b><span>Brain Score</span></div>
        <div class="aa-train-week" role="img" aria-label="Last seven days">${bars}</div>
      </div>
      <p class="aa-train-line${!done && streak > 1 ? ' is-warn' : ''}"><span>${trainTally(t, streak) || (streak > 1 ? `${streak} days in a row \u00b7 play today` : 'Four rounds, free every day')}</span><button type="button" class="aa-train-info" data-train-about aria-label="How Daily Training works" aria-expanded="false">?</button></p>
      <p class="aa-sheet-note aa-train-about" id="aaTrainAbout" hidden>${ads.isAd() ? 'Every round is free once a day. Then play it again for nothing, as often as you like, or play a new one of it with a short advertisement. Your best score of the day counts, and the bar under a round is the days you have played it.' : 'Every round is free, every day. Play it again, or play a new one of it. Your best score of the day counts, and the bar under a round is the days you have played it.'}</p>
      <div class="aa-train-rounds">
        ${TRAIN_ROUNDS.map(r => { const c = trainCardState(t, r.id); return `<div class="aa-train-card ${c.cls}" data-train="${r.id}" data-train-mode="again" role="button" tabindex="0">${trainIcon(r.id)}<span class="aa-row-label">${c.tag ? `<small class="aa-train-tag">${c.tag}</small>` : ''}<span class="aa-train-name">${r.name}</span><small class="aa-train-run">${runLine(r.id)}</small></span><span class="aa-train-cta">${c.chips}</span></div>`; }).join('')}
      </div>
      <div id="aaTrainGame" hidden></div>`;
    // the marks are paintings: fetched once, and the list drawn again when they arrive
    if (!ART) loadArt().then(() => { const list = $('.aa-train-rounds', el.trainBody); if (list && !list.hidden) renderTrain(); }).catch(() => {});
  }
  // Each round's mark is made of paintings, not a glyph: a canvas with a piece gone, the copy beside the
  // original, three on a wall, one detail through a lens. Picks of their own (salt 'icon'), so nothing of
  // the day's rounds is given away. Until the gallery has loaded, the drawn line mark stands in.
  function trainIcon(id) {
    if (!ART) return `<span class="aa-train-ico2">${TRAIN_ICON[id]}</span>`;
    const p = artPicks(3, 'icon-' + id), bg = w => `background-image:url('${w.file}')`;
    const inner = id === 'f' ? `<i style="${bg(p[0])}"></i><i style="${bg(p[0])}"></i>` : id === 'g' ? p.map(w => `<i style="${bg(w)}"></i>`).join('') : `<i style="${bg(p[0])}"></i>`;
    return `<span class="aa-train-ico2 aa-train-art aa-train-art--${id}" aria-hidden="true">${inner}</span>`;
  }
  el.trainBtn?.addEventListener('click', openTrain);
  // ← in a round or on its result: back to the list. ✕ on the list: out, as on every sheet.
  $('[data-close-sheet]', el.trainSheet)?.addEventListener('click', e => { if (el.trainSheet.classList.contains('is-playing')) { e.stopImmediatePropagation(); void trainBack(); } }, true);
  el.trainBody?.addEventListener('click', e => {
    const rb = e.target.closest('[data-train]');
    if (rb) { void trainPlay(rb.dataset.train, rb.dataset.trainMode === 'next'); return; }
    if (e.target.closest('[data-train-back]')) { void trainBack(); return; }
    const info = e.target.closest('[data-train-info]');
    if (info) { const c = $('.aa-art-credit', el.trainBody); if (c) { c.hidden = !c.hidden; info.setAttribute('aria-expanded', String(!c.hidden)); } return; }
    const about = e.target.closest('[data-train-about]');
    if (about) { const c = $('#aaTrainAbout', el.trainBody); if (c) { c.hidden = !c.hidden; about.setAttribute('aria-expanded', String(!c.hidden)); } return; }
    if (e.target.closest('[data-train-how]')) { trainHowCard(); return; }
    // a drag that just ended is not a tap on whatever it ended over
    if (train.game?.dragEnd && performance.now() - train.game.dragEnd < 400) return;
    if ((train.game?.kind === 'r' || train.game?.kind === 'g') && e.target.closest('.aa-art-piece, .aa-art-slot, .aa-gal-piece, .aa-gal-slot')) return;   // pieces move by dragging, and by nothing else
    if (e.target.closest('[data-train-howclose]')) { $('.aa-train-howcard', el.trainBody)?.remove(); return; }
    if (e.target.closest('[data-train-hint]')) { void trainHint(); return; }
    const detail = e.target.closest('[data-detail]');
    if (detail && train.game?.kind === 'e') curatorAnswer(+detail.dataset.detail);
  });
  // The hint button of the round in hand: free once a day, then an advertisement the player chooses.
  const hintLabel = () => `\u{1F4A1} Hint${trainHintsLeft() > 0 ? '' : ads.isAd() ? ICON_AD : ''}`;
  const hintBtnHtml = () => `${howBtnHtml()}<button type="button" class="aa-train-hint" data-train-hint>${hintLabel()}</button>`;
  async function trainHint() {
    const g = train.game; if (!g || !g.hint || g.hintBusy) return;
    if (trainHintsLeft() > 0) {
      const t = trainDay(); t.h = (t.h | 0) + 1; store.set(trainKey(), t);
      g.hints = (g.hints | 0) + 1; g.hint(); $$('[data-train-hint]', el.trainBody).forEach(b => { b.innerHTML = hintLabel(); });
      return;
    }
    g.hintBusy = true;
    try { const got = await adOffer('trainhint', null, true); if (got && train.game === g) { g.hints = (g.hints | 0) + 1; g.hint(); } }
    finally { if (train.game === g) g.hintBusy = false; }
  }
  // Play: the day's free round, a round already unlocked today, or an advertisement first. The round counts
  // as played when it starts, not when it ends, so leaving one halfway is not a way round it.
  // Play: free, unless it is a NEW puzzle (next) where advertising is on -- an advertisement first, every
  // time. Again replays the day's current puzzle of that round. A start counts when it starts.
  async function trainPlay(id, next = false) {
    if (train.busy || !TRAIN_ROUNDS.some(r => r.id === id)) return;
    if (!trainFree(id, next)) {
      train.busy = true;
      try { const got = await adOffer('trainplay', null, true); if (!got) return; }
      finally { train.busy = false; }
    }
    const t = trainDay(); t.pp = t.pp && typeof t.pp === 'object' ? t.pp : {}; t.pp[id] = (t.pp[id] | 0) + 1; t.p = (t.p | 0) + 1;
    if (next) { t.nx = t.nx && typeof t.nx === 'object' ? t.nx : {}; t.nx[id] = (t.nx[id] | 0) + 1; }
    store.set(trainKey(), t);
    train.serial = trainSerial(t, id);
    trainStart(id);
  }
  const howHtml = id => { const r = TRAIN_ROUNDS.find(x => x.id === id); return `<ol class="aa-train-how">${r.how.map(h => `<li>${h}</li>`).join('')}</ol>`; };
  const howBtnHtml = () => '<button type="button" class="aa-train-info" data-train-how aria-label="How to play">?</button>';

  // ── The coach for the rounds ──
  // The first time a round is opened it is taught the way the arrow board is: not a page of text but a
  // spotlight on the thing to touch, a card of one sentence, and -- where the move is a drag -- a hand that
  // makes the move over and over until the player makes it. The card never blocks the round; each step
  // clears itself when the move it asked for is made (`wait`), or on Next. Once through, or skipped, it is
  // not shown again (`trainHow:<id>`); the text version stays behind the ? in the round's bar.
  const TRAIN_COACH = {
    r: [
      { title: 'Look at the painting', body: 'It hangs whole for four seconds. Then it comes apart.', target: () => $('#aaCanvasSlots', el.trainBody), wait: 'play' },
      { title: 'Drag it home', body: 'Press a piece and drag it into the frame, to the place it belongs.', target: () => $('#aaCanvasTray .aa-art-piece:not([hidden])', el.trainBody), hand: () => [$('#aaCanvasTray .aa-art-piece:not([hidden])', el.trainBody), $(`[data-slot="${$('#aaCanvasTray .aa-art-piece:not([hidden])', el.trainBody)?.dataset.tile}"]`, el.trainBody)], wait: 'placed' },
      { title: 'Now the rest', body: 'Every piece home wins the round. A wrong try costs a little, so does time over 90 seconds. Hint puts one piece home for you.', target: () => $('#aaCanvasSlots', el.trainBody) },
    ],
    f: [
      { title: 'Find what is wrong', body: 'Three patches of this copy are not in the original: one mirrored, one recoloured, one from elsewhere. Tap the first one you spot.', target: () => $('#aaForgeCopy', el.trainBody), wait: 'found' },
      { title: 'Two more', body: 'A tap on nothing costs a little. Hint circles one for you.', target: () => $('.aa-train-hud', el.trainBody) },
    ],
    g: [
      { title: 'Remember the order', body: 'The paintings hang here for a few seconds, numbered. Remember which is first, second, third…', target: () => $('#aaGalleryRow', el.trainBody), wait: 'play' },
      { title: 'Hang them back', body: 'Drag each painting to the number it hung at. When every place is filled, the wrong ones are marked: move them.', target: () => $('#aaGalleryTray', el.trainBody), hand: () => [$('#aaGalleryTray .aa-gal-piece[data-pick="0"]', el.trainBody), $('.aa-gal-slot[data-slot="0"]', el.trainBody)], wait: 'placed' },
    ],
    e: [
      { title: 'Look closely', body: 'Six seconds. The corners as much as the middle.', target: () => $('#aaCurator', el.trainBody), wait: 'ask' },
      { title: 'Which is from it?', body: 'One of these four is a detail of that painting. Tap it. Three times over.', target: () => $('.aa-curator-opts', el.trainBody) },
    ],
  };
  const tcoach = { on: false, id: '', step: 0, box: null, anim: null };
  function trainCoachStart(id) {
    if (store.get('trainHow:' + id) || !TRAIN_COACH[id] || !el.trainSheet) return;
    trainCoachEnd(false);
    const box = document.createElement('div'); box.className = 'aa-coach aa-train-coach';
    box.innerHTML = `<div class="aa-coach-spot"></div><div class="aa-hand" hidden><svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="15" /><circle cx="20" cy="20" r="6" /></svg></div>
      <div class="aa-coach-card" role="dialog" aria-modal="false"><p class="aa-coach-step"></p><h3></h3><p class="aa-coach-body"></p>
      <div class="aa-coach-actions"><button type="button" class="aa-linkbtn" data-tc="skip">Skip</button><button type="button" class="aa-btn aa-btn--primary" data-tc="next">Next</button></div></div>`;
    box.addEventListener('click', e => { const a = e.target.closest('[data-tc]')?.dataset.tc; if (a === 'skip') trainCoachEnd(true); else if (a === 'next') trainCoachShow(tcoach.step + 1); });
    document.body.appendChild(box);
    Object.assign(tcoach, { on: true, id, step: 0, box });
    trainCoachShow(0);
  }
  function trainCoachShow(n) {
    const steps = TRAIN_COACH[tcoach.id]; if (!tcoach.on || !steps) return;
    if (n >= steps.length) { trainCoachEnd(true); return; }
    tcoach.step = n; const st = steps[n], box = tcoach.box;
    $('.aa-coach-step', box).textContent = `Step ${n + 1} of ${steps.length}`;
    $('h3', box).textContent = st.title; $('.aa-coach-body', box).textContent = st.body;
    $('[data-tc="next"]', box).textContent = n === steps.length - 1 ? 'Got it' : 'Next';
    trainCoachPlace();
  }
  function trainCoachPlace() {
    const steps = TRAIN_COACH[tcoach.id]; if (!tcoach.on || !steps) return;
    const st = steps[tcoach.step], box = tcoach.box, spot = $('.aa-coach-spot', box), hand = $('.aa-hand', box);
    const t = st.target?.(), r = t?.getBoundingClientRect?.();
    if (!r || !r.width) spot.classList.add('is-none');
    else { spot.classList.remove('is-none'); const pad = 10; spot.style.left = `${r.left - pad}px`; spot.style.top = `${r.top - pad}px`; spot.style.width = `${r.width + pad * 2}px`; spot.style.height = `${r.height + pad * 2}px`; }
    // the hand: from the thing to press to the place it goes, again and again, until the player does it
    if (tcoach.anim) { tcoach.anim.cancel(); tcoach.anim = null; }
    const pair = st.hand?.(), a = pair?.[0]?.getBoundingClientRect?.(), b = pair?.[1]?.getBoundingClientRect?.();
    if (!a || !b || !a.width || !b.width || calmer()) { hand.hidden = true; return; }
    hand.hidden = false;
    const from = [a.left + a.width / 2 - 20, a.top + a.height / 2 - 20], to = [b.left + b.width / 2 - 20, b.top + b.height / 2 - 20];
    hand.style.transform = `translate(${from[0]}px, ${from[1]}px)`;
    tcoach.anim = hand.animate([
      { transform: `translate(${from[0]}px, ${from[1]}px) scale(1)`, opacity: 0, offset: 0 },
      { transform: `translate(${from[0]}px, ${from[1]}px) scale(1)`, opacity: 1, offset: 0.15 },
      { transform: `translate(${from[0]}px, ${from[1]}px) scale(.8)`, opacity: 1, offset: 0.3 },
      { transform: `translate(${to[0]}px, ${to[1]}px) scale(.8)`, opacity: 1, offset: 0.8 },
      { transform: `translate(${to[0]}px, ${to[1]}px) scale(1)`, opacity: 0, offset: 1 },
    ], { duration: 2200, iterations: Infinity, easing: 'ease-in-out' });
  }
  // a round reporting a move: the step that was waiting for it clears
  function trainCoachEvent(kind) { const st = TRAIN_COACH[tcoach.id]?.[tcoach.step]; if (tcoach.on && st?.wait === kind) trainCoachShow(tcoach.step + 1); }
  function trainCoachEnd(done) {
    if (tcoach.anim) { tcoach.anim.cancel(); tcoach.anim = null; }
    if (tcoach.box) tcoach.box.remove();
    if (done && tcoach.id) store.set('trainHow:' + tcoach.id, 1);
    Object.assign(tcoach, { on: false, id: '', step: 0, box: null });
  }
  window.addEventListener('resize', () => { if (tcoach.on) trainCoachPlace(); });
  // A round fits the screen. Whatever a round draws under its line gets the room left below it and no more:
  // the paintings are as big as that room allows and no bigger, so both halves of the Forgery, the whole frame
  // with its tray, the Curator's painting and then its four details are on the glass together, nothing to
  // scroll for. The room is read from the layout (offsets up to the sheet, the panel's bottom padding), not
  // from the viewport, so it holds on a turned phone too; and it is read again whenever the window changes.
  // a clear strip kept under the last painting on top of the panel's own padding: a phone's gesture bar, a
  // browser's toolbar coming back, a line that wraps one more time -- none of them reaches the art
  const TRAIN_SAFE = 24;
  function trainFit() {
    const g = train.game, box = $('#aaTrainGame', el.trainBody), sheet = el.trainSheet; if (!g || !box || !sheet) return;
    const panel = $('.aa-sheet-panel', sheet);
    const room = first => {
      let top = 0; for (let n = first; n && n !== sheet; n = n.offsetParent) top += n.offsetTop;
      const pad = panel ? parseFloat(getComputedStyle(panel).paddingBottom) || 0 : 0;
      return Math.max(220, sheet.clientHeight - top - pad - TRAIN_SAFE);
    };
    const px = (node, w, full) => { if (node) node.style.width = w < full - 0.5 ? `${w.toFixed(1)}px` : ''; };
    const q = g.w ? g.w.w / g.w.h : 1;   // the painting's width over its height
    if (g.kind === 'f') {
      // the copy goes under the original or beside it, whichever leaves the two bigger on this screen: under
      // it on a tall phone even for a tall work, beside it where the room is short; the line says which
      const pair = $('.aa-forge-pair', box); if (!pair) return;
      const W = pair.clientWidth, colW = (W - 10) / 2;
      let r = room(pair);
      const side = Math.min(colW, r * q) > Math.min(W, (r - 10) / 2 * q);
      pair.classList.toggle('is-side', side);
      const where = $('#aaForgeWhere', box); if (where) where.textContent = side ? 'beside' : 'below';
      r = room(pair);   // the line may have rewrapped
      $$('.aa-art', pair).forEach(a => px(a, side ? Math.min(colW, r * q) : Math.min(W, (r - 10) / 2 * q), side ? colW : W));
    } else if (g.kind === 'r') {
      const slots = $('#aaCanvasSlots', box), tray = $('#aaCanvasTray', box); if (!slots || !tray) return;
      // measured under the line the round will carry once the pieces are down, which is the longer one
      const line = $('#aaCanvasLine', box), look = g.phase === 'show' ? line?.textContent : null;
      if (look != null && line) line.textContent = CANVAS_PLAY_LINE;
      const W = box.clientWidth, r = room(slots), N = g.n * g.n, MIN = 30, FMIN = Math.min(W, g.n * 36 + (g.n - 1) * 2 + 4);   // a place under 36 px is too small to drop on
      if (look != null && line) line.textContent = look;
      // the frame first: as wide as the box whenever the tray under it can be made to fit, the tray taking as
      // many columns as that needs (five to ten) with pieces as big as the columns then allow; where even
      // thumb-sized pieces (MIN wide) leave no room for the whole frame, the frame gives way and the pieces
      // do not, since a piece too small to take is a piece that cannot be played; nor does the frame go below
      // places a finger can drop on (FMIN) -- on the shortest screens the tray's last row may then need a scroll
      let best = null;
      for (let c = 5; c <= 10; c++) {
        const rows = Math.ceil(N / c), pwFull = (W - (c - 1) * 6) / c; if (pwFull < MIN) break;
        const pwMax = ((r - 12 - W / q - (rows - 1) * 6) / rows) * q;   // the widest piece that still leaves the frame the whole width
        const pw = Math.max(MIN, Math.min(pwFull, pwMax));
        const wb = Math.max(FMIN, Math.min(W, (r - 12 - rows * pw / q - (rows - 1) * 6) * q)), wt = pw * c + (c - 1) * 6;
        // the widest frame; then the biggest pieces; then the fewest rows and the fewest columns, a tray in shape
        if (!best || wb > best.wb + 0.5 || (wb > best.wb - 0.5 && (pw > best.pw + 0.5 || (pw > best.pw - 0.5 && rows < best.rows)))) best = { c, pw, wb, wt, rows };
      }
      if (!best) return;
      px(slots, best.wb, W); px(tray, best.wt, W);
      tray.style.gridTemplateColumns = `repeat(${best.c}, 1fr)`;
    } else if (g.kind === 'e') {
      const art = $('#aaCurator > .aa-art', box), opts = $('.aa-curator-opts', box), W = box.clientWidth;
      if (art) px(art, Math.min(W, room(art) * q), W);
      if (opts) px(opts, Math.min(W, room(opts)), W);
    }
  }
  // Fitted again when the window changes -- a frame later, once the turn handler at the foot of the file has
  // had its say, since a turned page is another shape -- and once the fonts are in, a line measured before
  // its font came being a line shorter. The coach's spotlight follows whatever moved.
  function trainRefit() { if (!train.game) return; trainFit(); if (tcoach.on) trainCoachPlace(); }
  window.addEventListener('resize', () => requestAnimationFrame(trainRefit));
  document.fonts?.ready?.then?.(trainRefit);
  function trainHowCard() {
    const g = train.game; if (!g) return;
    $('.aa-train-howcard', el.trainBody)?.remove();
    const card = document.createElement('div'); card.className = 'aa-train-howcard';
    card.innerHTML = `<div class="aa-train-howcard-in"><h3>${TRAIN_ROUNDS.find(x => x.id === g.kind).name}</h3>${howHtml(g.kind)}<button type="button" class="aa-btn aa-btn--primary" data-train-howclose>Got it</button></div>`;
    $('#aaTrainGame', el.trainBody)?.appendChild(card);
  }
  function trainStart(id) {
    if (!$('#aaTrainGame', el.trainBody)) renderTrain();
    const box = $('#aaTrainGame', el.trainBody); if (!box) return;
    $$('.aa-train-top, .aa-train-line, .aa-train-rounds, .aa-sheet-note', el.trainBody).forEach(n => { n.hidden = true; });
    box.hidden = false;
    trainScreen(true);
    if (id === 'r') void canvasStart(box); else if (id === 'f') void (async () => { if (await needArt(box)) forgeryStart(box); })(); else if (id === 'g') void galleryStart(box); else if (id === 'e') void curatorStart(box);
  }
  const hintCost = g => (g.hints | 0) * 10;
  function trainFinish(kind, score, lines, work = null, works = null) {
    trainStop(); const fresh = trainSave(kind, score);
    const lvl = fresh ? levelNo(-1) - 1 : 0;   // the level this clear was: the latest on the main count
    const box = $('#aaTrainGame', el.trainBody); if (!box) return;
    const t = trainDay();
    // the painting's name, painter and source sit behind a ? -- there for whoever wants them, in nobody's way
    const credit = work ? artCredit(work) : works ? `<p class="aa-art-credit">${works.map((w, i) => `${i + 1}. <b>${escapeHtml(w.title)}</b> \u2014 ${escapeHtml(w.artist)}`).join('<br>')}<br>The Met, public domain</p>` : '';
    box.innerHTML = `<div class="aa-train-res">
      <p class="aa-card-kicker">${TRAIN_ROUNDS.find(r => r.id === kind).name}${lvl ? ` <b class="aa-train-lv">Level ${lvl}</b>` : ''}${credit ? ' <button type="button" class="aa-train-info" data-train-info aria-label="About the painting" aria-expanded="false">?</button>' : ''}</p>
      <p class="aa-train-big">${clamp100(score)}</p>
      <p class="aa-train-sub">${lines}</p>
      ${credit.replace('<p class="aa-art-credit">', '<p class="aa-art-credit" hidden>')}
      ${(() => { const n = TRAIN_ROUNDS.filter(r => typeof t[r.id] === 'number').length; return (n > 1 ? `<p class="aa-train-sub"><b>Brain Score today: ${trainScore(t)}</b></p>` : '') + `<p class="aa-train-sub aa-train-ok">\u2713 ${trainTally(t, trainStreak(), true)}</p>`; })()}
      <div class="aa-actions aa-actions--stack"><button type="button" class="aa-btn aa-btn--primary${ads.isAd() ? ' aa-btn--ad' : ''}" data-train="${kind}" data-train-mode="next">Play next${ads.isAd() ? ICON_AD : ICON_NEXT}</button><button type="button" class="aa-btn aa-btn--soft" data-train="${kind}" data-train-mode="again">${ICON_AGAIN}Play again</button></div>
    </div>`;
    SFX.win(); vibe(20);
  }

  // ── The gallery rounds: real paintings, public domain ──
  // Two hundred and forty-seven works from The Metropolitan Museum of Art's Open Access collection (CC0), in games/data/art.json
  // with their titles, painters and dates, resized once and kept in images/art/. Every round names the work it
  // used, so ten minutes of training is also ten minutes in a museum. The day's picks depend on where the player is.
  let ART = null, artPromise = null;
  function loadArt() {
    if (ART) return Promise.resolve(ART);
    if (!artPromise) artPromise = fetch(`/games/data/art.json?v=${ART_VERSION}`, { cache: 'force-cache' }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }).then(a => { ART = a; return a; }).catch(e => { artPromise = null; throw e; });
    return artPromise;
  }
  async function needArt(box) {
    if (ART) return true;
    box.innerHTML = '<p class="aa-sheet-note">Opening the gallery…</p>';
    try { await loadArt(); return true; } catch { box.innerHTML = '<p class="aa-sheet-note">The gallery could not be loaded. Check the connection and try again.</p><div class="aa-actions aa-actions--stack"><button type="button" class="aa-btn aa-btn--soft" data-train-back>Back</button></div>'; return false; }
  }
  // ── Which paintings, for whom ──
  // The gallery starts where the player is, the way the tour does. Every work carries the country it comes
  // from (`cc`) and the tradition it belongs to (`trad`: is = Islamic, hb = Hindu and Buddhist, ea = East
  // Asian, we = European and American); a player's home country (the tour's) has a tradition of its own from
  // the table below. Works are ranked: the home country's own first, then the home tradition's nearest first,
  // then the rest of the continent, then everything else by distance. The first days draw from the top of that
  // list and the window widens a little every training day, so a player in Dhaka begins with Mughal and Bengal
  // and reaches Paris in a few weeks, and a player in Lyon the other way round. Days are still seeded: the same
  // home country sees the same paintings on the same day.
  const TRAD_OF = (() => {
    const t = {};
    for (const c of 'AF AL AZ BH BD BN DJ DZ EG GM GN ID IQ IR JO KM KW KG KZ LB LY MA ML MR MV MY NE OM PK PS QA SA SD SN SL SO SY TJ TM TN TR AE UZ XK YE TD TL EH'.split(' ')) t[c] = 'is';
    for (const c of 'IN NP LK BT MM TH KH LA MU FJ'.split(' ')) t[c] = 'hb';
    for (const c of 'CN JP KR KP TW VN MN HK MO SG'.split(' ')) t[c] = 'ea';
    return t;
  })();
  const tradOf = cc => TRAD_OF[cc] || 'we';
  function artRanked() {
    const home = store.get('home', null) || '';
    const H = DATA?.canon?.find(L => L.a2 === home);
    if (!H) return ART.works.slice();
    const ht = tradOf(home);
    const at = cc => DATA.canon.find(L => L.a2 === cc);
    const tier = w => w.cc === home ? 0 : tradOf(w.cc) === ht ? 1 : (at(w.cc)?.cont && at(w.cc).cont === H.cont) ? 2 : 3;
    const km = w => { const C = at(w.cc); return C ? kmBetween(H.c, C.c) : 20000; };
    return ART.works.map(w => ({ w, t: tier(w), d: km(w) })).sort((a, b) => a.t - b.t || a.d - b.d).map(x => x.w);
  }
  // how many training days this device has seen, today included: the window of the gallery open to it
  function trainDays() {
    let n = 0;
    try { for (const k of Object.keys(localStorage)) if (k.startsWith(STORE + 'train:')) n++; } catch { /* none */ }
    return Math.max(1, n);
  }
  function artPicks(n, salt) {
    const home = store.get('home', null) || '';
    const rnd = mulberry32(hashStr('aa-art-' + salt + '-' + home + '-' + dayKey() + (train.serial ? '-n' + train.serial : '')));
    const ranked = artRanked();
    const pool = ranked.slice(0, Math.min(ranked.length, Math.max(n + 9, 14 + 7 * (trainDays() - 1))));
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    return pool.slice(0, n);
  }
  const artCredit = w => `<p class="aa-art-credit"><b>${escapeHtml(w.title)}</b><br>${escapeHtml(w.artist)}${w.date ? ', ' + escapeHtml(w.date) : ''} · The Met, public domain</p>`;
  // a whole painting, at its own proportions
  const artFrame = (w, cls = '', inner = '', attrs = '') => `<div class="aa-art ${cls}" style="aspect-ratio:${w.w}/${w.h};background-image:url('${w.file}')" ${attrs}>${inner}</div>`;
  // one patch of a painting: the square (px, py, s) of it, in fractions of the whole, drawn at any size
  const artPatch = (w, px, py, s, cls = '', extra = '', attrs = '') => `<span class="aa-art-patch ${cls}" style="background-image:url('${w.file}');background-size:${(100 / s).toFixed(2)}% ${(100 / s).toFixed(2)}%;background-position:${(100 * px / (1 - s)).toFixed(2)}% ${(100 * py / (1 - s)).toFixed(2)}%;${extra}" ${attrs}></span>`;

  // Restore the Canvas: a painting in nine pieces. Tap a piece, tap where it goes.
  async function canvasStart(box) {
    if (!(await needArt(box))) return;
    const w = artPicks(1, 'canvas')[0], { n, allow } = tierParams('r');
    const rnd = mulberry32(hashStr('aa-canvas-deal-' + dayKey() + '-' + train.serial));
    const tray = Array.from({ length: n * n }, (_, i) => i); for (let i = tray.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [tray[i], tray[j]] = [tray[j], tray[i]]; }
    const tile = i => `<span class="aa-art-tile" style="background-image:url('${w.file}');background-size:${n * 100}% ${n * 100}%;background-position:${(100 * (i % n) / (n - 1)).toFixed(2)}% ${(100 * Math.floor(i / n) / (n - 1)).toFixed(2)}%"></span>`;
    train.game = { kind: 'r', w, n, allow, tile, slots: Array(n * n).fill(null), wrong: 0, t0: performance.now(), phase: 'show', locked: new Set(), hint() {
      // the first piece out of place goes home and stays there
      const g = train.game; if (!g || g.phase !== 'play') return;
      const k = g.slots.findIndex((t, i) => t !== i && !g.locked.has(i)); if (k < 0) return;
      const from = g.slots.indexOf(k); if (from >= 0) g.slots[from] = null;
      g.slots[k] = k; g.locked.add(k); canvasDraw(); canvasCheck();
    } };
    // the painting hangs whole in the frame first, every piece where it belongs, for a few seconds; then it
    // comes apart and the pieces tumble down into the tray, shuffled
    box.innerHTML = `<div class="aa-train-hud"><span>Restore the Canvas ${levelChip('r')}</span><span id="aaCanvasTime">${CANVAS_LOOK}</span>${hintBtnHtml()}</div>
      <p class="aa-train-sub" id="aaCanvasLine">Look at the painting. Remember where things are.</p>
      <div class="aa-art-slots" id="aaCanvasSlots" style="aspect-ratio:${w.w}/${w.h};grid-template-columns:repeat(${n}, 1fr)">${tray.map((_, i) => `<button type="button" class="aa-art-slot" data-slot="${i}" aria-label="Place ${i + 1}"><span class="aa-art-piece is-placed" data-tile="${i}">${tile(i)}</span></button>`).join('')}</div>
      <div class="aa-art-tray" id="aaCanvasTray">${tray.map(i => `<button type="button" class="aa-art-piece" data-tile="${i}" aria-label="Piece" style="aspect-ratio:${w.w}/${w.h}" hidden>${tile(i)}</button>`).join('')}</div>`;
    trainFit();
    const showUntil = performance.now() + CANVAS_LOOK * 1000;
    train.timer = setInterval(() => {
      const g = train.game; if (!g || g.kind !== 'r') return; const t = $('#aaCanvasTime', box);
      if (g.phase === 'show') { const rem = Math.ceil((showUntil - performance.now()) / 1000); if (t) t.textContent = String(Math.max(0, rem)); if (rem <= 0) canvasScatter(box); return; }
      if (t) t.textContent = fmtTime(performance.now() - g.t0);
    }, 500);
    canvasDragWire(box);
    trainCoachStart('r');
  }
  const CANVAS_LOOK = 4;   // seconds the painting hangs whole before it comes apart
  const CANVAS_PLAY_LINE = 'Drag each piece to where it belongs. Drag one out to take it back.';
  function canvasScatter(box) {
    const g = train.game; if (!g || g.kind !== 'r' || g.phase !== 'show') return;
    const from = new Map($$('#aaCanvasSlots .aa-art-piece', box).map(p => [+p.dataset.tile, p.getBoundingClientRect()]));
    g.phase = 'play'; g.t0 = performance.now();
    canvasDraw();   // the frame empties, the tray fills; each piece then flies from where it hung to where it lies
    const line = $('#aaCanvasLine', box); if (line) line.textContent = CANVAS_PLAY_LINE;
    const t = $('#aaCanvasTime', box); if (t) t.textContent = '0:00';
    SFX.scatter(); vibe(15);
    trainFly($$('#aaCanvasTray .aa-art-piece:not([hidden])', box).map(el => ({ el, from: from.get(+el.dataset.tile) })), { tumble: 12 }).then(() => { if (train.game === g) trainCoachEvent('play'); });
  }
  // Pieces on the move: each element flies from where it was (its `from` rect) to where it is now, one after
  // another, with a little tumble, and the promise lands with the last of them. Under reduced motion they
  // are simply there. The scatter of the canvas and the paintings coming off the gallery wall are both this.
  function trainFly(list, { tumble = 0, dur = 320, stagger = 30 } = {}) {
    if (calmer()) return Promise.resolve();
    const fin = [];
    list.forEach(({ el, from }, i) => {
      const to = el.getBoundingClientRect(); if (!from || !from.width || !to.width || !el.animate) return;
      const dx = from.left - to.left, dy = from.top - to.top, sc = from.width / to.width;
      el.classList.add('is-flying');
      const a = el.animate([
        { transform: `translate(${dx}px, ${dy}px) scale(${sc})` },
        { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 14}px) scale(${(1 + sc) / 2}) rotate(${tumble ? (i % 2 ? tumble : -tumble) : 0}deg)`, offset: 0.55 },
        { transform: 'none' },
      ], { duration: dur, delay: i * stagger, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'backwards' });
      fin.push(a.finished.catch(() => {}).then(() => el.classList.remove('is-flying')));
    });
    return Promise.all(fin);
  }
  /**
   * Drag and drop, with pointer events so a finger and a mouse are the same thing: press a piece, carry a
   * copy of it under the finger, drop it on a slot. Shared by the canvas and the gallery: `o.piece` and
   * `o.slot` are the selectors, `o.key` the data attribute that names a piece, `o.ghost(key)` draws the
   * carried copy, `o.drop(key, from, to)` and `o.out(key, from)` are what a drop means. Dragging is the only
   * way a piece moves: a tap does nothing, so there is one thing to learn. The pointer is captured once the
   * press moves (captured from the press, the buttons above would lose a tap that slid). The sheet does not
   * scroll from a piece (touch-action) so a drag never turns into a scroll halfway.
   */
  function trainDragWire(box, o) {
    // the game box lives on between rounds: wire each kind once, or a replay would answer every drop twice
    if (box.dataset['wired' + o.kind]) return; box.dataset['wired' + o.kind] = '1';
    let d = null;
    const over = (x, y) => { const sl = document.elementFromPoint(x, y)?.closest?.(o.slot); $$(o.slot + '.is-over', box).forEach(n => { if (n !== sl) n.classList.remove('is-over'); }); if (sl && !o.locked(+sl.dataset.slot)) sl.classList.add('is-over'); return sl; };
    box.addEventListener('pointerdown', e => {
      const g = train.game; if (!g || g.kind !== o.kind || e.button || (g.phase && g.phase !== 'play')) return;
      const piece = e.target.closest(o.piece); if (!piece) return;
      const slot = piece.closest(o.slot); const from = slot ? +slot.dataset.slot : -1;
      if (from >= 0 && o.locked(from)) return;
      const r = piece.getBoundingClientRect();
      d = { id: e.pointerId, key: +piece.dataset[o.key], from, piece, x0: e.clientX, y0: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height, moved: false, ghost: null };
    });
    box.addEventListener('pointermove', e => {
      const g = train.game; if (!d || e.pointerId !== d.id || !g) return;
      if (!d.moved) {
        if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 6) return;
        d.moved = true;
        try { box.setPointerCapture(e.pointerId); } catch { /* fine without */ }
        d.ghost = document.createElement('div'); d.ghost.className = 'aa-art-drag'; d.ghost.style.width = `${d.w}px`; d.ghost.style.height = `${d.h}px`; d.ghost.innerHTML = o.ghost(d.key);
        document.body.appendChild(d.ghost); d.piece.classList.add('is-ghost');
      }
      d.ghost.style.transform = `translate(${e.clientX - d.dx}px, ${e.clientY - d.dy}px)`;
      over(e.clientX, e.clientY);
    });
    const end = e => {
      if (!d || e.pointerId !== d.id) return;
      const g = train.game, was = d; d = null;
      if (!was.moved) return;   // a press that went nowhere
      was.ghost?.remove(); was.piece.classList.remove('is-ghost');
      $$(o.slot + '.is-over', box).forEach(n => n.classList.remove('is-over'));
      if (!g || g.kind !== o.kind) return;
      g.dragEnd = performance.now();
      const sl = e.type === 'pointercancel' ? null : document.elementFromPoint(e.clientX, e.clientY)?.closest?.(o.slot);
      if (sl) o.drop(was.key, was.from, +sl.dataset.slot);
      else if (was.from >= 0 && e.type !== 'pointercancel') o.out(was.key, was.from);   // out of the frame: back to the tray
      else o.redraw();
    };
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
  }
  const canvasDragWire = box => trainDragWire(box, { kind: 'r', piece: '.aa-art-piece', slot: '.aa-art-slot', key: 'tile', locked: k => !!train.game?.locked.has(k), ghost: k => train.game.tile(k), drop: canvasDrop, out: (k, from) => { const g = train.game; if (g) { g.slots[from] = null; canvasDraw(); } }, redraw: canvasDraw });
  function canvasDrop(tile, from, k) {
    const g = train.game; if (!g || g.locked.has(k)) { canvasDraw(); return; }
    if (from === k) { canvasDraw(); return; }
    const occupant = g.slots[k];
    if (from >= 0) g.slots[from] = occupant != null ? occupant : null;   // from a slot: swap
    g.slots[k] = tile; SFX.shoot(); canvasDraw(); canvasCheck(); trainCoachEvent('placed');
  }
  function canvasDraw() {
    const g = train.game; if (!g) return;
    const slots = $('#aaCanvasSlots', el.trainBody), tray = $('#aaCanvasTray', el.trainBody); if (!slots || !tray) return;
    $$('.aa-art-slot', slots).forEach((sl, k) => { const t = g.slots[k]; sl.innerHTML = t == null ? '' : `<span class="aa-art-piece is-placed${g.locked.has(k) ? ' is-locked' : ''}" data-tile="${t}">${g.tile(t)}</span>`; });
    $$('.aa-art-piece', tray).forEach(b => { b.hidden = g.slots.includes(+b.dataset.tile); });
  }
  function canvasCheck() {
    const g = train.game; if (!g || g.slots.some(t => t == null)) return;
    const wrongNow = g.slots.filter((t, i) => t !== i).length;
    if (wrongNow) { g.wrong++; toast(`${wrongNow} piece${wrongNow === 1 ? ' is' : 's are'} in the wrong place.`, 'hint', 1800); SFX.block(); return; }
    const secs = (performance.now() - g.t0) / 1000;
    trainFinish('r', 100 - g.wrong * 8 - Math.max(0, secs - g.allow) * 0.5 - hintCost(g), `${fmtTime(secs * 1000)} · ${g.wrong} wrong tr${g.wrong === 1 ? 'y' : 'ies'}`, g.w);
  }

  // The Forgery: the painting and a copy with three things wrong in it. Tap the copy where it lies.
  function forgeryStart(box) {
    const w = artPicks(1, 'forgery')[0], { lies: nLies, s, hue, allow } = tierParams('f');
    const rnd = mulberry32(hashStr('aa-forgery-' + dayKey() + '-' + train.serial));
    const spots = []; let guard = 0;
    while (spots.length < nLies && guard++ < 400) {
      const px = 0.05 + rnd() * (0.9 - s), py = 0.05 + rnd() * (0.9 - s);
      if (spots.every(q => Math.abs(q.px - px) > s * 1.2 || Math.abs(q.py - py) > s * 1.2)) spots.push({ px, py });
    }
    // three kinds of lie: a patch mirrored, a patch recoloured, a patch taken from elsewhere in the painting
    // the three kinds of lie, round and round: a fourth lie is mirrored again, a fifth recoloured again
    const lies = spots.map((q, i) => i % 3 === 0 ? { ...q, extra: 'transform:scaleX(-1)' } : i % 3 === 1 ? { ...q, extra: `filter:hue-rotate(${hue}deg) saturate(1.25)` } : { ...q, from: { px: 0.05 + rnd() * (0.9 - s), py: 0.05 + rnd() * (0.9 - s) } });
    const patches = lies.map((q, i) => { const src = q.from || q; return artPatch(w, src.px, src.py, s, 'aa-forge-lie', `left:${(100 * q.px).toFixed(2)}%;top:${(100 * q.py).toFixed(2)}%;width:${100 * s}%;height:${100 * s}%;${q.extra || ''}`, `data-lie="${i}"`); }).join('');
    train.game = { kind: 'f', w, lies, allow, found: new Set(), wrong: 0, t0: performance.now(), hint() {
      const g = train.game; if (!g) return; const k = g.lies.findIndex((_, i) => !g.found.has(i)); if (k < 0) return; forgeryFound(k, true);
    } };
    box.innerHTML = `<div class="aa-train-hud"><span>The Forgery ${levelChip('f')}</span><span id="aaForgeLeft">${nLies} to find</span><span id="aaForgeTime">0:00</span>${hintBtnHtml()}</div>
      <p class="aa-train-sub">${['Three', 'Four', 'Five'][nLies - 3]} things are wrong in the copy <span id="aaForgeWhere">${w.h > w.w ? 'beside' : 'below'}</span> the original. Tap them there.</p>
      <div class="aa-forge-pair${w.h > w.w ? ' is-side' : ''}">${artFrame(w, 'aa-forge-orig')}${artFrame(w, 'aa-forge-copy', patches, 'id="aaForgeCopy" role="img" aria-label="The copy"')}</div>`;
    trainFit();
    $('#aaForgeCopy', box)?.addEventListener('click', e => {
      const g = train.game; if (!g || g.kind !== 'f') return;
      const lie = e.target.closest('[data-lie]');
      if (lie) { const i = +lie.dataset.lie; if (!g.found.has(i)) forgeryFound(i, false); return; }
      g.wrong++; SFX.block(); vibe(30); toast('Not there.', 'hint', 900);
    });
    train.timer = setInterval(() => { const g = train.game; if (!g || g.kind !== 'f') return; const t = $('#aaForgeTime', box); if (t) t.textContent = fmtTime(performance.now() - g.t0); }, 500);
    trainCoachStart('f');
  }
  function forgeryFound(i, byHint) {
    const g = train.game; if (!g) return;
    g.found.add(i); if (!byHint) SFX.shoot(); trainCoachEvent('found');
    const p = $(`[data-lie="${i}"]`, el.trainBody); if (p) p.classList.add('is-found');
    const left = g.lies.length - g.found.size;
    const el2 = $('#aaForgeLeft', el.trainBody); if (el2) el2.textContent = left ? `${left} to find` : 'Found';
    if (left === 0) {
      const secs = (performance.now() - g.t0) / 1000;
      trainFinish('f', 100 - g.wrong * 10 - Math.max(0, secs - g.allow) * 0.5 - hintCost(g), `${fmtTime(secs * 1000)} · ${g.wrong} wrong tap${g.wrong === 1 ? '' : 's'}`, g.w);
    }
  }

  // Gallery Memory: five paintings on the wall for five seconds, then the same five out of order.
  const artThumb = (w, attrs = '') => `<span class="aa-art-thumb" style="background-image:url('${w.file}')" ${attrs}></span>`;
  async function galleryStart(box) {
    if (!(await needArt(box))) return;
    const { n, secs } = tierParams('g');
    const picks = artPicks(n, 'gallery');
    const rnd = mulberry32(hashStr('aa-gallery-deal-' + dayKey() + '-' + train.serial));
    const deal = picks.map((_, i) => i); for (let i = deal.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [deal[i], deal[j]] = [deal[j], deal[i]]; }
    train.game = { kind: 'g', picks, deal, n, slots: Array(n).fill(null), locked: new Set(), wrong: 0, phase: 'show', hint() {
      // the first painting out of place goes to its number and stays there
      const g = train.game; if (!g || g.phase !== 'play') return;
      const k = g.slots.findIndex((p, i) => p !== i && !g.locked.has(i)); if (k < 0) return;
      const from = g.slots.indexOf(k); if (from >= 0) g.slots[from] = null;
      g.slots[k] = k; g.locked.add(k); galleryDraw(); galleryCheck();
    } };
    box.innerHTML = `<div class="aa-train-hud"><span>Gallery Memory ${levelChip('g')}</span><span id="aaGalleryTime">${secs}</span>${hintBtnHtml()}</div>
      <p class="aa-train-sub" id="aaGalleryLine">Remember the order they hang in.</p>
      <div class="aa-gallery-row" id="aaGalleryRow" style="grid-template-columns:repeat(${Math.min(n, 5)}, 1fr)">${picks.map((w, i) => `<span class="aa-gallery-pick" data-c="${w.id}">${artThumb(w)}<small>${i + 1}</small></span>`).join('')}</div>`;
    let left = secs;
    train.timer = setInterval(() => {
      const g = train.game; if (!g || g.kind !== 'g' || g.phase !== 'show') return;
      left--; const t = $('#aaGalleryTime', box); if (t) t.textContent = String(Math.max(0, left));
      if (left <= 0) {
        clearInterval(train.timer); train.timer = 0;
        const row = $('#aaGalleryRow', box), wall = $$('#aaGalleryRow .aa-gallery-pick', box).map(e => e.getBoundingClientRect());
        if (row) row.outerHTML = `<div class="aa-gal-slots" id="aaGallerySlots" style="grid-template-columns:repeat(${Math.min(n, 5)}, 1fr)">${picks.map((_, i) => `<span class="aa-gal-slot" data-slot="${i}" aria-label="Place ${i + 1}"><small>${i + 1}</small></span>`).join('')}</div>
          <div class="aa-gal-tray" id="aaGalleryTray" style="grid-template-columns:repeat(${Math.min(n, 5)}, 1fr)">${g.deal.map(i => `<span class="aa-gal-piece" data-pick="${i}" aria-label="Painting">${artThumb(g.picks[i])}</span>`).join('')}</div>`;
        const line = $('#aaGalleryLine', box); if (line) line.textContent = 'Now drag each painting back to the number it hung at.';
        if (t) t.textContent = `0 of ${n}`;
        galleryDragWire(box);
        SFX.scatter(); vibe(15);
        trainFly($$('#aaGalleryTray .aa-gal-piece', box).map(el => ({ el, from: wall[+el.dataset.pick] })), { tumble: 8 }).then(() => { if (train.game !== g) return; g.phase = 'play'; g.t0 = performance.now(); trainCoachEvent('play'); });
      }
    }, 1000);
    trainCoachStart('g');
  }
  const galleryDragWire = box => trainDragWire(box, { kind: 'g', piece: '.aa-gal-piece', slot: '.aa-gal-slot', key: 'pick', locked: k => !!train.game?.locked.has(k), ghost: k => artThumb(train.game.picks[k]), drop: galleryDrop, out: (k, from) => { const g = train.game; if (g) { g.slots[from] = null; galleryDraw(); } }, redraw: galleryDraw });
  function galleryDrop(pick, from, k) {
    const g = train.game; if (!g || g.phase !== 'play' || g.locked.has(k) || from === k) { galleryDraw(); return; }
    const occupant = g.slots[k];
    if (from >= 0) g.slots[from] = occupant != null ? occupant : null;
    g.slots[k] = pick; SFX.shoot(); galleryDraw(); galleryCheck(); trainCoachEvent('placed');
  }
  function galleryDraw() {
    const g = train.game; if (!g) return;
    const slots = $('#aaGallerySlots', el.trainBody), tray = $('#aaGalleryTray', el.trainBody); if (!slots || !tray) return;
    $$('.aa-gal-slot', slots).forEach((sl, k) => { const p = g.slots[k]; sl.innerHTML = `<small>${k + 1}</small>${p == null ? '' : `<span class="aa-gal-piece is-placed${g.locked.has(k) ? ' is-locked' : ''}" data-pick="${p}">${artThumb(g.picks[p])}</span>`}`; sl.classList.remove('is-wrong'); });
    $$('.aa-gal-piece', tray).forEach(b => { b.hidden = g.slots.includes(+b.dataset.pick); });
    const t = $('#aaGalleryTime', el.trainBody); if (t) t.textContent = `${g.slots.filter(p => p != null).length} of ${g.n}`;
  }
  function galleryCheck() {
    const g = train.game; if (!g || g.slots.some(p => p == null)) return;
    const wrongNow = g.slots.map((p, i) => p !== i ? i : -1).filter(i => i >= 0);
    if (wrongNow.length) {
      g.wrong += wrongNow.length; SFX.block(); vibe(30);
      wrongNow.forEach(i => $(`.aa-gal-slot[data-slot="${i}"]`, el.trainBody)?.classList.add('is-wrong'));
      toast(`${wrongNow.length} ${wrongNow.length === 1 ? 'is' : 'are'} in the wrong place. Move them.`, 'hint', 1800);
      return;
    }
    trainFinish('g', 100 - g.wrong * 10 - hintCost(g), `${g.wrong} in the wrong place along the way`, null, g.picks);
  }

  // The Curator's Eye: one painting for six seconds; then, three times, four details -- which one is from it?
  async function curatorStart(box) {
    if (!(await needArt(box))) return;
    const { secs, q: nQ, s } = tierParams('e');
    const [w, ...others] = artPicks(1 + 3 * nQ, 'curator');
    const rnd = mulberry32(hashStr('aa-curator-' + dayKey() + '-' + train.serial));
    const ask = Array.from({ length: nQ }, (_, q) => {
      const truth = { w, px: 0.05 + rnd() * (0.9 - s), py: 0.05 + rnd() * (0.9 - s) };
      const opts = [truth, ...others.slice(q * 3, q * 3 + 3).map(o => ({ w: o, px: 0.05 + rnd() * (0.9 - s), py: 0.05 + rnd() * (0.9 - s) }))];
      for (let i = opts.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [opts[i], opts[j]] = [opts[j], opts[i]]; }
      return opts;
    });
    train.game = { kind: 'e', w, s, ask, q: 0, right: 0, phase: 'show', hint() {
      // one more look, a short one
      const g = train.game; if (!g || g.phase !== 'ask' || g.peeked || g.lock) return; g.peeked = true;
      const box2 = $('#aaCurator', el.trainBody); if (!box2) return;
      const keep = box2.innerHTML; box2.innerHTML = artFrame(g.w, 'is-peek'); trainFit(); setTimeout(() => { if (train.game === g) { box2.innerHTML = keep; trainFit(); } }, 1500);
    } };
    box.innerHTML = `<div class="aa-train-hud"><span>The Curator’s Eye ${levelChip('e')}</span><span id="aaCuratorTime">${secs}</span>${hintBtnHtml()}</div>
      <p class="aa-train-sub" id="aaCuratorLine">Look closely. You will be asked about the details.</p>
      <div id="aaCurator">${artFrame(w)}</div>`;
    trainFit();
    let left = secs;
    train.timer = setInterval(() => {
      const g = train.game; if (!g || g.kind !== 'e' || g.phase !== 'show') return;
      left--; const t = $('#aaCuratorTime', box); if (t) t.textContent = String(Math.max(0, left));
      if (left <= 0) { clearInterval(train.timer); train.timer = 0; g.phase = 'ask'; curatorAsk(); trainCoachEvent('ask'); }
    }, 1000);
    trainCoachStart('e');
  }
  function curatorAsk() {
    const g = train.game; if (!g) return;
    const opts = g.ask[g.q]; const box = $('#aaCurator', el.trainBody); if (!box || !opts) return;
    const t = $('#aaCuratorTime', el.trainBody); if (t) t.textContent = `${g.q + 1} of ${g.ask.length}`;
    const line = $('#aaCuratorLine', el.trainBody); if (line) line.textContent = 'Which detail is from the painting you saw?';
    box.innerHTML = `<div class="aa-curator-opts">${opts.map((o, i) => `<button type="button" class="aa-curator-opt" data-detail="${i}" aria-label="Detail ${i + 1}">${artPatch(o.w, o.px, o.py, g.s)}</button>`).join('')}</div>`;
    trainFit();
  }
  function curatorAnswer(i) {
    const g = train.game; if (!g || g.phase !== 'ask' || g.lock) return;
    const opts = g.ask[g.q]; const ok = opts[i].w === g.w; g.lock = true;
    if (ok) { g.right++; SFX.shoot(); } else { SFX.block(); vibe(30); }
    $$('.aa-curator-opt', el.trainBody).forEach((b, k) => { b.disabled = true; if (opts[k].w === g.w) b.classList.add('is-right'); else if (k === i) b.classList.add('is-wrong'); });
    g.q++;
    setTimeout(() => {
      if (train.game !== g) return; g.lock = false;
      if (g.q < g.ask.length) curatorAsk();
      else trainFinish('e', Math.round(100 * g.right / g.ask.length) - hintCost(g), `${g.right} of ${g.ask.length} right`, g.w);
    }, 700);
  }

  el.card.addEventListener('click', e => {
    if (performance.now() - cardShownAt < CARD_DEAF_MS) return;   // the click that opened this card is not a press on it
    const inv = e.target.closest('[data-invite]');
    if (inv) { invitePlayer(inv.dataset.invite, inv.dataset.name, inv); return; }
    const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
    if (act === 'adheart') { adOffer('heart'); return; }
    if (act === 'next') { const j = nextOpen(state.idx); if (j < 0) goToLevels(); else startLevel(j); }
    else if (act === 'again' || act === 'retry') { if (state.daily?.race) state.daily.moves = (state.moves | 0) + 1; startLevel(state.idx, false, state.daily, state.tier); }
    else if (act === 'shuffle') startLevel(state.idx, true, state.daily);
    else if (act === 'skip') { const id = DATA.levels[state.idx + 1]?.id; store.set(skipKey(state.idx + 1), true); if (id && !isLocalOnly(id)) syncTour({ [id]: { cleared: false, skipped: true } }); startLevel(nextOpen(state.idx)); }
    // Out of hearts is not the end of a challenge — giving up is, and it cannot be taken back: the loss goes
    // to the server, the seat closes and the stake is gone. So the quiet button asks before it does that.
    else if (act === 'giveup') {
      ask({ title: 'Give the board up?', body: 'Your run ends here, and your stake goes to whoever clears it.',
        ok: 'Give it up', cancel: 'Keep playing', danger: true }).then(yes => {
        if (!yes) return;
        el.card.innerHTML = '<h3>Sending…</h3>'; finishMatch(false, 0, true);
      });
    }
    else if (act === 'resend') { const b = e.target.closest('[data-act]'); b.disabled = true; flushResult(true).then(ok => { if (!ok) b.disabled = false; }); }
    else if (act === 'minfo') toggleRoomInfo();
    else if (act === 'minvite') showInvitePanel(state.pendingMatch);
    else if (act === 'mshare') sendInvite(state.pendingMatch);
    else if (act === 'mroom') renderRoom(state.pendingMatch);
    else if (act === 'mcancel') leaveRoom();
    else if (act === 'mstart') startMatch();
    else if (act === 'levels') goToLevels();
    else if (act === 'share') share();
    else if (act === 'gorace') el.overlay.hidden = true;
  });

  // A run belongs to the match it was played in. When that match is over — cleared, lost, given up, left, or
  // closed by somebody else — everything it put on the HUD goes with it. Without this the clock, the hearts
  // and the hints of the last match sat over the next room while it waited for players to join, which reads
  // like a game already in progress and is simply somebody else's board's leftovers.
  function clearRun() {
    stopTimer(); heartbeatStop();
    state.pieces = []; state.occ = null; state.mask = null; state.left = 0; state.W = 0; state.H = 0;
    state.lives = LIVES; state.livesMax = LIVES;
    state.elapsed = 0; state.startedAt = 0; state.raceBase = 0;
    state.hintsUsed = 0; state.hintsMax = HINTS_PER_LEVEL;
    state.checksUsed = 0; state.checksMax = CHECKS_PER_LEVEL;   // the same two lines as the hints, for the same reason
    state.finished = false; state.wrong = 0; state.fails = 0; state.potGone = false;
    state.combo = 0; state.bestCombo = 0; state.lastShot = 0; state.shown = new Set();
    state.daily = null; state.disc = null;
    el.board.innerHTML = '';
    if (el.ranks) el.ranks.hidden = true;
    renderHud();
  }
  function goToLevels() {
    coachEnd();
    stopTimer(); stopMatchPoll(); stopProgressPoll(); stopResultWatch(); musicStop();
    live.leaveFeed();   // back in the lobby: nothing to watch, but the socket is how invitations arrive
    clearRun();
    if (el.ranks) el.ranks.hidden = true; el.game.hidden = true; el.overlay.hidden = true; el.select.hidden = false; setHash(-1); renderSelect();
    // Somebody asked for a match while this player was still on a board. Now they are not.
    const waiting = state.inviteWaiting; state.inviteWaiting = null;
    if (waiting && Date.now() - waiting.at < INVITE_KEEP_MS) setTimeout(() => onInvite({ data: waiting }), 400);
  }
  async function share() {
    const n = DATA.levels.length, done = DATA.levels.filter((_, i) => cleared(i)).length;
    const D = state.disc, rec = state.daily ? store.get(`daily:${state.daily.key}`) : cleared(state.idx);
    const what = D ? `${D.country.name}'s ${KIND_WORD[D.kind]}, the ${state.level.name}` : state.level.name;
    const text = `Puzzle – Train Your Brain: I cleared ${what} (${state.daily ? 'daily board ' + state.daily.key : 'level ' + levelNo(state.idx)}) in ${fmtTime(rec?.t ?? state.elapsed, true)} ${'★'.repeat(rec?.stars || stars())} and ${done}/${n} boards so far. Rank: ${rankOf(arrowsShot()).name} (${fmtN(arrowsShot())} arrows).\nYour turn: https://ariyankhan.com/puzzle/${state.daily ? '#daily' : '#b-' + state.level.id}`;
    const flash = $('.aa-flash', el.card);
    try {
      if (shell.on && shell.bridge() && (await shell.ask('share ' + text, 8000)).ok) return;   // the phone's own share sheet
      if (navigator.share) { await navigator.share({ text }); return; }
      await navigator.clipboard.writeText(text);
      if (flash) { flash.textContent = 'Copied. Paste it anywhere.'; flash.hidden = false; }
    } catch { if (flash) { flash.textContent = text; flash.hidden = false; } }
  }

  // ── Rewarded advertisements ──
  //
  // Off until the domain is approved, and built so that turning it on is one line in the page rather than a
  // change in here: <meta name="puzzle-ads" content="h5" data-client="ca-pub-XXXXXXXX">.
  //
  // Three modes. `off` shows no ad anywhere and every offer below simply does not appear, so the game today is
  // the game as it was. `h5` is Google's H5 Games Ads placement API, which is the product that actually does
  // rewarded ads in a browser -- plain AdSense does not, whatever its dashboard implies. `test` is a five
  // second stand-in with the same shape and the same promise, so the whole flow can be walked through and
  // filmed before a single real ad exists.
  //
  // What this layer promises the game: ads.show() resolves 'watched' only when the network says the ad was
  // watched to the end. Everything else -- dismissed, blocked, nothing to serve, an error -- resolves to
  // something that is not 'watched', and the caller gives nothing away.
  // Two switches, and they answer different questions.
  //
  //   mode  -- off | test | h5 -- whether any of this exists at all.
  //   give  -- ad | free       -- what the offer IS, and it is the important one.
  //
  // give:'ad' is production and it is strict. A real rewarded advertisement is requested, and the reward is
  // handed over on one signal and one only: adViewed, the network saying the advertisement was watched through.
  // A skip, a close, a failed load, a blocked request, nothing in stock -- all of them give nothing, and the
  // player is told which it was. No other path grants anything.
  //
  // give:'free' is for the stretch before H5 Games Ads is approved for the domain, when no advertisement can
  // fill and a button labelled "Watch an ad" that pays out anyway is a lie in two directions at once. In this
  // mode the network is never asked, no advertising code runs for it, and the offer never calls itself an
  // advertisement: it is a free lifeline, and it says so. It exists so the feature can be seen and used before
  // approval without pretending to be something it is not.
  //
  // The day approval lands: data-give="ad" in the meta, or drop the attribute, and the strict path is live.
  // Nothing else changes.
  const ads = {
    mode: 'off',
    give: 'ad',
    client: '',
    admob: { rewarded: '' },
    showing: false,
    // Google's own test advertisements, asked for with data-adbreak-test on the script tag. Not our stand-in
    // panel: the real library runs the whole break and reports it, and nothing leaves the phone.
    mock: false,
    // Which developer mode forced this, if any. It is what decides whether a failure is allowed to name
    // itself on screen — a player is owed a plain sentence, a developer is owed the reason.
    dev: '',
    // The last break the library was asked for: what came back, why, and how long it took. Read by the
    // developer group in Settings, which is the only place on a phone that can show it.
    last: null,
    // Milliseconds from adConfig to the library saying it was ready, or 0 if it never said so.
    libReady: 0,
    ready() { return this.mode !== 'off' && !this.showing; },
    on() { return this.mode !== 'off'; },
    isAd() { return this.give === 'ad'; },
  };
  const ADS_MODES = ['off', 'test', 'h5'];
  // What the switch on a device may be set to. 'site' is not a mode — it means leave the page alone — and
  // 'mock' is not one either: it is 'h5' with Google's test advertisements in place of real ones.
  const ADS_DEV = ['site', 'off', 'test', 'mock', 'h5'];
  (function adsConfigure() {
    const meta = document.querySelector('meta[name="puzzle-ads"]');
    let mode = (meta?.content || 'off').trim();
    ads.client = (meta?.dataset.client || '').trim();
    // AdMob's ad unit ids, for when the game is running inside the app. They are not an alternative to the
    // AdSense tag — the same tag asks for the same breaks — they are what decides who answers: AdMob's demand
    // instead of AdSense's, which is the only arrangement Google's H5 guide calls policy compliant for a game
    // embedded in an app you own. Empty until the AdMob account has them; the browser never uses them.
    // One unit: the rewarded one. Nothing in this game shows an advertisement of its own accord, so there is
    // no interstitial unit and no slot for one.
    ads.admob = { rewarded: (meta?.dataset.admobRewarded || '').trim() };
    // The test mode is a developer's switch, not a URL anybody can find: on the live site it needs a flag set
    // by hand on that device first. The server's daily cap is the real defence either way -- it can only ever
    // hand out a few hundred gold a day, whatever the page claims to have shown -- but a free-gold link in a
    // share sheet is not a thing to leave lying about.
    const wanted = new URLSearchParams(location.search).get('ads');
    const local = devAllowed();
    // The stored switch, set from Settings after seven taps on the build line. It exists because the URL
    // parameter needs an address bar and the app has none: without it there is no way at all to watch the
    // advertisement path on a phone, which is the one place it has to work.
    // 'site' is what revealing the switch writes, and it means exactly what it says: leave the page alone.
    // It has to exist. The first version wrote 'off' instead, which is a mode — so seven taps to look at the
    // developer settings silently turned off the free lifeline every player is being given, on a screen with
    // no way to put it back, because choosing Off again changes nothing.
    const stored = store.get('adsdev', '');
    const dev = ADS_DEV.includes(stored) && stored !== 'site' ? stored : '';
    let forced = '';
    // Every mode is gated the same way now, Off included. It used to be exempt on the grounds that turning
    // advertising off can only ever be the safe direction — true when off meant no advertisement, and false
    // now that it also means no free lifeline, which makes a link somebody can be sent worth closing.
    if (wanted && ADS_DEV.includes(wanted) && wanted !== 'site' && (local || stored)) forced = wanted;
    else if (dev) forced = dev;
    ads.dev = forced;
    // 'mock' is the whole live path — the real library, the real callbacks, the real breakStatus — with
    // Google's mock advertisements standing in for demand we do not have yet. It is the only way to watch
    // the integration itself work before an approval lands, because our own Test panel never touches the
    // library at all and therefore proves nothing about it.
    if (forced === 'mock') { ads.mock = true; forced = 'h5'; }
    if (forced) mode = forced;
    ads.mode = ADS_MODES.includes(mode) ? mode : 'off';
    // What the offer is: a real advertisement, or a free lifeline. data-give says it for the app; data-give-web,
    // when present, says it for a browser -- the two are approved separately (AdMob for the app, H5 Games Ads
    // for the site), and a button that asks a network that has not approved the site yet gives nothing.
    const give = ((!shell.on && meta?.dataset.giveWeb) || meta?.dataset.give || 'ad').trim();
    ads.give = give === 'free' ? 'free' : 'ad';
    // Asking for the advertisement path and being handed a free lifeline is not a test of anything: the free
    // mode short-circuits every line of it. Keyed off what was actually forced, not off what is stored —
    // otherwise the URL parameter half of the switch sets a mode and leaves the offer free, which is the one
    // combination that looks like it worked and tests nothing.
    if (forced === 'test' || forced === 'h5') ads.give = 'ad';
    // Nothing of the advertising library is wired up for a free lifeline: it is not an advertisement, so it
    // does not ask for one, does not preload one, and does not report one.
    if (ads.mode !== 'h5' || !ads.isAd()) return;

    // The page already carries the AdSense tag, so there is nothing to load: adding a second copy of the same
    // script with the same publisher is how a page ends up with two libraries arguing over one slot. Take the
    // publisher from the tag that is there, and only add one if there is none.
    const tag = document.querySelector('script[src*="adsbygoogle.js"]');
    if (!ads.client && tag) { try { ads.client = new URL(tag.src).searchParams.get('client') || ''; } catch { /* leave it */ } }
    if (!tag && ads.client) {
      const sc = document.createElement('script');
      sc.async = true; sc.crossOrigin = 'anonymous';
      sc.dataset.adFrequencyHint = '30s';
      // Documented, and the only value it takes: mock advertisements, no request to Google, and the
      // library's own frequency rules still applied. It deliberately fails every other break, which is the
      // point — a flow that only works when an advertisement is there is a flow that has not been tested.
      if (ads.mock) sc.dataset.adbreakTest = 'on';
      // Only in the app, and only if there is something to put there. In a browser these attributes mean
      // nothing, and leaving them off keeps the page that is serving real visitors today byte for byte the
      // one that has been proven to work.
      if (shell.on) {
        if (ads.admob.rewarded) sc.dataset.admobRewardedSlot = ads.admob.rewarded;
        // Inside the app, AdMob or nothing. Google's own words for this parameter are that it stops the game
        // falling back to AdSense "in cases where the game is being played in an environment which doesn't
        // support AdMob requests" — and for us that fallback is not a safety net, it is the one thing we are
        // not allowed to do: AdSense's policy says Google ads may not be integrated into a software
        // application, and excepts AdMob. It also makes a failure honest. Without it, a break that AdMob
        // could not fill can be quietly answered by AdSense and we would never know which we had shown.
        // Not in the mock mode. admob-ads-only is a rule about where a REAL advertisement may come from, and
        // in the test mode there is no real advertisement and no request at all — all the rule can do there
        // is refuse the mock one, which is the only thing that mode exists to show.
        if (!ads.mock && ads.admob.rewarded) sc.dataset.admobAdsOnly = 'on';
      }
      sc.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(ads.client)}`;
      document.head.appendChild(sc);
    }
    // adBreak and adConfig are the page's to define, not the library's: they push onto the queue the library
    // drains once it is ready, which is what makes a break requested before the script loads still work.
    window.adsbygoogle = window.adsbygoogle || [];
    if (typeof window.adBreak !== 'function') window.adBreak = o => window.adsbygoogle.push(o);
    if (typeof window.adConfig !== 'function') window.adConfig = o => window.adsbygoogle.push(o);
    // onReady is the library saying it has initialised and finished preloading. Without it there is no way
    // to tell a break that found no advertisement from a break asked of a library that never came up at all,
    // and those two have nothing in common: one is demand, the other is us.
    const configuredAt = performance.now();
    try {
      window.adConfig({
        preloadAdBreaks: 'on',
        sound: state.muted ? 'off' : 'on',
        onReady() { ads.libReady = Math.round(performance.now() - configuredAt); renderDevLast(); },
      });
    } catch { /* the library decides */ }
  })();

  // When an ad may be offered for a lifeline.
  //
  // As often as the player asks. There used to be a cap of one per board per kind, on the theory that a board
  // should not be watchable into submission -- but that is the player's own time they are spending, and a cap
  // turns the plus into a button that works once and is then a dead nought for the rest of the board, which
  // reads like a fault rather than a rule.
  //
  // The one place it is still refused is a gold match. Somebody who has put gold on a table is racing people who
  // put in the same gold; letting one of them buy extra hearts with their attention is not a lifeline, it is a
  // different game. The tour and the daily board have nothing at stake but pride, and there it is a kindness.
  // Every board, not only the tour's. A challenge used to be excluded from this outright, which meant a player
  // in a match — the one place in the game where a board actually costs something — was the one player who
  // could not buy a heart back. The reason it was excluded is real but it is the player's to weigh, not this
  // function's: the match clock does not stop for an advertisement, and the offer says so.
  function adCanOffer(kind) { void kind; return ads.on(); }

  // A stand-in ad: the same shape as the real one, long enough to be a real decision, skippable like the real
  // one, and it resolves exactly the way the real one does.
  function adTestShow(name, tag = 'Test advertisement', why = '') {
    return new Promise(resolve => {
      const wrap = document.createElement('div');
      wrap.className = 'aa-adtest';
      wrap.innerHTML = `<div class="aa-adtest-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(tag)}">
        <p class="aa-adtest-tag">${escapeHtml(tag)}</p>
        ${why ? `<p class="aa-adtest-why">${escapeHtml(why)}</p>` : ''}
        <p class="aa-adtest-name">${escapeHtml(name)}</p>
        <p class="aa-adtest-count"><b>5</b></p>
        <button type="button" class="aa-btn aa-adtest-skip">Close</button>
      </div>`;
      document.body.appendChild(wrap);
      const num = $('b', wrap), skip = $('.aa-adtest-skip', wrap);
      let left = 5, done = false;
      const end = how => { if (done) return; done = true; clearInterval(t); wrap.remove(); resolve(how); };
      skip.addEventListener('click', () => end(left <= 0 ? 'watched' : 'dismissed'));
      const t = setInterval(() => {
        left--; num.textContent = String(Math.max(0, left));
        if (left <= 0) { skip.textContent = 'Claim'; $('.aa-adtest-count', wrap).textContent = 'Done'; clearInterval(t); }
      }, 1000);
      setTimeout(() => { if (!done && left <= 0) end('watched'); }, 5600);
    });
  }

  // The real one. adBreak hands back a function to call when the player has agreed; adViewed is the only
  // callback that means the ad was seen through, and it is the only one that resolves 'watched'.
  function adH5Show(name, onStart = () => {}) {
    return new Promise(resolve => {
      if (typeof window.adBreak !== 'function') { adNote(name, 'unavailable', 'no library', 0); resolve('unavailable'); return; }
      const asked = performance.now();
      let settled = false, started = false;
      // `why` is the library's own word for what happened: adBreakDone is handed a placementInfo whose
      // breakStatus is one of a documented set — noAdPreloaded, frequencyCapped, timeout, error, and the
      // rest. It was being thrown away, which is why a phone could only ever say "no advertisement was
      // available" and never which of nine quite different things that meant.
      const done = (how, why = '') => {
        if (settled) return;
        settled = true; clearTimeout(waitAd); clearTimeout(waitEnd);
        adNote(name, how, why, Math.round(performance.now() - asked));
        resolve(how);
      };
      // Two clocks, because the two silences mean different things. The first is a leak guard, not a
      // deadline: adBreakDone is documented to fire for every break, so a break that has found nothing says
      // so in well under a second, and the only thing this clock ever catches is a library that has gone
      // quiet altogether. It was eight seconds and a phone proved that too short — the first advertisement
      // of a session has to be fetched, it arrived late, and the game had already told the player there was
      // none. Twenty is long to look at a panel, but losing an advertisement the player asked for and then
      // waited for is worse. Once beforeReward has fired an ad is actually running, and a rewarded one is
      // allowed to be minutes long.
      let waitEnd = 0;
      const waitAd = setTimeout(() => { if (!started) done('unavailable', 'nothing answered'); }, 20000);
      try {
        // Written before the break, not only after it. A break that never comes back at all — the library
        // showing an advertisement and waiting on a player who put the phone down — would otherwise leave
        // the developer line saying nothing had been asked for, which is the one reading that is never true.
        adNote(name, 'asked', '', 0);
        window.adBreak({
          type: 'reward',
          name,
          beforeReward(showAdFn) {
            // The five seconds above are a promise to the player that nothing was found, and this is where
            // that promise is kept. The break is still live when the clock runs out — the library has no
            // cancel — so a fill that arrives at the sixth second would take the whole screen for an
            // advertisement nobody is waiting for any more, and adViewed would land on a settled promise and
            // pay nothing. Declining is simply not calling showAdFn: the library skips the break and reports
            // it. Not showing one at all is the only honest end to a break we have already given up on.
            if (settled) return;
            started = true; clearTimeout(waitAd);
            // The waiting panel goes now, not when this promise settles: an advertisement is about to take the
            // screen, and leaving "looking for one" on top of the thing it was looking for is worse than no
            // panel at all.
            try { onStart(); } catch { /* it was only a panel */ }
            // Once showAdFn has been called an advertisement is on the screen and the player is watching
            // it; this clock is a leak guard, not a deadline. Two minutes used to be it, which is inside the
            // length of a rewarded advertisement that buffers badly — and resolving here while the thing is
            // still playing is the same unkept promise as above, with the player's attention already spent.
            waitEnd = setTimeout(() => done('unavailable', 'never ended'), 300000);
            try { showAdFn(); } catch { done('unavailable', 'would not show'); }
          },
          adViewed() { done('watched'); },
          adDismissed() { done('dismissed'); },
          // Fires last, and only lands here if nothing above did. Its placementInfo carries the one word
          // that says why nothing did.
          adBreakDone(info) { done('unavailable', (info && info.breakStatus) || 'no reason given'); },
        });
      } catch (badCall) { done('unavailable', 'the call threw'); }
    });
  }

  // What happened last time the library was asked, kept for the developer group in Settings. A phone has no
  // console, so a value that is only ever logged is a value nobody will ever read: this is the whole of the
  // reporting, and it holds one attempt, the last.
  function adNote(name, how, why, ms) {
    ads.last = { name, how, why, ms, at: Date.now() };
    renderDevLast();
  }


  // Asking the network takes a moment, and a moment of nothing at all reads as a button that did not work.
  // It is also the one screen the player sees between tapping the plus and the advertisement arriving, so it
  // is where the bargain is stated: what this is for, in one line, before it starts.
  function adLooking(earn) {
    const wrap = document.createElement('div');
    wrap.className = 'aa-adtest';
    wrap.innerHTML = `<div class="aa-adtest-panel"><p class="aa-adtest-tag">Advertisement</p>${
      earn ? `<p class="aa-adtest-why">${escapeHtml(earn)}</p>` : ''
    }<p class="aa-adtest-name">Looking for one\u2026</p></div>`;
    document.body.appendChild(wrap);
    return wrap;
  }

  // Show one, and say whether it earned the reward. Never two at once.
  //
  // 'watched' comes back from adViewed and from nothing else. Every other ending -- dismissed, no fill, a
  // failed load, a request something blocked -- comes back as itself and grants nothing. This function has no
  // consolation path on purpose: a reward handed out for an advertisement that did not run is an advertisement
  // we were paid nothing for and a promise to the player that was not kept.
  async function adShow(name, earn = '') {
    if (!ads.ready()) return 'unavailable';
    ads.showing = true;
    const wasMusic = music.on;
    try {
      if (wasMusic) musicStop();                     // an ad has its own sound; the pad does not talk over it
      if (ads.mode === 'test') return await adTestShow(name, 'Test advertisement', earn);
      const looking = adLooking(earn);
      const shut = () => looking.remove();
      try { return await adH5Show(name, shut); } finally { shut(); }
    } finally {
      ads.showing = false;
      if (wasMusic && state.music && !el.game.hidden && !state.finished) musicStart();
    }
  }

  // What each kind of reward is, in one table: what to call it, what the ad is named in the network's own
  // reporting, and what happens when it is earned. Gold is the odd one out and says so -- it is the only one
  // the client cannot grant, because gold is real and the server is the only thing allowed to make it.
  // `earn` is the line the advertisement panel carries while it is fetching one: what this is for, said before
  // it starts rather than in a sheet the player had to get past first.
  const AD_REWARD = {
    heart: {
      earn: 'Watch this through and the board carries on where it stopped, with one heart.',
      board: true,
      grant() { state.lives = 1; state.moves++; state.finished = false; state.busy = false; el.overlay.hidden = true; renderHud(); startTimer(); heartLost(); toast('One heart. Make it count.', 'good'); },
    },
    trainhint: {
      earn: 'Watch this through for a hint in this round.',
      board: false,
      grant() { /* the round in hand takes it: trainHint applies it once this resolves */ },
    },
    trainplay: {
      earn: 'Watch this through for a new one of this round.',
      board: false,
      grant() { /* trainPlay starts the round once this resolves */ },
    },
    hint: {
      earn: 'Watch this through for one more hint on this board.',
      board: true,
      grant(quiet) { state.hintsMax = (state.hintsMax ?? HINTS_PER_LEVEL) + 1; state.moves++; renderHud(); if (!quiet) toast('One more hint.', 'good'); },
    },
    check: {
      earn: `Watch this through for one more ${CHECK_WORD} on this board.`,
      board: true,
      grant() { state.checksMax = (state.checksMax ?? CHECKS_PER_LEVEL) + 1; state.moves++; renderHud(); toast(`One more ${CHECK_WORD}.`, 'good'); },
    },
    gold: {
      earn: 'Watch this through and the gold goes to your purse.',
      needsAccount: true,
      async grant() {
        // The stand-in panel asks nothing of any network, and the reward has to hold to the same rule. It did
        // not: the gold was claimed from the server for an advertisement that was never requested, never
        // shown and never paid for by anybody — real gold, on an account that can stake it against other
        // people. What the test mode owes is the shape of the thing, and the toast is that.
        if (ads.mode === 'test') { toast('Test advertisement watched. The real one adds gold here.', 'good', 3200); return; }
        await adClaimGold();
      },
    },
  };

  // The offer. One sheet, one decision, and nothing is spent before the ad has actually been watched.
  // ── Asking ──
  // The browser's own confirm() is a modal from another world: it says "ariyankhan.com says", it cannot be
  // styled, it freezes the page while it is up, and on a phone it looks like the site has been taken over by
  // something. The four places this game stops to ask are all about losing something the player cares about —
  // a board, a stake, an account — which is exactly where a dialog should look like it belongs to the game.
  //
  // So it is one of ours. Same panel as the advertisement offer, same buttons, and it answers the same way
  // confirm() did: a promise for true or false, and nothing happens until it settles. Escape and the backdrop
  // both mean no, and on a destructive question the safe button is the one holding focus — the OK button of a
  // native confirm is under the thumb that opened it, which is how an account gets deleted by a double tap.
  let asking = null, askClose = null;   // askClose answers the open question No: it is what the app's Back does
  function ask({ title, body, ok = 'OK', cancel = 'Cancel', danger = false }) {
    if (asking) return asking;   // one question at a time, and the second press is not an answer to the first
    return (asking = new Promise(resolve => {
      const wrap = document.createElement('div');
      wrap.className = 'aa-ask';
      wrap.innerHTML = `<div class="aa-ask-panel" role="alertdialog" aria-modal="true" aria-labelledby="aaAskT" aria-describedby="aaAskB">
        <h3 id="aaAskT">${escapeHtml(title)}</h3>
        <p id="aaAskB">${escapeHtml(body)}</p>
        <div class="aa-actions aa-actions--stack">
          <button type="button" class="aa-btn ${danger ? 'aa-btn--danger' : 'aa-btn--primary'}" data-ask="yes">${escapeHtml(ok)}</button>
          <button type="button" class="aa-btn" data-ask="no">${escapeHtml(cancel)}</button>
        </div>
      </div>`;
      const done = answer => { if (!wrap.isConnected) return; document.removeEventListener('keydown', onKey, true); wrap.remove(); asking = null; askClose = null; resolve(answer); };
      askClose = () => done(false);
      const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); } };
      wrap.addEventListener('click', e => {
        if (e.target === wrap) { done(false); return; }
        const a = e.target.closest('[data-ask]')?.dataset.ask;
        if (a) done(a === 'yes');
      });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(wrap);
      $(danger ? '[data-ask="no"]' : '[data-ask="yes"]', wrap)?.focus({ preventScroll: true });
    }));
  }

  // Tapping the plus is the whole transaction. It used to raise a sheet first — a title, a paragraph, a
  // "Watch for a hint" and a "No thanks" — which is a second decision about a decision the player had already
  // made by reaching for an empty counter. The advertisement starts on the tap now, and the line it was worth
  // reading in that sheet rides on the advertisement's own panel instead, where it is in front of the player
  // for the whole wait rather than for as long as it takes to press a button.
  //
  // What is not lost by skipping it: the reward is still named before anything plays, the advertisement is
  // still started by the player's own tap on a control that says what it is for, and nothing is granted for an
  // advertisement that did not run through.
  async function adOffer(kind, note, quiet = false) {
    const R = AD_REWARD[kind];
    if (!R || ads.showing) return;
    if (R.needsAccount && !auth.user) { openSignIn('Sign in first, so the gold has a purse to go into.'); return; }
    // A heart, a hint and a check are each for THIS board, and this board can be gone by the time the
    // advertisement ends: given up from the card behind it, left for the list, or replaced by the next one.
    // The pieces array is built fresh for every board and emptied when a run is cleared away, so holding on
    // to it is holding on to the board itself -- cheaper and more honest than a counter to keep in step.
    //
    // The heart is the one that would do damage. Its grant sets lives, clears finished, hides the overlay and
    // starts the clock: run against a board the player has already walked away from, it revives somebody
    // else's board under them. The other two would quietly add an allowance to a board nobody asked for.
    const board = R.board ? state.pieces : null;

    if (ads.isAd()) {
      // A match does not pause for this, and a player about to spend half a minute on an advertisement is owed
      // that before it starts, not after.
      const earn = `${note || R.earn}${state.daily?.race ? ' The match clock keeps running while it plays.' : ''}`;
      const how = await adShow(`${PRODUCT_AD}-${kind}`, earn);
      // Watched through, or nothing. There is no third answer, and each of the others says which one it was.
      if (how !== 'watched') {
        // The reason rides along only on a device where somebody turned the switch on. A player is owed a
        // plain sentence about their heart; a developer is owed "frequencyCapped".
        const why = ads.dev && ads.last?.why ? ` (${ads.last.why})` : '';
        toast(how === 'dismissed' ? 'The advertisement was not watched through, so nothing was added.'
          : `No advertisement was available, so nothing was added.${why} Try again in a moment.`, 'hint', 4200);
        return;
      }
      // adShow gave the lock back when its panel came down, and the reward has not been handed over yet —
      // for gold that means a request still in flight. Take it back for the rest, or a second tap starts a
      // second advertisement while the first is still being paid for, and the day's gold goes twice as fast
      // as the player watched for it.
      ads.showing = true;
      try {
        // The network's panel is still tearing itself down as this resolves, and a 2.5-second hint glow
        // behind it is a hint the player never sees. A breath first, then the reward.
        await new Promise(r => setTimeout(r, 400));
        if (board && (state.pieces !== board || el.game.hidden)) {
          toast('That board is over, so there was nothing to add it to.', 'hint', 3200);
          return false;
        }
        await R.grant(quiet);
      } finally { ads.showing = false; }
      return true;
    }

    // Advertising off: there is nothing to watch and nothing to agree to, so the tap simply pays out.
    ads.showing = true;                         // gold's grant goes to the server; a second tap is not a second reward
    try { await R.grant(quiet); } finally { ads.showing = false; }
    return true;
  }
  const PRODUCT_AD = 'puzzle';

  // Gold is the server's to give. The client says an advertisement finished; the server decides what that is
  // worth, counts the day's claims from the ledger and answers with the balance it now holds.
  async function adClaimGold() {
    try {
      const r = await fetch(`${API_V1}/ads/reward`, { method: 'POST', credentials: 'include', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (d.error === 'ad_cap') toast(ads.isAd() ? 'That is all the gold advertisements give today. Come back tomorrow.'
          : 'That is all the free gold today. Come back tomorrow.', 'hint', 4000);
        else if (d.error === 'signed_out') openSignIn('Sign in first, so the gold has a purse to go into.');
        else toast('The gold could not be added. Try again in a moment.', 'bad');
        if (typeof d.gold === 'number') setGold(d.gold);
        return;
      }
      setGold(d.gold);
      const more = ads.isAd() ? `${d.left} more advertisement${d.left === 1 ? '' : 's'} today.` : `${d.left} more today.`;
      toast(d.granted ? `${gfmt(d.granted)} gold. ${more}` : 'That one was already counted.', 'good', 3500);
    } catch { toast('The gold could not be added. Try again in a moment.', 'bad'); }
  }

  // ── Accounts ──
  // Only for playing with other people: the single-player game never asks. The server keeps the provider's
  // opaque user id and the display name, nothing else, and the account can be deleted from the dashboard.
  // Signed out, the button opens the sign-in sheet; signed in, it opens the dashboard.
  const auth = { user: null, providers: {}, match: null, ready: false };
  // me is a read; everything else changes something and is posted. The paths are the versioned ones, so a
  // later backend can add a v2 without this client noticing.
  const AUTH_PATH = { me: '/auth/me', google: '/auth/google', name: '/auth/name', logout: '/auth/logout', delete: '/auth/delete', handoff: '/auth/handoff', redeem: '/auth/handoff/redeem' };
  /**
   * Every call to the service goes through here: same-origin cookie, no caching, JSON in and out, and a
   * failure thrown as an Error carrying the server's own word in `code` (plus whatever `extra` picks out of
   * the body, for the match calls that answer with gold or a code). GET when there is no body.
   */
  function apiCall(url, body, method = body ? 'POST' : 'GET', extra = null) {
    return fetch(url, { method, credentials: 'include', cache: 'no-store', headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {}, body: method === 'POST' ? JSON.stringify(body || {}) : undefined })
      .then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(d.error || `HTTP ${r.status}`), { code: d.error }, extra ? extra(d) : {}); return d; });
  }
  const authApi = (a, body) => apiCall(`${API_V1}${AUTH_PATH[a] || '/auth/me'}`, body, a === 'me' ? 'GET' : 'POST');
  async function authLoad(force) {
    if (auth.ready && !force) return auth;
    try {
      const d = await authApi('me');
      auth.user = d.user || null; auth.providers = d.providers || {};
      // The match this account is still in, if there is one. It comes from the server rather than from this
      // device's memory, which is the whole point: a challenge started in a browser tab is a challenge the
      // phone has to be able to find, and before this the code lived only in whichever client opened it.
      auth.match = d.match || null;
    } catch { auth.user = null; auth.providers = {}; auth.match = null; }
    auth.ready = true;
    // Signed in means reachable: the socket is what marks this player as about and what carries an invitation
    // to them wherever they are in the game.
    if (auth.user) { live.onInvite = onInvite; live.keep(); } else live.close();
    return auth;
  }
  async function openFriends() {
    closeSheets();
    await authLoad(true);   // the purse may have changed on another device or in a match that has just settled
    renderAccountRow();
    if (auth.user) openStakes(); else openSignIn();
  }
  let gisAsked = false;
  function openSignIn(why) {
    if (el.signInSheet) { const note = $('.aa-sheet-note', el.signInSheet); if (note) { if (note.dataset.own === undefined) note.dataset.own = note.textContent; note.textContent = why || note.dataset.own; } }
    if (el.googleBtn) el.googleBtn.innerHTML = '';
    if (el.signInNote) { el.signInNote.hidden = true; el.signInNote.textContent = ''; }
    openSheet(el.signInSheet);
    // Google will not run its own sign-in inside a WebView — it answers disallowed_useragent — so in the app
    // the button is ours and the token is fetched natively on the other side of the bridge.
    if (shell.on) renderShellButton();
    else if (auth.providers.google) loadGis();
    else signInNote('Sign-in is being switched on. Until then, a challenge link you were sent still works without an account.');
  }
  const signInNote = msg => { if (!el.signInNote) return; el.signInNote.textContent = msg; el.signInNote.hidden = false; };
  function loadGis() {
    if (window.google?.accounts?.id) { renderGoogleButton(); return; }
    if (gisAsked) return;
    gisAsked = true;
    const sc = document.createElement('script');
    sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true; sc.defer = true;
    sc.onload = renderGoogleButton;
    sc.onerror = () => { gisAsked = false; signInNote('Google sign-in could not load. Check your connection and try again.'); };
    document.head.appendChild(sc);
  }
  function renderGoogleButton() {
    const box = el.googleBtn;
    if (!box || !window.google?.accounts?.id) return;
    box.innerHTML = '';
    try {
      google.accounts.id.initialize({ client_id: auth.providers.google, callback: onGoogleCredential, ux_mode: 'popup', auto_select: false });
      google.accounts.id.renderButton(box, { theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', width: 260 });
    } catch { signInNote('Google sign-in could not start. Please try again.'); }
  }
  /**
   * The app's sign-in button, drawn only where it can work.
   *
   * What comes back over the bridge is the same kind of ID token Google's own button produces in a browser —
   * minted for the web client, because that is what the app passes as its serverClientId — so it is handed to
   * exactly the same function, posted to exactly the same endpoint, and checked by a server that needed no
   * change to accept it.
   */
  function renderShellButton() {
    const box = el.googleBtn;
    if (!box) return;
    if (!shell.bridge()) {
      // An Android System WebView too old for web message listeners. Nothing to press.
      signInNote('Signing in is not in the app yet. Every board plays without an account, and the gold is waiting when it lands.');
      return;
    }
    box.innerHTML = '<button type="button" class="aa-btn aa-btn--primary aa-signin-app" id="aaShellGoogle">Continue with Google</button>';
    $('#aaShellGoogle', box)?.addEventListener('click', shellSignIn);
  }

  async function shellSignIn() {
    const btn = $('#aaShellGoogle');
    if (btn) { btn.disabled = true; btn.textContent = 'Asking Google…'; }
    if (el.signInNote) { el.signInNote.hidden = true; el.signInNote.textContent = ''; }
    let d;
    try { d = await shell.ask('signIn'); } catch { d = { ok: false, error: 'failed' }; }
    if (btn) { btn.disabled = false; btn.textContent = 'Continue with Google'; }
    if (d.ok && d.idToken) { await onGoogleCredential({ credential: d.idToken }); return; }
    // Cancelling is an answer, not a fault, and it gets no scolding.
    if (d.error === 'cancelled') return;
    if (d.detail) console.warn('Google sign-in through the app: ' + d.detail);
    // "No credentials available" is Google's answer both to a phone with no Google account and to a build
    // whose signing certificate is not an OAuth client in the Cloud project yet. A phone that does have an
    // account is in the second case, so the note carries the fingerprint the Cloud form asks for.
    if (d.cert) console.warn('This build is signed with SHA-1 ' + d.cert);
    if (d.error === 'unavailable') { signInNote('This phone cannot sign in with Google — it has no Play services.'); return; }
    // "No credentials available" is also what Google answers for a build it has not been told about, and
    // the browser does not care how the app is signed: sign in there and come back.
    await shellWebSignIn();
  }

  async function onGoogleCredential(res) {
    try {
      const d = await authApi('google', { credential: res?.credential || '' });
      await signedIn(d, 'google');
    } catch (e) {
      signInNote(e.code === 'google_not_configured' ? 'Google sign-in is not switched on yet.' : 'That sign-in did not go through. Please try again.');
    }
  }
  /** What happens once the server has said who this is, whichever way the token reached it. */
  async function signedIn(d, method) {
    auth.user = d.user || null;
    const fresh = !!d.user && d.gold_granted;
    closeSheets();
    renderAccountRow();
    if (auth.user) syncTour();   // a new phone gets the tour back here; a player who played signed out gives theirs up
    if (!auth.user) return;
    // A browser the app opened only to sign in hands the account back to the app now, and plays nothing.
    if (handoff.nonce) { await handoffFinish(); return; }
    // The socket, the invitations and the purse come up whichever way the sign-in came: straight from the
    // sheet, or from a challenge link that asked for it first. The link is kept in storage as well as in
    // memory, because the app's browser sign-in comes back as a fresh page.
    await authLoad(true);
    const pend = state.pendingCode || pendingLink();
    state.pendingCode = null; store.set('pendingCode', null);
    if (pend) openMatchLink(pend);
    else if (!resumeLive()) openStakes();
    toast(fresh ? `Welcome, ${auth.user.name}. ${Number(auth.user.gold || 0).toLocaleString('en-US')} gold to start you off.` : `Signed in as ${auth.user.name}`, 'good', fresh ? 5000 : 2800);
    if (typeof gtag === 'function') gtag('event', 'login', { method, game: 'puzzle' });
  }

  // ── Sign-in handed from the browser to the app ──
  //
  // Google will not sign a WebView in, and the native way (shellSignIn) only works for a build whose signing
  // certificate Google has been told about. When it fails, the app opens this same page in the phone's
  // browser with ?handoff=<nonce>; there Google's own button works, and once signed in the page asks the
  // server for a code and opens puzzle://signin?code=…, which is the app again. The app lands on
  // #handoff=<code> and trades code and nonce for a session of its own. The nonce is made here, kept here,
  // and never shown to anybody but the browser's address bar, so a code is worth nothing to anything else
  // that might answer the puzzle: scheme. The server keeps a code for five minutes and one use.
  const handoff = { nonce: '' };
  {
    const n = shell.on ? '' : new URLSearchParams(location.search).get('handoff') || '';
    if (/^[A-Za-z0-9_-]{16,64}$/.test(n)) handoff.nonce = n;
  }
  const handoffNonce = () => { const b = new Uint8Array(24); crypto.getRandomValues(b); return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  /** In the app, once its own way has failed: the browser, by itself -- there is no button for this. */
  async function shellWebSignIn() {
    const nonce = handoffNonce();
    store.set('handoffNonce', nonce);
    signInNote('Opening your browser to sign in there. You will be brought straight back.');
    const r = await shell.ask(`open ${location.origin}/puzzle/?handoff=${nonce}`, 8000);
    if (r?.ok) return;
    // An app from before this path has no `open`; the note says what to do. A newer one that could not
    // find a browser says that instead.
    signInNote(shell.caps.open ? 'No browser could be opened on this phone. Try again, or sign in at ariyankhan.com/puzzle.' : 'Update Puzzle from Google Play, then sign in again: this version of the app cannot open the browser for it.');
  }
  /** In the browser: signed in, so ask for the code and go back to the app. */
  async function handoffFinish() {
    let d;
    try { d = await authApi('handoff', { nonce: handoff.nonce }); }
    catch { toast('The app could not be signed in. Go back to it and try again.', 'bad', 5000); return; }
    const link = `puzzle://signin?code=${d.code}`;
    let box = $('#aaHandoff');
    if (!box) { box = document.createElement('div'); box.id = 'aaHandoff'; box.className = 'aa-gate'; document.body.appendChild(box); }
    box.innerHTML = `<div class="aa-gate-inner">
      <img class="aa-gate-art" src="/images/puzzle-brain-mark-rose.svg?v=1" alt="" width="220" height="220">
      <h2 class="aa-gate-title">Signed in</h2>
      <p class="aa-gate-text">You are <b>${escapeHtml(auth.user?.name || '')}</b>. Go back to the Puzzle app to play.</p>
      <a class="aa-btn aa-gate-accept" href="${link}">Back to the app</a>
    </div>`;
    box.hidden = false;
    // Chrome follows a link to another app on its own only close after a tap; the button is there for when
    // it does not, and for a browser that asks first.
    setTimeout(() => { try { location.href = link; } catch { /* the button */ } }, 300);
  }
  /** In the app, arrived from the browser: #handoff=<code> is traded for a session. */
  async function handoffRedeem(code) {
    history.replaceState(null, '', location.pathname + location.search);
    const nonce = store.get('handoffNonce', '');
    if (!nonce) { toast('That sign-in link was not made by this app. Tap Sign in and try again.', 'hint', 5000); return; }
    try {
      const d = await authApi('redeem', { code, nonce });
      store.set('handoffNonce', '');
      await signedIn(d, 'handoff');
    } catch (e) {
      toast(e.code === 'bad_code' ? 'That sign-in link has expired. Tap Sign in and try again.' : 'That sign-in did not go through. Please try again.', 'bad', 5000);
    }
  }
  function handoffHash() {
    if (!shell.on) return;
    const m = /^#handoff=([a-f0-9]{64})$/.exec(location.hash);
    if (m) void handoffRedeem(m[1]);
  }
  window.addEventListener('hashchange', handoffHash);
  // ── The tour, kept by the account rather than by this phone ──
  //
  // Everything a player has cleared used to live in this browser and nowhere else: sign in on a new phone and
  // the gold came across while the tour started again at level 1. It now syncs, and the rule that makes that
  // safe is the server's: every field only improves, so whichever order two devices happen to sync in, neither
  // can undo the other. Which means this side never has to be clever — it pushes what it has, takes back the
  // merged answer, and applies it.
  //
  // None of it is ever in the way of playing. A push that fails costs freshness, not progress: the record is
  // already in local storage and goes up with the next sync.
  const progressApi = body => apiCall(`${API_V1}/progress`, body);

  const STATE_SEND_DAYS = 120;   // days of daily boards and training each push carries (the server's STATE_SEND_DAYS)
  const STATE_FULL_DAYS = 400;   // and a push after a long gap: well inside the server's 128 KB
  const STATE_KEYS = ['home', 'form', 'dailyStreak', 'playStreak'];   // what a new device needs before it can show the right tour

  /** Everything this device has played, in the shape the server stores. */
  function localTour() {
    const levels = {};
    const touch = id => (levels[id] ||= { cleared: false, skipped: false });
    try {
      for (const k of Object.keys(localStorage)) {
        if (!k.startsWith(STORE)) continue;
        const key = k.slice(STORE.length);
        if (key.startsWith('lv:')) {
          const r = store.get(key); if (!r || isLocalOnly(key.slice(3))) continue;
          const e = touch(key.slice(3));
          e.cleared = true;
          e.ms = typeof r.t === 'number' ? r.t : null;
          e.stars = r.stars || 0; e.quiz = !!r.quiz; e.tier = r.tier || 0; e.arrows = r.arrows || 0;
        } else if (key.startsWith('skip:')) {
          if (store.get(key) && !isLocalOnly(key.slice(5))) touch(key.slice(5)).skipped = true;
        }
      }
    } catch { /* storage can be unreadable in a private window; syncing is optional, playing is not */ }
    return levels;
  }
  function localState(allDays = false) {
    const out = {};
    for (const k of STATE_KEYS) { const v = store.get(k, null); if (v !== null && v !== undefined) out[k] = v; }
    // A home country this device guessed from the connection is not the player's answer, so it stays here.
    // Only a home they picked in Settings is worth telling the account about.
    if (store.get('homeAuto', false)) delete out.home;
    const loss = lossMap(); if (Object.keys(loss).length) out.loss = loss;
    // the daily boards and the training of the last STATE_SEND_DAYS days: the account keeps the older ones, and a
    // push that carried every day ever played would grow by a few hundred bytes a day, every five minutes. A push
    // after a long gap (see syncTour) carries STATE_FULL_DAYS, so what a device played while its pushes were
    // failing, or while it was signed out, reaches the account even if it is older than that
    const since = dayKeyBack(allDays ? STATE_FULL_DAYS : STATE_SEND_DAYS);
    const days = prefix => {
      const m = {};
      try {
        for (const k of Object.keys(localStorage)) {
          if (!k.startsWith(STORE + prefix)) continue;
          const key = k.slice(STORE.length), day = key.slice(prefix.length); if (day < since) continue;
          const v = store.get(key); if (v) m[day] = v;
        }
      } catch { /* as above */ }
      return m;
    };
    const daily = days('daily:'); if (Object.keys(daily).length) out.daily = daily;
    const trainDays = days('train:'); if (Object.keys(trainDays).length) out.train = trainDays;
    return out;
  }
  // Two devices' streaks as one, the rule the server applies too (mergeStreak in progress.ts): a streak is a run
  // of `count` days ending on `last`; two runs that overlap or meet are one run from the earlier start to the
  // later end, and with a gap between them the later run is the streak. A day after this device's today is a
  // clock that runs ahead (a phone set to tomorrow to peek at the next daily board), not a day played here: it is
  // neither kept nor adopted, or its lone day would win the merge and end a long run on every device. The
  // honest device's next push joins it on the account once the calendar gets there.
  const dayNo = day => { const [y, m, d] = day.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 864e5); };
  const okStreak = v => v && typeof v === 'object' && typeof v.last === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.last) && v.last <= dayKey()
    && Number.isFinite(Number(v.count)) && Number(v.count) >= 1;
  function mergeStreak(a, b) {
    const A = okStreak(a) ? { count: Math.floor(Number(a.count)), last: a.last } : null, B = okStreak(b) ? { count: Math.floor(Number(b.count)), last: b.last } : null;
    if (!A || !B) return A || B;
    const ea = dayNo(A.last), eb = dayNo(B.last);
    const [later, le, earlier, ee] = ea >= eb ? [A, ea, B, eb] : [B, eb, A, ea];
    const ls = le - later.count + 1, es = ee - earlier.count + 1;
    return { count: ee >= ls - 1 ? le - Math.min(ls, es) + 1 : later.count, last: later.last };
  }

  // The same rule the server applies, applied here too — not for the server's benefit but for the race: a board
  // cleared while the request was in the air must not be undone by an answer that predates it.
  const betterRun = (a, b) => !b ? true : (a.stars || 0) !== (b.stars || 0) ? (a.stars || 0) > (b.stars || 0)
    : typeof a.t === 'number' && typeof b.t === 'number' ? a.t < b.t : typeof a.t === 'number';

  function adoptTour(server, sent = null) {
    let changed = false;
    for (const [id, r] of Object.entries(server?.levels || {})) {
      if (r.cleared) {
        const next = { t: r.ms ?? 0, stars: r.stars || 0, quiz: !!r.quiz, tier: r.tier || 0, arrows: r.arrows || 0, at: r.at || Date.now() };
        if (betterRun(next, store.get('lv:' + id))) { store.set('lv:' + id, next); changed = true; }
      }
      if (r.skipped && !store.get('skip:' + id)) { store.set('skip:' + id, true); changed = true; }
    }
    const st = server?.state || {};
    for (const k of STATE_KEYS) {
      if (st[k] === undefined) continue;
      // a streak is joined with this device's own rather than replaced by the account's: a board cleared here
      // while the push was in the air must not be taken back by an answer that predates it
      // a setting changed here while the push was in the air (the ladder moved, a home picked) is newer than the
      // answer: it stays, and the next push says it
      if (sent && k !== 'playStreak' && k !== 'dailyStreak' && JSON.stringify(store.get(k, null)) !== JSON.stringify(sent[k] ?? null)) continue;
      const v = k === 'playStreak' || k === 'dailyStreak' ? mergeStreak(store.get(k, null), st[k]) : st[k];
      if (v != null && JSON.stringify(v) !== JSON.stringify(store.get(k, null))) { store.set(k, v); changed = true; }
    }
    if (st.home !== undefined) store.set('homeAuto', false);   // the account's home is a choice, however this device came by its own
    // What each device took off the rank, merged by the larger per device: a device's own count only grows.
    if (st.loss && typeof st.loss === 'object' && !Array.isArray(st.loss)) {
      const mine = lossMap(); let grew = false;
      for (const [dev, v] of Object.entries(st.loss)) { const n = Number(v) > 0 ? Math.floor(Number(v)) : 0; if (n > (Number(mine[dev]) || 0)) { mine[dev] = n; grew = true; } }
      if (grew) { store.set('loss', mine); changed = true; }
    }
    // a daily board: the better run of the two, as the account keeps it
    for (const [day, rec] of Object.entries(st.daily || {})) if (rec && typeof rec === 'object' && typeof rec.t === 'number' && betterRun(rec, store.get('daily:' + day))) { store.set('daily:' + day, rec); changed = true; }
    // training days merge by the better score per round: a round played on two devices keeps the best of both
    for (const [day, rec] of Object.entries(st.train || {})) {
      if (!rec || typeof rec !== 'object') continue;
      const mine = trainDay(day); let grew = false;
      for (const r of TRAIN_ROUNDS) { const v = Number(rec[r.id]), have = typeof mine[r.id] === 'number' ? mine[r.id] : -1; if (typeof rec[r.id] === 'number' && Number.isFinite(v) && clamp100(v) > have) { mine[r.id] = clamp100(v); grew = true; } }
      // hints used and rounds played: the larger, so a second device gets no second free round or hint
      for (const k of ['h', 'p']) { const v = Math.floor(Number(rec[k])); if (v > 0 && v > (mine[k] | 0)) { mine[k] = v; grew = true; } }
      if (rec.pp && typeof rec.pp === 'object') for (const r of TRAIN_ROUNDS) { const v = Math.floor(Number(rec.pp[r.id])); if (v > 0 && v > ((mine.pp && mine.pp[r.id]) | 0)) { mine.pp = mine.pp || {}; mine.pp[r.id] = v; grew = true; } }
      if (rec.nx && typeof rec.nx === 'object') for (const r of TRAIN_ROUNDS) { const v = Math.floor(Number(rec.nx[r.id])); if (v > 0 && v > ((mine.nx && mine.nx[r.id]) | 0)) { mine.nx = mine.nx || {}; mine.nx[r.id] = v; grew = true; } }
      // the puzzles finished, each with the first time it was: every one is a level, on every device
      if (rec.cl && typeof rec.cl === 'object') for (const r of TRAIN_ROUNDS) {
        const theirs = rec.cl[r.id]; if (!theirs || typeof theirs !== 'object') continue;
        for (const [x, at] of Object.entries(theirs)) {
          const v = Number(at); if (!/^\d{1,4}$/.test(x) || !(v > 0)) continue;
          mine.cl = mine.cl && typeof mine.cl === 'object' ? mine.cl : {};
          const m = mine.cl[r.id] && typeof mine.cl[r.id] === 'object' ? mine.cl[r.id] : (mine.cl[r.id] = {});
          if (!(Number(m[x]) > 0) || v < Number(m[x])) { m[x] = v; grew = true; }
        }
      }
      if (grew) { store.set(trainKey(day), mine); changed = true; }
    }
    if (!changed) return false;
    // The home country may have moved, which reorders the whole tour, so rebuild it rather than only repainting.
    DATA.levels = tourFor(DATA, store.get('home', null));
    maskCache.clear(); forgetNums();
    if (!el.select.hidden) renderSelect();
    return true;
  }

  let syncing = null, syncedAt = 0, syncOwed = false;
  /** Push what this device has, adopt what comes back. Safe to call as often as it is useful to. */
  function syncTour(levels) {
    if (!auth.user) return Promise.resolve(false);
    if (syncing) return syncing;
    // A push that could not be made -- the phone was offline when the board was cleared -- is owed, and the
    // next chance (the network back, the app back on screen) pushes the whole tour rather than that one board.
    // the long history whenever the account may be missing some of it: the first push since the sync was mended,
    // and any push after a gap longer than the usual window (signed out for months, a stretch of failed pushes)
    const okAt = Number(store.get('stateOkAt', 0)) || 0, full = Date.now() - okAt > (STATE_SEND_DAYS - 14) * 864e5;
    const body = levels && !syncOwed ? { levels, state: localState(full) } : { levels: localTour(), state: localState(full) };
    body.stats = localStats(); body.device = DEVICE;
    const sent = Object.fromEntries(STATE_KEYS.map(k => [k, store.get(k, null)]));
    syncing = progressApi(body)
      .then(d => { syncedAt = Date.now(); syncOwed = false; store.set('stateOkAt', Date.now()); return adoptTour(d, sent); })
      .catch(() => { syncOwed = true; return false; })
      .finally(() => { syncing = null; });
    return syncing;
  }
  /**
   * The tour used to sync at sign-in and after each clear, and at no other time -- so a phone left open for
   * days never saw what the tablet had cleared, and a board cleared on the train was pushed only when the app
   * was next started. Now it also syncs when the network comes back, whenever the game comes back on screen
   * (at most once a minute), and every few minutes while it is looked at; each of those pulls as well as
   * pushes, which is how the other device's progress arrives.
   */
  function syncIfStale(minMs = 60_000) { if (auth.user && (syncOwed || Date.now() - syncedAt > minMs)) void syncTour(); }
  window.addEventListener('online', () => { syncOwed = true; syncIfStale(0); });
  setInterval(() => { if (!document.hidden) syncIfStale(5 * 60_000); }, 60_000);
  /** One board, the moment it is cleared. The full sync would do the same thing, more slowly and less often. */
  function pushOne(id, rec) {
    if (!auth.user || !id || isLocalOnly(id)) return;
    syncTour({ [id]: { cleared: true, ms: rec.t ?? null, stars: rec.stars || 0, quiz: !!rec.quiz, tier: rec.tier || 0, arrows: rec.arrows || 0 } });
  }

  // ── Notifications ──
  //
  // Two things in this game happen to somebody who is not looking at it: a friend asks them to a match, and
  // the league pays out on Sunday night. Both are worth an interruption — the room the invitation is about
  // will be gone in minutes, and the gold is real. Nothing else in the game is, and nothing else is sent.
  //
  // It is off until it is asked for. The switch appears only for a signed-in player on a browser that can do
  // this and a server that has keys, because a notification has to be addressed to an account, and a switch
  // that cannot do anything is worse than no switch. The permission prompt is only ever raised by that switch
  // being turned on: a game that asks for notifications on the way in is a game people close.
  const push = { key: '', on: false, busy: false, checked: false, asked: false, app: false, granted: true, blocked: false, posted: '' };
  // isSecureContext rather than a list of protocols: it is the browser's own answer to the same question, and
  // it already knows that https, localhost and 127.0.0.1 all count and that a file:// page does not.
  // The shell is named here rather than left to the feature tests below it. A WebView reports no
  // PushManager today and the switch would hide itself on that alone, but "today" is the wrong thing to
  // rest on: a WebView that one day exposes the constructor without a push service behind it would show a
  // switch that subscribes and never delivers, which is the failure this whole block is written to avoid.
  const pushable = () => !shell.on && window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  // The app is the other way in. A WebView has no Push API; what a phone has is Firebase Cloud Messaging, and
  // the app minds the registration token FCM hands it and passes it over the bridge (pushState, pushOn,
  // pushOff). The page posts that token to the same account a browser's subscription goes to, and the player
  // sees one switch that means the same thing in both places.
  const appPush = () => shell.on && !!shell.bridge();
  // Where this device is, so the evening nudge comes at seven here and not at seven somewhere else.
  const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } })();
  const pushApi = (path, body) => apiCall(`${API_V1}/push/${path}`, body);
  // The server hands out its public key base64url; the browser wants the raw bytes.
  const urlB64ToBytes = b64 => {
    const pad = '='.repeat((4 - b64.length % 4) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  };
  // `serviceWorker.ready` waits for a registration that may never come — a page whose worker failed to
  // register, or a browser that quietly refused one — and a switch waiting on it would sit disabled for the
  // rest of the session with nothing to show for it. Eight seconds, then it says so instead.
  const swReady = () => Promise.race([
    navigator.serviceWorker.ready,
    new Promise(resolve => setTimeout(() => resolve(null), 8000)),
  ]);
  const pushSub = async () => { const reg = await swReady(); return reg ? reg.pushManager.getSubscription() : null; };

  function renderNotify() {
    if (!el.btnNotify) return;
    const app = appPush();
    const show = push.checked && (app ? push.app : (!!push.key && pushable()));
    if (el.notifyCap) el.notifyCap.hidden = !show;
    if (el.notifyGroup) el.notifyGroup.hidden = !show;
    if (!show) return;
    el.btnNotify.setAttribute('aria-checked', String(push.on));
    el.btnNotify.disabled = push.busy;
    // The evening nudge has a switch of its own, shown only once notifications are on at all: it is the one
    // thing a player may decline while keeping the invitations and the league they turned the first on for.
    if (el.remindRow) el.remindRow.hidden = !push.on;
    if (el.btnRemind) { el.btnRemind.setAttribute('aria-checked', String(remindOn())); el.btnRemind.disabled = !!push.remindBusy; }
    // The one state a switch cannot get itself out of: the browser, or the phone, has been told no, and only
    // its own settings can change that. Saying so is the difference between a broken switch and a closed door.
    // Notification is the browser's global and a WebView need not have it, so in the app the app is asked.
    const blocked = app ? push.blocked : Notification.permission === 'denied';
    if (el.notifyNote) el.notifyNote.textContent = blocked
      ? (app ? 'Blocked for Puzzle in your phone\u2019s settings.' : 'Blocked in this browser — turn it back on in the site settings.')
      : push.on ? (app ? 'On for this phone.' : 'On for this device.')
      : auth.user ? 'Only when somebody invites you, and when the league pays out.' : 'A nudge at 7 pm. Signed in, an invite and the league too.';
  }
  // The nudge's switch: the account's answer when there is one, this device's own when there is not. A device
  // with no account keeps it here and sends it with its token or subscription, and the server keeps it on
  // that device's row.
  const remindOn = () => auth.user ? auth.user.reminder !== false : store.get('remind', true) !== false;

  /**
   * What this device already has. Called when the account is known and again whenever Settings is opened,
   * because the first call may well have happened before anybody was signed in — and a switch that decided it
   * was unavailable while the page was still signing in would stay hidden for the rest of the session.
   */
  async function notifyInit() {
    if (!el.btnNotify) return;
    push.checked = true;
    if (appPush()) { await notifyInitApp(); return; }
    if (!pushable()) { renderNotify(); return; }
    if (!push.asked) {
      push.asked = true;
      // A failed ask is not an answer: it is asked again next time rather than left looking unavailable.
      try { const d = await pushApi('key'); push.key = d.enabled ? (d.key || '') : ''; }
      catch { push.key = ''; push.asked = false; }
    }
    if (push.key) push.on = !!(await pushSub().catch(() => null));
    renderNotify();
  }

  /**
   * The app's side of the same question. The server is asked once whether phones can be reached at all -- a
   * deploy with no Firebase key has no switch to offer, the way one with no VAPID keys has none for browsers
   * -- and the app is asked what this phone already has. A phone with the switch on posts its token again on
   * every open: the row follows whoever is signed in, and a token Firebase rotated while the game was closed
   * replaces the one the server was still addressing.
   */
  async function notifyInitApp() {
    // Signed out too: the evening nudge needs no account (the token is posted with none), and the phone's
    // own permission is asked on the first open, whoever is signed in. Whether phones can be reached at all is
    // the one thing the server is asked first.
    if (!push.asked) {
      push.asked = true;
      try { const d = await pushApi('key'); push.app = !!d.app; }
      catch { push.app = false; push.asked = false; }
    }
    if (!push.app) { renderNotify(); return; }
    const s = await shell.ask('pushState', 4000);
    if (!s?.ok || !s.available) { push.app = false; renderNotify(); return; }
    push.granted = s.granted !== false;
    push.on = !!s.on && !!s.token;
    push.blocked = push.on && s.enabled === false;
    if (push.on && s.token !== push.posted) {
      try { await pushApi('token', { token: s.token, tz: TZ, reminder: remindOn() }); push.posted = s.token; }
      catch (err) { if (err.code === 'push_off') push.app = false; }
    }
    renderNotify();
    void notifyFirstAsk();
  }

  /**
   * The first time the app is opened, the phone is asked for notifications straight away -- before anything
   * else, the way apps do: its own dialog, once, and not again; what the phone answers is its answer, and
   * the switch in Settings stays for changing it. Only in the app: a browser asked on a first visit is a
   * browser that says no for good.
   */
  async function notifyFirstAsk() {
    if (!appPush() || store.get('pushAsked') || !store.get('welcomed')) return;   // after Accept, not under it
    if (!push.checked) { await notifyInit(); if (store.get('pushAsked')) return; }
    // Not granted yet is the whole point of asking: on Android 13 and up a permission never asked for reads
    // as not granted, the same as one refused. A refusal from an earlier install comes straight back from
    // the phone, without a dialog, and the switch in Settings is still there.
    if (!push.app || push.on) return;
    store.set('pushAsked', Date.now());
    try {
      const r = await shell.ask('pushOn', 120000);
      if (!r?.ok || !r.token) { if (r?.error === 'denied') push.granted = false; renderNotify(); return; }
      push.granted = true;
      await pushApi('token', { token: r.token, tz: TZ, reminder: remindOn() });
      push.on = true; push.blocked = false; push.posted = r.token;
    } catch { /* asked and not answered: the switch in Settings is still there */ }
    renderNotify();
  }

  /** The phone lets its token go, and so does the row that would have been sent to. Never throws. */
  async function dropAppToken() {
    try {
      const r = await shell.ask('pushOff', 8000);
      if (r?.token) await pushApi('token/drop', { token: r.token }).catch(() => {});
    } catch { /* an app with no bridge has nothing to drop */ }
    push.on = false; push.posted = '';
  }

  async function notifyToggleApp() {
    if (push.busy || !push.app) return;
    push.busy = true; renderNotify();
    try {
      if (push.on) {
        // Off means off on this phone: the app lets its token go, and so does the row that would have been
        // sent to.
        await dropAppToken();
        push.blocked = false;
        toast('Notifications off on this phone.', 'hint');
      } else {
        // Straight to the phone's own dialog: the switch is the question, and a card before it was one too many.
        const r = await shell.ask('pushOn', 120000);
        if (!r?.ok || !r.token) {
          if (r?.error === 'denied') { push.granted = false; toast('Notifications are blocked for Puzzle in your phone\u2019s settings.', 'hint'); }
          else if (r?.error === 'unavailable') { push.app = false; toast('This build of the app cannot receive notifications.', 'bad'); }
          else toast(`Could not turn notifications on (${r?.error || 'failed'}).`, 'bad');
          return;
        }
        push.granted = true;
        await pushApi('token', { token: r.token, tz: TZ, reminder: remindOn() });
        push.on = true; push.blocked = false; push.posted = r.token;
        toast('Notifications on. Only an invite, and the league.', 'good');
      }
    } catch (err) {
      const why = typeof err.code === 'string' ? err.code : (err.name || err.message || 'failed');
      if (why === 'push_off') push.app = false;
      toast(`Could not change notifications (${why}).`, 'bad');
    } finally {
      push.busy = false; renderNotify();
    }
  }

  async function notifyToggle() {
    if (appPush()) { await notifyToggleApp(); return; }
    if (push.busy || !push.key) return;
    push.busy = true; renderNotify();
    try {
      const reg = await swReady();
      if (!reg) { toast('This browser has not started the game\u2019s service worker, so it cannot receive notifications.', 'bad'); return; }
      const had = await reg.pushManager.getSubscription();
      if (push.on || had) {
        // Off means off on this device: the browser's subscription goes, and so does the row that would have
        // been sent to. A device nobody unsubscribed from is a notification nobody can stop.
        if (had) { await pushApi('unsubscribe', { endpoint: had.endpoint }).catch(() => {}); await had.unsubscribe().catch(() => {}); }
        push.on = false;
        toast('Notifications off on this device.', 'hint');
      } else {
        // Say what this is for before the browser asks. Its own dialog is a system one -- it names the origin
        // rather than the game, it cannot be restyled or reworded, and there is no version of it that says
        // "Puzzle". What it can be given is context, so the player is not reading "ariyankhan.com wants to
        // send you notifications" cold and guessing what for.
        //
        // The second reason matters more. That dialog is a single shot: tap Block and web push is off for
        // this origin until the player digs into browser settings to undo it, and nothing in the game can
        // ask again. Anyone who is not sure should be able to say no here, where no costs nothing.
        // Straight to the browser's own dialog: the switch is the question, and a card before it was one too many.
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') { push.on = false; renderNotify(); toast(permission === 'denied' ? 'Your browser is blocking notifications for this site.' : 'Notifications stay off.', 'hint'); return; }
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(push.key) });
        const json = sub.toJSON();
        await pushApi('subscribe', { endpoint: json.endpoint, keys: json.keys, tz: TZ, reminder: remindOn() });
        push.on = true;
        toast('Notifications on. Only an invite, and the league.', 'good');
      }
    } catch (err) {
      push.on = !!(await pushSub().catch(() => null));
      // The server's own words when it has them ('push_off'), the browser's when it does not ('AbortError',
      // which is what a browser with no push service of its own says), and never a bare number.
      const why = typeof err.code === 'string' ? err.code : (err.name || err.message || 'failed');
      toast(`Could not change notifications (${why}).`, 'bad');
    } finally {
      push.busy = false; renderNotify();
    }
  }
  el.btnNotify?.addEventListener('click', notifyToggle);

  async function remindToggle() {
    if (push.remindBusy) return;
    const on = !remindOn();
    push.remindBusy = true; renderNotify();
    try {
      // With no account the switch is this device's row, named by what only this device holds.
      const who = auth.user ? {} : appPush() ? { token: push.posted } : { endpoint: (await pushSub().catch(() => null))?.endpoint || '' };
      const d = await pushApi('reminder', { on, ...who });
      if (auth.user) auth.user.reminder = d.reminder !== false; else store.set('remind', d.reminder !== false);
      toast(remindOn() ? 'A nudge at 7 pm, once a day, in your own time.' : (auth.user ? 'No daily nudge. Invites and the league still come.' : 'No daily nudge.'), 'hint');
    } catch (err) {
      toast(`Could not change that (${typeof err.code === 'string' ? err.code : 'failed'}).`, 'bad');
    } finally {
      push.remindBusy = false; renderNotify();
    }
  }
  el.btnRemind?.addEventListener('click', remindToggle);

  /** Give up this device's subscription, quietly. Used when the account leaves the browser. */
  async function notifyDrop() {
    if (appPush()) {
      // The phone's token goes with the account the way a browser's subscription does: off is off, and
      // whoever signs in next turns it on for themselves.
      await dropAppToken();
      return;
    }
    if (!pushable()) return;
    try {
      const sub = await pushSub();
      if (!sub) { push.on = false; return; }
      await pushApi('unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    } catch { /* a browser that will not say is a browser with nothing to unsubscribe */ }
    push.on = false;
  }
  /**
   * Signing out, the device keeps its notifications as its own: the token or subscription is posted again
   * with no account behind it, so the evening nudge still comes, and the invitations and the league -- which
   * need an account -- stop by themselves. Called once the sign-out has gone through.
   */
  async function notifyRelease() {
    try {
      if (appPush()) {
        const s = await shell.ask('pushState', 4000);
        if (s?.ok && s.on && s.token) { await pushApi('token', { token: s.token, tz: TZ, reminder: remindOn() }); push.posted = s.token; }
        return;
      }
      if (!pushable()) return;
      const sub = await pushSub();
      if (!sub) return;
      const json = sub.toJSON();
      await pushApi('subscribe', { endpoint: json.endpoint, keys: json.keys, tz: TZ, reminder: remindOn() });
    } catch { /* a device that cannot be re-posted is one the nudge will miss; nothing else changes */ }
  }

  // ── Gold matches: stake, invite, play the same board, and the board pays its places ──
  // The server holds both stakes, picks the board and decides the winner; the game only shows what it says.
  //
  // The tables are the server's list, not this file's: it is the server that refuses a stake it does not
  // recognise, so a client holding an older list would offer a table nobody can sit at. This is the list to
  // draw with until the lobby answers, and it is replaced by whatever comes back.
  let STAKES = [500, 1000, 10000, 1000000, 10000000];
  const gfmt = n => Number(n || 0).toLocaleString('en-US');
  // A table is called 10K, not 10,000: on a row of five buttons the digits are what makes them hard to tell apart.
  const gtiny = n => {
    const v = Math.abs(Number(n) || 0);
    if (v >= 1e6) return `${+(v / 1e6).toFixed(v % 1e6 ? 1 : 0)}M`;
    if (v >= 1000) return `${+(v / 1000).toFixed(v % 1000 ? 1 : 0)}K`;
    return gfmt(v);
  };
  // How a purse is written. "1,000,004,500" is twelve characters of arithmetic nobody does: what a player wants
  // from their own gold is its size, and from somebody else's, whether it is bigger than theirs. So 1B, 12.4M,
  // 340K — short enough to be set in type you can actually read, and the exact figure rides in the title for
  // anyone who wants to count it. The letters are capitals because that is how a game writes them, and
  // because a small m is milli: a thousandth, the opposite of what a purse is saying.
  const gpurse = n => {
    const v = Number(n) || 0, a = Math.abs(v), sign = v < 0 ? '-' : '';
    const cut = (div, unit) => {
      const x = a / div;
      return `${sign}${+(x < 10 ? x.toFixed(2) : x < 100 ? x.toFixed(1) : x.toFixed(0))}${unit}`;
    };
    if (a >= 1e9) return cut(1e9, 'B');
    if (a >= 1e6) return cut(1e6, 'M');
    if (a >= 1000) return cut(1000, 'K');
    return `${sign}${gfmt(a)}`;
  };
  // The old service took an action in the query string; the new one has a path per action. The call sites keep
  // the shape they had — matchApi('join', { code }) — and this turns it into the right request.
  function matchUrl(a, body, query) {
    const code = String(body?.code || new URLSearchParams(query.replace(/^&/, '')).get('code') || '').toUpperCase();
    switch (a) {
      case 'lobby':    return { url: `${API_V1}/lobby`, method: 'GET' };
      case 'get':      return { url: `${API_V1}/matches/${encodeURIComponent(code)}`, method: 'GET' };
      case 'create':   return { url: `${API_V1}/matches`, method: 'POST' };
      case 'cancel':   return { url: `${API_V1}/matches/${encodeURIComponent(code)}/leave`, method: 'POST' };
      default:         return { url: `${API_V1}/matches/${encodeURIComponent(code)}/${a}`, method: 'POST' };
    }
  }
  const matchApi = (a, body, query = '') => {
    const { url, method } = matchUrl(a, body, query);
    return apiCall(url, body, method, d => ({ gold: d.gold, matchCode: d.match_code, retryAfter: d.retry_after }));
  };
  // ── The live socket ──
  //
  // One socket, opened when there is a room to watch and closed when there is not. Everything it carries is
  // something the server decided: who joined, how far along everyone is, the countdown, the start, the finish.
  // Nothing about gold travels over it — a stake, a result and a payout are REST calls, because those have to
  // survive a dropped connection and be safe to send twice.
  //
  // It is a speed-up, never a dependency. If the socket cannot open, or drops and cannot get back, the game
  // falls back to asking over REST on the timer it always used, and the player notices nothing but latency.
  const live = {
    ws: null, code: null, tries: 0, retry: 0, onEvent: null, onTune: null, onInvite: null,
    // The socket used to exist only while a room was being watched, which made "online" mean "in a match" and
    // left a player in the lobby unreachable. It is held open for as long as somebody is signed in now: that
    // is what tells the server they are about, and it is how an invitation reaches them.
    hold: false,
    get connected() { return this.ws && this.ws.readyState === 1; },

    keep() { this.hold = true; this.tries = 0; this.open(); },
    /** Stop watching a room without giving up the socket: the lobby still wants it. */
    leaveFeed() { this.code = null; this.onEvent = null; this.send({ type: 'leave_feed' }); },

    watch(code, onEvent) {
      this.code = code; this.onEvent = onEvent;
      if (this.connected) { this.send({ type: 'watch', code }); return; }
      this.open();
    },

    open() {
      if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
      if (!auth.user) return;                       // the socket is for people playing together; it needs a session
      let ws;
      try { ws = new WebSocket(WS_URL); } catch { this.fallback(); return; }
      this.ws = ws;
      ws.onopen = () => {
        this.tries = 0;
        if (document.hidden) this.away(true);   // opened from the background: say so before an invitation is judged deliverable
        if (this.code) this.send({ type: 'watch', code: this.code });
        this.onTune?.();
      };
      ws.onmessage = e => {
        let ev; try { ev = JSON.parse(e.data); } catch { return; }
        if (ev.type === 'hello') return;
        // An invitation is addressed to the player, not to whatever room they happen to be watching, so it is
        // handled apart from the room feed and reaches them anywhere in the game.
        if (ev.type === 'invited') { this.onInvite?.(ev); return; }
        this.onEvent?.(ev);
      };
      ws.onclose = () => { this.ws = null; this.onTune?.(); this.fallback(); };
      ws.onerror = () => { /* onclose follows, and does the work */ };
    },

    // Back off and try again, but only while there is still something to watch, and give up after a few goes:
    // a player on a network that blocks WebSockets should not spend their match reconnecting.
    fallback() {
      clearTimeout(this.retry);
      // A room's socket gives up after four tries (the poll carries the room); the lobby's, held open for
      // invitations, keeps trying at a slower and slower pace -- a deploy or a tunnel must not leave a player
      // unreachable for the rest of the session.
      if (!this.code && !this.hold) return;
      if (this.code && this.tries >= 4) return;
      const wait = Math.min(this.hold && !this.code ? 30000 : 8000, 500 * 2 ** Math.min(this.tries++, 8));
      this.retry = setTimeout(() => this.open(), wait);
    },

    send(o) { if (this.connected) { try { this.ws.send(JSON.stringify(o)); } catch { /* the close handler tidies up */ } } },
    progress(pct, run) { this.send(run ? { type: 'progress', pct, run } : { type: 'progress', pct }); },
    resync() { this.send({ type: 'resync' }); },
    away(hidden) { this.send({ type: 'away', hidden: !!hidden }); },

    close() {
      clearTimeout(this.retry);
      this.code = null; this.onEvent = null; this.hold = false; this.tries = 0;
      const ws = this.ws; this.ws = null;
      if (ws) { try { ws.close(); } catch { /* already gone */ } }
    },
  };
  // While the socket is healthy the REST poll drops to a slow safety net; without it, it carries the game.
  const POLL_LIVE_MS = 15000, POLL_REST_MS = 2000;
  const pollEvery = () => (live.connected ? POLL_LIVE_MS : POLL_REST_MS);

  const matchLink = code => `${location.origin}${location.pathname}#m=${code}`;
  const setGold = g => { if (auth.user && typeof g === 'number') auth.user.gold = g; renderAccountRow(); renderPurse(); };

  // A player's face: the picture Google gave them, or their initial on a colour of their own. Two players whose
  // names start with the same letter have to look different at a glance, or the line-up says nothing.
  const FACE_COLOURS = 8;
  const faceHue = name => { let h = 0; const n = name || '?'; for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0; return h % FACE_COLOURS; };
  const initial = name => escapeHtml((name || '?').trim().charAt(0).toUpperCase() || '?');
  // the picture comes from what the server stored, and the server only ever stores one on Google's own host
  const faceInner = p => (p && p.pic)
    ? `<img class="aa-face-img" src="${escapeHtml(p.pic)}" alt="" referrerpolicy="no-referrer" loading="lazy"><span class="aa-face-let" aria-hidden="true">${initial(p.name)}</span>`
    : `<span class="aa-face-let" aria-hidden="true">${initial(p && p.name)}</span>`;
  const faceClass = p => ` is-c${faceHue(p && p.name)}${p && p.pic ? ' has-pic' : ''}`;
  // a picture that will not load (Google links do expire) drops back to the letter underneath it
  function wireFaces(root) {
    $$('.aa-face-img', root || document).forEach(img => {
      if (img.dataset.wired) return;
      img.dataset.wired = '1';
      img.addEventListener('error', () => { img.closest('.aa-rank, .aa-me-face, .aa-row-face')?.classList.remove('has-pic'); img.remove(); });
    });
  }

  // The player's own strip, kept at the top of every match screen: their face, their name, and their purse
  // directly under it. It used to read "Signed in with Google" — which the player knew, and which sat between
  // the two things they came to look at while the purse drifted off to the far edge of the row.
  function meStrip() {
    const u = auth.user;
    if (!u) return '';
    return `<div class="aa-me">
      <span class="aa-me-face${faceClass(u)}">${faceInner(u)}</span>
      <span class="aa-me-id">
        <span class="aa-me-name">${escapeHtml(u.name || 'Player')}</span>
        <span class="aa-gold" title="${gfmt(u.gold)} gold">${COIN}${gpurse(u.gold)}</span>
      </span>
    </div>`;
  }

  // ── The people you play with ──
  //
  // Sharing a link works and is staying, but it was the only way to bring somebody in: open the share sheet,
  // pick an app, paste, wait for them to notice. The game already knows who you have played with — every seat
  // ever taken is in the match table — so these are those people, most recent first, with whether they are
  // about, and an Invite that reaches them inside the game.
  //
  // There is no friends list behind it: nothing to accept, nothing to manage, and the only way onto somebody's
  // list is to have played with them, which is also the rule the server enforces on who may be invited.
  const recent = { at: 0, list: [], asked: false };
  async function loadRecent(force) {
    if (!auth.user) return [];
    if (!force && recent.asked && Date.now() - recent.at < 20000) return recent.list;
    try {
      const d = await fetch(`${API_V1}/players/recent`, { credentials: 'include', cache: 'no-store' }).then(r => r.json());
      recent.list = Array.isArray(d.players) ? d.players : [];
      recent.at = Date.now(); recent.asked = true;
    } catch { /* the panel says it could not ask, and the link is still there */ }
    return recent.list;
  }
  // The moment a match ends, whoever was at that table belongs at the top of this list — so the cached answer
  // from before it is wrong, not merely old. Playing is the one thing that changes the list, so it is the one
  // thing that throws the cache away.
  const forgetRecent = () => { recent.at = 0; };
  // Who the next table should invite. On the dashboard there is no room yet — an invitation has to point at a
  // table — so a tap there marks somebody instead of sending, and the stake that opens the table sends them
  // all. In a room the same button sends at once, because there is something to send.
  const picks = new Map();

  // Three states, and no fourth. It used to say when somebody was last seen, which is a diary of their evening
  // and nobody's business: whether they are there now is the only thing that decides whether to invite them.
  const playerRow = (p, mode) => {
    const picked = mode === 'pick' && picks.has(p.id);
    return `
    <div class="aa-pl${picked ? ' is-picked' : ''}" data-player="${p.id}">
      <span class="aa-rank aa-pl-face${faceClass(p)}" aria-hidden="true">${faceInner(p)}</span>
      <span class="aa-pl-who">
        <b>${escapeHtml(p.name || 'Player')}</b>
        <small class="aa-pl-when is-${p.status}">${p.status === 'playing' ? 'In a match' : p.status === 'online' ? 'Online' : 'Offline'}</small>
      </span>
      <button type="button" class="aa-btn aa-btn--small aa-pl-go${picked ? ' is-on' : ''}" data-invite="${p.id}" data-name="${escapeHtml(p.name || 'Player')}"${p.status === 'playing' ? ' disabled title="They are on a board right now"' : ''}${mode === 'pick' ? ` aria-pressed="${picked}"` : ''}>${picked ? '\u2713 Picked' : 'Invite'}</button>
    </div>`;
  };

  function playersHtml(list, mode) {
    if (!list.length) {
      return `<p class="aa-sheet-note">Nobody yet. Play one match with somebody — a link is enough the first time — and they will be here afterwards.</p>`;
    }
    return `<div class="aa-group aa-pl-list">${list.map(p => playerRow(p, mode)).join('')}</div>`;
  }

  // The invite panel of an open room: who you have played with, then the link for everybody else.
  async function showInvitePanel(m) {
    if (!m) return;
    state.pendingMatch = m;
    const draw = list => {
      el.card.innerHTML = `
        <p class="aa-card-kicker">Gold match · ${gpurse(m.stake)}</p>
        <h3>Invite</h3>
        ${list === null ? '<p class="aa-loading">Looking…</p>' : playersHtml(list)}
        <div class="aa-actions">
          <button type="button" class="aa-btn aa-btn--primary" data-act="mshare">Share a link</button>
          <button type="button" class="aa-btn" data-act="mroom">Back to the room</button>
        </div>
        <p class="aa-flash" hidden></p>`;
      wireFaces(el.card);
    };
    draw(recent.asked ? recent.list : null);
    showCard();
    const list = await loadRecent(true);
    if (state.pendingMatch?.code === m.code && !el.overlay.hidden) draw(list);
  }

  // Sending one. The room has to be open and theirs, which the server checks; this only has to say what
  // happened, and to be honest about somebody who is not online to hear it.
  async function invitePlayer(id, name, btn, quiet) {
    const m = state.pendingMatch;
    if (!m || !id) return false;
    if (btn) { btn.disabled = true; btn.textContent = 'Inviting…'; }
    try {
      const d = await matchApi('invite', { code: m.code, user_id: Number(id) });
      // Where it went: onto their screen, to their phone, or nowhere. An older server says only delivered.
      const reach = d.reach || (d.delivered ? 'live' : 'none');
      if (btn) btn.textContent = reach === 'none' ? 'Sent' : 'Invited';
      // A batch from the dashboard speaks once for all of them, so it asks for the answer and does the talking.
      if (!quiet) toast(reach === 'live' ? `${name} has been asked to join.`
        : reach === 'push' ? `${name} is away — their phone has been told.`
        : `${name} is not online — send them the link instead.`, reach === 'none' ? 'hint' : 'good');
      return reach !== 'none';
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Invite'; }
      if (!quiet) toast(err.code === 'not_played_together' ? 'You can only invite people you have played with.'
        : err.code === 'in_a_match' ? `${name} is on a board right now. Try again when they are done.`
        : err.code === 'taken' ? 'That room has already started.'
        : err.code === 'already_in' ? `${name} is already in this room.`
        : err.code === 'room_full' ? 'The room is full.'
        : err.code === 'rate_limited' ? `${name} was asked a moment ago. Give it a minute.`
        : err.code === 'try_later' ? 'Invitations are paused for a moment. Try again shortly.'
        : err.code === 'not_yours' ? 'Only somebody in the room can invite into it.'
        : 'Could not send that invitation.', 'bad', 4200);
      return false;
    }
  }

  // What this table pays, said once and said the same way everywhere a player is about to put gold on it.
  //
  // Whether the places pay depends on how many end up at the table, and a room being invited into does not
  // know that yet — so the sentence says what is certain either way. Once three are actually sitting there,
  // the server sends the two numbers and it can stop saying "with three or more".
  const splitLine = m => {
    const back = gpurse(m?.stake || 0), tenth = gpurse(Math.floor((m?.stake || 0) / 10));
    return m?.prizes?.second
      ? `First takes the pot, second gets its ${back} stake back and third ${tenth} — so finishing is worth it even once somebody has won.`
      : `Clear it first and you take the pot. With three or more at the table, second gets its ${back} stake back and third ${tenth}.`;
  };

  // Receiving one: the same card a shared link opens, so there is one way to say yes to a match.
  async function onInvite(ev) {
    const d = ev?.data || {};
    if (!d.code || !auth.user) return;
    // Not while a race board is on screen — and that includes the card that asks whether to try again, where
    // a challenge appearing under a thumb already on its way to a button is how somebody ends up in a match
    // they never chose. It is kept instead, and offered when they are back in the lobby.
    if (state.daily?.race) { state.inviteWaiting = { ...d, at: Date.now() }; toast(`${d.from || 'Somebody'} is challenging you. Finish here first.`, 'hint', 4000); return; }
    if (state.pendingMatch?.code === d.code || state.invite?.code === d.code) return;   // already looking at this room
    try {
      const r = await matchApi('get', { code: d.code });
      if (!r.match || r.match.state !== 'open') return;
      SFX.join?.(); vibe(20);
      closeSheets();
      showConfirm({ ...r.match, host: d.from || r.match.host, host_pic: d.pic || '', host_id: d.from_id || 0 });
    } catch { /* the room went away between the invitation and the tap */ }
  }

  // On means the room takes whoever else is online at that stake and starts itself; off means only the people
  // you send the link to, and only when you say go.
  const fillOn = () => store.get('fillOnline', true) !== false;
  function openStakes() {
    picks.clear();                      // a mark is for the table chosen in this visit, not for a later one
    const gold = auth.user?.gold ?? 0, fill = fillOn(), waiting = state.lobbyWaiting || {};
    el.matchTitle.textContent = 'Dashboard';
    el.matchBody.innerHTML = `
      ${meStrip()}
      <p class="aa-cap">Table</p>
      <div class="aa-stakes">${stakesHtml(gold, waiting)}</div>
      <label class="aa-fill"><input type="checkbox" id="aaFillOnline"${fill ? ' checked' : ''}><span>Fill from online</span></label>
      <p class="aa-cap" id="aaRecentCap" hidden>Recently played</p>
      <div id="aaRecentBox"></div>`;
    openSheet(el.matchSheet);
    wireFaces(el.matchBody);
    refreshLobby();
    refreshRecent();
  }

  // The dashboard's copy of the list. Inviting from here needs a table first — the room is what an invitation
  // points at — so a tap marks somebody, the caption says how many are marked and what to do next, and the
  // stake that opens the table sends every one of them.
  function pickCaption() {
    const cap = $('#aaRecentCap', el.matchBody);
    if (!cap) return;
    cap.textContent = picks.size
      ? `${picks.size} picked · now choose a table above`
      : 'Recently played';
    cap.classList.toggle('is-armed', picks.size > 0);
  }
  async function refreshRecent() {
    const box = $('#aaRecentBox', el.matchBody);
    if (!box) return;
    const list = await loadRecent(!recent.asked);
    const cap = $('#aaRecentCap', el.matchBody);
    if (!$('#aaRecentBox', el.matchBody)) return;         // the sheet changed under us
    if (cap) cap.hidden = !list.length;
    box.innerHTML = list.length ? playersHtml(list, 'pick') : '';
    wireFaces(box);
    pickCaption();
  }
  // Five tables in one row, small enough to take in at a glance. How many are sitting at each one rides in the
  // corner as a badge rather than as a line of type: the number is the news, the word "waiting" is not.
  const stakeLive = n => n ? `<span class="aa-stake-live" title="${n} waiting">${n}</span>` : '';
  // How long a match is, in boards. The list is the server's (the lobby sends it), so a length added there
  // reaches the player on their next look at the dashboard. Three is the default: a match should take a while.
  let LENGTHS = [1, 3, 5];
  // A match is one board. The server still plays longer ones (the lobby lists the lengths), but the dashboard
  // no longer asks: a choice nobody asked for is a choice in the way of the table.
  const matchLen = () => 1;
  /** One line that says how long a room's match is, for the room card and the invitation. */
  const shapeLine = m => { const n = Number(m?.boards_n) || (Array.isArray(m?.boards) ? m.boards.length : 1); return n === 1 ? 'One board' : `${n} boards in a row`; };
  const stakesHtml = (gold, waiting) => STAKES.map(v =>
    `<button type="button" class="aa-stake" data-stake="${v}"${gold < v ? ' disabled' : ''} aria-label="Play for ${gfmt(v)} gold"><span class="aa-stake-in"><img class="aa-coin aa-stake-coin" src="/images/puzzle-coin.png" alt="" width="128" height="128" decoding="async"><span class="aa-stake-amt">${gtiny(v)}</span></span>${stakeLive(waiting[v])}</button>`).join('');

  // How many are sitting in a room at each stake. Shown under the coins so nobody waits at an empty one.
  // The same answer carries the server's list of tables, so a table added or retired there reaches the player
  // on their next look at the dashboard rather than on their next app update.
  async function refreshLobby() {
    try {
      const d = await matchApi('lobby');
      state.lobbyWaiting = d.waiting || {};
      if (typeof d.gold === 'number') setGold(d.gold);
      if (Array.isArray(d.lengths) && d.lengths.length) LENGTHS = d.lengths.filter(n => Number.isInteger(n) && n > 0);
      const served = Array.isArray(d.stakes) ? d.stakes.filter(n => Number.isFinite(n) && n > 0) : [];
      const row = $('.aa-stakes', el.matchBody);
      if (served.length && String(served) !== String(STAKES)) {
        STAKES = served;
        if (row) row.innerHTML = stakesHtml(auth.user?.gold ?? 0, state.lobbyWaiting);
        return;
      }
      $$('.aa-stake', el.matchBody).forEach(b => {
        const n = state.lobbyWaiting[b.dataset.stake] || 0, live = $('.aa-stake-live', b);
        if (live && !n) live.remove();
        else if (live) { live.textContent = n; live.title = `${n} waiting`; }
        else if (n) b.insertAdjacentHTML('beforeend', stakeLive(n));
      });
    } catch { /* the count is a nicety, not the flow */ }
  }

  // The room, on the game screen: who is in, an Invite button, and Start for the host. The board is not dealt
  // until the host starts, so nobody can study it while the room fills up.
  const faces = players => (players || []).map(p => `<span class="aa-rank${p.you ? ' is-you' : ''}${faceClass(p)}" title="${escapeHtml(p.name)}">${faceInner(p)}</span>`).join('');
  function showRoom(m) {
    state.pendingMatch = m;
    state.roomInfo = false;           // a new room starts with the note folded away, as every room does
    closeSheets();
    clearRun();                       // the waiting room shows this match's nothing, not the last one's ending
    el.select.hidden = true; el.game.hidden = false; el.board.innerHTML = '';
    el.hudLevel.textContent = 'Gold match'; el.hudLevel.classList.remove('is-disc');
    el.hudDiff.textContent = ''; el.hudLeft.textContent = '0'; el.hudPct.textContent = '0%';
    el.boardBar.style.width = '0%'; el.ranks.hidden = true;
    scrollToGame();
    if (history.replaceState) history.replaceState(null, '', location.pathname + location.search + '#m=' + m.code);
    renderRoom(m);
    showCard();
    startRoomPoll(m.code);
    tickFill(m.fills_in);   // after the poll: starting it clears any tick already running, this one included
  }
  const INFO_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.2"/><path d="M12 7.6v.2"/></svg>';
  function toggleRoomInfo() {
    state.roomInfo = !state.roomInfo;
    const text = $('#aaRoomInfo', el.card), btn = $('.aa-info', el.card);
    if (text) text.hidden = !state.roomInfo;
    if (btn) btn.setAttribute('aria-expanded', String(!!state.roomInfo));
  }
  function renderRoom(m) {
    const host = m.you === 'host';
    state.pendingMatch = m;
    // What the table pays is one tap away rather than on the card: a paragraph that is read once and then sits
    // in the way of every glance at who has joined. The (i) opens it and closes it, and it stays as it was
    // left across the polls that redraw this card.
    el.card.innerHTML = `
      <p class="aa-card-kicker">Gold match · ${gpurse(m.stake)} <button type="button" class="aa-info" data-act="minfo" aria-expanded="${state.roomInfo ? 'true' : 'false'}" aria-controls="aaRoomInfo" aria-label="How the pot is paid">${INFO_ICON}</button></p>
      <h3>${m.count} of ${m.seats} joined</h3>
      <p class="aa-shape">${shapeLine(m)}</p>
      <div class="aa-ranks aa-ranks--card">${faces(m.players)}</div>
      <p class="aa-wait">${roomWait(m, host)}</p>
      <p class="aa-sheet-note aa-info-text" id="aaRoomInfo"${state.roomInfo ? '' : ' hidden'}>${splitLine(m)}</p>
      <div class="aa-actions">
        <button type="button" class="aa-btn${host && !m.open_to_all ? '' : ' aa-btn--primary'}" data-act="minvite">Invite</button>
        ${host && !m.open_to_all ? `<button type="button" class="aa-btn aa-btn--primary" data-act="mstart"${m.count > 1 ? '' : ' disabled'}>Start</button>` : ''}
        <button type="button" class="aa-btn" data-act="mcancel">Leave</button>
      </div>
      <p class="aa-flash" hidden></p>`;
    wireFaces(el.card);
  }
  // The room's own clock, counted from the second player sitting down, or the moment the seventh does. Between polls the clock
  // is counted down here so it does not tick in twos.
  function roomWait(m, host) {
    // one element, or the flex gap on .aa-wait would space the number out like a countdown clock
    if (typeof m.fills_in === 'number') return `<span>Starting in <b id="aaFillIn">${m.fills_in}</b>s</span>`;
    if (m.open_to_all) return host ? 'Looking for players. Send the link to bring a friend in too.' : 'Waiting for one more player.';
    return host ? (m.count > 1 ? 'Start when everyone is in.' : 'Waiting for your friends to join.') : `Waiting for ${escapeHtml(m.host)} to start.`;
  }
  // The crown can change hands while you are looking at the room, so say so rather than letting a Start button
  // appear out of nowhere.
  const noteHandover = (before, m) => { if (before && before.you === 'guest' && m.you === 'host') toast('You are the leader now.', 'good'); };
  function tickFill(secs) {
    clearInterval(state.fillTick); state.fillTick = 0;
    if (typeof secs !== 'number') return;
    let left = secs;
    state.fillTick = setInterval(() => {
      const n = $('#aaFillIn', el.card);
      if (!n) { clearInterval(state.fillTick); state.fillTick = 0; return; }
      n.textContent = Math.max(0, --left);
      if (left > 0 && left <= 3) SFX.tick();   // the last three: here it comes
    }, 1000);
  }
  function startRoomPoll(code) {
    stopMatchPoll();
    state.pollCode = code;
    const refresh = async () => {
      try {
        const d = await matchApi('get', null, '&code=' + encodeURIComponent(code));
        if (typeof d.gold === 'number') setGold(d.gold);
        const m = d.match;
        if (m.state === 'playing') { stopMatchPoll(); playMatch(m); }
        else if (m.state === 'open') {
          // the server can move a player sitting alone into an older room: follow it, link and all
          if (m.code !== code) { showRoom(m); return; }
          const before = state.pendingMatch;
          state.pendingMatch = m;
          if (before && m.count > before.count) { SFX.join(); vibe(15); }
          else if (before && m.count < before.count) { SFX.left(); }
          const moved = m.count !== before?.count || m.you !== before?.you
            || (typeof m.fills_in === 'number') !== (typeof before?.fills_in === 'number');
          if (!el.overlay.hidden && moved) { renderRoom(m); tickFill(m.fills_in); noteHandover(before, m); }
          // the number is counted down on this device between polls, so pull it back to the server's whenever
          // the two have drifted apart — a backgrounded tab, or a clock the server moved
          else if (typeof m.fills_in === 'number') {
            const shown = +($('#aaFillIn', el.card)?.textContent || NaN);
            if (!Number.isNaN(shown) && Math.abs(shown - m.fills_in) >= 2) { $('#aaFillIn', el.card).textContent = m.fills_in; tickFill(m.fills_in); }
          }
        }
        else { stopMatchPoll(); toast(m.state === 'void' ? 'That match was called off.' : 'That match is over.', 'hint'); goToLevels(); }
      } catch { /* a dropped poll is nothing: the next one will do */ }
    };
    // The poll period follows the socket: a slow safety net while it is up, the old two seconds when it is not.
    const tune = () => {
      if (!state.pollCode) return;
      clearInterval(state.matchPoll);
      state.matchPoll = setInterval(refresh, pollEvery());
    };
    live.onTune = tune;
    live.watch(code, ev => {
      if (ev.type === 'countdown_tick') {
        // the countdown belongs to the server: stop counting locally and show the number it sent, so every
        // player in the room sees the same one and a backgrounded tab cannot drift
        clearInterval(state.fillTick); state.fillTick = 0;
        const n = $('#aaFillIn', el.card);
        if (n) n.textContent = Math.max(0, Number(ev.data?.fills_in ?? 0));
        return;
      }
      refresh();   // somebody joined, left, or the match began: ask for the truth rather than patching a guess
    });
    state.matchPoll = setInterval(refresh, pollEvery());
  }
  function stopMatchPoll() {
    clearInterval(state.matchPoll); state.matchPoll = 0;
    clearInterval(state.fillTick); state.fillTick = 0;
    state.pollCode = null; live.onTune = null;
  }
  async function startMatch() {
    const m = state.pendingMatch;
    if (!m) return;
    const btn = $('[data-act="mstart"]', el.card); if (btn) btn.disabled = true;
    try { const d = await matchApi('start', { code: m.code }); stopMatchPoll(); playMatch(d.match); }
    catch (err) { if (btn) btn.disabled = false; toast(err.code === 'need_two' ? 'Nobody has joined yet.' : err.code === 'clock_starts_it' ? 'This room starts on its own clock.' : 'Could not start the match.', 'bad'); }
  }
  // Leaving hands your own stake back. The room closes only if you were the last one in it; otherwise it plays
  // on without you, with the next player in charge.
  async function leaveRoom() {
    const m = state.pendingMatch;
    if (!m) return;
    stopMatchPoll();
    try {
      const d = await matchApi('cancel', { code: m.code });
      setGold(d.gold);
      toast(d.closed ? `Match called off. ${gfmt(m.stake)} gold back.` : `You left. ${gfmt(m.stake)} gold back.`, 'good');
    } catch (err) { toast(err.code === 'taken' ? 'Too late, the match has started.' : 'Could not leave that room.', 'bad'); }
    state.pendingMatch = null;
    goToLevels();
  }
  function showConfirm(m) {
    el.matchTitle.textContent = 'A challenge';
    const gold = auth.user?.gold ?? 0, short = gold < m.stake;
    el.matchBody.innerHTML = `
      <div class="aa-vs-row aa-from">
        <span class="aa-rank aa-vs-face${faceClass({ name: m.host, pic: m.host_pic })}" aria-hidden="true">${faceInner({ name: m.host, pic: m.host_pic })}</span>
        <span class="aa-vs-who"><b>${escapeHtml(m.host)}</b> challenges you.</span>
      </div>
      <p class="aa-purse"><span>Stake</span><span class="aa-gold" title="${gfmt(m.stake)} gold">${COIN}${gpurse(m.stake)}</span></p>
      <p class="aa-shape">${shapeLine(m)}</p>
      <p class="aa-sheet-note">Everyone puts in ${gpurse(m.stake)} gold and plays the very same boards. ${splitLine(m)}${short ? ` <b>You have only ${gpurse(gold)}.</b>` : ''}</p>
      <div class="aa-actions">
        <button type="button" class="aa-btn aa-btn--primary" data-mact="join"${short ? ' disabled' : ''}>Confirm game</button>
        <button type="button" class="aa-btn" data-mact="close">Not now</button>
      </div>
      ${m.host_id ? `<p class="aa-card-out"><button type="button" class="aa-linkbtn" data-mact="mute">Mute ${escapeHtml(m.host)}</button></p>` : ''}
      <p class="aa-flash" hidden></p>`;
    openSheet(el.matchSheet);
    wireFaces(el.matchBody);
    // Kept apart from pendingMatch: that is the room this player may be sitting in, and its poll writes it
    // back every few seconds. An invitation that shared the slot was overwritten mid-sheet, so Confirm joined
    // the player's own room and Mute muted nobody.
    state.invite = m;
  }

  // ── Muting ──
  // The one answer to being asked too often: this person's invitations stop coming -- to the screen and to
  // the phone -- and they leave the list of people to ask. They are never told. Settings lists who is muted,
  // with a way back, so a tap in irritation is not for ever.
  const playersApi = (path, body) => apiCall(`${API_V1}/players/${path}`, body);

  async function muteHost(m) {
    if (!m?.host_id) return;
    const yes = await ask({
      title: `Mute ${m.host}?`,
      body: 'Their invitations will not reach you any more, on any device, and they leave your list. You can undo this in Settings.',
      ok: 'Mute', cancel: 'Keep', danger: true,
    });
    if (!yes) return;
    try {
      const d = await playersApi('mute', { user_id: m.host_id });
      forgetRecent();
      closeSheets();
      renderMuted(d.muted);
      toast(`${m.host} is muted. Settings has the way back.`, 'hint', 4000);
    } catch { toast('Could not mute them just now.', 'bad'); }
  }

  /** The list in Settings. Drawn from what the server last said; asked again each time Settings opens. */
  function renderMuted(list) {
    if (!el.mutedGroup) return;
    const rows = Array.isArray(list) ? list : [];
    const show = !!auth.user && rows.length > 0;
    if (el.mutedCap) el.mutedCap.hidden = !show;
    el.mutedGroup.hidden = !show;
    if (!show) { el.mutedGroup.innerHTML = ''; return; }
    el.mutedGroup.innerHTML = rows.map(p => `
      <div class="aa-row"><span class="aa-rank aa-pl-face${faceClass(p)}" aria-hidden="true">${faceInner(p)}</span><span class="aa-row-label">${escapeHtml(p.name || 'Player')}<small class="aa-row-sub">Their invitations do not reach you</small></span><button type="button" class="aa-btn aa-btn--small" data-unmute="${p.id}">Unmute</button></div>`).join('');
    wireFaces(el.mutedGroup);
  }
  async function loadMuted() {
    if (!auth.user) { renderMuted([]); return; }
    try { renderMuted((await playersApi('muted')).muted); } catch { /* the list stays as it was */ }
  }
  el.mutedGroup?.addEventListener('click', async e => {
    const id = e.target.closest('[data-unmute]')?.dataset.unmute;
    if (!id) return;
    const btn = e.target.closest('[data-unmute]'); btn.disabled = true;
    try { const d = await playersApi('unmute', { user_id: Number(id) }); forgetRecent(); renderMuted(d.muted); toast('Unmuted.', 'hint'); }
    catch { btn.disabled = false; toast('Could not unmute them just now.', 'bad'); }
  });

  function showMatchState(m, goldBefore, celebrate = true) {
    forgetRecent();
    el.matchTitle.textContent = m.you_won ? 'You win!' : m.winner ? `${m.winner} wins` : m.state === 'done' ? 'Nobody cleared it' : 'Waiting';
    // The time on each line is the race time the server keeps: from the match starting to that player's result
    // landing, which is the very thing first place is decided by. The board's own clock is a different number —
    // it starts at the player's first tap, and starts over when somebody takes the board again after running
    // out of hearts — so showing it here put the winner on the slower-looking line and made the sheet read like
    // the wrong player had won. (race_ms is missing only from a server older than this; then the clock is all
    // there is.)
    // The same faces the line-up over the board uses. A result is about who you played, and a column of bare
    // names says nothing about that — least of all in a room of five.
    const row = p => `<div class="aa-vs-row${p.won ? ' is-win' : ''}">
      <span class="aa-rank aa-vs-face${faceClass(p)}" aria-hidden="true">${faceInner(p)}</span>
      <span class="aa-vs-who">${p.ms > 0 ? `${p.place}. ` : ''}${escapeHtml(p.you ? 'You' : p.name)}</span>
      <b>${p.ms == null ? 'still playing' : p.ms < 0 ? (p.gave_up ? 'gave the board up' : 'ran out of hearts') : fmtTime(p.race_ms ?? p.ms, true)}</b></div>`;
    const mine = (m.players || []).find(p => p.you);
    // What this player took, which after a three-way board is not the same as what the pot held: second place
    // has its stake back and third a tenth of one, and telling either of them they "lost" would be a lie.
    const took = mine?.prize ?? 0;
    // Said as a label and a figure, because the sheet already shows the figure as a coin. What used to sit in
    // that coin was the player's whole balance, which is the one number this sheet has nothing to do with: it
    // is the same before and after for everybody who did not win, and on a winner it buries the winnings
    // inside a total. So the coin now holds what this match moved, and the words beside it say which way.
    const purse = took > 0
      ? (m.you_won ? { label: 'You won', gold: took }
        : took >= m.stake ? { label: 'Your stake came back', gold: took }
        : { label: 'You took back', gold: took })
      : m.winner ? { label: 'You lost', gold: m.stake }
      : m.draw ? { label: 'Every stake came back' }
      : { label: 'Your stake is held' };
    // The reading from the board just cleared, where this sheet is the end of that run. A challenge is still a
    // board of this game, so it says the same things about it a tour board does — the stars, what it cost, the
    // focus bar — and the only thing left out is a second clock, because the race time is already on every line
    // above. On a sheet opened for somebody else's match, or reopened later, there is no reading and the block
    // is simply not there.
    const RR = state.raceReading?.code && state.raceReading.code === m.code ? state.raceReading : null;
    const band = RR ? focusBand(RR.focus) : null;
    const reading = !RR ? '' : `
      <p class="aa-stars" aria-label="${RR.stars} of 3 stars">${'★'.repeat(RR.stars)}${'☆'.repeat(3 - RR.stars)}</p>
      <div class="aa-stats"><span><b>${RR.lost}</b>hearts lost</span><span><b>${RR.hints}</b>hints</span><span><b>x${RR.combo}</b>best combo</span></div>
      <div class="aa-focus" id="aaFocus" role="img" aria-label="Focus ${RR.focus} out of 100 — ${band.name}">
        <p class="aa-focus-cap">Your focus level<b class="aa-focus-num">0</b></p>
        <div class="aa-focus-bar">
          <span class="aa-focus-dim"></span>
          <span class="aa-focus-mark">${BRAIN}</span>
        </div>
      </div>`;
    el.matchBody.innerHTML = `
      <div class="aa-vs">${(m.players || []).map(row).join('')}</div>
      <p class="aa-purse"><span>${purse.label}</span>${purse.gold == null ? '' : `<span class="aa-gold${m.you_won ? ' is-won' : ''}" title="${gfmt(purse.gold)} gold">${COIN}<span id="aaPurseCount">${gpurse(purse.gold)}</span></span>`}</p>
      ${reading}
      ${m.state === 'done' ? '' : `<p class="aa-sheet-note">The others are still playing for their place. ${m.prizes?.second ? `Second takes ${gpurse(m.prizes.second)}, third ${gpurse(m.prizes.third)}.` : ''}</p>`}
      <div class="aa-actions"><button type="button" class="aa-btn aa-btn--primary" data-mact="stakes">Play another</button><button type="button" class="aa-btn" data-mact="close">Close</button></div>`;
    wireFaces(el.matchBody);
    if (RR) { runFocusBar(RR.focus, el.matchBody, !RR.ran); RR.ran = true; }
    openSheet(el.matchSheet);
    if (m.you_won && celebrate) {
      if (typeof goldBefore === 'number') purseWin = { from: goldBefore, to: auth.user?.gold ?? goldBefore };
      SFX.win(); vibe([0, 40, 60, 120]); goldRain(100, true);
      setTimeout(() => goldRain(60, true), 500);
      countTo($('#aaPurseCount', el.matchBody), 0, took);
    }
  }

  // Your own run is in, and with it the poll that carried the race stops — so the sheet freezes at the moment
  // you finished, saying the others are still playing for as long as you leave it open. The match does end;
  // it just ends on somebody else's screen. This follows the room until everybody has reported, and then
  // stops. It never celebrates again: the pot was decided the moment the first player cleared the board, so a
  // second fanfare would be for news that already broke.
  function watchResult(code, m) {
    stopResultWatch();
    if (!m || m.state === 'done') return;
    const tick = async () => {
      if (!el.matchSheet || el.matchSheet.hidden) { stopResultWatch(); return; }
      try {
        const d = await matchApi('get', null, '&code=' + encodeURIComponent(code));
        if (typeof d.gold === 'number') setGold(d.gold);
        showMatchState(d.match, undefined, false);
        if (d.match.state === 'done') stopResultWatch();
      } catch { /* a dropped poll is nothing: the next one will do */ }
    };
    state.resultWatch = setInterval(tick, 4000);
  }
  function stopResultWatch() { clearInterval(state.resultWatch); state.resultWatch = 0; }

  // The line-up over the board: first place first, and the order moves as they play.
  function renderRanks(players) {
    if (!el.ranks) return;
    if (!players?.length) { el.ranks.hidden = true; musicRace(0); return; }
    // Being second is a different board to be on than being first, and the music is the only part of the game
    // that can say so without taking the player's eyes off the arrows.
    const you = players.find(x => x.you);
    musicRace(players.some(x => x.won && !x.you) ? 0.3 : you && you.place > 1 ? 0.18 : 0);
    el.ranks.innerHTML = players.map(p => `<span class="aa-rank${p.you ? ' is-you' : ''}${p.won ? ' is-won' : ''}${p.ms === -1 ? ' is-out' : ''}${faceClass(p)}" title="${escapeHtml(p.name)}">${faceInner(p)}<span class="aa-rank-no">${p.place}</span></span>`).join('');
    el.ranks.setAttribute('aria-label', players.map(p => `${p.place}. ${p.name}`).join(', '));
    wireFaces(el.ranks);
    el.ranks.hidden = false;
  }
  function startProgressPoll() {
    stopProgressPoll();
    const R = state.daily;
    if (!R?.match) return;
    // Progress is over the whole match: board two of three half done is 50%, not 50% of a third.
    const boardFrac = () => (state.pieces.length ? (state.pieces.length - state.left) / state.pieces.length : 0);
    const myPct = () => { const n = R.boards?.length || 1; return Math.round((((R.bi | 0) + boardFrac()) / n) * 100); };
    const notePot = m => {
      if (m?.winner && !state.potGone && !state.finished) {   // the pot is gone; the places behind it are not
        state.potGone = true;
        SFX.taken(); toast(`${m.winner} cleared it first. Play on for second place.`);
      }
    };
    // The REST call is what carries the race while there is no socket, and stays on as a slow safety net when
    // there is one: it is also how the ranks come back, which is what the board beside the map is drawn from.
    // The board goes with the number, but only when it has changed: a snapshot is a few hundred bytes and the
    // socket sends every second, so an unchanged board is not worth carrying. The first post always carries it.
    let carried = -1;
    const runIfChanged = () => { if (state.moves === carried) return undefined; carried = state.moves | 0; return runSnapshot(); };
    // A run that comes back ahead of this board was made on another device, and this one catches up rather
    // than fighting it -- which is the whole answer to a tab left open while the phone played on.
    const takeBack = m => {
      const r = m?.your_run; if (!runAhead(r)) return;
      // Ahead on a later board: this device goes there, and puts the run onto it once it is drawn.
      if (R.boards && Number.isInteger(r.bi) && r.bi > (R.bi | 0)) {
        const bi = Math.min(r.bi, R.boards.length - 1), next = raceFor(R.match, R.boards, bi, r.moves | 0, r, R.elapsedBase || 0);
        const j = matchBoardIndex(next.board);
        if (j >= 0) { startLevel(j, false, next, R.tier); return; }
      }
      applyRun(r); carried = -1;
    };
    const send = async () => {
      try {
        const d = await matchApi('progress', { code: R.match.code, pct: myPct(), run: runIfChanged() });
        renderRanks(d.match.players);
        syncRaceClock(d.match);     // the match's own age, in case this device slept through part of it
        notePot(d.match);
        takeBack(d.match);
      } catch { carried = -1; /* the next tick will try again, and carry the board again */ }
    };
    const tune = () => {
      if (!state.progressPoll) return;
      clearInterval(state.progressPoll);
      state.progressPoll = setInterval(send, pollEvery());
    };
    live.onTune = tune;
    live.watch(R.match.code, ev => {
      // Somebody moved, finished, or the match ended. The state that comes with a start or a finish is the
      // whole room; a bare progress event only needs the ranks redrawn, and the socket sends one per tap.
      if (ev.type === 'state' && ev.match) { renderRanks(ev.match.players); syncRaceClock(ev.match); notePot(ev.match); takeBack(ev.match); return; }
      if (ev.type === 'progress_updated' || ev.type === 'player_finished' || ev.type === 'match_finished') live.resync();
    });
    // While the socket is up, our own progress goes over it — no request per tap, no waiting for a reply.
    state.progressPush = setInterval(() => { if (live.connected) live.progress(myPct(), runIfChanged()); }, 1000);
    send();
    state.progressPoll = setInterval(send, pollEvery());
  }
  function stopProgressPoll() {
    clearInterval(state.progressPoll); state.progressPoll = 0;
    clearInterval(state.progressPush); state.progressPush = 0;
    live.onTune = null;
  }

  const matchBoardIndex = board => DATA.levels.findIndex(L => L.id === board);
  /**
   * The race, as startLevel plays it: which board of the match, from what move count. A match is a run of
   * boards now, each with its own seed off the match's; `moves` carries on from board to board so the
   * server's guard -- a snapshot only ever replaces one with fewer moves -- still holds across them, and
   * `run` is a snapshot to put back onto the board once it is drawn.
   */
  function raceFor(m, boards, bi, moves = 0, run = null, elapsedBase = 0) {
    return { key: 'match', race: true, match: m, boards, bi, board: boards[bi], tier: m.tier,
      seed: (Number(m.seed) | 0) + bi * 7919, hash: '#m=' + m.code, moves, run, elapsedBase };
  }
  const boardsOfMatch = m => (Array.isArray(m.boards) && m.boards.length ? m.boards : [m.board]);
  function playMatch(m) {
    // Never deal this board again over a run that is already on screen. A poll that arrives late, a link
    // opened twice, the back button — any of them used to restart the board under the player, which looked
    // like the game had pressed Try again for them. Getting back onto a board is a tap, and only a tap.
    if (state.daily?.race && state.daily.match?.code === m.code) return;
    const boards = boardsOfMatch(m);
    // The board this account is on, wherever it last played: a run posted from another device says which.
    const bi = Math.max(0, Math.min(boards.length - 1, Number(m.your_run?.bi) | 0));
    const i = matchBoardIndex(boards[bi]);
    if (i < 0) { toast('That board is not in this version of the game.', 'bad'); return; }
    closeSheets();
    state.pendingMatch = null;
    stopMatchPoll();
    startLevel(i, false, raceFor(m, boards, bi, Number(m.your_run?.moves) | 0, m.your_run || null), m.tier)
      .then(() => { SFX.go(); vibe([0, 30, 60, 70]); });   // startLevel puts the line-up and the poll back
    if (typeof gtag === 'function') gtag('event', 'match_play', { game: 'puzzle', stake: m.stake });
  }

  async function sendInvite(m) {
    if (!m) return;
    const link = matchLink(m.code);
    const text = `Puzzle – Train Your Brain: I put ${gfmt(m.stake)} gold on a board. Match it and clear it before me.\n${link}`;
    const flash = $('.aa-flash', el.overlay.hidden ? el.matchBody : el.card);
    try {
      if (shell.on && shell.bridge() && (await shell.ask('share ' + text, 8000)).ok) return;   // the phone's own share sheet
      if (navigator.share) { await navigator.share({ text }); return; }
      await navigator.clipboard.writeText(text);
      if (flash) { flash.textContent = 'Link copied. Paste it to your friend.'; flash.hidden = false; }
    } catch { if (flash) { flash.textContent = link; flash.hidden = false; } }
  }

  el.goldAd?.addEventListener('click', e => {
    e.stopPropagation();   // the chip itself opens the dashboard; the plus does not
    adOffer('gold');
  });

  const goldError = e => e.code === 'not_enough_gold' ? 'You do not have that much gold.' : e.code === 'taken' ? 'Someone already took that match.' : e.code === 'own_match' ? 'That is your own invitation.' : e.code === 'signed_out' ? 'Please sign in again.' : e.code === 'room_full' ? 'That room is already full.' : e.code === 'no_match' ? 'That room is gone.' : e.code === 'rate_limited' ? 'Too many at once. Give it a minute.' : 'Something went wrong. Please try again.';
  // a challenge link kept while signing in: good for an hour, and only the shape a link has
  const pendingLink = () => { const p = store.get('pendingCode', null); return p && typeof p === 'object' && /^[A-Za-z0-9]{4,12}$/.test(p.code || '') && Date.now() - (p.at || 0) < 3600e3 ? p.code : ''; };

  el.matchBody?.addEventListener('change', e => {
    if (e.target.id !== 'aaFillOnline') return;
    store.set('fillOnline', e.target.checked);
  });
  el.matchBody?.addEventListener('click', async e => {
    const inv = e.target.closest('[data-invite]');
    if (inv) {
      const id = Number(inv.dataset.invite), name = inv.dataset.name;
      const row = inv.closest('.aa-pl');
      if (picks.delete(id)) {
        inv.textContent = 'Invite'; inv.classList.remove('is-on'); inv.setAttribute('aria-pressed', 'false');
        row?.classList.remove('is-picked');
      } else {
        picks.set(id, name);
        inv.textContent = '\u2713 Picked'; inv.classList.add('is-on'); inv.setAttribute('aria-pressed', 'true');
        row?.classList.add('is-picked');
        if (picks.size === 1) teach('tables', 'Now choose a table, and they will be invited to it.');
      }
      vibe(10);
      pickCaption();
      return;
    }
    const stake = e.target.closest('[data-stake]')?.dataset.stake;
    const act = e.target.closest('[data-mact]')?.dataset.mact;
    if (stake) {
      const btn = e.target.closest('[data-stake]'); btn.disabled = true;
      try {
        // People picked on the dashboard are invited into a room of their own: a public room can be walked into
        // by a stranger, moved or voided within minutes, and the phone that rang would find nothing there.
        const d = await matchApi('create', { stake: +stake, tier: TIER_OF(), open_to_all: picks.size ? false : fillOn(), boards: matchLen() });
        setGold(d.gold);
        showRoom(d.match);
        // People were picked on the dashboard before the table was: now there is a room to point them at.
        const who = [...picks]; picks.clear();
        if (who.length) {
          const here = [], away = [];
          for (const [id, name] of who) (await invitePlayer(id, name, null, true) ? here : away).push(name);
          // Everyone picked was sent an invitation; only the ones with the game open will see it now, and
          // saying which is which is kinder than a cheerful line about somebody who is asleep.
          const asked = here.length === 1 ? `${here[0]} has been asked to join.` : `${here.length} players have been asked to join.`;
          const missed = away.length === 1 ? `${away[0]} is not online — share the link.` : `${away.length} of them are not online — share the link.`;
          if (here.length && away.length) toast(`${asked} ${missed}`, 'hint', 4200);
          else if (here.length) toast(asked, 'good');
          else toast(missed, 'hint');
        }
      } catch (err) {
        btn.disabled = false;
        if (typeof err.gold === 'number') setGold(err.gold);
        if (err.code === 'in_match' && err.matchCode) { toast('You are already in a match. Here it is.', 'hint', 4000); openMatchLink(err.matchCode); }
        else if (err.code === 'not_enough_gold' && ads.on() && auth.user) adOffer('gold', 'Not enough gold for that table. Watch a short advertisement through and some is added to your purse.');
        else toast(goldError(err), 'bad');
      }
      return;
    }
    if (!act) return;
    const m = state.invite;
    if (act === 'stakes') openFriends();
    else if (act === 'mute') muteHost(m);
    else if (act === 'close') { state.invite = null; closeSheets(); if (state.daily?.race && state.finished) goToLevels(); }
    else if (act === 'join' && m) {
      const btn = e.target.closest('[data-mact]'); btn.disabled = true;
      try { const d = await matchApi('join', { code: m.code, tier: TIER_OF() }); state.invite = null; setGold(d.gold); showRoom(d.match); }
      catch (err) {
        btn.disabled = false;
        if (typeof err.gold === 'number') setGold(err.gold);
        if (err.code === 'in_match' && err.matchCode && err.matchCode !== m.code && state.pendingMatch?.state === 'open') {
          // Sitting in a room of their own that has not started: one tap to leave it for this one.
          const yes = await ask({ title: 'Leave your room?', body: `You are waiting in another room. Leave it and join ${m.host}'s?`, ok: 'Leave and join', cancel: 'Stay' });
          if (!yes) return;
          try { await matchApi('cancel', { code: err.matchCode }); const d = await matchApi('join', { code: m.code, tier: TIER_OF() }); state.invite = null; setGold(d.gold); showRoom(d.match); }
          catch (e2) { toast(goldError(e2), 'bad'); }
        }
        else if (err.code === 'in_match' && err.matchCode) { toast('You are already in a match. Here it is.', 'hint', 4000); openMatchLink(err.matchCode); }
        else if (err.code === 'not_enough_gold' && ads.on() && auth.user) adOffer('gold', 'Not enough gold for that table. Watch a short advertisement through and some is added to your purse.');
        else toast(goldError(err), 'bad');
      }
    }
  });

  const matchHash = () => (/^#m=([A-Za-z0-9]{4,12})$/.exec(location.hash) || [])[1]?.toUpperCase() || '';
  // An invitation opened while the game is already on screen only changes the address, so the page never
  // reloads: catch that here, or tapping a friend's link in a chat would do nothing.
  window.addEventListener('hashchange', () => {
    const code = matchHash();
    if (code && code !== state.daily?.match?.code) openMatchLink(code);
  });

  /**
   * Put a match on screen wherever it belongs, given what it is: a board to play, a room to wait in, or a
   * result to read. Used by an invitation link, by a refusal that names the room already held, and by a
   * device finding a match the account started somewhere else.
   */
  function enterMatch(m) {
    if (!m || !m.you) return false;
    if (state.daily?.race && state.daily.match?.code === m.code) return true;   // already on it
    if (m.state === 'playing') { if (m.your_ms == null && m.board) playMatch(m); else showMatchState(m); return true; }
    if (m.state === 'open') { showRoom(m); return true; }
    if (m.state === 'done') { showMatchState(m); return true; }
    return false;
  }

  /**
   * The match this account is still in, opened on a device that knew nothing about it.
   *
   * <p>This is the fix for the fault itself. The same account can be signed in on a phone and in a browser,
   * and the code of a room used to live only in the client that opened it: start a challenge in a tab, close
   * the tab, pick up the phone, and the phone had no idea there was a board with the account's gold on it.
   *
   * <p>It is deliberately only called on the way in — on load, and on signing in. A player halfway through a
   * board of their own is not dragged off it, and asking the server again from a Settings screen must never
   * move anybody anywhere.
   */
  let resumedCode = '';
  function resumeLive() {
    const m = auth.match;
    if (!m || m.code === resumedCode) return false;
    if (state.pieces.length && !state.finished) return false;   // busy on another board: leave them on it
    resumedCode = m.code;
    const entered = enterMatch(m);
    if (entered) splashSkip?.();   // the board is more urgent than the line about focus
    return entered;
  }

  // Someone opened an invitation link. Signing in comes first, because the stake leaves a real purse.
  async function openMatchLink(code) {
    try {
      await authLoad();
      const d = await matchApi('get', null, '&code=' + encodeURIComponent(code));
      const m = d.match;
      if (typeof d.gold === 'number') setGold(d.gold);
      if (state.daily?.race && state.daily.match?.code === code) return;   // already on this board: leave it alone
      if (!auth.user) { state.pendingCode = code; store.set('pendingCode', { code, at: Date.now() }); openSignIn(`${m.host} put ${gfmt(m.stake)} gold on a board for you. Sign in to take the challenge.`); return; }
      if (m.you && m.state === 'playing') { if (m.your_ms == null && m.board) playMatch(m); else showMatchState(m); return; }
      if (m.you && m.state === 'done') { showMatchState(m); return; }
      if (m.state === 'void') { toast('That invitation was called off.', 'hint', 4000); return; }
      if (m.state !== 'open') { toast('That match is over.', 'hint'); return; }
      if (m.you) { showRoom(m); return; }
      showConfirm(m);
    } catch (err) {
      toast(err.code === 'no_match' ? 'That invitation link is not valid any more.' : 'Could not open that invitation.', 'bad', 4500);
    }
  }

  // The lobby chip is the purse. A win counts up into it with the coins and the fanfare, so the gold is still
  // landing when the player gets back from the board.
  let purseWin = null;
  function renderPurse() {
    if (!el.purse) return;
    el.purse.hidden = !auth.user;
    if (!auth.user) { purseWin = null; return; }
    const gold = auth.user.gold ?? 0;
    const win = purseWin && purseWin.to === gold ? purseWin : null;
    purseWin = null;
    el.purse.className = 'aa-chip aa-chip--purse';
    if (el.goldAd) {
      el.goldAd.hidden = !ads.on();
      // The same rule the fail card follows: the offer never calls itself an advertisement unless one is
      // going to play. With data-give="free" nothing is requested and nothing is shown, and a button that
      // says "watch an advertisement" to somebody reading the screen with their ears is simply untrue.
      el.goldAd.setAttribute('aria-label', ads.isAd() ? 'Watch an advertisement for gold' : 'Free gold');
    }
    el.purse.title = `${gfmt(gold)} gold`;
    el.purseNo.textContent = gpurse(win ? win.from : gold);
    if (!win) { el.purse.classList.remove('is-won'); return; }
    el.purse.classList.add('is-won');
    SFX.win(); vibe([0, 40, 60, 120]); goldRain(80, true);
    countTo(el.purseNo, win.from, win.to, 1300);
    setTimeout(() => el.purse.classList.remove('is-won'), 1600);
  }

  // Quitting a challenge is giving the board up: the stake stays in the pot and the others carry on without you.
  async function leaveMatch() {
    const m = state.daily?.match;
    if (!m) return;
    if (!await ask({ title: 'Leave the challenge?', body: `Your ${gfmt(m.stake)} gold stays in the pot and the others play on.`,
      ok: 'Leave the board', cancel: 'Keep playing', danger: true })) return;
    stopProgressPoll(); stopTimer();
    state.finished = true; state.busy = true;
    try { const d = await matchApi('result', { code: m.code, ms: 0, cleared: false, gave_up: true }); setGold(d.gold); }
    catch { /* the day's sweep counts a run that never came back as a loss anyway */ }
    goToLevels();
    toast('You left the challenge.');
  }

  // The corner button on the home screen is the settings mark for a stranger and the player's own face once
  // they are signed in: the face is the sign-in, and it opens the same page.
  const homeCorner = $('#aaSettings');
  const homeCornerMark = homeCorner ? homeCorner.innerHTML : '';
  function renderHomeCorner() {
    if (!homeCorner) return;
    if (auth.user) {
      homeCorner.classList.add('has-face');
      homeCorner.innerHTML = `<span class="aa-row-face aa-home-face${faceClass(auth.user)}">${faceInner(auth.user)}</span>`;
      homeCorner.setAttribute('aria-label', `Settings · ${auth.user.name || 'Player'}`);
      wireFaces(homeCorner);
    } else {
      homeCorner.classList.remove('has-face');
      homeCorner.innerHTML = homeCornerMark;
      homeCorner.setAttribute('aria-label', 'Settings');
    }
  }
  function renderAccountRow() {
    renderHomeCorner();
    if (!el.accountGroup) return;
    el.accountGroup.hidden = !auth.user;
    if (el.accountCap) el.accountCap.hidden = !auth.user;
    // Sign out lives at the bottom of the page now, next to the things that end an account rather than at the
    // top where it is the first thing under a player's own name. It still comes and goes with the account.
    if (el.sessionGroup) el.sessionGroup.hidden = !auth.user;
    if (el.sessionCap) el.sessionCap.hidden = !auth.user;
    if (el.deleteAccBtn) el.deleteAccBtn.hidden = !auth.user;   // it sits under Leaving, beneath Sign out
    if (!auth.user) return;
    // The player's own picture, the same one the line-up over the board uses, so the row shows who is signed in
    // rather than a face that is the same for everybody. No picture, or one whose link has expired: their initial.
    if (el.accountFace) {
      el.accountFace.className = 'aa-row-ico aa-row-face' + faceClass(auth.user);
      el.accountFace.innerHTML = faceInner(auth.user);
      wireFaces(el.accountFace);
    }
    // The name is the headline, because it is the name everybody else sees and the one thing here a player can
    // change; how they signed in is the small print under it.
    if (el.accountName) el.accountName.textContent = auth.user.name || 'Player';
    el.accountWho.textContent = `Signed in with ${(auth.user.provider || 'google').replace(/^./, c => c.toUpperCase())}`;
    el.accountGold.className = 'aa-gold';
    el.accountGold.title = `${gfmt(auth.user.gold)} gold`;
    el.accountGold.innerHTML = `${COIN}${gpurse(auth.user.gold)}`;
  }
  // Google supplies a name; it is not always the one somebody wants over a board. This is the only thing in
  // the game a player types, and it happens where they are already looking — the row itself opens into a field,
  // rather than a card over a screen they are not on.
  function showRenameRow() {
    if (!auth.user || !el.accountGroup || $('#aaNameEdit', el.accountGroup)) return;
    if (el.accountRow) el.accountRow.hidden = true;
    el.accountGroup.insertAdjacentHTML('beforeend', `
      <div class="aa-row aa-row--edit" id="aaNameEdit">
        <input class="aa-input" id="aaNameIn" type="text" maxlength="24" value="${escapeHtml(auth.user.name || '')}" aria-label="Your name" autocomplete="off" spellcheck="false">
        <small>The name over the board, on the result sheet and in the league.</small>
        <span class="aa-edit-go">
          <button type="button" class="aa-btn aa-btn--small aa-btn--primary" id="aaNameSave">Save</button>
          <button type="button" class="aa-btn aa-btn--small aa-btn--ghost" id="aaNameCancel">Cancel</button>
        </span>
      </div>`);
    const input = $('#aaNameIn', el.accountGroup);
    input?.focus({ preventScroll: true });
    input?.select();
    input?.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); saveName(); }
      if (e.key === 'Escape') closeRenameRow();
    });
    $('#aaNameSave', el.accountGroup)?.addEventListener('click', saveName);
    $('#aaNameCancel', el.accountGroup)?.addEventListener('click', closeRenameRow);
  }
  function closeRenameRow() {
    $('#aaNameEdit', el.accountGroup)?.remove();
    if (el.accountRow) el.accountRow.hidden = false;
  }
  async function saveName() {
    const input = $('#aaNameIn', el.accountGroup), btn = $('#aaNameSave', el.accountGroup);
    const name = (input?.value || '').trim();
    if (!name) { toast('A name cannot be empty.', 'bad'); input?.focus(); return; }
    if (name === auth.user?.name) { closeRenameRow(); return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const d = await authApi('name', { name });
      if (d.user) auth.user = d.user;
      closeRenameRow();
      renderAccountRow(); renderPurse();
      forgetRecent();                       // the name on everybody else's list is this one
      toast('That is your name now.', 'good');
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
      toast(err.code === 'empty_name' ? 'A name cannot be empty.'
        : err.code === 'rate_limited' ? 'Too many changes just now. Try again in a minute.'
        : 'Could not save that name.', 'bad');
    }
  }
  el.accountRow?.addEventListener('click', () => { if (auth.user) showRenameRow(); });

  el.signOutBtn?.addEventListener('click', async () => {
    // The session goes, and the device keeps its notifications as its own: the token or subscription is
    // posted again with no account behind it, so the evening nudge still comes and the account's invitations
    // and league stop by themselves.
    try { await authApi('logout', {}); } catch { /* the cookie may already be gone */ }
    auth.user = null; live.close(); renderAccountRow(); renderNotify(); closeSheets(); toast('Signed out.');
    await notifyRelease();
  });
  el.deleteAccBtn?.addEventListener('click', async () => {
    if (!await ask({ title: 'Delete your account?', body: 'Your gold and any matches go with it. The progress on this device stays.',
      ok: 'Delete it', cancel: 'Keep my account', danger: true })) return;
    await notifyDrop();   // the rows go with the account anyway; the browser's own subscription does not
    try { await authApi('delete', {}); auth.user = null; renderAccountRow(); renderNotify(); closeSheets(); toast('Account deleted.'); }
    catch { toast('Could not delete the account. Please try again.', 'bad'); }
  });

  // The board is over: tell the server, then show where the gold went. Clearing it first pays first place on
  // the spot, and second and third as they come in; anyone finishing after that is playing for a place on the list, not for gold.
  //
  // A phone on a bad connection must not cost somebody the pot for a blink of a dropped request, so the result
  // is tried a few times, kept on the device if it still will not go, and sent again on the next visit. Only a
  // straight refusal from the server stops the retrying: asking again cannot change that answer.
  const PENDING = 'pendingResult';
  async function sendResult(code, ms, cleared, gaveUp = false) {
    let last;
    for (let i = 0; i < 3; i++) {
      try { return await matchApi('result', { code, ms, cleared, gave_up: gaveUp }); }
      catch (err) {
        last = err;
        if (err.code) break;
        await new Promise(r => setTimeout(r, 500 * (i + 1)));
      }
    }
    throw last;
  }
  const resultTrouble = err =>
    err?.code === 'signed_out' ? 'This device is signed out, so your time was not counted. Sign in and send it again.'
    : err?.code === 'not_yours' ? 'This match is not yours to report a time for.'
    : err?.code === 'no_match' ? 'That match is not there any more.'
    : `Your time has not reached the server yet${/^HTTP \d+$/.test(err?.message || '') ? ` (${err.message})` : ''}. It is kept on this device and sent again on your next visit.`;

  async function finishMatch(cleared, ms, gaveUp = false) {
    const R = state.daily;
    if (!R?.match) return;
    stopProgressPoll();
    const before = auth.user?.gold ?? 0;
    const sent = { code: R.match.code, ms: Math.max(0, Math.round(ms) || 0), cleared: !!cleared, gave_up: !!gaveUp };
    try {
      const d = await sendResult(sent.code, sent.ms, sent.cleared, sent.gave_up);
      store.set(PENDING, null);
      setGold(d.gold);
      renderRanks(d.match.players);
      el.overlay.hidden = true;
      showMatchState(d.match, before);
      watchResult(sent.code, d.match);
    } catch (err) {
      store.set(PENDING, sent);   // it goes with the device until it gets through
      el.card.innerHTML = `<h3>${cleared ? 'Board cleared!' : 'Out of hearts'}</h3>
        <p class="aa-card-lead">${resultTrouble(err)}</p>
        <div class="aa-actions">
          <button type="button" class="aa-btn aa-btn--primary" data-act="resend">Send it again</button>
          <button type="button" class="aa-btn" data-act="levels">World Tour</button>
        </div>`;
      showCard();
    }
  }

  // A time that never got through, tried again: on the next visit, or when the player asks.
  async function flushResult(loud) {
    const p = store.get(PENDING, null);
    if (!p?.code) return false;
    try {
      const d = await sendResult(p.code, p.ms, p.cleared, p.gave_up);
      store.set(PENDING, null);
      if (typeof d.gold === 'number') setGold(d.gold);
      if (loud) { el.overlay.hidden = true; showMatchState(d.match, (auth.user?.gold ?? 0) - (d.match?.you_won ? d.match.pot : 0)); }
      else if (d.match?.you_won) toast(`Your time got through. You won ${gpurse(d.match.pot)} gold.`, 'good', 5000);
      return true;
    } catch (err) {
      if (loud) { const n = $('.aa-card-lead', el.card); if (n) n.textContent = resultTrouble(err); }
      return false;
    }
  }

  // Winning gold should land like winning gold: coins rain, the purse counts up, the badge pops.
  const GOLD_COLORS = ['#FFD34D', '#FFB300', '#FFE9A3', '#E7A100'];
  function goldRain(n = 90, overSheet = false) {
    const c = el.confetti; if (!c) return;
    if (overSheet) {
      if (c.parentNode !== document.body) document.body.appendChild(c);   // the board is hidden in the lobby
      c.classList.add('is-over'); c.width = innerWidth; c.height = innerHeight;
    }
    const r = overSheet ? { width: document.body.offsetWidth, height: document.body.offsetHeight } : rectOf(el.boardWrap);
    const list = [];
    for (let i = 0; i < n; i++) {
      const p = particle(Math.random() * r.width, -20 - Math.random() * r.height * 0.4, (Math.random() - 0.5) * 2, 1 + Math.random() * 3);
      p.color = GOLD_COLORS[Math.floor(Math.random() * GOLD_COLORS.length)];
      p.round = true; p.w = 9 + Math.random() * 9; p.h = p.w; p.g = 0.16 + Math.random() * 0.12; p.ttl = 110 + Math.random() * 60;
      list.push(p);
    }
    fxEmit(list);
  }
  function countTo(node, from, to, ms = 1100) {
    if (!node) return;
    const box = node.closest('.aa-gold, .aa-chip--purse');
    const t0 = performance.now(), span = to - from;
    const step = now => {
      const k = Math.min(1, (now - t0) / ms), eased = 1 - Math.pow(1 - k, 3);
      const v = Math.round(from + span * eased);
      node.textContent = gpurse(v);
      if (box) box.title = `${gfmt(v)} gold`;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ── Particles: one canvas over the board, one animation loop, several emitters ──
  const fx = { parts: [], running: false };
  const particle = (x, y, vx, vy) => ({ x, y, vx, vy, g: 0.3 + Math.random() * 0.2, w: 5 + Math.random() * 7, h: 3 + Math.random() * 4, rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3, round: Math.random() < 0.3, color: PALETTE[Math.floor(Math.random() * PALETTE.length)], life: 1, ttl: 70 + Math.random() * 40 });
  function fxEmit(list) {
    const c = el.confetti; if (!c || !c.getContext) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      if (c.classList.contains('is-over')) { c.classList.remove('is-over'); el.boardWrap.appendChild(c); }
      return;
    }
    if (!fx.running && !c.classList.contains('is-over')) { const r = rectOf(el.boardWrap); c.width = Math.round(r.width); c.height = Math.round(r.height); }
    c.hidden = false; fx.parts.push(...list);
    if (fx.running) return;
    fx.running = true;
    const ctx = c.getContext('2d'); let last = performance.now();
    (function frame(now) {
      const dt = Math.min(2, (now - last) / 16.7); last = now;
      ctx.clearRect(0, 0, c.width, c.height);
      fx.parts = fx.parts.filter(p => {
        p.life -= dt / p.ttl; if (p.life <= 0 || p.y > c.height + 20) return false;
        p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= Math.pow(0.985, dt); p.rot += p.vr * dt;
        ctx.globalAlpha = Math.min(1, p.life * 2); ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.color;
        if (p.round) { ctx.beginPath(); ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2); ctx.fill(); } else ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore(); return true;
      });
      if (fx.parts.length) requestAnimationFrame(frame); else { ctx.clearRect(0, 0, c.width, c.height); c.hidden = true; if (c.classList.contains('is-over')) { c.classList.remove('is-over'); el.boardWrap.appendChild(c); } fx.running = false; }
    })(last);
  }
  // Level won: a fountain from the middle of the board.
  function confetti() {
    const W = el.boardWrap.clientWidth, H = el.boardWrap.clientHeight;
    fxEmit(Array.from({ length: 120 }, () => particle(W / 2 + (Math.random() - 0.5) * W * 0.4, H * 0.45, (Math.random() - 0.5) * 14, -Math.random() * 12 - 4)));
  }
  // Combo or long shot: streamers fly in from both edges of the screen, more and faster the higher the level (0-3).
  function sideBurst(level) {
    const W = el.boardWrap.clientWidth, H = el.boardWrap.clientHeight, n = 14 + level * 8, list = [];
    for (const side of [0, 1]) for (let k = 0; k < n; k++) {
      const y = H * (0.2 + Math.random() * 0.6), speed = 7 + Math.random() * 7 + level * 1.5, ang = (Math.random() - 0.5) * 0.9, dir = side ? -1 : 1;
      list.push(particle(side ? W + 6 : -6, y, dir * speed * Math.cos(ang), -Math.abs(speed * Math.sin(ang)) - 2));
    }
    fxEmit(list);
  }

  // Settings → Home country: a list of every country (canonical order), plus Auto
  // The home country is picked on a page of its own -- Settings → Home country → a list with a search box and
  // a Back button -- rather than in a <select>. The WebView drew that as a native list the height of the
  // screen with no way out but the system gesture, and nobody scrolls 197 names when they can type three letters.
  const HOME_AUTO = 'auto';
  const homeValue = () => { const h = store.get('home', null); return h == null ? HOME_AUTO : h; };
  const homeChoices = () => [
    { v: HOME_AUTO, name: 'Auto (where you are)' },
    { v: '', name: 'World order (no home)' },
    ...DATA.canon.slice().sort((a, b) => a.name.localeCompare(b.name)).map(L => ({ v: L.a2, name: L.name })),
  ];
  function renderHome() {
    if (!DATA) return;
    const cur = homeValue();
    const now = homeChoices().find(c => c.v === cur);
    if (el.homeNow) el.homeNow.textContent = cur === HOME_AUTO ? `Auto · ${firstCountry()?.name || 'where you are'}` : now ? now.name : 'Your tour starts here and spreads out';
    if (el.homeSheet && !el.homeSheet.hidden) renderHomeList();
  }
  function renderHomeList() {
    if (!el.homeList || !DATA) return;
    const q = (el.homeSearch?.value || '').trim().toLowerCase(), cur = homeValue();
    const rows = homeChoices().filter(c => !q || c.name.toLowerCase().includes(q));
    el.homeList.innerHTML = rows.length
      ? rows.map(c => `<button type="button" class="aa-row aa-row--link aa-row--pick${c.v === cur ? ' is-on' : ''}" data-home="${escapeHtml(c.v)}" role="radio" aria-checked="${c.v === cur}"><span class="aa-row-label">${escapeHtml(c.name)}</span><span class="aa-radio" aria-hidden="true"></span></button>`).join('')
      : '<p class="aa-home-none">No country by that name.</p>';
  }
  function openHomePage() {
    if (!el.homeSheet) return;
    if (el.homeSearch) el.homeSearch.value = '';
    renderHomeList();
    openSheet(el.homeSheet);           // over Settings, which stays where it was for Back
    // The chosen row is brought into view, not the search box: a keyboard that opens by itself covers the list.
    $('.aa-row--pick.is-on', el.homeList)?.scrollIntoView({ block: 'center' });
  }
  const closeHomePage = () => { if (el.homeSheet) el.homeSheet.hidden = true; };
  el.homeRow?.addEventListener('click', openHomePage);
  el.homeBack?.addEventListener('click', closeHomePage);
  el.homeSearch?.addEventListener('input', renderHomeList);
  el.homeList?.addEventListener('click', async e => {
    const btn = e.target.closest('[data-home]'); if (!btn) return;
    const v = btn.dataset.home;
    await chooseHome(v);
    closeHomePage();
  });
  async function chooseHome(v) {
    if (v === 'auto') { try { localStorage.removeItem(STORE + 'home'); localStorage.removeItem(STORE + 'homeAuto'); } catch { /* ignore */ } const c = await homeCountry(DATA); DATA.levels = tourFor(DATA, c); maskCache.clear(); forgetNums(); renderSelect(); }
    else setHome(v);
    renderHome();
    toast(v === 'auto' ? 'Tour order follows where you are.' : v ? `Your tour now starts from ${firstCountry()?.name || 'there'}.` : 'Tour in world order.', 'hint');
  }
  // ── Board zoom: pinch with two fingers, drag to pan while zoomed, or the − ⤢ + buttons ──
  // On a Master board of 180 arrows a cell is ~9 px on a phone: zooming is how a tap lands on the arrow meant.
  const zoom = { s: 1, x: 0, y: 0, MIN: 1, MAX: 4, ptrs: new Map(), pinch: null, pan: null };
  function applyZoom() {
    const wrap = el.boardWrap, svg = el.board; if (!wrap || !svg) return;
    const bw = svg.clientWidth, bh = svg.clientHeight, ww = wrap.clientWidth, wh = wrap.clientHeight;
    void ww; void wh;
    // the scaled board may never leave its own frame: its edges stay outside (or on) the frame of the unzoomed board
    if (zoom.s <= 1.001) { zoom.s = 1; zoom.x = 0; zoom.y = 0; }
    else { zoom.x = Math.max(bw * (1 - zoom.s), Math.min(0, zoom.x)); zoom.y = Math.max(bh * (1 - zoom.s), Math.min(0, zoom.y)); }
    svg.style.transform = zoom.s === 1 ? '' : `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`;
    el.zoomBtns?.forEach(b => { b.disabled = (b.dataset.zoom === 'out' || b.dataset.zoom === 'fit') ? zoom.s === 1 : zoom.s >= zoom.MAX; });
  }
  // zoom by a factor around a point (in wrap coordinates, relative to the board's unscaled top-left)
  function zoomAt(factor, px, py) {
    const s0 = zoom.s, s1 = Math.max(zoom.MIN, Math.min(zoom.MAX, s0 * factor)); if (s1 === s0) return;
    zoom.x = px - (px - zoom.x) * (s1 / s0); zoom.y = py - (py - zoom.y) * (s1 / s0); zoom.s = s1; applyZoom();
  }
  function resetZoom() { zoom.s = 1; zoom.x = 0; zoom.y = 0; zoom.ptrs.clear(); zoom.pinch = null; zoom.pan = null; applyZoom(); }
  el.zoomBtns = $$('#aaZoom [data-zoom]');
  el.zoomBtns.forEach(b => b.addEventListener('click', () => {
    const svg = el.board; const cx = svg.clientWidth / 2, cy = svg.clientHeight / 2;   // around the centre of the board's frame
    if (b.dataset.zoom === 'fit') resetZoom(); else zoomAt(b.dataset.zoom === 'in' ? 1.6 : 1 / 1.6, cx, cy);
  }));
  if (el.boardWrap) {
    const wrap = el.boardWrap;
    wrap.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      { const q = ptOf(e); zoom.ptrs.set(e.pointerId, [q.x, q.y]); }
      if (zoom.ptrs.size === 2) {
        // remember the board point under the pinch centre (board-local, unscaled) and the frame's origin on screen
        const [a, b] = [...zoom.ptrs.values()]; const r = rectOf(el.board); const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        zoom.pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), s: zoom.s, left0: r.left - zoom.x, top0: r.top - zoom.y, qx: (mx - r.left) / zoom.s, qy: (my - r.top) / zoom.s }; zoom.pan = null;
      }
      else if (zoom.ptrs.size === 1 && zoom.s > 1) { const q = ptOf(e); zoom.pan = { x0: q.x, y0: q.y, zx: zoom.x, zy: zoom.y, moved: false }; }
    });
    wrap.addEventListener('pointermove', e => {
      if (!zoom.ptrs.has(e.pointerId)) return;
      { const q = ptOf(e); zoom.ptrs.set(e.pointerId, [q.x, q.y]); }
      if (zoom.pinch && zoom.ptrs.size === 2) {
        const [a, b] = [...zoom.ptrs.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]); const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        const s1 = Math.max(zoom.MIN, Math.min(zoom.MAX, zoom.pinch.s * d / Math.max(1, zoom.pinch.d)));
        // keep the board point under the pinch centre where the fingers are: screen = origin + x + q * s
        zoom.s = s1; zoom.x = (mx - zoom.pinch.left0) - zoom.pinch.qx * s1; zoom.y = (my - zoom.pinch.top0) - zoom.pinch.qy * s1; applyZoom();
      } else if (zoom.pan && zoom.ptrs.size === 1) {
        const q = ptOf(e); const dx = q.x - zoom.pan.x0, dy = q.y - zoom.pan.y0;
        if (!zoom.pan.moved && Math.hypot(dx, dy) < 12) return;   // a tap on an arrow is still a tap
        zoom.pan.moved = true; zoom.x = zoom.pan.zx + dx; zoom.y = zoom.pan.zy + dy; applyZoom();
      }
    });
    const up = e => { zoom.ptrs.delete(e.pointerId); if (zoom.ptrs.size < 2) zoom.pinch = null; if (!zoom.ptrs.size) zoom.pan = null; };
    wrap.addEventListener('pointerup', up); wrap.addEventListener('pointercancel', up);
    wrap.addEventListener('wheel', e => { if (!el.game || el.game.hidden) return; e.preventDefault(); const r = rectOf(el.board), q = ptOf(e); zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, q.x - r.left + zoom.x, q.y - r.top + zoom.y); }, { passive: false });
  }
  // ── The league ──
  //
  // Every week the gold won at the tables is counted and the ten who won the most are paid: tenth place takes
  // the base prize and every place above it doubles, so first takes it doubled nine times. The table, the
  // ladder and the week's end all come from the server — it counts from its own ledger, and a client that
  // guessed any of it would be showing a number nobody is going to be paid.
  //
  // What is worked out here is only the countdown, from the end the server gave: a clock that ticks without
  // asking again, and one request when the screen is opened.
  const league = { data: null, at: 0, tick: 0, view: 'now' };
  const leagueApi = () => apiCall(`${API_V1}/league`);

  // A table of ten seven-digit numbers is a wall. 5.12M is a prize.
  const gshort = n => {
    const v = Number(n) || 0, a = Math.abs(v), sign = v < 0 ? '-' : '';
    if (a >= 1e9) return `${sign}${(a / 1e9).toFixed(2).replace(/\.?0+$/, '')}B`;
    if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`;
    if (a >= 10000) return `${sign}${Math.round(a / 1000)}K`;
    return `${sign}${gfmt(a)}`;
  };
  // "2d 18h", then "18h 40m", then "9m": always two units while there are two, so the size of what is left
  // reads at a glance without the player doing arithmetic.
  function fmtLeft(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    return m ? `${m}m` : 'any moment';
  }
  const leagueLeft = () => league.data ? league.data.season.ends_at - Date.now() : 0;

  // The chip on the home screen is the way in, and it carries the countdown so the week is visible without
  // opening anything. It appears once the server has answered: a game whose API is unreachable should not be
  // showing a league that cannot be played.
  function renderLeagueChip() {
    if (!el.league) return;
    if (!league.data) { el.league.hidden = true; return; }
    el.league.hidden = false;
    // It used to count down here as well as inside. Two clocks for one week is one too many, and the word is
    // what a player is looking for when they want the table.
    el.leagueEnds.textContent = 'League';
    el.league.title = 'This week\u2019s league';
  }
  async function loadLeague(force) {
    if (!force && league.data && Date.now() - league.at < 30000) return league.data;
    try { league.data = await leagueApi(); league.at = Date.now(); league.failed = false; }
    catch { league.failed = true; /* the league is a screen, never the game: if it cannot be read, the chip simply stays away */ }
    renderLeagueChip();
    return league.data;
  }

  // ── Drawing it ──
  //
  // One table, the week's clock above it and the rules folded behind the question mark. Every row is a player
  // who played; the medals are on the places that are actually being paid, so a gold badge is a promise the
  // settlement keeps rather than a decoration on the first line. The pieces are the game's own — its faces,
  // its cards, its palette — because a screen that borrowed another game's art would look like a different game.
  const MEDAL = r => r === 1 ? ' is-g1' : r === 2 ? ' is-g2' : r === 3 ? ' is-g3' : r <= 10 ? ' is-prize' : '';
  const leagueRow = (r, prize, paid) => `
    <div class="aa-lg-row${r.you ? ' is-you' : ''}">
      <span class="aa-lg-medal${prize ? MEDAL(r.rank) : ''}">${r.rank}</span>
      <span class="aa-rank${faceClass(r)}" aria-hidden="true">${faceInner(r)}</span>
      <span class="aa-lg-who"><b>${escapeHtml(r.name || 'Player')}</b>${prize ? `<small>${paid ? 'won' : 'wins'} ${gshort(prize)}</small>` : ''}</span>
      <span class="aa-lg-earn${r.earning < 0 ? ' is-down' : ''}">${COIN}${gshort(r.earning)}</span>
    </div>`;
  // A prize belongs to a row only while that row is in front: the table holds everyone who played, so places
  // one to ten can be held by a player who is down on the week, and "wins 5.12M" under a losing line would be
  // a promise the settlement does not keep.
  const prizeOn = (r, prizes) => r.earning > 0 ? (prizes[r.rank - 1] || 0) : 0;

  function renderLeague() {
    if (!el.leagueBody) return;
    const d = league.data;
    if (!d) { el.leagueBody.innerHTML = `<p class="aa-loading">${league.failed ? 'The league could not be reached. Check your connection and open it again.' : 'Loading the league…'}</p>`; return; }
    const prizes = d.prizes || [], mine = d.me;
    const last = d.last && d.last.paid.length ? d.last : null;
    const showing = league.view === 'last' && last ? 'last' : 'now';

    // One line, not a card. There is a single league and the player is already looking at it, so a panel
    // announcing which one it is says only "the one you are in"; what is worth the space is the week's clock,
    // where the player stands, and the way back to last week's paid table.
    const mineLast = last && last.paid.find(r => r.you);
    const myPlace = showing === 'last' ? (mineLast ? mineLast.rank : null) : (mine && mine.rank);
    const bar = `
      <div class="aa-lg-bar">
        <span class="aa-lg-when">${showing === 'last' ? 'Last week, paid out' : `Ends in <b>${fmtLeft(leagueLeft())}</b>`}${myPlace ? ` · you are <b>#${myPlace}</b>` : ''}</span>
        ${last ? `<button type="button" class="aa-btn aa-btn--small aa-lg-results" data-lgact="${showing === 'last' ? 'now' : 'last'}">${showing === 'last' ? 'This week' : 'Results'}</button>` : ''}
      </div>`;

    const rows = showing === 'last' ? last.paid : (d.top || []);
    const table = rows.length
      ? `<div class="aa-group aa-lg-table" id="aaLeagueTable">
           <div class="aa-lg-head"><span>Rank</span><span>Player</span><span>Earning</span></div>
           ${rows.map(r => leagueRow(r, showing === 'last' ? r.gold : prizeOn(r, prizes), showing === 'last')).join('')}
         </div>`
      : `<p class="aa-sheet-note">Nobody has played for gold this week yet. The first match played is the first line in the table.</p>`;

    const meLine = showing === 'last' ? ''
      : !auth.user
        ? `<p class="aa-sheet-note">Sign in to play the gold tables and enter this week's league.</p>
           <p class="aa-lg-cta"><button type="button" class="aa-btn aa-btn--small" data-lgact="signin">Sign in</button></p>`
        : mine && mine.rank ? ''
        : `<p class="aa-sheet-note">Play a gold match — a friend's room or an online table — and you are in this week's table.</p>`;

    // Your own row, pinned to the foot of the sheet. A hundred places is a long scroll, and a player deep in
    // it should not have to find themselves to see where they stand — so it follows the scroll, and gets out
    // of the way when the real row is on screen (see wireLeaguePin).
    const pinRow = showing === 'last' ? mineLast : (mine && mine.rank ? { ...auth.user, rank: mine.rank, earning: mine.earning, you: true } : null);
    const pinned = auth.user && pinRow
      ? `<div class="aa-lg-pin" id="aaLeaguePin" hidden>${leagueRow(pinRow, showing === 'last' ? pinRow.gold : prizeOn(pinRow, prizes), showing === 'last')}</div>`
      : '';

    // What the places pay lives behind the question mark with the rest of the rules. It is a table of ten
    // numbers that never change: worth reading once, and worth the room on the screen never again.
    el.leagueBody.innerHTML = `
      ${bar}
      <div class="aa-lg-rules" id="aaLeagueRules" hidden>
        <p>Every gold match counts, a friend's room the same as an online table: play one and you are on the board. What you win, less the stakes you paid, is your earning for the week — so the table is what you are up over the week, and gold you were given does not count.</p>
        <p>When the week ends the top ten are paid, tenth place taking ${gshort(prizes[prizes.length - 1] || 0)} and every place above it doubling that, up to ${gshort(prizes[0] || 0)} for first. A week you end down on keeps your place on the board and pays nothing.</p>
        <p class="aa-cap aa-lg-cap">What the places pay</p>
        <div class="aa-lg-prizes">
          ${prizes.map((g, i) => `<div class="aa-lg-prize"><span class="aa-lg-medal${MEDAL(i + 1)}">${i + 1}</span><span>${COIN} ${gshort(g)}</span></div>`).join('')}
        </div>
      </div>
      ${meLine}
      ${table}
      ${pinned}`;
    wireFaces(el.leagueBody);
    wireLeaguePin();
  }

  // The pinned row hides itself while the real one is on screen: two copies of the same line, one right above
  // the other, reads as a bug rather than as help.
  let leaguePinWatch = null;
  function wireLeaguePin() {
    leaguePinWatch?.disconnect();
    leaguePinWatch = null;
    const pin = $('#aaLeaguePin', el.leagueBody);
    if (!pin) return;
    const row = $('#aaLeagueTable .aa-lg-row.is-you', el.leagueBody);
    const panel = el.leagueSheet?.querySelector('.aa-sheet-panel');
    if (!row || !panel || typeof IntersectionObserver !== 'function') { pin.hidden = false; return; }
    pin.hidden = false;
    leaguePinWatch = new IntersectionObserver(entries => { pin.hidden = entries[entries.length - 1].isIntersecting; },
      { root: panel, threshold: 0.75 });
    leaguePinWatch.observe(row);
  }

  async function openLeague() {
    closeSheets();
    league.view = 'now';
    openSheet(el.leagueSheet);
    renderLeague();                                   // with whatever is already known, at once
    await authLoad(true).catch(() => {});             // the prize may have landed while the game was closed
    await loadLeague(true);
    renderPurse(); renderAccountRow();
    renderLeague();
  }

  // The countdown is redrawn on a slow timer rather than on every frame: it changes by the minute at most.
  function startLeagueTick() {
    if (league.tick) return;
    league.tick = setInterval(() => {
      if (document.hidden) return;
      renderLeagueChip();
      if (el.leagueSheet && !el.leagueSheet.hidden) renderLeague();
      // the week has turned while the game was open: ask for the new one
      if (league.data && leagueLeft() <= 0) loadLeague(true).then(() => { if (el.leagueSheet && !el.leagueSheet.hidden) renderLeague(); });
    }, 30000);
  }

  // ── Wiring ──
  el.btnHint.addEventListener('click', hint);
  // The counter is not how a check is spent -- an arrow is. Tapping it says so, which is the only place in the
  // game that teaches the gesture, so it answers every time rather than once.
  el.btnCheck?.addEventListener('click', () => {
    const left = checksLeftNow();
    if (left <= 0 && adCanOffer('check')) { adOffer('check'); return; }   // the plus is the offer; tapping it takes it
    toast(left > 0
      ? `Press and hold an arrow to see whether its lane is clear. ${left} ${left === 1 ? CHECK_WORD : CHECK_WORD + 's'} left.`
      : `No ${CHECK_WORD}s left on this level.`, left > 0 ? 'hint' : 'bad');
  });
  el.play.addEventListener('click', () => startLevel(+el.play.dataset.level || 0));
  // Sheets
  const openSheet = sh => { sh.hidden = false; document.body.style.overflow = 'hidden'; };
  const closeSheets = () => { stopResultWatch(); if (el.trainSheet) { el.trainSheet.hidden = true; trainLeave(); } el.sheet.hidden = true; if (el.homeSheet) el.homeSheet.hidden = true; if (el.signInSheet) el.signInSheet.hidden = true; if (el.matchSheet) el.matchSheet.hidden = true; if (el.leagueSheet) el.leagueSheet.hidden = true; document.body.style.overflow = ''; };
  el.settingsBtns.forEach(b => b.addEventListener('click', () => {
    openSheet(el.sheet);
    renderAccountRow();                                   // with what the page already knows, at once
    renderNotify();
    renderDev();
    authLoad(true).then(() => { renderAccountRow(); renderPurse(); syncTour(); void loadMuted(); return notifyInit(); }).catch(() => {});   // then with the server's answer, tour included
  }));
  el.friends?.addEventListener('click', openFriends);
  el.league?.addEventListener('click', openLeague);
  el.leagueBody?.addEventListener('click', e => {
    const act = e.target.closest('[data-lgact]')?.dataset.lgact;
    if (act === 'signin') { closeSheets(); openSignIn('Sign in to play the gold tables and enter this week\'s league.'); return; }
    // Results swaps the table for last week's paid one, and back: two weeks on one screen would crowd both.
    if (act === 'last' || act === 'now') { league.view = act; renderLeague(); el.leagueSheet.querySelector('.aa-sheet-panel').scrollTop = 0; }
  });
  el.leagueInfo?.addEventListener('click', () => {
    const box = $('#aaLeagueRules', el.leagueBody);
    if (box) { box.hidden = !box.hidden; el.leagueInfo.setAttribute('aria-expanded', String(!box.hidden)); }
  });
  $$('[data-close-sheet]').forEach(b => b.addEventListener('click', closeSheets));
  $$('.aa-sheet').forEach(sh => sh.addEventListener('click', e => { if (e.target === sh) closeSheets(); }));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheets(); });
  // Themes
  const THEMES = ['paper', 'night', 'mint'];
  // The splash mark is the rose one everywhere but Night, where the dark one is inverted to white by the stylesheet.
  function applyTheme(t) { document.documentElement.dataset.theme = t; store.set('theme', t); $('meta[name="theme-color"]')?.setAttribute('content', t === 'night' ? '#0E0E10' : t === 'mint' ? '#E6F2EC' : '#F4EDE0'); $('.aa-splash-logo img')?.setAttribute('src', t === 'night' ? '/images/puzzle-brain-mark.svg?v=2' : '/images/puzzle-brain-mark-rose.svg?v=1'); renderThemes(); }
  // ── The build line, and the developer switch behind it ────────────────────────────────────────────
  //
  // The version is not hardcoded: it is the one the page asked for, read back off the script tag, so it can
  // never drift from what is actually running. Saying whether this is the app is worth as much again — the
  // first question about any report is which of the two it came from.
  const BUILD = (() => {
    try { return new URL($('script[src*="js/puzzle.js"]')?.src || '').searchParams.get('v') || '?'; }
    catch { return '?'; }
  })();

  /**
   * What the developer switch is for.
   *
   * Off is what every player gets. Test is the stand-in panel: the whole flow — the offer, the wait, the
   * reward, the refusals — with nothing asked of any network, which is the only way to judge how it feels
   * before a network will answer at all. Live asks for the real thing, on this device and no other, which is
   * what makes approval day a check rather than a leap: flip it here, watch one, then flip data-give for
   * everybody.
   */
  // Where the developer settings may exist at all: a page served from this machine, or the app's debug build.
  // Anywhere else -- the site, the release build -- the seven taps do nothing and a flag left over from
  // before is ignored, because a switch anybody can find is not a developer's switch.
  function devAllowed() { return location.hostname === 'localhost' || location.hostname === '127.0.0.1' || shell.debug; }   // a declaration: adsConfigure runs before this line is reached
  function renderDev() {
    const on = devAllowed() && !!store.get('adsdev', '');
    if (el.devCap) el.devCap.hidden = !on;
    if (el.devGroup) el.devGroup.hidden = !on;
    if (!on || !el.devAds) return;
    const stored = store.get('adsdev', '');
    const cur = ADS_DEV.includes(stored) ? stored : 'site';
    el.devAds.innerHTML = '';
    for (const [m, label] of [['site', 'Default'], ['test', 'Test'], ['mock', 'Mock'], ['h5', 'Live']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'aa-dev-opt' + (m === cur ? ' is-active' : '');
      b.textContent = label;
      // A reload, because the modes are read once on the way in and a half-configured advertising library is
      // a worse thing to debug than a second of black.
      b.addEventListener('click', () => { store.set('adsdev', m); location.reload(); });
      el.devAds.appendChild(b);
    }
    if (el.devAdsNote) el.devAdsNote.textContent = cur === 'h5'
      ? 'Real advertisements, on this device only. Put the phone in AdMob test devices first.'
      : cur === 'mock' ? 'Google\u2019s own test advertisements, through the real library. Nothing leaves the phone, and it refuses every other break on purpose.'
      : cur === 'test' ? 'A stand-in panel. The same flow and the same reward, with no network asked.'
      : 'Whatever the page says \u2014 the same as every player gets.';
    renderDevLast();
    renderDevTools();
  }

  // The last break, in one line. "puzzle-heart \u00b7 nothing to show \u00b7 noAdPreloaded \u00b7 0.4s" is the
  // difference between guessing and knowing, and Settings is the only screen on a phone that can hold it.
  function renderDevLast() {
    if (!el.devLast) return;
    const lib = ads.mode !== 'h5' ? 'Library not in use'
      : ads.libReady ? `Library ready in ${(ads.libReady / 1000).toFixed(1)}s`
      : 'Library has not reported ready';
    const L = ads.last;
    if (!L) { el.devLast.textContent = `${lib} \u00b7 nothing asked for yet`; return; }
    if (L.how === 'asked') { el.devLast.textContent = `${lib} \u00b7 ${L.name} \u00b7 asked for, still waiting`; return; }
    const said = L.how === 'watched' ? 'watched through' : L.how === 'dismissed' ? 'closed early'
      : L.how === 'asked' ? 'asked for, still waiting' : 'nothing to show';
    el.devLast.textContent = `${lib} \u00b7 ${L.name} \u00b7 ${said}${L.why ? ` \u00b7 ${L.why}` : ''} \u00b7 ${(L.ms / 1000).toFixed(1)}s`;
  }

  // One button, and only inside the app: Google publishes a page that reports whether this WebView is
  // actually joined to the Mobile Ads SDK. Green there means registerWebView worked and anything still
  // missing is on the account side; red means the fault is ours and no amount of waiting fixes it. There is
  // no other way to tell those two apart from a phone.
  function renderDevTools() {
    if (!el.devTools) return;
    el.devTools.innerHTML = '';
    if (!shell.on) { el.devTools.hidden = true; return; }
    el.devTools.hidden = false;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'aa-dev-opt';
    b.textContent = 'Check the ad connection';
    b.addEventListener('click', async () => {
      const r = await shell.ask('adTest');
      if (!r?.ok) toast('This app is too old for that check. Install the latest build.', 'bad', 3600);
    });
    el.devTools.appendChild(b);
  }

  if (el.build) {
    // The build number is for a developer, and it shows only where one is: localhost or the debug app. Players
    // see nothing under the credit line, and there is nothing there for anybody to tap seven times.
    el.build.hidden = !devAllowed();
    el.build.textContent = `Build ${BUILD}${shell.on ? ' · app' : ''}`;
    let taps = 0, tapTimer = null;
    el.build.addEventListener('click', () => {
      clearTimeout(tapTimer);
      tapTimer = setTimeout(() => { taps = 0; }, 1500);
      if (++taps < 7) return;
      taps = 0;
      if (!devAllowed()) return;   // players' devices: nothing happens, and nothing says so
      if (!store.get('adsdev', '')) store.set('adsdev', 'site');
      renderDev();
      el.devGroup?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast('Developer settings are on.', 'good');
    });
  }

  // The way back: the switch is a per-device flag, and until now the only way to lose it was to clear the
  // browser's storage. Forgetting it puts the device back on exactly what every player gets; a reload,
  // because the modes are read once on the way in.
  el.devHide?.addEventListener('click', () => { try { localStorage.removeItem(STORE + 'adsdev'); } catch { /* ignore */ } location.reload(); });
  function renderThemes() {
    if (!el.themes) return;
    const cur = document.documentElement.dataset.theme || 'paper';
    el.themes.innerHTML = '';
    for (const t of THEMES) { const b = document.createElement('button'); b.type = 'button'; b.className = 'aa-theme' + (t === cur ? ' is-active' : ''); b.dataset.theme = t; b.textContent = t[0].toUpperCase() + t.slice(1); b.addEventListener('click', () => applyTheme(t)); el.themes.appendChild(b); }
  }
  el.themeBtn.addEventListener('click', () => { const cur = document.documentElement.dataset.theme || 'paper'; applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]); });
  applyTheme(THEMES.includes(store.get('theme')) ? store.get('theme') : 'paper');
  // Leaving a board is always asked about now. It used to be asked about only once an arrow had been
  // cleared, so walking out of a board a player had been staring at for a minute — the part that costs
  // something on a hard one — took one tap and said nothing.
  el.btnLevels.addEventListener('click', async () => {
    if (state.daily?.race && state.daily.match && !state.finished) { leaveMatch(); return; }
    if (state.pieces.length && !state.finished && !await ask({
      title: 'Leave this board?', body: 'It starts again from the beginning next time, with your hearts back.',
      ok: 'Leave the board', cancel: 'Keep playing' })) return;
    goToLevels();
  });
  // ── The app's Back button ──
  // In the app, Android's Back arrives here over the bridge, because the page has no history for the WebView
  // to walk: it routes with replaceState, and a sheet is an element that is shown. So the page does what the
  // ✕ or the corner arrow would -- one layer at a time: the open question, the Home page, a sheet, the board
  // (with its "Leave this board?" where that applies) -- and when nothing is open it says so, and the app
  // steps into the background.
  function backPressed() {
    if (askClose) { askClose(); return; }
    if (el.homeSheet && !el.homeSheet.hidden) { closeHomePage(); return; }
    if (el.trainSheet && !el.trainSheet.hidden) { if (el.trainSheet.classList.contains('is-playing')) void trainBack(); else closeSheets(); return; }
    if ([el.sheet, el.signInSheet, el.matchSheet, el.leagueSheet].some(s => s && !s.hidden)) { closeSheets(); return; }
    if (!el.game.hidden) { el.btnLevels.click(); return; }
    shell.ask('leave', 2000);
  }
  let shellWired = null;   // the bridge object already listened to (a new page gets a new one)
  function shellListen() {
    const b = shell.bridge();
    if (!b || b === shellWired) return;
    try { b.addEventListener('message', e => { let d; try { d = JSON.parse(e.data); } catch { return; } if (d && d.event === 'back') backPressed(); }); } catch { return; }
    shellWired = b;
    shell.ask('hello', 4000).then(d => { if (d?.ok) shell.caps = d; });   // so the app holds a way to reach this page, and the page knows what the app can do
  }
  if (shell.on) { shellListen(); window.addEventListener('load', shellListen); setTimeout(() => { void notifyFirstAsk(); }, 400); }
  el.btnSound.addEventListener('click', () => { state.muted = !state.muted; store.set('muted', state.muted); renderSound(); if (!state.muted) SFX.shoot(); });
  el.btnVibe?.addEventListener('click', () => { state.vibe = !state.vibe; store.set('vibe', state.vibe); renderToggles(); vibe(20); });
  // Turning music on while standing in the lobby does not start it: it starts on the next board, the same as
  // it would have if it had been on all along.
  el.btnMusic?.addEventListener('click', () => { state.music = !state.music; store.set('music', state.music); renderToggles(); if (state.music) { if (!el.game.hidden) musicStart(); } else musicStop(); });
  // Browsers only allow sound after a gesture: the first tap anywhere starts the pad (if Music is on).
  // Not a start: a rescue. If the browser would not let the context run when the board began, the next tap on
  // the board is a gesture it will accept, and the music that was built silently comes up then.
  document.addEventListener('pointerdown', () => { try { if (music.on && audio?.state === 'suspended') audio.resume(); } catch { /* ignore */ } }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    live.away(document.hidden);   // an invitation while hidden rings the phone instead of landing on a tab nobody sees
    if (document.hidden) { musicStop(); heartbeatStop(); deckStop(); return; }
    syncIfStale();                        // what another device cleared meanwhile, and what this one owes
    if (!el.select.hidden) deckStart();   // the home deck turns while somebody is looking at it, and not otherwise
    // Back on a board that was left mid-play. Nothing else restarts it now that music begins with a board
    // rather than with the first tap anywhere, so coming back is its own beginning.
    if (state.music && !el.game.hidden && !state.finished) musicStart();
    // And a board still standing on its last heart is still standing on its last heart.
    if (!el.game.hidden && !state.finished && state.lives === 1 && state.startedAt) heartLost();
  });
  el.btnGuides?.addEventListener('click', () => { state.guides = !state.guides; store.set('guides', state.guides); renderToggles(); });
  // Reset progress used to be here. It wiped this device, which made sense when this device was the only place
  // a tour existed. It is not any more: the account holds it, so clearing local storage would have deleted
  // nothing and then re-downloaded it on the next sync — a button that looks destructive and does nothing.
  renderToggles();
  renderDev();
  document.addEventListener('keydown', e => { if (!el.game.hidden && !state.finished && (e.key === 'h' || e.key === 'H') && !/input|textarea/i.test(document.activeElement?.tagName || '')) hint(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && state.startedAt && !state.raceBase && !state.finished) { stopTimer(); } });

  // ── Upright ──
  // The game is a column and stays one, however the phone is held. An installed copy is held there by the
  // manifest ("orientation": "portrait"), and where a browser lets a page ask — installed or fullscreen — the
  // orientation is locked outright, which is the best answer: the screen never turns at all.
  //
  // A plain tab cannot be locked by anybody. It used to say so and stop, with a notice asking for the phone
  // back, and that is the wrong answer: somebody lying on their side did not turn the phone, they turned
  // themselves, and being told to sit up by a puzzle game is not a reasonable thing to be told. So the page
  // turns back instead. The body is given the portrait box it wants and rotated by exactly the angle the
  // browser rotated it, the other way, which leaves the game on the same glass it was on a moment ago —
  // nothing moves under the thumb, the clock does not stop, and the board being played is the board still
  // being played.
  //
  // `turn.dir` is what the page was turned by: -90 for a screen the browser rotated one way, 90 for the
  // other, 0 for upright. Everything that follows a finger reads through ptOf/rectOf below, which are the
  // identity while it is 0 — so a phone held upright, and every desktop, runs exactly the code it always did.
  try { screen.orientation?.lock?.('portrait')?.catch?.(() => {}); } catch { /* a tab may not ask */ }
  const sideways = matchMedia('(orientation:landscape) and (max-height:560px) and (pointer:coarse)');
  function onTurn() {
    // 90 means the screen was turned one way, 270 (or -90) the other; anything else is upright enough.
    const a = ((screen.orientation?.angle ?? window.orientation ?? 0) % 360 + 360) % 360;
    turn.dir = !sideways.matches ? 0 : a === 90 ? -90 : a === 270 ? 90 : 0;
    const r = document.documentElement.classList;
    r.toggle('is-turned', turn.dir !== 0);
    r.toggle('is-turned-ccw', turn.dir === -90);
    r.toggle('is-turned-cw', turn.dir === 90);
    trainRefit();   // a round in hand is fitted to the page's new shape
  }
  sideways.addEventListener?.('change', onTurn);
  screen.orientation?.addEventListener?.('change', onTurn);
  window.addEventListener('orientationchange', onTurn);
  window.addEventListener('resize', onTurn);
  onTurn();

  // ── First open: welcome and terms. Every launch: the logo and a line to set the mood ──
  const QUOTES = [
    'Endless scrolling has shrunk your attention span? Play 30 minutes a day for 21 days and watch your focus come back.',
    'Your brain has learned to skim. Teach it to look again: one board, one right move at a time.',
    '21 days. 30 minutes a day. One country at a time. That is how focus is rebuilt.',
    'No feed, no noise, no timer. Just you, a map and the next clear move.',
    'Attention is a muscle. Every board you clear is one more rep.',
    'Cannot sit with one thing for ten minutes any more? Start with one board tonight.',
    'Play a board before bed instead of the feed. Wind down, then sleep well.',
    'Look before you tap. Patience clears more boards than speed.',
  ];
  // The launch splash holds the screen for a couple of seconds with a line about focus. A match the account is
  // in the middle of is more urgent than the line, so finding one cuts the splash short: this is the handle.
  let splashSkip = null;
  function showSplash(then) {
    if (!el.splash) { then?.(); return; }
    // On a first open the welcome comes before this, and the account can have been asked and a match found
    // while the welcome was being read. A board already on the screen is not covered with a line about focus.
    if (resumedCode && !el.game.hidden) { then?.(); return; }
    const n = store.get('launches', 0); store.set('launches', n + 1);
    el.splashQuote.textContent = QUOTES[n % QUOTES.length];
    el.splash.hidden = false;
    let done = false;
    const finish = () => { if (done) return; done = true; splashSkip = null; el.splash.classList.add('is-out'); setTimeout(() => { el.splash.hidden = true; el.splash.classList.remove('is-out'); then?.(); }, 240); };
    splashSkip = finish;
    el.splash.addEventListener('click', finish, { once: true });
    setTimeout(finish, 2400);
  }
  function showGate(then) {
    if (!el.gate) { then?.(); return; }
    el.gate.hidden = false;
    el.accept.addEventListener('click', () => { store.set('welcomed', Date.now()); analyticsOn(); el.gate.hidden = true; showSplash(then); if (shell.on) void notifyFirstAsk(); }, { once: true });
    el.accept.focus({ preventScroll: true });
  }
  {
    const deep = /^#(level-\d+|b-[\w:]+|daily|league|m=[A-Za-z0-9]+)$/.test(location.hash);
    let seenThisSession = false;
    try { seenThisSession = sessionStorage.getItem('aa:splash') === '1'; sessionStorage.setItem('aa:splash', '1'); } catch { /* ignore */ }
    if (!store.get('welcomed')) showGate();
    else { analyticsOn(); if (!deep && !seenThisSession) showSplash(); }
  }

  renderSound();
  el.loading.hidden = false;
  // The account is asked about now, in parallel with the level data and the splash, rather than only once the
  // data has landed. It used to be the other way round, and a match waiting to be resumed paid for it twice:
  // the whole splash, and then a round trip that could have been made during it.
  const authEarly = authLoad();
  loadData().then(() => {
    el.loading.hidden = true;
    renderSelect();
    // the purse and the account row from the first paint, not only once Play with Friends has been tapped, and
    // a time from last time that never got through goes now
    authEarly.then(() => {
      renderPurse(); renderAccountRow(); syncTour(); void notifyInit();
      // Opened by the app to sign in: signed in already means straight back; otherwise the sheet, and the
      // sign-in itself goes back (signedIn).
      if (handoff.nonce) { if (auth.user) void handoffFinish(); else openSignIn('Sign in here and you will be taken straight back to the app.'); }
      handoffHash();
      // Not when a link brought us here: that link names the room, and it wins over anything remembered.
      if (!matchHash()) resumeLive();
      return flushResult(false);
    }).catch(() => {});
    // the league chip, and the clock that keeps its countdown honest
    loadLeague().then(startLeagueTick).catch(() => {});
    const m = /^#level-(\d+)$/.exec(location.hash), mb = /^#b-([\w:]+)$/.exec(location.hash), mm = matchHash();
    if (mm) openMatchLink(mm);
    else if (mb) {
      // A link to a country somebody has not reached yet opens their own next board instead — which it did
      // silently, and looked like the link was broken. It says so now.
      const j = DATA.levels.findIndex(L => L.id === mb[1]);
      if (j >= 0 && !unlocked(j)) toast(`${DATA.levels[j].name} is not open yet — it comes as your tour reaches it. Here is your next board.`, 'hint', 5000);
      startLevel(j < 0 ? 0 : j);
    }
    else if (m) startLevel(+m[1] - 1);   // older links: position in the list
    else if (location.hash === '#daily') { const d = dailyPick(); startLevel(d.idx, false, d); }
    // Where a league notification lands: the table it is about, not the lobby it happens to be reached through.
    else if (location.hash === '#league') openLeague();
  }).catch(err => { el.loading.hidden = true; el.error.textContent = `Could not load the levels (${err.message}). Check your connection and tap Play again.`; el.error.hidden = false; });

  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('/piece-the-world-sw.js').catch(() => {}); });
  }

  const root = document.getElementById('stars');
  if (root && !root.childElementCount) {
    for (let i = 0; i < 90; i++) {
      const s = document.createElement('div'); const size = Math.random() < 0.25 ? 2.5 : 1.5; s.className = 'star';
      s.style.cssText = `left:${Math.random() * 100}%;top:${Math.random() * 100}%;width:${size}px;height:${size}px;animation-duration:${2 + Math.random() * 5}s;animation-delay:${Math.random() * 5}s;background:${Math.random() < 0.1 ? '#F5C518' : '#fff'}`;
      root.appendChild(s);
    }
  }
})();
