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
  // Each continent: the countries it counts, and places that can be marked on its map but are counted on
  // their own line (territories, and places whose status is disputed). Transcontinental Turkey and Cyprus
  // appear on both the Europe and Asia maps, as most travel lists have them.
  const CONTINENTS = {
    europe: { counted: EUROPE, extra: ['x-kosovo'] },
    asia: { counted: new Set('004 051 031 048 050 064 096 116 156 196 268 356 360 364 368 376 392 400 398 414 417 418 422 458 462 496 104 524 408 512 586 275 608 634 682 702 410 144 760 762 764 626 792 795 784 860 704 887'.split(' ')), extra: ['158', '344', '446', 'x-n-cyprus'] },
    africa: { counted: new Set('012 024 204 072 854 108 132 120 140 148 174 178 180 384 262 818 226 232 748 231 266 270 288 324 624 404 426 430 434 450 454 466 478 480 504 508 516 562 566 646 678 686 690 694 706 710 728 729 834 768 788 800 894 716'.split(' ')), extra: ['732', 'x-somaliland', '654'] },
    'north-america': { counted: new Set('028 044 052 084 124 188 192 212 214 222 308 320 332 340 388 484 558 591 659 662 670 780 840'.split(' ')), extra: ['304', '630', '060', '136', '796', '850', '092', '660', '500', '533', '531', '534', '652', '663', '666'] },
    'south-america': { counted: new Set('032 068 076 152 170 218 328 600 604 740 858 862'.split(' ')), extra: ['238', '239'] },
    oceania: { counted: new Set('036 242 296 584 583 520 554 585 598 882 090 776 798 548'.split(' ')), extra: ['540', '258', '316', '580', '016', '184', '570', '574', '612', '876'] },
  };
  // Places on the world map that are not among the 195 countries counted (193 UN members, the Vatican and
  // Palestine): dependent territories and places whose status is disputed. They can still be marked, and
  // are counted on their own line.
  const NOT_COUNTED = new Set('016 660 533 060 086 092 136 184 531 234 238 258 260 304 316 831 334 344 833 832 446 500 580 540 570 574 612 630 239 654 534 652 663 666 158 796 850 732 876 248'.split(' '));
  const US_SKIP = new Set(['11', '60', '66', '69', '72', '78']);   // DC and the territories: the count is the 50 states
  const REGIONS = {
    us: { label: 'USA', unit: 'states', one: 'state', total: 50, file: '/js/vendor/us-states-10m.json', object: 'states', size: [975, 610] },
    europe: { label: 'Europe', unit: 'countries', one: 'country', total: 46, file: '/js/vendor/countries-50m.json', object: 'countries', size: [900, 760] },
    asia: { label: 'Asia', unit: 'countries', one: 'country', total: 48, file: '/js/vendor/countries-50m.json', object: 'countries', size: [1000, 720] },
    africa: { label: 'Africa', unit: 'countries', one: 'country', total: 54, file: '/js/vendor/countries-50m.json', object: 'countries', size: [840, 860] },
    'north-america': { label: 'North America', unit: 'countries', one: 'country', total: 23, file: '/js/vendor/countries-50m.json', object: 'countries', size: [1000, 820] },
    'south-america': { label: 'South America', unit: 'countries', one: 'country', total: 12, file: '/js/vendor/countries-50m.json', object: 'countries', size: [720, 900] },
    oceania: { label: 'Oceania', unit: 'countries', one: 'country', total: 14, file: '/js/vendor/countries-50m.json', object: 'countries', size: [1000, 640] },
    world: { label: 'World', unit: 'countries', one: 'country', total: 195, file: '/js/vendor/countries-50m.json', object: 'countries', size: [1000, 520] },
    // Countries by their regions: Natural Earth admin-1 borders, one small TopoJSON per country (js/data/admin1/).
    canada: { label: 'Canada', unit: 'provinces & territories', one: 'province or territory', total: 13, admin: true, file: '/js/data/admin1/canada.json', object: 'regions', size: [1000, 820] },
    australia: { label: 'Australia', unit: 'states & territories', one: 'state or territory', total: 8, admin: true, file: '/js/data/admin1/australia.json', object: 'regions', size: [1000, 860] },
    uk: { label: 'the UK', unit: 'regions', one: 'region', total: 12, admin: true, file: '/js/data/admin1/uk.json', object: 'regions', size: [700, 1000] },
    germany: { label: 'Germany', unit: 'states', one: 'state', total: 16, admin: true, file: '/js/data/admin1/germany.json', object: 'regions', size: [760, 1000] },
    japan: { label: 'Japan', unit: 'prefectures', one: 'prefecture', total: 47, admin: true, file: '/js/data/admin1/japan.json', object: 'regions', size: [900, 900] },
    mexico: { label: 'Mexico', unit: 'states', one: 'state', total: 32, admin: true, file: '/js/data/admin1/mexico.json', object: 'regions', size: [1000, 680] },
    brazil: { label: 'Brazil', unit: 'states', one: 'state', total: 27, admin: true, file: '/js/data/admin1/brazil.json', object: 'regions', size: [900, 880] },
    spain: { label: 'Spain', unit: 'autonomous communities', one: 'autonomous community', total: 17, admin: true, file: '/js/data/admin1/spain.json', object: 'regions', size: [1000, 820],
      note: '* Ceuta and Melilla, Spain’s two autonomous cities in North Africa, can be marked and are counted on their own line. The Canary Islands are shown in the box.' },
    italy: { label: 'Italy', unit: 'regions', one: 'region', total: 20, admin: true, file: '/js/data/admin1/italy.json', object: 'regions', size: [760, 1000] },
    china: { label: 'China', unit: 'provinces & regions', one: 'province or region', total: 31, admin: true, file: '/js/data/admin1/china.json', object: 'regions', size: [1000, 820],
      note: '* Hong Kong and Macau, China’s two special administrative regions, can be marked and are counted on their own line.' },
    'south-korea': { label: 'South Korea', unit: 'provinces & cities', one: 'province or city', total: 17, admin: true, file: '/js/data/admin1/south-korea.json', object: 'regions', size: [760, 1000] },
    argentina: { label: 'Argentina', unit: 'provinces', one: 'province', total: 24, admin: true, file: '/js/data/admin1/argentina.json', object: 'regions', size: [620, 1000] },
    portugal: { label: 'Portugal', unit: 'districts & regions', one: 'district or region', total: 20, admin: true, file: '/js/data/admin1/portugal.json', object: 'regions', size: [720, 1000] },
    france: { label: 'France', unit: 'regions', one: 'region', total: 13, admin: true, file: '/js/data/admin1/france.json', object: 'regions', size: [900, 900] },
    netherlands: { label: 'the Netherlands', unit: 'provinces', one: 'province', total: 12, admin: true, file: '/js/data/admin1/netherlands.json', object: 'regions', size: [740, 1000] },
    switzerland: { label: 'Switzerland', unit: 'cantons', one: 'canton', total: 26, admin: true, file: '/js/data/admin1/switzerland.json', object: 'regions', size: [1000, 660] },
    austria: { label: 'Austria', unit: 'states', one: 'state', total: 9, admin: true, file: '/js/data/admin1/austria.json', object: 'regions', size: [1000, 540] },
    poland: { label: 'Poland', unit: 'voivodeships', one: 'voivodeship', total: 16, admin: true, file: '/js/data/admin1/poland.json', object: 'regions', size: [1000, 940] },
    ireland: { label: 'Ireland', unit: 'counties', one: 'county', total: 26, admin: true, file: '/js/data/admin1/ireland.json', object: 'regions', size: [780, 1000] },
    sweden: { label: 'Sweden', unit: 'counties', one: 'county', total: 21, admin: true, file: '/js/data/admin1/sweden.json', object: 'regions', size: [520, 1000] },
    'new-zealand': { label: 'New Zealand', unit: 'regions', one: 'region', total: 16, admin: true, file: '/js/data/admin1/new-zealand.json', object: 'regions', size: [760, 1000] },
    colombia: { label: 'Colombia', unit: 'departments', one: 'department', total: 33, admin: true, file: '/js/data/admin1/colombia.json', object: 'regions', size: [760, 1000] },
    'south-africa': { label: 'South Africa', unit: 'provinces', one: 'province', total: 9, admin: true, file: '/js/data/admin1/south-africa.json', object: 'regions', size: [1000, 860] },
    norway: { label: 'Norway', unit: 'counties', one: 'county', total: 15, admin: true, file: '/js/data/admin1/norway.json', object: 'regions', size: [760, 1000] },
    greece: { label: 'Greece', unit: 'regions', one: 'region', total: 13, admin: true, file: '/js/data/admin1/greece.json', object: 'regions', size: [900, 860],
      note: '* Mount Athos, the self-governing monastic state, can be marked and is counted on its own line.' },
    turkey: { label: 'Turkey', unit: 'provinces', one: 'province', total: 81, admin: true, file: '/js/data/admin1/turkey.json', object: 'regions', size: [1000, 480] },
    peru: { label: 'Peru', unit: 'regions', one: 'region', total: 26, admin: true, file: '/js/data/admin1/peru.json', object: 'regions', size: [760, 1000] },
    chile: { label: 'Chile', unit: 'regions', one: 'region', total: 16, admin: true, file: '/js/data/admin1/chile.json', object: 'regions', size: [760, 1000] },
    belgium: { label: 'Belgium', unit: 'provinces', one: 'province', total: 11, admin: true, file: '/js/data/admin1/belgium.json', object: 'regions', size: [1000, 820] },
    denmark: { label: 'Denmark', unit: 'regions', one: 'region', total: 5, admin: true, file: '/js/data/admin1/denmark.json', object: 'regions', size: [900, 760] },
    'czech-republic': { label: 'the Czech Republic', unit: 'regions', one: 'region', total: 14, admin: true, file: '/js/data/admin1/czech-republic.json', object: 'regions', size: [1000, 600] },
    hungary: { label: 'Hungary', unit: 'counties', one: 'county', total: 20, admin: true, file: '/js/data/admin1/hungary.json', object: 'regions', size: [1000, 640] },
    croatia: { label: 'Croatia', unit: 'counties', one: 'county', total: 21, admin: true, file: '/js/data/admin1/croatia.json', object: 'regions', size: [900, 880] },
    iceland: { label: 'Iceland', unit: 'regions', one: 'region', total: 8, admin: true, file: '/js/data/admin1/iceland.json', object: 'regions', size: [1000, 700] },
    finland: { label: 'Finland', unit: 'regions', one: 'region', total: 19, admin: true, file: '/js/data/admin1/finland.json', object: 'regions', size: [600, 1000] },
    romania: { label: 'Romania', unit: 'counties', one: 'county', total: 42, admin: true, file: '/js/data/admin1/romania.json', object: 'regions', size: [1000, 720] },
    thailand: { label: 'Thailand', unit: 'provinces', one: 'province', total: 77, admin: true, file: '/js/data/admin1/thailand.json', object: 'regions', size: [620, 1000] },
    ecuador: { label: 'Ecuador', unit: 'provinces', one: 'province', total: 24, admin: true, file: '/js/data/admin1/ecuador.json', object: 'regions', size: [1000, 780] },
    cuba: { label: 'Cuba', unit: 'provinces', one: 'province', total: 16, admin: true, file: '/js/data/admin1/cuba.json', object: 'regions', size: [1000, 480] },
    'costa-rica': { label: 'Costa Rica', unit: 'provinces', one: 'province', total: 7, admin: true, file: '/js/data/admin1/costa-rica.json', object: 'regions', size: [900, 860] },
    bolivia: { label: 'Bolivia', unit: 'departments', one: 'department', total: 9, admin: true, file: '/js/data/admin1/bolivia.json', object: 'regions', size: [860, 1000] },
    malaysia: { label: 'Malaysia', unit: 'states & territories', one: 'state or territory', total: 16, admin: true, file: '/js/data/admin1/malaysia.json', object: 'regions', size: [1000, 500] },
    parks: { label: 'National Parks', unit: 'parks', one: 'park', total: 63, file: '/js/vendor/us-states-10m.json', object: 'states', size: [975, 610] },
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
  const blank = () => Object.fromEntries(Object.keys(REGIONS).map(k => [k, { v: [], w: [] }]));   // one slot per map
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
    if (R.admin) {
      // extra: markable but counted on its own line (Spain's Ceuta and Melilla). inset: moved closer and boxed.
      const features = fc.features.map(f => ({ ...f, id: f.properties.id, properties: { name: f.properties.name, extra: !!f.properties.extra, inset: !!f.properties.inset } }));
      const list = [...features].sort((a, b) => a.properties.name.localeCompare(b.properties.name));
      const ids = new Set(list.map(f => f.id));
      const counted = new Set(list.filter(f => !f.properties.extra).map(f => f.id));
      return { key, features, list, byId: new Map(list.map(f => [f.id, f])), counted, interactive: ids };
    }
    const named = fc.features.map(f => {
      const raw = f.properties?.name || '';
      const id = f.id != null ? String(f.id) : 'x-' + raw.toLowerCase().replace(/[^a-z]+/g, '-');
      return { ...f, id, properties: { name: NAME_FIX[raw] || raw } };
    });
    let features, list, counted;
    if (key === 'parks') {
      // The 63 national parks are points on the US map; the states are only the background.
      const parks = await loadTopo('/js/data/national-parks.json');
      features = named.filter(f => !US_SKIP.has(f.id));
      list = parks.map(p => ({ id: p.id, park: p, properties: { name: p.name, sub: `${p.states} · est. ${p.year}` } }));
      counted = new Set(list.map(f => f.id));
      list.sort((a, b) => a.properties.name.localeCompare(b.properties.name));
      return { key, features, list, byId: new Map(list.map(f => [f.id, f])), counted, interactive: counted };
    }
    if (key === 'us') {
      features = named.filter(f => !US_SKIP.has(f.id));
      list = features;
      counted = new Set(list.map(f => f.id));
    } else if (CONTINENTS[key]) {
      const C = CONTINENTS[key];
      features = named.filter(f => f.id !== '010');
      const seen = new Set(); list = [];
      for (const f of features) if ((C.counted.has(f.id) || C.extra.includes(f.id)) && !seen.has(f.id) && f.properties.name !== 'Ashmore and Cartier Islands') { seen.add(f.id); list.push(f); }
      if (C.counted.has('798')) list.push({ id: '798', properties: { name: 'Tuvalu' }, geometry: null, listOnly: true });
      counted = C.counted;
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
    if (key === 'us' || key === 'parks') return d3.geoAlbersUsa().fitExtent([[pad, pad], [W - pad, H - pad]], { type: 'FeatureCollection', features: data.features });
    // Each continent is framed by a grid of points over its extent, in a projection suited to its shape.
    const grid = (x0, x1, y0, y1) => { const pts = []; for (let x = x0; x <= x1; x += 2) for (let y = y0; y <= y1; y += 2) pts.push([x, y]); return { type: 'MultiPoint', coordinates: pts }; };
    const fit = (p, box) => p.fitExtent([[pad, pad], [W - pad, H - pad]], box);
    if (key === 'europe') return fit(d3.geoConicConformal().rotate([-12, 0]).parallels([40, 64]), grid(-24, 44, 35, 71));
    if (key === 'asia') return fit(d3.geoConicConformal().rotate([-88, 0]).parallels([15, 45]), grid(26, 146, -10, 54));
    if (key === 'africa') return fit(d3.geoAzimuthalEqualArea().rotate([-17, -2]), grid(-25, 58, -35, 37));
    if (key === 'north-america') return fit(d3.geoConicEqualArea().rotate([96, 0]).parallels([20, 60]), grid(-168, -52, 7, 72));
    if (key === 'south-america') return fit(d3.geoConicEqualArea().rotate([60, 0]).parallels([-5, -42]), grid(-82, -34, -56, 13));
    const all = { type: 'FeatureCollection', features: data.features };
    if (key === 'canada') return fit(d3.geoConicConformal().rotate([96, 0]).parallels([49, 77]), all);
    if (key === 'australia') return fit(d3.geoConicEqualArea().rotate([-134, 0]).parallels([-18, -36]), all);
    if (key === 'uk' || key === 'germany' || key === 'spain' || key === 'italy' || key === 'france' || key === 'brazil') return fit(d3.geoMercator(), all);
    if (key === 'china') return fit(d3.geoConicEqualArea().rotate([-105, 0]).parallels([25, 47]), all);
    if (key === 'argentina') return fit(d3.geoConicConformal().rotate([65, 0]).parallels([-25, -45]), all);
    if (key === 'south-korea' || key === 'portugal' || key === 'netherlands' || key === 'switzerland' || key === 'austria' || key === 'poland' || key === 'ireland' || key === 'new-zealand' || key === 'colombia' || key === 'south-africa') return fit(d3.geoMercator(), all);
    if (key === 'greece' || key === 'turkey' || key === 'peru' || key === 'chile') return fit(d3.geoMercator(), all);
    if (key === 'norway') return fit(d3.geoConicConformal().rotate([-15, 0]).parallels([60, 70]), all);
    if (['belgium', 'denmark', 'czech-republic', 'hungary', 'croatia', 'iceland', 'romania', 'thailand', 'ecuador'].includes(key)) return fit(d3.geoMercator(), all);
    if (['cuba', 'costa-rica', 'bolivia', 'malaysia'].includes(key)) return fit(d3.geoMercator(), all);
    if (key === 'finland') return fit(d3.geoConicConformal().rotate([-26, 0]).parallels([61, 68]), all);
    if (key === 'sweden') return fit(d3.geoConicConformal().rotate([-16, 0]).parallels([57, 67]), all);
    if (key === 'mexico') return fit(d3.geoConicConformal().rotate([102, 0]).parallels([17.5, 29.5]), all);
    // Japan's remote Pacific islands would shrink the main islands to a corner: frame Okinawa to Hokkaido.
    if (key === 'japan') return fit(d3.geoMercator(), grid(123, 146, 24, 45));
    if (key === 'oceania') return fit(d3.geoMercator().rotate([-165, 0]), grid(112, 232, -48, 16));
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
        stroke: T.line, 'stroke-width': state.region === 'us' || REGIONS[state.region].admin ? 0.9 : 0.5, 'fill-opacity': outside && state.region !== 'parks' ? 0.45 : null,
      }, g);
      if (interactive && !outside) { p.classList.add('tvm-shape'); if (f.id === hoverId) p.classList.add('is-hover'); }
    }
    // An inset (the Canary Islands, moved closer in the data) gets a dashed frame, like Alaska and Hawaii.
    for (const f of data.features) if (f.properties.inset) {
      const [[x0, y0], [x1, y1]] = path.bounds(f), m = 10;
      el('rect', { x: x0 - m, y: y0 - m, width: x1 - x0 + 2 * m, height: y1 - y0 + 2 * m, rx: 8, fill: 'none', stroke: T.muted, 'stroke-opacity': 0.6, 'stroke-dasharray': '4 4' }, g);
    }
    if (state.region === 'parks') drawParks(target, proj, T, interactive, W, H);
    else if (state.region !== 'us') drawSmall(target, path, proj, T, interactive);
    return [W, H];
  }
  // Countries too small to click at this scale (Vatican City, Malta, the island states of the Caribbean and
  // the Pacific) also get a dot, so every place in the list can be marked from the map too.
  function drawSmall(target, path, proj, T, interactive) {
    const g = el('g', {}, target);
    for (const f of data.list) {
      if (!f.geometry || path.area(f) > (state.region === 'world' ? 4 : 30)) continue;   // the world map only dots the tiniest
      const xy = proj(d3.geoCentroid(f)); if (!xy || !isFinite(xy[0])) continue;
      const [W, H] = REGIONS[state.region].size; if (xy[0] < 0 || xy[1] < 0 || xy[0] > W || xy[1] > H) continue;
      const s = statusOf(f.id);
      const c = el('circle', { cx: xy[0].toFixed(1), cy: xy[1].toFixed(1), r: state.region === 'world' ? 3.5 : 4.5, 'data-id': interactive ? f.id : null,
        fill: s === 'v' ? T.visited : s === 'w' ? T.want : T.land, stroke: T.muted, 'stroke-width': 1, 'stroke-opacity': 0.8 }, g);
      if (interactive) { c.classList.add('tvm-shape', 'tvm-park'); if (f.id === hoverId) c.classList.add('is-hover'); }
    }
  }
  // Parks are dots. AlbersUSA has no place for American Samoa or the US Virgin Islands, so those two sit in
  // labelled boxes in the open Atlantic east of the Carolinas, the way Alaska and Hawaii are inset on the left.
  const INSETS = { 'virgin-islands': [W => W - 143, H => H - 250, 'U.S. Virgin Islands'], 'american-samoa': [W => W - 143, H => H - 202, 'American Samoa'] };
  function drawParks(target, proj, T, interactive, W, H) {
    const g = el('g', {}, target);
    const r = 7.5;
    for (const f of data.list) {
      const p = f.park; let xy = proj([p.lon, p.lat]);
      if (!xy && INSETS[p.id]) {
        const [fx, fy, label] = INSETS[p.id]; xy = [fx(W), fy(H)];
        el('rect', { x: xy[0] - 18, y: xy[1] - 18, width: 160, height: 36, rx: 8, fill: 'none', stroke: T.muted, 'stroke-opacity': 0.5, 'stroke-dasharray': '3 3' }, g);
        const t = el('text', { x: xy[0] + 16, y: xy[1] + 5, fill: T.muted, 'font-family': "'Helvetica Neue', Arial, sans-serif", 'font-size': 13 }, g); t.textContent = label;
      }
      if (!xy) continue;
      const s = statusOf(f.id);
      const c = el('circle', {
        cx: xy[0].toFixed(1), cy: xy[1].toFixed(1), r, 'data-id': interactive ? f.id : null,
        fill: s === 'v' ? T.visited : s === 'w' ? T.want : T.bg, stroke: s ? T.line : T.muted, 'stroke-width': s ? 2 : 1.6,
      }, g);
      if (interactive) { c.classList.add('tvm-shape', 'tvm-park'); if (f.id === hoverId) c.classList.add('is-hover'); }
    }
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
    if (c.extra) bits.push(state.region === 'europe' ? '+ Kosovo' : `+ ${c.extra} more ${c.extra === 1 ? 'place' : 'places'}`);
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
      if (f.properties.sub) { const sm = document.createElement('small'); sm.textContent = f.properties.sub; b.querySelector('.tvm-name').appendChild(sm); }
      frag.appendChild(b);
    }
    listEl.appendChild(frag);
    $('#tvmListEmpty').hidden = items.length > 0;
    $('#tvmListNote').hidden = state.region === 'us' || state.region === 'parks' || (REGIONS[state.region].admin && !REGIONS[state.region].note);
    $('#tvmListNote').textContent = REGIONS[state.region].note ? REGIONS[state.region].note : state.region === 'europe'
      ? '* Kosovo can be marked, but the count follows the 46 countries most travel lists use.'
      : '* Territories and places with disputed status can be marked; they are counted on their own line, not in the total.';
  }
  listEl.addEventListener('click', e => { const b = e.target.closest('.tvm-item'); if (b) toggle(b.dataset.id); });
  $('#tvmSearch').addEventListener('input', renderList);

  /* ══════════════════════════════════════════════
     Map interaction
     ══════════════════════════════════════════════ */
  const tip = $('#tvmTip');
  svg.addEventListener('click', e => { const p = e.target.closest('[data-id]'); if (p) toggle(p.dataset.id); });
  svg.addEventListener('mousemove', e => {
    const p = e.target.closest('[data-id]');
    const id = p ? p.dataset.id : null;
    if (id !== hoverId) { $$('.tvm-shape.is-hover', svg).forEach(x => x.classList.remove('is-hover')); hoverId = id; if (p) p.classList.add('is-hover'); }
    if (p) {
      const s = statusOf(id);
      const it = data.byId.get(id).properties;
      tip.textContent = it.name + (it.sub ? ` · ${it.sub}` : '') + (s ? (s === 'v' ? ' · visited' : ' · want to go') : '');
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
    $('#tvmListHead').textContent = state.region === 'us' ? 'All 50 states' : state.region === 'parks' ? 'All 63 national parks' : state.region === 'world' ? 'Countries and territories' : R.admin ? `All ${R.total} ${R.unit}` : `Countries of ${R.label}`;
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
  const defaultTitle = () => state.region === 'us' ? 'States I’ve visited' : state.region === 'parks' ? 'National parks I’ve visited' : state.region === 'world' ? 'Countries I’ve visited' : REGIONS[state.region].admin ? `My ${REGIONS[state.region].label.replace(/^the /, '')} travel map` : `My ${REGIONS[state.region].label} travel map`;
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
