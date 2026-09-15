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
  const DATA_VERSION = '4';
  const MAP_VERSION = '1';
  const STORE = 'aa:v1:';
  const store = {
    get(k, fb) { try { const v = localStorage.getItem(STORE + k); return v == null ? fb : JSON.parse(v); } catch { return fb; } },
    set(k, v) { try { localStorage.setItem(STORE + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };
  const LIVES = 4;                 // Classic and Rush; One Life has 1, Deep Focus none
  const DIFF_OF = tier => ['Normal', 'Normal', 'Hard', 'Expert', 'Master'][tier];
  const COMBO_WINDOW_MS = 1500;
  const MILESTONES = [25, 50, 75, 90];
  const RUSH_SECONDS = 90;
  const HINT_PENALTY_MS = 5000;
  const HINTS_PER_LEVEL = 3;       // Classic and Rush; Deep Focus is unlimited
  const MODES = { classic: 'Classic' };  // one way to play: the tour ramps up, and the player's own form shifts it
  const livesFor = () => LIVES;
  // ── Adaptive difficulty ──
  // The tour has a base tier per level. A skill score in [-2, 2], updated after every board from the player's own
  // play (hearts lost, wrong taps, hints, retries, seconds per arrow), shifts that base one tier up or down, so a
  // player on a roll meets Hard boards early and a player who keeps losing hearts gets a breather. Never generic:
  // two players on level 12 can get different boards. Levels 1 and 2 always stay Normal.
  const BASE_TIER = i => i < 5 ? 0 : i < 15 ? 1 : i < 30 ? 2 : i < 50 ? 3 : 4;
  const SKILL_UP = 1.2, SKILL_DOWN = -1.2, SKILL_KEEP = 0.6, SKILL_GAIN = 0.8;
  const skillShift = skill => skill >= SKILL_UP ? 1 : skill <= SKILL_DOWN ? -1 : 0;
  const tierFor = (i, skill) => i < 2 ? 0 : Math.max(0, Math.min(4, BASE_TIER(i) + skillShift(skill)));
  // How a finished board went, in [-1, 1]. A lost board is -1; a clean, quick clear is 1.
  const rateRun = ({ won, wrong, hints, retries, secPerArrow }) => {
    if (!won) return -1;
    const q = 0.9 - 0.35 * wrong - 0.2 * hints - (retries ? 0.5 : 0) - (secPerArrow > 1.8 ? 0.3 : 0) + (secPerArrow < 1 && wrong === 0 ? 0.3 : 0);
    return Math.max(-1, Math.min(1, q));
  };
  const nextSkill = (skill, run) => Math.max(-2, Math.min(2, skill * SKILL_KEEP + rateRun(run) * SKILL_GAIN));
  const TIER_OF = i => tierFor(i, store.get('skill', 0));
  const LEVEL_DIFF = (i, tier = TIER_OF(i)) => tier <= 1 && tier > BASE_TIER(i) ? 'Hard' : DIFF_OF(tier);
  const MAXLEN_OF = [4, 5, 6, 7, 8];
  // How narrow the play is per tier (see generate()): the share of pieces that aim at other pieces, the share
  // that sit on the newest open run, and how far down that run they sit. Measured on the tour boards, the
  // arrows free at any moment go from about 25% of the board (plain generation) to about 4-6%.
  const NARROW_OF = [0.5, 0.75, 0.9, 0.97, 1];
  const CHAIN_OF = [0.6, 0.75, 0.9, 0.95, 1];
  const FAR_OF = [0.2, 0.4, 0.6, 0.8, 0.9];
  const GEN_OPTS = tier => ({ narrow: NARROW_OF[tier], chain: CHAIN_OF[tier], far: FAR_OF[tier] });
  const DIRS = { r: [0, 1], l: [0, -1], d: [1, 0], u: [-1, 0] };
  const PALETTE = ['#FFED54', '#5CD6FF', '#8CFF7A', '#FF9AD5', '#C79BFF', '#FFB347', '#6EE7B7', '#FDBA74', '#F97373', '#38BDF8'];

  const el = {
    select: $('#aaSelect'), levels: $('#aaLevels'), progress: $('#aaProgress'), streak: $('#aaStreak'), daily: $('#aaDaily'), hudDiff: $('#aaHudDiff'), play: $('#aaPlay'), playSub: $('#aaPlaySub'), path: $('#aaPath'), btnVibe: $('#aaVibe'), btnGuides: $('#aaGuides'), btnMusic: $('#aaMusic'), howTo: $('#aaHowTo'), aboutPanel: $('#aaAboutPanel'),
    sheet: $('#aaSheet'), levelsSheet: $('#aaLevelsSheet'), levelsBtn: $('#aaLevelsBtn'), settingsBtns: $$('#aaSettings, #aaSettingsG'), themeBtn: $('#aaTheme'), themes: $('#aaThemes'),
    game: $('#aaGame'), boardWrap: $('#aaBoardWrap'), board: $('#aaBoard'), toast: $('#aaToast'), confetti: $('#aaConfetti'),
    hudLevel: $('#aaHudLevel'), hudMode: $('#aaHudMode'), hudTime: $('#aaHudTime'), hudLeft: $('#aaHudLeft'), hudLives: $('#aaHudLives'), hudLivesWrap: $('#aaHudLivesWrap'), hudPct: $('#aaHudPct'), boardBar: $('#aaBoardBar'),
    btnHint: $('#aaHint'), btnLevels: $('#aaBackToLevels'), btnSound: $('#aaSound'),
    overlay: $('#aaOverlay'), card: $('#aaCard'),
    loading: $('#aaLoading'), error: $('#aaError'),
    gate: $('#aaGate'), accept: $('#aaAccept'), splash: $('#aaSplash'), splashQuote: $('#aaSplashQuote'),
    worldMap: $('#aaWorldMap'), worldCap: $('#aaWorldCap'),
  };
  if (!el.board) return;

  let DATA = null;
  const state = {
    mode: 'classic', muted: !!store.get('muted', false), music: store.get('music', true) !== false, vibe: store.get('vibe', true) !== false, guides: !!store.get('guides', false),
    idx: -1, level: null, tier: 0, mask: null, pieces: [], occ: null, W: 0, H: 0, left: 0,
    lives: LIVES, livesMax: LIVES, startedAt: 0, elapsed: 0, timerId: 0, finished: false, hintsUsed: 0, wrong: 0, fails: 0, seedBump: 0, busy: false,
    combo: 0, bestCombo: 0, lastShot: 0, shown: new Set(), daily: null,
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
  const dailyPick = () => { const h = hashStr('aa-daily-' + dayKey()); return { key: dayKey(), idx: h % 70, tier: 1 + (h >> 8) % 4, seed: 900000 + (h % 100000) }; };
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
  const SFX = { shoot: () => beep([[880, 0, 0.07], [1320, 0.04, 0.08]]), block: () => beep([[150, 0, 0.18, 'square', 0.04]]), win: () => beep([[523, 0, 0.12], [659, 0.1, 0.12], [784, 0.2, 0.12], [1047, 0.3, 0.35]]), lose: () => beep([[300, 0, 0.2, 'triangle'], [220, 0.2, 0.35, 'triangle']]) };
  function vibe(ms) { if (state.vibe && navigator.vibrate) { try { navigator.vibrate(ms); } catch { /* ignore */ } } }
  function renderToggles() {
    el.btnMusic?.setAttribute('aria-checked', String(state.music));
    el.btnVibe?.setAttribute('aria-checked', String(state.vibe));
    el.btnGuides?.setAttribute('aria-checked', String(state.guides));
    el.board.classList.toggle('aa-board--guides', state.guides);
  }
  function renderSound() { el.btnSound.setAttribute('aria-checked', String(!state.muted)); el.btnSound.setAttribute('aria-label', state.muted ? 'Sound off' : 'Sound on'); }

  let toastTimer = 0;
  function toast(msg, kind = '') { el.toast.textContent = msg; el.toast.className = 'aa-toast' + (kind ? ' aa-toast--' + kind : ''); el.toast.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2800); }

  // ── Data ──
  async function loadData() {
    if (DATA) return DATA;
    const r = await fetch(`games/data/arrow-atlas.json?v=${DATA_VERSION}`, { cache: 'force-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    DATA = await r.json();
    return DATA;
  }

  // ── Lobby world map ──
  // Every country faint; the 70 tour countries outlined; cleared ones filled and numbered with their level;
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
    el.playSub.textContent = nextIdx < 0 ? 'All 70 cleared · replay any level' : `Level ${nextIdx + 1} · ${LEVEL_DIFF(nextIdx)}`;
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
      s.textContent = rec ? `${L.name} ${'★'.repeat(rec.stars)}` : open ? LEVEL_DIFF(i) : '🔒';
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

  // ── Puzzle generation ──
  // Every piece gets an order number `ord`; the solution removes pieces newest-first. Two pairwise rules keep
  // that solution valid whatever the player does (removing a piece only ever frees cells): everything on a
  // piece's exit run must be newer than it, and everything whose run crosses one of its cells must be older.
  // A new piece therefore either gets the newest number (its run holds nothing yet) or is slotted between the
  // pieces its run crosses and the pieces it points at, ords being fractional. What makes a board hard is not
  // how many arrows it has but how few are free at any moment, so with probability `narrow` a piece aims at
  // existing pieces (it is then blocked until they go), with probability `chain` it sits on the run of the most
  // recently placed still-open piece, and `far` picks that spot further down the run, harder to spot. A head
  // that can only point at the sea is free from the start; the last few pieces placed are the only ones that
  // need to be. Pieces whose head sits on the coast walk along the coast (`hug`), so the outline is drawn by
  // arrows. Cells with a single option are always handled first so pockets do not go dead.
  function generate(mask, maxLen, seed, { chain = 0.8, far = 0.5, hug = 0.9, narrow = 0.8 } = {}) {
    const H = mask.rows.length, W = mask.rows[0].length;
    const land = mask.rows.map(r => r.split('').map(ch => ch === '1'));
    const inb = (y, x) => y >= 0 && y < H && x >= 0 && x < W;
    const isLand = (y, x) => inb(y, x) && land[y][x];
    const OPP = { r: 'l', l: 'r', u: 'd', d: 'u' };
    // coast cells: land with any non-land 8-neighbour (8-neighbour so the coast is 4-connected and can be walked)
    const coast = new Set();
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (land[r][c]) { let edge = false; for (let dy = -1; dy <= 1 && !edge; dy++) for (let dx = -1; dx <= 1; dx++) if ((dy || dx) && !isLand(r + dy, c + dx)) { edge = true; break; } if (edge) coast.add(r * W + c); }
    for (let attempt = 0; attempt < 200; attempt++) {
      const rnd = mulberry32(seed * 7919 + attempt * 104729 + 17);
      const occ = Array.from({ length: H }, () => new Array(W).fill(-1));
      const pieces = [];
      let ord = 0;
      const empty = new Set();
      for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (land[r][c]) empty.add(r * W + c);
      const freeCell = (y, x) => isLand(y, x) && occ[y][x] < 0;
      // What lies on the run from (r,c) in direction d: the oldest piece on it (Infinity if none) and whether
      // there is empty land, i.e. room for a later piece to block it.
      const rayInfo = (r, c, d) => { const [dr, dc] = DIRS[d]; let y = r + dr, x = c + dc, hi = Infinity, room = false; while (inb(y, x)) { const i = occ[y][x]; if (i >= 0) hi = Math.min(hi, pieces[i].ord); else if (land[y][x]) room = true; y += dr; x += dc; } return { hi, room }; };
      // Newest piece whose run crosses any of these cells (-1 if none): the new piece must be newer than it.
      const laneMax = cells => { let lo = -1; for (const [r, c] of cells) for (const [d, [dr, dc]] of Object.entries(DIRS)) { let y = r + dr, x = c + dc; while (inb(y, x)) { const i = occ[y][x]; if (i >= 0) { const P = pieces[i]; if (P.cells[0][0] === y && P.cells[0][1] === x && P.dir === OPP[d]) lo = Math.max(lo, P.ord); } y += dr; x += dc; } } return lo; };
      const slotBetween = (lo, hi) => { let k = (lo + hi) / 2; while (pieces.some(P => P.ord === k)) k = (lo + k) / 2; return k; };   // never tie with an unrelated piece
      // Directions a head at (r,c) could take: 'blocked' (aims at pieces it can be slotted under), 'open' (empty
      // run with land ahead, blocked later), 'sea' (free from the start).
      const options = (r, c) => { const out = []; const lo = laneMax([[r, c]]); for (const d of Object.keys(DIRS)) { const { hi, room } = rayInfo(r, c, d); if (hi < Infinity) { if (lo < hi) out.push({ d, kind: 'blocked', hi }); } else out.push({ d, kind: room ? 'open' : 'sea', hi }); } return out; };
      const onExitOf = (P, r, c) => { const [pr, pc] = DIRS[P.dir], [hy, hx] = P.cells[0]; return pr ? c === hx && Math.sign(r - hy) === pr : r === hy && Math.sign(c - hx) === pc; };
      const piecesOn = (r, c, d) => { const [dr, dc] = DIRS[d]; let y = r + dr, x = c + dc; const out = new Set(); while (inb(y, x)) { if (occ[y][x] >= 0) out.add(occ[y][x]); y += dr; x += dc; } return Array.from(out); };
      const closureOf = ids => { const seen = new Set(ids); const queue = ids.slice(); while (queue.length) { const P = pieces[queue.shift()]; for (const i of piecesOn(P.cells[0][0], P.cells[0][1], P.dir)) if (!seen.has(i)) { seen.add(i); queue.push(i); } } return Array.from(seen); };
      const renumber = ids => { for (const P of ids.map(i => pieces[i]).sort((a, b) => a.ord - b.ord)) P.ord = ++ord; };
      // Absorb cell (r,c) into a neighbouring piece: onto a tail that touches it (the head's run is unchanged) or
      // onto a head that points straight at it (the head moves forward). If the cell lies on the run of a newer
      // piece, the piece and everything downstream of it are renumbered newer still, unless one of those points
      // back at the cell (a cycle). A head moving forward shortens its own run and can end up pointing at the
      // sea, so that is only allowed while land stays ahead, or as a last resort.
      const landAhead = (r, c, d) => { const [dr, dc] = DIRS[d]; let y = r + dr, x = c + dc; while (inb(y, x)) { if (land[y][x]) return true; y += dr; x += dc; } return false; };
      const absorb = (r, c, allowEat = false) => {
        for (const pass of ['tail', 'head', 'eat']) {
          if (pass === 'eat' && !allowEat) break;
          for (const [dr, dc] of Object.values(DIRS)) {
            const y = r + dr, x = c + dc; if (!inb(y, x) || occ[y][x] < 0) continue;
            const q = pieces[occ[y][x]]; const tail = q.cells[q.cells.length - 1], head = q.cells[0];
            if (q.cells.length >= maxLen + 6) continue;
            const [qr, qc] = DIRS[q.dir];
            if (pass !== 'tail') {
              if (!(head[0] === y && head[1] === x && head[0] + qr === r && head[1] + qc === c)) continue;
              if (pass === 'head' && !landAhead(r, c, q.dir)) continue;
            } else {
              if (tail[0] !== y || tail[1] !== x || onExitOf(q, r, c)) continue;
              if (q.cells.length === 1 && !(head[0] - qr === r && head[1] - qc === c)) continue;   // keep the head in line with its first segment
            }
            if (pieces.some(P => P.ord > q.ord && onExitOf(P, r, c))) { const cl = closureOf([q.idx]); if (cl.some(i => i !== q.idx && onExitOf(pieces[i], r, c))) continue; renumber(cl); }
            if (pass === 'tail') q.cells.push([r, c]); else q.cells.unshift([r, c]);
            occ[r][c] = q.idx; empty.delete(r * W + c); return true;
          }
        }
        return false;
      };
      // A free cell with no other free neighbour (a coast corner, a nook): a walk passing by steps in and ends
      // there, otherwise nothing else will ever reach it and it becomes a lone arrow pointing at the sea.
      const nook = (y, x, fy, fx) => freeCell(y, x) && !Object.values(DIRS).some(([a, b]) => (y + a !== fy || x + b !== fx) && freeCell(y + a, x + b));
      // Grow a body of up to `len` cells backwards from the head at (r,c): a random walk through empty land,
      // never onto the head's own run (that would block itself). Turns are what make the board a maze.
      const buildBody = (r, c, dir, len, hugging) => {
        const [dr, dc] = DIRS[dir];
        const onExit = (y, x) => (dr ? x === c && Math.sign(y - r) === dr : y === r && Math.sign(x - c) === dc);
        const cells = [[r, c]];
        let py = r, px = c, pdir = [-dr, -dc];
        if (len > 1 && freeCell(r - dr, c - dc)) { py -= dr; px -= dc; cells.push([py, px]); }
        for (let k = cells.length; k < len; k++) {
          const opts = [];
          for (const [ddr, ddc] of Object.values(DIRS)) {
            const y = py + ddr, x = px + ddc;
            if (!freeCell(y, x) || onExit(y, x) || cells.some(([cy, cx]) => cy === y && cx === x)) continue;
            opts.push([ddr, ddc]);
          }
          if (!opts.length) break;
          const nooks = opts.filter(([a, b]) => nook(py + a, px + b, py, px));
          const coastOpts = hugging ? opts.filter(([a, b]) => coast.has((py + a) * W + px + b)) : [];
          const from = nooks.length && rnd() < 0.9 ? nooks : coastOpts.length ? coastOpts : opts;
          const straight = from.find(([a, b]) => a === pdir[0] && b === pdir[1]);
          const step = straight && rnd() < (hugging ? 0.75 : 0.62) ? straight : from[Math.floor(rnd() * from.length)];
          py += step[0]; px += step[1]; pdir = step; cells.push([py, px]);
        }
        return cells;
      };
      // Would this piece leave some empty cell with no option at all? Only cells whose runs pass through the
      // new cells, or that lie on the new run, can be affected, so those are the ones checked.
      const createsDead = (cells, dir, at) => {
        const idx = pieces.length; pieces.push({ idx, ord: at, cells, dir });
        for (const [y, x] of cells) occ[y][x] = idx;
        let dead = false;
        outer: for (const [y0, x0] of cells) for (const [dr, dc] of Object.values(DIRS)) {
          let y = y0 + dr, x = x0 + dc;
          while (inb(y, x)) { if (freeCell(y, x) && !options(y, x).length) { dead = true; break outer; } y += dr; x += dc; }
        }
        for (const [y, x] of cells) occ[y][x] = -1;
        pieces.pop();
        return dead;
      };
      // Fit a piece with head (r,c) pointing d: body shortened until it kills nothing and, when aiming at pieces,
      // until the pieces whose runs cross it are all older than the ones it points at. Returns { cells, ord } or null.
      const fit = (r, c, d, len, hugging) => {
        const { hi } = rayInfo(r, c, d);
        let cells = buildBody(r, c, d, len, hugging);
        for (; cells.length; cells = cells.slice(0, cells.length - 1)) {
          const lo = laneMax(cells); if (lo >= hi) continue;
          const at = hi === Infinity ? ord + 1 : slotBetween(lo, hi);
          if (!createsDead(cells, d, at)) return { cells, at };
        }
        return null;
      };
      const chainP = chain * Math.max(0, 1 - attempt / 40);   // stubborn boards fall back to plain most-constrained-first
      const strictAlign = attempt < 40;                        // heads must continue their last segment; later attempts allow a bent one
      const open = [];                                         // pieces whose run still has empty land
      const lineEmpties = P => { const [dr, dc] = DIRS[P.dir]; const out = []; let [y, x] = P.cells[0]; y += dr; x += dc; while (inb(y, x)) { if (freeCell(y, x)) out.push([y, x]); y += dr; x += dc; } return out; };
      const lenFor = (y, x, d) => (freeCell(y - DIRS[d][0], x - DIRS[d][1]) || !strictAlign) ? 3 + Math.floor(rnd() * (maxLen - 2)) : 1;
      // Pick a direction for a head at (r,c): blocked (with probability narrow) > open > sea; within a kind,
      // one whose body can continue straight behind the head first, and one not reserving a coast corner.
      const exitsAtCorner = (r, c, d) => { const [dr, dc] = DIRS[d]; let y = r + dr, x = c + dc, ly = -1, lx = -1; while (inb(y, x)) { if (land[y][x]) { ly = y; lx = x; } y += dr; x += dc; } return ly >= 0 && (!isLand(ly + dc, lx + dr) || !isLand(ly - dc, lx - dr)); };
      const pickDir = (r, c, opts) => {
        const kinds = rnd() < narrow ? ['blocked', 'open', 'sea'] : ['open', 'blocked', 'sea'];
        for (const kind of kinds) {
          const ds = opts.filter(o => o.kind === kind).map(o => o.d); if (!ds.length) continue;
          const aligned = ds.filter(d => freeCell(r - DIRS[d][0], c - DIRS[d][1]));
          const tidy = (aligned.length ? aligned : ds).filter(d => kind === 'blocked' || !exitsAtCorner(r, c, d));
          const pool = tidy.length ? tidy : aligned.length ? aligned : ds;
          return pool[Math.floor(rnd() * pool.length)];
        }
        return null;
      };
      // Place the piece for head (r,c): try directions in preference order until one fits.
      const placeAt = (r, c, opts) => {
        const tried = new Set();
        while (tried.size < opts.length) {
          const d = pickDir(r, c, opts.filter(o => !tried.has(o.d))); if (!d) break; tried.add(d);
          const f = fit(r, c, d, lenFor(r, c, d), coast.has(r * W + c) && rnd() < hug);
          if (f) return { r, c, dir: d, ...f };
        }
        return null;
      };
      let failed = false;
      while (empty.size) {
        // most constrained empty cell first (ties broken randomly); a cell with one option is placed at once
        let best = null, bestN = 9, bestOpts = null; const pool = Array.from(empty);
        for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
        for (const cell of pool) { const r = Math.floor(cell / W), c = cell % W; const os = options(r, c); if (os.length && os.length < bestN) { best = [r, c]; bestN = os.length; bestOpts = os; if (bestN === 1) break; } }
        if (!best) {
          // Dead cell: no option at all. Absorb it into a neighbouring piece; if no cell can be absorbed this
          // attempt fails and the next seed is tried.
          let merged = false;
          for (const cell of pool) { if (absorb(Math.floor(cell / W), cell % W)) { merged = true; break; } }
          if (!merged) for (const cell of pool) { if (absorb(Math.floor(cell / W), cell % W, true)) { merged = true; break; } }
          if (merged) continue;
          failed = true; break;
        }
        let placed = null;
        if (bestN > 1 && rnd() < chainP) {
          // chain step: block the most recent piece that is still open
          while (open.length && !lineEmpties(pieces[open[open.length - 1]]).length) open.pop();
          if (open.length) {
            const cands = lineEmpties(pieces[open[open.length - 1]]);
            const order = rnd() < far ? cands.slice().sort(() => rnd() - 0.5) : cands;
            for (const [y, x] of order) { const os = options(y, x).filter(o => o.kind !== 'sea'); if (os.length && (placed = placeAt(y, x, os))) break; }
          }
        }
        if (!placed) {
          const [r, c] = best;
          if (bestOpts.every(o => o.kind === 'sea') && absorb(r, c)) continue;   // a head here would be free from the start: rather join a neighbour
          placed = placeAt(r, c, bestOpts);
        }
        if (!placed) { failed = true; break; }
        const { cells, dir, at } = placed;
        if (cells.length === 1 && absorb(cells[0][0], cells[0][1])) continue;
        const idx = pieces.length;
        for (const [y, x] of cells) { occ[y][x] = idx; empty.delete(y * W + x); }
        if (at > ord) ord = at;
        pieces.push({ idx, ord: at, cells, dir, color: PALETTE[idx % PALETTE.length] });
        if (rayInfo(cells[0][0], cells[0][1], dir).room) open.push(idx);
      }
      if (!failed) return { W, H, pieces, occ, land };
    }
    throw new Error('could not generate a solvable board');
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
      headG.appendChild(svgEl('path', { d: 'M-0.26 -0.22 L0.08 0 L-0.26 0.22 Z', class: 'aa-head' }));
      g.appendChild(headG);
      p.bodyLen = bodyLen; p.exitLen = exitLen;
      g.addEventListener('click', () => tapPiece(p));
      g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tapPiece(p); } });
      p.el = g;
      piecesG.appendChild(g);
    }
    svg.appendChild(piecesG);
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
    state.idx = i; state.level = DATA.levels[i]; state.tier = daily ? daily.tier : keepTier >= 0 ? keepTier : TIER_OF(i);
    state.maskInfo = state.level.tiers[state.tier];
    const gen = generate(state.maskInfo, MAXLEN_OF[state.tier], (daily ? daily.seed : (i + 1) * 1000) + state.seedBump, GEN_OPTS(state.tier));
    const livesMax = livesFor(state.mode);
    Object.assign(state, { W: gen.W, H: gen.H, pieces: gen.pieces, occ: gen.occ, land: gen.land, left: gen.pieces.length, lives: livesMax, livesMax, elapsed: 0, startedAt: 0, finished: false, hintsUsed: 0, wrong: 0, busy: false, combo: 0, bestCombo: 0, lastShot: 0, shown: new Set() });
    el.select.hidden = true; el.game.hidden = false; el.overlay.hidden = true; el.error.hidden = true; el.loading.hidden = true;
    if (daily) { if (history.replaceState) history.replaceState(null, '', location.pathname + location.search + '#daily'); } else setHash(i);
    scrollToGame();
    const diff = daily ? DIFF_OF(state.tier) : LEVEL_DIFF(i, state.tier);
    state.diff = diff;
    renderBoard(); renderHud();
    if (i === 0 && !cleared(0) && !daily) toast('Tap an arrow to shoot it off the board. If another arrow is in its way, you lose a heart.', 'hint');
    else if (diff !== 'Normal') toast(`${diff.toUpperCase()} LEVEL · ${state.pieces.length} arrows${!daily && state.tier > BASE_TIER(i) ? ' · you earned this' : ''}`, 'hard');
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
  function tapPiece(p) {
    if (state.finished || p.gone || state.busy) return;
    startTimer();
    const blocker = blockerOf(p);
    if (blocker) { blocked(p, blocker); return; }
    shoot(p);
  }
  function shoot(p) {
    p.gone = true; state.left--;
    for (const [y, x] of p.cells) state.occ[y][x] = -1;
    const travel = p.bodyLen + p.exitLen;
    const dur = Math.min(0.7, 0.15 + travel * 0.03);
    const track = p.el.querySelector('.aa-track'), head = p.el.querySelector('.aa-head');
    p.el.classList.add('is-going');
    track.style.transition = `stroke-dashoffset ${dur}s cubic-bezier(.45,0,1,1)`;
    track.style.strokeDashoffset = String(-travel);
    head.style.transition = `transform ${dur * (p.exitLen / travel)}s cubic-bezier(.45,0,1,1), opacity .15s ${dur * (p.exitLen / travel)}s`;
    head.style.transform = `translate(${p.exitLen}px, 0)`; // local frame: the head group is already rotated to point forward
    head.style.opacity = '0';
    setTimeout(() => p.el.remove(), dur * 1000 + 80);
    SFX.shoot(); vibe(12);
    const now = performance.now();
    state.combo = now - state.lastShot < COMBO_WINDOW_MS ? state.combo + 1 : 1; state.lastShot = now; state.bestCombo = Math.max(state.bestCombo, state.combo);
    updateReveal(); renderHud();
    const pct = Math.round(((state.pieces.length - state.left) / state.pieces.length) * 100);
    const m = MILESTONES.find(x => pct >= x && !state.shown.has(x));
    if (state.left === 0) winLevel();
    else if (m) { state.shown.add(m); toast(({ 25: 'Nice start. 25% cleared.', 50: 'Halfway. The shape is showing.', 75: '75% cleared. Keep the rhythm.', 90: 'Almost there!' })[m]); }
    else if (state.combo >= 3) toast(`Combo x${state.combo}!`, 'combo');
  }
  function blocked(p, blocker) {
    state.lives--; state.wrong++;
    SFX.block(); vibe(60);
    p.el.classList.remove('is-shake'); void p.el.getBBox(); p.el.classList.add('is-shake');
    blocker.el.classList.add('is-blocker');
    setTimeout(() => blocker.el.classList.remove('is-blocker'), 600);
    setTimeout(() => p.el.classList.remove('is-shake'), 400);
    renderHud();
    if (state.lives <= 0) failLevel('Out of hearts.');
    else toast(state.lives === 1 ? 'Blocked! Last heart, look before you tap.' : 'Blocked! The red arrow is in the way.', 'bad');
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
  // Feed the finished board into the skill score (tour levels only; the daily board has a fixed tier).
  function learnFrom(won) {
    if (state.daily) return null;
    const before = store.get('skill', 0);
    const run = { won, wrong: state.wrong, hints: state.hintsUsed, retries: state.fails - (won ? 0 : 1), secPerArrow: state.elapsed / 1000 / Math.max(1, state.pieces.length) };
    const after = nextSkill(before, run);
    store.set('skill', after);
    store.set('lastRun', { level: state.idx + 1, tier: state.tier, ...run, q: rateRun(run), skill: after, at: Date.now() });
    return { before, after, shift: skillShift(after), was: skillShift(before) };
  }
  // One line for the result card explaining what the player's form did to the next board.
  function adaptNote(learn, nextIdx) {
    if (!learn || nextIdx == null || nextIdx >= DATA.levels.length) return '';
    const nextTier = tierFor(nextIdx, learn.after), base = BASE_TIER(nextIdx);
    if (nextTier > base) return `<p class="aa-adapt aa-adapt--up">On a roll: Level ${nextIdx + 1} steps up to ${LEVEL_DIFF(nextIdx, nextTier)}.</p>`;
    if (nextTier < base) return `<p class="aa-adapt aa-adapt--down">Breather: Level ${nextIdx + 1} eases to ${LEVEL_DIFF(nextIdx, nextTier)} for now.</p>`;
    if (learn.shift > 0 || learn.was > 0) return `<p class="aa-adapt">Level ${nextIdx + 1} is ${LEVEL_DIFF(nextIdx, nextTier)}. Clean, quick clears push the difficulty up.</p>`;
    return '';
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
      <div class="aa-stats"><span><b>${fmtTime(t, true)}</b>time</span><span><b>${LIVES - state.lives}</b>hearts lost</span><span><b>${state.hintsUsed}</b>hints</span><span><b>x${state.bestCombo}</b>best combo</span></div>
      <p class="aa-facts">${facts}</p>
      <p class="aa-best">${isBest ? (prev ? `New best time! Previous ${fmtTime(prev.t, true)}.` : 'First clear. That is your time to beat.') : `Your best: ${fmtTime(prev.t, true)}.`}</p>
      ${last ? '' : adaptNote(learn, i + 1)}
      <div class="aa-actions">
        ${last || state.daily ? '' : `<button type="button" class="aa-btn aa-btn--primary" data-act="next">Next: Level ${i + 2} · ${LEVEL_DIFF(i + 1)}</button>`}
        <button type="button" class="aa-btn" data-act="again">Play again</button>
        <button type="button" class="aa-btn" data-act="share">Share</button>
        <button type="button" class="aa-btn" data-act="levels">World Tour</button>
      </div>
      <p class="aa-flash" hidden></p>
      <p class="aa-yt">Curious about ${L.name}? I make geography, history and economy videos: <a href="https://www.youtube.com/@ariyankhan" target="_blank" rel="noopener">youtube.com/@ariyankhan</a></p>`;
    el.overlay.hidden = false;
    $('[data-act]', el.card)?.focus({ preventScroll: true });
    if (typeof gtag === 'function') gtag('event', 'level_complete', { game: 'arrow_atlas', level: i + 1, mode: state.mode, tier: state.tier, arrows: state.pieces.length, time_ms: t, stars: s, quiz: quizRight ? 1 : 0, skill: Math.round((learn?.after ?? 0) * 100) / 100 });
  }
  function failLevel(reason) {
    if (state.finished) return;
    stopTimer(); state.finished = true; state.busy = true; state.fails++;
    store.set('streak', 0);
    SFX.lose(); renderHud();
    const learn = learnFrom(false);
    const canSkip = !state.daily && state.fails >= 2 && state.idx < DATA.levels.length - 1;
    const eased = learn && tierFor(state.idx, learn.after) < state.tier;
    el.card.innerHTML = `
      <p class="aa-card-kicker">${state.daily ? 'Daily board' : `Level ${state.idx + 1}`} · ${DIFF_OF(state.tier)}</p>
      <h3>${reason}</h3>
      <p class="aa-card-lead">${state.left} of ${state.pieces.length} arrows were still on the board.</p>
      ${eased ? '<p class="aa-adapt aa-adapt--down">Breather: a new layout will be a smaller board. Try again keeps this one.</p>' : ''}
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

  function confetti() {
    const c = el.confetti; if (!c || !c.getContext) return;
    const r = el.boardWrap.getBoundingClientRect();
    c.width = Math.round(r.width); c.height = Math.round(r.height); c.hidden = false;
    const ctx = c.getContext('2d');
    const parts = Array.from({ length: 120 }, () => ({ x: c.width / 2 + (Math.random() - 0.5) * c.width * 0.4, y: c.height * 0.45, vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 12 - 4, g: 0.35 + Math.random() * 0.2, w: 6 + Math.random() * 6, h: 3 + Math.random() * 4, rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3, color: PALETTE[Math.floor(Math.random() * PALETTE.length)] }));
    const t0 = performance.now();
    (function frame(now) {
      const k = (now - t0) / 1600; ctx.clearRect(0, 0, c.width, c.height); ctx.globalAlpha = Math.max(0, 1 - k * k);
      for (const p of parts) { p.vy += p.g; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.vx *= 0.99; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.color; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore(); }
      if (k < 1) requestAnimationFrame(frame); else { ctx.clearRect(0, 0, c.width, c.height); c.hidden = true; }
    })(t0);
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
  el.howTo?.addEventListener('click', () => { el.aboutPanel.open = true; el.aboutPanel.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
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
