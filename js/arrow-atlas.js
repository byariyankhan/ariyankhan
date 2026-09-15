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
  const DATA_VERSION = '3';
  const STORE = 'aa:v1:';
  const LIVES = 4;                 // Classic and Rush; One Life has 1, Deep Focus none
  const DIFF_OF = tier => ['Normal', 'Normal', 'Hard', 'Super Hard', 'Expert'][tier];
  const COMBO_WINDOW_MS = 1500;
  const MILESTONES = [25, 50, 75, 90];
  const RUSH_SECONDS = 90;
  const HINT_PENALTY_MS = 5000;
  const HINTS_PER_LEVEL = 3;       // Classic and Rush; Deep Focus is unlimited
  const MODES = { classic: 'Classic', rush: 'Rush', onelife: 'One Life', focus: 'Deep Focus' };
  const livesFor = mode => mode === 'onelife' ? 1 : mode === 'focus' ? Infinity : LIVES;
  const TIER_OF = i => i < 5 ? 0 : i < 15 ? 1 : i < 30 ? 2 : i < 50 ? 3 : 4;
  const MAXLEN_OF = [4, 5, 6, 7, 8];
  const DIRS = { r: [0, 1], l: [0, -1], d: [1, 0], u: [-1, 0] };
  const PALETTE = ['#FFED54', '#5CD6FF', '#8CFF7A', '#FF9AD5', '#C79BFF', '#FFB347', '#6EE7B7', '#FDBA74', '#F97373', '#38BDF8'];

  const store = {
    get(k, fb) { try { const v = localStorage.getItem(STORE + k); return v == null ? fb : JSON.parse(v); } catch { return fb; } },
    set(k, v) { try { localStorage.setItem(STORE + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  const el = {
    select: $('#aaSelect'), levels: $('#aaLevels'), progress: $('#aaProgress'), progressBar: $('#aaProgressBar'), modes: $('#aaModes'), streak: $('#aaStreak'), daily: $('#aaDaily'), hudDiff: $('#aaHudDiff'),
    game: $('#aaGame'), boardWrap: $('#aaBoardWrap'), board: $('#aaBoard'), toast: $('#aaToast'), confetti: $('#aaConfetti'),
    hudLevel: $('#aaHudLevel'), hudMode: $('#aaHudMode'), hudTime: $('#aaHudTime'), hudLeft: $('#aaHudLeft'), hudLives: $('#aaHudLives'), hudLivesWrap: $('#aaHudLivesWrap'), hudPct: $('#aaHudPct'), boardBar: $('#aaBoardBar'),
    btnHint: $('#aaHint'), btnRestart: $('#aaRestart'), btnLevels: $('#aaBackToLevels'), btnSound: $('#aaSound'),
    overlay: $('#aaOverlay'), card: $('#aaCard'),
    loading: $('#aaLoading'), error: $('#aaError'),
  };
  if (!el.board) return;

  let DATA = null;
  const state = {
    mode: MODES[store.get('mode')] ? store.get('mode') : 'classic', muted: !!store.get('muted', false),
    idx: -1, level: null, tier: 0, mask: null, pieces: [], occ: null, W: 0, H: 0, left: 0,
    lives: LIVES, livesMax: LIVES, startedAt: 0, elapsed: 0, timerId: 0, finished: false, hintsUsed: 0, fails: 0, seedBump: 0, busy: false,
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
  function scrollToGame() { const top = el.game.getBoundingClientRect().top + window.scrollY - 84; window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' }); }
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
  const SFX = { shoot: () => beep([[880, 0, 0.07], [1320, 0.04, 0.08]]), block: () => beep([[150, 0, 0.18, 'square', 0.04]]), win: () => beep([[523, 0, 0.12], [659, 0.1, 0.12], [784, 0.2, 0.12], [1047, 0.3, 0.35]]), lose: () => beep([[300, 0, 0.2, 'triangle'], [220, 0.2, 0.35, 'triangle']]) };
  function renderSound() { el.btnSound.setAttribute('aria-pressed', String(!state.muted)); el.btnSound.textContent = state.muted ? 'Sound: off' : 'Sound: on'; }

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

  // ── Level select ──
  function renderSelect() {
    if (!DATA) return;
    const n = DATA.levels.length;
    const done = DATA.levels.filter((_, i) => cleared(i)).length;
    const learned = DATA.levels.filter((_, i) => cleared(i)?.quiz).length;
    el.progress.textContent = `${done}/${n} countries cleared · ${learned} named correctly`;
    const streak = store.get('streak', 0), dStreak = store.get('dailyStreak', { count: 0, last: '' });
    el.streak.textContent = streak >= 2 ? `🔥 ${streak}-level win streak` : dStreak.count >= 2 ? `🔥 ${dStreak.count}-day daily streak` : 'Clear levels in a row to build a win streak.';
    renderDaily();
    el.progressBar.style.width = `${(done / n) * 100}%`;
    el.modes.innerHTML = '';
    for (const m of [['classic', 'Classic', 'Timer counts up, 4 hearts, 3 hints'], ['rush', 'Rush', `${RUSH_SECONDS}s countdown, 4 hearts, 3 hints`], ['onelife', 'One Life', 'One heart. One blocked tap and it is over.'], ['focus', 'Deep Focus', 'No clock, no hearts. Just clear the map.']]) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'aa-mode' + (m[0] === state.mode ? ' is-active' : ''); b.dataset.mode = m[0]; b.setAttribute('aria-pressed', String(m[0] === state.mode));
      b.innerHTML = `<strong>${m[1]}</strong><span>${m[2]}</span>`;
      b.addEventListener('click', () => { state.mode = m[0]; store.set('mode', m[0]); renderSelect(); });
      el.modes.appendChild(b);
    }
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
      s.textContent = rec ? `${L.name} ${'★'.repeat(rec.stars)}` : open ? DIFF_OF(TIER_OF(i)) : '🔒';
      b.appendChild(s);
      b.addEventListener('click', () => startLevel(i));
      el.levels.appendChild(b);
    });
  }

  function renderDaily() {
    const d = dailyPick(), L = DATA.levels[d.idx], rec = store.get(`daily:${d.key}`);
    const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    el.daily.innerHTML = `
      <div class="aa-daily-text">
        <span class="aa-daily-kicker">Today's Country · ${date}</span>
        <strong>${rec ? L.name : 'A mystery country'} · ${DIFF_OF(d.tier)}</strong>
        <span class="aa-daily-sub">${rec ? `Cleared in ${fmtTime(rec.t, true)} ${'★'.repeat(rec.stars)} · play again for a better time` : 'One bonus board a day, any level of the tour. Same board for everyone today.'}</span>
      </div>
      <button type="button" class="aa-btn aa-btn--primary" data-daily>${rec ? 'Replay' : 'Play'}</button>`;
    $('[data-daily]', el.daily).addEventListener('click', () => startLevel(d.idx, false, d));
  }

  // ── Puzzle generation ──
  function generate(mask, maxLen, seed) {
    const H = mask.rows.length, W = mask.rows[0].length;
    const land = mask.rows.map(r => r.split('').map(ch => ch === '1'));
    for (let attempt = 0; attempt < 200; attempt++) {
      const rnd = mulberry32(seed * 7919 + attempt * 104729 + 17);
      const occ = Array.from({ length: H }, () => new Array(W).fill(-1));
      const pieces = [];
      let ord = 0;
      const empty = new Set();
      for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (land[r][c]) empty.add(r * W + c);
      const clearDirs = (r, c) => {
        const out = [];
        for (const [d, [dr, dc]] of Object.entries(DIRS)) {
          let y = r + dr, x = c + dc, ok = true;
          while (y >= 0 && y < H && x >= 0 && x < W) { if (occ[y][x] >= 0) { ok = false; break; } y += dr; x += dc; }
          if (ok) out.push(d);
        }
        return out;
      };
      let failed = false;
      while (empty.size) {
        // most constrained empty cell first, ties broken randomly
        let best = null, bestN = 9, bestDirs = null; const pool = Array.from(empty);
        for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
        for (const cell of pool) { const r = Math.floor(cell / W), c = cell % W; const ds = clearDirs(r, c); if (ds.length && ds.length < bestN) { best = [r, c]; bestN = ds.length; bestDirs = ds; if (bestN === 1) break; } }
        if (!best) {
          // Dead cell: every run to the edge is blocked. Absorb it into a neighbouring piece whose tail
          // touches it and which points away from it — the head's run is unchanged, so it stays solvable.
          // Solvability invariant: a piece's exit line must be clear of every piece with a smaller `ord`
          // (placed earlier = removed later). Appending the cell to q's tail is safe when the cell is not on
          // the exit line of q or of any piece newer than q. If a newer piece is in the way but q's own exit
          // line is clear right now, q can simply become the newest piece (be removed first) instead.
          let merged = false;
          const onExitOf = (P, r, c) => { const [pr, pc] = DIRS[P.dir], [hy, hx] = P.cells[0]; return pr ? c === hx && Math.sign(r - hy) === pr : r === hy && Math.sign(c - hx) === pc; };
          const lineClear = P => { const [pr, pc] = DIRS[P.dir]; let [y, x] = P.cells[0]; y += pr; x += pc; while (y >= 0 && y < H && x >= 0 && x < W) { if (occ[y][x] >= 0 && occ[y][x] !== P.idx) return false; y += pr; x += pc; } return true; };
          for (const cell of pool) {
            const r = Math.floor(cell / W), c = cell % W;
            for (const [dr, dc] of Object.values(DIRS)) {
              const y = r + dr, x = c + dc; if (y < 0 || y >= H || x < 0 || x >= W || occ[y][x] < 0) continue;
              const q = pieces[occ[y][x]]; const tail = q.cells[q.cells.length - 1], head = q.cells[0];
              if (q.cells.length >= maxLen + 6) continue;
              // Cell directly in front of q's head: q's head simply moves forward onto it. Its exit line is the
              // rest of q's old line, which was already clear of every older piece, so nothing changes.
              const [qr, qc] = DIRS[q.dir];
              if (head[0] === y && head[1] === x && head[0] + qr === r && head[1] + qc === c) {
                if (pieces.some(P => P.ord > q.ord && onExitOf(P, r, c))) { if (!lineClear(q)) continue; q.ord = ++ord; }
                q.cells.unshift([r, c]); occ[r][c] = q.idx; empty.delete(cell); merged = true; break;
              }
              if (tail[0] !== y || tail[1] !== x || onExitOf(q, r, c)) continue;
              if (pieces.some(P => P.ord > q.ord && onExitOf(P, r, c))) { if (!lineClear(q)) continue; q.ord = ++ord; }
              q.cells.push([r, c]); occ[r][c] = q.idx; empty.delete(cell); merged = true; break;
            }
            if (merged) break;
          }
          if (merged) continue;
          failed = true; break;
        }
        const [r, c] = best;
        const dir = bestDirs[Math.floor(rnd() * bestDirs.length)];
        const [dr, dc] = DIRS[dir];
        const len = 3 + Math.floor(rnd() * (maxLen - 2));
        const cells = [[r, c]];
        // The body snakes backwards through empty land cells (random walk, no revisits), never onto the head's
        // own exit line — that would block itself. Turns are what make the board look like a maze.
        const onExit = (y, x) => (dr ? x === c && Math.sign(y - r) === dr : y === r && Math.sign(x - c) === dc);
        let py = r, px = c, pdir = [-dr, -dc];
        for (let k = 1; k < len; k++) {
          const opts = [];
          for (const [ddr, ddc] of Object.values(DIRS)) {
            const y = py + ddr, x = px + ddc;
            if (y < 0 || y >= H || x < 0 || x >= W || !land[y][x] || occ[y][x] >= 0 || onExit(y, x) || cells.some(([cy, cx]) => cy === y && cx === x)) continue;
            opts.push([ddr, ddc]);
          }
          if (!opts.length) break;
          const straight = opts.find(([a, b]) => a === pdir[0] && b === pdir[1]);
          const step = straight && rnd() < 0.62 ? straight : opts[Math.floor(rnd() * opts.length)];
          py += step[0]; px += step[1]; pdir = step; cells.push([py, px]);
        }
        const idx = pieces.length;
        for (const [y, x] of cells) { occ[y][x] = idx; empty.delete(y * W + x); }
        pieces.push({ idx, ord: ++ord, cells, dir, color: PALETTE[idx % PALETTE.length] });
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
    svg.setAttribute('viewBox', `-0.5 -0.5 ${W + 1} ${H + 1}`);
    svg.classList.toggle('aa-board--tall', H > W * 1.25);
    const t = state.maskInfo;
    const outline = svgEl('path', { d: state.level.d, class: 'aa-outline', transform: `translate(${-t.x} ${-t.y}) scale(${t.k})` });
    svg.appendChild(outline);
    state.outlineEl = outline;
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
      headG.appendChild(svgEl('path', { d: 'M-0.34 -0.3 L0.08 0 L-0.34 0.3', class: 'aa-head' }));
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
  async function startLevel(i, bumpSeed = false, daily = null) {
    try { await loadData(); } catch (err) { el.error.textContent = `Could not load the levels (${err.message}).`; el.error.hidden = false; return; }
    if (i < 0 || i >= DATA.levels.length) i = 0;
    if (!daily && !unlocked(i)) i = DATA.levels.findIndex((_, j) => !cleared(j) && unlocked(j));
    if (i < 0) i = 0;
    stopTimer();
    if (bumpSeed) state.seedBump++; else if (state.idx !== i || !!daily !== !!state.daily) { state.seedBump = 0; state.fails = 0; }
    state.daily = daily;
    state.idx = i; state.level = DATA.levels[i]; state.tier = daily ? daily.tier : TIER_OF(i);
    state.maskInfo = state.level.tiers[state.tier];
    const gen = generate(state.maskInfo, MAXLEN_OF[state.tier], (daily ? daily.seed : (i + 1) * 1000) + state.seedBump);
    const livesMax = livesFor(state.mode);
    Object.assign(state, { W: gen.W, H: gen.H, pieces: gen.pieces, occ: gen.occ, land: gen.land, left: gen.pieces.length, lives: livesMax, livesMax, elapsed: 0, startedAt: 0, finished: false, hintsUsed: 0, busy: false, combo: 0, bestCombo: 0, lastShot: 0, shown: new Set() });
    el.select.hidden = true; el.game.hidden = false; el.overlay.hidden = true; el.error.hidden = true; el.loading.hidden = true;
    if (daily) { if (history.replaceState) history.replaceState(null, '', location.pathname + location.search + '#daily'); } else setHash(i);
    scrollToGame();
    renderBoard(); renderHud();
    const diff = DIFF_OF(state.tier);
    if (i === 0 && !cleared(0) && !daily) toast('Tap an arrow to shoot it off the board. If another arrow is in its way, you lose a heart.', 'hint');
    else if (diff !== 'Normal') toast(`${diff.toUpperCase()} LEVEL · ${state.pieces.length} arrows${state.mode === 'onelife' ? ' · one heart' : ''}`, 'hard');
    else toast(`${daily ? 'Daily board' : 'Level ' + (i + 1)} · ${state.pieces.length} arrows · which country is this?`);
  }

  function renderHud() {
    el.hudLevel.textContent = state.daily ? 'Daily' : `Level ${state.idx + 1}`;
    el.hudMode.textContent = MODES[state.mode];
    el.hudDiff.textContent = DIFF_OF(state.tier);
    el.hudDiff.className = 'aa-hud-diff aa-hud-diff--' + DIFF_OF(state.tier).toLowerCase().replace(' ', '-');
    const focus = state.mode === 'focus';
    el.hudLivesWrap.hidden = focus;
    const hintsLeft = HINTS_PER_LEVEL - state.hintsUsed;
    el.btnHint.textContent = focus ? 'Hint' : `Hint (${Math.max(0, hintsLeft)})`;
    el.btnHint.disabled = state.finished || (!focus && hintsLeft <= 0);
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
    el.hudTime.textContent = state.mode === 'focus' ? '∞' : state.mode === 'rush' ? fmtTime(RUSH_SECONDS * 1000 - e) : fmtTime(e);
    el.hudTime.classList.toggle('is-low', state.mode === 'rush' && RUSH_SECONDS * 1000 - e < 15000);
  }
  function startTimer() {
    if (state.startedAt || state.finished) return;
    state.startedAt = performance.now();
    state.timerId = setInterval(() => { renderTime(); if (state.mode === 'rush' && currentElapsed() >= RUSH_SECONDS * 1000) failLevel('Time is up!'); }, 200);
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
    SFX.shoot();
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
    const focus = state.mode === 'focus';
    if (!focus) state.lives--;
    SFX.block();
    p.el.classList.remove('is-shake'); void p.el.getBBox(); p.el.classList.add('is-shake');
    blocker.el.classList.add('is-blocker');
    setTimeout(() => blocker.el.classList.remove('is-blocker'), 600);
    setTimeout(() => p.el.classList.remove('is-shake'), 400);
    renderHud();
    if (focus) toast('Blocked. The red arrow is in the way. No penalty in Deep Focus.', 'bad');
    else if (state.lives <= 0) failLevel('Out of hearts.');
    else toast(state.lives === 1 ? 'Blocked! Last heart, look before you tap.' : 'Blocked! The red arrow is in the way.', 'bad');
  }
  function hint() {
    if (state.finished) return;
    const focus = state.mode === 'focus';
    if (!focus && state.hintsUsed >= HINTS_PER_LEVEL) { toast('No hints left on this level.', 'bad'); return; }
    const p = state.pieces.find(q => !q.gone && !blockerOf(q));
    if (!p) return;
    startTimer();
    state.hintsUsed++; if (!focus) state.elapsed += HINT_PENALTY_MS;
    $$('.aa-piece.is-hint', el.board).forEach(g => g.classList.remove('is-hint'));
    p.el.classList.add('is-hint');
    setTimeout(() => p.el.classList.remove('is-hint'), 2500);
    toast(focus ? 'Hint: the glowing arrow is free.' : `Hint: the glowing arrow is free. +${HINT_PENALTY_MS / 1000}s on the clock, ${HINTS_PER_LEVEL - state.hintsUsed} left.`, 'hint');
    renderHud();
  }

  // ── End of level ──
  function stars() { if (state.mode === 'focus') return state.hintsUsed === 0 ? 3 : state.hintsUsed <= 2 ? 2 : 1; const lost = state.livesMax - state.lives; return lost === 0 ? 3 : lost === 1 ? 2 : 1; }
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
    const prev = state.daily ? store.get(`daily:${state.daily.key}`) : cleared(i);
    const isBest = !prev || t < prev.t;
    const rec = { t: isBest ? t : prev.t, stars: Math.max(s, prev?.stars || 0), quiz: !!(quizRight || prev?.quiz), at: Date.now() };
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
      <div class="aa-stats"><span><b>${fmtTime(t, true)}</b>time</span><span><b>${state.mode === 'focus' ? '∞' : LIVES - state.lives}</b>${state.mode === 'focus' ? 'hearts' : 'hearts lost'}</span><span><b>${state.hintsUsed}</b>hints</span><span><b>x${state.bestCombo}</b>best combo</span></div>
      <p class="aa-facts">${facts}</p>
      <p class="aa-best">${isBest ? (prev ? `New best time! Previous ${fmtTime(prev.t, true)}.` : 'First clear. That is your time to beat.') : `Your best: ${fmtTime(prev.t, true)}.`}</p>
      <div class="aa-actions">
        ${last || state.daily ? '' : `<button type="button" class="aa-btn aa-btn--primary" data-act="next">Next: Level ${i + 2}</button>`}
        <button type="button" class="aa-btn" data-act="again">Play again</button>
        <button type="button" class="aa-btn" data-act="share">Share</button>
        <button type="button" class="aa-btn" data-act="levels">World Tour</button>
      </div>
      <p class="aa-flash" hidden></p>
      <p class="aa-yt">Curious about ${L.name}? I make geography, history and economy videos: <a href="https://www.youtube.com/@ariyankhan" target="_blank" rel="noopener">youtube.com/@ariyankhan</a></p>`;
    el.overlay.hidden = false;
    $('[data-act]', el.card)?.focus({ preventScroll: true });
    if (typeof gtag === 'function') gtag('event', 'level_complete', { game: 'arrow_atlas', level: i + 1, mode: state.mode, time_ms: t, stars: s, quiz: quizRight ? 1 : 0 });
  }
  function failLevel(reason) {
    if (state.finished) return;
    stopTimer(); state.finished = true; state.busy = true; state.fails++;
    store.set('streak', 0);
    SFX.lose(); renderHud();
    const canSkip = !state.daily && state.fails >= 2 && state.idx < DATA.levels.length - 1;
    el.card.innerHTML = `
      <p class="aa-card-kicker">${state.daily ? 'Daily board' : `Level ${state.idx + 1}`} · ${DIFF_OF(state.tier)}</p>
      <h3>${reason}</h3>
      <p class="aa-card-lead">${state.left} of ${state.pieces.length} arrows were still on the board.</p>
      <div class="aa-actions">
        <button type="button" class="aa-btn aa-btn--primary" data-act="retry">Try again</button>
        <button type="button" class="aa-btn" data-act="shuffle">New layout</button>
        ${canSkip ? '<button type="button" class="aa-btn" data-act="skip">Skip level</button>' : ''}
        <button type="button" class="aa-btn" data-act="levels">World Tour</button>
      </div>`;
    el.overlay.hidden = false;
    $('[data-act]', el.card)?.focus({ preventScroll: true });
  }
  el.card.addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
    if (act === 'next') startLevel(state.idx + 1);
    else if (act === 'again' || act === 'retry') startLevel(state.idx, false, state.daily);
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
    const text = `Arrow Atlas: I cleared ${state.level.name} (${state.daily ? 'daily board ' + state.daily.key : 'level ' + (state.idx + 1)}, ${MODES[state.mode]}) in ${fmtTime(rec?.t ?? state.elapsed, true)} ${'★'.repeat(rec?.stars || stars())} and ${done}/${n} countries so far.\nYour turn: https://ariyankhan.com/arrow-atlas.html${state.daily ? '#daily' : '#level-' + (state.idx + 1)}`;
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
  el.btnRestart.addEventListener('click', () => startLevel(state.idx, false, state.daily));
  el.btnLevels.addEventListener('click', () => { if (state.left < state.pieces.length && !state.finished && !confirm('Leave this level? Progress on it will be lost.')) return; goToLevels(); });
  el.btnSound.addEventListener('click', () => { state.muted = !state.muted; store.set('muted', state.muted); renderSound(); if (!state.muted) SFX.shoot(); });
  document.addEventListener('keydown', e => { if (!el.game.hidden && !state.finished && (e.key === 'h' || e.key === 'H') && !/input|textarea/i.test(document.activeElement?.tagName || '')) hint(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && state.startedAt && !state.finished) { stopTimer(); } });
  el.board.addEventListener('pointerdown', () => { if (!state.startedAt && !state.finished && state.elapsed) startTimer(); });

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
