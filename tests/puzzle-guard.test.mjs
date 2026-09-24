// The client's half of closing the ways round the game (the server's is games/puzzle/tests): a result the
// server calls too early is sent again when it says, not dropped; advertisement gold is claimed with a ticket
// asked for first; the league never promises a prize the settlement will not pay; and the delete confirmation
// says what a new account starts with.
// Run: node tests/puzzle-guard.test.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
const root = path.resolve(new URL('.', import.meta.url).pathname, '..');
const js = fs.readFileSync(path.join(root, 'js/puzzle.js'), 'utf8');
const privacy = fs.readFileSync(path.join(root, 'puzzle/privacy.html'), 'utf8');
// Pull the exact production pieces out of the IIFE, as tests/puzzle.test.mjs does.
const grab = re => { const m = js.match(re); if (!m) throw new Error('could not find ' + re); return m[0]; };

let tests = 0;
const pending = [];
const test = (name, fn) => {
  tests++;
  const run = (async () => { try { await fn(); console.log('  ✓ ' + name); } catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; } })();
  pending.push(run);
  return run;
};

// ── The result sender ──
const senderSrc = [grab(/const tooEarlyWait = [^\n]+/), grab(/async function sendResult\(code, ms, cleared, gaveUp = false\) \{[\s\S]*?\n  \}\n/)].join('\n');
/** sendResult over a scripted server: each call takes the next answer; waits are recorded, not slept. */
function sender(answers) {
  const calls = [], waits = [];
  const matchApi = async (a, body) => {
    calls.push({ a, body });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const setTimeout = (fn, ms) => { waits.push(ms); fn(); return 0; };
  const { sendResult, tooEarlyWait } = new Function('matchApi', 'setTimeout', senderSrc + '\nreturn { sendResult, tooEarlyWait };')(matchApi, setTimeout);
  return { sendResult, tooEarlyWait, calls, waits };
}
const refusal = (code, extra = {}) => Object.assign(new Error(code), { code }, extra);

await test('a result the server calls too early is sent again when it says, and then counts', async () => {
  const s = sender([refusal('too_early', { retryAfter: 4, retryAfterMs: 3_200 }), refusal('too_early', { retryAfter: 1, retryAfterMs: 40 }), { match: { code: 'ABC' }, gold: 900 }]);
  const d = await s.sendResult('ABC', 4_000, true);
  assert.equal(d.gold, 900);
  assert.equal(s.calls.length, 3, 'three sends: two told to wait, one taken');
  assert.deepEqual(s.waits, [3_350, 400], 'each wait is what the server said, a breath past it (and never under a quarter second)');
  assert.deepEqual(s.calls[2].body, { code: 'ABC', ms: 4_000, cleared: true, gave_up: false }, 'the same result each time');
});
await test('a wait is bounded, and a server that only ever says too early is given up on after eight', async () => {
  const s = sender(Array.from({ length: 20 }, () => refusal('too_early', { retryAfter: 90 })));
  await assert.rejects(() => s.sendResult('ABC', 1, true), /too_early/);
  assert.equal(s.calls.length, 9, 'the first send and eight more');
  assert.ok(s.waits.every(w => w === 60_000), 'no wait longer than a minute, whatever it is told');
  assert.equal(s.tooEarlyWait({}), 1_150, 'a refusal without a time waits a second');
});
await test('a straight refusal still stops at once, and a dropped connection is still tried three times', async () => {
  const no = sender([refusal('not_yours'), { match: {} }]);
  await assert.rejects(() => no.sendResult('ABC', 1, true), /not_yours/);
  assert.equal(no.calls.length, 1);
  const net = sender([new Error('HTTP 502'), new Error('HTTP 502'), new Error('HTTP 502'), { match: {} }]);
  await assert.rejects(() => net.sendResult('ABC', 1, true), /HTTP 502/);
  assert.equal(net.calls.length, 3);
  assert.deepEqual(net.waits, [500, 1_000, 1_500]);
});
test('the result is kept on the device before it is sent, so a reload while it waits still sends it', () => {
  const fin = grab(/async function finishMatch\(cleared, ms, gaveUp = false\) \{[\s\S]*?\n  \}\n/);
  const kept = fin.indexOf('store.set(PENDING, sent);'), sent = fin.indexOf('await sendResult(');
  assert.ok(kept > 0 && sent > kept, 'PENDING is written before the first send');
  assert.ok(/retryAfterMs: d\.retry_after_ms/.test(grab(/const matchApi = [\s\S]*?\n  \};\n/)), 'and the match calls carry the server’s wait in milliseconds');
  assert.ok(/return flushResult\(false\);/.test(js), 'the next visit sends what is kept');
});

