// Build "Arrow Atlas" level data: for each country its outline (in a REF×REF box) and, per difficulty tier, the
// scale k (cells per unit) at which the game's own rasteriser yields about TARGETS[t] land cells. The grid masks
// themselves are rasterised in the browser with the same code (extracted from js/arrow-atlas.js below), so the
// data stays small and every player gets the same board.
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
const js = fs.readFileSync(new URL('../js/arrow-atlas.js', import.meta.url), 'utf8');
const grab = re => { const m = js.match(re); if (!m) throw new Error('could not find ' + re); return m[0]; };
const { rasterise, REF } = new Function([grab(/const REF = \d+;/), grab(/function parsePath\(d\) \{[\s\S]*?\n  \}\n/), grab(/function insidePath\([\s\S]*?\n  \}\n/), grab(/function rasterise\([\s\S]*?\n  \}\n/)].join('\n') + '\nreturn { rasterise, REF };')();

const TARGETS = [110, 240, 400, 540, 680]; // land cells per difficulty tier: boards ~28 cells across, like the reference apps (thick lines, long snakes)
// Board caps per tier (cells). Easy to Hard keep ~12 px cells on a phone; Expert and Master may grow so their
// targets are actually reached (with one cap for all, Master boards were no bigger than Hard ones).
const MAX_DIM_OF = [32, 32, 32, 36, 40];     // widest/tallest board for roundish countries
const MAX_TALL_OF = [46, 46, 46, 50, 54];    // long side for tall shapes (Chile, Norway)
const MAX_WIDE_OF = [38, 38, 38, 42, 46];    // long side for wide shapes (Cuba, Malaysia)

// World Tour order: the original 70 (recognisable shapes first, then by area), then every other country by population.
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
  Uganda: 'Kampala', Iraq: 'Baghdad', Morocco: 'Rabat', Uzbekistan: 'Tashkent', Ghana: 'Accra', Cameroon: 'Yaoundé', "Côte d'Ivoire": 'Yamoussoukro', 'North Korea': 'Pyongyang', Taiwan: 'Taipei', 'Burkina Faso': 'Ouagadougou',
  Romania: 'Bucharest', Malawi: 'Lilongwe', Ecuador: 'Quito', Netherlands: 'Amsterdam', Syria: 'Damascus', Guatemala: 'Guatemala City', Cambodia: 'Phnom Penh', Senegal: 'Dakar', Zimbabwe: 'Harare', Guinea: 'Conakry',
  Rwanda: 'Kigali', Benin: 'Porto-Novo', Tunisia: 'Tunis', Burundi: 'Gitega', Belgium: 'Brussels', Haiti: 'Port-au-Prince', 'Dominican Republic': 'Santo Domingo', Czechia: 'Prague', Jordan: 'Amman', Azerbaijan: 'Baku',
  'United Arab Emirates': 'Abu Dhabi', Hungary: 'Budapest', Honduras: 'Tegucigalpa', Belarus: 'Minsk', Tajikistan: 'Dushanbe', Israel: 'Jerusalem', Austria: 'Vienna', 'Papua New Guinea': 'Port Moresby', Switzerland: 'Bern', Togo: 'Lomé',
  'Sierra Leone': 'Freetown', Laos: 'Vientiane', Paraguay: 'Asunción', Bulgaria: 'Sofia', Serbia: 'Belgrade', Lebanon: 'Beirut', Nicaragua: 'Managua', Kyrgyzstan: 'Bishkek', 'El Salvador': 'San Salvador', Eritrea: 'Asmara',
  Turkmenistan: 'Ashgabat', Denmark: 'Copenhagen', Finland: 'Helsinki', Slovakia: 'Bratislava', 'Republic of the Congo': 'Brazzaville', 'Costa Rica': 'San José', Oman: 'Muscat', Ireland: 'Dublin', Liberia: 'Monrovia', Palestine: 'Ramallah',
  Panama: 'Panama City', Kuwait: 'Kuwait City', Croatia: 'Zagreb', Georgia: 'Tbilisi', Uruguay: 'Montevideo', 'Bosnia and Herzegovina': 'Sarajevo', Armenia: 'Yerevan', Jamaica: 'Kingston', Albania: 'Tirana', Qatar: 'Doha',
  Lithuania: 'Vilnius', Moldova: 'Chișinău', Gambia: 'Banjul', Gabon: 'Libreville', Lesotho: 'Maseru', Slovenia: 'Ljubljana', 'North Macedonia': 'Skopje', 'Guinea-Bissau': 'Bissau', Latvia: 'Riga', 'Trinidad and Tobago': 'Port of Spain',
  'Equatorial Guinea': 'Malabo', Estonia: 'Tallinn', 'Timor-Leste': 'Dili', Cyprus: 'Nicosia', Eswatini: 'Mbabane', Djibouti: 'Djibouti', Fiji: 'Suva', Guyana: 'Georgetown', Bhutan: 'Thimphu', 'Solomon Islands': 'Honiara',
  Montenegro: 'Podgorica', Luxembourg: 'Luxembourg', Suriname: 'Paramaribo', Brunei: 'Bandar Seri Begawan', Belize: 'Belmopan', Bahamas: 'Nassau', Vanuatu: 'Port Vila', Kosovo: 'Pristina',
};
// world-atlas names that differ from the display names
const ATLAS_NAME = { 'DR Congo': 'Dem. Rep. Congo', 'Central African Republic': 'Central African Rep.', 'South Sudan': 'S. Sudan', 'United States': 'United States of America', 'Dominican Republic': 'Dominican Rep.', 'Bosnia and Herzegovina': 'Bosnia and Herz.', 'North Macedonia': 'Macedonia', 'Equatorial Guinea': 'Eq. Guinea', 'Solomon Islands': 'Solomon Is.', Eswatini: 'eSwatini', 'Republic of the Congo': 'Congo' };
const DISPLAY = Object.fromEntries(Object.entries(ATLAS_NAME).map(([a, b]) => [b, a]));
// dependencies, disputed or uninhabited areas that are not levels
const SKIP = new Set(['Antarctica', 'Puerto Rico', 'W. Sahara', 'New Caledonia', 'Greenland', 'Falkland Is.', 'Fr. S. Antarctic Lands', 'N. Cyprus', 'Somaliland']);

