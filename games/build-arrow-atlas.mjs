// Build "Arrow Atlas" level data: for each country, a grid mask (which cells are land) at
// five board sizes, plus the country outline in the same coordinates for the reveal.
// Usage (from the repo root, one-off):
//   npm i --no-save d3-geo topojson-client world-atlas
//   curl -L -o ne50.geojson https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson
//   node games/build-arrow-atlas.mjs ne50.geojson
// Then bump DATA_VERSION in js/arrow-atlas.js so edges drop the old file.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const d3 = require('d3-geo');
const topojson = require('topojson-client');
const atlas = require('world-atlas/countries-110m.json');
const ne = JSON.parse(fs.readFileSync(process.argv[2] || 'ne_50m_admin_0_countries.geojson', 'utf8'));
const OUT = new URL('./data/arrow-atlas.json', import.meta.url).pathname;

const TARGETS = [140, 380, 620, 880, 1150]; // land cells per difficulty tier (dense, maze-like boards: ~40 to ~250 arrows)
const MAX_DIM = 46;                        // widest/tallest board in cells for roundish countries
const MAX_TALL = 64, MAX_WIDE = 56;        // long side for tall (Chile, Norway) and wide (Cuba, Malaysia) shapes; phones are tall, so tall boards get more room
const REF = 100;                       // outline paths are stored in a REF×REF box; each tier stores k = cells per unit

// World Tour order: recognisable shapes first, then the rest by area.
const TOUR = [
  'Italy', 'India', 'Australia', 'Brazil', 'Bangladesh', 'Japan', 'United Kingdom', 'United States', 'China', 'Egypt',
  'Mexico', 'Argentina', 'Canada', 'Russia', 'Turkey', 'France', 'Spain', 'Germany', 'Saudi Arabia', 'Indonesia',
  'South Africa', 'Iran', 'Kazakhstan', 'Algeria', 'DR Congo', 'Sudan', 'Libya', 'Mongolia', 'Peru', 'Chad',
  'Niger', 'Angola', 'Mali', 'Colombia', 'Ethiopia', 'Bolivia', 'Mauritania', 'Tanzania', 'Nigeria', 'Venezuela',
  'Pakistan', 'Namibia', 'Mozambique', 'Chile', 'Zambia', 'Myanmar', 'Afghanistan', 'South Sudan', 'Somalia', 'Central African Republic',
  'Ukraine', 'Madagascar', 'Botswana', 'Kenya', 'Yemen', 'Thailand', 'Sweden', 'Norway', 'Poland', 'Vietnam',
  'Philippines', 'Malaysia', 'New Zealand', 'Nepal', 'Sri Lanka', 'Greece', 'Portugal', 'South Korea', 'Cuba', 'Iceland',
];
const CAPITALS = {
  Italy: 'Rome', India: 'New Delhi', Australia: 'Canberra', Brazil: 'Brasília', Bangladesh: 'Dhaka', Japan: 'Tokyo', 'United Kingdom': 'London', 'United States': 'Washington, D.C.', China: 'Beijing', Egypt: 'Cairo',
  Mexico: 'Mexico City', Argentina: 'Buenos Aires', Canada: 'Ottawa', Russia: 'Moscow', Turkey: 'Ankara', France: 'Paris', Spain: 'Madrid', Germany: 'Berlin', 'Saudi Arabia': 'Riyadh', Indonesia: 'Jakarta',
  'South Africa': 'Pretoria', Iran: 'Tehran', Kazakhstan: 'Astana', Algeria: 'Algiers', 'DR Congo': 'Kinshasa', Sudan: 'Khartoum', Libya: 'Tripoli', Mongolia: 'Ulaanbaatar', Peru: 'Lima', Chad: "N'Djamena",
  Niger: 'Niamey', Angola: 'Luanda', Mali: 'Bamako', Colombia: 'Bogotá', Ethiopia: 'Addis Ababa', Bolivia: 'Sucre', Mauritania: 'Nouakchott', Tanzania: 'Dodoma', Nigeria: 'Abuja', Venezuela: 'Caracas',
  Pakistan: 'Islamabad', Namibia: 'Windhoek', Mozambique: 'Maputo', Chile: 'Santiago', Zambia: 'Lusaka', Myanmar: 'Naypyidaw', Afghanistan: 'Kabul', 'South Sudan': 'Juba', Somalia: 'Mogadishu', 'Central African Republic': 'Bangui',
  Ukraine: 'Kyiv', Madagascar: 'Antananarivo', Botswana: 'Gaborone', Kenya: 'Nairobi', Yemen: "Sana'a", Thailand: 'Bangkok', Sweden: 'Stockholm', Norway: 'Oslo', Poland: 'Warsaw', Vietnam: 'Hanoi',
  Philippines: 'Manila', Malaysia: 'Kuala Lumpur', 'New Zealand': 'Wellington', Nepal: 'Kathmandu', 'Sri Lanka': 'Sri Jayawardenepura Kotte', Greece: 'Athens', Portugal: 'Lisbon', 'South Korea': 'Seoul', Cuba: 'Havana', Iceland: 'Reykjavík',
};
// world-atlas names that differ from the tour names
const ATLAS_NAME = { 'DR Congo': 'Dem. Rep. Congo', 'Central African Republic': 'Central African Rep.', 'South Sudan': 'S. Sudan', 'United States': 'United States of America' };