// ── Advertisement gold ──
const adSrc = [grab(/const adCapped = [^\n]+\n[^\n]+\n/), grab(/const adPost = [^\n]+\n[^\n]+\n/),
  grab(/async function adTicket\(\) \{[\s\S]*?\n  \}\n/), grab(/async function adClaimGold\(ticket\) \{[\s\S]*?\n  \}\n/)].join('\n');
/** The gold flow over a scripted server: every POST takes the next answer for its path. */
function adFlow(script, { isAd = true, now = 1_000_000 } = {}) {
  const posts = [], toasts = [], waits = [], gold = [], signIn = [];
  const fetch = async (url, opts) => {
    const pathOf = url.replace('/api/puzzle/v1', '');
    posts.push({ path: pathOf, body: JSON.parse(opts.body) });
    const next = script[pathOf].shift();
    if (next instanceof Error) throw next;
    return { ok: next.status === 200, status: next.status, json: async () => next.body };
  };
  const env = {
    fetch, API_V1: '/api/puzzle/v1', ads: { isAd: () => isAd }, toast: (msg, kind) => toasts.push({ msg, kind }),
    setGold: g => gold.push(g), openSignIn: m => signIn.push(m), gfmt: n => String(n),
    setTimeout: (fn, ms) => { waits.push(ms); fn(); return 0; }, Date: { now: () => now },
  };
  const names = Object.keys(env);
  const { adTicket, adClaimGold } = new Function(...names, adSrc + '\nreturn { adTicket, adClaimGold };')(...names.map(n => env[n]));
  return { adTicket, adClaimGold, posts, toasts, waits, gold, signIn };
}