const feats = topojson.feature(atlas, atlas.objects.countries).features;
const neByIso = new Map(ne.features.map(f => [f.properties.ISO_N3, f.properties]));
const neByName = new Map(ne.features.map(f => [f.properties.NAME, f.properties]));
const propsOf = f => neByIso.get(f.id != null ? String(f.id).padStart(3, '0') : '') || neByName.get(f.properties.name) || {};
const r1 = v => Math.round(v * 10) / 10;
const idOf = f => f.id != null ? String(f.id).padStart(3, '0') : 'n:' + f.properties.name.toLowerCase().replace(/[^a-z]+/g, '-');   // stable id for features world-atlas leaves without one (Kosovo)

// Keep the main polygon and anything within 45° of it (Alaska stays, French Guiana and Hawaii go).
function mainland(f) {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  const areas = polys.map(c => d3.geoArea({ type: 'Polygon', coordinates: c }));
  const big = polys[areas.indexOf(Math.max(...areas))];
  const c0 = d3.geoCentroid({ type: 'Polygon', coordinates: big });
  const keep = polys.filter(c => d3.geoDistance(c0, d3.geoCentroid({ type: 'Polygon', coordinates: c })) < 45 * Math.PI / 180);
  return { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: keep } };
}
// Find the scale whose land-cell count is closest to the target, keeping the board within the dimension caps.
// Elongated countries would otherwise cap out at ~130 cells: their long side is allowed extra room.
function scaleFor(d, target, tier) {
  const probe = rasterise(d, 0.3);
  const tall = probe.h > probe.w * 1.5, wide = probe.w > probe.h * 1.5;
  const maxW = wide ? MAX_WIDE_OF[tier] : MAX_DIM_OF[tier], maxH = tall ? MAX_TALL_OF[tier] : MAX_DIM_OF[tier];
  let lo = 0.06, hi = Math.max(maxW, maxH) / REF, best = null;
  for (let i = 0; i < 18; i++) {
    const k = Math.round((lo + hi) / 2 * 1000) / 1000; const m = rasterise(d, k);
    if (m.count < target) lo = k; else hi = k;
    if (m.w <= maxW && m.h <= maxH && (!best || Math.abs(m.count - target) < Math.abs(best.count - target))) best = m;
    if (hi - lo < 0.0015) break;
  }
  return best;
}
const inTour = new Set(TOUR.map(n => ATLAS_NAME[n] || n));
const rest = feats.filter(f => !inTour.has(f.properties.name) && !SKIP.has(f.properties.name)).sort((a, b) => (propsOf(b).POP_EST || 0) - (propsOf(a).POP_EST || 0)).map(f => DISPLAY[f.properties.name] || f.properties.name);
const order = [...TOUR, ...rest];
const levels = [];
for (const name of order) {
  const f = feats.find(x => x.properties.name === (ATLAS_NAME[name] || name));
  if (!f) throw new Error('not in world-atlas: ' + name);
  if (!CAPITALS[name]) throw new Error('no capital for ' + name);
  const props = propsOf(f);
  const main = mainland(f);
  const centre = d3.geoCentroid(main);
  const proj = d3.geoAzimuthalEqualArea().rotate([-centre[0], -centre[1]]);
  proj.fitExtent([[0, 0], [REF, REF]], main);
  const d = d3.geoPath(proj)(main).replace(/-?\d+\.\d+/g, m => String(r1(+m)));
  const masks = TARGETS.map((t, tier) => scaleFor(d, t, tier));
  levels.push({ id: idOf(f), name, cap: CAPITALS[name], pop: props.POP_EST || null, cont: props.CONTINENT || '', sub: props.SUBREGION || '', d, k: masks.map(m => m.k), _masks: masks });
}
fs.writeFileSync(OUT, JSON.stringify({ version: 2, targets: TARGETS, ref: REF, levels: levels.map(({ _masks, ...L }) => L) }));
console.table(levels.map(l => ({ name: l.name, cont: l.cont, t0: `${l._masks[0].count} ${l._masks[0].w}x${l._masks[0].h}`, t2: `${l._masks[2].count} ${l._masks[2].w}x${l._masks[2].h}`, t4: `${l._masks[4].count} ${l._masks[4].w}x${l._masks[4].h}` })));
console.log(levels.length, 'levels, bytes', fs.statSync(OUT).size);
