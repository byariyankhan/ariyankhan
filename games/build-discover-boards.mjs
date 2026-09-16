// Build the discovery boards for Arrow Atlas: after a country's outline the player clears a board shaped like
// something a traveller would find there (its animal, its bird or a landmark). Shapes are Twemoji glyphs
// (graphics CC-BY 4.0, https://github.com/twitter/twemoji) traced to a single outline with potrace, scaled into
// the same REF box as the country outlines and flattened to straight segments (M/L/Z only, the one path form the
// game's parser reads), so the game's rasteriser and generator need no changes. A few shapes that no glyph
// carries well (the pyramids) are drawn by hand in CUSTOM.
// Usage (from the repo root, one-off): npm i --no-save sharp potrace @twemoji/svg && node games/build-discover-boards.mjs
// Then bump DISCB_VERSION in js/arrow-atlas.js so edges drop the old file.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require('sharp'); const potrace = require('potrace');
const TW = new URL('../' + (process.env.TWEMOJI_DIR || 'node_modules/@twemoji/svg/'), import.meta.url).pathname;
const disc = JSON.parse(fs.readFileSync(new URL('./data/discover.json', import.meta.url), 'utf8')).items;
const levels = JSON.parse(fs.readFileSync(new URL('./data/arrow-atlas.json', import.meta.url), 'utf8')).levels;
const OUT = new URL('./data/discover-boards.json', import.meta.url).pathname;
const js = fs.readFileSync(new URL('../js/arrow-atlas.js', import.meta.url), 'utf8');
const grab = re => { const m = js.match(re); if (!m) throw new Error('could not find ' + re); return m[0]; };
const { rasterise, REF } = new Function([grab(/const REF = \d+;/), grab(/function parsePath\(d\) \{[\s\S]*?\n  \}\n/), grab(/function insidePath\([\s\S]*?\n  \}\n/), grab(/function rasterise\([\s\S]*?\n  \}\n/)].join('\n') + '\nreturn { rasterise, REF };')();
const TARGETS = [110, 240, 400, 700, 900], MAX_DIM_OF = [32, 32, 32, 40, 44], MAX_TALL_OF = [46, 46, 46, 54, 58], MAX_WIDE_OF = [38, 38, 38, 46, 50];

