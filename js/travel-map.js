/* Travel Map — mark the US states, European countries or world countries you have visited (and the ones
   you want to see), then download the map as an image to share. Everything runs in the browser: the
   selection lives in this tab, in a share link and in localStorage, and is never sent anywhere. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const SVG_NS = 'http://www.w3.org/2000/svg';
  if (!$('#tvmMap') || typeof d3 === 'undefined' || typeof topojson === 'undefined') return;

  /* ══════════════════════════════════════════════
     The three maps
     ══════════════════════════════════════════════ */
  const NAME_FIX = {
    'Bosnia and Herz.': 'Bosnia and Herzegovina', 'Macedonia': 'North Macedonia', 'United States of America': 'United States',
    'Czechia': 'Czech Republic', 'W. Sahara': 'Western Sahara', 'Dem. Rep. Congo': 'DR Congo', 'Dominican Rep.': 'Dominican Republic',
    'Central African Rep.': 'Central African Republic', 'Eq. Guinea': 'Equatorial Guinea', 'S. Sudan': 'South Sudan',
    'Solomon Is.': 'Solomon Islands', 'Falkland Is.': 'Falkland Islands', 'Fr. S. Antarctic Lands': 'French Southern Lands',
    'eSwatini': 'Eswatini', 'Antigua and Barb.': 'Antigua and Barbuda', 'St. Vin. and Gren.': 'St. Vincent and the Grenadines',
    'Br. Indian Ocean Ter.': 'British Indian Ocean Territory', 'N. Cyprus': 'Northern Cyprus', 'Faeroe Is.': 'Faroe Islands',
    'Marshall Is.': 'Marshall Islands', 'Cook Is.': 'Cook Islands', 'Cayman Is.': 'Cayman Islands', 'N. Mariana Is.': 'Northern Mariana Islands',
    'Turks and Caicos Is.': 'Turks and Caicos Islands', 'U.S. Virgin Is.': 'U.S. Virgin Islands', 'British Virgin Is.': 'British Virgin Islands',
    'Wallis and Futuna Is.': 'Wallis and Futuna', 'Pitcairn Is.': 'Pitcairn Islands', 'Fr. Polynesia': 'French Polynesia',
    'St-Barthélemy': 'Saint Barthélemy', 'St-Martin': 'Saint Martin', 'S. Geo. and the Is.': 'South Georgia and the South Sandwich Islands',
    'Heard I. and McDonald Is.': 'Heard and McDonald Islands', 'Indian Ocean Ter.': 'Indian Ocean Territories',
    'Ashmore and Cartier Is.': 'Ashmore and Cartier Islands', 'St. Pierre and Miquelon': 'Saint Pierre and Miquelon',
    'São Tomé and Principe': 'São Tomé and Príncipe', 'St. Kitts and Nevis': 'Saint Kitts and Nevis', 'Saint Lucia': 'Saint Lucia',
    'Côte d\'Ivoire': 'Côte d’Ivoire',
  };
  // The 44 countries the UN counts as Europe, plus Cyprus and Turkey, which most travel lists include.
  const EUROPE = new Set('008 020 040 112 056 070 100 191 196 203 208 233 246 250 276 300 348 352 372 380 428 438 440 442 470 498 492 499 528 807 578 616 620 642 643 674 688 703 705 724 752 756 804 826 336 792'.split(' '));
  // Places on the world map that are not among the 195 countries counted (193 UN members, the Vatican and
  // Palestine): dependent territories and places whose status is disputed. They can still be marked, and
  // are counted on their own line.
  const NOT_COUNTED = new Set('016 660 533 060 086 092 136 184 531 234 238 258 260 304 316 831 334 344 833 832 446 500 580 540 570 574 612 630 239 654 534 652 663 666 158 796 850 732 876 248'.split(' '));
  const US_SKIP = new Set(['11', '60', '66', '69', '72', '78']);   // DC and the territories: the count is the 50 states
  const REGIONS = {
    us: { label: 'USA', unit: 'states', one: 'state', total: 50, file: '/js/vendor/us-states-10m.json', object: 'states', size: [975, 610] },
    europe: { label: 'Europe', unit: 'countries', one: 'country', total: 46, file: '/js/vendor/countries-50m.json', object: 'countries', size: [900, 760] },
    world: { label: 'World', unit: 'countries', one: 'country', total: 195, file: '/js/vendor/countries-50m.json', object: 'countries', size: [1000, 520] },
  };
  const THEMES = {
    atlas:  { name: 'Atlas',  bg: '#F7F3EA', land: '#E2DACB', visited: '#1E7A72', want: '#E9A23B', line: '#FFFFFF', ink: '#1D2B2A', muted: '#6B746F' },
    sunset: { name: 'Sunset', bg: '#FFF4EC', land: '#F0DCCD', visited: '#D9483B', want: '#F2B13C', line: '#FFFFFF', ink: '#3B1F1A', muted: '#8A6A60' },
    night:  { name: 'Night',  bg: '#0F1A2B', land: '#26354F', visited: '#F5C518', want: '#4FA3E0', line: '#0F1A2B', ink: '#F3F5F8', muted: '#A5B0C2' },
    forest: { name: 'Forest', bg: '#EEF3EA', land: '#D3DDCC', visited: '#2F6B3A', want: '#C79A2E', line: '#FFFFFF', ink: '#1E2B1F', muted: '#66705F' },
    ocean:  { name: 'Ocean',  bg: '#EAF3FA', land: '#D0DFEC', visited: '#1F5F8B', want: '#E07A5F', line: '#FFFFFF', ink: '#13263A', muted: '#5E7184' },
  };
  const FORMATS = { story: [1080, 1920], post: [1080, 1350], square: [1080, 1080], wide: [1920, 1080] };

  /* ══════════════════════════════════════════════
     State
     ══════════════════════════════════════════════ */
  const blank = () => ({ us: { v: [], w: [] }, europe: { v: [], w: [] }, world: { v: [], w: [] } });
  const state = { region: 'us', mode: 'v', theme: 'atlas', format: 'post', title: '', marks: blank() };
  const cache = {};
  let data = null;         // { features (drawn), list (in the checklist), byId }
  let hoverId = null;

  const store = {
    load() { try { return JSON.parse(localStorage.getItem('travel-map:v1') || 'null'); } catch (_) { return null; } },
    save() { try { localStorage.setItem('travel-map:v1', JSON.stringify({ marks: state.marks, theme: state.theme, format: state.format, title: state.title })); } catch (_) { /* private mode */ } },
  };

  async function loadTopo(file) {
    if (!cache[file]) cache[file] = fetch(file).then(r => { if (!r.ok) throw new Error('map data'); return r.json(); });
    return cache[file];
  }
  async function loadRegion(key) {
    const R = REGIONS[key];
    const topo = await loadTopo(R.file);
    const fc = topojson.feature(topo, topo.objects[R.object]);
    const named = fc.features.map(f => {
      const raw = f.properties?.name || '';
      const id = f.id != null ? String(f.id) : 'x-' + raw.toLowerCase().replace(/[^a-z]+/g, '-');
      return { ...f, id, properties: { name: NAME_FIX[raw] || raw } };
    });
    let features, list, counted;
    if (key === 'us') {
      features = named.filter(f => !US_SKIP.has(f.id));
      list = features;
      counted = new Set(list.map(f => f.id));
    } else if (key === 'europe') {
      features = named.filter(f => f.id !== '010');
      list = features.filter(f => EUROPE.has(f.id) || f.id === 'x-kosovo');
      counted = EUROPE;
    } else {
      features = named.filter(f => f.id !== '010' && f.id !== 'x-siachen-glacier');
      // One entry per id (Ashmore and Cartier Islands share Australia's), and Tuvalu, which the map data
      // is too coarse to draw, as a list-only entry so the count can reach 195.
      const seen = new Set(); list = [];
      for (const f of features) if (!seen.has(f.id) && f.id !== 'x-indian-ocean-ter-') { seen.add(f.id); if (f.properties.name !== 'Ashmore and Cartier Islands') list.push(f); }
      list.push({ id: '798', properties: { name: 'Tuvalu' }, geometry: null, listOnly: true });
      counted = new Set(list.filter(f => !NOT_COUNTED.has(f.id) && !f.id.startsWith('x-')).map(f => f.id));
    }
    list = [...list].sort((a, b) => a.properties.name.localeCompare(b.properties.name));
    const byId = new Map(list.map(f => [f.id, f]));
    return { key, features, list, byId, counted, interactive: new Set(list.map(f => f.id)) };
  }

  /* ══════════════════════════════════════════════
     Marks
     ══════════════════════════════════════════════ */
  const marks = () => state.marks[state.region];
  const statusOf = id => (marks().v.includes(id) ? 'v' : marks().w.includes(id) ? 'w' : null);
  function setStatus(id, s) {
    const m = marks();
    m.v = m.v.filter(x => x !== id); m.w = m.w.filter(x => x !== id);
    if (s) m[s].push(id);
  }
  // A click marks the place with the current mode, or unmarks it if it already has that mark.
  function toggle(id) {
    if (!data.interactive.has(id)) return;
    setStatus(id, statusOf(id) === state.mode ? null : state.mode);
    changed();
  }

  /* ══════════════════════════════════════════════
     Drawing
     ══════════════════════════════════════════════ */
  function el(name, attrs = {}, parent) {
    const n = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  }
  function projectionFor(key, W, H) {
    const pad = 12;
    if (key === 'us') return d3.geoAlbersUsa().fitExtent([[pad, pad], [W - pad, H - pad]], { type: 'FeatureCollection', features: data.features });
    if (key === 'europe') {
      const pts = []; for (let x = -24; x <= 44; x += 4) for (let y = 35; y <= 71; y += 4) pts.push([x, y]);
      return d3.geoConicConformal().rotate([-12, 0]).parallels([40, 64]).fitExtent([[pad, pad], [W - pad, H - pad]], { type: 'MultiPoint', coordinates: pts });
    }
    return d3.geoNaturalEarth1().fitExtent([[pad, pad], [W - pad, H - pad]], { type: 'FeatureCollection', features: data.features });
  }
  // One function draws the live map and the exported one, so the download always matches the screen.
  function drawMap(target, theme, { interactive }) {
    const [W, H] = REGIONS[state.region].size;
    const proj = projectionFor(state.region, W, H);
    const path = d3.geoPath(proj);
    const T = THEMES[theme];
    const g = el('g', { 'stroke-linejoin': 'round' }, target);
    for (const f of data.features) {
      const d = path(f); if (!d) continue;
      const s = data.interactive.has(f.id) ? statusOf(f.id) : null;
      const outside = !data.interactive.has(f.id);
      const p = el('path', {
        d, fill: s === 'v' ? T.visited : s === 'w' ? T.want : T.land, 'data-id': interactive && !outside ? f.id : null,
        stroke: T.line, 'stroke-width': state.region === 'us' ? 0.9 : 0.5, 'fill-opacity': outside ? 0.45 : null,
      }, g);
      if (interactive && !outside) { p.classList.add('tvm-shape'); if (f.id === hoverId) p.classList.add('is-hover'); }
    }
    return [W, H];
  }
  const svg = $('#tvmMap');
  function render() {
    if (!data) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const [W, H] = drawMap(svg, state.theme, { interactive: true });
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    $('#tvmStage').dataset.theme = state.theme;
    // The list's dots, the mode buttons and the meter take the theme's two colours, so they match the map.
    const T = THEMES[state.theme], tool = $('#tvmTool');
    tool.style.setProperty('--c-v', T.visited); tool.style.setProperty('--c-w', T.want);
  }

  /* ══════════════════════════════════════════════
     Counter and checklist
     ══════════════════════════════════════════════ */
  function counts() {
    const m = marks(), R = REGIONS[state.region];
    const v = m.v.filter(id => data.counted.has(id)).length;
    const extra = m.v.filter(id => !data.counted.has(id)).length;
    return { v, w: m.w.length, extra, total: R.total, pct: Math.round(v / R.total * 100) };
  }
  function renderCounter() {
    const c = counts(), R = REGIONS[state.region];
    $('#tvmCount').textContent = c.v;
    $('#tvmTotal').textContent = `/ ${R.total} ${R.unit}`;
    $('#tvmPct').textContent = `${c.pct}%`;
    $('#tvmBar').style.width = `${Math.min(100, c.pct)}%`;
    const bits = [];
    if (c.w) bits.push(`${c.w} on your wish list`);
    if (c.extra) bits.push(state.region === 'europe' ? `+ Kosovo` : `+ ${c.extra} ${c.extra === 1 ? 'territory' : 'territories'}`);
    $('#tvmSub').textContent = bits.join(' · ');
  }
  const listEl = $('#tvmList');
  function renderList() {
    const q = $('#tvmSearch').value.trim().toLowerCase();
    const items = data.list.filter(f => !q || f.properties.name.toLowerCase().includes(q));
    listEl.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const f of items) {
      const s = statusOf(f.id);
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'tvm-item' + (s ? ` is-${s}` : ''); b.dataset.id = f.id;
      b.setAttribute('aria-pressed', s ? 'true' : 'false');
      b.innerHTML = `<span class="tvm-dot" aria-hidden="true"></span><span class="tvm-name"></span>${s ? `<span class="tvm-tag">${s === 'v' ? 'Visited' : 'Want to go'}</span>` : ''}`;
      b.querySelector('.tvm-name').textContent = f.properties.name + (data.counted.has(f.id) ? '' : ' *');
      frag.appendChild(b);
    }
    listEl.appendChild(frag);
    $('#tvmListEmpty').hidden = items.length > 0;
    $('#tvmListNote').hidden = state.region === 'us';
    $('#tvmListNote').textContent = state.region === 'europe'
      ? '* Kosovo can be marked, but the count follows the 46 countries most travel lists use.'
      : '* Territories and places with disputed status can be marked, and are counted on their own line.';
  }
  listEl.addEventListener('click', e => { const b = e.target.closest('.tvm-item'); if (b) toggle(b.dataset.id); });
  $('#tvmSearch').addEventListener('input', renderList);

  /* ══════════════════════════════════════════════
     Map interaction
     ══════════════════════════════════════════════ */
  const tip = $('#tvmTip');
  svg.addEventListener('click', e => { const p = e.target.closest('path[data-id]'); if (p) toggle(p.dataset.id); });
  svg.addEventListener('mousemove', e => {
    const p = e.target.closest('path[data-id]');
    const id = p ? p.dataset.id : null;
    if (id !== hoverId) { $$('.tvm-shape.is-hover', svg).forEach(x => x.classList.remove('is-hover')); hoverId = id; if (p) p.classList.add('is-hover'); }
    if (p) {
      const s = statusOf(id);
      tip.textContent = data.byId.get(id).properties.name + (s ? (s === 'v' ? ' · visited' : ' · want to go') : '');
      tip.hidden = false;
      const r = $('#tvmStage').getBoundingClientRect();
      tip.style.left = `${e.clientX - r.left + 14}px`; tip.style.top = `${e.clientY - r.top + 14}px`;
    } else tip.hidden = true;
  });
  svg.addEventListener('mouseleave', () => { tip.hidden = true; hoverId = null; $$('.tvm-shape.is-hover', svg).forEach(x => x.classList.remove('is-hover')); });

  /* ══════════════════════════════════════════════
     Controls
     ══════════════════════════════════════════════ */
  // The tabs are links to each region's own page; the marks travel with them in localStorage.
  $$('.tvm-mode').forEach(b => b.addEventListener('click', () => { state.mode = b.dataset.mode; syncControls(); }));
  $$('.tvm-theme').forEach(b => { b.style.setProperty('--sw-a', THEMES[b.dataset.theme].visited); b.style.setProperty('--sw-b', THEMES[b.dataset.theme].bg); b.addEventListener('click', () => { state.theme = b.dataset.theme; changed(); }); });
  $('#tvmFormat').addEventListener('change', e => { state.format = e.target.value; store.save(); });
  $('#tvmTitle').addEventListener('input', e => { state.title = e.target.value.slice(0, 60); store.save(); saveHash(); });
  $('#tvmClear').addEventListener('click', () => {
    if (!marks().v.length && !marks().w.length) return;
    if (!confirm(`Clear every ${REGIONS[state.region].one} you have marked on the ${REGIONS[state.region].label} map?`)) return;
    state.marks[state.region] = { v: [], w: [] }; changed();
  });
  $('#tvmShare').addEventListener('click', async () => {
    saveHash();
    try { await navigator.clipboard.writeText(location.href); flash('Link copied: anyone who opens it sees your map'); }
    catch (_) { flash('Copy the address bar to share your map'); }
  });

  function syncControls() {
    $$('.tvm-tab').forEach(b => { const on = b.dataset.region === state.region; b.classList.toggle('is-on', on); if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    $$('.tvm-mode').forEach(b => { const on = b.dataset.mode === state.mode; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    $$('.tvm-theme').forEach(b => b.setAttribute('aria-pressed', b.dataset.theme === state.theme ? 'true' : 'false'));
    $('#tvmFormat').value = state.format;
    $('#tvmTitle').value = state.title;
    $('#tvmTitle').placeholder = defaultTitle();
    const R = REGIONS[state.region];
    $('#tvmSearch').placeholder = `Search ${R.unit}…`;
    $('#tvmListHead').textContent = state.region === 'us' ? 'All 50 states' : state.region === 'europe' ? 'Countries of Europe' : 'Countries and territories';
  }
  function changed() { render(); renderCounter(); renderList(); store.save(); saveHash(); syncControls(); }

  async function switchRegion(key) {
    if (!REGIONS[key]) return;
    state.region = key; syncControls(); busy(true);
    try { data = await loadRegion(key); } catch (_) { busy(false); return showError('The map could not be loaded. Please reload the page.'); }
    busy(false); hoverId = null; $('#tvmSearch').value = '';
    changed();
  }

  /* ══════════════════════════════════════════════
     Share link: #r=us&v=06.32&w=15&t=Title&th=night
     ══════════════════════════════════════════════ */
  function saveHash() {
    const m = marks(), q = [`r=${state.region}`];
    if (m.v.length) q.push('v=' + m.v.map(encodeURIComponent).join('.'));
    if (m.w.length) q.push('w=' + m.w.map(encodeURIComponent).join('.'));
    if (state.title) q.push('t=' + encodeURIComponent(state.title).replace(/%20/g, '+'));
    if (state.theme !== 'atlas') q.push('th=' + state.theme);
    history.replaceState(null, '', '#' + q.join('&'));
  }
  function loadHash() {
    const h = location.hash.slice(1); if (!h) return false;
    const q = new URLSearchParams(h);
    const r = q.get('r'); if (!REGIONS[r]) return false;
    const ids = k => (q.get(k) || '').split('.').filter(x => /^[0-9a-z-]{1,40}$/.test(x)).slice(0, 300);
    state.region = r; state.marks[r] = { v: ids('v'), w: ids('w').filter(x => !ids('v').includes(x)) };
    if (q.has('t')) state.title = q.get('t').slice(0, 60);
    if (THEMES[q.get('th')]) state.theme = q.get('th');
    return true;
  }

  /* ══════════════════════════════════════════════
     Export: the map on a card with a title, the count, a legend and the site's address
     ══════════════════════════════════════════════ */
  const defaultTitle = () => state.region === 'us' ? 'States I’ve visited' : state.region === 'europe' ? 'My Europe travel map' : 'Countries I’ve visited';
  function exportSvg() {
    const [EW, EH] = FORMATS[state.format];
    const T = THEMES[state.theme], R = REGIONS[state.region], c = counts();
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('xmlns', SVG_NS); s.setAttribute('width', EW); s.setAttribute('height', EH); s.setAttribute('viewBox', `0 0 ${EW} ${EH}`);
    el('rect', { width: EW, height: EH, fill: T.bg }, s);
    const u = Math.min(EW, EH) / 1080, pad = 64 * u;
    const serif = "Georgia, 'Times New Roman', serif", sans = "'Helvetica Neue', Arial, sans-serif";
    const title = el('text', { x: pad, y: pad + 64 * u, fill: T.ink, 'font-family': serif, 'font-size': 66 * u, 'font-weight': 700 }, s);
    title.textContent = state.title || defaultTitle();
    const line = el('text', { x: pad, y: pad + 128 * u, fill: T.visited, 'font-family': sans, 'font-size': 38 * u, 'font-weight': 700 }, s);
    line.textContent = `${c.v} of ${R.total} ${R.unit} · ${c.pct}%`;
    // map box
    const top = pad + 170 * u, bottom = EH - pad - 120 * u;
    const [MW, MH] = R.size, boxW = EW - 2 * pad, boxH = bottom - top;
    const k = Math.min(boxW / MW, boxH / MH), w = MW * k, h = MH * k;
    const inner = el('svg', { x: pad + (boxW - w) / 2, y: top + (boxH - h) / 2, width: w, height: h, viewBox: `0 0 ${MW} ${MH}` }, s);
    drawMap(inner, state.theme, { interactive: false });
    // legend
    const ly = EH - pad - 52 * u;
    let lx = pad;
    for (const [color, label] of [[T.visited, `Visited (${c.v + c.extra})`], ...(c.w ? [[T.want, `Want to go (${c.w})`]] : [])]) {
      el('rect', { x: lx, y: ly - 26 * u, width: 30 * u, height: 30 * u, rx: 8 * u, fill: color }, s);
      const t = el('text', { x: lx + 44 * u, y: ly - 2 * u, fill: T.ink, 'font-family': sans, 'font-size': 28 * u, 'font-weight': 600 }, s);
      t.textContent = label; lx += (label.length * 15 + 110) * u;
    }
    const foot = el('text', { x: EW - pad, y: EH - pad + 4 * u, 'text-anchor': 'end', fill: T.muted, 'font-family': sans, 'font-size': 24 * u }, s);
    foot.textContent = 'ariyankhan.com/travel-map';
    return s;
  }
  async function exportPng() {
    const s = exportSvg(); const [EW, EH] = FORMATS[state.format];
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(s)], { type: 'image/svg+xml;charset=utf-8' }));
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('render')); i.src = url; });
      const cv = document.createElement('canvas'); cv.width = EW; cv.height = EH;
      cv.getContext('2d').drawImage(img, 0, 0, EW, EH);
      return await new Promise((res, rej) => cv.toBlob(b => (b ? res(b) : rej(new Error('png'))), 'image/png'));
    } finally { URL.revokeObjectURL(url); }
  }
  $('#tvmDownload').addEventListener('click', async () => {
    busy(true, 'Making your image…');
    try {
      const b = await exportPng();
      const a = document.createElement('a'); a.href = URL.createObjectURL(b);
      a.download = `travel-map-${state.region}-${counts().v}-${REGIONS[state.region].unit}.png`;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    } catch (_) { showError('The image could not be made in this browser.'); }
    busy(false);
  });

  /* ══════════════════════════════════════════════
     Status helpers and boot
     ══════════════════════════════════════════════ */
  function busy(on, msg = 'Loading map…') { const e = $('#tvmStatus'); e.textContent = msg; e.hidden = !on; }
  function showError(msg) { const e = $('#tvmError'); e.textContent = msg; e.hidden = false; setTimeout(() => (e.hidden = true), 6000); }
  function flash(msg) { const e = $('#tvmFlash'); e.textContent = msg; e.hidden = false; clearTimeout(flash.t); flash.t = setTimeout(() => (e.hidden = true), 2600); }

  const saved = store.load();
  if (saved && saved.marks) {
    for (const k of Object.keys(REGIONS)) if (saved.marks[k]) state.marks[k] = { v: [...(saved.marks[k].v || [])], w: [...(saved.marks[k].w || [])] };
    if (THEMES[saved.theme]) state.theme = saved.theme;
    if (FORMATS[saved.format]) state.format = saved.format;
    if (typeof saved.title === 'string') state.title = saved.title.slice(0, 60);
  }
  const startRegion = $('#tvmMap').dataset.region;
  if (!loadHash() && REGIONS[startRegion]) state.region = startRegion;
  switchRegion(state.region).then(() => $('#tvmTool').classList.add('is-ready'));
})();
