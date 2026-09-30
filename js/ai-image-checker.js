/* ══════════════════════════════════════════════════
   AI IMAGE CHECKER — reads what an image's metadata says about how it was made.
   Loads after js/ai-metadata-remover.js, whose parsers and AI signatures it reuses
   (window.AMRCore), so both tools always recognise the same generators.
   Everything runs in the browser: nothing is uploaded.
   ══════════════════════════════════════════════════ */
(() => {
  'use strict';
  const core = window.AMRCore;
  const drop = document.getElementById('aicDrop');
  const input = document.getElementById('aicInput');
  const results = document.getElementById('aicResults');
  const list = document.getElementById('aicList');
  const clearBtn = document.getElementById('aicClear');
  const errBox = document.getElementById('aicError');
  if (!core || !drop || !input || !results || !list) return;

  const latin1 = new TextDecoder('latin1');
  const utf8 = new TextDecoder('utf-8');
  const MAX_BYTES = 80 * 1024 * 1024;
  const urls = [];
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const AI_TOOLS = new Set(core.SIGNATURES.map(s => s.label).filter(l => !/^C2PA|^IPTC/.test(l)));

  /* ── Collect the raw metadata blocks of a JPEG, PNG or WebP ── */
  async function blocks(u8, kind) {
    const out = { exif: [], xmp: [], c2pa: [], text: [] };
    const be16 = i => (u8[i] << 8) | u8[i + 1];
    const be32 = i => ((u8[i] << 24) >>> 0) + (u8[i + 1] << 16) + (u8[i + 2] << 8) + u8[i + 3];
    const le32 = i => u8[i] + (u8[i + 1] << 8) + (u8[i + 2] << 16) + ((u8[i + 3] << 24) >>> 0);
    const str = (i, n) => latin1.decode(u8.subarray(i, i + n));
    if (kind === 'jpeg') {
      let p = 2;
      while (p + 4 <= u8.length && u8[p] === 0xFF) {
        const m = u8[p + 1];
        if (m === 0xD9 || m === 0xDA) break;              // end of image / start of scan: no metadata after this
        if (m >= 0xD0 && m <= 0xD7 || m === 0x01) { p += 2; continue; }
        const len = be16(p + 2), d = p + 4, end = p + 2 + len;
        if (len < 2 || end > u8.length) break;
        if (m === 0xE1 && str(d, 6) === 'Exif\0\0') out.exif.push(u8.subarray(d + 6, end));
        else if (m === 0xE1 && str(d, 29) === 'http://ns.adobe.com/xap/1.0/\0') out.xmp.push(utf8.decode(u8.subarray(d + 29, end)));
        else if (m === 0xEB) out.c2pa.push(u8.subarray(d, end));
        else if (m === 0xFE) out.text.push({ keyword: 'Comment', body: utf8.decode(u8.subarray(d, end)) });
        p = end;
      }
    } else if (kind === 'png') {
      let p = 8;
      while (p + 12 <= u8.length) {
        const len = be32(p), type = str(p + 4, 4), d = p + 8, end = d + len;
        if (end + 4 > u8.length) break;
        if (type === 'eXIf') out.exif.push(u8.subarray(d, end));
        else if (type === 'caBX') out.c2pa.push(u8.subarray(d, end));
        else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
          const t = await core.readPngText(u8, type, d, end);
          if (/^XML:com\.adobe\.xmp$/i.test(t.keyword)) out.xmp.push(t.body); else out.text.push(t);
        }
        if (type === 'IEND') break;
        p = end + 4;
      }
    } else if (kind === 'webp') {
      let p = 12;
      while (p + 8 <= u8.length) {
        const type = str(p, 4), len = le32(p + 4), d = p + 8, end = d + len;
        if (end > u8.length) break;
        if (type === 'EXIF') out.exif.push(str(d, 6) === 'Exif\0\0' ? u8.subarray(d + 6, end) : u8.subarray(d, end));
        else if (type === 'XMP ') out.xmp.push(utf8.decode(u8.subarray(d, end)));
        else if (type === 'C2PA') out.c2pa.push(u8.subarray(d, end));
        p = end + (len & 1);
      }
    }
    return out;
  }

  /* ── EXIF (TIFF) reader: the handful of tags people actually want to see ── */
  function readExif(t) {
    if (t.length < 8) return {};
    const le = t[0] === 0x49;
    const u16 = i => le ? t[i] | (t[i + 1] << 8) : (t[i] << 8) | t[i + 1];
    const u32 = i => le ? (t[i] | (t[i + 1] << 8) | (t[i + 2] << 16)) + t[i + 3] * 16777216 : t[i] * 16777216 + ((t[i + 1] << 16) | (t[i + 2] << 8) | t[i + 3]);
    const ascii = (off, n) => latin1.decode(t.subarray(off, off + n)).replace(/\0+$/, '').trim();
    const rational = off => { const d = u32(off + 4); return d ? u32(off) / d : 0; };
    function ifd(off) {
      const tags = {};
      if (off + 2 > t.length) return tags;
      const n = u16(off);
      for (let k = 0; k < n; k++) {
        const e = off + 2 + k * 12;
        if (e + 12 > t.length) break;
        const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
        const size = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8 }[type] || 1) * count;
        const valOff = size <= 4 ? e + 8 : u32(e + 8);
        if (valOff + size > t.length) continue;
        if (type === 2) tags[tag] = ascii(valOff, count);
        else if (type === 3) tags[tag] = u16(valOff);
        else if (type === 4) tags[tag] = u32(valOff);
        else if (type === 5) tags[tag] = Array.from({ length: Math.min(count, 3) }, (_, j) => rational(valOff + j * 8));
        else if (type === 7 || type === 1) tags[tag] = t.subarray(valOff, valOff + Math.min(count, 256));
      }
      return tags;
    }
    const root = ifd(u32(4));
    const exif = root[0x8769] ? ifd(root[0x8769]) : {};
    const gps = root[0x8825] ? ifd(root[0x8825]) : {};
    const out = {
      make: root[0x010F], model: root[0x0110], software: root[0x0131], artist: root[0x013B],
      description: root[0x010E], date: exif[0x9003] || root[0x0132],
    };
    if (Array.isArray(gps[2]) && Array.isArray(gps[4])) {
      const deg = a => a[0] + (a[1] || 0) / 60 + (a[2] || 0) / 3600;
      let lat = deg(gps[2]), lon = deg(gps[4]);
      if (gps[1] === 'S') lat = -lat;
      if (gps[3] === 'W') lon = -lon;
      if (lat || lon) out.gps = [lat, lon];
    }
    return out;
  }

  function xmpField(xmp, name) {
    const m = xmp.match(new RegExp(`${name}\\s*=\\s*"([^"]{1,200})"`)) || xmp.match(new RegExp(`<${name}>([^<]{1,200})</${name}>`));
    return m ? m[1].trim() : '';
  }

  function claimGenerator(bytes) {
    const text = latin1.decode(bytes.subarray(0, 4 * 1024 * 1024));
    // claim_generator is a CBOR string ("Adobe_Photoshop/25.0 …", "ChatGPT"); the CBOR length byte in front of it can
    // itself be printable (0x60–0x7F), so the name must start with a capital letter or a digit.
    const m = text.match(/claim_generator(?:_info)?[\s\S]{0,40}?(?:name[\s\S]{0,3})?([A-Z0-9][\x20-\x7e]{2,80})/);
    return m ? m[1].trim().slice(0, 80) : '';
  }

  /* ── One file → one verdict and a list of findings ── */
  async function inspect(file) {
    const u8 = new Uint8Array(await file.arrayBuffer());
    const kind = core.sniff(u8);
    if (kind === 'other') return { file, kind, unsupported: true };
    const [cleaned, raw] = await Promise.all([core.processFile(file, { keepExif: false }), blocks(u8, kind)]);
    URL.revokeObjectURL(cleaned.url);
    const detected = Array.from(cleaned.report.detected);
    const exif = raw.exif.length ? readExif(raw.exif[0]) : {};
    const xmp = raw.xmp.join('\n');
    const facts = [];
    const add = (label, value, flag) => { if (value) facts.push({ label, value: String(value), flag }); };
    const gen = raw.c2pa.length ? claimGenerator(raw.c2pa.reduce((a, b) => { const c = new Uint8Array(a.length + b.length); c.set(a); c.set(b, a.length); return c; }, new Uint8Array())) : '';
    if (raw.c2pa.length) add('Content Credentials (C2PA)', gen ? `Present — made or edited with ${gen}` : 'Present — a signed record of how the file was made or edited', 'warn');
    const source = xmpField(xmp, 'Iptc4xmpExt:DigitalSourceType') || xmpField(xmp, 'DigitalSourceType');
    if (source) add('Digital source type', /algorithmic/i.test(source) ? `${source.split('/').pop()} (marked as AI-generated)` : source.split('/').pop(), /algorithmic/i.test(source) ? 'ai' : '');
    add('Created with', xmpField(xmp, 'xmp:CreatorTool') || xmpField(xmp, 'CreatorTool'));
    add('Software', exif.software);
    add('Camera', [exif.make, exif.model].filter(Boolean).join(' ').trim());
    add('Date taken', exif.date);
    add('Artist', exif.artist);
    if (exif.gps) add('GPS location', `${exif.gps[0].toFixed(5)}, ${exif.gps[1].toFixed(5)} — anyone with the file can see where it was taken`, 'warn');
    for (const t of raw.text) {
      const body = (t.body || '').trim();
      if (!body) continue;
      const isPrompt = /^(parameters|prompt|workflow|Comment|Description|Dream|sd-metadata|invokeai_metadata)$/i.test(t.keyword);
      add(isPrompt ? `AI prompt / settings (“${t.keyword}”)` : `Text “${t.keyword}”`, body.length > 280 ? body.slice(0, 280) + '…' : body, isPrompt ? 'ai' : '');
    }
    const aiTools = detected.filter(l => AI_TOOLS.has(l));
    const aiSource = detected.includes('IPTC “AI-generated” source type');
    let verdict;
    if (aiTools.length || aiSource) verdict = { level: 'ai', title: aiTools.length ? `AI signs found: ${aiTools.join(', ')}` : 'Marked as AI-generated', text: 'This file’s metadata says it was made or edited with an AI tool.' };
    else if (raw.c2pa.length) verdict = { level: 'warn', title: 'Content Credentials found', text: 'The file carries a signed record of how it was made or edited. No known AI generator is named in it.' };
    else if (cleaned.report.removed.length) verdict = { level: 'none', title: 'No AI metadata found', text: 'The file has ordinary metadata but nothing that points to an AI tool. That does not prove it is a real photo: metadata is easy to remove.' };
    else verdict = { level: 'none', title: 'No metadata at all', text: 'The file carries no hidden data. It may have been cleaned or re-saved, so this says nothing either way about AI.' };
    return { file, kind, verdict, facts, blocks: cleaned.report.removed };
  }

  function card(r) {
    const url = URL.createObjectURL(r.file); urls.push(url);
    const el = document.createElement('article');
    el.className = 'aic-item';
    if (r.unsupported) {
      el.innerHTML = `<div class="aic-item-head"><div class="aic-item-thumb"><img src="${url}" alt="" loading="lazy" decoding="async"></div><div><p class="aic-item-name">${esc(r.file.name)}</p><p class="aic-verdict aic-verdict--none"><strong>Can’t inspect this format</strong> Only JPG, PNG and WebP files can be read. Convert the image to one of those first.</p></div></div>`;
      return el;
    }
    const facts = r.facts.length
      ? `<dl class="aic-facts">${r.facts.map(f => `<div${f.flag ? ` class="is-${f.flag}"` : ''}><dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`).join('')}</dl>`
      : '';
    const blocks = r.blocks.length
      ? `<details class="aic-blocks"><summary>${r.blocks.length} metadata block${r.blocks.length > 1 ? 's' : ''} in this file</summary><ul>${r.blocks.map(b => `<li>${esc(b.label)}</li>`).join('')}</ul></details>`
      : '';
    const remove = r.blocks.length ? '<a class="aic-btn aic-btn--primary" href="/ai-metadata-remover/">Remove this metadata →</a>' : '';
    el.innerHTML = `
      <div class="aic-item-head">
        <div class="aic-item-thumb"><img src="${url}" alt="" loading="lazy" decoding="async"></div>
        <div>
          <p class="aic-item-name">${esc(r.file.name)}</p>
          <p class="aic-verdict aic-verdict--${r.verdict.level}"><strong>${esc(r.verdict.title)}</strong> ${esc(r.verdict.text)}</p>
        </div>
      </div>
      ${facts}${blocks}
      <div class="aic-item-actions">${remove}</div>`;
    return el;
  }

  const showError = msg => { errBox.textContent = msg || ''; errBox.hidden = !msg; };

  async function handle(files) {
    files = Array.from(files || []).filter(f => f && (f.type.startsWith('image/') || /\.(jpe?g|png|webp)$/i.test(f.name)));
    if (!files.length) return;
    showError('');
    drop.classList.add('is-busy'); drop.setAttribute('aria-busy', 'true');
    for (const file of files) {
      if (file.size > MAX_BYTES) { showError(`“${file.name}” is larger than 80 MB and was skipped.`); continue; }
      try { list.prepend(card(await inspect(file))); }
      catch (e) { showError(`“${file.name}” could not be read: ${e.message || e}`); }
    }
    results.hidden = !list.children.length;
    drop.classList.remove('is-busy'); drop.setAttribute('aria-busy', 'false');
    input.value = '';
    if (!results.hidden) results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => handle(input.files));
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('is-over'); }));
  drop.addEventListener('drop', e => handle(e.dataTransfer?.files));
  document.addEventListener('paste', e => handle(Array.from(e.clipboardData?.files || [])));
  clearBtn?.addEventListener('click', () => { urls.splice(0).forEach(u => URL.revokeObjectURL(u)); list.innerHTML = ''; results.hidden = true; showError(''); });
})();
