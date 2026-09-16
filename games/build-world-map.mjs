// Build the lobby world map for Arrow Atlas: every country as an SVG path in a 1000x520 box (Natural Earth
// projection, Antarctica dropped), plus a label point per country (centroid of its main landmass).
// Usage (from the repo root, one-off): npm i --no-save d3-geo topojson-client world-atlas && node games/build-world-map.mjs
// Then bump MAP_VERSION in js/arrow-atlas.js so edges drop the old file.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const d3 = require('d3-geo');
const topojson = require('topojson-client');
const atlas = require('world-atlas/countries-110m.json');
const atlas10 = require('world-atlas/countries-10m.json');
const SMALL = ['Andorra', 'Antigua and Barb.', 'Bahrain', 'Barbados', 'Cabo Verde', 'Comoros', 'Dominica', 'Grenada', 'Kiribati', 'Liechtenstein', 'Maldives', 'Malta', 'Marshall Is.', 'Mauritius', 'Micronesia', 'Monaco', 'Nauru', 'Palau', 'St. Kitts and Nevis', 'Saint Lucia', 'St. Vin. and Gren.', 'Samoa', 'San Marino', 'São Tomé and Principe', 'Seychelles', 'Singapore', 'Tonga', 'Tuvalu', 'Vatican'];
const OUT = new URL('./data/world-map.json', import.meta.url).pathname;
const W = 1000, H = 520;
const feats110 = topojson.feature(atlas, atlas.objects.countries).features.filter(f => f.properties.name !== 'Antarctica');
const have = new Set(feats110.map(f => f.properties.name));
const feats = feats110.concat(topojson.feature(atlas10, atlas10.objects.countries).features.filter(f => SMALL.includes(f.properties.name) && !have.has(f.properties.name)));
const proj = d3.geoNaturalEarth1().fitSize([W, H], { type: 'FeatureCollection', features: feats });
const path = d3.geoPath(proj);
const r1 = v => Math.round(v * 10) / 10;
const idOf = f => f.id != null ? String(f.id).padStart(3, '0') : 'n:' + f.properties.name.toLowerCase().replace(/[^a-z]+/g, '-');
function mainPoly(f) {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  const areas = polys.map(c => d3.geoArea({ type: 'Polygon', coordinates: c }));
  return { type: 'Polygon', coordinates: polys[areas.indexOf(Math.max(...areas))] };
}
const countries = feats.map(f => {
  let d = path(f) || '';
  const [cx, cy] = path.centroid(mainPoly(f));
  // a state too small to show at this size becomes a small dot at its centre, so it can still be tapped and marked
  const [[x0, y0], [x1, y1]] = d ? path.bounds(f) : [[0, 0], [0, 0]];
  if (!d || (x1 - x0 < 3 && y1 - y0 < 3)) { const r = 2.2; d = `M${r1(cx - r)} ${r1(cy)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`; }
  d = d.replace(/-?\d+\.\d+/g, m => String(r1(+m)));
  return { id: idOf(f), n: f.properties.name, d, cx: r1(cx), cy: r1(cy) };
}).filter(c => c.d);
fs.writeFileSync(OUT, JSON.stringify({ version: 2, w: W, h: H, countries }));
console.log(countries.length, 'countries, bytes', fs.statSync(OUT).size);
