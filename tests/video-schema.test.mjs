// Google shows a video rich result only when every VideoObject on a page has a name, a description, a
// thumbnail and an upload date. Search Console reported the blog's videos as invalid for a missing
// uploadDate, so this checks every page that carries one.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let tests = 0, bad = 0;
const ok = (cond, name) => { tests++; if (cond) { console.log(`  ✓ ${name}`); return; } bad++; console.log(`  ✗ ${name}`); };

const pages = [...readdirSync(root).filter(f => f.endsWith('.html')),
  ...readdirSync(join(root, 'blog')).filter(f => f.endsWith('.html')).map(f => `blog/${f}`),
  ...readdirSync(join(root, 'case-studies')).filter(f => f.endsWith('.html')).map(f => `case-studies/${f}`)];

const videos = (node, out = []) => {
  if (Array.isArray(node)) node.forEach(n => videos(n, out));
  else if (node && typeof node === 'object') {
    if (node['@type'] === 'VideoObject') out.push(node);
    Object.values(node).forEach(v => videos(v, out));
  }
  return out;
};

let seen = 0;
for (const f of pages) {
  const s = readFileSync(join(root, f), 'utf8');
  for (const [, json] of s.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let data; try { data = JSON.parse(json); } catch { ok(false, `${f}: structured data parses`); continue; }
    for (const v of videos(data)) {
      seen++;
      const id = (v.embedUrl || '').split('/').pop();
      ok(v.name && v.description && v.thumbnailUrl, `${f}: video ${id} has a name, description and thumbnail`);
      ok(/^\d{4}-\d{2}-\d{2}/.test(v.uploadDate || ''), `${f}: video ${id} has an uploadDate`);
      ok(!v.duration || /^PT(\d+H)?(\d+M)?(\d+S)?$/.test(v.duration), `${f}: video ${id} duration is ISO 8601`);
      ok(s.includes(`youtube.com/embed/${id}`) || s.includes(`youtube-nocookie.com/embed/${id}`) || s.includes(id), `${f}: video ${id} is on the page`);
    }
  }
}
ok(seen >= 7, `found ${seen} videos`);
console.log(bad ? `\n${bad} of ${tests} failed` : `\nall ${tests} tests passed`);
process.exit(bad ? 1 : 0);
