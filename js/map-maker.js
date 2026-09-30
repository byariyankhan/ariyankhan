/* ══════════════════════════════════════════════════
   MAP MAKER — highlight countries on a world map,
   export PNG / SVG. 100% in-browser.
   Deps (loaded before this file, all local):
     js/vendor/d3-array.min.js, d3-geo.min.js,
     d3-geo-projection.min.js  -> window.d3
     js/vendor/topojson-client.min.js -> window.topojson
   Data: js/vendor/countries-110m.json (default),
         js/vendor/countries-50m.json (high detail)
   Source: Natural Earth via world-atlas (public domain).
   ══════════════════════════════════════════════════ */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /* ── Stars + FAQ (same as the other tool page) ── */
  (function stars() {
    const root = document.getElementById('stars');
    if (!root) return;
    for (let i = 0; i < 90; i++) {
      const s = document.createElement('div');
      const size = Math.random() < 0.25 ? 2.5 : 1.5;
      s.className = 'star';
      s.style.cssText = `left:${Math.random() * 100}%;top:${Math.random() * 100}%;width:${size}px;height:${size}px;animation-duration:${2 + Math.random() * 5}s;animation-delay:${Math.random() * 5}s;background:${Math.random() < 0.1 ? '#F5C518' : '#fff'}`;
      root.appendChild(s);
    }
  })();
  (function faq() {
    const items = $$('.faq-item');
    const set = (item, open) => {
      item.classList.toggle('open', open);
      item.querySelector('.faq-q')?.setAttribute('aria-expanded', String(open));
      item.querySelector('.faq-a')?.setAttribute('aria-hidden', String(!open));
    };
    items.forEach(item => item.querySelector('.faq-q')?.addEventListener('click', () => {
      const was = item.classList.contains('open');
      items.forEach(i => set(i, false));
      if (!was) set(item, true);
    }));
  })();

  if (!$('#mmMap') || typeof d3 === 'undefined' || typeof topojson === 'undefined') return;

  /* ══════════════════════════════════════════════
     Names: world-atlas abbreviates; expand + add aliases for search.
     ══════════════════════════════════════════════ */
  const NAME_FIX = {
    'W. Sahara': 'Western Sahara', 'Dem. Rep. Congo': 'DR Congo', 'Dominican Rep.': 'Dominican Republic',
    'Central African Rep.': 'Central African Republic', 'Eq. Guinea': 'Equatorial Guinea',
    'Bosnia and Herz.': 'Bosnia and Herzegovina', 'S. Sudan': 'South Sudan', 'Solomon Is.': 'Solomon Islands',
    'Falkland Is.': 'Falkland Islands', 'Fr. S. Antarctic Lands': 'French Southern Lands', 'eSwatini': 'Eswatini',
    'Macedonia': 'North Macedonia', 'United States of America': 'United States', 'Antigua and Barb.': 'Antigua and Barbuda',
    'St. Vin. and Gren.': 'St. Vincent and the Grenadines', 'Br. Indian Ocean Ter.': 'British Indian Ocean Territory',
    'N. Cyprus': 'Northern Cyprus', 'Faeroe Is.': 'Faroe Islands', 'Marshall Is.': 'Marshall Islands', 'Cook Is.': 'Cook Islands',
    'Cayman Is.': 'Cayman Islands', 'N. Mariana Is.': 'Northern Mariana Islands', 'Turks and Caicos Is.': 'Turks and Caicos Islands',
    'U.S. Virgin Is.': 'U.S. Virgin Islands', 'British Virgin Is.': 'British Virgin Islands', 'Wallis and Futuna Is.': 'Wallis and Futuna',
    'Pitcairn Is.': 'Pitcairn Islands', 'Fr. Polynesia': 'French Polynesia', 'St-Barthélemy': 'Saint Barthélemy', 'St-Martin': 'Saint Martin',
    'Heard I. and McDonald Is.': 'Heard and McDonald Islands', 'S. Geo. and the Is.': 'South Georgia and the South Sandwich Islands',
    'Ashmore and Cartier Is.': 'Ashmore and Cartier Islands', 'Indian Ocean Ter.': 'Indian Ocean Territories',
    'St. Kitts and Nevis': 'Saint Kitts and Nevis', 'St. Pierre and Miquelon': 'Saint Pierre and Miquelon', 'Saint Helena': 'Saint Helena',
  };
  const ALIASES = {
    'United States': ['USA', 'US', 'America'], 'United Kingdom': ['UK', 'Britain', 'Great Britain', 'England'],
    'United Arab Emirates': ['UAE'], 'Myanmar': ['Burma'], "Côte d'Ivoire": ['Ivory Coast', 'Cote dIvoire'], 'Cabo Verde': ['Cape Verde'],
    'Netherlands': ['Holland'], 'Czechia': ['Czech Republic'], 'Eswatini': ['Swaziland'], 'Turkey': ['Türkiye', 'Turkiye'],
    'DR Congo': ['Democratic Republic of the Congo', 'Congo-Kinshasa', 'DRC', 'Zaire'], 'Congo': ['Republic of the Congo', 'Congo-Brazzaville'],
    'North Macedonia': ['Macedonia'], 'Timor-Leste': ['East Timor'], 'Russia': ['Russian Federation'], 'South Korea': ['Korea'],
    'North Korea': ['DPRK'], 'Iran': ['Persia'], 'Vatican': ['Vatican City', 'Holy See'], 'Taiwan': ['Republic of China'],
    'Bangladesh': ['BD'], 'Palestine': ['Gaza', 'West Bank'], 'Greenland': ['Kalaallit Nunaat'], 'Antarctica': ['South Pole'],
  };

  /* Region presets: [west, south, east, north] in degrees */
  const REGIONS = {
    world: null,
    europe: [-25, 34, 45, 72], asia: [25, -11, 150, 60], africa: [-20, -36, 55, 38],
    'middle-east': [24, 12, 64, 43], 'north-america': [-170, 6, -50, 84], 'south-america': [-84, -57, -33, 14],
    oceania: [110, -50, 182, 0], 'south-asia': [60, 5, 98, 38], 'southeast-asia': [92, -11, 142, 24],
    'east-asia': [95, 18, 150, 54], 'central-asia': [46, 35, 88, 56], caribbean: [-90, 8, -58, 28],
  };

  const PROJECTIONS = {
    naturalEarth: { label: 'Natural Earth', make: () => d3.geoNaturalEarth1(), rect: false },
    equalEarth:   { label: 'Equal Earth', make: () => d3.geoEqualEarth(), rect: false },
    robinson:     { label: 'Robinson', make: () => d3.geoRobinson(), rect: false },
    winkel3:      { label: 'Winkel Tripel', make: () => d3.geoWinkel3(), rect: false },
    mercator:     { label: 'Mercator', make: () => d3.geoMercator(), rect: true },
    miller:       { label: 'Miller', make: () => d3.geoMiller(), rect: true },
    equirect:     { label: 'Equirectangular', make: () => d3.geoEquirectangular(), rect: true },
    orthographic: { label: 'Globe (Orthographic)', make: () => d3.geoOrthographic().clipAngle(90), rect: false, globe: true },
  };
  const ASPECTS = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '4:3': [1600, 1200], '21:9': [2560, 1080] };
  const GROUP_COLORS = ['#FFED54', '#E8383A', '#3B82F6', '#22C55E', '#F97316', '#A855F7'];

  /* ══════════════════════════════════════════════
     State
     ══════════════════════════════════════════════ */
  const state = {
    projection: 'naturalEarth', aspect: '16:9', detail: '110m',
    region: 'world', fit: 'region', zoom: 1, padding: 6,
    land: '#2a2a2a', ocean: '#0d0d0d', oceanTransparent: false, border: '#000000', borderWidth: 0.6,
    graticule: false, graticuleColor: '#333333', labels: true, labelColor: '#ffffff', labelSize: 22, sphereOutline: true,
    groups: [{ color: GROUP_COLORS[0], label: 'Highlighted', ids: [] }],
    active: 0,
  };
  let world = null;          // { features, borders, byId }
  let projection = null, path = null;
  let hoverId = null;
  const svg = $('#mmMap');
  const tip = $('#mmTip');

  /* ══════════════════════════════════════════════
     Data
     ══════════════════════════════════════════════ */
  const cache = {};
  async function loadWorld(detail) {
    if (cache[detail]) return cache[detail];
    const res = await fetch(`/js/vendor/countries-${detail}.json`);
    if (!res.ok) throw new Error('Could not load map data');
    const topo = await res.json();
    const fc = topojson.feature(topo, topo.objects.countries);
    const features = fc.features.map(f => {
      const raw = f.properties?.name || `#${f.id}`;
      const name = NAME_FIX[raw] || raw;
      return { ...f, id: String(f.id), properties: { name, raw, search: [name, raw, ...(ALIASES[name] || [])].join('|').toLowerCase() } };
    }).sort((a, b) => a.properties.name.localeCompare(b.properties.name));
    const byId = new Map(features.map(f => [f.id, f]));
    const borders = topojson.mesh(topo, topo.objects.countries, (a, b) => a !== b);
    const outline = topojson.mesh(topo, topo.objects.countries, (a, b) => a === b);
    cache[detail] = { features, byId, borders, outline };
    return cache[detail];
  }

  /* Largest polygon = sensible label anchor (France → mainland, USA → lower 48).
     Returns its centroid and projected bounds so tiny shapes can skip the label. */
  function largestPolygon(feature) {
    const g = feature.geometry;
    if (g.type === 'Polygon') return feature;
    let best = null, bestArea = -1;
    for (const coords of g.coordinates) {
      const poly = { type: 'Polygon', coordinates: coords };
      const a = path.area(poly);
      if (a > bestArea) { bestArea = a; best = poly; }
    }
    return best || feature;
  }
  function labelPoint(feature) { return path.centroid(largestPolygon(feature)); }
  function labelFits(feature, text, fontSize) {
    // Skip labels that would spill far outside a small country (e.g. Bangladesh at world zoom);
    // they come back automatically when the user zooms in.
    const b = path.bounds(largestPolygon(feature));
    const w = b[1][0] - b[0][0], h = b[1][1] - b[0][1];
    const textW = text.length * fontSize * 0.58;
    return w >= textW * 0.75 || h >= fontSize * 3;
  }

  /* ══════════════════════════════════════════════
     Projection / framing
     ══════════════════════════════════════════════ */
  function canvasSize() { return ASPECTS[state.aspect]; }
  function selectedFeatures() {
    const ids = new Set(state.groups.flatMap(g => g.ids));
    return world.features.filter(f => ids.has(f.id));
  }
  function bboxPolygon([w, s, e, n]) {
    // Sampled edges so curved projections frame the box properly. d3 treats
    // rings as spherical: the exterior must wind CLOCKWISE (west edge going
    // north first), otherwise the polygon means "the whole world except this box".
    const pts = [];
    const step = 2;
    for (let y = s; y < n; y += step) pts.push([w, y]);
    for (let x = w; x < e; x += step) pts.push([x, n]);
    for (let y = n; y > s; y -= step) pts.push([e, y]);
    for (let x = e; x > w; x -= step) pts.push([x, s]);
    pts.push([w, s]);
    return { type: 'Polygon', coordinates: [pts] };
  }
  function fitTarget() {
    if (state.fit === 'selection') {
      const sel = selectedFeatures();
      if (sel.length) return { type: 'FeatureCollection', features: sel };
    }
    const box = REGIONS[state.region];
    return box ? bboxPolygon(box) : { type: 'Sphere' };
  }
  function buildProjection() {
    const [W, H] = canvasSize();
    const def = PROJECTIONS[state.projection];
    projection = def.make();
    path = d3.geoPath(projection);
    const target = fitTarget();
    if (def.globe) {
      // Point the globe at the target, then fit the full sphere.
      const c = target.type === 'Sphere' ? [0, 0] : d3.geoCentroid(target);
      projection.rotate([-c[0], -c[1]]);
      projection.fitExtent([[0, 0], [W, H]], { type: 'Sphere' });
      const padPx = Math.min(W, H) * state.padding / 100;
      projection.fitExtent([[padPx, padPx], [W - padPx, H - padPx]], { type: 'Sphere' });
    } else {
      const padPx = Math.min(W, H) * state.padding / 100;
      projection.fitExtent([[padPx, padPx], [W - padPx, H - padPx]], target);
    }
    if (state.zoom !== 1) {
      const center = projection.invert ? projection.invert([W / 2, H / 2]) : null;
      projection.scale(projection.scale() * state.zoom);
      if (center) {
        const q = projection(center);
        if (q) { const t = projection.translate(); projection.translate([t[0] + W / 2 - q[0], t[1] + H / 2 - q[1]]); }
      }
    }
    projection.precision?.(0.3);
  }

  /* ══════════════════════════════════════════════
     Render (one function builds the live SVG; export reuses it)
     ══════════════════════════════════════════════ */
  function el(name, attrs = {}) {
    const n = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) n.setAttribute(k, v);
    return n;
  }
  function groupOf(id) { return state.groups.find(g => g.ids.includes(id)) || null; }

  function render(target = svg, { interactive = true } = {}) {
    if (!world) return;
    buildProjection();
    const [W, H] = canvasSize();
    target.setAttribute('viewBox', `0 0 ${W} ${H}`);
    while (target.firstChild) target.removeChild(target.firstChild);

    const def = PROJECTIONS[state.projection];
    // Background / ocean
    if (!state.oceanTransparent) {
      if (def.rect) target.appendChild(el('rect', { x: 0, y: 0, width: W, height: H, fill: state.ocean }));
      else {
        target.appendChild(el('rect', { x: 0, y: 0, width: W, height: H, fill: state.ocean }));
      }
    }
    if (!def.rect) {
      // Sphere fill = ocean, so a transparent background still shows the map's ocean shape
      target.appendChild(el('path', { d: path({ type: 'Sphere' }), fill: state.oceanTransparent ? 'none' : state.ocean, stroke: state.sphereOutline ? state.border : 'none', 'stroke-width': state.borderWidth * 1.5 }));
    }
    if (state.graticule) {
      target.appendChild(el('path', { d: path(d3.geoGraticule10()), fill: 'none', stroke: state.graticuleColor, 'stroke-width': 0.5, 'stroke-opacity': 0.8 }));
    }
    // Countries
    const gLand = el('g', { id: 'countries' });
    for (const f of world.features) {
      const d = path(f);
      if (!d) continue;
      const grp = groupOf(f.id);
      const p = el('path', { d, fill: grp ? grp.color : state.land, 'data-id': f.id });
      if (interactive) {
        p.classList.add('mm-country');
        if (f.id === hoverId) p.classList.add('is-hover');
      }
      gLand.appendChild(p);
    }
    target.appendChild(gLand);
    // Borders
    target.appendChild(el('path', { d: path(world.borders), fill: 'none', stroke: state.border, 'stroke-width': state.borderWidth, 'stroke-linejoin': 'round' }));
    target.appendChild(el('path', { d: path(world.outline), fill: 'none', stroke: state.border, 'stroke-width': state.borderWidth, 'stroke-linejoin': 'round' }));
    // Labels
    if (state.labels) {
      const gT = el('g', { id: 'labels', 'font-family': "Inter, 'Segoe UI', Arial, sans-serif", 'font-weight': '700', 'font-size': state.labelSize, 'text-anchor': 'middle', fill: state.labelColor, 'paint-order': 'stroke', stroke: 'rgba(0,0,0,.65)', 'stroke-width': Math.max(2, state.labelSize / 7), 'stroke-linejoin': 'round' });
      for (const f of selectedFeatures()) {
        const c = labelPoint(f);
        if (!c || !isFinite(c[0]) || !isFinite(c[1])) continue;
        if (c[0] < 0 || c[1] < 0 || c[0] > W || c[1] > H) continue;
        if (!labelFits(f, f.properties.name, state.labelSize)) continue;
        if (def.globe) {
          // Skip countries on the far side of the globe (their clipped centroid can still land on-canvas).
          const r = projection.rotate();
          if (d3.geoDistance(d3.geoCentroid(largestPolygon(f)), [-r[0], -r[1]]) > Math.PI / 2 - 0.3) continue;
        }
        const t = el('text', { x: c[0].toFixed(1), y: (c[1] + state.labelSize / 3).toFixed(1) });
        t.textContent = f.properties.name;
        gT.appendChild(t);
      }
      target.appendChild(gT);
    }
  }

  /* ══════════════════════════════════════════════
     Groups UI
     ══════════════════════════════════════════════ */
  const groupsEl = $('#mmGroups');
  function renderGroups() {
    groupsEl.innerHTML = '';
    state.groups.forEach((g, i) => {
      const box = document.createElement('div');
      box.className = 'mm-group' + (i === state.active ? ' is-active' : '');
      box.innerHTML = `
        <div class="mm-group-head">
          <button type="button" class="mm-group-pick" data-i="${i}" aria-label="Make this the active group" title="Click a country on the map to add it to the active group">
            <span class="mm-swatch" data-color="${g.color}"></span>
          </button>
          <input type="color" value="${g.color}" data-i="${i}" class="mm-color" aria-label="Group colour">
          <input type="text" value="${escapeAttr(g.label)}" data-i="${i}" class="mm-label" placeholder="Label" aria-label="Group label" maxlength="40">
          <span class="mm-count">${g.ids.length}</span>
          ${state.groups.length > 1 ? `<button type="button" class="mm-x" data-del="${i}" aria-label="Remove group">×</button>` : ''}
        </div>
        <div class="mm-chips">${g.ids.map(id => `<span class="mm-chip">${escapeHtml(world.byId.get(id)?.properties.name || id)}<button type="button" data-rm="${id}" aria-label="Remove">×</button></span>`).join('') || '<span class="mm-chips-empty">Click countries on the map or use the search box.</span>'}</div>`;
      groupsEl.appendChild(box);
      paintSwatches(box);
    });
    $('#mmAddGroup').hidden = state.groups.length >= GROUP_COLORS.length;
  }
  groupsEl.addEventListener('click', e => {
    const pick = e.target.closest('.mm-group-pick'); const del = e.target.closest('[data-del]'); const rm = e.target.closest('[data-rm]');
    if (pick) { state.active = +pick.dataset.i; renderGroups(); }
    else if (del) { state.groups.splice(+del.dataset.del, 1); state.active = Math.min(state.active, state.groups.length - 1); update(); }
    else if (rm) { for (const g of state.groups) g.ids = g.ids.filter(id => id !== rm.dataset.rm); update(); }
  });
  groupsEl.addEventListener('input', e => {
    if (e.target.classList.contains('mm-color')) { state.groups[+e.target.dataset.i].color = e.target.value; e.target.closest('.mm-group').querySelector('.mm-swatch').style.background = e.target.value; render(); saveHash(); }
    if (e.target.classList.contains('mm-label')) { state.groups[+e.target.dataset.i].label = e.target.value; saveHash(); }
  });
  $('#mmAddGroup').addEventListener('click', () => {
    const used = new Set(state.groups.map(g => g.color));
    state.groups.push({ color: GROUP_COLORS.find(c => !used.has(c)) || '#ffffff', label: `Group ${state.groups.length + 1}`, ids: [] });
    state.active = state.groups.length - 1; update();
  });

  function toggleCountry(id) {
    const g = state.groups[state.active];
    if (g.ids.includes(id)) g.ids = g.ids.filter(x => x !== id);
    else { for (const o of state.groups) o.ids = o.ids.filter(x => x !== id); g.ids.push(id); }
    update();
  }

  /* ══════════════════════════════════════════════
     Search
     ══════════════════════════════════════════════ */
  const search = $('#mmSearch'), results = $('#mmResults');
  function runSearch() {
    const q = search.value.trim().toLowerCase();
    results.innerHTML = '';
    if (!q || !world) { results.hidden = true; return; }
    const hits = world.features.filter(f => f.properties.search.includes(q)).slice(0, 12);
    if (!hits.length) { results.hidden = true; return; }
    for (const f of hits) {
      const b = document.createElement('button');
      b.type = 'button'; b.dataset.id = f.id;
      const inGroup = groupOf(f.id);
      b.innerHTML = `${escapeHtml(f.properties.name)}${inGroup ? ` <span class="mm-swatch" data-color="${inGroup.color}"></span>` : ''}`;
      results.appendChild(b);
    }
    paintSwatches(results);
    results.hidden = false;
  }
  search.addEventListener('input', runSearch);
  search.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); const first = results.querySelector('button'); if (first) { toggleCountry(first.dataset.id); search.select(); runSearch(); } }
    if (e.key === 'Escape') { results.hidden = true; }
  });
  results.addEventListener('click', e => { const b = e.target.closest('button'); if (b) { toggleCountry(b.dataset.id); search.focus(); runSearch(); } });
  document.addEventListener('click', e => { if (!e.target.closest('.mm-search')) results.hidden = true; });

  /* ══════════════════════════════════════════════
     Map interaction
     ══════════════════════════════════════════════ */
  svg.addEventListener('click', e => { const p = e.target.closest('path[data-id]'); if (p) toggleCountry(p.dataset.id); });
  svg.addEventListener('mousemove', e => {
    const p = e.target.closest('path[data-id]');
    const id = p ? p.dataset.id : null;
    if (id !== hoverId) {
      $$('.mm-country.is-hover', svg).forEach(x => x.classList.remove('is-hover'));
      hoverId = id;
      if (p) p.classList.add('is-hover');
    }
    if (p) {
      const grp = groupOf(id);
      tip.textContent = world.byId.get(id)?.properties.name + (grp ? ` · ${grp.label || 'highlighted'}` : '');
      tip.hidden = false;
      const r = svg.parentElement.getBoundingClientRect();
      tip.style.left = `${e.clientX - r.left + 14}px`; tip.style.top = `${e.clientY - r.top + 14}px`;
    } else tip.hidden = true;
  });
  svg.addEventListener('mouseleave', () => { tip.hidden = true; hoverId = null; $$('.mm-country.is-hover', svg).forEach(x => x.classList.remove('is-hover')); });

  /* ══════════════════════════════════════════════
     Controls
     ══════════════════════════════════════════════ */
  const controls = {
    mmProjection: ['projection', v => v], mmAspect: ['aspect', v => v], mmRegion: ['region', v => v],
    mmLand: ['land', v => v], mmOcean: ['ocean', v => v], mmBorder: ['border', v => v], mmBorderWidth: ['borderWidth', Number],
    mmLabelColor: ['labelColor', v => v], mmLabelSize: ['labelSize', Number], mmGratColor: ['graticuleColor', v => v],
    mmZoom: ['zoom', Number], mmPadding: ['padding', Number],
  };
  const checks = { mmLabels: 'labels', mmGrat: 'graticule', mmOceanTransparent: 'oceanTransparent', mmSphere: 'sphereOutline' };
  for (const [id, [key, cast]] of Object.entries(controls)) {
    const input = $('#' + id); if (!input) continue;
    input.addEventListener('input', () => { state[key] = cast(input.value); if (key === 'region') state.fit = 'region'; update(false); });
  }
  for (const [id, key] of Object.entries(checks)) {
    const input = $('#' + id); if (!input) continue;
    input.addEventListener('change', () => { state[key] = input.checked; update(false); });
  }
  $('#mmFitSelection').addEventListener('click', () => { state.fit = 'selection'; state.zoom = 1; $('#mmZoom').value = 1; update(false); });
  $('#mmFitWorld').addEventListener('click', () => { state.fit = 'region'; state.region = 'world'; $('#mmRegion').value = 'world'; state.zoom = 1; $('#mmZoom').value = 1; update(false); });
  $('#mmClear').addEventListener('click', () => { state.groups.forEach(g => g.ids = []); update(); });
  $('#mmDetail').addEventListener('change', async e => {
    state.detail = e.target.checked ? '50m' : '110m';
    setBusy(true, e.target.checked ? 'Loading detailed borders (about 700 KB)…' : 'Loading…');
    try { world = await loadWorld(state.detail); } catch (err) { showError(err.message); }
    setBusy(false); update();
  });
  $$('.mm-preset').forEach(b => b.addEventListener('click', () => applyPreset(b.dataset.preset)));

  function syncControls() {
    for (const [id, [key]] of Object.entries(controls)) { const i = $('#' + id); if (i) i.value = state[key]; }
    for (const [id, key] of Object.entries(checks)) { const i = $('#' + id); if (i) i.checked = state[key]; }
    $('#mmDetail').checked = state.detail === '50m';
    $('#mmZoomVal').textContent = `${state.zoom.toFixed(1)}×`;
  }

  /* Style presets */
  const PRESETS = {
    dark:   { land: '#2a2a2a', ocean: '#0d0d0d', border: '#000000', labelColor: '#ffffff', graticuleColor: '#333333' },
    light:  { land: '#e6e6e6', ocean: '#ffffff', border: '#9a9a9a', labelColor: '#111111', graticuleColor: '#d0d0d0' },
    ocean:  { land: '#d9d2b8', ocean: '#7fb3d5', border: '#6b6a5a', labelColor: '#1a1a1a', graticuleColor: '#9ec5e0' },
    slate:  { land: '#3b4252', ocean: '#1c2028', border: '#11131a', labelColor: '#eceff4', graticuleColor: '#2e3440' },
    paper:  { land: '#f3e9d2', ocean: '#fbf7ee', border: '#8a7b5a', labelColor: '#3b2f1e', graticuleColor: '#e0d5bd' },
  };
  function applyPreset(name) { Object.assign(state, PRESETS[name] || {}); syncControls(); update(false); }

  /* ══════════════════════════════════════════════
     Export
     ══════════════════════════════════════════════ */
  function exportSize() {
    const [W, H] = canvasSize();
    const mult = Number($('#mmExportScale').value) || 1;
    return [Math.round(W * mult), Math.round(H * mult)];
  }
  function buildExportSvg() {
    const s = document.createElementNS(SVG_NS, 'svg');
    const [W, H] = canvasSize();
    const [ew, eh] = exportSize();
    s.setAttribute('xmlns', SVG_NS);
    s.setAttribute('width', ew); s.setAttribute('height', eh);
    render(s, { interactive: false });
    s.setAttribute('viewBox', `0 0 ${W} ${H}`);
    return s;
  }
  function svgString() { return new XMLSerializer().serializeToString(buildExportSvg()); }
  async function toPngBlob() {
    const str = svgString();
    const [ew, eh] = exportSize();
    const url = URL.createObjectURL(new Blob([str], { type: 'image/svg+xml;charset=utf-8' }));
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not rasterise the map')); i.src = url; });
      const c = document.createElement('canvas'); c.width = ew; c.height = eh;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, ew, eh);
      return await new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('PNG encoding failed'))), 'image/png'));
    } finally { URL.revokeObjectURL(url); }
  }
  function download(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.style.display = 'none';
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  function fileBase() {
    const names = selectedFeatures().slice(0, 3).map(f => f.properties.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase());
    return `map-${names.length ? names.join('-') : 'world'}-${state.aspect.replace(':', 'x')}`;
  }
  $('#mmDownloadPng').addEventListener('click', async () => {
    setBusy(true, 'Rendering PNG…');
    try { download(await toPngBlob(), `${fileBase()}.png`); } catch (e) { showError(e.message); }
    setBusy(false);
  });
  $('#mmDownloadSvg').addEventListener('click', () => {
    download(new Blob([svgString()], { type: 'image/svg+xml;charset=utf-8' }), `${fileBase()}.svg`);
  });
  $('#mmCopyPng').addEventListener('click', async () => {
    if (!navigator.clipboard || typeof ClipboardItem === 'undefined') { showError('Clipboard images are not supported in this browser. Use Download PNG.'); return; }
    setBusy(true, 'Copying…');
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': await toPngBlob() })]); flash('Copied to clipboard'); }
    catch (e) { showError('Clipboard blocked by the browser. Use Download PNG.'); }
    setBusy(false);
  });
  $('#mmShare').addEventListener('click', async () => {
    saveHash();
    try { await navigator.clipboard.writeText(location.href); flash('Link copied — anyone opening it sees this exact map'); }
    catch (_) { flash('Copy the address bar URL to share this map'); }
  });

  /* ══════════════════════════════════════════════
     URL state (share links), status helpers
     ══════════════════════════════════════════════ */
  // A share link carries only what differs from a fresh map, as readable key=value pairs after the #:
  // #c=250.276 is "France and Germany highlighted", and an untouched map has no # at all. Older links
  // (#m= followed by base64 JSON of every setting) still open.
  const DEFAULTS = JSON.parse(JSON.stringify(state));
  const HEX = { land: 'l', ocean: 'o', border: 'b', graticuleColor: 'gc', labelColor: 'lc' };
  const FLAGS = { oceanTransparent: 't', graticule: 'gr', labels: 'lb', sphereOutline: 'so' };
  const NUMS = { zoom: 'z', padding: 'pd', borderWidth: 'bw', labelSize: 'ls' };
  const defaultLabel = i => (i === 0 ? DEFAULTS.groups[0].label : `Group ${i + 1}`);
  const defaultColor = i => GROUP_COLORS[i % GROUP_COLORS.length];
  function saveHash() {
    const q = [];
    const put = (k, v) => q.push(`${k}=${encodeURIComponent(v).replace(/%20/g, '+')}`);
    if (state.projection !== DEFAULTS.projection) put('p', state.projection);
    if (state.aspect !== DEFAULTS.aspect) put('a', state.aspect.replace(':', 'x'));
    if (state.region !== DEFAULTS.region) put('r', state.region);
    if (state.fit !== DEFAULTS.fit) put('f', 's');
    if (state.detail !== DEFAULTS.detail) put('d', '50');
    for (const [k, key] of Object.entries(NUMS)) if (state[k] !== DEFAULTS[k]) put(key, +Number(state[k]).toFixed(2));
    for (const [k, key] of Object.entries(HEX)) if (state[k].toLowerCase() !== DEFAULTS[k].toLowerCase()) put(key, state[k].slice(1).toLowerCase());
    for (const [k, key] of Object.entries(FLAGS)) if (state[k] !== DEFAULTS[k]) put(key, state[k] ? 1 : 0);
    // Groups: c = the ids of each group, joined with "." and groups separated by "_"; a colour or a name is
    // written only for a group whose colour or name is not the one it would get by default.
    const gs = state.groups;
    if (gs.length > 1 || gs[0].ids.length) {
      put('c', gs.map(g => g.ids.join('.')).join('_'));
      if (gs.some((g, i) => g.color.toLowerCase() !== defaultColor(i).toLowerCase())) put('k', gs.map(g => g.color.slice(1).toLowerCase()).join('.'));
      if (gs.some((g, i) => g.label !== defaultLabel(i))) put('n', gs.map(g => g.label.replace(/_/g, ' ')).join('_'));
    } else {
      if (gs[0].color.toLowerCase() !== defaultColor(0).toLowerCase()) put('k', gs[0].color.slice(1).toLowerCase());
      if (gs[0].label !== defaultLabel(0)) put('n', gs[0].label.replace(/_/g, ' '));
    }
    history.replaceState(null, '', q.length ? `#${q.join('&')}` : location.pathname + location.search);
  }
  function loadHash() {
    const h = location.hash.slice(1);
    if (!h) return false;
    if (h.startsWith('m=')) return loadLegacyHash(h.slice(2));
    const q = new URLSearchParams(h);
    const hex = v => (/^[0-9a-f]{6}$/i.test(v || '') ? `#${v.toLowerCase()}` : null);
    if (PROJECTIONS[q.get('p')]) state.projection = q.get('p');
    const asp = (q.get('a') || '').replace('x', ':');
    if (ASPECTS[asp]) state.aspect = asp;
    if (q.get('r') in REGIONS) state.region = q.get('r');
    if (q.get('f') === 's') state.fit = 'selection';
    if (q.get('d') === '50') state.detail = '50m';
    const num = (key, lo, hi) => { const v = Number(q.get(key)); return q.has(key) && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null; };
    state.zoom = num('z', 0.5, 8) ?? state.zoom;
    state.padding = num('pd', 0, 20) ?? state.padding;
    state.borderWidth = num('bw', 0, 4) ?? state.borderWidth;
    state.labelSize = num('ls', 8, 80) ?? state.labelSize;
    for (const [k, key] of Object.entries(HEX)) state[k] = hex(q.get(key)) || state[k];
    for (const [k, key] of Object.entries(FLAGS)) if (q.has(key)) state[k] = q.get(key) === '1';
    const ids = q.has('c') ? q.get('c').split('_') : [''];
    const colors = (q.get('k') || '').split('.');
    const names = q.has('n') ? q.get('n').split('_') : [];
    state.groups = ids.slice(0, GROUP_COLORS.length).map((list, i) => ({
      color: hex(colors[i]) || defaultColor(i),
      label: (names[i] ?? defaultLabel(i)).slice(0, 40),
      ids: list.split('.').filter(x => /^\d+$/.test(x)),
    }));
    state.active = 0;
    return true;
  }
  function loadLegacyHash(b64) {
    try {
      const s = JSON.parse(decodeURIComponent(escape(atob(b64.replace(/-/g, '+').replace(/_/g, '/')))));
      if (PROJECTIONS[s.p]) state.projection = s.p;
      if (ASPECTS[s.a]) state.aspect = s.a;
      if (s.r in REGIONS) state.region = s.r;
      state.fit = s.f === 'selection' ? 'selection' : 'region';
      state.zoom = Math.min(8, Math.max(0.5, Number(s.z) || 1));
      state.padding = Math.min(20, Math.max(0, Number(s.pd) || 6));
      state.detail = s.d === '50m' ? '50m' : '110m';
      if (Array.isArray(s.st) && s.st.length >= 11) {
        const c = v => (/^#[0-9a-f]{6}$/i.test(v) ? v : null);
        state.land = c(s.st[0]) || state.land; state.ocean = c(s.st[1]) || state.ocean; state.oceanTransparent = !!s.st[2];
        state.border = c(s.st[3]) || state.border; state.borderWidth = Math.min(4, Math.max(0, Number(s.st[4]) || 0.6));
        state.graticule = !!s.st[5]; state.graticuleColor = c(s.st[6]) || state.graticuleColor; state.labels = !!s.st[7];
        state.labelColor = c(s.st[8]) || state.labelColor; state.labelSize = Math.min(80, Math.max(8, Number(s.st[9]) || 22)); state.sphereOutline = !!s.st[10];
      }
      if (Array.isArray(s.g) && s.g.length) {
        state.groups = s.g.slice(0, GROUP_COLORS.length).map((g, i) => ({
          color: /^#[0-9a-f]{6}$/i.test(g[0]) ? g[0] : GROUP_COLORS[i % GROUP_COLORS.length],
          label: String(g[1] || '').slice(0, 40),
          ids: String(g[2] || '').split(',').filter(x => /^\d+$/.test(x)),
        }));
        state.active = 0;
      }
      return true;
    } catch (_) { return false; }
  }
  function setBusy(on, msg) { $('#mmStatus').textContent = on ? msg : ''; $('#mmStatus').hidden = !on; document.body.classList.toggle('mm-busy', on); }
  function showError(msg) { const e = $('#mmError'); e.textContent = msg; e.hidden = false; clearTimeout(showError.t); showError.t = setTimeout(() => (e.hidden = true), 6000); }
  function flash(msg) { const e = $('#mmFlash'); e.textContent = msg; e.hidden = false; clearTimeout(flash.t); flash.t = setTimeout(() => (e.hidden = true), 2500); }
  // Swatch colours come from data-color: the CSP refuses style="" in markup, but a CSSOM write is allowed.
  function paintSwatches(root) { root.querySelectorAll('.mm-swatch[data-color]').forEach(el => { el.style.background = el.dataset.color; }); }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function escapeAttr(s) { return escapeHtml(s); }

  function update(groupsToo = true) {
    // Drop ids that don't exist in the current detail level (110m lacks tiny states)
    for (const g of state.groups) g.ids = g.ids.filter(id => world.byId.has(id));
    $('#mmZoomVal').textContent = `${state.zoom.toFixed(1)}×`;
    $('#mmExportDims').textContent = exportSize().join(' × ');
    render();
    if (groupsToo) renderGroups();
    saveHash();
  }
  $('#mmExportScale').addEventListener('change', () => { $('#mmExportDims').textContent = exportSize().join(' × '); });

  /* ══════════════════════════════════════════════
     Boot
     ══════════════════════════════════════════════ */
  (async () => {
    // Fill selects
    const ps = $('#mmProjection');
    for (const [k, v] of Object.entries(PROJECTIONS)) { const o = document.createElement('option'); o.value = k; o.textContent = v.label; ps.appendChild(o); }
    const fromHash = loadHash();
    syncControls();
    setBusy(true, 'Loading map…');
    try {
      world = await loadWorld(state.detail);
      if (!fromHash && !state.groups[0].ids.length) {
        // Friendly default: highlight the visitor's likely interest — nothing. Keep world blank; hint text explains.
      }
      update();
      $('#mmTool').classList.add('is-ready');
    } catch (e) {
      showError('The map data could not be loaded. Please reload the page.');
    }
    setBusy(false);
  })();
})();
