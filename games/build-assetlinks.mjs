// The file that makes the Android app's address bar disappear.
//
//   node games/build-assetlinks.mjs AA:BB:CC:...:FF
//
// A Trusted Web Activity is only trusted if the SITE says so. This writes .well-known/assetlinks.json naming
// the app and the SHA-256 of the certificate it is signed with — and that certificate is the one Play App
// Signing holds, not the upload key, so the fingerprint comes from:
//
//   Play Console → Test and release → Setup → App signing → App signing key certificate → SHA-256
//
// Until this file is live with the right fingerprint the app still works; it simply shows the address bar,
// and https://ariyankhan.com/puzzle/ links open in the browser rather than in the app.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const PACKAGE = 'com.ariyankhan.puzzle';
const OUT = path.join(ROOT, '.well-known', 'assetlinks.json');

const raw = (process.argv[2] || '').trim().toUpperCase().replace(/\s/g, '');
if (!/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(raw)) {
  console.error(`Give it the SHA-256 fingerprint, the way Play Console prints it:\n
  node games/build-assetlinks.mjs 1A:2B:3C:...:FF        (32 pairs, colon separated)\n
Play Console → Test and release → Setup → App signing → App signing key certificate.`);
  process.exit(1);
}

// Two entries, because two things are being trusted with the same file: the app, and Chrome's own check that
// the app may handle https://ariyankhan.com/puzzle links without asking.
const doc = [{
  relation: ['delegate_permission/common.handle_all_urls'],
  target: { namespace: 'android_app', package_name: PACKAGE, sha256_cert_fingerprints: [raw] },
}];

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n');
console.log(`wrote ${path.relative(ROOT, OUT)} for ${PACKAGE}`);
console.log('deploy the site, then check: https://ariyankhan.com/.well-known/assetlinks.json');
