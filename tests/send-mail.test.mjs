// The contact form's mail handler, exercised as a real POST against a real PHP.
//
// Not a reading of the source: PHP's own built-in server runs send-mail.php exactly as the VPS does, and the
// only thing standing in for production is PHPMailer itself — a stub, prepended so the handler finds the class
// already defined and never reaches the real one, which records what would have been sent. Everything before
// that (the origin check, the spam gate, validation, the subject, the addresses and the body) is the shipped
// code. Each block starts its own server with its own environment, because how the handler is configured is
// half of what is being tested.
//
//   node tests/send-mail.test.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'ak-mail-'));
const stub = join(work, 'stub-mailer.php');

let tests = 0, bad = 0;
const failures = [];
const ok = (cond, name) => { tests++; if (cond) { console.log(`  ✓ ${name}`); return; } bad++; failures.push(name); console.log(`  ✗ ${name}`); };
const eq = (a, b, name) => ok(a === b, `${name}${a === b ? '' : ` (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`}`);

// The stub. It declares the class the handler asks for before Composer's autoloader is ever consulted, so the
// real PHPMailer is never loaded and nothing is put on a wire. It records the addresses and the credentials it
// was handed, which is how the difference between "who we sign in as" and "who the mail is from" is asserted.
writeFileSync(stub, `<?php
namespace PHPMailer\\PHPMailer;
class PHPMailer {
  // The handler picks one of these by port; without them the SMTP path throws before it sends anything.
  const ENCRYPTION_STARTTLS = 'tls';
  const ENCRYPTION_SMTPS = 'ssl';
  public $CharSet = '', $Subject = '', $Body = '', $Host = '', $Username = '', $Password = '';
  public $Port = 0, $SMTPAuth = false, $SMTPSecure = '', $Timeout = 0, $SMTPOptions = [], $ErrorInfo = '';
  private $to = [], $from = [], $replyTo = [], $transport = 'none';
  public function __construct($exceptions = false) {}
  public function isSMTP() { $this->transport = 'smtp'; }
  public function isMail() { $this->transport = 'mail'; }
  public function isHTML($b) {}
  public function setFrom($a, $b = '') { $this->from = [$a, $b]; }
  public function addAddress($a, $b = '') { $this->to[] = [$a, $b]; }
  public function addReplyTo($a, $b = '') { $this->replyTo = [$a, $b]; }
  public function send() {
    file_put_contents(getenv('MAIL_CAPTURE'), json_encode([
      'subject' => $this->Subject, 'body' => $this->Body,
      'to' => $this->to, 'from' => $this->from, 'replyTo' => $this->replyTo,
      'transport' => $this->transport,
      'smtp' => ['host' => $this->Host, 'user' => $this->Username, 'pass' => $this->Password,
                 'port' => $this->Port, 'auth' => $this->SMTPAuth, 'secure' => $this->SMTPSecure],
    ]) . "\\n", FILE_APPEND);
    return true;
  }
}
`);

const sleep = ms => new Promise(r => setTimeout(r, ms));
let seat = 0;

// A port the OS says is free, rather than a number picked in advance: a run that was interrupted can leave a
// server holding one, and the next run would then talk to *that* server — with the previous run's environment,
// which is a confusing way to fail.
const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

// The handler's rate limit is keyed by address and remembered in the temp directory for an hour, so a run that
// reused last run's addresses would start out already refused. Every run gets its own private /24.
const RUN = [Math.floor(Math.random() * 254) + 1, Math.floor(Math.random() * 254) + 1];
const ipFor = n => `10.${RUN[0]}.${RUN[1]}.${(n % 250) + 1}`;

/** A server with one environment, a place for it to record what it "sent", and a way to post to it. */
async function withServer(env, fn) {
  const port = await freePort();
  const capture = join(work, `sent-${port}.jsonl`);
  const php = spawn('php', ['-d', `auto_prepend_file=${stub}`, '-S', `127.0.0.1:${port}`, '-t', root], {
    cwd: root,
    env: { ...process.env, MAIL_CAPTURE: capture, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const err = [];
  let dead = false;
  php.stderr.on('data', d => err.push(String(d)));
  php.on('exit', () => { dead = true; });
  const base = `http://127.0.0.1:${port}/send-mail.php`;

  try {
    let up = false;
    for (let i = 0; i < 60 && !up && !dead; i++) {
      try { await fetch(base); up = true; } catch { await sleep(250); }
    }
    if (!up) throw new Error(`php -S did not come up on ${port}: ${err.join('') || 'it exited without saying why'}`);

    // The handler allows five messages an hour per address, so every request gets its own.
    const post = async body => {
      const r = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ipFor(++seat) },
        body: JSON.stringify(body),
      });
      // A body that is not JSON means PHP fell over before the handler could answer, and the reason is on
      // the server's stderr — worth showing, because the alternative is a bare 500 and a guess.
      const raw = await r.text();
      let json = {};
      try { json = JSON.parse(raw); }
      catch { console.log(`  … PHP did not answer with JSON: ${raw.slice(0, 200)}\n    ${err.join('').trim().split('\n').slice(-3).join('\n    ')}`); }
      const lines = existsSync(capture) ? readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean) : [];
      return { status: r.status, json, sent: lines.length ? JSON.parse(lines[lines.length - 1]) : null, count: lines.length };
    };
    await fn({ post, base });
  } finally {
    php.kill('SIGTERM');
  }
}

