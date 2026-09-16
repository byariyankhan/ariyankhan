/* ══════════════════════════════════════════════════
   ARROW ATLAS — tap-away arrow puzzle on country maps
   No dependencies. Data: games/data/arrow-atlas.json
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
  const DATA_VERSION = '8';
  const MAP_VERSION = '1';
  const STORE = 'aa:v1:';
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
  const RUSH_SECONDS = 90;
  const HINT_PENALTY_MS = 5000;
  const HINTS_PER_LEVEL = 3;       // Classic and Rush; Deep Focus is unlimited
  const MODES = { classic: 'Classic' };  // one way to play: the tour ramps up, and the player's own form shifts it
  const LIVES_OF = [4, 4, 4, 4, 3];   // hearts per tier: Master boards, as the reference apps' hard levels, give three
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
  const MAXLEN_OF = [7, 9, 11, 12, 10];  // longest body per tier: long snakes, as on the reference boards; Master a little shorter so it packs more arrows
  // How narrow the play is per tier (see generate()): narrow = prefer the end whose run holds more pieces (blocked
  // longer), far = prefer the end with a gap right ahead (the arrow it frees when it goes is that far away), rail =
  // straighter, longer snakes, holes/lane = share and length of the lanes carved out first.
  const NARROW_OF = [0.5, 0.75, 0.9, 0.97, 1];
  const FAR_OF = [0.2, 0.4, 0.6, 0.8, 0.9];
  const RAIL_OF = [0.1, 0.15, 0.2, 0.25, 0.3];     // share of pieces that run long and straight across the board
  const HOLE_OF = [0.1, 0.15, 0.2, 0.22, 0.25];    // share of inland cells carved out as lanes: the cleared arrow frees one far away, across the lane
  const LANE_OF = [1, 2, 3, 3, 4];                 // longest lane (empty cells between an arrow and its blocker)
  // Tightening iterations per tier (see generate stage 3): a local search that turns arrows to face a blocker so a
  // simulated player has fewer free arrows to pick from at any moment. Hard and up.
  const TIGHTEN_OF = [0, 0, 250, 350, 400];
  const GEN_OPTS = tier => ({ narrow: NARROW_OF[tier], far: FAR_OF[tier], rail: RAIL_OF[tier], holes: HOLE_OF[tier], lane: LANE_OF[tier], tighten: TIGHTEN_OF[tier] });
  const DIRS = { r: [0, 1], l: [0, -1], d: [1, 0], u: [-1, 0] };
  const PALETTE = ['#FFED54', '#5CD6FF', '#8CFF7A', '#FF9AD5', '#C79BFF', '#FFB347', '#6EE7B7', '#FDBA74', '#F97373', '#38BDF8'];

  const el = {
    select: $('#aaSelect'), levels: $('#aaLevels'), progress: $('#aaProgress'), streak: $('#aaStreak'), daily: $('#aaDaily'), hudDiff: $('#aaHudDiff'), play: $('#aaPlay'), playSub: $('#aaPlaySub'), path: $('#aaPath'), btnVibe: $('#aaVibe'), btnGuides: $('#aaGuides'), btnMusic: $('#aaMusic'), howTo: $('#aaHowTo'),
    sheet: $('#aaSheet'), levelsSheet: $('#aaLevelsSheet'), levelsBtn: $('#aaLevelsBtn'), settingsBtns: $$('#aaSettings, #aaSettingsG'), themeBtn: $('#aaTheme'), themes: $('#aaThemes'),
    game: $('#aaGame'), boardWrap: $('#aaBoardWrap'), board: $('#aaBoard'), toast: $('#aaToast'), confetti: $('#aaConfetti'),
    hudLevel: $('#aaHudLevel'), hudMode: $('#aaHudMode'), hudTime: $('#aaHudTime'), hudLeft: $('#aaHudLeft'), hudLives: $('#aaHudLives'), hudLivesWrap: $('#aaHudLivesWrap'), hudPct: $('#aaHudPct'), boardBar: $('#aaBoardBar'),
    btnHint: $('#aaHint'), btnLevels: $('#aaBackToLevels'), btnSound: $('#aaSound'),
    overlay: $('#aaOverlay'), card: $('#aaCard'),
    loading: $('#aaLoading'), error: $('#aaError'),
    gate: $('#aaGate'), accept: $('#aaAccept'), splash: $('#aaSplash'), splashQuote: $('#aaSplashQuote'),
    worldMap: $('#aaWorldMap'), worldCap: $('#aaWorldCap'), worldScroll: $('#aaWorldScroll'),
  };
  if (!el.board) return;

  let DATA = null;
  const state = {
    mode: 'classic', muted: !!store.get('muted', false), music: store.get('music', true) !== false, vibe: store.get('vibe', true) !== false, guides: !!store.get('guides', false),
    idx: -1, level: null, tier: 0, mask: null, pieces: [], occ: null, W: 0, H: 0, left: 0,
    lives: LIVES, livesMax: LIVES, startedAt: 0, elapsed: 0, timerId: 0, finished: false, hintsUsed: 0, wrong: 0, fails: 0, seedBump: 0, busy: false,
    combo: 0, bestCombo: 0, lastShot: 0, cheerHold: 0, shown: new Set(), daily: null,
  };

  // ── Helpers ──
  const fmtTime = (ms, tenths) => { const s = Math.max(0, ms) / 1000, m = Math.floor(s / 60), r = s - m * 60; return tenths ? `${m}:${r.toFixed(1).padStart(4, '0')}` : `${m}:${String(Math.floor(r)).padStart(2, '0')}`; };
  const fmtPop = n => !n ? '' : n >= 1e9 ? `${(n / 1e9).toFixed(2)} billion` : n >= 1e6 ? `${Math.round(n / 1e6)} million` : `${Math.round(n / 1e3)}K`;
  const svgEl = (tag, attrs = {}) => { const n = document.createElementNS(SVG_NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
  const progressKey = i => `lv:${i}`;
  const cleared = i => store.get(progressKey(i));
  const unlocked = i => i === 0 || !!cleared(i - 1) || !!store.get(`skip:${i}`);
  const dayKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const hashStr = str => { let h = 2166136261; for (const ch of str) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  const dailyPick = () => { const h = hashStr('aa-daily-' + dayKey()); return { key: dayKey(), idx: h % DATA.levels.length, tier: 1 + (h >> 8) % 4, seed: 900000 + (h % 100000) }; };
  function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function scrollToGame() { window.scrollTo({ top: 0, behavior: 'smooth' }); }
  function setHash(i) { if (history.replaceState) history.replaceState(null, '', location.pathname + location.search + (i >= 0 ? `#level-${i + 1}` : '')); }

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
  const music = { ctx: null, master: null, timer: 0, step: 0, on: false };
  const CHORDS = [[57, 64, 67, 71, 76], [53, 60, 64, 69, 72], [48, 55, 60, 64, 71], [55, 59, 62, 67, 74]]; // Am9 · Fmaj7 · Cmaj7 · G6 (MIDI)
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
  function musicStart() {
    if (music.on || !state.music) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      const ctx = audio; music.ctx = ctx;
      const master = ctx.createGain(); master.gain.value = 0.0001; master.connect(ctx.destination);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 520; lp.Q.value = 0.6; lp.connect(master);
      const delay = ctx.createDelay(1.2); delay.delayTime.value = 0.52; const fb = ctx.createGain(); fb.gain.value = 0.32;
      const dlp = ctx.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 900;
      lp.connect(delay); delay.connect(dlp); dlp.connect(fb); fb.connect(delay); dlp.connect(master);
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.05; const lfoG = ctx.createGain(); lfoG.gain.value = 180; lfo.connect(lfoG).connect(lp.frequency); lfo.start();
      music.master = master; music.lp = lp; music.lfo = lfo; music.on = true;
      master.gain.exponentialRampToValueAtTime(0.11, ctx.currentTime + 4);
      const playChord = () => {
        if (!music.on) return;
        const notes = CHORDS[music.step % CHORDS.length]; music.step++;
        const t = ctx.currentTime, dur = 14;
        notes.forEach((m, i) => {
          for (const det of [-6, 5]) {
            const o = ctx.createOscillator(); o.type = i === 0 ? 'triangle' : 'sine'; o.frequency.value = mtof(m - (i === 0 ? 12 : 0)); o.detune.value = det;
            const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t);
            g.gain.exponentialRampToValueAtTime(i === 0 ? 0.5 : 0.28, t + 4 + i * 0.6);
            g.gain.setValueAtTime(i === 0 ? 0.5 : 0.28, t + dur - 5);
            g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
            o.connect(g).connect(lp); o.start(t); o.stop(t + dur + 0.1);
          }
        });
        music.timer = setTimeout(playChord, (dur - 4) * 1000);
      };
      playChord();
    } catch { /* no audio, no problem */ }
  }
  function musicStop() {
    if (!music.on) return;
    music.on = false; clearTimeout(music.timer);
    try { const t = music.ctx.currentTime; music.master.gain.setValueAtTime(music.master.gain.value, t); music.master.gain.exponentialRampToValueAtTime(0.0001, t + 1.5); setTimeout(() => { try { music.master.disconnect(); music.lfo.stop(); } catch { /* ignore */ } }, 1700); } catch { /* ignore */ }
  }
  const SFX = { shoot: () => beep([[880, 0, 0.07], [1320, 0.04, 0.08]]), cheer: lv => { const f = 587 * Math.pow(2, lv * 3 / 12); beep([[f, 0, 0.09], [f * 1.26, 0.07, 0.1], [f * 1.5, 0.14, 0.14], [f * 2, 0.21, 0.22, 'sine', 0.06]]); }, block: () => beep([[220, 0, 0.06, 'square', 0.05], [110, 0.05, 0.22, 'triangle', 0.06]]), win: () => beep([[523, 0, 0.12], [659, 0.1, 0.12], [784, 0.2, 0.12], [1047, 0.3, 0.35]]), lose: () => beep([[300, 0, 0.2, 'triangle'], [220, 0.2, 0.35, 'triangle']]) };
  function vibe(ms) { if (state.vibe && navigator.vibrate) { try { navigator.vibrate(ms); } catch { /* ignore */ } } }
  function renderToggles() {
    el.btnMusic?.setAttribute('aria-checked', String(state.music));
    el.btnVibe?.setAttribute('aria-checked', String(state.vibe));
    el.btnGuides?.setAttribute('aria-checked', String(state.guides));
    el.board.classList.toggle('aa-board--guides', state.guides);
  }
  function renderSound() { el.btnSound.setAttribute('aria-checked', String(!state.muted)); el.btnSound.setAttribute('aria-label', state.muted ? 'Sound off' : 'Sound on'); }

  let toastTimer = 0;
  function toast(msg, kind = '', ms = 2800) { el.toast.textContent = msg; el.toast.className = 'aa-toast' + (kind ? ' aa-toast--' + kind : ''); el.toast.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms); }

  // ── Data ──
  async function loadData() {
    if (DATA) return DATA;
    const r = await fetch(`games/data/arrow-atlas.json?v=${DATA_VERSION}`, { cache: 'force-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    DATA = await r.json();
    return DATA;
  }

  // ── Lobby world map ──
  // Every country faint; the tour countries outlined; cleared ones filled and numbered with their level;
  // the next level pulsing. Tap a country to play its level. Built by games/build-world-map.mjs.
  let MAP = null, mapPromise = null, mapDrawn = false;
  function loadMap() {
    if (!mapPromise) mapPromise = fetch(`games/data/world-map.json?v=${MAP_VERSION}`, { cache: 'force-cache' }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }).then(m => { MAP = m; return m; });
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
        if (i != null) { p.classList.add('is-tour'); p.setAttribute('tabindex', '0'); p.setAttribute('role', 'button'); p.addEventListener('click', () => { if (unlocked(i)) startLevel(i); else toast(`Level ${i + 1} is locked. Clear the levels before it first.`, 'bad'); }); p.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.click(); } }); }
        land.appendChild(p);
      }
    }
    labels.innerHTML = '';
    const n = DATA.levels.length, done = DATA.levels.filter((_, i) => cleared(i)).length;
    const nextIdx = DATA.levels.findIndex((_, j) => !cleared(j) && unlocked(j));
    for (const c of MAP.countries) {
      const i = byId.get(c.id); if (i == null) continue;
      const p = land.querySelector(`path[data-id="${c.id}"]`);
      const rec = cleared(i), isNext = i === nextIdx, open = unlocked(i);
      p.classList.toggle('is-done', !!rec); p.classList.toggle('is-next', isNext); p.classList.toggle('is-locked', !open);
      p.setAttribute('aria-label', rec ? `Level ${i + 1}, ${DATA.levels[i].name}, cleared, replay` : isNext ? `Level ${i + 1}, next, play` : open ? `Level ${i + 1}, play` : `Level ${i + 1}, locked`);
      if (rec || isNext) {
        const g = svgEl('g', { class: isNext ? 'is-next' : '' });
        g.appendChild(svgEl('circle', { cx: c.cx, cy: c.cy, r: 16 }));
        const t = svgEl('text', { x: c.cx, y: c.cy }); t.textContent = String(i + 1); g.appendChild(t);
        labels.appendChild(g);
      }
    }
    el.worldCap.textContent = done ? `${done} of ${n} countries collected · tap a country to play it` : 'Your world tour starts here · tap the highlighted country';

  }

  // ── Level select ──
  function renderSelect() {
    if (!DATA) return;
    renderWorld();
    const n = DATA.levels.length;
    const done = DATA.levels.filter((_, i) => cleared(i)).length;
    const learned = DATA.levels.filter((_, i) => cleared(i)?.quiz).length;
    el.progress.textContent = `${done}/${n}`;
    el.progress.setAttribute('aria-label', `${done} of ${n} countries cleared, ${learned} named correctly`);
    const streak = store.get('streak', 0), dStreak = store.get('dailyStreak', { count: 0, last: '' });
    el.streak.textContent = streak >= 2 ? `🔥 ${streak} in a row` : dStreak.count >= 2 ? `🔥 ${dStreak.count}-day daily streak` : '';
    renderDaily();
    const nextIdx = DATA.levels.findIndex((_, j) => !cleared(j) && unlocked(j));
    el.playSub.textContent = nextIdx < 0 ? `All ${DATA.levels.length} cleared · replay any level` : `Level ${nextIdx + 1} · ${DIFF_OF(TIER_OF())}`;
    el.play.dataset.level = nextIdx < 0 ? 0 : nextIdx;
    el.play.querySelector('.aa-play-label').textContent = done ? 'Continue' : 'Play';
    if (el.path) { el.path.innerHTML = '';
    const start = Math.max(0, (nextIdx < 0 ? n - 1 : nextIdx) - 1);
    for (let i = start; i < Math.min(n, start + 5); i++) {
      const d = document.createElement('button'); d.type = 'button';
      d.className = 'aa-dot' + (cleared(i) ? ' is-done' : '') + (i === nextIdx ? ' is-current' : '') + (unlocked(i) ? '' : ' is-locked');
      d.textContent = String(i + 1); d.disabled = !unlocked(i); d.setAttribute('aria-label', `Level ${i + 1}`);
      d.addEventListener('click', () => startLevel(i));
      el.path.appendChild(d);
    } }
    renderThemes();
    el.levels.innerHTML = '';
    DATA.levels.forEach((L, i) => {
      const rec = cleared(i), open = unlocked(i);
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'aa-level' + (rec ? ' is-done' : '') + (open ? '' : ' is-locked') + ((i + 1) % 10 === 0 ? ' is-milestone' : ''); b.dataset.level = i; b.disabled = !open;
      b.setAttribute('aria-label', rec ? `Level ${i + 1}, ${L.name}, ${rec.stars} stars` : open ? `Level ${i + 1}` : `Level ${i + 1}, locked`);
      const svg = svgEl('svg', { viewBox: '-2 -2 104 104', 'aria-hidden': 'true', focusable: 'false' });
      svg.appendChild(svgEl('path', { d: L.d }));
      b.appendChild(svg);
      const t = document.createElement('span'); t.className = 'aa-level-num'; t.textContent = String(i + 1); b.appendChild(t);
      const s = document.createElement('span'); s.className = 'aa-level-sub';
      s.textContent = rec ? `${L.name} ${'★'.repeat(rec.stars)}` : open ? DIFF_OF(TIER_OF()) : '🔒';
      b.appendChild(s);
      b.addEventListener('click', () => startLevel(i));
      el.levels.appendChild(b);
    });
  }

  function renderDaily() {
    const d = dailyPick(), L = DATA.levels[d.idx], rec = store.get(`daily:${d.key}`);
    const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    el.daily.innerHTML = `
      <button type="button" class="aa-mini aa-mini--daily" data-daily aria-label="Today's Country, ${rec ? 'cleared, replay' : 'play'}">
        <span class="aa-mini-kicker">Today's Country</span>
        <span class="aa-mini-big">${rec ? L.name : 'Mystery'} · ${DIFF_OF(d.tier)}</span>
        <span class="aa-mini-sub">${rec ? `Cleared ${'★'.repeat(rec.stars)} · replay` : `${date} · play`}</span>
      </button>`;
    $('[data-daily]', el.daily).addEventListener('click', () => startLevel(d.idx, false, d));
  }

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
  const maskFor = (L, tier) => { const key = L.id + ':' + tier; if (!maskCache.has(key)) maskCache.set(key, rasterise(L.d, L.k[tier])); return maskCache.get(key); };

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
  function generate(mask, maxLen, seed, { far = 0.5, hug = 0.6, narrow = 0.8, rail = 0.2, holes = 0.2, lane = 3, tighten = 0 } = {}) {
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
            return sum / N + 0.3 * start;
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
  function freeAtStart(b) { const { W, H, occ } = b; return b.pieces.filter(p => { const [dr, dc] = DIRS[p.dir]; let [y, x] = p.cells[0]; y += dr; x += dc; while (y >= 0 && y < H && x >= 0 && x < W) { if (occ[y][x] >= 0) return false; y += dr; x += dc; } return true; }).length; }
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
      g.addEventListener('pointermove', e => { if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 12) { clearTimeout(holdTimer); down = null; } });
      g.addEventListener('pointerup', () => { clearTimeout(holdTimer); g.classList.remove('is-pressed'); if (!down) return; down = null; if (held) { held = false; return; } tapPiece(p); });
      g.addEventListener('pointercancel', () => { clearTimeout(holdTimer); g.classList.remove('is-pressed'); down = null; });
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
  function updateReveal() {
    const total = state.pieces.length;
    const done = total - state.left;
    const k = total ? done / total : 0;
    state.outlineEl?.style.setProperty('fill-opacity', String(0.035 + 0.8 * k * k));
  }

  // ── Game lifecycle ──
  async function startLevel(i, bumpSeed = false, daily = null, keepTier = -1) {
    try { await loadData(); } catch (err) { el.error.textContent = `Could not load the levels (${err.message}).`; el.error.hidden = false; return; }
    if (i < 0 || i >= DATA.levels.length) i = 0;
    if (!daily && !unlocked(i)) i = DATA.levels.findIndex((_, j) => !cleared(j) && unlocked(j));
    if (i < 0) i = 0;
    stopTimer();
    if (bumpSeed) state.seedBump++; else if (state.idx !== i || !!daily !== !!state.daily) { state.seedBump = 0; state.fails = 0; }
    state.daily = daily;
    state.idx = i; state.level = DATA.levels[i]; state.tier = daily ? daily.tier : keepTier >= 0 ? keepTier : TIER_OF();
    state.busy = true; el.select.hidden = true; el.game.hidden = false; el.overlay.hidden = true; el.board.innerHTML = '';
    el.hudLevel.textContent = daily ? 'Daily' : `Level ${i + 1}`; el.hudLeft.textContent = 'Drawing the board…';
    await new Promise(r => setTimeout(r, 20));   // let the game screen paint before the (up to ~1 s on phones) generation
    state.maskInfo = maskFor(state.level, state.tier);
    const gen = bestBoard(state.maskInfo, state.tier, (daily ? daily.seed : (i + 1) * 1000) + state.seedBump);
    const livesMax = livesFor(state.tier);
    Object.assign(state, { W: gen.W, H: gen.H, pieces: gen.pieces, occ: gen.occ, land: gen.land, left: gen.pieces.length, lives: livesMax, livesMax, elapsed: 0, startedAt: 0, finished: false, hintsUsed: 0, wrong: 0, busy: false, combo: 0, bestCombo: 0, lastShot: 0, cheerHold: 0, shown: new Set(), armed: new Set() });
    el.error.hidden = true; el.loading.hidden = true;
    if (daily) { if (history.replaceState) history.replaceState(null, '', location.pathname + location.search + '#daily'); } else setHash(i);
    scrollToGame();
    const diff = DIFF_OF(state.tier);
    state.diff = diff;
    renderBoard(); renderHud();
    if (i === 0 && !cleared(0) && !daily) toast('Tap an arrow to shoot it off the board. If another arrow is in its way, you lose a heart.', 'hint');
    else if (state.tier >= 2) toast(`${diff.toUpperCase()} LEVEL · ${state.pieces.length} arrows${daily ? '' : ' · you earned this'}`, 'hard');
    else toast(`${daily ? 'Daily board' : 'Level ' + (i + 1)} · ${state.pieces.length} arrows · which country is this?`);
  }

  function renderHud() {
    el.hudLevel.textContent = state.daily ? 'Daily' : `Level ${state.idx + 1}`;
    const diffLabel = state.diff || DIFF_OF(state.tier);
    el.hudDiff.textContent = diffLabel;
    el.hudDiff.className = 'aa-hud-diff aa-hud-diff--' + diffLabel.toLowerCase().replace(' ', '-');
    const hintsLeft = HINTS_PER_LEVEL - state.hintsUsed;
    el.btnHint.textContent = `💡 ${Math.max(0, hintsLeft)}`;
    el.btnHint.disabled = state.finished || hintsLeft <= 0;
    const pct = state.pieces.length ? Math.round(((state.pieces.length - state.left) / state.pieces.length) * 100) : 0;
    el.hudPct.textContent = `${pct}%`;
    el.boardBar.style.width = `${pct}%`;
    el.hudLeft.textContent = String(state.left);
    const max = Number.isFinite(state.livesMax) ? state.livesMax : 0;
    el.hudLives.innerHTML = Array.from({ length: max }, (_, k) => `<span class="${k < state.lives ? 'is-on' : 'is-off'}">♥</span>`).join('');
    el.hudLives.setAttribute('aria-label', `${state.lives} of ${max} hearts`);
    el.hudLives.classList.toggle('is-last', max > 1 && state.lives === 1 && !state.finished);
    renderTime();
  }
  const currentElapsed = () => state.startedAt ? state.elapsed + (performance.now() - state.startedAt) : state.elapsed;
  function renderTime() {
    const e = currentElapsed();
    el.hudTime.textContent = fmtTime(e);
  }
  function startTimer() {
    if (state.startedAt || state.finished) return;
    state.startedAt = performance.now();
    state.timerId = setInterval(renderTime, 500);
  }
  function stopTimer() { if (state.startedAt) { state.elapsed += performance.now() - state.startedAt; state.startedAt = 0; } clearInterval(state.timerId); state.timerId = 0; }

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
  function peek(p) {
    if (state.finished || p.gone) return;
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
    p.gone = true; state.left--;
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
    SFX.shoot(); vibe(12);
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
    if (state.armed.has(p)) { bounce(p); SFX.block(); toast('Still blocked. It will go by itself once its lane clears.', 'hint'); return; }
    state.lives--; state.wrong++; state.combo = 0;
    arm(p);
    SFX.block(); vibe(60);
    bounce(p);
    blocker.el.classList.add('is-blocker');
    setTimeout(() => blocker.el.classList.remove('is-blocker'), 600);
    renderHud();
    if (state.lives <= 0) failLevel('Out of hearts.');
    else toast(state.lives === 1 ? 'Blocked! Last heart. It stays red and goes by itself once its lane clears.' : 'Blocked! It stays red and goes by itself once its lane clears.', 'bad');
  }
  function hint() {
    if (state.finished) return;
    if (state.hintsUsed >= HINTS_PER_LEVEL) { toast('No hints left on this level.', 'bad'); return; }
    const p = state.pieces.find(q => !q.gone && !blockerOf(q));
    if (!p) return;
    startTimer();
    state.hintsUsed++; state.elapsed += HINT_PENALTY_MS;
    $$('.aa-piece.is-hint', el.board).forEach(g => g.classList.remove('is-hint'));
    p.el.classList.add('is-hint');
    setTimeout(() => p.el.classList.remove('is-hint'), 2500);
    toast(`Hint: the glowing arrow is free. ${HINTS_PER_LEVEL - state.hintsUsed} left.`, 'hint');
    renderHud();
  }

  // ── End of level ──
  // Move the player's form on the finished board (tour levels only; the daily board has a fixed tier).
  function learnFrom(won) {
    if (state.daily) return null;
    const run = { firstTry: won && state.fails === 0, heartsLost: state.livesMax - state.lives, hints: state.hintsUsed, secPerArrow: state.elapsed / 1000 / Math.max(1, state.pieces.length) };
    const before = formNow(), after = nextForm(before, won, run), points = won ? clearPoints(run) : 0;
    store.set('form', after);
    store.set('lastRun', { level: state.idx + 1, tier: state.tier, won, ...run, points, at: Date.now() });
    return { before, after, points };
  }
  // One line for the result card explaining what the player's form did to the next board.
  function adaptNote(learn, nextIdx) {
    if (!learn || nextIdx == null || nextIdx >= DATA.levels.length) return '';
    const { before, after, points } = learn;
    if (after.tier > before.tier) return `<p class="aa-adapt aa-adapt--up">${points >= STEP_POINTS ? 'Flawless and fast.' : 'Two in a row at the first try.'} Level ${nextIdx + 1} steps up to ${DIFF_OF(after.tier)}.</p>`;
    if (after.tier >= 4) return `<p class="aa-adapt aa-adapt--up">Master boards. As hard as it gets.</p>`;
    if (after.wins > 0) return `<p class="aa-adapt">First try. One more like that and the boards step up to ${DIFF_OF(after.tier + 1)}; a flawless, fast clear steps up at once.</p>`;
    return `<p class="aa-adapt">Level ${nextIdx + 1} stays ${DIFF_OF(after.tier)}. Two first-try clears in a row step it up, a flawless fast clear at once.</p>`;
  }
  function stars() { const lost = state.livesMax - state.lives; return lost === 0 ? 3 : lost === 1 ? 2 : 1; }
  function winLevel() {
    stopTimer(); state.finished = true; state.busy = true;
    state.outlineEl?.style.setProperty('fill-opacity', '0.9');
    SFX.win(); confetti();
    setTimeout(showQuiz, 700);
  }
  function showQuiz() {
    const L = state.level;
    const pool = DATA.levels.filter(x => x !== L && x.cont === L.cont);
    const others = (pool.length >= 2 ? pool : DATA.levels.filter(x => x !== L)).slice();
    const rnd = mulberry32(state.idx * 31 + 7);
    for (let i = others.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [others[i], others[j]] = [others[j], others[i]]; }
    const options = [L, others[0], others[1]]; for (let i = options.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [options[i], options[j]] = [options[j], options[i]]; }
    el.card.innerHTML = `<h3>Board cleared!</h3><p class="aa-card-lead">Which country did you just clear?</p><div class="aa-quiz"></div>`;
    const box = $('.aa-quiz', el.card);
    for (const o of options) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'aa-btn aa-quiz-opt'; b.textContent = o.name;
      b.addEventListener('click', () => { $$('.aa-quiz-opt', box).forEach(x => { x.disabled = true; x.classList.toggle('is-right', x.textContent === L.name); x.classList.toggle('is-wrong', x === b && o !== L); }); setTimeout(() => showResult(o === L), 650); });
      box.appendChild(b);
    }
    el.overlay.hidden = false;
    $('.aa-quiz-opt', box)?.focus({ preventScroll: true });
  }
  function showResult(quizRight) {
    const L = state.level, i = state.idx;
    const t = Math.round(state.elapsed), s = stars();
    const learn = learnFrom(true);
    const prev = state.daily ? store.get(`daily:${state.daily.key}`) : cleared(i);
    const isBest = !prev || t < prev.t;
    const rec = { t: isBest ? t : prev.t, stars: Math.max(s, prev?.stars || 0), quiz: !!(quizRight || prev?.quiz), tier: state.tier, arrows: state.pieces.length, at: Date.now() };
    if (state.daily) {
      store.set(`daily:${state.daily.key}`, rec);
      const ds = store.get('dailyStreak', { count: 0, last: '' });
      if (ds.last !== state.daily.key) { const y = new Date(); y.setDate(y.getDate() - 1); const yk = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`; store.set('dailyStreak', { count: ds.last === yk ? ds.count + 1 : 1, last: state.daily.key }); }
    } else store.set(progressKey(i), rec);
    const streak = store.get('streak', 0) + 1; store.set('streak', streak);
    const milestone = !state.daily && (i + 1) % 10 === 0;
    const facts = [L.cap ? `Capital: <b>${L.cap}</b>` : '', L.pop ? `Population: <b>${fmtPop(L.pop)}</b>` : '', L.sub ? `Region: <b>${L.sub}</b>` : ''].filter(Boolean).join(' · ');
    const last = i >= DATA.levels.length - 1;
    el.card.innerHTML = `
      <p class="aa-card-kicker">${milestone ? `Milestone · ${i + 1} countries` : streak >= 2 ? `${streak} in a row · ` : ''}${quizRight ? 'Correct!' : 'It was'}</p>
      <h3>${L.name}</h3>
      <p class="aa-stars" aria-label="${s} of 3 stars">${'★'.repeat(s)}${'☆'.repeat(3 - s)}</p>
      <div class="aa-stats"><span><b>${fmtTime(t, true)}</b>time</span><span><b>${state.livesMax - state.lives}</b>hearts lost</span><span><b>${state.hintsUsed}</b>hints</span><span><b>x${state.bestCombo}</b>best combo</span></div>
      <p class="aa-facts">${facts}</p>
      <p class="aa-best">${isBest ? (prev ? `New best time! Previous ${fmtTime(prev.t, true)}.` : 'First clear. That is your time to beat.') : `Your best: ${fmtTime(prev.t, true)}.`}</p>
      ${last ? '' : adaptNote(learn, i + 1)}
      <div class="aa-actions">
        ${last || state.daily ? '' : `<button type="button" class="aa-btn aa-btn--primary" data-act="next">Next: Level ${i + 2} · ${DIFF_OF(TIER_OF())}</button>`}
        <button type="button" class="aa-btn" data-act="again">Play again</button>
        <button type="button" class="aa-btn" data-act="share">Share</button>
        <button type="button" class="aa-btn" data-act="levels">World Tour</button>
      </div>
      <p class="aa-flash" hidden></p>
      <p class="aa-yt">Curious about ${L.name}? I make geography, history and economy videos: <a href="https://www.youtube.com/@ariyankhan" target="_blank" rel="noopener">youtube.com/@ariyankhan</a></p>`;
    el.overlay.hidden = false;
    $('[data-act]', el.card)?.focus({ preventScroll: true });
    if (typeof gtag === 'function') gtag('event', 'level_complete', { game: 'arrow_atlas', level: i + 1, mode: state.mode, tier: state.tier, arrows: state.pieces.length, time_ms: t, stars: s, quiz: quizRight ? 1 : 0, tier_next: learn?.after.tier ?? state.tier });
  }
  function failLevel(reason) {
    if (state.finished) return;
    stopTimer(); state.finished = true; state.busy = true; state.fails++;
    store.set('streak', 0);
    SFX.lose(); renderHud();
    const learn = learnFrom(false);
    const canSkip = !state.daily && state.fails >= 2 && state.idx < DATA.levels.length - 1;
    const eased = !!learn && learn.after.tier < learn.before.tier;
    el.card.innerHTML = `
      <p class="aa-card-kicker">${state.daily ? 'Daily board' : `Level ${state.idx + 1}`} · ${DIFF_OF(state.tier)}</p>
      <h3>${reason}</h3>
      <p class="aa-card-lead">${state.left} of ${state.pieces.length} arrows were still on the board.</p>
      ${eased ? `<p class="aa-adapt aa-adapt--down">Two losses in a row. A new layout eases to ${DIFF_OF(learn.after.tier)}; Try again keeps this board.</p>` : learn && learn.after.losses === 1 && state.tier > 0 ? '<p class="aa-adapt">One more loss and the boards ease off a step.</p>' : ''}
      <div class="aa-actions">
        <button type="button" class="aa-btn aa-btn--primary" data-act="retry">Try again</button>
        <button type="button" class="aa-btn" data-act="shuffle">${eased ? 'Easier layout' : 'New layout'}</button>
        ${canSkip ? '<button type="button" class="aa-btn" data-act="skip">Skip level</button>' : ''}
        <button type="button" class="aa-btn" data-act="levels">World Tour</button>
      </div>`;
    el.overlay.hidden = false;
    $('[data-act]', el.card)?.focus({ preventScroll: true });
  }
  el.card.addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
    if (act === 'next') startLevel(state.idx + 1);
    else if (act === 'again' || act === 'retry') startLevel(state.idx, false, state.daily, state.tier);
    else if (act === 'shuffle') startLevel(state.idx, true, state.daily);
    else if (act === 'skip') { store.set(`skip:${state.idx + 1}`, true); startLevel(state.idx + 1); }
    else if (act === 'levels') goToLevels();
    else if (act === 'share') share();
  });

  function goToLevels() {
    stopTimer(); el.game.hidden = true; el.overlay.hidden = true; el.select.hidden = false; setHash(-1); renderSelect();
  }
  async function share() {
    const n = DATA.levels.length, done = DATA.levels.filter((_, i) => cleared(i)).length;
    const rec = state.daily ? store.get(`daily:${state.daily.key}`) : cleared(state.idx);
    const text = `Arrow Atlas: I cleared ${state.level.name} (${state.daily ? 'daily board ' + state.daily.key : 'level ' + (state.idx + 1)}) in ${fmtTime(rec?.t ?? state.elapsed, true)} ${'★'.repeat(rec?.stars || stars())} and ${done}/${n} countries so far.\nYour turn: https://ariyankhan.com/arrow-atlas.html${state.daily ? '#daily' : '#level-' + (state.idx + 1)}`;
    const flash = $('.aa-flash', el.card);
    try {
      if (navigator.share) { await navigator.share({ text }); return; }
      await navigator.clipboard.writeText(text);
      if (flash) { flash.textContent = 'Copied. Paste it anywhere.'; flash.hidden = false; }
    } catch { if (flash) { flash.textContent = text; flash.hidden = false; } }
  }

  // ── Particles: one canvas over the board, one animation loop, several emitters ──
  const fx = { parts: [], running: false };
  const particle = (x, y, vx, vy) => ({ x, y, vx, vy, g: 0.3 + Math.random() * 0.2, w: 5 + Math.random() * 7, h: 3 + Math.random() * 4, rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3, round: Math.random() < 0.3, color: PALETTE[Math.floor(Math.random() * PALETTE.length)], life: 1, ttl: 70 + Math.random() * 40 });
  function fxEmit(list) {
    const c = el.confetti; if (!c || !c.getContext || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!fx.running) { const r = el.boardWrap.getBoundingClientRect(); c.width = Math.round(r.width); c.height = Math.round(r.height); }
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
      if (fx.parts.length) requestAnimationFrame(frame); else { ctx.clearRect(0, 0, c.width, c.height); c.hidden = true; fx.running = false; }
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

  // ── Wiring ──
  el.btnHint.addEventListener('click', hint);
  el.play.addEventListener('click', () => startLevel(+el.play.dataset.level || 0));
  // Sheets
  const openSheet = sh => { sh.hidden = false; document.body.style.overflow = 'hidden'; };
  const closeSheets = () => { el.sheet.hidden = true; el.levelsSheet.hidden = true; document.body.style.overflow = ''; };
  el.settingsBtns.forEach(b => b.addEventListener('click', () => openSheet(el.sheet)));
  el.levelsBtn.addEventListener('click', () => { renderSelect(); openSheet(el.levelsSheet); });
  $$('[data-close-sheet]').forEach(b => b.addEventListener('click', closeSheets));
  $$('.aa-sheet').forEach(sh => sh.addEventListener('click', e => { if (e.target === sh) closeSheets(); }));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheets(); });
  el.levels.addEventListener('click', e => { if (e.target.closest('.aa-level')) closeSheets(); });
  // Themes
  const THEMES = ['paper', 'night', 'mint'];
  function applyTheme(t) { document.documentElement.dataset.theme = t; store.set('theme', t); $('meta[name="theme-color"]')?.setAttribute('content', t === 'night' ? '#0E0E10' : t === 'mint' ? '#E6F2EC' : '#F4EDE0'); renderThemes(); }
  function renderThemes() {
    if (!el.themes) return;
    const cur = document.documentElement.dataset.theme || 'paper';
    el.themes.innerHTML = '';
    for (const t of THEMES) { const b = document.createElement('button'); b.type = 'button'; b.className = 'aa-theme' + (t === cur ? ' is-active' : ''); b.dataset.theme = t; b.textContent = t[0].toUpperCase() + t.slice(1); b.addEventListener('click', () => applyTheme(t)); el.themes.appendChild(b); }
  }
  el.themeBtn.addEventListener('click', () => { const cur = document.documentElement.dataset.theme || 'paper'; applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]); });
  applyTheme(THEMES.includes(store.get('theme')) ? store.get('theme') : 'paper');
  el.btnLevels.addEventListener('click', () => { if (state.left < state.pieces.length && !state.finished && !confirm('Leave this level? Progress on it will be lost.')) return; goToLevels(); });
  el.btnSound.addEventListener('click', () => { state.muted = !state.muted; store.set('muted', state.muted); renderSound(); if (!state.muted) SFX.shoot(); });
  el.btnVibe?.addEventListener('click', () => { state.vibe = !state.vibe; store.set('vibe', state.vibe); renderToggles(); vibe(20); });
  el.btnMusic?.addEventListener('click', () => { state.music = !state.music; store.set('music', state.music); renderToggles(); if (state.music) musicStart(); else musicStop(); });
  // Browsers only allow sound after a gesture: the first tap anywhere starts the pad (if Music is on).
  document.addEventListener('pointerdown', () => { if (state.music && !music.on) musicStart(); }, { passive: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden) musicStop(); });
  el.btnGuides?.addEventListener('click', () => { state.guides = !state.guides; store.set('guides', state.guides); renderToggles(); });
  const goAbout = () => { closeSheets(); if (!el.game.hidden) goToLevels(); document.getElementById('aaAbout')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  el.howTo?.addEventListener('click', goAbout);
  // Reset progress: wipes everything the game stored on this device (progress, streaks, form, settings, launches)
  document.getElementById('aaReset')?.addEventListener('click', () => {
    if (!confirm('Delete all Arrow Atlas progress and settings on this device? This cannot be undone.')) return;
    try { Object.keys(localStorage).filter(k => k.startsWith(STORE)).forEach(k => localStorage.removeItem(k)); } catch { /* ignore */ }
    location.replace(location.pathname);
  });
  $$('a[href="#aaAbout"]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); goAbout(); }));
  renderToggles();
  document.addEventListener('keydown', e => { if (!el.game.hidden && !state.finished && (e.key === 'h' || e.key === 'H') && !/input|textarea/i.test(document.activeElement?.tagName || '')) hint(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && state.startedAt && !state.finished) { stopTimer(); } });
  el.board.addEventListener('pointerdown', () => { if (!state.startedAt && !state.finished && state.elapsed) startTimer(); });

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
  function showSplash(then) {
    if (!el.splash) { then?.(); return; }
    const n = store.get('launches', 0); store.set('launches', n + 1);
    el.splashQuote.textContent = QUOTES[n % QUOTES.length];
    el.splash.hidden = false;
    let done = false;
    const finish = () => { if (done) return; done = true; el.splash.classList.add('is-out'); setTimeout(() => { el.splash.hidden = true; el.splash.classList.remove('is-out'); then?.(); }, 240); };
    el.splash.addEventListener('click', finish, { once: true });
    setTimeout(finish, 2400);
  }
  function showGate(then) {
    if (!el.gate) { then?.(); return; }
    el.gate.hidden = false;
    el.accept.addEventListener('click', () => { store.set('welcomed', Date.now()); el.gate.hidden = true; showSplash(then); }, { once: true });
    el.accept.focus({ preventScroll: true });
  }
  {
    const deep = /^#(level-\d+|daily)$/.test(location.hash);
    let seenThisSession = false;
    try { seenThisSession = sessionStorage.getItem('aa:splash') === '1'; sessionStorage.setItem('aa:splash', '1'); } catch { /* ignore */ }
    if (!store.get('welcomed')) showGate();
    else if (!deep && !seenThisSession) showSplash();
  }

  renderSound();
  el.loading.hidden = false;
  loadData().then(() => {
    el.loading.hidden = true;
    renderSelect();
    const m = /^#level-(\d+)$/.exec(location.hash);
    if (m) startLevel(+m[1] - 1);
    else if (location.hash === '#daily') { const d = dailyPick(); startLevel(d.idx, false, d); }
  }).catch(err => { el.loading.hidden = true; el.error.textContent = `Could not load the levels (${err.message}). Check your connection and reload.`; el.error.hidden = false; });

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('/piece-the-world-sw.js').catch(() => {}); });
  }

  $$('.faq-item').forEach(item => {
    const q = item.querySelector('.faq-q'), a = item.querySelector('.faq-a');
    q?.addEventListener('click', () => { const open = !item.classList.contains('open'); item.classList.toggle('open', open); q.setAttribute('aria-expanded', String(open)); a?.setAttribute('aria-hidden', String(!open)); });
  });
  const root = document.getElementById('stars');
  if (root && !root.childElementCount) {
    for (let i = 0; i < 90; i++) {
      const s = document.createElement('div'); const size = Math.random() < 0.25 ? 2.5 : 1.5; s.className = 'star';
      s.style.cssText = `left:${Math.random() * 100}%;top:${Math.random() * 100}%;width:${size}px;height:${size}px;animation-duration:${2 + Math.random() * 5}s;animation-delay:${Math.random() * 5}s;background:${Math.random() < 0.1 ? '#F5C518' : '#fff'}`;
      root.appendChild(s);
    }
  }
})();
