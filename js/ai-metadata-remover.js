/* ══════════════════════════════════════════════════
   AI METADATA REMOVER — 100% in-browser
   Strips C2PA / JUMBF, XMP, IPTC, EXIF, PNG text
   chunks and other hidden metadata from JPG, PNG and
   WebP by rewriting the file container byte-by-byte.
   Pixels are never touched, nothing is uploaded.
   ══════════════════════════════════════════════════ */
(() => {
  'use strict';

  /* ── Stars background (same look as main.js, kept local so this page
        doesn't have to load the homepage bundle) ── */
  (function stars() {
    const root = document.getElementById('stars');
    if (!root) return;
    for (let i = 0; i < 90; i++) {
      const s = document.createElement('div');
      const size = Math.random() < 0.25 ? 2.5 : 1.5;
      s.className = 'star';
      s.style.cssText = [
        `left:${Math.random() * 100}%`, `top:${Math.random() * 100}%`,
        `width:${size}px`, `height:${size}px`,
        `animation-duration:${2 + Math.random() * 5}s`,
        `animation-delay:${Math.random() * 5}s`,
        `background:${Math.random() < 0.1 ? '#F5C518' : '#fff'}`,
      ].join(';');
      root.appendChild(s);
    }
  })();

  /* ── FAQ accordion (same markup as service pages) ── */
  (function faq() {
    const items = Array.from(document.querySelectorAll('.faq-item'));
    function set(item, open) {
      const btn = item.querySelector('.faq-q');
      const ans = item.querySelector('.faq-a');
      if (!btn || !ans) return;
      item.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', String(open));
      ans.setAttribute('aria-hidden', String(!open));
    }
    items.forEach(item => {
      item.querySelector('.faq-q')?.addEventListener('click', () => {
        const wasOpen = item.classList.contains('open');
        items.forEach(i => set(i, false));
        if (!wasOpen) set(item, true);
      });
    });
  })();

  /* ══════════════════════════════════════════════
     Byte helpers
     ══════════════════════════════════════════════ */
  const latin1 = new TextDecoder('latin1');
  const utf8 = new TextDecoder('utf-8', { fatal: false });

  function ascii(u8, start, len) {
    let s = '';
    const end = Math.min(u8.length, start + len);
    for (let i = start; i < end; i++) s += String.fromCharCode(u8[i]);
    return s;
  }
  const u32be = (u8, p) => ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0;
  const u32le = (u8, p) => (u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16) | (u8[p + 3] << 24)) >>> 0;
  function startsWith(u8, p, str) {
    if (p + str.length > u8.length) return false;
    for (let i = 0; i < str.length; i++) if (u8[p + i] !== str.charCodeAt(i)) return false;
    return true;
  }
  function concat(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ══════════════════════════════════════════════
     AI signature detection — runs over every metadata
     block we find (removed or kept) so the report can
     say which generator/tool left its fingerprint.
     ══════════════════════════════════════════════ */
  const SIGNATURES = [
    { label: 'C2PA Content Credentials', re: /urn:c2pa|c2pa\.|c2pa_|contentauth|content credentials|jumbf|\bjumd\b|\bcai\b.*adobe/i },
    { label: 'IPTC “AI-generated” source type', re: /trainedAlgorithmicMedia|algorithmicMedia/i },
    { label: 'OpenAI / ChatGPT / DALL·E', re: /openai|chatgpt|dall[·\-\s]?e|gpt-image|gpt-4o/i },
    { label: 'Google Gemini / Imagen', re: /made with google|google ai|\bimagen\b|synthid|\bgemini\b|nano banana/i },
    { label: 'Adobe Firefly / generative fill', re: /adobe firefly|firefly image|generative fill|genai/i },
    { label: 'Midjourney', re: /midjourney/i },
    { label: 'Stable Diffusion / ComfyUI / A1111', re: /stable[\s_-]?diffusion|comfyui|automatic1111|sd-webui|fooocus|invokeai|negative prompt:|cfg scale|\bsampler:|model hash|\bsdxl\b|\bflux\.1|black forest labs/i },
    { label: 'Microsoft Designer / Bing Image Creator', re: /microsoft designer|bing image creator|image creator from/i },
    { label: 'Other AI image tool', re: /leonardo\.?ai|ideogram|recraft|\bkrea\b|runwayml|meta ai|canva magic|magic media|freepik pikaso|nightcafe|playground\.?ai|dreamstudio|tensor\.?art/i },
  ];

  function detectSignatures(text, found) {
    for (const sig of SIGNATURES) {
      if (sig.re.test(text)) found.add(sig.label);
    }
  }

  /* ── Report builder shared by all three parsers ── */
  function makeReport() {
    return {
      removed: [],      // { label, bytes }
      kept: [],         // { label, bytes }   (metadata we deliberately kept)
      detected: new Set(),
      keptWarnings: new Set(), // AI signatures that live inside a block we kept
      notes: [],
    };
  }
  function scanBlock(u8, start, end, report, kept) {
    const slice = u8.subarray(start, Math.min(end, start + 4 * 1024 * 1024));
    const text = latin1.decode(slice);
    const before = new Set(report.detected);
    detectSignatures(text, report.detected);
    if (kept) {
      for (const label of report.detected) if (!before.has(label)) report.keptWarnings.add(label);
    }
  }

  /* ══════════════════════════════════════════════
     JPEG
     ══════════════════════════════════════════════ */
  function cleanJpeg(u8, opts) {
    const report = makeReport();
    const out = [u8.subarray(0, 2)];
    const len = u8.length;
    let pos = 2;

    while (pos < len) {
      if (u8[pos] !== 0xFF) {
        // Not a marker where one should be — copy the rest untouched rather than guess.
        out.push(u8.subarray(pos));
        report.notes.push('Unexpected bytes between segments were copied unchanged.');
        pos = len;
        break;
      }
      const marker = u8[pos + 1];
      if (marker === 0xFF) { pos++; continue; }                       // fill byte
      if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
        out.push(u8.subarray(pos, pos + 2)); pos += 2; continue;       // standalone markers
      }
      if (marker === 0xD9) { out.push(u8.subarray(pos, pos + 2)); pos += 2; break; }
      if (marker === 0xDA) {
        // Start of Scan: entropy-coded data follows. Copy through EOI, drop anything after it.
        let eoi = -1;
        for (let i = pos + 2; i < len - 1; i++) {
          if (u8[i] === 0xFF && u8[i + 1] === 0xD9) { eoi = i; break; }
        }
        const end = eoi < 0 ? len : eoi + 2;
        out.push(u8.subarray(pos, end));
        if (end < len) {
          report.removed.push({ label: 'Hidden data after end-of-image', bytes: len - end });
          scanBlock(u8, end, len, report, false);
        }
        pos = len;
        break;
      }

      const segLen = (u8[pos + 2] << 8) | u8[pos + 3];
      const segEnd = pos + 2 + segLen;
      if (segLen < 2 || segEnd > len) {
        out.push(u8.subarray(pos));
        report.notes.push('A malformed segment was copied unchanged.');
        break;
      }
      const d = pos + 4; // payload start
      const decision = classifyJpegSegment(marker, u8, d, segEnd, opts);
      if (decision.keep) {
        out.push(u8.subarray(pos, segEnd));
        if (decision.label) {
          report.kept.push({ label: decision.label, bytes: segEnd - pos });
          scanBlock(u8, d, segEnd, report, true);
        }
      } else {
        report.removed.push({ label: decision.label, bytes: segEnd - pos });
        scanBlock(u8, d, segEnd, report, false);
      }
      pos = segEnd;
    }

    return { bytes: concat(out), report, mime: 'image/jpeg', ext: 'jpg' };
  }

  function classifyJpegSegment(marker, u8, d, end, opts) {
    const has = s => startsWith(u8, d, s);
    switch (marker) {
      case 0xE0: return { keep: true };                                  // JFIF / JFXX
      case 0xE1:
        if (has('Exif\0')) {
          return opts.keepExif
            ? { keep: true, label: 'EXIF (kept by your choice)' }
            : { keep: false, label: 'EXIF — camera, GPS, date, software' };
        }
        if (has('http://ns.adobe.com/xap/1.0/')) return { keep: false, label: 'XMP metadata (creator tool, AI source type)' };
        if (has('http://ns.adobe.com/xmp/extension/')) return { keep: false, label: 'Extended XMP metadata' };
        return { keep: false, label: 'APP1 metadata block' };
      case 0xE2:
        if (has('ICC_PROFILE\0')) return { keep: true };                // colour profile, keeps colours accurate
        if (has('MPF\0')) return { keep: false, label: 'MPF multi-picture index (hidden extra images)' };
        if (has('FPXR')) return { keep: false, label: 'FlashPix metadata' };
        return { keep: false, label: 'APP2 metadata block' };
      case 0xEB:
        return { keep: false, label: has('JP') ? 'C2PA / JUMBF Content Credentials' : 'APP11 metadata block' };
      case 0xEC: return { keep: false, label: 'Ducky (Adobe Save-for-Web) block' };
      case 0xED: return { keep: false, label: 'IPTC / Photoshop resources' };
      case 0xEE: return { keep: true };                                  // Adobe colour transform — decoder needs it
      case 0xFE: return { keep: false, label: 'JPEG comment' };
      default:
        if (marker >= 0xE3 && marker <= 0xEF) return { keep: false, label: `APP${marker - 0xE0} metadata block` };
        return { keep: true };                                           // DQT, DHT, SOF, DRI …
    }
  }

  /* ══════════════════════════════════════════════
     PNG
     ══════════════════════════════════════════════ */
  const PNG_KEEP = new Set([
    'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT',
    'bKGD', 'pHYs', 'hIST', 'sPLT', 'acTL', 'fcTL', 'fdAT', 'cICP', 'mDCV', 'cLLI', 'mDCv', 'cLLi',
  ]);

  async function cleanPng(u8, opts) {
    const report = makeReport();
    const out = [u8.subarray(0, 8)];
    const len = u8.length;
    let pos = 8;

    while (pos + 8 <= len) {
      const clen = u32be(u8, pos);
      const type = ascii(u8, pos + 4, 4);
      const end = pos + 12 + clen;
      if (end > len) {
        out.push(u8.subarray(pos));
        report.notes.push('A truncated chunk was copied unchanged.');
        pos = len;
        break;
      }
      const d = pos + 8;

      if (PNG_KEEP.has(type)) {
        out.push(u8.subarray(pos, end));
      } else if (type === 'eXIf') {
        if (opts.keepExif) {
          out.push(u8.subarray(pos, end));
          report.kept.push({ label: 'EXIF (kept by your choice)', bytes: end - pos });
          scanBlock(u8, d, d + clen, report, true);
        } else {
          report.removed.push({ label: 'EXIF — camera, GPS, date, software', bytes: end - pos });
          scanBlock(u8, d, d + clen, report, false);
        }
      } else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
        const text = await readPngText(u8, type, d, d + clen);
        report.removed.push({ label: pngTextLabel(type, text.keyword), bytes: end - pos });
        detectSignatures(`${text.keyword}\n${text.body}`, report.detected);
        pngKeywordHint(text.keyword, text.body, report.detected);
      } else if (type === 'caBX') {
        report.removed.push({ label: 'C2PA / JUMBF Content Credentials (caBX)', bytes: end - pos });
        scanBlock(u8, d, d + clen, report, false);
      } else if (type === 'tIME') {
        report.removed.push({ label: 'Last-modified timestamp (tIME)', bytes: end - pos });
      } else {
        report.removed.push({ label: `“${type}” chunk`, bytes: end - pos });
        scanBlock(u8, d, d + clen, report, false);
      }

      pos = end;
      if (type === 'IEND') break;
    }
    if (pos < len) {
      report.removed.push({ label: 'Hidden data after end-of-image', bytes: len - pos });
      scanBlock(u8, pos, len, report, false);
    }
    return { bytes: concat(out), report, mime: 'image/png', ext: 'png' };
  }

  function pngTextLabel(type, keyword) {
    const k = (keyword || '').trim();
    if (/^parameters$/i.test(k)) return 'Stable Diffusion prompt & settings (“parameters”)';
    if (/^(prompt|workflow)$/i.test(k)) return `ComfyUI ${k.toLowerCase()} JSON`;
    if (/^XML:com\.adobe\.xmp$/i.test(k)) return 'XMP metadata (creator tool, AI source type)';
    if (/^Raw profile type (exif|iptc|xmp)/i.test(k)) return `Embedded ${k.replace(/^Raw profile type /i, '').toUpperCase()} profile`;
    return k ? `Text chunk “${k}”` : `Text chunk (${type})`;
  }
  function pngKeywordHint(keyword, body, detected) {
    const k = (keyword || '').trim();
    if (/^parameters$/i.test(k)) detected.add('Stable Diffusion / ComfyUI / A1111');
    if (/^(prompt|workflow)$/i.test(k) && /"class_type"|"inputs"|"nodes"/.test(body)) detected.add('Stable Diffusion / ComfyUI / A1111');
    if (/^Comment$/i.test(k) && /"prompt"\s*:|"uc"\s*:/.test(body)) detected.add('Other AI image tool');
  }

  async function inflate(bytes) {
    if (typeof DecompressionStream === 'undefined') return '';
    try {
      const ds = new DecompressionStream('deflate');
      const writer = ds.writable.getWriter();
      writer.write(bytes); writer.close();
      const buf = await new Response(ds.readable).arrayBuffer();
      return utf8.decode(new Uint8Array(buf).subarray(0, 2 * 1024 * 1024));
    } catch (_) { return ''; }
  }

  async function readPngText(u8, type, d, end) {
    let i = d;
    while (i < end && u8[i] !== 0) i++;
    const keyword = latin1.decode(u8.subarray(d, i));
    i++; // NUL
    if (type === 'tEXt') return { keyword, body: latin1.decode(u8.subarray(i, Math.min(end, i + 2 * 1024 * 1024))) };
    if (type === 'zTXt') return { keyword, body: await inflate(u8.subarray(i + 1, end)) };
    // iTXt: compFlag(1) compMethod(1) lang\0 translated\0 text
    const compressed = u8[i] === 1;
    i += 2;
    while (i < end && u8[i] !== 0) i++; i++;
    while (i < end && u8[i] !== 0) i++; i++;
    const body = compressed ? await inflate(u8.subarray(i, end)) : utf8.decode(u8.subarray(i, Math.min(end, i + 2 * 1024 * 1024)));
    return { keyword, body };
  }

  /* ══════════════════════════════════════════════
     WebP (RIFF)
     ══════════════════════════════════════════════ */
  const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);

  function cleanWebp(u8, opts) {
    const report = makeReport();
    const len = u8.length;
    const chunks = [];
    let pos = 12;
    let removedExif = false, removedXmp = false;

    while (pos + 8 <= len) {
      const fourcc = ascii(u8, pos, 4);
      const size = u32le(u8, pos + 4);
      const d = pos + 8;
      const end = d + size;
      if (end > len) {
        chunks.push(u8.subarray(pos));
        report.notes.push('A truncated chunk was copied unchanged.');
        pos = len;
        break;
      }
      const padded = end + (size & 1);

      if (WEBP_KEEP.has(fourcc)) {
        chunks.push(fourcc === 'VP8X' ? u8.slice(pos, padded) : u8.subarray(pos, padded));
      } else if (fourcc === 'EXIF') {
        if (opts.keepExif) {
          chunks.push(u8.subarray(pos, padded));
          report.kept.push({ label: 'EXIF (kept by your choice)', bytes: padded - pos });
          scanBlock(u8, d, end, report, true);
        } else {
          removedExif = true;
          report.removed.push({ label: 'EXIF — camera, GPS, date, software', bytes: padded - pos });
          scanBlock(u8, d, end, report, false);
        }
      } else if (fourcc === 'XMP ') {
        removedXmp = true;
        report.removed.push({ label: 'XMP metadata (creator tool, AI source type)', bytes: padded - pos });
        scanBlock(u8, d, end, report, false);
      } else if (fourcc === 'C2PA') {
        report.removed.push({ label: 'C2PA / JUMBF Content Credentials', bytes: padded - pos });
        scanBlock(u8, d, end, report, false);
      } else {
        report.removed.push({ label: `“${fourcc.trim()}” chunk`, bytes: padded - pos });
        scanBlock(u8, d, end, report, false);
      }
      pos = Math.min(padded, len);
    }
    if (pos < len) {
      report.removed.push({ label: 'Hidden data after end-of-image', bytes: len - pos });
      scanBlock(u8, pos, len, report, false);
    }

    // Clear the EXIF / XMP feature flags in VP8X so the header matches the body.
    for (const c of chunks) {
      if (c.length >= 9 && ascii(c, 0, 4) === 'VP8X') {
        if (removedExif) c[8] &= ~0x08;
        if (removedXmp) c[8] &= ~0x04;
      }
    }

    const body = concat(chunks);
    const header = new Uint8Array(12);
    header.set([0x52, 0x49, 0x46, 0x46], 0);                   // RIFF
    const riffSize = body.length + 4;
    header[4] = riffSize & 0xFF; header[5] = (riffSize >>> 8) & 0xFF;
    header[6] = (riffSize >>> 16) & 0xFF; header[7] = (riffSize >>> 24) & 0xFF;
    header.set([0x57, 0x45, 0x42, 0x50], 8);                   // WEBP
    return { bytes: concat([header, body]), report, mime: 'image/webp', ext: 'webp' };
  }

  /* ══════════════════════════════════════════════
     Fallback: any other format the browser can decode
     (AVIF, GIF, BMP, HEIC on Safari …) is rebuilt from
     pixels into a fresh PNG. Nothing but pixels survive.
     ══════════════════════════════════════════════ */
  async function reencodeToPng(file) {
    const report = makeReport();
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch (_) {
      throw new Error('This browser cannot decode that file. Convert it to JPG or PNG first, then try again.');
    }
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const blob = await new Promise((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error('Could not encode PNG.'))), 'image/png'));
    report.removed.push({ label: 'Entire original container (rebuilt from pixels)', bytes: Math.max(0, file.size - blob.size) });
    report.notes.push('This format is rebuilt pixel-by-pixel into a new PNG, so every container-level tag is gone. Animation, HDR and the original compression are not preserved.');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { bytes, report, mime: 'image/png', ext: 'png', reencoded: true };
  }

  /* ── Format sniffing (never trust the extension) ── */
  function sniff(u8) {
    if (u8.length > 3 && u8[0] === 0xFF && u8[1] === 0xD8 && u8[2] === 0xFF) return 'jpeg';
    if (u8.length > 8 && startsWith(u8, 0, '\x89PNG\r\n\x1a\n')) return 'png';
    if (u8.length > 12 && startsWith(u8, 0, 'RIFF') && startsWith(u8, 8, 'WEBP')) return 'webp';
    return 'other';
  }

  async function processFile(file, opts) {
    const buf = await file.arrayBuffer();
    const u8 = new Uint8Array(buf);
    const kind = sniff(u8);
    let result;
    if (kind === 'jpeg') result = cleanJpeg(u8, opts);
    else if (kind === 'png') result = await cleanPng(u8, opts);
    else if (kind === 'webp') result = cleanWebp(u8, opts);
    else result = await reencodeToPng(file);

    const base = file.name.replace(/\.[^.]+$/, '') || 'image';
    const blob = new Blob([result.bytes], { type: result.mime });
    return {
      name: `${base}-clean.${result.ext}`,
      originalName: file.name,
      originalSize: file.size,
      newSize: blob.size,
      blob,
      url: URL.createObjectURL(blob),
      kind: kind === 'other' ? 'converted' : kind,
      report: result.report,
      reencoded: !!result.reencoded,
    };
  }

  /* ══════════════════════════════════════════════
     UI
     ══════════════════════════════════════════════ */
  const drop = document.getElementById('amrDrop');
  const input = document.getElementById('amrInput');
  const results = document.getElementById('amrResults');
  const list = document.getElementById('amrList');
  const summary = document.getElementById('amrSummary');
  const dlAll = document.getElementById('amrDownloadAll');
  const clearBtn = document.getElementById('amrClear');
  const errBox = document.getElementById('amrError');
  if (!drop || !input || !results || !list) return;

  const MAX_BYTES = 80 * 1024 * 1024;
  const items = [];

  const getOpts = () => ({ keepExif: document.querySelector('input[name="amrMode"]:checked')?.value === 'keep-exif' });

  function showError(msg) {
    errBox.textContent = msg;
    errBox.hidden = !msg;
  }

  function kindLabel(kind) {
    return { jpeg: 'JPG', png: 'PNG', webp: 'WebP', converted: 'Converted → PNG' }[kind] || kind;
  }

  function renderItem(item) {
    const r = item.report;
    const removedBytes = r.removed.reduce((a, b) => a + b.bytes, 0);
    const detected = Array.from(r.detected);
    const warnings = Array.from(r.keptWarnings);

    const badges = [];
    if (detected.length) {
      detected.forEach(d => badges.push(`<span class="amr-badge amr-badge--ai">${esc(d)}</span>`));
    } else if (r.removed.length) {
      badges.push('<span class="amr-badge">No known AI signature found — generic metadata removed</span>');
    } else {
      badges.push('<span class="amr-badge amr-badge--ok">Already clean — no metadata found</span>');
    }

    const removedList = r.removed.length
      ? `<ul class="amr-removed">${r.removed.map(x => `<li><span>${esc(x.label)}</span><em>${fmtBytes(x.bytes)}</em></li>`).join('')}</ul>`
      : '';
    const keptList = r.kept.length
      ? `<ul class="amr-removed amr-removed--kept">${r.kept.map(x => `<li><span>${esc(x.label)}</span><em>${fmtBytes(x.bytes)}</em></li>`).join('')}</ul>`
      : '';
    const warnHtml = warnings.length
      ? `<p class="amr-warn">Heads-up: the EXIF block you chose to keep still mentions <strong>${esc(warnings.join(', '))}</strong>. Switch to “Remove everything” and re-run this file if you want that gone too.</p>`
      : '';
    const notesHtml = r.notes.length ? `<p class="amr-note">${esc(r.notes.join(' '))}</p>` : '';

    const el = document.createElement('article');
    el.className = 'amr-item';
    el.innerHTML = `
      <div class="amr-item-thumb"><img src="${item.url}" alt="" loading="lazy" decoding="async"></div>
      <div class="amr-item-body">
        <div class="amr-item-head">
          <div>
            <p class="amr-item-name" title="${esc(item.originalName)}">${esc(item.originalName)}</p>
            <p class="amr-item-meta">${kindLabel(item.kind)} · ${fmtBytes(item.originalSize)} → ${fmtBytes(item.newSize)}${removedBytes ? ` · <span class="yl">${fmtBytes(removedBytes)} of metadata removed</span>` : ''}</p>
          </div>
          <a class="amr-btn amr-btn--dl" href="${item.url}" download="${esc(item.name)}">Download</a>
        </div>
        <div class="amr-badges">${badges.join('')}</div>
        ${removedList}${keptList}${warnHtml}${notesHtml}
      </div>`;
    return el;
  }

  function updateSummary() {
    const files = items.length;
    const blocks = items.reduce((a, i) => a + i.report.removed.length, 0);
    const bytes = items.reduce((a, i) => a + i.report.removed.reduce((x, y) => x + y.bytes, 0), 0);
    const flagged = items.filter(i => i.report.detected.size).length;
    summary.innerHTML = `
      <span><strong>${files}</strong> file${files === 1 ? '' : 's'} cleaned</span>
      <span><strong>${blocks}</strong> metadata block${blocks === 1 ? '' : 's'} removed</span>
      <span><strong>${fmtBytes(bytes)}</strong> of hidden data stripped</span>
      <span><strong>${flagged}</strong> had an AI signature</span>`;
    dlAll.hidden = files < 2;
    results.hidden = files === 0;
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []).filter(f => f && f.size > 0);
    if (!files.length) return;
    showError('');
    const opts = getOpts();
    drop.classList.add('is-busy');
    drop.setAttribute('aria-busy', 'true');

    for (const file of files) {
      if (file.size > MAX_BYTES) {
        showError(`“${file.name}” is larger than ${fmtBytes(MAX_BYTES)} and was skipped.`);
        continue;
      }
      try {
        const item = await processFile(file, opts);
        items.unshift(item);
        list.prepend(renderItem(item));
        updateSummary();
      } catch (err) {
        showError(`“${file.name}”: ${err.message || 'could not be processed.'}`);
      }
    }

    drop.classList.remove('is-busy');
    drop.setAttribute('aria-busy', 'false');
    if (items.length) results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* Inputs: click, keyboard, drag-drop, paste */
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => { handleFiles(input.files); input.value = ''; });

  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); drop.classList.add('is-over');
  }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); drop.classList.remove('is-over');
  }));
  drop.addEventListener('drop', e => handleFiles(e.dataTransfer?.files));
  document.addEventListener('paste', e => {
    const files = Array.from(e.clipboardData?.files || []).filter(f => f.type.startsWith('image/'));
    if (files.length) handleFiles(files);
  });

  dlAll.addEventListener('click', () => {
    // One click per file, spaced out so browsers don't collapse them into a single download.
    items.forEach((item, i) => {
      setTimeout(() => {
        const a = document.createElement('a');
        a.href = item.url; a.download = item.name; a.style.display = 'none';
        document.body.appendChild(a); a.click(); a.remove();
      }, i * 250);
    });
  });

  clearBtn.addEventListener('click', () => {
    items.forEach(i => URL.revokeObjectURL(i.url));
    items.length = 0;
    list.innerHTML = '';
    showError('');
    updateSummary();
    drop.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
})();
