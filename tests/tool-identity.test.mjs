// Map Maker, AI Metadata Remover, AI Image Checker and Travel Map are products of their own, like /puzzle/: a folder each, with the tool, a
// How to use guide, About & FAQ and Privacy, their own look and no site navigation (README: "Two tools with
// identities of their own"). This guards that shape, the one-hop redirects from the old pages, and every link.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(root, f), 'utf8');
let tests = 0, bad = 0;
const ok = (cond, name) => { tests++; if (cond) { console.log(`  ✓ ${name}`); return; } bad++; console.log(`  ✗ ${name}`); };

const TOOLS = [
  { dir: 'map-maker', css: 'css/map-maker.css', js: 'js/map-maker.js', body: 'mmk' },
  { dir: 'ai-metadata-remover', css: 'css/ai-metadata-remover.css', js: 'js/ai-metadata-remover.js', body: 'amrk' },
  { dir: 'ai-image-checker', css: 'css/ai-image-checker.css', js: 'js/ai-image-checker.js', body: 'aick' },
  { dir: 'travel-map', css: 'css/travel-map.css', js: 'js/travel-map.js', body: 'tvmk' },
];
const PAGES = ['index', 'how-to-use', 'about', 'privacy'];
const ht = read('.htaccess');
const sitemap = read('sitemap.xml');

for (const t of TOOLS) {
  console.log(`\n${t.dir}/ is a product of its own`);
  ok(existsSync(join(root, t.dir, 'icon.svg')) && existsSync(join(root, t.dir, 'og.png')), 'it has its own logo and share image');
  ok(!existsSync(join(root, `${t.dir}.html`)), `the old ${t.dir}.html is gone`);
  for (const p of PAGES) {
    const f = `${t.dir}/${p}.html`;
    if (!existsSync(join(root, f))) { ok(false, `${f} exists`); continue; }
    const s = read(f);
    const url = `https://ariyankhan.com/${t.dir}/${p === 'index' ? '' : p + '.html'}`;
    ok(!/<site-nav|<site-footer|css\/style\.css|site-nav\.js|site-footer\.js/.test(s), `${f}: no site navigation, footer or site stylesheet`);
    ok(s.includes(`href="/${t.css}?v=`) && (s.match(/rel="stylesheet" href="\/css\//g) || []).length === 1, `${f}: loads its own stylesheet and no other`);
    ok(s.includes(`<body class="${t.body}">`) && s.includes(`class="${t.body}-bar"`) && s.includes(`class="${t.body}-foot"`), `${f}: its own header and footer`);
    ok(s.includes(`<link rel="canonical" href="${url}" />`), `${f}: canonical is ${url}`);
    ok(s.includes(`href="/${t.dir}/icon.svg"`) && s.includes(`https://ariyankhan.com/${t.dir}/og.png`), `${f}: its own favicon and share image`);
    ok((s.match(/<h1\b/g) || []).length === 1, `${f}: one h1`);
    let ld = null; try { ld = JSON.parse(s.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]); } catch {}
    ok(ld && ld['@graph'].some(n => n['@type'] === 'BreadcrumbList'), `${f}: structured data parses, with a breadcrumb`);
    ok(!/href="(?!\/|https?:|#|mailto:)/.test(s) && !/src="(?!\/|https?:|data:)/.test(s), `${f}: every link and asset path is root-absolute (the page is a folder deep)`);
    for (const [, href] of s.matchAll(/href="(\/[^"#?]*)/g)) {
      const target = href.endsWith('/') ? join(root, href, 'index.html') : join(root, href);
      if (!existsSync(target) && href !== '/') ok(false, `${f}: link ${href} resolves`);
    }
    ok(sitemap.includes(`<loc>${url}</loc>`), `${f}: listed in the sitemap`);
  }
  const index = read(`${t.dir}/index.html`);
  ok(index.includes(`src="/${t.js}?v=`), `the tool page loads /${t.js}`);
  ok(!/<[a-z][^>]*\sstyle="/i.test(PAGES.map(p => read(`${t.dir}/${p}.html`)).join('')), 'no inline style attribute (the CSP refuses them)');
  ok(!/<[a-z][^>]*\sstyle="/i.test(read(t.js)), `${t.js} writes no style="" into markup either`);
  ok(new RegExp(`^RewriteRule \\^${t.dir.replace(/-/g, '\\-').replace(/\\-/g, '-')}\\(\\?:\\\\\\.html\\)\\?\\$ +https://%\\{ENV:TOOL_HOST\\}/${t.dir}/ \\[R=301,L,NE\\]$`, 'm').test(ht),
    `/${t.dir}.html and /${t.dir} 301 to /${t.dir}/`);
}

console.log('\nThe redirects are one hop from any variant');
const first = ht.indexOf('RewriteRule ^map-maker');
ok(/^RewriteCond %\{HTTP_HOST\} \^\(\?:www\\\.\|youtube\\\.\)\?\(\.\+\)\$ \[NC\]\nRewriteRule \^\(\?:map-maker\|ai-metadata-remover\|ai-image-checker\|travel-map\)\(\?:\\\.html\)\?\$ - \[E=TOOL_HOST:%1\]$/m.test(ht), 'the target host is the canonical one');
ok(first > 0 && first < ht.indexOf('RewriteRule ^ https://%1%{REQUEST_URI}') && first < ht.indexOf('RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI}'), 'and the rules run before the www and HTTPS rules');
ok(!/\/map-maker\.html|\/ai-metadata-remover\.html/.test(sitemap), 'the sitemap has no old address');

console.log('\nNothing links to the old addresses');
const ALLOWED = new Set();
const SKIP = new Set(['.git', 'node_modules', 'tests', 'deploy', 'vendor', 'android', 'images']);
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (!SKIP.has(name)) walk(p); } else if (/\.(html|php|js|mjs|txt|xml|json|webmanifest)$/.test(name)) files.push(p);
  }
})(root);
const old = /(?:^|["'(\s/=])(?:map-maker|ai-metadata-remover|ai-image-checker|travel-map)\.html/m;
const linking = files.map(p => relative(root, p)).filter(f => !ALLOWED.has(f) && old.test(readFileSync(join(root, f), 'utf8')));
ok(linking.length === 0, linking.length ? `no links to the old pages — found in: ${linking.join(', ')}` : `none of ${files.length} files links to an old address`);
ok(/href="\$\{root\}map-maker\/"/.test(read('js/site-footer.js')) && /href="\$\{root\}ai-metadata-remover\/"/.test(read('js/site-footer.js')), 'the site footer links to the folders');
ok(read('index.html').includes('href="/map-maker/"') && read('index.html').includes('href="/ai-metadata-remover/"'), 'the homepage has a card for each tool');

console.log(bad ? `\n${bad} of ${tests} failed` : `\nall ${tests} tests passed`);
process.exit(bad ? 1 : 0);
