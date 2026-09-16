// youtube.ariyankhan.com is the same container as the main site, routed by host in the root .htaccess.
// The routing itself is checked against a real Apache before every deploy; this guards the shape of it, so a
// tidy-up (or a file re-uploaded under the folder's old, spaced name) cannot quietly take the subdomain down.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(root, f), 'utf8');
let tests = 0, bad = 0;
const ok = (cond, name) => { tests++; if (cond) { console.log(`  ✓ ${name}`); return; } bad++; console.log(`  ✗ ${name}`); };

const ht = read('.htaccess');
const nginx = read('deploy/nginx-ariyankhan.conf');

console.log('The subdomain has somewhere to serve from');
ok(existsSync(join(root, 'youtube/index.php')), 'the smart opener is at youtube/index.php');
ok(existsSync(join(root, 'youtube/spain.php')), 'the Spain page is at youtube/spain.php');
ok(existsSync(join(root, 'youtube/robots.txt')) && existsSync(join(root, 'youtube/sitemap.xml')), 'it has its own robots.txt and sitemap.xml');
ok(existsSync(join(root, 'youtube/assets/spain-thumbnail.png')), 'and the thumbnail the Spain page points at');
ok(!existsSync(join(root, 'Youtube Ariyan Khan')), 'the old folder name with spaces in it is gone');

console.log('\nThe host routing is still in .htaccess');
ok(/RewriteCond %\{HTTP_HOST\} \^youtube\\\. \[NC\]\s*\nRewriteRule \^\$ youtube\/index\.php \[END\]/.test(ht), 'the subdomain root serves youtube/index.php');
ok(/RewriteCond %\{DOCUMENT_ROOT\}\/youtube\/\$1 -f/.test(ht), 'a real file in the folder is served as it stands');
ok(/RewriteCond %\{DOCUMENT_ROOT\}\/youtube\/\$1\.php -f/.test(ht), '/spain finds spain.php, so the canonical URLs carry no extension');
ok(/RewriteRule \^\(\.\+\)\\\.php\$ https:\/\/%\{HTTP_HOST\}\/\$1 \[R=301,L,NE\]/.test(ht), 'and /spain.php redirects to /spain rather than answering twice');
ok(/RewriteCond %\{HTTP_HOST\} \^youtube\\\. \[NC\]\s*\nRewriteRule \^ - \[R=404,END\]/.test(ht), 'anything the folder does not hold is a 404, not the main site');
ok(/^RewriteRule \^youtube\(\/\|\$\) - \[R=404,L\]$/m.test(ht), 'and on the main site /youtube is a 404, so nothing is indexed twice');
ok((ht.match(/\[END\]/g) || []).length >= 4, 'the rules end with [END], which is what stops an internal rewrite looping back');

console.log('\nThe subdomain is not handed two of every security header');
ok(/<If "%\{HTTP_HOST\} =~ \/\^youtube\\\.\/i">/.test(ht), 'there is a host-scoped header block');
for (const h of ['Content-Security-Policy', 'X-Frame-Options', 'Referrer-Policy', 'Permissions-Policy'])
  ok(new RegExp(`Header always unset ${h}`).test(ht), `the main site's ${h} is dropped, because the pages set their own`);

console.log('\nThe pages do set their own');
for (const f of ['youtube/index.php', 'youtube/spain.php']) {
  const src = read(f);
  ok(/header\(\s*$/m.test(src) || /Content-Security-Policy/.test(src), `${f} sends a Content-Security-Policy`);
  ok(/nonce/.test(src), `${f} uses a nonce rather than 'unsafe-inline'`);
}

console.log('\nThe VPS knows the name');
ok(/server_name .*\byoutube\.ariyankhan\.com\b/.test(nginx), 'nginx answers for youtube.ariyankhan.com');
ok(/certbot .*-d youtube\.ariyankhan\.com/.test(nginx), 'and the certificate command covers it');

console.log('\nThe subdomain talks about itself, not the main site');
ok(read('youtube/robots.txt').includes('https://youtube.ariyankhan.com/sitemap.xml'), 'robots.txt points at its own sitemap');
ok(!/ariyankhan\.com\/(?!$)/.test(read('youtube/sitemap.xml').replace(/youtube\.ariyankhan\.com/g, '')), 'the sitemap lists only subdomain URLs');

console.log(bad ? `\n${bad} of ${tests} failed` : `\nall ${tests} tests passed`);
process.exit(bad ? 1 : 0);
