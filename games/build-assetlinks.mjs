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

// Every fingerprint the app may reach a phone signed with. Play App Signing hands out three certificates,
// and which one matters is not the one the console shows first:
//
//   deployment_cert        signs the APKs Play actually delivers -- this is the one Chrome checks
//   hybrid_classical_cert  the classical half of the quantum-ready pair
//   hybrid_pqc_cert        the post-quantum half
//
// Listing only the hybrid classical one is what left the app with an address bar: it verified against
// nothing, because nothing on the device was signed with it. They all go in; the field is an array, an
// unused fingerprint costs nothing, and a rotation that starts using one of the others cannot break trust.
//
//   node games/build-assetlinks.mjs AA:BB:... CC:DD:... EE:FF:...
//
// Download them from Play Console -> Protected with Play -> App signing -> Download certificate, and read
// each one with: keytool -printcert -file deployment_cert.der
const raw = process.argv.slice(2).map(a => a.trim().toUpperCase().replace(/\s/g, '')).filter(Boolean);
const bad = raw.filter(f => !/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(f));
if (!raw.length || bad.length) {
  console.error(`Give it the SHA-256 fingerprints, the way keytool prints them:\n
  node games/build-assetlinks.mjs 1A:2B:...:FF [more...]   (32 pairs each, colon separated)\n
Play Console → Protected with Play → App signing → Download certificate, then
  keytool -printcert -file deployment_cert.der`);
  if (bad.length) console.error(`\nnot a SHA-256 fingerprint: ${bad.join(', ')}`);
  process.exit(1);
}

// Two entries, because two things are being trusted with the same file: the app, and Chrome's own check that
// the app may handle https://ariyankhan.com/puzzle links without asking.
const doc = [{
  relation: ['delegate_permission/common.handle_all_urls'],
  target: { namespace: 'android_app', package_name: PACKAGE, sha256_cert_fingerprints: raw },
}];

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n');
console.log(`wrote ${path.relative(ROOT, OUT)} for ${PACKAGE} with ${raw.length} fingerprint${raw.length === 1 ? '' : 's'}`);
console.log('deploy the site, then check: https://ariyankhan.com/.well-known/assetlinks.json');
