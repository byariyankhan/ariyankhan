// Build "Piece the World" level data: projected piece paths per continent + a world level of merged continents.
// Usage (from the repo root, one-off):
//   npm i --no-save d3-geo d3-geo-projection topojson-client world-atlas
//   curl -L -o ne50.geojson https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson
//   node games/build-data.mjs ne50.geojson
// Then bump DATA_VERSION in js/piece-the-world.js (and the preload in piece-the-world.html) so edges drop the old files.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const d3 = { ...require('d3-geo'), ...require('d3-geo-projection') };
const topojson = require('topojson-client');
const ne = JSON.parse(fs.readFileSync(process.argv[2] || 'ne_50m_admin_0_countries.geojson', 'utf8'));
const atlas = require('world-atlas/countries-110m.json');
const OUT = new URL('./data/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });

const NAME_FIX = { 'W. Sahara': 'Western Sahara', 'Dem. Rep. Congo': 'DR Congo', 'Dominican Rep.': 'Dominican Republic', 'Central African Rep.': 'Central African Republic', 'Eq. Guinea': 'Equatorial Guinea', 'Bosnia and Herz.': 'Bosnia and Herzegovina', 'S. Sudan': 'South Sudan', 'Solomon Is.': 'Solomon Islands', 'eSwatini': 'Eswatini', 'Macedonia': 'North Macedonia', 'United States of America': 'United States', 'Antigua and Barb.': 'Antigua and Barbuda', 'St. Vin. and Gren.': 'St. Vincent and the Grenadines', 'N. Cyprus': 'Northern Cyprus', 'Marshall Is.': 'Marshall Islands', 'St. Kitts and Nevis': 'Saint Kitts and Nevis', 'Cabo Verde': 'Cabo Verde', 'São Tomé and Principe': 'São Tomé and Príncipe', 'Timor-Leste': 'Timor-Leste', 'Côte d\'Ivoire': 'Côte d\'Ivoire', 'Fr. S. Antarctic Lands': 'French Southern Lands', 'Falkland Is.': 'Falkland Islands', 'Faeroe Is.': 'Faroe Islands', 'Br. Indian Ocean Ter.': 'British Indian Ocean Territory' };
const TYPES = new Set(['Sovereign country', 'Sovereignty', 'Country']);      // pieces = real countries (+ Greenland-type "Country")
const EXTRA = new Set(['Kosovo', 'Taiwan', 'Palestine', 'Western Sahara', 'Somaliland', 'Northern Cyprus', 'Greenland', 'Puerto Rico', 'Hong Kong', 'New Caledonia', 'French Polynesia']);
// Levels: lon/lat box for framing (clockwise ring built below) + azimuthal centre
const LEVELS = {
  'south-america': { name: 'South America', cont: 'South America', box: [-84, -57, -33, 14], center: [-60, -20] },
  'north-america': { name: 'North America', cont: 'North America', box: [-170, 6, -50, 84], center: [-100, 45] },
  europe:          { name: 'Europe', cont: 'Europe', box: [-25, 34, 45, 72], center: [15, 54] },
  africa:          { name: 'Africa', cont: 'Africa', box: [-20, -36, 55, 38], center: [18, 2] },
  asia:            { name: 'Asia', cont: 'Asia', box: [25, -11, 150, 60], center: [90, 30] },
  oceania:         { name: 'Oceania', cont: 'Oceania', box: [110, -50, 182, 0], center: [145, -25] },
};
const W = 1000;
function ring([w, s, e, n]) { const p = []; for (let y = s; y < n; y += 1) p.push([w, y]); for (let x = w; x < e; x += 1) p.push([x, n]); for (let y = n; y > s; y -= 1) p.push([e, y]); for (let x = e; x > w; x -= 1) p.push([x, s]); p.push([w, s]); return { type: 'Polygon', coordinates: [p] }; }
const r1 = v => Math.round(v * 10) / 10;
function roundPath(d) { return d.replace(/-?\d+\.\d+/g, m => String(r1(+m))); }
const summary = [];

for (const [id, L] of Object.entries(LEVELS)) {
  const feats = ne.features.filter(f => f.properties.CONTINENT === L.cont && (TYPES.has(f.properties.TYPE) || EXTRA.has(f.properties.NAME)));
  const proj = d3.geoAzimuthalEqualArea().rotate([-L.center[0], -L.center[1]]);
  // fit to box → derive board height from projected box aspect
  proj.fitWidth(W, ring(L.box));
  const b = d3.geoPath(proj).bounds(ring(L.box));
  const H = Math.round(b[1][1] - b[0][1]);
  proj.fitExtent([[0, 0], [W, H]], ring(L.box));
  proj.clipExtent([[0, 0], [W, H]]);
  const path = d3.geoPath(proj);
  const pieces = [], auto = [];
  for (const f of feats) {
    const d = path(f); if (!d) continue;
    // largest visible polygon for anchor/centroid
    let best = null, bestA = -1; const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const c of polys) { const a = path.area({ type: 'Polygon', coordinates: c }); if (a > bestA) { bestA = a; best = c; } }
    const area = path.area(f); const c = path.centroid({ type: 'Polygon', coordinates: best });
    if (!isFinite(c[0])) continue;
    const bb = path.bounds(f);
    const iso = f.properties.ISO_N3;
    const piece = { id: iso && iso !== '-99' ? iso : (NAME_FIX[f.properties.NAME] || f.properties.NAME).toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: NAME_FIX[f.properties.NAME] || f.properties.NAME, d: roundPath(d), cx: r1(c[0]), cy: r1(c[1]), area: Math.round(area), bbox: bb.flat().map(r1), sub: f.properties.SUBREGION, pop: f.properties.POP_EST };
    if (area < 120 || (bb[1][0] - bb[0][0]) < 14 || (bb[1][1] - bb[0][1]) < 14) auto.push(piece); else pieces.push(piece);
  }
  pieces.sort((a, b) => b.area - a.area);
  const level = { id, name: L.name, board: { w: W, h: H }, pieces, auto };
  fs.writeFileSync(`${OUT}/${id}.json`, JSON.stringify(level));
  summary.push({ id, pieces: pieces.length, auto: auto.map(a => a.name), bytes: fs.statSync(`${OUT}/${id}.json`).size, h: H });
}

