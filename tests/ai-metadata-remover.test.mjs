// Unit test for js/ai-metadata-remover.js — builds synthetic JPEG / PNG / WebP
// files stuffed with metadata, runs the stripper, and checks the output.
// Run:  node tests/ai-metadata-remover.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'js', 'ai-metadata-remover.js'), 'utf8');

// Pull the parser functions out of the page IIFE without a DOM.
const body = src
  .replace('(() => {', '')                 // opening of the page IIFE (after the header comment)
  .replace(/\}\)\(\);\s*$/, '')            // its closing call
  .replace("const drop = document.getElementById('amrDrop');",
    "return { cleanJpeg, cleanPng, cleanWebp, sniff, processFile };\n  const drop = document.getElementById('amrDrop');");
const stubDoc = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  createElement: () => ({ style: {}, getContext: () => ({ drawImage() {} }), toBlob: cb => cb(null) }),
};
const api = new Function('document', 'window', body)(stubDoc, { matchMedia: () => ({ matches: false }) });

/* ── builders ── */
const be16 = n => [(n >> 8) & 0xff, n & 0xff];
const be32 = n => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le32 = n => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const str = s => Array.from(Buffer.from(s, 'latin1'));

function jpegSeg(marker, payload) {
  return [0xff, marker, ...be16(payload.length + 2), ...payload];
}
function buildJpeg({ exif = true, xmp = true, c2pa = true, iptc = true, com = true, trailer = true } = {}) {
  const bytes = [0xff, 0xd8];
  bytes.push(...jpegSeg(0xe0, [...str('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]));
  if (exif) bytes.push(...jpegSeg(0xe1, [...str('Exif\0\0MM\0*\0\0\0\x08'), ...str('\0\0 Software=Adobe Firefly ')]));
  if (xmp) bytes.push(...jpegSeg(0xe1, [...str('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:Description Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"/></x:xmpmeta>')]));
  bytes.push(...jpegSeg(0xe2, [...str('ICC_PROFILE\0'), 1, 1, ...new Array(40).fill(7)]));
  if (c2pa) bytes.push(...jpegSeg(0xeb, [...str('JP'), 0, 1, 0, 0, 0, 1, ...str('jumbc2pa.manifest urn:c2pa:openai ChatGPT')]));
  if (iptc) bytes.push(...jpegSeg(0xed, [...str('Photoshop 3.0\x008BIM\x04\x04\0\0'), ...str('\0\x10\x1c\x02\x78\0\x05hello')]));
  if (com) bytes.push(...jpegSeg(0xfe, str('Created with Midjourney')));
  bytes.push(...jpegSeg(0xdb, [0, ...new Array(64).fill(1)]));                       // DQT
  bytes.push(...jpegSeg(0xc0, [8, ...be16(1), ...be16(1), 1, 1, 0x11, 0]));          // SOF0 1x1 gray
  bytes.push(...jpegSeg(0xc4, [0x00, 1, ...new Array(15).fill(0), 0]));             // DHT (DC)
  bytes.push(...jpegSeg(0xc4, [0x10, 1, ...new Array(15).fill(0), 0]));             // DHT (AC)
  bytes.push(0xff, 0xda, ...be16(8), 1, 1, 0x00, 0, 63, 0);                          // SOS header
  bytes.push(0x00, 0xff, 0x00, 0x7f);                                                // fake entropy data w/ stuffed FF00
  bytes.push(0xff, 0xd9);                                                            // EOI
  if (trailer) bytes.push(...str('TRAILING motion photo data SynthID Gemini'));
  return new Uint8Array(bytes);
}
function parseJpegMarkers(u8) {
  const out = [];
  let p = 2;
  while (p < u8.length) {
    assert.equal(u8[p], 0xff, `marker expected at ${p}`);
    const m = u8[p + 1];
    if (m === 0xd9) { out.push('EOI'); p += 2; break; }
    if (m === 0xda) { out.push('SOS'); break; }
    const len = (u8[p + 2] << 8) | u8[p + 3];
    out.push(`APP${m - 0xe0}`.replace(/APP-?\d+/, x => (m >= 0xe0 && m <= 0xef ? x : `M${m.toString(16)}`)));
    p += 2 + len;
  }
  return out;
}

const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function pngChunk(type, data) {
  const td = [...str(type), ...data];
  return [...be32(data.length), ...td, ...be32(crc32(td))];
}
function buildPng() {
  const raw = Buffer.from([0, 255, 0, 0]);                                           // 1x1 RGB, filter 0
  const idat = Array.from(zlib.deflateSync(raw));
  const b = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  b.push(...pngChunk('IHDR', [...be32(1), ...be32(1), 8, 2, 0, 0, 0]));
  b.push(...pngChunk('tEXt', [...str('parameters\0masterpiece, 1girl\nNegative prompt: bad\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1, Model hash: abc')]));
  b.push(...pngChunk('zTXt', [...str('prompt\0'), 0, ...Array.from(zlib.deflateSync(Buffer.from('{"3":{"class_type":"KSampler","inputs":{}}}')))]));
  b.push(...pngChunk('iTXt', [...str('XML:com.adobe.xmp\0'), 0, 0, ...str('\0\0<x:xmpmeta>Made with Google AI</x:xmpmeta>')]));
  b.push(...pngChunk('eXIf', str('MM\0*\0\0\0\x08 OpenAI')));
  b.push(...pngChunk('caBX', str('jumb c2pa urn:c2pa:abc')));
  b.push(...pngChunk('tIME', [7, 230, 1, 1, 0, 0, 0]));
  b.push(...pngChunk('pHYs', [...be32(2835), ...be32(2835), 1]));
  b.push(...pngChunk('IDAT', idat));
  b.push(...pngChunk('IEND', []));
  b.push(...str('garbage after IEND'));
  return new Uint8Array(b);
}
function parsePngChunks(u8) {
  const out = [];
  let p = 8;
  while (p + 8 <= u8.length) {
    const len = (u8[p] << 24 | u8[p + 1] << 16 | u8[p + 2] << 8 | u8[p + 3]) >>> 0;
    const type = Buffer.from(u8.subarray(p + 4, p + 8)).toString('latin1');
    const td = u8.subarray(p + 4, p + 8 + len);
    const crc = (u8[p + 8 + len] << 24 | u8[p + 9 + len] << 16 | u8[p + 10 + len] << 8 | u8[p + 11 + len]) >>> 0;
    assert.equal(crc, crc32(td), `crc mismatch on ${type}`);
    out.push(type);
    p += 12 + len;
    if (type === 'IEND') break;
  }
  assert.equal(p, u8.length, 'no trailing bytes after IEND');
  return out;
}

function webpChunk(fourcc, data) {
  const b = [...str(fourcc), ...le32(data.length), ...data];
  if (data.length & 1) b.push(0);
  return b;
}
function buildWebp() {
  const vp8x = [0x20 | 0x08 | 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0];                     // ICC + EXIF + XMP flags, 1x1
  const chunks = [
    ...webpChunk('VP8X', vp8x),
    ...webpChunk('ICCP', new Array(20).fill(3)),
    ...webpChunk('VP8L', [0x2f, 0, 0, 0, 0, 0x88, 0x88, 0x08, 0x20]),                // odd length → padded
    ...webpChunk('EXIF', str('MM\0*\0\0\0\x08 Microsoft Designer')),
    ...webpChunk('XMP ', str('<x:xmpmeta>Midjourney Job ID</x:xmpmeta>')),
    ...webpChunk('C2PA', str('jumb c2pa.manifest')),
    ...webpChunk('ZZZZ', str('unknown chunk')),
  ];
  return new Uint8Array([...str('RIFF'), ...le32(chunks.length + 4), ...str('WEBP'), ...chunks]);
}
function parseWebpChunks(u8) {
  const size = (u8[4] | u8[5] << 8 | u8[6] << 16 | u8[7] << 24) >>> 0;
  assert.equal(size + 8, u8.length, 'RIFF size matches file length');
  const out = [];
  let p = 12;
  while (p + 8 <= u8.length) {
    const fourcc = Buffer.from(u8.subarray(p, p + 4)).toString('latin1');
    const len = (u8[p + 4] | u8[p + 5] << 8 | u8[p + 6] << 16 | u8[p + 7] << 24) >>> 0;
    out.push({ fourcc, flags: fourcc === 'VP8X' ? u8[p + 8] : null });
    p += 8 + len + (len & 1);
  }
  assert.equal(p, u8.length, 'no trailing bytes after last chunk');
  return out;
}

/* ── tests ── */
let passed = 0;
function test(name, fn) { return Promise.resolve().then(fn).then(() => { passed++; console.log('✓', name); }, e => { console.error('✗', name, '\n ', e.message); process.exitCode = 1; }); }

await test('sniff detects formats', () => {
  assert.equal(api.sniff(buildJpeg()), 'jpeg');
  assert.equal(api.sniff(buildPng()), 'png');
  assert.equal(api.sniff(buildWebp()), 'webp');
  assert.equal(api.sniff(new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70])), 'other');
});

await test('JPEG: remove everything', () => {
  const inp = buildJpeg();
  const { bytes, report } = api.cleanJpeg(inp, { keepExif: false });
  assert.deepEqual(parseJpegMarkers(bytes), ['APP0', 'APP2', 'Mdb', 'Mc0', 'Mc4', 'Mc4', 'SOS']);
  assert.ok(bytes.length < inp.length);
  assert.equal(bytes[bytes.length - 2], 0xff); assert.equal(bytes[bytes.length - 1], 0xd9);
  const labels = report.removed.map(r => r.label);
  assert.ok(labels.some(l => /EXIF/.test(l)));
  assert.ok(labels.some(l => /XMP/.test(l)));
  assert.ok(labels.some(l => /C2PA/.test(l)));
  assert.ok(labels.some(l => /IPTC/.test(l)));
  assert.ok(labels.some(l => /comment/.test(l)));
  assert.ok(labels.some(l => /after end-of-image/.test(l)));
  const det = [...report.detected];
  assert.ok(det.includes('C2PA Content Credentials'), det.join());
  assert.ok(det.includes('OpenAI / ChatGPT / DALL·E'));
  assert.ok(det.includes('Midjourney'));
  assert.ok(det.includes('Adobe Firefly / generative fill'));
  assert.ok(det.includes('IPTC “AI-generated” source type'));
  assert.ok(det.includes('Google Gemini / Imagen'));
  // Entropy data must be byte-identical
  const sosIn = inp.indexOf(0xda, 0) ; // not used — compare tail instead
  const tailIn = Buffer.from(inp).indexOf(Buffer.from([0xff, 0xda]));
  const tailOut = Buffer.from(bytes).indexOf(Buffer.from([0xff, 0xda]));
  const eoiIn = Buffer.from(inp).indexOf(Buffer.from([0xff, 0xd9]), tailIn);
  assert.deepEqual(Buffer.from(inp.subarray(tailIn, eoiIn + 2)), Buffer.from(bytes.subarray(tailOut)));
});

await test('JPEG: keep EXIF mode keeps EXIF, warns about signature inside it', () => {
  const { bytes, report } = api.cleanJpeg(buildJpeg(), { keepExif: true });
  assert.deepEqual(parseJpegMarkers(bytes), ['APP0', 'APP1', 'APP2', 'Mdb', 'Mc0', 'Mc4', 'Mc4', 'SOS']);
  assert.ok(report.kept.some(k => /EXIF/.test(k.label)));
  assert.ok([...report.keptWarnings].includes('Adobe Firefly / generative fill'));
});

await test('JPEG: already-clean file is unchanged and reports nothing', () => {
  const inp = buildJpeg({ exif: false, xmp: false, c2pa: false, iptc: false, com: false, trailer: false });
  const { bytes, report } = api.cleanJpeg(inp, { keepExif: false });
  assert.deepEqual(Buffer.from(bytes), Buffer.from(inp));
  assert.equal(report.removed.length, 0);
  assert.equal(report.detected.size, 0);
});

await test('JPEG: idempotent (cleaning twice gives same bytes)', () => {
  const once = api.cleanJpeg(buildJpeg(), { keepExif: false }).bytes;
  const twice = api.cleanJpeg(once, { keepExif: false }).bytes;
  assert.deepEqual(Buffer.from(once), Buffer.from(twice));
});

await test('PNG: remove everything', async () => {
  const inp = buildPng();
  const { bytes, report } = await api.cleanPng(inp, { keepExif: false });
  assert.deepEqual(parsePngChunks(bytes), ['IHDR', 'pHYs', 'IDAT', 'IEND']);
  const labels = report.removed.map(r => r.label);
  assert.ok(labels.some(l => /Stable Diffusion prompt/.test(l)), labels.join('|'));
  assert.ok(labels.some(l => /ComfyUI prompt/.test(l)), labels.join('|'));
  assert.ok(labels.some(l => /XMP/.test(l)));
  assert.ok(labels.some(l => /EXIF/.test(l)));
  assert.ok(labels.some(l => /caBX/.test(l)));
  assert.ok(labels.some(l => /tIME/.test(l)));
  assert.ok(labels.some(l => /after end-of-image/.test(l)));
  const det = [...report.detected];
  assert.ok(det.includes('Stable Diffusion / ComfyUI / A1111'), det.join());
  assert.ok(det.includes('Google Gemini / Imagen'), det.join());
  assert.ok(det.includes('OpenAI / ChatGPT / DALL·E'), det.join());
  assert.ok(det.includes('C2PA Content Credentials'), det.join());
});

await test('PNG: keep EXIF mode', async () => {
  const { bytes, report } = await api.cleanPng(buildPng(), { keepExif: true });
  assert.deepEqual(parsePngChunks(bytes), ['IHDR', 'eXIf', 'pHYs', 'IDAT', 'IEND']);
  assert.ok([...report.keptWarnings].includes('OpenAI / ChatGPT / DALL·E'));
});

await test('WebP: remove everything, VP8X flags cleared, RIFF size fixed', () => {
  const inp = buildWebp();
  const { bytes, report } = api.cleanWebp(inp, { keepExif: false });
  const chunks = parseWebpChunks(bytes);
  assert.deepEqual(chunks.map(c => c.fourcc), ['VP8X', 'ICCP', 'VP8L']);
  assert.equal(chunks[0].flags & 0x08, 0, 'EXIF flag cleared');
  assert.equal(chunks[0].flags & 0x04, 0, 'XMP flag cleared');
  assert.equal(chunks[0].flags & 0x20, 0x20, 'ICC flag kept');
  assert.equal(inp[20] & 0x08, 0x08, 'input untouched (VP8X copied, not mutated in place)');
  const labels = report.removed.map(r => r.label);
  assert.ok(labels.some(l => /EXIF/.test(l)));
  assert.ok(labels.some(l => /XMP/.test(l)));
  assert.ok(labels.some(l => /C2PA/.test(l)));
  assert.ok(labels.some(l => /ZZZZ/.test(l)));
  const det = [...report.detected];
  assert.ok(det.includes('Microsoft Designer / Bing Image Creator'), det.join());
  assert.ok(det.includes('Midjourney'), det.join());
});

await test('WebP: keep EXIF mode keeps EXIF flag', () => {
  const { bytes } = api.cleanWebp(buildWebp(), { keepExif: true });
  const chunks = parseWebpChunks(bytes);
  assert.deepEqual(chunks.map(c => c.fourcc), ['VP8X', 'ICCP', 'VP8L', 'EXIF']);
  assert.equal(chunks[0].flags & 0x08, 0x08);
  assert.equal(chunks[0].flags & 0x04, 0);
});

await test('Truncated JPEG segment is copied, not crashed on', () => {
  const inp = buildJpeg().subarray(0, 40); // cut in the middle of EXIF
  const { bytes, report } = api.cleanJpeg(inp, { keepExif: false });
  assert.ok(bytes.length > 0);
  assert.ok(report.notes.length > 0);
});

// Write fixtures for manual browser testing
const fx = path.join(here, 'fixtures');
fs.mkdirSync(fx, { recursive: true });
fs.writeFileSync(path.join(fx, 'synthetic-meta.jpg'), buildJpeg());
fs.writeFileSync(path.join(fx, 'synthetic-meta.png'), buildPng());
fs.writeFileSync(path.join(fx, 'synthetic-meta.webp'), buildWebp());

console.log(`\n${passed} passed${process.exitCode ? ' (with failures)' : ''}`);
