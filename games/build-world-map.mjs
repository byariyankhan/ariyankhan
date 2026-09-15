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
const OUT = new URL('./data/world-map.json', import.meta.url).pathname;
const W = 1000, H = 520;
const feats = topojson.feature(atlas, atlas.objects.countries).features.filter(f => f.properties.name !== 'Antarctica');
const proj = d3.geoNaturalEarth1().fitSize([W, H], { type: 'FeatureCollection', features: feats });
const path = d3.geoPath(proj);
const r1 = v => Math.round(v * 10) / 10;
function mainPoly(f) {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  const areas = polys.map(c => d3.geoArea({ type: 'Polygon', coordinates: c }));
  return { type: 'Polygon', coordinates: polys[areas.indexOf(Math.max(...areas))] };
}
const countries = feats.map(f => {
  const d = path(f).replace(/-?\d+\.\d+/g, m => String(r1(+m)));
  const [cx, cy] = path.centroid(mainPoly(f));
  return { id: String(f.id).padStart(3, '0'), n: f.properties.name, d, cx: r1(cx), cy: r1(cy) };
}).filter(c => c.d);
fs.writeFileSync(OUT, JSON.stringify({ version: 1, w: W, h: H, countries }));
console.log(countries.length, 'countries, bytes', fs.statSync(OUT).size);