await test('a ticket is asked for first, and the claim carries it', async () => {
  const f = adFlow({ '/ads/start': [{ status: 200, body: { ticket: 'T'.repeat(32), min_seconds: 15, left: 10 } }],
    '/ads/reward': [{ status: 200, body: { gold: 1500, granted: 500, left: 9 } }] });
  const t = await f.adTicket();
  assert.deepEqual(t, { id: 'T'.repeat(32), at: 1_000_000, wait: 15_000 });
  await f.adClaimGold({ ...t, at: t.at - 20_000 });        // the advertisement took twenty seconds
  assert.deepEqual(f.posts.map(p => p.path), ['/ads/start', '/ads/reward']);
  assert.deepEqual(f.posts[1].body, { ticket: 'T'.repeat(32) }, 'the claim sends the ticket');
  assert.deepEqual(f.waits, [], 'an advertisement longer than the hold is claimed at once');
  assert.deepEqual(f.gold, [1500]);
  assert.match(f.toasts[0].msg, /^500 gold\. 9 more advertisements today\.$/);
});
await test('no ticket, no advertisement: the day spent, the server away and a dropped connection each say why', async () => {
  const capped = adFlow({ '/ads/start': [{ status: 429, body: { error: 'ad_cap', gold: 700, left: 0 } }] });
  assert.equal(await capped.adTicket(), null);
  assert.match(capped.toasts[0].msg, /all the gold advertisements give today/);
  assert.deepEqual(capped.gold, [700]);
  const down = adFlow({ '/ads/start': [{ status: 503, body: { error: 'unavailable' } }] });
  assert.equal(await down.adTicket(), null);
  assert.match(down.toasts[0].msg, /^No gold advertisement right now\. Try again in a moment\.$/);
  const off = adFlow({ '/ads/start': [new Error('offline')] }, { isAd: false });
  assert.equal(await off.adTicket(), null);
  assert.match(off.toasts[0].msg, /^No free gold right now\./);
  const out = adFlow({ '/ads/start': [{ status: 401, body: { error: 'signed_out' } }] });
  assert.equal(await out.adTicket(), null);
  assert.equal(out.signIn.length, 1, 'signed out is the sign-in sheet');
});
await test('the free tap waits out the hold, says so, and claims once', async () => {
  const f = adFlow({ '/ads/reward': [{ status: 200, body: { gold: 500, granted: 500, left: 9 } }] }, { isAd: false });
  await f.adClaimGold({ id: 'T'.repeat(32), at: 1_000_000, wait: 15_000 });
  assert.equal(f.toasts[0].msg, 'Your gold arrives in 15 seconds.');
  assert.deepEqual(f.waits, [15_150], 'the hold and a breath');
  assert.equal(f.posts.length, 1, 'one claim, not a refused one first');
});
await test('a clock behind the server’s is told too early, waits what it is told and claims again', async () => {
  const f = adFlow({ '/ads/reward': [{ status: 409, body: { error: 'too_early', retry_after: 2, retry_after_ms: 1_200 } }, { status: 200, body: { gold: 500, granted: 500, left: 9 } }] });
  await f.adClaimGold({ id: 'T'.repeat(32), at: 900_000, wait: 15_000 });
  assert.deepEqual(f.waits, [1_350]);
  assert.equal(f.posts.length, 2);
  assert.deepEqual(f.gold, [500]);
});
test('the gold offer fetches its ticket before anything is shown, and a failed fetch shows nothing', () => {
  const offer = grab(/async function adOffer\(kind, note, quiet = false\) \{[\s\S]*?\n  \}\n/);
  const asked = offer.indexOf('ticket = await adTicket()'), shown = offer.indexOf('await adShow(');
  assert.ok(asked > 0 && shown > asked, 'adTicket comes before adShow');
  assert.ok(/if \(!ticket\) return;/.test(offer), 'no ticket, no advertisement');
  assert.ok(/R\.ticket && ads\.mode !== 'test'/.test(offer), 'the test panel, which claims nothing, asks for none');
  assert.ok(/grant\(quiet, ticket\) \{[\s\S]*?adClaimGold\(ticket\)/.test(grab(/const AD_REWARD = \{[\s\S]*?\n  \};\n/)), 'and the gold grant claims with it');
});

// ── The league and the account ──
test('a line the server says cannot be paid is not promised a prize', () => {
  const prizeOn = new Function(grab(/const prizeOn = [^\n]+/) + '\nreturn prizeOn;')();
  const ladder = [5_120_000, 2_560_000];
  assert.equal(prizeOn({ rank: 1, earning: 80_000, eligible: false }, ladder), 0, 'fewer than three opponents: no prize shown');
  assert.equal(prizeOn({ rank: 1, earning: 1_000, eligible: true }, ladder), 5_120_000);
  assert.equal(prizeOn({ rank: 2, earning: 1_000 }, ladder), 2_560_000, 'a server from before the word is believed');
  assert.equal(prizeOn({ rank: 1, earning: -5, eligible: true }, ladder), 0, 'and a losing week is still paid nothing');
  assert.ok(/eligible: mine\.eligible/.test(js), 'the pinned row carries it too');
  assert.ok(/at least three different people/.test(js), 'and the rules say so');
});
test('deleting an account says a new one starts with nothing, and the privacy policy says why', () => {
  assert.ok(/title: 'Delete your account\?', body: '[^']*A new account made later starts with 0 gold\./.test(js));
  assert.ok(/one-way hash of your Google account ID/.test(privacy) && /does not collect the welcome gold a second time/.test(privacy));
});

await Promise.all(pending);
console.log(process.exitCode ? `\nsome of ${tests} tests failed` : `\nall ${tests} tests passed`);
