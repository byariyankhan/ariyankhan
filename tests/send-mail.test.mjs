// The contact form's mail handler, exercised as a real POST against a real PHP.
//
// Not a reading of the source: PHP's own built-in server runs send-mail.php exactly as the VPS does, and the
// only thing standing in for production is PHPMailer itself — a stub, prepended so the handler finds the class
// already defined and never reaches the real one, which records what would have been sent. Everything before
// that (the origin check, the spam gate, validation, the subject and the body) is the shipped code.
//
//   node tests/send-mail.test.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'ak-mail-'));
const capture = join(work, 'sent.jsonl');
const PORT = 8771;

let tests = 0, bad = 0;
const failures = [];
const ok = (cond, name) => { tests++; if (cond) { console.log(`  ✓ ${name}`); return; } bad++; failures.push(name); console.log(`  ✗ ${name}`); };
const eq = (a, b, name) => ok(a === b, `${name}${a === b ? '' : ` (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`}`);

// The stub. It declares the class the handler asks for before Composer's autoloader is ever consulted, so the
// real PHPMailer is never loaded and nothing is put on a wire.
writeFileSync(join(work, 'stub-mailer.php'), `<?php
namespace PHPMailer\\PHPMailer;
class PHPMailer {
  public $CharSet = '', $Subject = '', $Body = '', $Host = '', $Username = '', $Password = '';
  public $Port = 0, $SMTPAuth = false, $SMTPSecure = '', $Timeout = 0, $SMTPOptions = [], $ErrorInfo = '';
  private $to = [], $from = [], $replyTo = [];
  public function __construct($exceptions = false) {}
  public function isSMTP() {} public function isMail() {} public function isHTML($b) {}
  public function setFrom($a, $b = '') { $this->from = [$a, $b]; }
  public function addAddress($a, $b = '') { $this->to[] = [$a, $b]; }
  public function addReplyTo($a, $b = '') { $this->replyTo = [$a, $b]; }
  public function send() {
    file_put_contents(getenv('MAIL_CAPTURE'), json_encode([
      'subject' => $this->Subject, 'body' => $this->Body,
      'to' => $this->to, 'from' => $this->from, 'replyTo' => $this->replyTo,
    ]) . "\\n", FILE_APPEND);
    return true;
  }
}
`);

const php = spawn('php', ['-d', `auto_prepend_file=${join(work, 'stub-mailer.php')}`, '-S', `127.0.0.1:${PORT}`, '-t', root], {
  cwd: root,
  // 'mail' rather than 'smtp' so the handler needs no credentials to reach the part under test.
  env: { ...process.env, MAIL_DRIVER: 'mail', TO_EMAIL: 'inbox@example.com', MAIL_CAPTURE: capture },
  stdio: ['ignore', 'ignore', 'pipe'],
});
const serverErr = [];
php.stderr.on('data', d => serverErr.push(String(d)));

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/send-mail.php`, { method: 'GET' }); return true; } catch { await sleep(250); }
  }
  return false;
}

let seat = 0;   // the handler allows five messages an hour per address, so every case gets its own
async function post(body) {
  const r = await fetch(`http://127.0.0.1:${PORT}/send-mail.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `203.0.113.${++seat}` },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  const lines = existsSync(capture) ? readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { status: r.status, json, sent: lines.length ? JSON.parse(lines[lines.length - 1]) : null, count: lines.length };
}

const form = extra => ({
  name: 'Philippe Nesser',
  email: 'philippe@example.com',
  whatsapp: '01712345678',
  whatsappCountry: 'Bangladesh',
  whatsappRule: 'bd',
  message: 'I have a 20 minute interview that needs cutting down.',
  budget: '$500 - $1,000',
  website: '',
  t: 0,
  ...extra,
});