// Which glyph stands for a find: ordered keyword rules over the discovery text (first match wins)
const RULES = [
  ['tiger', '1f405'], ['leopard', '1f406'], ['cheetah', '1f406'], ['jaguar', '1f406'], ['ocelot', '1f406'], ['lynx', '1f406'],
  ['elephant', '1f418'], ['rhino', '1f98f'], ['hippo', '1f99b'], ['dromedary', '1f42a'], ['camel', '1f42a'], ['giraffe', '1f992'], ['okapi', '1f992'],
  ['kangaroo', '1f998'], ['gorilla', '1f98d'], ['orangutan', '1f9a7'], ['chimpanzee', '1f412'], ['monkey', '1f412'], ['macaque', '1f412'], ['mandrill', '1f412'], ['lemur', '1f412'],
  ['crocodile', '1f40a'], ['tortoise', '1f422'], ['turtle', '1f422'], ['iguana', '1f98e'], ['lizard', '1f98e'], ['dragon', '1f409'], ['boa', '1f40d'], ['snake', '1f40d'],
  ['whale shark', '1f988'], ['shark', '1f988'], ['whale', '1f40b'], ['dolphin', '1f42c'], ['marlin', '1f41f'], ['coelacanth', '1f41f'],
  ['flamingo', '1f9a9'], ['peafowl', '1f99a'], ['peacock', '1f99a'], ['pheasant', '1f99a'], ['monal', '1f99a'], ['quetzal', '1f99a'], ['junglefowl', '1f413'], ['rooster', '1f413'],
  ['parrot', '1f99c'], ['macaw', '1f99c'], ['amazon', '1f99c'], ['lory', '1f99c'], ['lorikeet', '1f99c'], ['penguin', '1f427'], ['dove', '1f54a'], ['pigeon', '1f54a'], ['dodo', '1f9a4'],
  ['eagle', '1f985'], ['condor', '1f985'], ['vulture', '1f985'], ['falcon', '1f985'], ['hawk', '1f985'], ['osprey', '1f985'], ['kestrel', '1f985'],
  ['swan', '1f9a2'], ['duck', '1f986'], ['owl', '1f989'],
  ['sloth', '1f9a5'], ['otter', '1f9a6'], ['beaver', '1f9ab'], ['bison', '1f9ac'], ['aurochs', '1f402'], ['bull', '1f402'], ['ox', '1f402'], ['water buffalo', '1f403'], ['carabao', '1f403'], ['buffalo', '1f403'], ['takin', '1f403'], ['kouprey', '1f403'], ['cow', '1f404'],
  ['ibex', '1f410'], ['chamois', '1f410'], ['tur', '1f410'], ['markhor', '1f410'], ['goat', '1f410'], ['mouflon', '1f40f'],
  ['deer', '1f98c'], ['huemul', '1f98c'], ['antelope', '1f98c'], ['oryx', '1f98c'], ['gemsbok', '1f98c'], ['springbok', '1f98c'], ['kob', '1f98c'], ['vicuña', '1f999'], ['llama', '1f999'], ['guanaco', '1f999'],
  ['horse', '1f40e'], ['zebra', '1f993'], ['hare', '1f407'], ['rabbit', '1f407'], ['bat', '1f987'], ['flying fox', '1f987'], ['crab', '1f980'], ['langouste', '1f99e'], ['dugong', '1f9ad'], ['seal', '1f9ad'],
  ['bee', '1f41d'], ['ladybird', '1f41e'], ['hedgehog', '1f994'], ['shrew', '1f994'], ['solenodon', '1f994'], ['tapir', '1f417'], ['hound', '1f415'], ['dog', '1f415'],
  ['panda', '1f43c'], ['fox', '1f98a'], ['bear', '1f43b'], ['wolf', '1f43a'], ['koala', '1f428'], ['lion', '1f981'],
  ['frigatebird', '1f426'], ['crane', '1f426'], ['stork', '1f426'], ['ibis', '1f426'], ['pelican', '1f426'], ['hornbill', '1f426'], ['toucan', '1f426'], ['kiwi', '1f426'], ['emu', '1f426'], ['ostrich', '1f426'], ['sunbird', '1f426'], ['hoopoe', '1f426'], ['bird', '1f426'], ['robin', '1f426'], ['thrush', '1f426'], ['magpie', '1f426'], ['nightingale', '1f426'], ['turaco', '1f426'], ['motmot', '1f426'], ['roller', '1f426'], ['bustard', '1f426'], ['shoebill', '1f426'], ['tern', '1f426'], ['warbler', '1f426'], ['lapwing', '1f426'], ['trogon', '1f426'], ['streamertail', '1f426'], ['kiskadee', '1f426'], ['troupial', '1f426'], ['bellbird', '1f426'], ['palmchat', '1f426'], ['megapode', '1f426'], ['manumea', '1f426'], ['grosbeak', '1f426'], ['rockfowl', '1f426'], ['francolin', '1f426'], ['partridge', '1f426'], ['hornero', '1f426'], ['dipper', '1f426'], ['godwit', '1f426'], ['blackbird', '1f426'], ['wagtail', '1f426'], ['sparrow', '1f426'], ['swallow', '1f426'], ['raven', '1f426'], ['goshawk', '1f426'], ['sisserou', '1f99c'], ['jacquot', '1f99c'], ['huma', '1f426'], ['turul', '1f985'],
];
// A landmark glyph where it says more than the animal (or the animal is only a face)
const PLACE = { JP: ['p', '1f5fb'], CL: ['p', '1f5ff'], IT: ['p', '1f3db'], GR: ['p', '1f3db'], US: ['p', '1f5fd'], VA: ['p', '26ea'], SA: ['p', '1f54b'], KH: ['p', '1f6d5'], TR: ['p', '1f54c'], IN: ['a', '1f405'], MA: ['p', '1f54c'], IR: ['p', '1f54c'], KR: ['p', '1f3ef'], DE: ['p', '1f3f0'], GB: ['p', '1f3f0'], CZ: ['p', '1f3f0'], RO: ['p', '1f3f0'], ES: ['a', '1f402'], PT: ['b', '1f413'], IS: ['p', '1f30b'], EC: ['a', '1f422'], NP: ['p', '1f3d4'], PK: ['p', '1f3d4'], CH: ['p', '1f3d4'], AT: ['p', '1f3d4'], TZ: ['p', '1f3d4'], VU: ['p', '1f30b'], SV: ['p', '1f30b'], NI: ['p', '1f30b'], CV: ['p', '1f30b'], KM: ['p', '1f30b'], VC: ['p', '1f30b'], SM: ['p', '1f3f0'], LI: ['p', '1f3f0'], MC: ['p', '1f3f0'], LU: ['p', '1f3f0'], EG: ['p', 'pyramids'], BH: ['p', '1f54c'], KW: ['p', '1f54c'], QA: ['p', '1f54c'], AE: ['p', '1f54c'], OM: ['p', '1f3f0'], BN: ['p', '1f54c'], MV: ['a', '1f988'], TH: ['a', '1f418'], TW: ['a', '1f43b'], HU: ['p', '1f3db'], IL: ['p', '1f54d'], PS: ['p', '1f54c'], AM: ['p', '26ea'], GE: ['p', '26ea'], ET: ['p', '26ea'], RU: ['p', '1f3f0'] };
// What the place board is called: the glyph shows one landmark, the discovery text often names two
const LABEL = { IT: 'The Pantheon, Rome', JP: 'Mount Fuji', GB: 'Windsor Castle', US: 'Statue of Liberty', EG: 'Pyramids of Giza', RU: 'Moscow Kremlin', TR: 'Blue Mosque, Istanbul', DE: 'Neuschwanstein Castle', SA: 'The Kaaba, Mecca', IR: 'Shah Mosque, Isfahan', ET: 'Church of St George, Lalibela', TZ: 'Mount Kilimanjaro', PK: 'K2', CL: 'Moai of Easter Island', NP: 'Mount Everest', GR: 'The Parthenon, Athens', KR: 'Gyeongbokgung Palace', IS: 'Hekla volcano', MA: 'Hassan II Mosque, Casablanca', RO: 'Bran Castle', KH: 'Angkor Wat', CZ: 'Prague Castle', AE: 'Sheikh Zayed Grand Mosque', HU: 'Hungarian Parliament', IL: 'Great Synagogue, Jerusalem', AT: 'Grossglockner, the Alps', CH: 'The Matterhorn', NI: 'Momotombo volcano', SV: 'Izalco volcano', OM: 'Nizwa Fort', PS: 'Ibrahimi Mosque, Hebron', KW: 'Grand Mosque of Kuwait', GE: 'Gergeti Trinity Church', AM: 'Geghard Monastery', QA: 'Qatar State Mosque', BH: 'Al Fateh Grand Mosque', KM: 'Mount Karthala', LU: 'Vianden Castle', CV: 'Pico do Fogo', BN: 'Sultan Omar Ali Saifuddien Mosque', VU: 'Mount Yasur', VC: 'La Soufrière', MC: "Prince's Palace of Monaco", LI: 'Vaduz Castle', SM: 'Guaita Tower', VA: "St Peter's Basilica" };
// Hand-drawn shapes (REF box, y down) where no glyph fits: two pyramids for Egypt
const CUSTOM = { pyramids: 'M 0 100 L 36 12 L 72 100 Z M 72 100 L 86 52 L 100 100 Z' };
const FACE = new Set(['1f43b', '1f43a', '1f98a', '1f428', '1f981']);   // face-only glyphs: take a bird or a place instead when there is one (the panda face is iconic enough)
const KIND_ORDER = ['a', 'b', 'p'];
function pick(a2) {
  if (PLACE[a2]) { const [kind, hex] = PLACE[a2]; return { kind, hex }; }
  const d = disc[a2];
  let best = null;
  const hit = (text, kw) => new RegExp('(^|[^a-z])' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z]|$)').test(text);   // whole words: 'ox' must not match 'fox', 'tur' not 'turaco'
  for (const kind of KIND_ORDER) { const text = (d[kind] || '').toLowerCase(); for (const [kw, hex] of RULES) if (hit(text, kw)) { if (!best || (FACE.has(best.hex) && !FACE.has(hex))) best = { kind, hex }; break; } if (best && !FACE.has(best.hex)) break; }
  return best;
}
const boards = {}; const need = new Set();
for (const L of levels) { const p = pick(L.a2); if (!p) throw new Error('no glyph for ' + L.name + ': ' + JSON.stringify(disc[L.a2])); boards[L.a2] = { kind: p.kind, hex: p.hex, name: p.kind === 'p' ? (LABEL[L.a2] || short(disc[L.a2].p)) : short(disc[L.a2][p.kind]) }; need.add(p.hex); }
if (Object.keys(LABEL).some(a2 => boards[a2]?.kind !== 'p')) throw new Error('LABEL names a country whose board is not a place');
function short(name) { return name.split(/ and | \(|, /)[0].trim(); }   // "Golden eagle (heraldic)" → "Golden eagle"; "Red kangaroo and the koala" → "Red kangaroo"

function scaleFor(d, target, tier) {
  const probe = rasterise(d, 0.3);
  const tall = probe.h > probe.w * 1.5, wide = probe.w > probe.h * 1.5;
  const maxW = wide ? MAX_WIDE_OF[tier] : MAX_DIM_OF[tier], maxH = tall ? MAX_TALL_OF[tier] : MAX_DIM_OF[tier];
  let lo = 0.06, hi = Math.max(maxW, maxH) / REF, best = null;
  for (let i = 0; i < 18; i++) { const k = Math.round((lo + hi) / 2 * 1000) / 1000; const m = rasterise(d, k); if (m.count < target) lo = k; else hi = k; if (m.w <= maxW && m.h <= maxH && (!best || Math.abs(m.count - target) < Math.abs(best.count - target))) best = m; if (hi - lo < 0.0015) break; }
  return best;
}
const shapes = {}; const S = 240;
// potrace writes M/L/C/Z; cubics are sampled into straight runs, then the polyline is thinned (Douglas–Peucker)
function flatten(raw, tol) {
  const toks = raw.match(/[MLCZ]|-?\d+\.?\d*/g); const rings = []; let ring = null, cmd = '', cur = [0, 0], i = 0;
  const num = () => +toks[i++];
  while (i < toks.length) {
    const t = toks[i]; if (/[MLCZ]/.test(t)) { cmd = t; i++; if (t === 'Z') { ring = null; continue; } }
    if (cmd === 'M') { ring = [[num(), num()]]; rings.push(ring); cur = ring[0]; cmd = 'L'; }
    else if (cmd === 'L') { cur = [num(), num()]; ring.push(cur); }
    else if (cmd === 'C') { const [x1, y1, x2, y2, x, y] = [num(), num(), num(), num(), num(), num()]; const [x0, y0] = cur; for (let s = 1; s <= 4; s++) { const u = s / 4, v = 1 - u; ring.push([v * v * v * x0 + 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u * x, v * v * v * y0 + 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u * y]); } cur = [x, y]; }
    else throw new Error('unexpected path token ' + t);
  }
  const dist = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1]; const L2 = dx * dx + dy * dy || 1; const u = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)); return Math.hypot(p[0] - a[0] - u * dx, p[1] - a[1] - u * dy); };
  const rdp = pts => { if (pts.length < 3) return pts; let far = 0, at = 0; for (let k = 1; k < pts.length - 1; k++) { const d = dist(pts[k], pts[0], pts[pts.length - 1]); if (d > far) { far = d; at = k; } } return far > tol ? rdp(pts.slice(0, at + 1)).slice(0, -1).concat(rdp(pts.slice(at))) : [pts[0], pts[pts.length - 1]]; };
  return rings.map(r => { if (r.length > 1 && Math.hypot(r[0][0] - r[r.length - 1][0], r[0][1] - r[r.length - 1][1]) < 1e-6) r = r.slice(0, -1); const half = Math.ceil(r.length / 2); return rdp(r.slice(0, half + 1)).slice(0, -1).concat(rdp(r.slice(half).concat([r[0]])).slice(0, -1)); }).filter(r => r.length >= 3);
}
function fit(rings) {   // scale into the REF box, centred, one decimal
  const xs = rings.flat().map(p => p[0]), ys = rings.flat().map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), sc = REF / Math.max(x1 - x0, y1 - y0);
  const ox = (REF - (x1 - x0) * sc) / 2, oy = (REF - (y1 - y0) * sc) / 2;
  const f = v => String(Math.round(v * 10) / 10);
  return rings.map(r => 'M ' + r.map(([x, y]) => `${f((x - x0) * sc + ox)} ${f((y - y0) * sc + oy)}`).join(' L ') + ' Z').join(' ');
}
for (const hex of need) {
  if (CUSTOM[hex]) { const d = CUSTOM[hex]; const masks = TARGETS.map((t, tier) => scaleFor(d, t, tier)); shapes[hex] = { d, k: masks.map(m => m.k) }; console.log(hex, 'custom', masks.map(m => `${m.count} ${m.w}x${m.h}`).join(' | ')); continue; }
  const file = TW + hex + '.svg'; if (!fs.existsSync(file)) throw new Error('no twemoji ' + hex);
  const png = await sharp(fs.readFileSync(file)).resize(S, S, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).ensureAlpha().extractChannel('alpha').negate().png().toBuffer();
  const raw = await new Promise((res, rej) => potrace.trace(png, { threshold: 128, turdSize: 14, alphaMax: 1, optTolerance: 0.45 }, (err, out) => err ? rej(err) : res(/ d="([^"]+)"/.exec(out)[1])));
  const d = fit(flatten(raw, 0.9));   // 0.9 px of 240: well under a cell even on Master boards
  const masks = TARGETS.map((t, tier) => scaleFor(d, t, tier));
  if (masks.some(m => !m || m.count < 40)) throw new Error('shape too thin: ' + hex + ' ' + masks.map(m => m && m.count));
  shapes[hex] = { d, k: masks.map(m => m.k) };
  console.log(hex, 'path', d.length, 'cells', masks.map(m => `${m.count} ${m.w}x${m.h}`).join(' | '));
}
fs.writeFileSync(OUT, JSON.stringify({ version: 1, shapes, boards }));
console.log(Object.keys(shapes).length, 'shapes for', Object.keys(boards).length, 'countries, bytes', fs.statSync(OUT).size);
const byHex = {}; for (const [a2, b] of Object.entries(boards)) (byHex[b.hex] = byHex[b.hex] || []).push(a2 + ':' + b.kind);
console.log(JSON.stringify(byHex));