const feats = topojson.feature(atlas, atlas.objects.countries).features;
const neByIso = new Map(ne.features.map(f => [f.properties.ISO_N3, f.properties]));
const neByName = new Map(ne.features.map(f => [f.properties.NAME, f.properties]));
const r1 = v => Math.round(v * 10) / 10;

// Keep the main polygon and anything within 45° of it (Alaska stays, French Guiana and Hawaii go).
function mainland(f) {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  const areas = polys.map(c => d3.geoArea({ type: 'Polygon', coordinates: c }));
  const big = polys[areas.indexOf(Math.max(...areas))];
  const c0 = d3.geoCentroid({ type: 'Polygon', coordinates: big });
  const keep = polys.filter(c => d3.geoDistance(c0, d3.geoCentroid({ type: 'Polygon', coordinates: c })) < 45 * Math.PI / 180);
  return { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: keep } };
}

// Rasterise at k cells per REF unit (the outline is fitted into a REF×REF box once).
function rasteriseAt(feature, proj, k) {
  const S = Math.ceil(REF * k) + 1;
  const cells = [];
  for (let r = 0; r < S; r++) { cells.push([]); for (let c = 0; c < S; c++) cells[r].push(d3.geoContains(feature, proj.invert([(c + 0.5) / k, (r + 0.5) / k])) ? 1 : 0); }
  // drop connected components under 4 cells (stray islands make unfair one-cell puzzles)
  const seen = cells.map(row => row.map(() => false));
  for (let r = 0; r < S; r++) for (let c = 0; c < S; c++) {
    if (!cells[r][c] || seen[r][c]) continue;
    const comp = []; const stack = [[r, c]]; seen[r][c] = true;
    while (stack.length) { const [y, x] = stack.pop(); comp.push([y, x]); for (const [dy, dx] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const ny = y + dy, nx = x + dx; if (ny >= 0 && nx >= 0 && ny < S && nx < S && cells[ny][nx] && !seen[ny][nx]) { seen[ny][nx] = true; stack.push([ny, nx]); } } }
    if (comp.length < 4) for (const [y, x] of comp) cells[y][x] = 0;
  }
  let r0 = S, r1_ = -1, c0 = S, c1 = -1;
  for (let r = 0; r < S; r++) for (let c = 0; c < S; c++) if (cells[r][c]) { r0 = Math.min(r0, r); r1_ = Math.max(r1_, r); c0 = Math.min(c0, c); c1 = Math.max(c1, c); }
  if (r1_ < 0) return { k, x: 0, y: 0, rows: [], count: 0, w: 0, h: 0 };
  const rows = cells.slice(r0, r1_ + 1).map(row => row.slice(c0, c1 + 1).join(''));
  return { k: Math.round(k * 1000) / 1000, x: c0, y: r0, rows, count: rows.join('').split('1').length - 1, w: rows[0].length, h: rows.length };
}
// Find the scale whose land-cell count is closest to the target, keeping the board within the dimension caps.
// Elongated countries would otherwise cap out at ~130 cells: their long side is allowed extra room.
function rasteriseTarget(feature, proj, target) {
  const probe = rasteriseAt(feature, proj, 0.3);
  const tall = probe.h > probe.w * 1.5, wide = probe.w > probe.h * 1.5;
  const maxW = wide ? MAX_WIDE : MAX_DIM, maxH = tall ? MAX_TALL : MAX_DIM;
  let lo = 0.06, hi = Math.max(maxW, maxH) / REF, best = null; // hi keeps the long side within the cap
  for (let i = 0; i < 18; i++) {
    const k = (lo + hi) / 2; const m = rasteriseAt(feature, proj, k);
    if (m.count < target) lo = k; else hi = k;
    if (m.w <= maxW && m.h <= maxH && (!best || Math.abs(m.count - target) < Math.abs(best.count - target))) best = m;
  }
  return best;
}
const levels = [];
for (const name of TOUR) {
  const f = feats.find(x => x.properties.name === (ATLAS_NAME[name] || name));
  if (!f) throw new Error('not in world-atlas: ' + name);
  const props = neByIso.get(String(f.id).padStart(3, '0')) || neByName.get(name) || {};
  const main = mainland(f);
  const centre = d3.geoCentroid(main);
  const proj = d3.geoAzimuthalEqualArea().rotate([-centre[0], -centre[1]]);
  proj.fitExtent([[0, 0], [REF, REF]], main);
  const d = d3.geoPath(proj)(main).replace(/-?\d+\.\d+/g, m => String(r1(+m)));
  const tiers = TARGETS.map(t => rasteriseTarget(main, proj, t));
  levels.push({ id: String(f.id).padStart(3, '0'), name, cap: CAPITALS[name], pop: props.POP_EST || null, cont: props.CONTINENT || '', sub: props.SUBREGION || '', d, tiers });
}
fs.writeFileSync(OUT, JSON.stringify({ version: 1, targets: TARGETS, ref: REF, levels }));
console.table(levels.map(l => ({ name: l.name, cont: l.cont, t0: `${l.tiers[0].count} ${l.tiers[0].w}x${l.tiers[0].h}`, t2: `${l.tiers[2].count} ${l.tiers[2].w}x${l.tiers[2].h}`, t4: `${l.tiers[4].count} ${l.tiers[4].w}x${l.tiers[4].h}` })));
console.log('bytes', fs.statSync(OUT).size);