try {
  if (!await waitForServer()) throw new Error(`php -S did not come up on ${PORT}: ${serverErr.join('')}`);

  console.log('The subject is the short project type, then the sender');
  {
    const r = await post(form({ service: 'Talking Head Video Editing' }));
    eq(r.status, 200, 'the handler accepts a complete form');
    eq(r.json.ok, true, 'and reports it sent');
    eq(r.sent.subject, 'Talking Head - Philippe Nesser', 'the subject is exactly the example from the brief');
  }

  console.log('\nEvery option on the form has a short name');
  {
    const cases = [
      ['Talking Head Video Editing', 'Talking Head'],
      ['Documentary Video Editing', 'Documentary'],
      ['Short Form (TikTok / Reels / Shorts)', 'Short Form'],
      ['Map Animation & Geopolitical Visuals', 'Map Animation'],
      ['Color Grading Only', 'Color Grading'],
      ['Other', 'Other'],
    ];
    for (const [service, short] of cases) {
      const r = await post(form({ service, name: 'Dana Reid' }));
      eq(r.sent.subject, `${short} - Dana Reid`, `${service} → ${short}`);
    }
  }

  console.log('\nThe form and the handler agree on the wording');
  {
    const index = readFileSync(join(root, 'index.html'), 'utf8');
    const menu = index.slice(index.indexOf('id="dd1-menu"'));
    const options = [...menu.slice(0, menu.indexOf('</div>\n              </div>') + 1 || 6000)
      .matchAll(/data-dropdown-id="dd1"[\s\S]*?data-value="([^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&'));
    const php = readFileSync(join(root, 'send-mail.php'), 'utf8');
    const mapped = [...php.matchAll(/^\s*'([^']+)'\s*=>\s*'([^']+)',$/gm)].map(m => m[1]);
    ok(options.length === 6, `the form offers six project types (found ${options.length})`);
    for (const o of options) ok(mapped.includes(o), `"${o}" has a short name in send-mail.php`);
  }

  console.log('\nThe body still carries the full service name');
  {
    const r = await post(form({ service: 'Map Animation & Geopolitical Visuals' }));
    eq(r.sent.subject, 'Map Animation - Philippe Nesser', 'the subject is shortened');
    ok(r.sent.body.includes('Service:   Map Animation & Geopolitical Visuals'), 'and the body spells it out in full');
    ok(r.sent.body.includes('Name:      Philippe Nesser'), 'with the name');
    ok(r.sent.body.includes('WhatsApp:  +8801712345678'), 'and the number, normalised as before');
    ok(!r.sent.body.includes('Map Animation - '), 'the short name does not leak into the body');
  }

  console.log('\nA project type nobody has heard of, and none at all');
  {
    const odd = await post(form({ service: 'Vertical Podcast Editing', name: 'Sam Oyelaran' }));
    eq(odd.sent.subject, 'Vertical Podcast Editing - Sam Oyelaran', 'an unknown type travels as it arrived rather than being dropped');

    const none = await post(form({ service: '', name: 'Sam Oyelaran' }));
    eq(none.sent.subject, 'Sam Oyelaran', 'and with no project type the subject is just the sender');
    ok(none.sent.body.includes('Service:   —'), 'the body still shows the placeholder it always did');
  }

  console.log('\nThe rest of the handler is untouched');
  {
    const before = (await post(form({ service: 'Other' }))).count;
    const hp = await post(form({ service: 'Other', website: 'http://spam.example' }));
    eq(hp.status, 200, 'a bot that fills the honeypot is told everything is fine');
    eq(hp.count, before, 'and nothing is sent');

    const quick = await post(form({ service: 'Other', t: Date.now() }));
    eq(quick.status, 429, 'a form submitted in under three seconds is refused');

    const bademail = await post(form({ service: 'Other', email: 'not-an-email' }));
    eq(bademail.status, 400, 'an invalid email is refused');
    eq(bademail.json.error, 'Invalid email address', 'by name');

    const badnumber = await post(form({ service: 'Other', whatsapp: '12345' }));
    eq(badnumber.status, 400, 'and so is a WhatsApp number that is not one');

    const missing = await post(form({ service: 'Other', message: '' }));
    eq(missing.status, 400, 'a missing message is still required');
    eq(missing.count, before, 'none of those sent anything');
  }

  console.log('\nThe rate limit still bites');
  {
    const ip = '198.51.100.7';
    let refused = 0;
    for (let i = 0; i < 7; i++) {
      const r = await fetch(`http://127.0.0.1:${PORT}/send-mail.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
        body: JSON.stringify(form({ service: 'Other' })),
      });
      if (r.status === 429) refused++;
    }
    ok(refused >= 2, `the sixth and seventh message from one address are refused (${refused} of 7)`);
  }
} finally {
  php.kill('SIGTERM');
  rmSync(work, { recursive: true, force: true });
}

console.log(bad ? `\n${bad} of ${tests} failed: ${failures.join('; ')}` : `\nall ${tests} tests passed`);
process.exit(bad ? 1 : 0);
