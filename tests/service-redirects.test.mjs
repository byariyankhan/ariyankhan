// Only the four main service pages are service pages. Everything that lived under /service/ was deleted and
// 301s to one of them from the top of the root .htaccess (service/README.md has the map and the reasons).
// The redirects themselves are checked against a real Apache before a deploy; this guards the shape of it, so
// a tidy-up cannot quietly drop a rule, put a removed page back in the sitemap, or link to a URL that redirects.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(root, f), 'utf8');
let tests = 0, bad = 0;
const ok = (cond, name) => { tests++; if (cond) { console.log(`  ✓ ${name}`); return; } bad++; console.log(`  ✗ ${name}`); };

const MAIN = ['talking-head-video-editing.html', 'documentary-video-editing.html', 'short-form-video-editing.html', 'map-animation-video-editing.html'];
const [TH, DOC, SF, MA] = MAIN;
const REDIRECTS = {
  'corporate-video-editing': TH,
  'remote-video-editor': TH,
  'video-editor-for-authors-and-speakers': TH,
  'video-editor-for-coaches': TH,
  'video-editor-for-finance-and-investing-channels': TH,
  'video-editor-for-founders': TH,
  'video-editor-for-healthcare-professionals': TH,
  'video-editor-for-podcasters': TH,
  'video-editor-for-real-estate-agents': TH,
  'video-editor-for-business-documentary-channels': DOC,
  'video-editor-for-faceless-youtube-channels': DOC,
  'video-editor-for-nonprofit-organizations': DOC,
  'video-editor-for-true-crime-youtube-channels': DOC,
  'video-editor-for-wildlife-and-nature-documentaries': DOC,
  'video-editor-for-fitness-creators': SF,
  'video-editor-for-social-media-promo-clips': SF,
  'video-editor-for-economics-and-trade-explainer-channels': MA,
  'video-editor-for-geography-and-country-explainer-channels': MA,
  'video-editor-for-history-and-geopolitics-channels': MA,
  'video-editor-for-military-history-channels': MA,
};
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ht = read('.htaccess');

console.log('The four main service pages are there, and nothing else is in /service/');
for (const page of MAIN) ok(existsSync(join(root, page)), `${page} exists`);
ok(readdirSync(join(root, 'service')).join() === 'README.md', 'service/ holds only its README');

console.log('\nEvery old /service/ URL has its 301, straight to its main page');
const rule = (pattern, target) =>
  new RegExp(`^RewriteRule ${esc(pattern)} +https://%\\{ENV:SERVICE_HOST\\}/${esc(target)} \\[R=301,L,NE\\]$`, 'm').test(ht);
ok(rule('^service/?$', TH), '/service/ → talking head');
ok(rule('^service/index\\.(?:php|html)$', TH), '/service/index.php → talking head');
for (const [slug, target] of Object.entries(REDIRECTS)) ok(rule(`^service/${slug}\\.html$`, target), `${slug} → ${target}`);
ok((ht.match(/^RewriteRule \^service\//gm) || []).length === Object.keys(REDIRECTS).length + 2, 'and there are no other /service/ rules');
ok(/^RewriteCond %\{HTTP_HOST\} \^\(\?:www\\\.\|youtube\\\.\)\?\(\.\+\)\$ \[NC\]\nRewriteRule \^service\(\?:\/\|\$\) - \[E=SERVICE_HOST:%1\]$/m.test(ht),
  'the target host is the canonical one (www. and youtube. stripped)');
const first = ht.indexOf('RewriteRule ^service/?$');
ok(first > ht.indexOf('RewriteEngine On'), 'the rules come after RewriteEngine On');
ok(first < ht.indexOf('RewriteRule ^ https://%1%{REQUEST_URI}') && first < ht.indexOf('RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI}'),
  'and before the www and HTTPS rules, so http://www.… is still one hop');
for (const slug of Object.keys(REDIRECTS)) if (existsSync(join(root, `service/${slug}.html`))) ok(false, `service/${slug}.html is deleted`);
ok(!existsSync(join(root, 'service/index.php')) && !existsSync(join(root, 'service/css')), 'the folder index and its stylesheet are gone');

console.log('\nThe sitemap and the llms files list only the main service pages');
for (const f of ['sitemap.xml', 'llms.txt', 'llms-full.txt']) ok(!/ariyankhan\.com\/service\b/.test(read(f)), `${f} has no /service/ URL`);
const sitemap = read('sitemap.xml');
for (const page of MAIN) ok(sitemap.includes(`<loc>https://ariyankhan.com/${page}</loc>`), `the sitemap lists ${page}`);

console.log('\nNo internal link goes through one of those redirects');
const SKIP = new Set(['.git', 'node_modules', 'tests', 'deploy', 'vendor', 'android', 'images']);
const TEXT = /\.(html|php|js|mjs|txt|xml|json|webmanifest|css)$/;
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (!SKIP.has(name)) walk(p); } else if (TEXT.test(name)) files.push(p);
  }
})(root);
const slugs = Object.keys(REDIRECTS).map(esc).join('|');
const pageLink = new RegExp(`service/(?:${slugs}|index)\\.(?:html|php)`);
const dirLink = /(?:href|src|action)=["'](?:\.\.\/|\/|https?:\/\/(?:www\.)?ariyankhan\.com\/)?service\/?["'#?]|https?:\/\/(?:www\.)?ariyankhan\.com\/service(?:[/"'\s)#?]|$)/m;
const linking = files.filter(p => { const s = readFileSync(p, 'utf8'); return pageLink.test(s) || dirLink.test(s); }).map(p => relative(root, p));
ok(files.length > 50, `scanned ${files.length} pages, scripts and text files`);
ok(linking.length === 0, linking.length ? `no links to redirected URLs — found in: ${linking.join(', ')}` : 'none of them links to a redirected URL');

console.log(bad ? `\n${bad} of ${tests} failed` : `\nall ${tests} tests passed`);
process.exit(bad ? 1 : 0);
