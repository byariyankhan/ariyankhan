/* ══════════════════════════════════════════════════
   PIECE THE WORLD — region jigsaw game
   No dependencies. Level data lives in games/data/<level>.json
   (built by a script from Natural Earth 1:50m, equal-area projection).
   Pieces are SVG paths already in board coordinates, so a piece is
   "home" when its translation is (0,0). Dragging shows a ghost at
   real board scale in a fixed overlay; dropping close enough snaps.
   ══════════════════════════════════════════════════ */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DATA_VERSION = '1';
  const STORE_PREFIX = 'ptw:v1:';

  // Level order doubles as the "next level" chain.
  const LEVELS = [
    { id: 'world', name: 'World', pieces: 7, tag: 'The seven continents', blurb: 'Warm up: drop each continent where it belongs.' },
    { id: 'europe', name: 'Europe', pieces: 38, tag: '38 countries', blurb: 'The Balkans will test you.' },
    { id: 'asia', name: 'Asia', pieces: 36, tag: '36 countries', blurb: 'From Turkey to Japan, the biggest board.' },
    { id: 'africa', name: 'Africa', pieces: 49, tag: '49 countries', blurb: 'The most pieces of any level.' },
    { id: 'north-america', name: 'North America', pieces: 12, tag: '12 countries', blurb: 'Central America is smaller than you think.' },
    { id: 'south-america', name: 'South America', pieces: 12, tag: '12 countries', blurb: 'Twelve pieces, one very long Chile.' },
    { id: 'oceania', name: 'Oceania', pieces: 7, tag: '7 countries', blurb: 'Islands, islands, islands.' },
  ];
  const MODES = [
    { id: 'easy', label: 'Easy', desc: 'Outlines and names on the board' },
    { id: 'normal', label: 'Normal', desc: 'Outlines only, names on the pieces' },
    { id: 'hard', label: 'Hard', desc: 'Silhouette only, no names anywhere' },
  ];
  const PALETTE = ['#FFED54', '#FF7B5C', '#5CD6FF', '#8CFF7A', '#FF9AD5', '#C79BFF', '#FFB347', '#6EE7B7', '#F97373', '#A3E635', '#38BDF8', '#FDBA74'];

  // ── Storage (best-effort; private mode may throw) ──
  const store = {
    get(k, fallback) { try { const v = localStorage.getItem(STORE_PREFIX + k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
    set(k, v) { try { localStorage.setItem(STORE_PREFIX + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  // ── DOM ──
  const el = {
    select: $('#ptwSelect'), levels: $('#ptwLevels'), modes: $('#ptwModes'),
    game: $('#ptwGame'), boardWrap: $('#ptwBoardWrap'), board: $('#ptwBoard'), tray: $('#ptwTray'), trayHint: $('#ptwTrayHint'),
    ghost: $('#ptwGhost'), toast: $('#ptwToast'), confetti: $('#ptwConfetti'),
    hudLevel: $('#ptwHudLevel'), hudMode: $('#ptwHudMode'), hudTime: $('#ptwHudTime'), hudCount: $('#ptwHudCount'), hudMiss: $('#ptwHudMiss'),
    btnHint: $('#ptwHint'), btnRestart: $('#ptwRestart'), btnLevels: $('#ptwBackToLevels'), btnSound: $('#ptwSound'),
    done: $('#ptwDone'), doneTitle: $('#ptwDoneTitle'), doneStars: $('#ptwDoneStars'), doneStats: $('#ptwDoneStats'), doneBest: $('#ptwDoneBest'),
    btnAgain: $('#ptwAgain'), btnNext: $('#ptwNext'), btnHarder: $('#ptwHarder'), btnShare: $('#ptwShare'), doneFlash: $('#ptwDoneFlash'),
    error: $('#ptwError'), loading: $('#ptwLoading'),
  };
  if (!el.board) return;

  // ── State ──
  const cache = new Map();
  const state = {
    mode: MODES.some(m => m.id === store.get('mode')) ? store.get('mode') : 'normal',
    muted: !!store.get('muted', false),
    level: null, data: null, rank: new Map(), remaining: new Set(), placedCount: 0,
    misses: 0, hints: 0, startedAt: 0, elapsed: 0, timerId: 0, finished: false,
    selected: null, drag: null, hintTimer: 0,
  };

  // ── Helpers ──
  const fmtTime = (ms, tenths) => {
    const s = ms / 1000, m = Math.floor(s / 60), r = s - m * 60;
    return tenths ? `${m}:${r.toFixed(1).padStart(4, '0')}` : `${m}:${String(Math.floor(r)).padStart(2, '0')}`;
  };
  const fmtPop = n => !n ? '' : n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${Math.round(n / 1e6)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n);
  const levelMeta = id => LEVELS.find(l => l.id === id);
  const modeMeta = id => MODES.find(m => m.id === id);
  const bestKey = (level, mode) => `best:${level}:${mode}`;
  const svgEl = (tag, attrs = {}) => { const n = document.createElementNS(SVG_NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
  const shuffle = arr => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
  const pieceDims = p => [p.bbox[2] - p.bbox[0], p.bbox[3] - p.bbox[1]];
  const ordinalRank = r => r === 1 ? 'largest' : r === 2 ? '2nd largest' : r === 3 ? '3rd largest' : `#${r} by area`;

  function scrollToGame() {
    const top = el.game.getBoundingClientRect().top + window.scrollY - 84;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  function setHash(level, mode) {
    const h = level ? `#${level}${mode && mode !== 'normal' ? '-' + mode : ''}` : '';
    if (history.replaceState) history.replaceState(null, '', location.pathname + location.search + h);
  }

  // ── Sound (tiny synthesised blips, no assets) ──
  let audio = null;
  function beep(notes) {
    if (state.muted) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      const t0 = audio.currentTime;
      notes.forEach(([freq, start, dur, type = 'sine', gain = 0.08]) => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.type = type; o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t0 + start);
        g.gain.exponentialRampToValueAtTime(gain, t0 + start + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
        o.connect(g).connect(audio.destination);
        o.start(t0 + start); o.stop(t0 + start + dur + 0.02);
      });
    } catch { /* no audio, no problem */ }
  }
  const SFX = {
    place: () => beep([[660, 0, 0.08], [990, 0.06, 0.12]]),
    miss: () => beep([[160, 0, 0.16, 'square', 0.04]]),
    win: () => beep([[523, 0, 0.12], [659, 0.1, 0.12], [784, 0.2, 0.12], [1047, 0.3, 0.35]]),
  };
  function renderSound() {
    el.btnSound.setAttribute('aria-pressed', String(!state.muted));
    el.btnSound.textContent = state.muted ? 'Sound: off' : 'Sound: on';
  }

  // ── Toast ──
  let toastTimer = 0;
  function toast(msg, kind = '') {
    el.toast.textContent = msg;
    el.toast.className = 'ptw-toast' + (kind ? ' ptw-toast--' + kind : '');
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2600);
  }

  // ── Level select screen ──
  function renderSelect() {
    el.modes.innerHTML = '';
    for (const m of MODES) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'ptw-mode' + (m.id === state.mode ? ' is-active' : '');
      b.dataset.mode = m.id; b.setAttribute('aria-pressed', String(m.id === state.mode));
      b.innerHTML = `<strong>${m.label}</strong><span>${m.desc}</span>`;
      b.addEventListener('click', () => { state.mode = m.id; store.set('mode', m.id); renderSelect(); });
      el.modes.appendChild(b);
    }
    el.levels.innerHTML = '';
    for (const L of LEVELS) {
      const best = store.get(bestKey(L.id, state.mode));
      const card = document.createElement('button');
      card.type = 'button'; card.className = 'ptw-level'; card.dataset.level = L.id;
      card.innerHTML = `
        <span class="ptw-level-name">${L.name}</span>
        <span class="ptw-level-tag">${L.tag}</span>
        <span class="ptw-level-blurb">${L.blurb}</span>
        <span class="ptw-level-best">${best ? `${'★'.repeat(best.stars)}${'☆'.repeat(3 - best.stars)} Best ${fmtTime(best.t, true)} · ${best.acc}%` : 'Not played yet on ' + modeMeta(state.mode).label}</span>
        <span class="ptw-level-play">Play</span>`;
      card.addEventListener('click', () => startLevel(L.id, state.mode));
      card.addEventListener('pointerenter', () => { loadLevel(L.id).catch(() => {}); }, { once: true });
      el.levels.appendChild(card);
    }
  }

  // ── Data ──
  async function loadLevel(id) {
    if (cache.has(id)) return cache.get(id);
    const p = fetch(`games/data/${id}.json?v=${DATA_VERSION}`, { cache: 'force-cache' }).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }).catch(err => { cache.delete(id); throw err; });
    cache.set(id, p);
    return p;
  }

  // ── Game lifecycle ──
  async function startLevel(id, mode) {
    if (!levelMeta(id)) id = 'world';
    if (!modeMeta(mode)) mode = 'normal';
    state.mode = mode; store.set('mode', mode);
    el.select.hidden = true; el.game.hidden = false; el.done.hidden = true; el.error.hidden = true; el.loading.hidden = false;
    setHash(id, mode); scrollToGame();
    let data;
    try { data = await loadLevel(id); }
    catch (err) {
      el.loading.hidden = true;
      el.error.textContent = `Could not load the ${levelMeta(id).name} level (${err.message}). Check your connection and try again.`;
      el.error.hidden = false;
      return;
    }
    el.loading.hidden = true;
    resetState(id, data);
    renderBoard();
    renderTray();
    renderHud();
  }

  function resetState(id, data) {
    stopTimer(); clearTimeout(state.hintTimer); cancelDrag();
    state.level = id; state.data = data;
    state.remaining = new Set(data.pieces.map(p => p.id));
    state.placedCount = 0; state.misses = 0; state.hints = 0; state.startedAt = 0; state.elapsed = 0;
    state.finished = false; state.selected = null;
    // Rank every country (incl. auto-placed) by projected area — the projection is equal-area, so this is true size.
    const all = [...data.pieces, ...data.auto].slice().sort((a, b) => b.area - a.area);
    state.rank = new Map(all.map((p, i) => [p.id, i + 1]));
    state.color = new Map(data.pieces.map((p, i) => [p.id, PALETTE[i % PALETTE.length]]));
    data.auto.forEach((p, i) => state.color.set(p.id, PALETTE[(i + 5) % PALETTE.length]));
  }

  function renderBoard() {
    const { data } = state;
    const svg = el.board;
    svg.innerHTML = '';
    svg.setAttribute('viewBox', `0 0 ${data.board.w} ${data.board.h}`);
    svg.classList.toggle('ptw-board--hard', state.mode === 'hard');
    svg.classList.toggle('ptw-board--tall', data.board.h > data.board.w);
    if (data.sphere) svg.appendChild(svgEl('path', { d: data.sphere, class: 'ptw-sphere' }));
    const targets = svgEl('g', { class: 'ptw-targets' });
    const autos = svgEl('g', { class: 'ptw-autos' });
    const placed = svgEl('g', { class: 'ptw-placed-layer' });
    const labels = svgEl('g', { class: 'ptw-labels' });
    const fx = svgEl('g', { class: 'ptw-fx' });
    for (const p of data.pieces) targets.appendChild(svgEl('path', { d: p.d, class: 'ptw-target', 'data-id': p.id }));
    for (const p of data.auto) {
      const a = svgEl('path', { d: p.d, class: 'ptw-auto', fill: state.color.get(p.id) });
      a.appendChild(svgEl('title')).textContent = `${p.name} (placed for you)`;
      autos.appendChild(a);
    }
    if (state.mode === 'easy') {
      const fs = Math.max(11, Math.round(data.board.w / 72));
      for (const p of data.pieces) {
        const [bw, bh] = pieceDims(p);
        if (Math.min(bw, bh) < fs * 2.6) continue;
        const t = svgEl('text', { x: p.cx, y: p.cy, class: 'ptw-label', 'font-size': fs, 'data-id': p.id });
        t.textContent = p.name;
        labels.appendChild(t);
      }
    }
    svg.append(targets, autos, placed, labels, fx);
  }

  function renderTray() {
    const { data } = state;
    el.tray.innerHTML = '';
    el.tray.classList.toggle('ptw-tray--nonames', state.mode === 'hard');
    const order = shuffle(data.pieces.slice());
    for (const p of order) el.tray.appendChild(makeTrayPiece(p));
    el.trayHint.textContent = data.auto.length
      ? `${data.pieces.length} pieces. ${data.auto.length} tiny ${data.auto.length === 1 ? 'country is' : 'countries are'} placed for you (${data.auto.slice(0, 3).map(a => a.name).join(', ')}${data.auto.length > 3 ? '…' : ''}).`
      : `${data.pieces.length} pieces. Drag each one onto the board.`;
  }

  function makeTrayPiece(p) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'ptw-piece'; btn.dataset.id = p.id;
    btn.setAttribute('aria-label', state.mode === 'hard' ? 'Puzzle piece' : p.name);
    const [bw, bh] = pieceDims(p);
    const maxDim = Math.max(bw, bh);
    const size = Math.round(Math.min(96, Math.max(44, 30 + maxDim * 0.12)));
    const pad = maxDim * 0.06;
    const svg = svgEl('svg', { viewBox: `${p.bbox[0] - pad} ${p.bbox[1] - pad} ${bw + pad * 2} ${bh + pad * 2}`, width: size, height: size, 'aria-hidden': 'true', focusable: 'false' });
    svg.appendChild(svgEl('path', { d: p.d, fill: state.color.get(p.id) }));
    btn.appendChild(svg);
    if (state.mode !== 'hard') { const n = document.createElement('span'); n.className = 'ptw-piece-name'; n.textContent = p.name; btn.appendChild(n); }
    btn.addEventListener('pointerdown', e => beginDrag(e, p, btn));
    btn.addEventListener('click', () => {
      if (btn.dataset.suppressClick) { delete btn.dataset.suppressClick; return; }
      selectPiece(state.selected === p.id ? null : p.id);
    });
    return btn;
  }

  function selectPiece(id) {
    state.selected = id;
    $$('.ptw-piece', el.tray).forEach(b => b.classList.toggle('is-selected', b.dataset.id === id));
    if (id) toast(state.mode === 'hard' ? 'Piece selected. Tap the board where it belongs.' : `${pieceById(id).name} selected. Tap the board where it belongs.`);
  }
  const pieceById = id => state.data.pieces.find(p => p.id === id);

  function renderHud() {
    el.hudLevel.textContent = levelMeta(state.level).name;
    el.hudMode.textContent = modeMeta(state.mode).label;
    el.hudCount.textContent = `${state.placedCount}/${state.data.pieces.length}`;
    el.hudMiss.textContent = String(state.misses);
    el.hudTime.textContent = fmtTime(currentElapsed());
    el.btnHint.disabled = state.finished || state.remaining.size === 0;
  }

  // ── Timer ──
  const currentElapsed = () => state.startedAt ? state.elapsed + (performance.now() - state.startedAt) : state.elapsed;
  function startTimer() {
    if (state.startedAt || state.finished) return;
    state.startedAt = performance.now();
    state.timerId = setInterval(() => { el.hudTime.textContent = fmtTime(currentElapsed()); }, 250);
  }
  function stopTimer() {
    if (state.startedAt) { state.elapsed += performance.now() - state.startedAt; state.startedAt = 0; }
    clearInterval(state.timerId); state.timerId = 0;
  }

  // ── Dragging ──
  const boardScale = () => { const m = el.board.getScreenCTM(); return m ? m.a : 1; };

  function beginDrag(e, piece, btn) {
    if (state.finished || (e.button != null && e.button > 0) || state.drag) return;
    e.preventDefault();
    startTimer();
    const g = svgEl('g', { class: 'ptw-ghost-piece' });
    g.appendChild(svgEl('path', { d: piece.d, fill: state.color.get(piece.id) }));
    el.ghost.innerHTML = ''; el.ghost.appendChild(g); el.ghost.hidden = false;
    state.drag = { piece, btn, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false, g };
    btn.classList.add('is-dragging');
    try { btn.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
    moveGhost(e.clientX, e.clientY);
  }
  function moveGhost(x, y) {
    const d = state.drag; if (!d) return;
    const s = boardScale();
    d.g.setAttribute('transform', `translate(${x - d.piece.cx * s} ${y - d.piece.cy * s}) scale(${s})`);
  }
  function onPointerMove(e) {
    const d = state.drag; if (!d || e.pointerId !== d.pointerId) return;
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 6) { d.moved = true; el.boardWrap.classList.add('is-target'); }
    if (d.moved) moveGhost(e.clientX, e.clientY);
  }
  function onPointerUp(e) {
    const d = state.drag; if (!d || e.pointerId !== d.pointerId) return;
    const { piece, btn, moved } = d;
    cancelDrag();
    if (!moved) return; // plain tap → the click handler selects the piece
    btn.dataset.suppressClick = '1';
    tryDrop(piece, e.clientX, e.clientY, btn);
  }
  function cancelDrag() {
    const d = state.drag; if (!d) return;
    d.btn.classList.remove('is-dragging');
    try { d.btn.releasePointerCapture(d.pointerId); } catch { /* ignore */ }
    el.ghost.hidden = true; el.ghost.innerHTML = '';
    el.boardWrap.classList.remove('is-target');
    state.drag = null;
  }

  function clientToBoard(x, y) {
    const m = el.board.getScreenCTM(); if (!m) return null;
    const pt = new DOMPoint(x, y).matrixTransform(m.inverse());
    return { x: pt.x, y: pt.y };
  }
  function tolerance(piece) {
    const s = boardScale();
    const maxDim = Math.max(...pieceDims(piece));
    return Math.min(Math.max(24 / s, 0.25 * maxDim), Math.max(0.4 * maxDim, 30 / s));
  }
  function tryDrop(piece, clientX, clientY, btn) {
    const r = el.board.getBoundingClientRect();
    const inside = clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
    if (!inside) { toast('Drop it on the board.'); return; }
    const pt = clientToBoard(clientX, clientY); if (!pt) return;
    const dist = Math.hypot(pt.x - piece.cx, pt.y - piece.cy);
    const tol = tolerance(piece);
    if (dist <= tol) placePiece(piece, btn);
    else missPiece(piece, pt, btn, dist <= tol * 2.2);
  }

  function placePiece(piece, btn) {
    state.remaining.delete(piece.id);
    state.placedCount++;
    if (state.selected === piece.id) state.selected = null;
    const layer = $('.ptw-placed-layer', el.board);
    const path = svgEl('path', { d: piece.d, class: 'ptw-placed', fill: state.color.get(piece.id), 'data-id': piece.id });
    path.appendChild(svgEl('title')).textContent = piece.name;
    layer.appendChild(path);
    $(`.ptw-target[data-id="${piece.id}"]`, el.board)?.classList.add('is-done');
    $(`.ptw-label[data-id="${piece.id}"]`, el.board)?.remove();
    btn?.remove();
    SFX.place();
    toast(factFor(piece), 'ok');
    renderHud();
    if (state.remaining.size === 0) finishLevel();
  }
  function factFor(p) {
    const parts = [p.name];
    const rank = state.rank.get(p.id);
    if (state.level === 'world') { if (p.sub) parts.push(p.sub); }
    else {
      if (rank) parts.push(`${ordinalRank(rank)} in ${levelMeta(state.level).name}`);
      if (p.pop) parts.push(`${fmtPop(p.pop)} people`);
    }
    return '✓ ' + parts.join(' · ');
  }
  function missPiece(piece, pt, btn, close) {
    state.misses++;
    SFX.miss();
    const fx = $('.ptw-fx', el.board);
    const flash = svgEl('path', { d: piece.d, class: 'ptw-miss', transform: `translate(${pt.x - piece.cx} ${pt.y - piece.cy})` });
    fx.appendChild(flash);
    setTimeout(() => flash.remove(), 520);
    btn?.classList.remove('ptw-shake'); void btn?.offsetWidth; btn?.classList.add('ptw-shake');
    const who = state.mode === 'hard' ? 'That piece' : piece.name;
    toast(close ? `So close! ${who} is just next to that.` : `Not there. ${who} goes somewhere else.`, 'bad');
    renderHud();
  }

  // Tap-to-place: select a piece, then tap the board.
  el.board.addEventListener('click', e => {
    if (!state.selected || state.finished) return;
    const piece = pieceById(state.selected); if (!piece) return;
    startTimer();
    const btn = $(`.ptw-piece[data-id="${piece.id}"]`, el.tray);
    tryDrop(piece, e.clientX, e.clientY, btn);
  });

  // ── Hint ──
  function hint() {
    if (state.finished || !state.remaining.size) return;
    const id = state.selected && state.remaining.has(state.selected) ? state.selected : $('.ptw-piece', el.tray)?.dataset.id;
    const piece = pieceById(id); if (!piece) return;
    startTimer();
    state.hints++;
    selectPiece(id);
    const target = $(`.ptw-target[data-id="${id}"]`, el.board);
    $$('.ptw-target.is-hint', el.board).forEach(t => t.classList.remove('is-hint'));
    target?.classList.add('is-hint');
    clearTimeout(state.hintTimer);
    state.hintTimer = setTimeout(() => target?.classList.remove('is-hint'), 2600);
    toast(`Hint: ${state.mode === 'hard' ? 'the piece' : piece.name} belongs in the glowing spot. Hints cost accuracy.`, 'hint');
    renderHud();
  }

  // ── Finish ──
  function stars(acc) { return acc >= 90 ? 3 : acc >= 70 ? 2 : 1; }
  function finishLevel() {
    stopTimer();
    state.finished = true;
    const n = state.data.pieces.length;
    const acc = Math.round((n / (n + state.misses + state.hints * 2)) * 100);
    const t = Math.round(state.elapsed);
    const s = stars(acc);
    const key = bestKey(state.level, state.mode);
    const prev = store.get(key);
    const isBest = !prev || t < prev.t;
    if (isBest) store.set(key, { t, acc, stars: s, misses: state.misses, hints: state.hints, at: Date.now() });
    const L = levelMeta(state.level);
    el.doneTitle.textContent = `${L.name} complete!`;
    el.doneStars.textContent = '★'.repeat(s) + '☆'.repeat(3 - s);
    el.doneStars.setAttribute('aria-label', `${s} of 3 stars`);
    el.doneStats.innerHTML = `<span><b>${fmtTime(t, true)}</b>time</span><span><b>${acc}%</b>accuracy</span><span><b>${state.misses}</b>misses</span><span><b>${state.hints}</b>hints</span>`;
    el.doneBest.textContent = isBest ? (prev ? `New personal best on ${modeMeta(state.mode).label}! Previous ${fmtTime(prev.t, true)}.` : `First clear on ${modeMeta(state.mode).label}. That is your time to beat.`) : `Your best on ${modeMeta(state.mode).label}: ${fmtTime(prev.t, true)}.`;
    const next = LEVELS[(LEVELS.findIndex(l => l.id === state.level) + 1) % LEVELS.length];
    el.btnNext.textContent = `Next: ${next.name}`;
    el.btnNext.dataset.level = next.id;
    const mi = MODES.findIndex(m => m.id === state.mode);
    el.btnHarder.hidden = mi >= MODES.length - 1;
    if (!el.btnHarder.hidden) { el.btnHarder.textContent = `Try ${MODES[mi + 1].label}`; el.btnHarder.dataset.mode = MODES[mi + 1].id; }
    el.doneFlash.hidden = true;
    el.done.hidden = false;
    el.btnAgain.focus({ preventScroll: true });
    SFX.win();
    confetti();
    renderHud();
    if (typeof gtag === 'function') gtag('event', 'level_complete', { level: state.level, mode: state.mode, time_ms: t, accuracy: acc, stars: s });
  }

  function shareText() {
    const L = levelMeta(state.level), n = state.data.pieces.length;
    const best = store.get(bestKey(state.level, state.mode)) || {};
    const url = `https://ariyankhan.com/piece-the-world.html#${state.level}${state.mode !== 'normal' ? '-' + state.mode : ''}`;
    return `I pieced together ${L.name} (${n} pieces, ${modeMeta(state.mode).label}) in ${fmtTime(best.t ?? state.elapsed, true)} with ${best.acc ?? '?'}% accuracy ${'★'.repeat(best.stars || 1)}\nCan you beat it? ${url}`;
  }
  async function share() {
    const text = shareText();
    try {
      if (navigator.share) { await navigator.share({ text }); return; }
      await navigator.clipboard.writeText(text);
      el.doneFlash.textContent = 'Result copied. Paste it anywhere.'; el.doneFlash.hidden = false;
    } catch {
      el.doneFlash.textContent = text; el.doneFlash.hidden = false;
    }
  }

  // ── Confetti (canvas, ~1.8s) ──
  function confetti() {
    const c = el.confetti; if (!c || !c.getContext) return;
    const r = el.boardWrap.getBoundingClientRect();
    c.width = Math.round(r.width); c.height = Math.round(r.height); c.hidden = false;
    const ctx = c.getContext('2d');
    const parts = Array.from({ length: 140 }, () => ({
      x: c.width / 2 + (Math.random() - 0.5) * c.width * 0.4, y: c.height * 0.45,
      vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 12 - 4, g: 0.35 + Math.random() * 0.2,
      w: 6 + Math.random() * 6, h: 3 + Math.random() * 4, rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
      color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
    }));
    const t0 = performance.now();
    (function frame(now) {
      const k = (now - t0) / 1800;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.globalAlpha = Math.max(0, 1 - k * k);
      for (const p of parts) {
        p.vy += p.g; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.vx *= 0.99;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.color; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
      }
      if (k < 1) requestAnimationFrame(frame); else { ctx.clearRect(0, 0, c.width, c.height); c.hidden = true; }
    })(t0);
  }

  // ── Wiring ──
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', () => cancelDrag());
  window.addEventListener('blur', () => cancelDrag());
  el.btnHint.addEventListener('click', hint);
  el.btnRestart.addEventListener('click', () => startLevel(state.level, state.mode));
  el.btnLevels.addEventListener('click', () => {
    if (state.placedCount && !state.finished && !confirm('Leave this level? Your progress on it will be lost.')) return;
    stopTimer(); cancelDrag(); el.game.hidden = true; el.done.hidden = true; el.select.hidden = false; setHash(null); renderSelect();
  });
  el.btnSound.addEventListener('click', () => { state.muted = !state.muted; store.set('muted', state.muted); renderSound(); if (!state.muted) SFX.place(); });
  el.btnAgain.addEventListener('click', () => startLevel(state.level, state.mode));
  el.btnNext.addEventListener('click', () => startLevel(el.btnNext.dataset.level, state.mode));
  el.btnHarder.addEventListener('click', () => startLevel(state.level, el.btnHarder.dataset.mode));
  el.btnShare.addEventListener('click', share);
  document.addEventListener('keydown', e => {
    if (el.game.hidden || state.finished) return;
    if (e.key === 'h' || e.key === 'H') { if (!/input|textarea/i.test(document.activeElement?.tagName || '')) hint(); }
    if (e.key === 'Escape') { cancelDrag(); selectPiece(null); }
  });
  // Keep the ghost aligned if the layout shifts mid-drag (orientation change, tray scroll…)
  window.addEventListener('resize', () => { if (state.drag) cancelDrag(); });

  renderSound();
  renderSelect();

  // Deep link: #africa, #africa-hard, #world-easy
  const m = /^#([a-z-]+?)(?:-(easy|normal|hard))?$/.exec(location.hash);
  if (m && levelMeta(m[1])) startLevel(m[1], m[2] || state.mode);
  else loadLevel('world').catch(() => {});

  // PWA: offline play after the first visit. The worker only touches this game's own files.
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('/piece-the-world-sw.js').catch(() => {}); });
  }

  // FAQ accordion (same markup as the other tool pages)
  $$('.faq-item').forEach(item => {
    const q = item.querySelector('.faq-q'), a = item.querySelector('.faq-a');
    q?.addEventListener('click', () => {
      const open = !item.classList.contains('open');
      item.classList.toggle('open', open);
      q.setAttribute('aria-expanded', String(open));
      a?.setAttribute('aria-hidden', String(!open));
    });
  });

  // Stars background (same as the other tool pages)
  const root = document.getElementById('stars');
  if (root && !root.childElementCount) {
    for (let i = 0; i < 90; i++) {
      const s = document.createElement('div');
      const size = Math.random() < 0.25 ? 2.5 : 1.5;
      s.className = 'star';
      s.style.cssText = `left:${Math.random() * 100}%;top:${Math.random() * 100}%;width:${size}px;height:${size}px;animation-duration:${2 + Math.random() * 5}s;animation-delay:${Math.random() * 5}s;background:${Math.random() < 0.1 ? '#F5C518' : '#fff'}`;
      root.appendChild(s);
    }
  }
})();