const form = extra => ({
  name: 'Philippe Nesser',
  email: 'philippe@example.com',
  whatsapp: '01712345678',
  whatsappCountry: 'Bangladesh',
  whatsappRule: 'bd',
  message: 'I have a 20 minute interview that needs cutting down.',
  service: 'Talking Head Video Editing',
  budget: '$500 - $1,000',
  website: '',
  t: 0,
  ...extra,
});

// What the VPS passes the container when the relay is in use. No real key: the point is which value lands
// where, and a made-up one proves that as well as a real one would — better, since it is safe to commit.
const RELAY = {
  MAIL_DRIVER: 'smtp',
  TO_EMAIL: 'hi@ariyankhan.com',
  FROM_EMAIL: 'no-reply@ariyankhan.com',
  FROM_NAME: 'ariyankhan.com',
  SMTP_HOST: 'smtp-relay.brevo.com',
  SMTP_USER: 'b000000001@smtp-brevo.com',
  SMTP_PASS: 'not-a-real-key',
  SMTP_PORT: '587',
};

try {
  await withServer(RELAY, async ({ post, base }) => {
    console.log('The relay signs in as itself; the message is from the site');
    {
      const r = await post(form());
      eq(r.status, 200, `the handler accepts a complete form${r.status === 200 ? '' : `: ${r.json.error}`}`);

      eq(r.sent.smtp.user, RELAY.SMTP_USER, 'SMTP authenticates as SMTP_USER');
      eq(r.sent.smtp.pass, RELAY.SMTP_PASS, 'with SMTP_PASS');
      eq(r.sent.smtp.host, RELAY.SMTP_HOST, 'against SMTP_HOST');
      eq(r.sent.smtp.port, 587, 'on SMTP_PORT');
      eq(r.sent.smtp.auth, true, 'and it does authenticate');
      eq(r.sent.smtp.secure, 'tls', 'with STARTTLS, which is what port 587 means');
      eq(r.sent.transport, 'smtp', 'over SMTP rather than the local sendmail');

      eq(r.sent.from[0], RELAY.FROM_EMAIL, 'the message is From FROM_EMAIL');
      ok(r.sent.from[0] !== RELAY.SMTP_USER, 'which is not the account it signed in as — the bug this replaces');
      eq(r.sent.from[1], 'Philippe Nesser', "under the visitor's name, which is what an inbox list shows");
      eq(r.sent.from[1], r.sent.replyTo[1], 'the same name the reply would go to');

      eq(r.sent.to[0][0], RELAY.TO_EMAIL, 'it is addressed To the inbox');
      eq(r.sent.replyTo[0], 'philippe@example.com', "and Reply-To is the visitor's own address");
      eq(r.sent.replyTo[1], 'Philippe Nesser', 'under their name, so a reply reaches them and not this site');

      // The name is free text; the address is the part every receiving server checks. One must never follow
      // the other, or a visitor could decide what domain this site claims to send from.
      const other = await post(form({ name: 'Dana Reid', email: 'dana@example.com' }));
      eq(other.sent.from[1], 'Dana Reid', 'a different visitor puts a different name on it');
      eq(other.sent.from[0], RELAY.FROM_EMAIL, 'and never a different address');
    }

    console.log('\nThe subject is unchanged by any of that');
    {
      const r = await post(form());
      eq(r.sent.subject, 'Talking Head - Philippe Nesser', 'the short project type, then the sender');
      const cases = [
        ['Talking Head Video Editing', 'Talking Head'],
        ['Documentary Video Editing', 'Documentary'],
        ['Short Form (TikTok / Reels / Shorts)', 'Short Form'],
        ['Map Animation & Geopolitical Visuals', 'Map Animation'],
        ['Color Grading Only', 'Color Grading'],
        ['Other', 'Other'],
      ];
      for (const [service, short] of cases) {
        const one = await post(form({ service, name: 'Dana Reid' }));
        eq(one.sent.subject, `${short} - Dana Reid`, `${service} → ${short}`);
      }
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

    console.log('\nThe gate in front of all this is untouched');
    {
      const before = (await post(form())).count;
      const hp = await post(form({ website: 'http://spam.example' }));
      eq(hp.status, 200, 'a bot that fills the honeypot is told everything is fine');
      eq(hp.count, before, 'and nothing is sent');

      eq((await post(form({ t: Date.now() }))).status, 429, 'a form submitted in under three seconds is refused');
      const bademail = await post(form({ email: 'not-an-email' }));
      eq(bademail.status, 400, 'an invalid email is refused');
      eq(bademail.json.error, 'Invalid email address', 'by name');
      eq((await post(form({ whatsapp: '12345' }))).status, 400, 'and so is a WhatsApp number that is not one');
      eq((await post(form({ message: '' }))).status, 400, 'a missing message is still required');
      eq((await post(form())).count, before + 1, 'none of those sent anything');
    }

    console.log('\nThe rate limit still bites');
    {
      let refused = 0;
      for (let i = 0; i < 7; i++) {
        const r = await fetch(base, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ipFor(251) },   // one address, on purpose
          body: JSON.stringify(form()),
        });
        if (r.status === 429) refused++;
      }
      ok(refused >= 2, `the sixth and seventh message from one address are refused (${refused} of 7)`);
    }
  });

  // ── What the health check asks, from the other side ──
  //
  // `health` in .github/scripts/puzzle-vps.sh POSTs the honeypot value and wants a 200. That only works
  // because the handler checks its own configuration *before* the honeypot short-circuits. These blocks hold
  // that contract up: a container missing a setting must answer 500, and a complete one must answer 200
  // without sending anything.
  const honeypot = { website: 'health-check' };

  console.log('\nThe health check can tell a configured container from a broken one');
  await withServer(RELAY, async ({ post }) => {
    const r = await post(honeypot);
    eq(r.status, 200, 'fully configured: the health check gets its 200');
    eq(r.json.ok, true, 'reported as fine');
    eq(r.count, 0, 'and no mail was sent to find that out');
  });

  for (const [missing, label] of [
    ['TO_EMAIL', 'no inbox to deliver to'],
    ['FROM_EMAIL', 'no address to send from'],
    ['SMTP_HOST', 'no relay'],
    ['SMTP_USER', 'no relay account'],
    ['SMTP_PASS', 'no relay key'],
  ]) {
    await withServer({ ...RELAY, [missing]: '' }, async ({ post }) => {
      const r = await post(honeypot);
      eq(r.status, 500, `${missing} empty → 500 (${label})`);
      eq(r.json.error, 'Mail service is not configured', 'with the message the health check prints');
      eq(r.count, 0, 'and nothing sent');
    });
  }

  console.log('\nWithout a relay the site sends to itself, and needs no sender configured');
  await withServer({ MAIL_DRIVER: 'mail', TO_EMAIL: 'hi@ariyankhan.com' }, async ({ post }) => {
    const r = await post(form());
    eq(r.status, 200, 'the local sendmail path still works with only an inbox set');
    eq(r.sent.transport, 'mail', 'and it does not try to reach a relay');
    eq(r.sent.from[0], 'hi@ariyankhan.com', 'the inbox address is a truthful sender when there is no relay');
    eq(r.sent.replyTo[0], 'philippe@example.com', 'the visitor is still the Reply-To');
  });

  // ── The plumbing that carries those settings to the container ──
  console.log('\nThe settings reach the container');
  {
    const compose = readFileSync(join(root, 'deploy/docker-compose.yml'), 'utf8');
    const standalone = readFileSync(join(root, 'deploy/docker-compose.standalone.yml'), 'utf8');
    const entry = readFileSync(join(root, 'deploy/web-entrypoint.sh'), 'utf8');
    const php = readFileSync(join(root, 'send-mail.php'), 'utf8');
    const ops = readFileSync(join(root, '.github/scripts/puzzle-vps.sh'), 'utf8');

    for (const v of ['TO_EMAIL', 'FROM_EMAIL', 'FROM_NAME', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']) {
      ok(new RegExp(`^\\s+${v}: \\$\\{${v}`, 'm').test(compose), `docker-compose.yml passes ${v} through`);
      ok(new RegExp(`^\\s+${v}: \\$\\{${v}`, 'm').test(standalone), `the standalone compose passes ${v} through`);
    }
    for (const k of ['from_email', 'from_name']) ok(entry.includes(`"${k}"`), `the entrypoint writes ${k} into the config file`);
    ok(/FROM_EMAIL FROM_NAME/.test(ops), 'inspect reports on the new settings too');

    // No credential may be committed, whatever else changes here.
    ok(!/smtp-brevo\.com['"]?\s*[,;)]/.test(php) && !php.includes('xsmtpsib'), 'send-mail.php hardcodes no relay account or key');
    // A credential written into the file rather than taken from the environment: the key must be assigned an
    // interpolation and nothing else. (Anchored to the start of the line — `${SMTP_PASS:-}` contains the text
    // "SMTP_PASS:" itself, which a loose pattern matches against the very syntax that makes it safe.)
    const hardcoded = /^\s*(SMTP_PASS|SMTP_USER):\s*(?!\$\{)\S/m;
    for (const [f, src] of [['docker-compose.yml', compose], ['the standalone compose', standalone], ['the entrypoint', entry]]) {
      ok(!hardcoded.test(src) && !src.includes('xsmtpsib'), `${f} carries no key of its own`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(bad ? `\n${bad} of ${tests} failed: ${failures.join('; ')}` : `\nall ${tests} tests passed`);
process.exit(bad ? 1 : 0);
