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
  const HINTS_PER_LEVEL = 3;
  // How long an invitation that arrived mid-board is worth offering afterwards. A room waits minutes, not
  // hours, and an invitation to one that has since filled up or been called off is worse than none.
  const INVITE_KEEP_MS = 120_000;
  const HINTS_OF = [3, 3, 3, 3, 3];   // hints per tier: three everywhere (fewer hints or hearts is not how this game gets hard)
  // Press and hold an arrow and it says whether its lane is clear: green it goes, red it does not. That was free
  // and invisible -- nothing in the game mentioned it, and nothing counted it. Four a level makes it a choice
  // worth making and puts it on the bar where a player can see it, beside the hearts and the lamp.
  const CHECKS_PER_LEVEL = 4;
  const CHECK_ICON = '🔎';
  const CHECK_WORD = 'check';
  const hintsFor = tier => HINTS_OF[tier] ?? HINTS_PER_LEVEL;
  const MODES = { classic: 'Classic' };  // one way to play: the tour ramps up, and the player's own form shifts it
  const LIVES_OF = [4, 4, 4, 4, 4];   // hearts per tier: four everywhere
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
  const TIGHTEN_OF = [0, 0, 250, 300, 300];
  const GEN_OPTS = tier => ({ narrow: NARROW_OF[tier], far: FAR_OF[tier], rail: RAIL_OF[tier], holes: HOLE_OF[tier], lane: LANE_OF[tier], tighten: TIGHTEN_OF[tier] });
  const DIRS = { r: [0, 1], l: [0, -1], d: [1, 0], u: [-1, 0] };
  const PALETTE = ['#FFED54', '#5CD6FF', '#8CFF7A', '#FF9AD5', '#C79BFF', '#FFB347', '#6EE7B7', '#FDBA74', '#F97373', '#38BDF8'];

  const el = {
    select: $('#aaSelect'), tagline: $('#aaTagline'), homeSel: $('#aaHome'), purse: $('#aaPurse'), purseNo: $('#aaPurseNo'), goldAd: $('#aaGoldAd'), hudDiff: $('#aaHudDiff'), play: $('#aaPlay'), path: $('#aaPath'), btnVibe: $('#aaVibe'), btnGuides: $('#aaGuides'), btnMusic: $('#aaMusic'), howTo: $('#aaHowTo'),
    sheet: $('#aaSheet'), friends: $('#aaFriends'), signInSheet: $('#aaSignInSheet'), googleBtn: $('#aaGoogleBtn'), signInNote: $('#aaSignInNote'), ranks: $('#aaRanks'), league: $('#aaLeague'), leagueEnds: $('#aaLeagueEnds'), leagueSheet: $('#aaLeagueSheet'), leagueBody: $('#aaLeagueBody'), leagueInfo: $('#aaLeagueInfo'), matchSheet: $('#aaMatchSheet'), matchBody: $('#aaMatchBody'), matchTitle: $('#aaMatchTitle'), accountGroup: $('#aaAccountGroup'), accountCap: $('#aaAccountCap'), accountRow: $('#aaAccountRow'), accountName: $('#aaAccountName'), accountWho: $('#aaAccountWho'), accountGold: $('#aaAccountGold'), accountFace: $('#aaAccountFace'), sessionGroup: $('#aaSessionGroup'), sessionCap: $('#aaSessionCap'), signOutBtn: $('#aaSignOut'), deleteAccBtn: $('#aaDeleteAcc'), settingsBtns: $$('#aaSettings, #aaSettingsG'), themeBtn: $('#aaTheme'), themes: $('#aaThemes'),
    game: $('#aaGame'), boardWrap: $('#aaBoardWrap'), board: $('#aaBoard'), toast: $('#aaToast'), confetti: $('#aaConfetti'),
    hudLevel: $('#aaHudLevel'), hudMode: $('#aaHudMode'), hudTime: $('#aaHudTime'), hudLeft: $('#aaHudLeft'), hudLives: $('#aaHudLives'), hudLivesWrap: $('#aaHudLivesWrap'), hudPct: $('#aaHudPct'), boardBar: $('#aaBoardBar'),
    btnHint: $('#aaHint'), btnCheck: $('#aaCheck'), btnLevels: $('#aaBackToLevels'), btnSound: $('#aaSound'),
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
    lives: LIVES, livesMax: LIVES, startedAt: 0, raceBase: 0, elapsed: 0, timerId: 0, finished: false, hintsUsed: 0, checksUsed: 0, checksMax: CHECKS_PER_LEVEL, wrong: 0, fails: 0, seedBump: 0, busy: false, potGone: false,
    combo: 0, bestCombo: 0, lastShot: 0, cheerHold: 0, shown: new Set(), daily: null,
  };

  // ── Helpers ──
  const fmtTime = (ms, tenths) => { const s = Math.max(0, ms) / 1000, m = Math.floor(s / 60), r = s - m * 60; return tenths ? `${m}:${r.toFixed(1).padStart(4, '0')}` : `${m}:${String(Math.floor(r)).padStart(2, '0')}`; };
  const fmtPop = n => !n ? '' : n >= 1e9 ? `${(n / 1e9).toFixed(2)} billion` : n >= 1e6 ? `${Math.round(n / 1e6)} million` : `${Math.round(n / 1e3)}K`;
  const svgEl = (tag, attrs = {}) => { const n = document.createElementNS(SVG_NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
  // progress is keyed by country id (not by level number: the tour order is the player's own, home country first)
  const progressKey = i => 'lv:' + DATA.levels[i].id;
  const skipKey = i => 'skip:' + DATA.levels[i].id;
  const cleared = i => store.get(progressKey(i));
  const unlocked = i => i === 0 || !!cleared(i - 1) || !!store.get(skipKey(i));
  const dayKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const hashStr = str => { let h = 2166136261; for (const ch of str) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  // the daily board is the same country for everyone: picked from the canonical list, then found in the player's own order
  const dailyPick = () => { const h = hashStr('aa-daily-' + dayKey()); const L = DATA.canon[h % DATA.canon.length]; return { key: dayKey(), idx: DATA.levels.indexOf(L), tier: 1 + (h >> 8) % 4, seed: 900000 + (h % 100000) }; };
  function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function scrollToGame() { window.scrollTo({ top: 0, behavior: 'smooth' }); }
  // the address names the board (#b-<id>), not its place in the list: the list is personal and the numbers are progress
  function setHash(i) { if (history.replaceState) history.replaceState(null, '', location.pathname + location.search + (i >= 0 ? `#b-${DATA.levels[i].id}` : '')); }
  // Level numbers count the player's own journey: cleared boards in the order they were cleared, then the board in
  // hand. The tour list only decides what comes next, so a player who cleared 63 countries before the discovery
  // boards existed is on level 65, not back on level 4 because Bhutan's animal sits fourth in the list.
  let numCache = null;
  const forgetNums = () => { numCache = null; };
  function levelNo(i) {
    if (!numCache) {
      const done = DATA.levels.map((_, j) => ({ j, rec: cleared(j) })).filter(x => x.rec).sort((a, b) => ((a.rec.at || 0) - (b.rec.at || 0)) || (a.j - b.j));
      numCache = { n: done.length, of: new Map(done.map((x, k) => [x.j, k + 1])) };
    }
    return numCache.of.get(i) || numCache.n + 1;
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
      music.master.gain.linearRampToValueAtTime(mix(MUSIC.gain, i), t + k);
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
    if (i >= MUSIC.pulseFrom) {
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

  const SFX = { shoot: () => beep([[880, 0, 0.07], [1320, 0.04, 0.08]]), cheer: lv => { const f = 587 * Math.pow(2, lv * 3 / 12); beep([[f, 0, 0.09], [f * 1.26, 0.07, 0.1], [f * 1.5, 0.14, 0.14], [f * 2, 0.21, 0.22, 'sine', 0.06]]); }, block: () => beep([[220, 0, 0.06, 'square', 0.05], [110, 0.05, 0.22, 'triangle', 0.06]]), win: () => beep([[523, 0, 0.12], [659, 0.1, 0.12], [784, 0.2, 0.12], [1047, 0.3, 0.35]]), lose: () => beep([[300, 0, 0.2, 'triangle'], [220, 0.2, 0.35, 'triangle']]), taken: () => beep([[784, 0, 0.1], [523, 0.09, 0.18, 'triangle', 0.05]]),
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
  // Every button in the game answers back. The board's own arrows are not buttons, so they keep their own shot.
  document.addEventListener('pointerdown', e => {
    const b = e.target.closest('button, .aa-fill');
    if (b && !b.disabled && !b.closest('.aa-piece')) SFX.tap();
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
  const COIN = '<img class="aa-coin" src="/images/puzzle-coin.png" alt="" width="128" height="128" decoding="async">';

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
  function teach(k, msg, kind = 'hint', ms = 2800) {
    if (!sayOnce(k)) return false;
    toast(msg, kind, ms);
    return true;
  }
  function toast(msg, kind = '', ms = 2800) { el.toast.textContent = msg; el.toast.className = 'aa-toast' + (kind ? ' aa-toast--' + kind : ''); el.toast.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms); }

  // ── Data ──
  async function loadData() {
    if (DATA) return DATA;
    const [r] = await Promise.all([fetch(`/games/data/puzzle.json?v=${DATA_VERSION}`, { cache: 'force-cache' }), loadDiscBoards()]);
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
    const tour = orderFor(d, home).flatMap(C => [C, discLevelFor(C)].filter(Boolean));
    // discovery clears were briefly kept under dv:<id> before the boards became levels of their own
    for (const L of tour) if (L.disc && !store.get('lv:' + L.id)) { const v = store.get('dv:' + L.country.id); if (v) store.set('lv:' + L.id, v); }
    return tour;
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
  function setHome(a2) { store.set('home', a2); store.set('homeAuto', false); DATA.levels = tourFor(DATA, a2); maskCache.clear(); forgetNums(); renderSelect(); }

  // ── Lobby world map ──
  // Every country faint; the tour countries outlined; cleared ones filled and numbered with their level;
  // the next level pulsing. Tap a country to play its level. Built by games/build-world-map.mjs.
  let MAP = null, mapPromise = null, mapDrawn = false;
  function loadMap() {
    if (!mapPromise) mapPromise = fetch(`/games/data/world-map.json?v=${MAP_VERSION}`, { cache: 'force-cache' }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }).then(m => { MAP = m; return m; });
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
        if (i != null) { p.classList.add('is-tour'); p.setAttribute('tabindex', '0'); p.setAttribute('role', 'button'); p.addEventListener('click', () => { if (!unlocked(i)) { toast(`${DATA.levels[i].name} is locked. Clear the levels before it first.`, 'bad'); return; } startLevel(i); }); p.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.click(); } }); }
        land.appendChild(p);
      }
    }
    labels.innerHTML = '';
    const n = DATA.levels.filter(L => !L.disc).length, done = DATA.levels.filter((L, i) => !L.disc && cleared(i)).length;
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
    el.worldCap.textContent = `${done} of ${n} countries discovered`;

  }

  // ── Level select ──
  function renderSelect() {
    if (!DATA) return;
    renderWorld();
    const n = DATA.levels.length;
    renderPurse();
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
    if (!discbPromise) discbPromise = fetch(`/games/data/discover-boards.json?v=${DISCB_VERSION}`, { cache: 'force-cache' }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }).then(d => { DISCB = d; return d; });
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
  // the next board to play after i: the first open one further down the list (cleared boards are skipped, so Next
  // never lands on a replay), else the first open one anywhere, else nothing (-1)
  function nextOpen(i) {
    const open = j => !cleared(j) && unlocked(j);
    for (let j = i + 1; j < DATA.levels.length; j++) if (open(j)) return j;
    for (let j = 0; j <= i && j < DATA.levels.length; j++) if (open(j)) return j;
    return -1;
  }
  const hudLabel = () => state.daily ? (state.daily.race ? 'Challenge' : 'Daily') : `Level ${levelNo(state.idx)}`;
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
  const CANDIDATES_OF = [4, 6, 8, 6, 5];
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
    stopTimer(); stopProgressPoll();
    if (el.ranks) el.ranks.hidden = true;
    if (daily?.race) state.seedBump = 0;   // a race is that exact board: a stray reshuffle must not change it
    else if (bumpSeed) state.seedBump++; else if (state.idx !== i || !!daily !== !!state.daily) { state.seedBump = 0; state.fails = 0; }
    state.daily = daily; state.level = DATA.levels[i]; state.disc = state.level.disc ? state.level : null;
    state.idx = i; state.tier = daily ? daily.tier : keepTier >= 0 ? keepTier : TIER_OF();
    state.busy = true; el.select.hidden = true; el.game.hidden = false; el.overlay.hidden = true; el.board.innerHTML = '';
    el.hudLevel.textContent = hudLabel(); el.hudLeft.textContent = 'Drawing the board…';
    el.btnLevels.setAttribute('aria-label', daily?.race ? 'Leave the challenge' : 'Back to home');
    await new Promise(r => setTimeout(r, 20));   // let the game screen paint before the (up to ~1 s on phones) generation
    state.maskInfo = maskFor(state.level, state.tier);
    const seed = (daily ? daily.seed : (i + 1) * 1000) + state.seedBump;
    const gen = bestBoard(state.maskInfo, state.tier, seed);
    const livesMax = livesFor(state.tier);
    Object.assign(state, { W: gen.W, H: gen.H, pieces: gen.pieces, occ: gen.occ, land: gen.land, left: gen.pieces.length, hintsMax: hintsFor(state.tier), checksUsed: 0, checksMax: CHECKS_PER_LEVEL, adKinds: new Set(), lives: livesMax, livesMax, elapsed: 0, startedAt: 0, raceBase: 0, finished: false, hintsUsed: 0, wrong: 0, busy: false, potGone: false, combo: 0, bestCombo: 0, lastShot: 0, cheerHold: 0, shown: new Set(), armed: new Set() });
    el.error.hidden = true; el.loading.hidden = true;
    if (daily) { if (history.replaceState) history.replaceState(null, '', location.pathname + location.search + (daily.hash ?? '#daily')); } else setHash(i);
    scrollToGame();
    const diff = DIFF_OF(state.tier);
    state.diff = diff;
    resetZoom(); renderBoard(); renderHud();
    if (daily?.race && daily.match) { renderRanks(daily.match.players); syncRaceClock(daily.match); startProgressPoll(); }   // back on a race board is back in the match, on the match's own clock
    if (i === 0 && !cleared(0) && !daily) teach('tap', 'Tap an arrow to shoot it off the board. If another arrow is in its way, you lose a heart.');
    else if (state.disc) toast(`${state.disc.country.name}'s ${KIND_WORD[state.disc.kind]} · ${state.pieces.length} arrows · clear it to see what it is`, state.tier >= 2 ? 'hard' : '');
    else if (state.tier >= 2) toast(`${diff.toUpperCase()} LEVEL · ${state.pieces.length} arrows${daily ? '' : ' · you earned this'}`, 'hard');
    else if (daily?.race) toast(`Challenge board · ${state.pieces.length} arrows · clear it as fast as you can.`);
    else toast(`${daily ? 'Daily board' : 'Level ' + levelNo(i)} · ${state.pieces.length} arrows · which country is this?`);
  }

  function renderHud() {
    el.hudLevel.textContent = hudLabel();
    const diffLabel = state.diff || DIFF_OF(state.tier);
    el.hudDiff.textContent = diffLabel;
    el.hudDiff.className = 'aa-hud-diff aa-hud-diff--' + diffLabel.toLowerCase().replace(' ', '-');
    const hintsLeft = (state.hintsMax ?? HINTS_PER_LEVEL) - state.hintsUsed;
    el.btnHint.textContent = `💡 ${Math.max(0, hintsLeft)}`;
    el.btnHint.disabled = state.finished || hintsLeft <= 0;
    if (el.btnCheck) {
      const left = checksLeftNow();
      el.btnCheck.textContent = `${CHECK_ICON} ${Math.max(0, left)}`;
      el.btnCheck.classList.toggle('is-spent', left <= 0);
      el.btnCheck.setAttribute('aria-label', `${Math.max(0, left)} ${left === 1 ? CHECK_WORD : CHECK_WORD + 's'} left. Press and hold an arrow to check whether its lane is clear.`);
    }
    const pct = state.pieces.length ? Math.round(((state.pieces.length - state.left) / state.pieces.length) * 100) : 0;
    el.hudPct.textContent = `${pct}%`;
    el.boardBar.style.width = `${pct}%`;
    el.hudLeft.textContent = String(state.left);
    const max = Number.isFinite(state.livesMax) ? state.livesMax : 0;
    el.hudLives.innerHTML = Array.from({ length: max }, (_, k) => `<span class="${k < state.lives ? 'is-on' : 'is-off'}">♥</span>`).join('');
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
    state.checksUsed++;
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
    state.lives--; state.wrong++; state.combo = 0;
    arm(p); musicWrong();
    SFX.block(); vibe(60);
    bounce(p);
    blocker.el.classList.add('is-blocker');
    setTimeout(() => blocker.el.classList.remove('is-blocker'), 600);
    renderHud();
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
      if (adCanOffer('hint')) { adOffer('hint'); return; }
      toast('No hints left on this level.', 'bad'); return;
    }
    const p = state.pieces.find(q => !q.gone && !blockerOf(q));
    if (!p) return;
    startTimer();
    state.hintsUsed++;
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
    store.set('lastRun', { level: levelNo(state.idx), disc: !!state.disc, tier: state.tier, won, ...run, points, at: Date.now() });
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
  const ICON_AGAIN = ICO('<path d="M20 12a8 8 0 1 1-2.5-5.8"/><path d="M20 3.6V9h-5.4"/>');
  const ICON_SHARE = ICO('<circle cx="17.5" cy="5.5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="17.5" cy="18.5" r="2.6"/><path d="M8.4 10.7l6.8-3.9"/><path d="M8.4 13.3l6.8 3.9"/>');
  const ICON_SHUFFLE = ICO('<path d="M3.5 6.5h3.2l10.6 11h3.2"/><path d="M3.5 17.5h3.2l10.6-11h3.2"/><path d="M17.6 3.6l2.9 2.9-2.9 2.9"/><path d="M17.6 14.6l2.9 2.9-2.9 2.9"/>');
  const ICON_AD    = ICO('<rect x="2.8" y="4.8" width="18.4" height="14.4" rx="2.4"/><path d="M10.2 9.4l4.6 2.6-4.6 2.6z"/>');
  const ICON_SKIP  = ICO('<path d="M5.5 5.5l9 6.5-9 6.5z"/><path d="M18 5.5v13"/>');
  const ICON_FLAG  = ICO('<path d="M6 21V4"/><path d="M6 5h11l-2.2 3.4L17 12H6z"/>');
  const ICON_MAP   = ICO('<circle cx="12" cy="12" r="8.6"/><path d="M3.4 12h17.2"/><path d="M12 3.4c2.7 2.9 2.7 14 0 17.2"/><path d="M12 3.4c-2.7 2.9-2.7 14 0 17.2"/>');
  // The bar is filled in front of the player rather than handed to them finished: the brain travels, the
  // number counts up with it, and the sound climbs alongside. That second is the whole point of the reading —
  // it is the only part of the card that is worth watching happen.
  function runFocusBar(value) {
    const box = $('#aaFocus', el.card);
    if (!box) return;
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
  function winLevel() {
    stopTimer(); state.finished = true; state.busy = true;
    music.spike = 0; musicRace(0);   // it is done: whatever was leaning on the player stops leaning
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
    const prev = R ? null : state.daily ? store.get(`daily:${state.daily.key}`) : cleared(i);
    const isBest = !prev || t < prev.t;
    // `quiz` is what a board's record used to say about the question at the end. There is no question now, so
    // every cleared board carries it: the name is on the card either way, and a row saved today should not
    // read as poorer than one saved last week.
    const rec = { t: isBest ? t : prev.t, stars: Math.max(s, prev?.stars || 0), quiz: true, tier: state.tier, arrows: state.pieces.length, at: Date.now() };
    if (R) { /* a race is not part of the tour: nothing is saved and the difficulty ladder does not move */ }
    else if (state.daily) {
      store.set(`daily:${state.daily.key}`, rec);
      const ds = store.get('dailyStreak', { count: 0, last: '' });
      if (ds.last !== state.daily.key) { const y = new Date(); y.setDate(y.getDate() - 1); const yk = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`; store.set('dailyStreak', { count: ds.last === yk ? ds.count + 1 : 1, last: state.daily.key }); }
      syncTour({});   // the daily board lives in the state blob, which every push carries
    } else { store.set(progressKey(i), rec); forgetNums(); pushOne(DATA.levels[i].id, rec); }
    if (R) {
      // No number here on purpose: the one that counts is the race time the server works out, and it is on the
      // sheet a second later. Two different times on two screens in a row is how a race stops making sense.
      el.card.innerHTML = '<h3>Board cleared!</h3><p class="aa-card-lead">Sending your time…</p>';
      el.overlay.hidden = false;
      finishMatch(true, t);
      return;
    }
    // The streak is still counted and still reset by a loss — it is a record of this device's play and throwing
    // it away would throw away every player's, permanently. It is simply not announced on the card any more.
    store.set('streak', store.get('streak', 0) + 1);
    const n = levelNo(i), milestone = !state.daily && n % 10 === 0;
    const facts = D ? escapeHtml(D.rel.charAt(0).toUpperCase() + D.rel.slice(1)) : [L.cap ? `Capital: <b>${L.cap}</b>` : '', L.pop ? `Population: <b>${fmtPop(L.pop)}</b>` : '', L.sub ? `Region: <b>${L.sub}</b>` : ''].filter(Boolean).join(' · ');
    const nj = nextOpen(i), last = nj < 0;
    // The reading. It is shown, not described: a bar under a caption, with the comparison against everybody
    // else added underneath only when the server has enough players to make it true.
    const focus = focusOf(t, state.pieces.length, state.livesMax - state.lives, state.hintsUsed);
    const band = focusBand(focus);
    el.card.innerHTML = `
      <p class="aa-card-kicker">${milestone ? `Milestone · level ${n} · ` : ''}You cleared</p>
      <h3>${escapeHtml(L.name)}</h3>
      <p class="aa-facts">${facts}</p>
      <p class="aa-stars" aria-label="${s} of 3 stars">${'★'.repeat(s)}${'☆'.repeat(3 - s)}</p>
      <div class="aa-stats"><span><b>${fmtTime(t, true)}</b>time</span><span><b>${state.livesMax - state.lives}</b>hearts lost</span><span><b>${state.hintsUsed}</b>hints</span><span><b>x${state.bestCombo}</b>best combo</span></div>
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
      <p class="aa-yt">Curious about ${escapeHtml(C.name)}? I make geography, history and economy videos: <a href="https://www.youtube.com/@ariyankhan" target="_blank" rel="noopener">youtube.com/@ariyankhan</a></p>`;
    el.overlay.hidden = false;
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
    if (state.finished) return;
    stopTimer(); state.finished = true; state.busy = true; state.fails++;
    music.spike = 0; musicRace(0);
    store.set('streak', 0);
    SFX.lose(); renderHud();
    const learn = learnFrom(false);
    const canSkip = !state.daily && state.fails >= 2 && state.idx < DATA.levels.length - 1;
    const eased = !!learn && learn.after.tier < learn.before.tier;
    el.card.innerHTML = `
      <p class="aa-card-kicker">${state.daily ? (state.daily.race ? `Gold match · ${gpurse(state.daily.match?.stake || 0)}` : 'Daily board') : hudLabel()} · ${DIFF_OF(state.tier)}</p>
      <h3>${reason}</h3>
      <p class="aa-card-lead">${state.left} of ${state.pieces.length} arrows were still on the board.</p>
      ${state.daily?.race && sayOnce('race-retry') ? '<p class="aa-adapt">Try again puts you back on the same board with your hearts back. Nothing is lost until somebody else clears it.</p>' : ''}
      <div class="aa-actions aa-actions--stack">
        <button type="button" class="aa-btn aa-btn--primary" data-act="retry">${ICON_AGAIN}Try again</button>
        ${state.daily?.race ? `<button type="button" class="aa-btn" data-act="giveup">${ICON_FLAG}Give the board up</button>` : `<button type="button" class="aa-btn" data-act="shuffle">${ICON_SHUFFLE}${eased ? 'Easier layout' : 'New layout'}</button>`}
        ${canSkip ? `<button type="button" class="aa-btn" data-act="skip">${ICON_SKIP}Skip level</button>` : ''}
        ${adCanOffer('heart')
          ? `<button type="button" class="aa-btn aa-btn--ad" data-act="adheart">${ICON_AD}Watch an ad</button>`
          : `<button type="button" class="aa-btn" data-act="levels">${ICON_MAP}World Tour</button>`}
      </div>
      ${adCanOffer('heart') ? '<p class="aa-card-out"><button type="button" class="aa-linkbtn" data-act="levels">Back to the World Tour</button></p>' : ''}`;
    el.overlay.hidden = false;
    $('[data-act]', el.card)?.focus({ preventScroll: true });
  }
  el.card.addEventListener('click', e => {
    const inv = e.target.closest('[data-invite]');
    if (inv) { invitePlayer(inv.dataset.invite, inv.dataset.name, inv); return; }
    const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
    if (act === 'adheart') { adOffer('heart'); return; }
    if (act === 'next') { const j = nextOpen(state.idx); if (j < 0) goToLevels(); else startLevel(j); }
    else if (act === 'again' || act === 'retry') startLevel(state.idx, false, state.daily, state.tier);
    else if (act === 'shuffle') startLevel(state.idx, true, state.daily);
    else if (act === 'skip') { const id = DATA.levels[state.idx + 1]?.id; store.set(skipKey(state.idx + 1), true); if (id) syncTour({ [id]: { cleared: false, skipped: true } }); startLevel(nextOpen(state.idx)); }
    // Out of hearts is not the end of a challenge — giving up is, and it cannot be taken back: the loss goes
    // to the server, the seat closes and the stake is gone. So the quiet button asks before it does that.
    else if (act === 'giveup') {
      if (!confirm('Give the board up? Your run ends here, and your stake goes to whoever clears it.')) return;
      el.card.innerHTML = '<h3>Sending…</h3>'; finishMatch(false, 0);
    }
    else if (act === 'resend') { const b = e.target.closest('[data-act]'); b.disabled = true; flushResult(true).then(ok => { if (!ok) b.disabled = false; }); }
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
    stopTimer();
    state.pieces = []; state.occ = null; state.mask = null; state.left = 0; state.W = 0; state.H = 0;
    state.lives = LIVES; state.livesMax = LIVES;
    state.elapsed = 0; state.startedAt = 0; state.raceBase = 0;
    state.hintsUsed = 0; state.hintsMax = HINTS_PER_LEVEL;
    state.checksUsed = 0; state.checksMax = CHECKS_PER_LEVEL;   // the same two lines as the hints, for the same reason
    state.adKinds = new Set();
    state.finished = false; state.wrong = 0; state.fails = 0; state.potGone = false;
    state.combo = 0; state.bestCombo = 0; state.lastShot = 0; state.shown = new Set();
    state.daily = null; state.disc = null;
    el.board.innerHTML = '';
    if (el.ranks) el.ranks.hidden = true;
    renderHud();
  }
  function goToLevels() {
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
    const text = `Puzzle – Train Your Brain: I cleared ${what} (${state.daily ? 'daily board ' + state.daily.key : 'level ' + levelNo(state.idx)}) in ${fmtTime(rec?.t ?? state.elapsed, true)} ${'★'.repeat(rec?.stars || stars())} and ${done}/${n} countries so far.\nYour turn: https://ariyankhan.com/puzzle/${state.daily ? '#daily' : '#b-' + state.level.id}`;
    const flash = $('.aa-flash', el.card);
    try {
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
  const ads = {
    mode: 'off',
    client: '',
    showing: false,
    ready() { return this.mode !== 'off' && !this.showing; },
    on() { return this.mode !== 'off'; },
  };
  (function adsConfigure() {
    const meta = document.querySelector('meta[name="puzzle-ads"]');
    let mode = (meta?.content || 'off').trim();
    ads.client = (meta?.dataset.client || '').trim();
    // The test mode is a developer's switch, not a URL anybody can find: on the live site it needs a flag set
    // by hand on that device first. The server's daily cap is the real defence either way -- it can only ever
    // hand out a few hundred gold a day, whatever the page claims to have shown -- but a free-gold link in a
    // share sheet is not a thing to leave lying about.
    const wanted = new URLSearchParams(location.search).get('ads');
    const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (wanted && ['off', 'test', 'h5'].includes(wanted) && (wanted === 'off' || local || store.get('adsdev', false))) mode = wanted;
    ads.mode = ['off', 'test', 'h5'].includes(mode) ? mode : 'off';
    if (ads.mode !== 'h5') return;

    // The page already carries the AdSense tag, so there is nothing to load: adding a second copy of the same
    // script with the same publisher is how a page ends up with two libraries arguing over one slot. Take the
    // publisher from the tag that is there, and only add one if there is none.
    const tag = document.querySelector('script[src*="adsbygoogle.js"]');
    if (!ads.client && tag) { try { ads.client = new URL(tag.src).searchParams.get('client') || ''; } catch { /* leave it */ } }
    if (!tag && ads.client) {
      const sc = document.createElement('script');
      sc.async = true; sc.crossOrigin = 'anonymous';
      sc.dataset.adFrequencyHint = '30s';
      sc.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(ads.client)}`;
      document.head.appendChild(sc);
    }
    // adBreak and adConfig are the page's to define, not the library's: they push onto the queue the library
    // drains once it is ready, which is what makes a break requested before the script loads still work.
    window.adsbygoogle = window.adsbygoogle || [];
    if (typeof window.adBreak !== 'function') window.adBreak = o => window.adsbygoogle.push(o);
    if (typeof window.adConfig !== 'function') window.adConfig = o => window.adsbygoogle.push(o);
    try { window.adConfig({ preloadAdBreaks: 'on', sound: state.muted ? 'off' : 'on' }); } catch { /* the library decides */ }
  })();

  // When an ad may be offered for a lifeline.
  //
  // Once per board per kind, so a board cannot be watched into submission -- and never in a gold match. Somebody
  // who has put gold on a table is racing people who put in the same gold; letting one of them buy an extra
  // heart with thirty seconds of their attention is not a lifeline, it is a different game. The daily board and
  // the tour have nothing at stake but pride, and there it is a kindness.
  const adCanOffer = kind => ads.on() && !state.daily?.race && !state.adKinds?.has(kind);
  const adSpend = kind => { (state.adKinds = state.adKinds || new Set()).add(kind); };

  // A stand-in ad: the same shape as the real one, long enough to be a real decision, skippable like the real
  // one, and it resolves exactly the way the real one does.
  function adTestShow(name) {
    return new Promise(resolve => {
      const wrap = document.createElement('div');
      wrap.className = 'aa-adtest';
      wrap.innerHTML = `<div class="aa-adtest-panel" role="dialog" aria-modal="true" aria-label="Test advertisement">
        <p class="aa-adtest-tag">Test advertisement</p>
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
  function adH5Show(name) {
    return new Promise(resolve => {
      if (typeof window.adBreak !== 'function') { resolve('unavailable'); return; }
      let settled = false, started = false;
      const done = how => { if (!settled) { settled = true; clearTimeout(waitAd); clearTimeout(waitEnd); resolve(how); } };
      // Two clocks, because the two silences mean different things. If beforeReward has not fired in eight
      // seconds there is nothing to show and the player should not be left looking at a spinner. Once it has
      // fired an ad is actually running, and a rewarded one is allowed to be a minute long.
      let waitEnd = 0;
      const waitAd = setTimeout(() => { if (!started) done('unavailable'); }, 8000);
      try {
        window.adBreak({
          type: 'reward',
          name,
          beforeReward(showAdFn) {
            started = true; clearTimeout(waitAd);
            waitEnd = setTimeout(() => done('unavailable'), 120000);
            try { showAdFn(); } catch { done('unavailable'); }
          },
          adViewed() { done('watched'); },
          adDismissed() { done('dismissed'); },
          adBreakDone() { done('unavailable'); },    // fires last; only lands if nothing above did
        });
      } catch { done('unavailable'); }
    });
  }

  // Show one, and say whether it earned the reward. Never two at once.
  async function adShow(name) {
    if (!ads.ready()) return 'unavailable';
    ads.showing = true;
    const wasMusic = music.on;
    try {
      if (wasMusic) musicStop();                     // an ad has its own sound; the pad does not talk over it
      const how = await (ads.mode === 'test' ? adTestShow(name) : adH5Show(name));
      return how;
    } finally {
      ads.showing = false;
      if (wasMusic && state.music && !el.game.hidden && !state.finished) musicStart();
    }
  }

  // What each kind of reward is, in one table: what to call it, what the ad is named in the network's own
  // reporting, and what happens when it is earned. Gold is the odd one out and says so -- it is the only one
  // the client cannot grant, because gold is real and the server is the only thing allowed to make it.
  const AD_REWARD = {
    heart: {
      title: 'One more heart',
      lead: 'Watch a short advertisement and carry on with this board from where it stopped, with one heart.',
      cta: 'Watch for a heart',
      grant() { state.lives = 1; state.finished = false; state.busy = false; el.overlay.hidden = true; renderHud(); startTimer(); toast('One heart. Make it count.', 'good'); },
    },
    hint: {
      title: 'One more hint',
      lead: 'Watch a short advertisement for one more hint on this board.',
      cta: 'Watch for a hint',
      grant() { state.hintsMax = (state.hintsMax ?? HINTS_PER_LEVEL) + 1; renderHud(); toast('One more hint.', 'good'); hint(); },
    },
    check: {
      title: `Two more ${CHECK_WORD}s`,
      lead: `Watch a short advertisement for two more ${CHECK_WORD}s on this board.`,
      cta: `Watch for ${CHECK_WORD}s`,
      grant() { state.checksMax = (state.checksMax ?? CHECKS_PER_LEVEL) + 2; renderHud(); toast(`Two more ${CHECK_WORD}s.`, 'good'); },
    },
    gold: {
      title: 'Gold for an advertisement',
      lead: 'Watch a short advertisement and the gold is added to your purse.',
      cta: 'Watch for gold',
      needsAccount: true,
      async grant() { await adClaimGold(); },
    },
  };

  // The offer. One sheet, one decision, and nothing is spent before the ad has actually been watched.
  function adOffer(kind, note) {
    const R = AD_REWARD[kind];
    if (!R || ads.showing) return;
    if (R.needsAccount && !auth.user) { openSignIn('Sign in first, so the gold has a purse to go into.'); return; }
    const wrap = document.createElement('div');
    wrap.className = 'aa-adoffer';
    wrap.innerHTML = `<div class="aa-adoffer-panel" role="dialog" aria-modal="true" aria-labelledby="aaAdTitle">
      <h3 id="aaAdTitle">${escapeHtml(R.title)}</h3>
      <p>${escapeHtml(note || R.lead)}</p>
      <div class="aa-actions aa-actions--stack">
        <button type="button" class="aa-btn aa-btn--primary" data-ad="go">${ICON_AD}${escapeHtml(R.cta)}</button>
        <button type="button" class="aa-btn" data-ad="no">No thanks</button>
      </div>
    </div>`;
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.addEventListener('click', async e => {
      if (e.target === wrap) { close(); return; }
      const act = e.target.closest('[data-ad]')?.dataset.ad;
      if (!act) return;
      if (act === 'no') { close(); return; }
      const btn = e.target.closest('[data-ad]');
      btn.disabled = true;
      const how = await adShow(`${PRODUCT_AD}-${kind}`);
      close();
      if (how !== 'watched') { toast(how === 'dismissed' ? 'The advertisement was not finished, so nothing was added.' : 'No advertisement was available. Try again in a moment.', 'hint'); return; }
      // Only now, and only once per board for the lifelines.
      if (kind !== 'gold') adSpend(kind);
      await R.grant();
    });
    $('[data-ad]', wrap)?.focus({ preventScroll: true });
  }
  const PRODUCT_AD = 'puzzle';

  // Gold is the server's to give. The client says an advertisement finished; the server decides what that is
  // worth, counts the day's claims from the ledger and answers with the balance it now holds.
  async function adClaimGold() {
    try {
      const r = await fetch(`${API_V1}/ads/reward`, { method: 'POST', credentials: 'include', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (d.error === 'ad_cap') toast('That is all the gold advertisements give today. Come back tomorrow.', 'hint', 4000);
        else if (d.error === 'signed_out') openSignIn('Sign in first, so the gold has a purse to go into.');
        else toast('The gold could not be added. Try again in a moment.', 'bad');
        if (typeof d.gold === 'number') setGold(d.gold);
        return;
      }
      setGold(d.gold);
      toast(d.granted ? `${gfmt(d.granted)} gold. ${d.left} more advertisement${d.left === 1 ? '' : 's'} today.` : 'That one was already counted.', 'good', 3500);
    } catch { toast('The gold could not be added. Try again in a moment.', 'bad'); }
  }

  // ── Accounts ──
  // Only for playing with other people: the single-player game never asks. The server keeps the provider's
  // opaque user id and the display name, nothing else, and the account can be deleted from the dashboard.
  // Signed out, the button opens the sign-in sheet; signed in, it opens the dashboard.
  const auth = { user: null, providers: {}, ready: false };
  // me is a read; everything else changes something and is posted. The paths are the versioned ones, so a
  // later backend can add a v2 without this client noticing.
  const AUTH_PATH = { me: '/auth/me', google: '/auth/google', name: '/auth/name', logout: '/auth/logout', delete: '/auth/delete' };
  function authApi(a, body) {
    const method = a === 'me' ? 'GET' : 'POST';
    return fetch(`${API_V1}${AUTH_PATH[a] || '/auth/me'}`, { method, credentials: 'include', cache: 'no-store', headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {}, body: method === 'POST' ? JSON.stringify(body || {}) : undefined })
      .then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(d.error || `HTTP ${r.status}`), { code: d.error }); return d; });
  }
  async function authLoad(force) {
    if (auth.ready && !force) return auth;
    try { const d = await authApi('me'); auth.user = d.user || null; auth.providers = d.providers || {}; }
    catch { auth.user = null; auth.providers = {}; }
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
    if (why && el.signInSheet) { const note = $('.aa-sheet-note', el.signInSheet); if (note) note.textContent = why; }
    if (el.googleBtn) el.googleBtn.innerHTML = '';
    if (el.signInNote) { el.signInNote.hidden = true; el.signInNote.textContent = ''; }
    openSheet(el.signInSheet);
    if (auth.providers.google) loadGis();
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
  async function onGoogleCredential(res) {
    try {
      const d = await authApi('google', { credential: res?.credential || '' });
      auth.user = d.user || null;
      const fresh = !!d.user && d.gold_granted;
      closeSheets();
      renderAccountRow();
      if (auth.user) syncTour();   // a new phone gets the tour back here; a player who played signed out gives theirs up
      if (auth.user) {
        if (state.pendingCode) { const c = state.pendingCode; state.pendingCode = null; openMatchLink(c); } else openStakes();
        toast(fresh ? `Welcome, ${auth.user.name}. ${Number(auth.user.gold || 0).toLocaleString('en-US')} gold to start you off.` : `Signed in as ${auth.user.name}`, 'good', fresh ? 5000 : 2800);
        if (typeof gtag === 'function') gtag('event', 'login', { method: 'google', game: 'puzzle' });
      }
    } catch (e) {
      signInNote(e.code === 'google_not_configured' ? 'Google sign-in is not switched on yet.' : 'That sign-in did not go through. Please try again.');
    }
  }
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
  const progressApi = body =>
    fetch(`${API_V1}/progress`, {
      method: body ? 'POST' : 'GET', credentials: 'include', cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(d.error || `HTTP ${r.status}`), { code: d.error }); return d; });

  const STATE_KEYS = ['home', 'form', 'dailyStreak'];   // what a new device needs before it can show the right tour

  /** Everything this device has played, in the shape the server stores. */
  function localTour() {
    const levels = {};
    const touch = id => (levels[id] ||= { cleared: false, skipped: false });
    try {
      for (const k of Object.keys(localStorage)) {
        if (!k.startsWith(STORE)) continue;
        const key = k.slice(STORE.length);
        if (key.startsWith('lv:')) {
          const r = store.get(key); if (!r) continue;
          const e = touch(key.slice(3));
          e.cleared = true;
          e.ms = typeof r.t === 'number' ? r.t : null;
          e.stars = r.stars || 0; e.quiz = !!r.quiz; e.tier = r.tier || 0; e.arrows = r.arrows || 0;
        } else if (key.startsWith('skip:')) {
          if (store.get(key)) touch(key.slice(5)).skipped = true;
        }
      }
    } catch { /* storage can be unreadable in a private window; syncing is optional, playing is not */ }
    return levels;
  }
  function localState() {
    const out = {};
    for (const k of STATE_KEYS) { const v = store.get(k, null); if (v !== null && v !== undefined) out[k] = v; }
    // A home country this device guessed from the connection is not the player's answer, so it stays here.
    // Only a home they picked in Settings is worth telling the account about.
    if (store.get('homeAuto', false)) delete out.home;
    const daily = {};
    try {
      for (const k of Object.keys(localStorage)) {
        if (!k.startsWith(STORE + 'daily:')) continue;
        const key = k.slice(STORE.length); const v = store.get(key); if (v) daily[key.slice(6)] = v;
      }
    } catch { /* as above */ }
    if (Object.keys(daily).length) out.daily = daily;
    return out;
  }

  // The same rule the server applies, applied here too — not for the server's benefit but for the race: a board
  // cleared while the request was in the air must not be undone by an answer that predates it.
  const betterRun = (a, b) => !b ? true : (a.stars || 0) !== (b.stars || 0) ? (a.stars || 0) > (b.stars || 0)
    : typeof a.t === 'number' && typeof b.t === 'number' ? a.t < b.t : typeof a.t === 'number';

  function adoptTour(server) {
    let changed = false;
    for (const [id, r] of Object.entries(server?.levels || {})) {
      if (r.cleared) {
        const next = { t: r.ms ?? 0, stars: r.stars || 0, quiz: !!r.quiz, tier: r.tier || 0, arrows: r.arrows || 0, at: r.at || Date.now() };
        if (betterRun(next, store.get('lv:' + id))) { store.set('lv:' + id, next); changed = true; }
      }
      if (r.skipped && !store.get('skip:' + id)) { store.set('skip:' + id, true); changed = true; }
    }
    const st = server?.state || {};
    for (const k of STATE_KEYS) if (st[k] !== undefined && JSON.stringify(st[k]) !== JSON.stringify(store.get(k, null))) { store.set(k, st[k]); changed = true; }
    if (st.home !== undefined) store.set('homeAuto', false);   // the account's home is a choice, however this device came by its own
    for (const [day, rec] of Object.entries(st.daily || {})) if (!store.get('daily:' + day)) { store.set('daily:' + day, rec); changed = true; }
    if (!changed) return false;
    // The home country may have moved, which reorders the whole tour, so rebuild it rather than only repainting.
    DATA.levels = tourFor(DATA, store.get('home', null));
    maskCache.clear(); forgetNums();
    if (!el.select.hidden) renderSelect();
    return true;
  }

  let syncing = null;
  /** Push what this device has, adopt what comes back. Safe to call as often as it is useful to. */
  function syncTour(levels) {
    if (!auth.user) return Promise.resolve(false);
    if (syncing) return syncing;
    const body = levels ? { levels, state: localState() } : { levels: localTour(), state: localState() };
    syncing = progressApi(body)
      .then(d => adoptTour(d))
      .catch(() => false)
      .finally(() => { syncing = null; });
    return syncing;
  }
  /** One board, the moment it is cleared. The full sync would do the same thing, more slowly and less often. */
  function pushOne(id, rec) {
    if (!auth.user || !id) return;
    syncTour({ [id]: { cleared: true, ms: rec.t ?? null, stars: rec.stars || 0, quiz: !!rec.quiz, tier: rec.tier || 0, arrows: rec.arrows || 0 } });
  }

  // ── Gold matches: stake, invite, play the same board, winner takes the pot ──
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
    return fetch(url, { method, credentials: 'include', cache: 'no-store', headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {}, body: method === 'POST' ? JSON.stringify(body || {}) : undefined })
      .then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(d.error || `HTTP ${r.status}`), { code: d.error, gold: d.gold }); return d; });
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
      if ((!this.code && !this.hold) || this.tries >= 4) return;
      const wait = Math.min(8000, 500 * 2 ** this.tries++);
      this.retry = setTimeout(() => this.open(), wait);
    },

    send(o) { if (this.connected) { try { this.ws.send(JSON.stringify(o)); } catch { /* the close handler tidies up */ } } },
    progress(pct) { this.send({ type: 'progress', pct }); },
    resync() { this.send({ type: 'resync' }); },

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
    el.overlay.hidden = false;
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
      if (btn) btn.textContent = d.delivered ? 'Invited' : 'Sent';
      // A batch from the dashboard speaks once for all of them, so it asks for the answer and does the talking.
      if (!quiet) toast(d.delivered ? `${name} has been asked to join.` : `${name} is not online — send them the link instead.`, d.delivered ? 'good' : 'hint');
      return !!d.delivered;
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Invite'; }
      if (!quiet) toast(err.code === 'not_played_together' ? 'You can only invite people you have played with.'
        : err.code === 'in_a_match' ? `${name} is on a board right now. Try again when they are done.`
        : err.code === 'taken' ? 'That room has already started.'
        : err.code === 'already_in' ? `${name} is already in this room.`
        : 'Could not send that invitation.', 'bad');
      return false;
    }
  }

  // Receiving one: the same card a shared link opens, so there is one way to say yes to a match.
  async function onInvite(ev) {
    const d = ev?.data || {};
    if (!d.code || !auth.user) return;
    // Not while a race board is on screen — and that includes the card that asks whether to try again, where
    // a challenge appearing under a thumb already on its way to a button is how somebody ends up in a match
    // they never chose. It is kept instead, and offered when they are back in the lobby.
    if (state.daily?.race) { state.inviteWaiting = { ...d, at: Date.now() }; toast(`${d.from || 'Somebody'} is challenging you. Finish here first.`, 'hint', 4000); return; }
    if (state.pendingMatch?.code === d.code) return;            // already looking at this room
    try {
      const r = await matchApi('get', { code: d.code });
      if (!r.match || r.match.state !== 'open') return;
      SFX.join?.(); vibe(20);
      closeSheets();
      showConfirm({ ...r.match, host: d.from || r.match.host, host_pic: d.pic || '' });
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
      <div class="aa-stakes">${stakesHtml(gold, waiting)}</div>
      <label class="aa-fill"><input type="checkbox" id="aaFillOnline"${fill ? ' checked' : ''}><span>Fill from online</span></label>
      <p class="aa-cap" id="aaRecentCap" hidden>Played with lately</p>
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
      : 'Played with lately · tap to invite';
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
    closeSheets();
    clearRun();                       // the waiting room shows this match's nothing, not the last one's ending
    el.select.hidden = true; el.game.hidden = false; el.board.innerHTML = '';
    el.hudLevel.textContent = 'Gold match'; el.hudLevel.classList.remove('is-disc');
    el.hudDiff.textContent = ''; el.hudLeft.textContent = '0'; el.hudPct.textContent = '0%';
    el.boardBar.style.width = '0%'; el.ranks.hidden = true;
    scrollToGame();
    if (history.replaceState) history.replaceState(null, '', location.pathname + location.search + '#m=' + m.code);
    renderRoom(m);
    el.overlay.hidden = false;
    startRoomPoll(m.code);
    tickFill(m.fills_in);   // after the poll: starting it clears any tick already running, this one included
  }
  function renderRoom(m) {
    const host = m.you === 'host';
    state.pendingMatch = m;
    el.card.innerHTML = `
      <p class="aa-card-kicker">Gold match · ${gpurse(m.stake)}</p>
      <h3>${m.count} of ${m.seats} joined</h3>
      <div class="aa-ranks aa-ranks--card">${faces(m.players)}</div>
      <p class="aa-wait">${roomWait(m, host)}</p>
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
      <p class="aa-sheet-note">Everyone puts in ${gpurse(m.stake)} gold and plays the very same board. Clear it first and you take the lot.${short ? ` <b>You have only ${gpurse(gold)}.</b>` : ''}</p>
      <div class="aa-actions">
        <button type="button" class="aa-btn aa-btn--primary" data-mact="join"${short ? ' disabled' : ''}>Confirm game</button>
        <button type="button" class="aa-btn" data-mact="close">Not now</button>
      </div>
      <p class="aa-flash" hidden></p>`;
    openSheet(el.matchSheet);
    wireFaces(el.matchBody);
    state.pendingMatch = m;
  }

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
      <b>${p.ms == null ? 'still playing' : p.ms < 0 ? 'ran out of hearts' : fmtTime(p.race_ms ?? p.ms, true)}</b></div>`;
    const purse = m.you_won ? `You won ${gpurse(m.pot)}` : m.winner ? `You lost ${gpurse(m.stake)}` : m.draw ? 'Every stake came back' : 'Your stake is held';
    el.matchBody.innerHTML = `
      <div class="aa-vs">${(m.players || []).map(row).join('')}</div>
      <p class="aa-purse"><span>${purse}</span><span class="aa-gold${m.you_won ? ' is-won' : ''}" title="${gfmt(auth.user?.gold ?? 0)} gold">${COIN}<span id="aaPurseCount">${gpurse(auth.user?.gold ?? 0)}</span></span></p>
      ${m.state === 'done' ? '' : '<p class="aa-sheet-note">The others are still playing for their place.</p>'}
      <div class="aa-actions"><button type="button" class="aa-btn aa-btn--primary" data-mact="stakes">Play another</button><button type="button" class="aa-btn" data-mact="close">Close</button></div>`;
    wireFaces(el.matchBody);
    openSheet(el.matchSheet);
    if (m.you_won && celebrate) {
      if (typeof goldBefore === 'number') purseWin = { from: goldBefore, to: auth.user?.gold ?? goldBefore };
      SFX.win(); vibe([0, 40, 60, 120]); goldRain(100, true);
      setTimeout(() => goldRain(60, true), 500);
      if (typeof goldBefore === 'number') countTo($('#aaPurseCount', el.matchBody), goldBefore, auth.user?.gold ?? goldBefore);
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
    const myPct = () => (state.pieces.length ? Math.round(((state.pieces.length - state.left) / state.pieces.length) * 100) : 0);
    const notePot = m => {
      if (m?.winner && !state.potGone && !state.finished) {   // the pot is gone; the places behind it are not
        state.potGone = true;
        SFX.taken(); toast(`${m.winner} cleared it first. Play on for second place.`);
      }
    };
    // The REST call is what carries the race while there is no socket, and stays on as a slow safety net when
    // there is one: it is also how the ranks come back, which is what the board beside the map is drawn from.
    const send = async () => {
      try {
        const d = await matchApi('progress', { code: R.match.code, pct: myPct() });
        renderRanks(d.match.players);
        syncRaceClock(d.match);     // the match's own age, in case this device slept through part of it
        notePot(d.match);
      } catch { /* the next tick will try again */ }
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
      if (ev.type === 'state' && ev.match) { renderRanks(ev.match.players); syncRaceClock(ev.match); notePot(ev.match); return; }
      if (ev.type === 'progress_updated' || ev.type === 'player_finished' || ev.type === 'match_finished') live.resync();
    });
    // While the socket is up, our own progress goes over it — no request per tap, no waiting for a reply.
    state.progressPush = setInterval(() => { if (live.connected) live.progress(myPct()); }, 1000);
    send();
    state.progressPoll = setInterval(send, pollEvery());
  }
  function stopProgressPoll() {
    clearInterval(state.progressPoll); state.progressPoll = 0;
    clearInterval(state.progressPush); state.progressPush = 0;
    live.onTune = null;
  }

  const matchBoardIndex = board => DATA.levels.findIndex(L => L.id === board);
  function playMatch(m) {
    // Never deal this board again over a run that is already on screen. A poll that arrives late, a link
    // opened twice, the back button — any of them used to restart the board under the player, which looked
    // like the game had pressed Try again for them. Getting back onto a board is a tap, and only a tap.
    if (state.daily?.race && state.daily.match?.code === m.code) return;
    const i = matchBoardIndex(m.board);
    if (i < 0) { toast('That board is not in this version of the game.', 'bad'); return; }
    closeSheets();
    state.pendingMatch = null;
    stopMatchPoll();
    startLevel(i, false, { key: 'match', race: true, match: m, board: m.board, tier: m.tier, seed: m.seed, hash: '#m=' + m.code })
      .then(() => { SFX.go(); vibe([0, 30, 60, 70]); });   // startLevel puts the line-up and the poll back
    if (typeof gtag === 'function') gtag('event', 'match_play', { game: 'puzzle', stake: m.stake });
  }

  async function sendInvite(m) {
    if (!m) return;
    const link = matchLink(m.code);
    const text = `Puzzle – Train Your Brain: I put ${gfmt(m.stake)} gold on a board. Match it, clear it before me and take the lot.\n${link}`;
    const flash = $('.aa-flash', el.overlay.hidden ? el.matchBody : el.card);
    try {
      if (navigator.share) { await navigator.share({ text }); return; }
      await navigator.clipboard.writeText(text);
      if (flash) { flash.textContent = 'Link copied. Paste it to your friend.'; flash.hidden = false; }
    } catch { if (flash) { flash.textContent = link; flash.hidden = false; } }
  }

  el.goldAd?.addEventListener('click', e => {
    e.stopPropagation();   // the chip itself opens the dashboard; the plus does not
    adOffer('gold');
  });

  const goldError = e => e.code === 'not_enough_gold' ? 'You do not have that much gold.' : e.code === 'taken' ? 'Someone already took that match.' : e.code === 'own_match' ? 'That is your own invitation.' : e.code === 'signed_out' ? 'Please sign in again.' : 'Something went wrong. Please try again.';

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
        const d = await matchApi('create', { stake: +stake, tier: TIER_OF(), open_to_all: fillOn() });
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
        if (err.code === 'not_enough_gold' && ads.on() && auth.user) adOffer('gold', 'Not enough gold for that table. Watch a short advertisement and some is added to your purse.');
        else toast(goldError(err), 'bad');
      }
      return;
    }
    if (!act) return;
    const m = state.pendingMatch;
    if (act === 'stakes') openFriends();
    else if (act === 'close') { closeSheets(); if (state.daily?.race && state.finished) goToLevels(); }
    else if (act === 'join' && m) {
      const btn = e.target.closest('[data-mact]'); btn.disabled = true;
      try { const d = await matchApi('join', { code: m.code, tier: TIER_OF() }); setGold(d.gold); showRoom(d.match); }
      catch (err) {
        btn.disabled = false;
        if (typeof err.gold === 'number') setGold(err.gold);
        if (err.code === 'not_enough_gold' && ads.on() && auth.user) adOffer('gold', 'Not enough gold for that table. Watch a short advertisement and some is added to your purse.');
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

  // Someone opened an invitation link. Signing in comes first, because the stake leaves a real purse.
  async function openMatchLink(code) {
    try {
      await authLoad();
      const d = await matchApi('get', null, '&code=' + encodeURIComponent(code));
      const m = d.match;
      if (typeof d.gold === 'number') setGold(d.gold);
      if (state.daily?.race && state.daily.match?.code === code) return;   // already on this board: leave it alone
      if (!auth.user) { state.pendingCode = code; openSignIn(`${m.host} put ${gfmt(m.stake)} gold on a board for you. Sign in to take the challenge.`); return; }
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
    if (el.goldAd) el.goldAd.hidden = !ads.on();
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
    if (!confirm(`Leave the challenge? Your ${gfmt(m.stake)} gold stays in the pot and the others play on.`)) return;
    stopProgressPoll(); stopTimer();
    state.finished = true; state.busy = true;
    try { const d = await matchApi('result', { code: m.code, ms: 0, cleared: false }); setGold(d.gold); }
    catch { /* the day's sweep counts a run that never came back as a loss anyway */ }
    goToLevels();
    toast('You left the challenge.');
  }

  function renderAccountRow() {
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
    try { await authApi('logout', {}); } catch { /* the cookie may already be gone */ }
    auth.user = null; live.close(); renderAccountRow(); closeSheets(); toast('Signed out.');
  });
  el.deleteAccBtn?.addEventListener('click', async () => {
    if (!confirm('Delete your account? Your gold and any matches go with it. The progress on this device stays.')) return;
    try { await authApi('delete', {}); auth.user = null; renderAccountRow(); closeSheets(); toast('Account deleted.'); }
    catch { toast('Could not delete the account. Please try again.', 'bad'); }
  });

  // The board is over: tell the server, then show where the gold went. Clearing it first pays the whole pot on
  // the spot; anyone finishing after that is playing for a place on the list, not for gold.
  //
  // A phone on a bad connection must not cost somebody the pot for a blink of a dropped request, so the result
  // is tried a few times, kept on the device if it still will not go, and sent again on the next visit. Only a
  // straight refusal from the server stops the retrying: asking again cannot change that answer.
  const PENDING = 'pendingResult';
  async function sendResult(code, ms, cleared) {
    let last;
    for (let i = 0; i < 3; i++) {
      try { return await matchApi('result', { code, ms, cleared }); }
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

  async function finishMatch(cleared, ms) {
    const R = state.daily;
    if (!R?.match) return;
    stopProgressPoll();
    const before = auth.user?.gold ?? 0;
    const sent = { code: R.match.code, ms: Math.max(0, Math.round(ms) || 0), cleared: !!cleared };
    try {
      const d = await sendResult(sent.code, sent.ms, sent.cleared);
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
      el.overlay.hidden = false;
    }
  }

  // A time that never got through, tried again: on the next visit, or when the player asks.
  async function flushResult(loud) {
    const p = store.get(PENDING, null);
    if (!p?.code) return false;
    try {
      const d = await sendResult(p.code, p.ms, p.cleared);
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
    const r = overSheet ? { width: innerWidth, height: innerHeight } : el.boardWrap.getBoundingClientRect();
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
      if (c.classList.contains('is-over')) { c.classList.remove('is-over'); el.boardWrap.insertBefore(c, el.toast); }
      return;
    }
    if (!fx.running && !c.classList.contains('is-over')) { const r = el.boardWrap.getBoundingClientRect(); c.width = Math.round(r.width); c.height = Math.round(r.height); }
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
      if (fx.parts.length) requestAnimationFrame(frame); else { ctx.clearRect(0, 0, c.width, c.height); c.hidden = true; if (c.classList.contains('is-over')) { c.classList.remove('is-over'); el.boardWrap.insertBefore(c, el.toast); } fx.running = false; }
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
  function renderHome() {
    const sel = el.homeSel; if (!sel || !DATA) return;
    if (!sel.options.length) {
      sel.appendChild(new Option('Auto (where you are)', 'auto'));
      sel.appendChild(new Option('World order (no home)', ''));
      for (const L of DATA.canon.slice().sort((a, b) => a.name.localeCompare(b.name))) sel.appendChild(new Option(L.name, L.a2));
    }
    const home = store.get('home', null); sel.value = home == null ? 'auto' : home;
    if (sel.value !== (home == null ? 'auto' : home)) sel.value = '';
  }
  el.homeSel?.addEventListener('change', async () => {
    const v = el.homeSel.value;
    if (v === 'auto') { try { localStorage.removeItem(STORE + 'home'); localStorage.removeItem(STORE + 'homeAuto'); } catch { /* ignore */ } const c = await homeCountry(DATA); DATA.levels = orderFor(DATA, c); maskCache.clear(); renderSelect(); }
    else setHome(v);
    toast(v === 'auto' ? 'Tour order follows where you are.' : v ? `Your tour now starts from ${DATA.levels[0].name}.` : 'Tour in world order.', 'hint');
  });
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
      zoom.ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      if (zoom.ptrs.size === 2) {
        // remember the board point under the pinch centre (board-local, unscaled) and the frame's origin on screen
        const [a, b] = [...zoom.ptrs.values()]; const r = el.board.getBoundingClientRect(); const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        zoom.pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), s: zoom.s, left0: r.left - zoom.x, top0: r.top - zoom.y, qx: (mx - r.left) / zoom.s, qy: (my - r.top) / zoom.s }; zoom.pan = null;
      }
      else if (zoom.ptrs.size === 1 && zoom.s > 1) zoom.pan = { x0: e.clientX, y0: e.clientY, zx: zoom.x, zy: zoom.y, moved: false };
    });
    wrap.addEventListener('pointermove', e => {
      if (!zoom.ptrs.has(e.pointerId)) return;
      zoom.ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      if (zoom.pinch && zoom.ptrs.size === 2) {
        const [a, b] = [...zoom.ptrs.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]); const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        const s1 = Math.max(zoom.MIN, Math.min(zoom.MAX, zoom.pinch.s * d / Math.max(1, zoom.pinch.d)));
        // keep the board point under the pinch centre where the fingers are: screen = origin + x + q * s
        zoom.s = s1; zoom.x = (mx - zoom.pinch.left0) - zoom.pinch.qx * s1; zoom.y = (my - zoom.pinch.top0) - zoom.pinch.qy * s1; applyZoom();
      } else if (zoom.pan && zoom.ptrs.size === 1) {
        const dx = e.clientX - zoom.pan.x0, dy = e.clientY - zoom.pan.y0;
        if (!zoom.pan.moved && Math.hypot(dx, dy) < 12) return;   // a tap on an arrow is still a tap
        zoom.pan.moved = true; zoom.x = zoom.pan.zx + dx; zoom.y = zoom.pan.zy + dy; applyZoom();
      }
    });
    const up = e => { zoom.ptrs.delete(e.pointerId); if (zoom.ptrs.size < 2) zoom.pinch = null; if (!zoom.ptrs.size) zoom.pan = null; };
    wrap.addEventListener('pointerup', up); wrap.addEventListener('pointercancel', up);
    wrap.addEventListener('wheel', e => { if (!el.game || el.game.hidden) return; e.preventDefault(); const r = el.board.getBoundingClientRect(); zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - r.left + zoom.x, e.clientY - r.top + zoom.y); }, { passive: false });
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
  const leagueApi = () => fetch(`${API_V1}/league`, { credentials: 'include', cache: 'no-store' })
    .then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d; });

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
    try { league.data = await leagueApi(); league.at = Date.now(); }
    catch { /* the league is a screen, never the game: if it cannot be read, the chip simply stays away */ }
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
    if (!d) { el.leagueBody.innerHTML = '<p class="aa-loading">Loading the league…</p>'; return; }
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
    toast(left > 0
      ? `Press and hold an arrow to see whether its lane is clear. ${left} ${left === 1 ? CHECK_WORD : CHECK_WORD + 's'} left.`
      : `No ${CHECK_WORD}s left on this level.`, left > 0 ? 'hint' : 'bad');
  });
  el.play.addEventListener('click', () => startLevel(+el.play.dataset.level || 0));
  // Sheets
  const openSheet = sh => { sh.hidden = false; document.body.style.overflow = 'hidden'; };
  const closeSheets = () => { stopResultWatch(); el.sheet.hidden = true; if (el.signInSheet) el.signInSheet.hidden = true; if (el.matchSheet) el.matchSheet.hidden = true; if (el.leagueSheet) el.leagueSheet.hidden = true; document.body.style.overflow = ''; };
  el.settingsBtns.forEach(b => b.addEventListener('click', () => {
    openSheet(el.sheet);
    renderAccountRow();                                   // with what the page already knows, at once
    authLoad(true).then(() => { renderAccountRow(); renderPurse(); syncTour(); }).catch(() => {});   // then with the server's answer, tour included
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
  function applyTheme(t) { document.documentElement.dataset.theme = t; store.set('theme', t); $('meta[name="theme-color"]')?.setAttribute('content', t === 'night' ? '#0E0E10' : t === 'mint' ? '#E6F2EC' : '#F4EDE0'); renderThemes(); }
  function renderThemes() {
    if (!el.themes) return;
    const cur = document.documentElement.dataset.theme || 'paper';
    el.themes.innerHTML = '';
    for (const t of THEMES) { const b = document.createElement('button'); b.type = 'button'; b.className = 'aa-theme' + (t === cur ? ' is-active' : ''); b.dataset.theme = t; b.textContent = t[0].toUpperCase() + t.slice(1); b.addEventListener('click', () => applyTheme(t)); el.themes.appendChild(b); }
  }
  el.themeBtn.addEventListener('click', () => { const cur = document.documentElement.dataset.theme || 'paper'; applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]); });
  applyTheme(THEMES.includes(store.get('theme')) ? store.get('theme') : 'paper');
  el.btnLevels.addEventListener('click', () => {
    if (state.daily?.race && state.daily.match && !state.finished) { leaveMatch(); return; }
    if (state.left < state.pieces.length && !state.finished && !confirm('Leave this level? Progress on it will be lost.')) return;
    goToLevels();
  });
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
    if (document.hidden) { musicStop(); return; }
    // Back on a board that was left mid-play. Nothing else restarts it now that music begins with a board
    // rather than with the first tap anywhere, so coming back is its own beginning.
    if (state.music && !el.game.hidden && !state.finished) musicStart();
  });
  el.btnGuides?.addEventListener('click', () => { state.guides = !state.guides; store.set('guides', state.guides); renderToggles(); });
  const goAbout = () => { closeSheets(); if (!el.game.hidden) goToLevels(); document.getElementById('aaAbout')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  el.howTo?.addEventListener('click', goAbout);
  // Reset progress used to be here. It wiped this device, which made sense when this device was the only place
  // a tour existed. It is not any more: the account holds it, so clearing local storage would have deleted
  // nothing and then re-downloaded it on the next sync — a button that looks destructive and does nothing.
  $$('a[href="#aaAbout"]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); goAbout(); }));
  renderToggles();
  document.addEventListener('keydown', e => { if (!el.game.hidden && !state.finished && (e.key === 'h' || e.key === 'H') && !/input|textarea/i.test(document.activeElement?.tagName || '')) hint(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && state.startedAt && !state.raceBase && !state.finished) { stopTimer(); } });
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
    const deep = /^#(level-\d+|b-[\w:]+|daily|m=[A-Za-z0-9]+)$/.test(location.hash);
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
    // the purse and the account row from the first paint, not only once Play with Friends has been tapped, and
    // a time from last time that never got through goes now
    authLoad().then(() => { renderPurse(); renderAccountRow(); syncTour(); return flushResult(false); }).catch(() => {});
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