// World level: continents merged from world-atlas 110m by NE CONTINENT (join on ISO numeric id)
const contOf = new Map(ne.features.map(f => [f.properties.ISO_N3, f.properties.CONTINENT]));
const geoms = atlas.objects.countries.geometries;
const groups = {};
for (const g of geoms) { const c = contOf.get(String(g.id).padStart(3, '0')); if (!c || c === 'Seven seas (open ocean)') continue; (groups[c] ??= []).push(g); }
const proj = d3.geoEqualEarth(); proj.fitWidth(W, { type: 'Sphere' }); const wb = d3.geoPath(proj).bounds({ type: 'Sphere' }); const WH = Math.round(wb[1][1] - wb[0][1]); proj.fitExtent([[0, 0], [W, WH]], { type: 'Sphere' });
const wpath = d3.geoPath(proj);
const CENTERS = { Africa: [20, 5], Asia: [90, 40], Europe: [15, 52], 'North America': [-100, 45], 'South America': [-60, -15], Oceania: [140, -25], Antarctica: [0, -85] };
const wpieces = Object.entries(groups).map(([c, gs]) => { const merged = topojson.merge(atlas, gs); const d = wpath(merged); const cen = wpath.centroid(merged); const lab = CENTERS[c] ? proj(CENTERS[c]) : cen; return { id: c.toLowerCase().replace(/\s+/g, '-'), name: c, d: roundPath(d), cx: r1(lab[0]), cy: r1(lab[1]), area: Math.round(wpath.area(merged)), bbox: wpath.bounds(merged).flat().map(r1), sub: `${gs.length} countries`, pop: null }; }).sort((a, b) => b.area - a.area);
fs.writeFileSync(`${OUT}/world.json`, JSON.stringify({ id: 'world', name: 'World', board: { w: W, h: WH }, sphere: roundPath(wpath({ type: 'Sphere' })), pieces: wpieces, auto: [] }));
summary.push({ id: 'world', pieces: wpieces.length, auto: [], bytes: fs.statSync(`${OUT}/world.json`).size, h: WH });
console.table(summary.map(s => ({ ...s, auto: s.auto.join(', ').slice(0, 90) })));
for (const [id] of Object.entries(LEVELS)) { const l = JSON.parse(fs.readFileSync(`${OUT}/${id}.json`)); console.log(id, '→', l.pieces.map(p => p.name).join(', ')); }
