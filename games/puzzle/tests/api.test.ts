// The HTTP surface, exercised over the wire against a running puzzle API.
//
// Point it at the API directly, or at nginx, with AA_TEST_BASE. Everything here is the outside view: what a
// browser and a phone app can actually do, what they are refused, and what happens when Redis disappears.
import { pool, query, tx } from '../backend/src/db.js';
import { k, redis } from '../backend/src/redis.js';
import { config } from '../backend/src/config.js';
import { give, idem } from '../backend/src/gold.js';
import { startSession } from '../backend/src/auth.js';
import { online } from '../backend/src/presence.js';
import { boardIdSet } from '../backend/src/rooms.js';
import { begun, eq, finish, ok, reset, section } from './helpers.js';

const BASE = process.env.AA_TEST_BASE ?? 'http://127.0.0.1:8760';
const V = `${BASE}/api/puzzle/v1`;

async function mint(name: string, gold = 200_000): Promise<{ id: number; token: string }> {
  return tx(async c => {
    const r = await query<{ id: number }>(c,
      `INSERT INTO users (provider, sub, name, gold) VALUES ('test', $1, $2, 0) RETURNING id`,
      [`api-${name}-${Date.now()}-${Math.random()}`, name]);
    const id = r.rows[0]!.id;
    await give(c, id, gold, 'admin', idem.admin(`api-mint:${id}`));
    return { id, token: await startSession(c, id, 'app') };
  });
}
interface Call { status: number; json: Record<string, unknown>; headers: Headers; }
async function call(path: string, opts: { token?: string; cookie?: string; body?: unknown; base?: string } = {}): Promise<Call> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch((opts.base ?? V) + path, {
    method: opts.body === undefined ? 'GET' : 'POST', headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) as Record<string, unknown>, headers: r.headers };
}
/** Start a room the way its host does, and wind its clock back past the floor on how fast it can be cleared. */
async function start(code: string, host: string): Promise<Call> {
  const r = await call(`/matches/${code}/start`, { token: host, body: {} });
  await begun(code);
  return r;
}

// Start from a clean database so this suite does not depend on what ran before it: a room another suite left
// waiting at the same stake would be joined rather than created, and the test would be asking about a room it
// does not host. The server keeps no state of its own that a truncate would confuse.
await reset();

section('Health says which part is unwell');
{
  // The full report answers at the root, which nginx keeps for the host; the one under the public prefix says
  // only whether the service is up. Container statistics and error text are for the host, not for whoever asks.
  const h = await call('/health', { base: BASE });
  eq(h.status, 200, 'health answers');
  eq((h.json.postgres as { ok: boolean }).ok, true, 'and reports PostgreSQL up');
  eq((h.json.redis as { ok: boolean }).ok, true, 'and Redis up');
  eq(h.json.product, 'puzzle', 'tagged with the product, not a generic name');
  const pub = await call('/health');
  eq(pub.status, 200, 'the public health answers');
  eq(JSON.stringify(Object.keys(pub.json)), '["ok"]', 'and says only that the service is up');

  // The prefix the game had before its rename is gone, and gone on purpose: it was carried for exactly as
  // long as it took every copy of the client to move over. Nothing should answer there now.
  const legacy = await call('/lobby', { base: `${BASE}/api/arrow-atlas/v1` });
  eq(legacy.status, 404, 'the prefix the game had before its rename is no longer served');
  const live = await fetch(`${BASE}/health/live`);
  eq(live.status, 200, 'the liveness probe answers without touching the database');
}

section('Both transports carry the same session');
const a = await mint('apiAnn'), b = await mint('apiBen');
{
  const viaBearer = await call('/auth/me', { token: a.token });
  eq((viaBearer.json.user as { id: number }).id, a.id, 'a phone app is known by its Bearer token');
  const viaCookie = await call('/auth/me', { cookie: `${config.auth.cookie}=${a.token}` });
  eq((viaCookie.json.user as { id: number }).id, a.id, 'a browser is known by its cookie');
  const anon = await call('/auth/me');
  eq(anon.json.user, null, 'and nobody is known by nothing');
  eq(anon.headers.get('cache-control'), 'no-store', 'no answer from this API may be cached');
}

section('A sign-in handed from the browser to the app');
{
  const nonce = 'app-nonce-0123456789abcdef';
  const off = await call('/auth/handoff', { body: { nonce } });
  eq(off.status, 401, 'a browser that is not signed in gets no code');
  const bad = await call('/auth/handoff', { cookie: `${config.auth.cookie}=${a.token}`, body: { nonce: 'short' } });
  eq(bad.status, 400, 'a nonce that is not the shape the app makes is refused');
  const start = await call('/auth/handoff', { cookie: `${config.auth.cookie}=${a.token}`, body: { nonce } });
  eq(start.status, 200, 'a signed-in browser gets a code');
  const code = String(start.json.code);
  eq(/^[a-f0-9]{64}$/.test(code), true, 'of the same shape as a session token');
  const wrong = await call('/auth/handoff/redeem', { body: { code, nonce: 'someone-elses-nonce-000000' } });
  eq(wrong.status, 404, 'the code is worth nothing without the nonce that asked for it');
  const again = await call('/auth/handoff/redeem', { body: { code, nonce } });
  eq(again.status, 404, 'and a wrong guess burns it');
  const start2 = await call('/auth/handoff', { cookie: `${config.auth.cookie}=${a.token}`, body: { nonce } });
  const code2 = String(start2.json.code);
  const web = await call('/auth/handoff/redeem', { body: { code: code2, nonce } });
  eq(web.status, 200, 'code and nonce together sign the app in');
  eq((web.json.user as { id: number }).id, a.id, 'as the account the browser held');
  eq(String(web.headers.get('set-cookie')).includes(config.auth.cookie), true, 'with a session cookie, the way the WebView keeps one');
  eq(web.json.token, undefined, 'and no token in the body for a cookie client');
  const twice = await call('/auth/handoff/redeem', { body: { code: code2, nonce } });
  eq(twice.status, 404, 'a code spent is a code gone');
  const start3 = await call('/auth/handoff', { cookie: `${config.auth.cookie}=${a.token}`, body: { nonce } });
  const bearer = await call('/auth/handoff/redeem', { body: { code: String(start3.json.code), nonce, client: 'app' } });
  eq(typeof bearer.json.token, 'string', 'a client that asks for the token gets it in the body');
  const who = await call('/auth/me', { token: String(bearer.json.token) });
  eq((who.json.user as { id: number }).id, a.id, 'and that token is a session');
}

section('Signed out means signed out');
{
  const r = await call('/matches', { body: { stake: 500 } });
  eq(r.status, 401, 'opening a room without a session is refused');
  eq(r.json.error, 'signed_out', 'and says why');
}

section('A bad stake is refused before any gold moves');
{
  const r = await call('/matches', { token: a.token, body: { stake: 123 } });
  eq(r.status, 400, 'a stake the game does not offer is refused');
  eq(r.json.error, 'bad_stake', 'with the honest reason');
}

section('A result sent twice is still one pot');
{
  const made = await call('/matches', { token: a.token, body: { stake: 500, open_to_all: false, tier: 2 } });
  const code = (made.json.match as { code: string }).code;
  await call(`/matches/${code}/join`, { token: b.token, body: { tier: 2 } });
  await start(code, a.token);
  const before = (await call('/auth/me', { token: b.token })).json.user as { gold: number };
  // the same request five times over, the way a client retrying a lost reply would send it
  for (let i = 0; i < 5; i++) await call(`/matches/${code}/result`, { token: b.token, body: { ms: 3300, cleared: true } });
  const after = (await call('/auth/me', { token: b.token })).json.user as { gold: number };
  eq(after.gold, before.gold + 1000, 'the pot lands once, however many times it is asked for');
  const rows = await query<{ n: number }>(pool,
    `SELECT COUNT(*)::int AS n FROM gold_ledger WHERE match_code = $1 AND reason = 'payout'`, [code]);
  eq(rows.rows[0]!.n, 1, 'and the ledger holds one payout row');
}

section('A room that fills itself cannot be started by hand');
{
  // Its own host: an account is in one match at a time, and the one above is still going.
  const host = await mint('apiFill');
  const made = await call('/matches', { token: host.token, body: { stake: config.game.stakes[1], open_to_all: true, tier: 2 } });
  const code = (made.json.match as { code: string }).code;
  const c = await mint('apiCarl');
  await call(`/matches/${code}/join`, { token: c.token, body: { tier: 2 } });
  const r = await call(`/matches/${code}/start`, { token: host.token, body: {} });
  eq(r.status, 409, 'the host is refused');
  eq(r.json.error, 'clock_starts_it', 'because the clock owns the start');
}

section('Rate limits bite, and say so properly');
{
  const spammer = await mint('apiSpam', 5_000_000);
  let limited = 0, allowed = 0, retryAfter = '';
  // The window is a fixed one, so a run that straddles its boundary is allowed up to twice the limit — by
  // design, and not what this test is about. The remaining count going back up is that boundary passing, so
  // the run starts over in the fresh window rather than failing for a reason that is not a bug.
  let left = Infinity, restarts = 0;
  for (let i = 0; i < 26; i++) {                          // match_create allows 20 a minute
    const r = await call('/matches', { token: spammer.token, body: { stake: 500, open_to_all: false, tier: 2 } });
    const now = Number(r.headers.get('x-ratelimit-remaining') ?? -1);
    if (now > left && restarts < 3) { restarts++; limited = 0; allowed = 0; i = -1; left = Infinity; continue; }
    left = now;
    if (r.status === 429) { limited++; retryAfter = r.headers.get('retry-after') ?? ''; } else allowed++;
  }
  ok(limited > 0, `the limit is enforced (${allowed} allowed, ${limited} refused)`);
  ok(allowed <= 21, `and it is roughly where it was configured (${allowed} got through, limit 20)`);
  ok(Number(retryAfter) > 0, `a 429 tells the client when to come back (Retry-After: ${retryAfter})`);
  const head = await call('/auth/me', { token: spammer.token });
  ok(head.headers.get('x-ratelimit-limit') !== null, 'and every answer carries the limit headers');
}

section('Losing Redis degrades the game; it does not stop it');
{
  // The service's own client, so this suite imports nothing the backend does not already depend on.
  await redis.flushdb();                                  // as if the cache had been restarted from nothing (this
                                                          // database only: other copies of the suite may share the server)
  const me = await call('/auth/me', { token: a.token });
  eq(me.status, 200, 'signing in still works with an empty Redis');
  const host = await mint('apiRedis');
  const made = await call('/matches', { token: host.token, body: { stake: 500, open_to_all: false, tier: 2 } });
  eq(made.status, 200, 'and a room still opens');
  const code = (made.json.match as { code: string }).code;
  const got = await call(`/matches/${code}`, { token: host.token });
  eq((got.json.match as { code: string }).code, code, 'and reading it back still works');
  // And the things that must never have been in Redis are still in PostgreSQL.
  const still = await query<{ n: number }>(pool, 'SELECT COUNT(*)::int AS n FROM users WHERE id = $1', [a.id]);
  eq(still.rows[0]!.n, 1, 'the account is where it belongs: in PostgreSQL');
}

section('Gold is never for the client to claim');
{
  const host = await mint('apiGoldHost'), racer = await mint('apiGoldRacer');
  const made = await call('/matches', { token: host.token, body: { stake: 500, open_to_all: false, tier: 2 } });
  const code = (made.json.match as { code: string }).code;
  await call(`/matches/${code}/join`, { token: racer.token, body: { tier: 2 } });
  await call(`/matches/${code}/start`, { token: host.token, body: {} });
  const before = (await call('/auth/me', { token: racer.token })).json.user as { gold: number };
  const hostBefore = (await call('/auth/me', { token: host.token })).json.user as { gold: number };
  // "Cleared", the instant the board is dealt: the script that used to take every pot at every table.
  const instant = await call(`/matches/${code}/result`, { token: host.token, body: { ms: 1, cleared: true } });
  eq(instant.status, 409, 'a clear sooner than the board could be cleared is refused');
  eq(instant.json.error, 'too_early', 'as too early, which a client knows to send again');
  ok(Number(instant.json.retry_after) >= 1 && Number(instant.json.retry_after) <= Math.ceil(config.game.minBoardMs / 1000), `with when (${instant.json.retry_after} s)`);
  ok(Number(instant.headers.get('retry-after')) >= 1, 'in the header too');
  const room = await call(`/matches/${code}`, { token: host.token });
  eq((room.json.match as { players: { you: boolean; ms: number | null }[] }).players.find(p => p.you)?.ms, null, 'and nothing was written: the host is still racing');
  eq(((await call('/auth/me', { token: host.token })).json.user as { gold: number }).gold, hostBefore.gold, 'and nobody was paid');
  // a client claiming an impossible time, and one claiming somebody else's room
  await call(`/matches/${code}/result`, { token: racer.token, body: { ms: -5_000_000, cleared: true } });
  const outsider = await mint('apiOut');
  const stolen = await call(`/matches/${code}/result`, { token: outsider.token, body: { ms: 1, cleared: true } });
  eq(stolen.status, 403, 'a player with no seat cannot report a result');
  const after = (await call('/auth/me', { token: racer.token })).json.user as { gold: number };
  eq(after.gold, before.gold, 'and no claim invented gold: an impossible time is a board lost, not a board won');
  // Once the board could have been cleared, the same result counts.
  await begun(code);
  const later = await call(`/matches/${code}/result`, { token: host.token, body: { ms: 7_000, cleared: true } });
  eq(later.status, 200, 'the same clear, sent again after the wait, is taken');
  eq(((await call('/auth/me', { token: host.token })).json.user as { gold: number }).gold, hostBefore.gold + 1000, 'and wins the pot, exactly');
}

section('A purse that cannot cover the stake is told so, not charged');
{
  const poor = await mint('apiPoor', 100);
  const r = await call('/matches', { token: poor.token, body: { stake: 500, open_to_all: false, tier: 2 } });
  eq(r.status, 400, 'the room is refused');
  eq(r.json.error, 'not_enough_gold', 'for the honest reason');
  eq((await call('/auth/me', { token: poor.token })).json.user && ((await call('/auth/me', { token: poor.token })).json.user as { gold: number }).gold, 100, 'and the purse is untouched');
}

section('The tour syncs over the wire, and only for the signed in');
{
  const out = await call('/progress', {});
  eq(out.status, 401, 'a stranger cannot read a tour');

  // 050 is Bangladesh: a board of the tour. Only a board of the game is synced.
  const p = await mint('apiProgress', 1_000);
  const push = await call('/progress', { token: p.token, body: { levels: { '050': { cleared: true, stars: 3, ms: 41_000 }, bd: { cleared: true, stars: 3, ms: 1 } }, state: { home: 'bd' }, device: 'apitestdev1', stats: { '050': { p: 3, c: 1, f: 2, h: 1, l: 2, ms: 41_000 }, inventedBoard: { p: 1_000 } } } });
  eq(push.status, 200, 'a push is accepted');
  eq((await query(pool, `SELECT plays FROM level_stats WHERE user_id = $1 AND device = 'apitestdev1' AND level_id = '050'`, [p.id])).rows[0]?.plays, 3, 'and the counts it carried are kept per device');
  eq(Object.keys(push.json.levels as object), ['050'], 'a level id that is no board of the game is dropped, not stored');
  eq((await query(pool, `SELECT count(*)::int AS n FROM level_stats WHERE user_id = $1 AND level_id = 'inventedBoard'`, [p.id])).rows[0]?.n, 0, 'and so are its counts');
  // Two more players on it, and the board is a line in the public table; a board one player has counted is
  // not, whatever is asked for. (Read once: the answer is kept for five minutes.)
  await call('/progress', { token: p.token, body: { levels: {}, device: 'apitestdev1', stats: { '356': { p: 2, c: 1, f: 1, h: 0, l: 1, ms: 50_000 } } } });
  for (const who of ['apiProgress2', 'apiProgress3']) {
    const q = await mint(who, 1_000);
    await call('/progress', { token: q.token, body: { levels: {}, device: 'apitestdev1', stats: { '050': { p: 2, c: 1, f: 1, h: 0, l: 1, ms: 50_000 } } } });
  }
  const diff = await call('/boards/difficulty?min=1');
  eq(diff.status, 200, 'the difficulty table is public');
  const lines = diff.json.boards as { level_id: string; players: number }[];
  eq(lines.find(b => b.level_id === '050')?.players, 3, 'and shows a board three have played, anonymously');
  ok(!lines.some(b => b.level_id === '356'), 'but not one only one player has counted, even asked for min=1: one person is not a board');
  eq(((push.json.levels as Record<string, { stars: number }>)['050'])?.stars, 3, 'and answers with the merged tour');
  eq((push.json.state as { home: string })?.home, 'bd', 'settings included');

  const read = await call('/progress', { token: p.token });
  eq(read.status, 200, 'and it can be read back');
  eq(((read.json.levels as Record<string, { ms: number }>)['050'])?.ms, 41_000, 'with the time that was sent');

  // the merge rule, through the routes rather than through the module
  await call('/progress', { token: p.token, body: { levels: { '050': { cleared: true, stars: 1, ms: 300_000 } } } });
  const after = await call('/progress', { token: p.token });
  eq(((after.json.levels as Record<string, { stars: number }>)['050'])?.stars, 3, 'a worse run sent afterwards does not win');
}

section('Two devices on one account: a Master board, the training and the streak all reach both');
{
  // What production saw: one Master board in a push and the whole push failed, from that device, every time.
  const p = await mint('apiTwoDevices', 1_000);
  const day = new Date().toISOString().slice(0, 10);
  const prev = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
  // 450 real boards: every country, its discovery board, and laps round a scene board
  const countries = [...await boardIdSet()];
  const ids = [...countries, ...countries.map(c => 'd:' + c), ...Array.from({ length: 450 - 2 * countries.length }, (_, i) => `s:tower~${i + 1}`)];
  const tour: Record<string, unknown> = {};
  for (const [i, id] of ids.entries()) tour[id] = { cleared: true, stars: 3, ms: 60_000 + i, tier: i % 5, arrows: 110, quiz: true };
  const stats: Record<string, unknown> = {};
  for (const id of ids) stats[id] = { p: 3, c: 1, f: 2, h: 1, l: 4, ms: 312_456 };
  // the phone: a whole tour of 450 boards, Master ones among them -- a body past the old 64 KB limit
  const phone = await call('/progress', { token: p.token, body: { levels: tour, stats, device: 'phoneDev01', state: { train: { [day]: { e: 100, p: 1, pp: { e: 1 } } }, playStreak: { count: 2, last: prev } } } });
  eq(phone.status, 200, 'the phone’s push, Master boards and all, is accepted');
  eq(Object.keys(phone.json.levels as object).length, 450, 'every board of it is on the account');
  // the website: one board and the Forgery, later the same day
  const web = await call('/progress', { token: p.token, body: { levels: { 'f:brain': { cleared: true, stars: 2, ms: 50_000, tier: 4 } }, device: 'webDev0001', state: { train: { [day]: { f: 39, p: 1, pp: { f: 1 } } }, playStreak: { count: 1, last: day } } } });
  eq(web.status, 200, 'the website’s push is accepted');
  const st = web.json.state as Record<string, any>;
  eq(Object.keys(web.json.levels as object).length, 451, 'and it gets the phone’s boards back');
  eq([st.train?.[day]?.e, st.train?.[day]?.f], [100, 39], 'and both rounds of the day');
  eq([st.playStreak?.count, st.playStreak?.last], [3, day], 'and the streak joined: two days on the phone and today on the website');
  // the phone asks again and sees the same
  const again = await call('/progress', { token: p.token });
  eq((again.json.state as Record<string, any>).train?.[day]?.f, 39, 'the phone reads the website’s round');

  // both at once, each with boards the account has not seen: every insert's foreign key holds a lock on the
  // user's row, and a row lock taken the wrong way round here deadlocked two such pushes against each other
  const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => call('/progress', { token: p.token, body: {
    levels: { [`s:arena~${i + 1}`]: { cleared: true, stars: 1, ms: 30_000, tier: 4 }, [`s:cross~${i + 1}`]: { cleared: true, stars: 2, ms: 31_000, tier: 3 } },
    device: i % 2 ? 'phoneDev01' : 'webDev0001', state: { train: { [day]: { g: 50 + i } }, loss: { [i % 2 ? 'phoneDev01' : 'webDev0001']: 10 + i } } } })));
  eq(burst.map(r => r.status), [200, 200, 200, 200, 200, 200], 'six pushes from two devices at the same moment all land');
  const end = await call('/progress', { token: p.token });
  eq((end.json.state as Record<string, any>).train?.[day]?.g, 55, 'and the best of their rounds is kept');
  eq(Object.keys(end.json.levels as object).length, 463, 'and every board of every one of them');

  // only the tour sync may send a big body: everywhere else the server's own limit stands
  const big = await call('/auth/name', { token: p.token, body: { name: 'x'.repeat(100_000) } });
  eq(big.status, 413, 'a 100 KB body to another route is refused');
}

section('Opening the app is not playing: only a sync that brings something new moves last_played_at');
{
  const p = await mint('apiPlayedAt', 1_000);
  const day = new Date().toISOString().slice(0, 10);
  const long = async () => { await query(pool, `UPDATE users SET last_played_at = now() - interval '3 days' WHERE id = $1`, [p.id]); };
  const played = async () => (await query<{ fresh: boolean }>(pool, `SELECT last_played_at > now() - interval '1 minute' AS fresh FROM users WHERE id = $1`, [p.id])).rows[0]?.fresh;
  await call('/progress', { token: p.token, body: { levels: { '050': { cleared: true, stars: 2, ms: 60_000, tier: 1, arrows: 40 } }, device: 'devPlayed1', stats: { '050': { p: 1, c: 1 } }, state: { playStreak: { count: 1, last: day }, home: 'BD' } } });
  await long();
  const same = await call('/progress', { token: p.token, body: { levels: { '050': { cleared: true, stars: 2, ms: 60_000, tier: 1, arrows: 40 } }, device: 'devPlayed1', stats: { '050': { p: 1, c: 1 } }, state: { playStreak: { count: 1, last: day }, home: 'IN' } } });
  eq(same.status, 200, 'the same sync again, as every open makes it');
  eq(await played(), false, 'moves nothing: the evening nudge still counts the days away');
  await call('/progress', { token: p.token, body: { state: { train: { [day]: { r: 72, p: 1, pp: { r: 1 } } } } } });
  eq(await played(), true, 'a training round scored is play');
  await long();
  await call('/progress', { token: p.token, body: { levels: {}, device: 'devPlayed1', stats: { '050': { p: 2, c: 1, f: 1 } } } });
  eq(await played(), true, 'and so is a board started again and lost');
  await long();
  await call('/progress', { token: p.token, body: { levels: { '356': { cleared: true, stars: 3, ms: 40_000, tier: 1, arrows: 38 } } } });
  eq(await played(), true, 'and a board cleared');
}

section('A link cannot delete somebody\u2019s account');
{
  // Reported by a review bot on PR #82, and it was real: the compatibility shim mounted every action for GET
  // as well as POST, so /games/api/auth.php?a=delete behind a cross-site link deleted the reader's account —
  // the session cookie is SameSite=Lax, which a browser still sends on a top-level navigation. The shim is
  // gone now, and what replaces that 405 is stronger: on the versioned surface nothing that changes anything
  // is registered for GET at all, so a link cannot reach it. This proves that rather than assuming it.
  const victim = await mint('apiVictim', 5_000);
  const byLink = await call('/auth/delete', { cookie: `${config.auth.cookie}=${victim.token}` });
  eq(byLink.status, 404, 'a GET to the delete route does not reach a handler');
  const still = await query<{ n: number }>(pool, 'SELECT COUNT(*)::int AS n FROM users WHERE id = $1', [victim.id]);
  eq(still.rows[0]!.n, 1, 'and the account is still there');

  // every other route that changes something, the same way
  for (const path of ['/auth/name', '/auth/logout', '/matches']) {
    const r = await call(path, { cookie: `${config.auth.cookie}=${victim.token}` });
    eq(r.status, 404, `a GET to ${path} does not reach a handler either`);
  }
  for (const verb of ['join', 'start', 'leave', 'progress', 'result']) {
    const r = await call(`/matches/ZZZZZZ/${verb}`, { cookie: `${config.auth.cookie}=${victim.token}` });
    eq(r.status, 404, `a GET to /matches/:code/${verb} does not reach a handler`);
  }

  // and the two reads the client actually does over GET still work
  eq((await call('/auth/me', { cookie: `${config.auth.cookie}=${victim.token}` })).status, 200, 'reading the account over GET still works');
  eq((await call('/lobby', {})).status, 200, 'and so does the lobby');

  // POST still deletes, which is what the dashboard does
  const byPost = await call('/auth/delete', { cookie: `${config.auth.cookie}=${victim.token}`, body: {} });
  eq(byPost.status, 200, 'a POST from the dashboard still deletes the account');
  const gone = await query<{ n: number }>(pool, 'SELECT COUNT(*)::int AS n FROM users WHERE id = $1', [victim.id]);
  eq(gone.rows[0]!.n, 0, 'and it is really gone');
}

section('The tables are the five the server names, and nothing else');
{
  const lobby = await call('/lobby');
  eq(lobby.json.stakes, [500, 1000, 10_000, 1_000_000, 10_000_000], 'the lobby names every table it will seat');
  const rich = await mint('high-roller', 20_000_000);
  const big = await call('/matches', { token: rich.token, body: { stake: 10_000_000, open_to_all: false } });
  eq(big.status, 200, 'the biggest table opens for a purse that can cover it');
  eq(big.json.gold, 10_000_000, 'and the stake has left the purse');
  const gone = await call('/matches', { token: rich.token, body: { stake: 7000, open_to_all: false } });
  eq(gone.status, 400, 'a table that no longer exists is refused');
  eq(gone.json.error, 'bad_stake', 'and says why');
  const poor = await mint('small-purse', 600);
  const over = await call('/matches', { token: poor.token, body: { stake: 10_000_000, open_to_all: false } });
  eq(over.status, 400, 'a purse that cannot cover the big table is refused');
  eq(over.json.error, 'not_enough_gold', 'for the honest reason, not as an unknown table');
  eq((await call('/matches', { token: poor.token, body: { stake: 500, open_to_all: false } })).status, 200,
     'and the smallest table still seats them');
}

section('The league is readable signed out, and knows you when you are in');
{
  const out = await call('/league');
  eq(out.status, 200, 'a signed-out visitor may read the league');
  const prizes = out.json.prizes as number[];
  eq(prizes.length, 10, 'the ladder comes with it');
  eq(prizes[0], 5_120_000, 'first place is the base doubled nine times');
  eq(prizes[9], 10_000, 'and tenth is the base');
  const season = out.json.season as { key: string; ends_at: number; ends_in_ms: number };
  ok(season.ends_at > Date.now(), 'the week has an end in the future');
  ok(season.ends_in_ms > 0 && season.ends_in_ms <= 168 * 3600_000, 'and a countdown no longer than the week itself');
  eq(out.json.me, null, 'a visitor has no place in it');

  const me = await mint('leaguer');
  const mine = await call('/league', { token: me.token });
  eq((mine.json.me as { rank: number | null }).rank, null, 'a player who has not played is unranked');
  eq((mine.json.me as { earning: number }).earning, 0, 'and has won nothing');

  // win a pot, and the table has to know about it
  const rival = await mint('leaguer-rival');
  // A table of its own, bigger than anything else this suite plays, so first place is first on the merits
  // rather than on nobody else having won yet -- which was true only by accident of the order of the sections
  // above, and stopped being true the moment each of them got a host of its own.
  const LEAGUE_STAKE = config.game.stakes[2] ?? config.game.stakes[0]!;
  const made = await call('/matches', { token: me.token, body: { stake: LEAGUE_STAKE, open_to_all: false } });
  const code = (made.json.match as { code: string }).code;
  await call(`/matches/${code}/join`, { token: rival.token, body: {} });
  await start(code, me.token);
  await call(`/matches/${code}/result`, { token: me.token, body: { ms: 3_000, cleared: true } });

  const after = await call('/league', { token: me.token });
  const place = after.json.me as { rank: number | null; earning: number };
  eq(place.rank, 1, 'the biggest winner of the week is first');
  eq(place.earning, LEAGUE_STAKE, 'having won the other seat\u2019s stake');
  const top = after.json.top as { name: string; you: boolean }[];
  ok(top.some(r => r.you), 'and the row is marked as theirs');
  const loser = await call('/league', { token: rival.token });
  const lost = loser.json.me as { rank: number | null; earning: number };
  ok(typeof lost.rank === 'number' && lost.rank > 1, 'the player who lost their stake is still in the table, below the winner');
  eq(lost.earning, -LEAGUE_STAKE, 'with the stake they lost standing as their week so far');
}

section('The people you have played with, and inviting them without a link');
{
  const host = await mint('inviteHost'), mate = await mint('inviteMate'), stranger = await mint('inviteStranger');

  const before = await call('/players/recent', { token: host.token });
  eq(before.status, 200, 'the list answers for a player who has played nobody');
  eq((before.json.players as unknown[]).length, 0, 'and it is empty rather than absent');
  eq((await call('/players/recent')).status, 401, 'a signed-out visitor has no list to read');

  // one match together is the whole qualification: no request, no accepting, nothing to manage
  const made = await call('/matches', { token: host.token, body: { stake: config.game.stakes[0], open_to_all: false } });
  const code = (made.json.match as { code: string }).code;
  await call(`/matches/${code}/join`, { token: mate.token, body: {} });
  await start(code, host.token);
  await call(`/matches/${code}/result`, { token: host.token, body: { ms: 3_000, cleared: true } });

  const after = await call('/players/recent', { token: host.token });
  const list = after.json.players as { id: number; name: string; matches: number; status: string }[];
  eq(list.length, 1, 'the person they just played is on the list');
  eq(list[0]?.id, mate.id, 'and it is that person');
  eq(list[0]?.name, 'inviteMate', 'by name, so a row can be drawn without a second call');
  eq(list[0]?.matches, 1, 'with how many times they have played');
  // When they last played is what orders the list, and it stays on the server: a row saying "14 hr ago" is a
  // diary of somebody's evening, and no part of deciding whether to invite them.
  ok(!('last_at' in (list[0] ?? {})), 'but not when they were last seen, which is nobody\u2019s business');
  // The other seat has not reported a result, so that match is open in the database — but a room nobody
  // finished stays that way for hours, and somebody with the game shut is not playing anything. Presence
  // decides, and only then does the seat choose between "online" and "in a match".
  eq(list[0]?.status, 'offline', 'a half-finished room does not make somebody who is not here look busy');
  await online.seen(mate.id);
  eq(((await call('/players/recent', { token: host.token })).json.players as { status: string }[])[0]?.status, 'playing',
     'with the game open and a race unfinished, they are in a match');
  await call(`/matches/${code}/result`, { token: mate.token, body: { ms: 9_000, cleared: true } });
  eq(((await call('/players/recent', { token: host.token })).json.players as { status: string }[])[0]?.status, 'online',
     'once that race is over they are simply here');
  await online.gone(mate.id);
  eq(((await call('/players/recent', { token: host.token })).json.players as { status: string }[])[0]?.status, 'offline',
     'and when they close the game they are offline again');
  eq(((await call('/players/recent', { token: mate.token })).json.players as { id: number }[])[0]?.id, host.id,
     'and the list reads the same way round from the other seat');

  const room = await call('/matches', { token: host.token, body: { stake: config.game.stakes[0], open_to_all: false } });
  const next = (room.json.match as { code: string }).code;
  const sent = await call(`/matches/${next}/invite`, { token: host.token, body: { user_id: mate.id } });
  eq(sent.status, 200, 'the host may ask somebody they have played to come and sit down');
  eq(sent.json.ok, true, 'and is told it went');

  eq(sent.json.delivered, false, 'honestly, including that nobody was there to hear it');

  // Not while they are racing: a challenge landing on a board somebody is being timed on is a notification
  // over a game in progress, and the one thing this game must not send.
  const busy = await call('/matches', { token: mate.token, body: { stake: config.game.stakes[0], open_to_all: false } });
  const busyCode = (busy.json.match as { code: string }).code;
  const third = await mint('inviteThird');
  await call(`/matches/${busyCode}/join`, { token: third.token, body: {} });
  await start(busyCode, mate.token);
  const mid = await call(`/matches/${next}/invite`, { token: host.token, body: { user_id: mate.id } });
  eq(mid.status, 409, 'somebody in the middle of a race is not interrupted');
  eq(mid.json.error, 'in_a_match', 'and the sender is told why');
  await call(`/matches/${busyCode}/result`, { token: mate.token, body: { ms: 4_000, cleared: true } });
  eq((await call(`/matches/${next}/invite`, { token: host.token, body: { user_id: mate.id } })).status, 200,
     'once their board is over they can be asked again');

  const spam = await call(`/matches/${next}/invite`, { token: host.token, body: { user_id: stranger.id } });
  eq(spam.status, 403, 'a stranger may not be invited');
  eq(spam.json.error, 'not_played_together', 'which is the only rule there is about who may be asked');
  const notMine = await call(`/matches/${next}/invite`, { token: mate.token, body: { user_id: stranger.id } });
  eq(notMine.status, 403, 'and a room is only the host\u2019s to invite into');
  eq((await call(`/matches/${next}/invite`, { token: host.token, body: { user_id: host.id } })).status, 400,
     'inviting yourself is refused before anything is looked up');
  eq((await call('/matches/ZZZZZZ/invite', { token: host.token, body: { user_id: mate.id } })).status, 404,
     'so is inviting into a room that does not exist');
  eq((await call(`/matches/${next}/invite`, { body: { user_id: mate.id } })).status, 401,
     'and a signed-out caller may invite nobody');
}

section('A player may choose the name the others see');
{
  const me = await mint('apiNamed');
  eq((await call('/auth/name', { body: { name: 'Ariyan Khan' } })).status, 401, 'a signed-out caller may rename nobody');

  const ok1 = await call('/auth/name', { token: me.token, body: { name: '  Ariyan Khan  ' } });
  eq(ok1.status, 200, 'their own name is theirs to change');
  eq((ok1.json.user as { name: string }).name, 'Ariyan Khan', 'and it comes back trimmed');
  eq(((await call('/auth/me', { token: me.token })).json.user as { name: string }).name, 'Ariyan Khan',
     'the change is the account, not the answer to one call');

  const empty = await call('/auth/name', { token: me.token, body: { name: '   ' } });
  eq(empty.status, 400, 'a name of nothing but spaces is refused');
  eq(empty.json.error, 'empty_name', 'and says so');
  eq(((await call('/auth/me', { token: me.token })).json.user as { name: string }).name, 'Ariyan Khan',
     'leaving the name they had');

  // Whatever arrives, what is stored is one line of at most 24 characters: this name is drawn in a row on
  // somebody else's screen, and a wall of text or a newline in it is their problem, not this player's joke.
  const long = await call('/auth/name', { token: me.token, body: { name: 'A'.repeat(80) } });
  eq((long.json.user as { name: string }).name.length, 24, 'a very long name is cut to twenty-four characters');
  const messy = await call('/auth/name', { token: me.token, body: { name: 'Ari\nyan\tKhan' } });
  eq((messy.json.user as { name: string }).name, 'Ari yan Khan', 'and newlines and tabs come back as single spaces');

  // and the table shows the new one, because names are read from the account rather than copied into a match
  const mate = await mint('apiNamedMate');
  const made = await call('/matches', { token: me.token, body: { stake: config.game.stakes[0], open_to_all: false } });
  const code = (made.json.match as { code: string }).code;
  await call(`/matches/${code}/join`, { token: mate.token, body: {} });
  await call('/auth/name', { token: me.token, body: { name: 'The Cartographer' } });
  const seen = await call(`/matches/${code}`, { token: mate.token });
  const players = (seen.json.match as { players: { name: string }[] }).players;
  ok(players.some(x => x.name === 'The Cartographer'), 'the room shows the name as it is now, not as it was');
}

section('How a cleared board went, against everybody else who cleared it');
{
  const me = await mint('paceMe');
  const bad = await call(`/boards/pace?level_id=&tier=0&ms=1000`);
  eq(bad.status, 400, 'a board nobody named is refused');
  eq((await call('/boards/pace?level_id=050&tier=9&ms=1000')).status, 400, 'so is a difficulty that does not exist');
  eq((await call('/boards/pace?level_id=050&tier=5&ms=1000')).status, 400, 'one past Master too');
  eq((await call('/boards/pace?level_id=pace-board&tier=4&ms=30000')).status, 200, 'and Master itself is compared: five tiers, Master is 4');
  eq((await call('/boards/pace?level_id=050&tier=0&ms=0')).status, 400, 'and a time of nothing');

  const quiet = await call('/boards/pace?level_id=036&tier=1&ms=30000');
  eq(quiet.status, 200, 'a board nobody has cleared still answers');
  eq(quiet.json.n, 0, 'with nobody in it');
  eq(quiet.json.beats_pct, undefined, 'and no percentage, because there is nothing to work one out from');

  // Nineteen clears: still not enough to tell somebody where they stand.
  const times: number[] = [];
  for (let k = 0; k < 19; k++) times.push(10_000 + k * 1000);
  await tx(async c => {
    for (const [k, ms] of times.entries()) {
      const u = await query<{ id: number }>(c,
        `INSERT INTO users (provider, sub, name, gold) VALUES ('test', $1, $2, 0) RETURNING id`,
        [`pace-${k}-${Date.now()}-${Math.random()}`, `pacer${k}`]);
      await query(c, `INSERT INTO progress (user_id, level_id, cleared, ms, stars, tier, arrows)
                      VALUES ($1, '036', true, $2, 3, 1, 40)`, [u.rows[0]!.id, ms]);
    }
  });
  const nearly = await call('/boards/pace?level_id=036&tier=1&ms=30000', { token: me.token });
  eq(nearly.json.n, 19, 'nineteen clears are counted');
  eq(nearly.json.beats_pct, undefined, 'but still no percentage: a share of nineteen is a guess dressed as a fact');

  // The twentieth crosses the floor, and now the answer is worth saying.
  await tx(async c => {
    const u = await query<{ id: number }>(c,
      `INSERT INTO users (provider, sub, name, gold) VALUES ('test', $1, 'pacer19', 0) RETURNING id`,
      [`pace-19-${Date.now()}-${Math.random()}`]);
    await query(c, `INSERT INTO progress (user_id, level_id, cleared, ms, stars, tier, arrows)
                    VALUES ($1, '036', true, 29000, 3, 1, 40)`, [u.rows[0]!.id]);
  });
  const slow = await call('/boards/pace?level_id=036&tier=1&ms=40000', { token: me.token });
  eq(slow.json.n, 20, 'twenty clears are enough');
  eq(slow.json.beats_pct, 0, 'a run slower than all of them beats none of them');
  const quick = await call('/boards/pace?level_id=036&tier=1&ms=9000', { token: me.token });
  eq(quick.json.beats_pct, 100, 'and one faster than all of them beats them all');
  const middling = await call('/boards/pace?level_id=036&tier=1&ms=20000', { token: me.token });
  ok((middling.json.beats_pct as number) > 40 && (middling.json.beats_pct as number) < 60,
     `a middling run lands in the middle (${middling.json.beats_pct}%)`);

  // The difficulty is part of the question: the same board on Master is a different board to compare against.
  eq((await call('/boards/pace?level_id=036&tier=3&ms=20000')).json.n, 0, 'another difficulty is another table');

  // A player is never compared with themselves.
  await call('/progress', { token: me.token, body: { levels: { '036': { cleared: true, ms: 20_000, stars: 3, tier: 1, arrows: 40 } } } });
  eq((await call('/boards/pace?level_id=036&tier=1&ms=20000', { token: me.token })).json.n, 20,
     'their own row is left out of the count');
  eq((await call('/boards/pace?level_id=036&tier=1&ms=20000')).json.n, 21, 'and counted for everybody else');

  // A time nobody could have played is not counted at all: forty arrows in a second would push every honest
  // player's "you beat X%" down.
  const forger = await mint('paceForger');
  await call('/progress', { token: forger.token, body: { levels: { '036': { cleared: true, ms: 1_000, stars: 3, tier: 1, arrows: 40 } } } });
  eq((await call('/boards/pace?level_id=036&tier=1&ms=20000')).json.n, 21, 'a clear faster than 150 ms an arrow is left out');
}

section('One match at a time, and a device that knows nothing can still find it');
{
  // The fault this is here for: the same account signed in on a phone and in a browser, a challenge started
  // in one of them, and nothing in the other that could see it. The code used to live only in whichever
  // client had opened the room.
  const one = await mint('liveOne'), two = await mint('liveTwo');

  const made = await call('/matches', { token: one.token, body: { stake: 500, open_to_all: false, tier: 2 } });
  const code = (made.json.match as { code: string }).code;

  const mine = await call('/auth/me', { token: one.token });
  eq((mine.json.match as { code: string } | null)?.code, code, 'a fresh sign-in is told which match the account is in');
  eq((mine.json.match as { state: string }).state, 'open', 'and what state it is in');

  const second = await call('/matches', { token: one.token, body: { stake: 500, open_to_all: false, tier: 2 } });
  eq(second.status, 409, 'a second match is refused');
  eq(second.json.error, 'in_match', 'for the honest reason');
  eq(second.json.match_code, code, 'and the refusal carries the room already held, so the client has a way back to it');

  // Somebody else's invitation is refused the same way while a match is live.
  const host = await mint('liveHost');
  const theirs = await call('/matches', { token: host.token, body: { stake: 500, open_to_all: false, tier: 2 } });
  const theirCode = (theirs.json.match as { code: string }).code;
  const barged = await call(`/matches/${theirCode}/join`, { token: one.token, body: { tier: 2 } });
  eq(barged.status, 409, 'and so is an invitation');
  eq(barged.json.match_code, code, 'naming the same room');

  // Leaving hands the seat and the stake back, and the account is free again.
  await call(`/matches/${code}/leave`, { token: one.token, body: {} });
  eq((await call('/auth/me', { token: one.token })).json.match, null, 'leaving clears it');
  const now = await call('/matches', { token: one.token, body: { stake: 500, open_to_all: false, tier: 2 } });
  eq(now.status, 200, 'and the next match opens straight away');

  // A player signed out has no match to be told about, and nothing to leak.
  eq((await call('/auth/me')).json.match, null, 'a signed-out visitor is told nothing');
  void two;
}

section('A phone registers for notifications the way a browser does, and is told when it cannot');
{
  const key = await call('/push/key');
  eq(key.status, 200, 'the key endpoint answers signed out');
  eq(key.json.app, false, 'and says whether phones can be reached at all -- not on a box with no service account');

  const p = await mint('phoneOwner');
  const out = await call('/push/token', { body: { token: 'x'.repeat(40) } });
  eq(out.status, 503, 'a token needs no account: signed out it is taken the same way, and refused here only for want of a service account');
  eq(out.json.error, 'push_off', 'in the same word');
  const junk = await call('/push/token', { token: p.token, body: { token: 'short' } });
  eq(junk.status, 400, 'and has to look like one');
  eq(junk.json.error, 'bad_token', 'which is said before anything else is checked');
  const off = await call('/push/token', { token: p.token, body: { token: 'x'.repeat(40) } });
  eq(off.status, 503, 'with no service account the server refuses the token');
  eq(off.json.error, 'push_off', 'in the same word the browser is given');
  const drop = await call('/push/token/drop', { token: p.token, body: { token: 'x'.repeat(40) } });
  eq(drop.status, 200, 'dropping a token never needs the service account');
  eq(drop.json.on, false, 'and answers with whether anything is still listening');

  // The evening nudge is per account and the one notification a player may decline on its own.
  eq(((await call('/auth/me', { token: p.token })).json.user as { reminder: boolean }).reminder, true, 'the nudge is on to begin with');
  const nudgeOff = await call('/push/reminder', { token: p.token, body: { on: false } });
  eq([nudgeOff.status, nudgeOff.json.reminder], [200, false], 'and can be turned off');
  eq(((await call('/auth/me', { token: p.token })).json.user as { reminder: boolean }).reminder, false, 'which /auth/me then says');
  eq((await call('/push/reminder', { token: p.token, body: { on: true } })).json.reminder, true, 'and back on');
  // Signed out, the nudge switch is the device's own row, named by the token or endpoint only it knows.
  eq((await call('/push/reminder', { body: { on: false } })).status, 400, 'a stranger with no device named has nothing to switch');
  eq((await call('/push/reminder', { body: { on: false, token: 'y'.repeat(40) } })).status, 404, 'nor with a token nobody posted');
}

section('What a client sends is checked, not passed to the database');
{
  const t = (await mint('checked-host')).token;
  const tier = await call('/matches', { token: t, body: { stake: 500, open_to_all: false, tier: 'hard' } });
  eq(tier.status, 400, 'a tier that is not a number is refused as the client\'s mistake');
  eq(tier.json.error, 'bad_tier', 'and named');
  const half = await call('/matches', { token: t, body: { stake: 500, open_to_all: false, tier: 2.5 } });
  eq(half.status, 400, 'so is a tier between two of the five');
  const bad = await fetch(`${V}/matches`, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: '{not json' });
  eq(bad.status, 400, 'unreadable JSON is a 400, not a failure of ours');
  eq(((await bad.json()) as { error: string }).error, 'bad_request', 'with a shape the client can handle');
  const sub = await call('/push/subscribe', { token: t, body: { endpoint: 'https://puzzle-postgres.internal/x', keys: { p256dh: 'p', auth: 'a' } } });
  eq([400, 503].includes(sub.status), true, 'a push endpoint inside our own network is not stored');
  if (sub.status === 400) eq(sub.json.error, 'bad_subscription', 'and is called a bad subscription');
}

section('A room says how long it is');
{
  const host = await mint('shapeHost');
  eq((await call('/lobby')).json.lengths, [1, 3, 5], 'the lobby says which lengths are offered');
  const room = await call('/matches', { token: host.token, body: { stake: config.game.stakes[0], open_to_all: false, boards: 3 } });
  eq([room.status, (room.json.match as { boards_n: number }).boards_n], [200, 3], 'a three-board match opens and the room says so');
  await call(`/matches/${(room.json.match as { code: string }).code}/leave`, { token: host.token, body: {} });
  const bad = await call('/matches', { token: host.token, body: { stake: config.game.stakes[0], open_to_all: false, boards: 2 } });
  eq([bad.status, bad.json.error], [400, 'bad_length'], 'a length not on the list is refused');
}

section('Mute: the one answer to being asked too often');
{
  const host = await mint('muteHost'), mate = await mint('muteMate');
  // Having played together is the right to ask at all.
  const first = await call('/matches', { token: host.token, body: { stake: config.game.stakes[0], open_to_all: false } });
  const firstCode = (first.json.match as { code: string }).code;
  await call(`/matches/${firstCode}/join`, { token: mate.token, body: {} });
  await start(firstCode, host.token);
  await call(`/matches/${firstCode}/result`, { token: host.token, body: { ms: 3_000, cleared: true } });
  await call(`/matches/${firstCode}/result`, { token: mate.token, body: { ms: 4_000, cleared: true } });

  const room = await call('/matches', { token: host.token, body: { stake: config.game.stakes[0], open_to_all: false } });
  const code = (room.json.match as { code: string }).code;
  // Asking twice in a row is simply asking twice: the ask is never refused. The phone, though, rings once per room.
  eq((await call(`/matches/${code}/invite`, { token: host.token, body: { user_id: mate.id } })).status, 200, 'the first ask goes');
  const twice = await call(`/matches/${code}/invite`, { token: host.token, body: { user_id: mate.id } });
  eq([twice.status, twice.json.reach], [200, 'none'], 'and so does the second, straight away -- reaching nobody, because mate is not online');
  await online.seen(mate.id);
  eq((await call(`/matches/${code}/invite`, { token: host.token, body: { user_id: mate.id } })).json.reach, 'live', 'with the game open it lands on the screen');
  await query(pool, `INSERT INTO push_tokens (user_id, token) VALUES ($1, $2)`, [mate.id, 'fcm:' + 'm'.repeat(40)]);
  // A socket open behind other windows is not a player looking: hidden, the phone is told instead.
  await online.away(mate.id, true);
  eq((await call(`/matches/${code}/invite`, { token: host.token, body: { user_id: mate.id } })).json.reach, 'push', 'with the tab hidden, the phone is told even though a socket is open');
  await online.away(mate.id, false);
  eq((await call(`/matches/${code}/invite`, { token: host.token, body: { user_id: mate.id } })).json.reach, 'live', 'and back in front of it, the screen again');
  await online.gone(mate.id);
  eq((await call(`/matches/${code}/invite`, { token: host.token, body: { user_id: mate.id } })).json.reach, 'push', 'with the game closed and a phone registered, the phone is told');

  // Mate has had enough.
  eq((await call('/players/mute', { token: mate.token, body: { user_id: host.id } })).status, 200, 'mate mutes host');
  eq(((await call('/players/muted', { token: mate.token })).json.muted as { id: number }[]).map(x => x.id), [host.id], 'and the list says so');
  const muted = await call(`/matches/${code}/invite`, { token: host.token, body: { user_id: mate.id } });
  eq([muted.status, muted.json.reach], [200, 'none'], 'the next ask goes nowhere, and host is told only that mate is not reachable');
  eq(((await call('/players/recent', { token: mate.token })).json.players as { id: number }[]).some(x => x.id === host.id), false, 'host is off mate\'s list');
  eq(((await call('/players/recent', { token: host.token })).json.players as { id: number }[]).some(x => x.id === mate.id), true, 'but mate is still on host\'s: host is never told');
  eq((await call('/players/mute', { token: mate.token, body: { user_id: mate.id } })).status, 400, 'nobody can mute themselves');
  eq((await call('/players/mute', { body: { user_id: host.id } })).status, 401, 'nor a stranger anybody');

  // And the way back.
  eq(((await call('/players/unmute', { token: mate.token, body: { user_id: host.id } })).json.muted as unknown[]).length, 0, 'unmuting empties the list');
  eq((await call(`/matches/${code}/invite`, { token: host.token, body: { user_id: mate.id } })).json.reach, 'push', 'and the phone is told again');
  await query(pool, `DELETE FROM push_tokens WHERE user_id = $1`, [mate.id]);
}

section('A phone rings once in ten minutes for one sender, whatever room it is for');
{
  // The fault: a room costs nothing to open and leave, and a phone rang once per room -- so one sender could
  // ring somebody twenty times a minute, opening a room, inviting, leaving and opening the next.
  const host = await mint('ringHost'), mate = await mint('ringMate');
  const first = await call('/matches', { token: host.token, body: { stake: config.game.stakes[0], open_to_all: false } });
  const firstCode = (first.json.match as { code: string }).code;
  await call(`/matches/${firstCode}/join`, { token: mate.token, body: {} });
  await start(firstCode, host.token);
  await call(`/matches/${firstCode}/result`, { token: host.token, body: { ms: 3_000, cleared: true } });
  await call(`/matches/${firstCode}/result`, { token: mate.token, body: { ms: -1, cleared: false } });
  await query(pool, `INSERT INTO push_tokens (user_id, token) VALUES ($1, $2)`, [mate.id, 'fcm:' + 'r'.repeat(40)]);
  const day = new Date().toISOString().slice(0, 10);
  const reaches: string[] = [];
  for (let i = 0; i < 3; i++) {
    const room = await call('/matches', { token: host.token, body: { stake: config.game.stakes[0], open_to_all: false } });
    const code = (room.json.match as { code: string }).code;
    reaches.push(String((await call(`/matches/${code}/invite`, { token: host.token, body: { user_id: mate.id } })).json.reach));
    await call(`/matches/${code}/leave`, { token: host.token, body: {} });
  }
  eq(reaches, ['push', 'push', 'push'], 'three rooms opened and left to ask again: the sender is told the same each time');
  eq(Number(await redis.get(k('invringday', host.id, mate.id, day))), 1, 'but the phone rang once');
  ok(Number(await redis.ttl(k('invring', host.id, mate.id))) > 500, 'and will not ring for this sender again for ten minutes');
  eq(Number(await redis.get(k('invpops', host.id, mate.id))), 3, 'the card on an open screen is counted per sender too');
  await query(pool, `DELETE FROM push_tokens WHERE user_id = $1`, [mate.id]);

  // What happens when Redis is not there to count: nothing rings and nothing pops up. A missed invitation is
  // a link to send; a flood nobody can stop is not.
  const { inviteRings, invitePopsUp } = await import('../backend/src/players.js');
  eq(await invitePopsUp(host.id, mate.id, 'NEWONE'), true, 'a new room is a new card, while the sender is under the count');
  const set = redis.set.bind(redis);
  (redis as unknown as { set: unknown }).set = () => Promise.reject(new Error('redis is down'));
  try {
    eq(await inviteRings(9_001, 9_002), false, 'with Redis away, an invitation rings no phone');
    eq(await invitePopsUp(9_001, 9_002, 'ABCDEF'), false, 'and pops up on no screen');
  } finally { (redis as unknown as { set: unknown }).set = set; }
}

section('Gold for an advertisement needs a ticket asked for before it');
{
  const p = await mint('adTicket', 0);
  const old = await call('/ads/reward', { token: p.token, body: {} });
  eq([old.status, old.json.error], [400, 'no_ticket'], 'a claim with no ticket -- what a page from before tickets sends -- is refused with a 4xx');
  eq((await call('/ads/start', { body: {} })).status, 401, 'a signed-out visitor has no purse to ask for');
  const t = await call('/ads/start', { token: p.token, body: {} });
  eq(t.status, 200, 'a ticket is handed out before the advertisement is shown');
  eq([t.json.left, t.json.min_seconds], [config.game.adGoldPerDay, config.game.adMinSeconds], 'with how many are left today and how long an advertisement takes');
  const ticket = String(t.json.ticket);
  const early = await call('/ads/reward', { token: p.token, body: { ticket } });
  eq([early.status, early.json.error], [409, 'too_early'], 'claimed at once, it is too early');
  ok(Number(early.json.retry_after) >= 1 && Number(early.json.retry_after) <= config.game.adMinSeconds, `with when to claim it (${early.json.retry_after} s)`);
  eq(((await call('/auth/me', { token: p.token })).json.user as { gold: number }).gold, 0, 'and nothing was paid');
  // wind the ticket's clock back, as if the advertisement had played through
  const key = k('adticket', p.id), rec = JSON.parse(String(await redis.get(key))) as { h: string; at: number };
  await redis.set(key, JSON.stringify({ ...rec, at: rec.at - config.game.adMinSeconds * 1000 }), 'EX', 600);
  const paid = await call('/ads/reward', { token: p.token, body: { ticket } });
  eq([paid.status, paid.json.granted, paid.json.left], [200, config.game.adGold, config.game.adGoldPerDay - 1], 'after an advertisement’s length it pays');
  const again = await call('/ads/reward', { token: p.token, body: { ticket } });
  eq([again.status, again.json.error], [400, 'no_ticket'], 'and the same ticket does not pay twice');
  eq((await call('/ads/reward', { token: p.token, body: { ticket: 'not a ticket at all' } })).status, 400, 'a ticket of the wrong shape is no ticket');

  // The day's allowance spent: said when the ticket is asked for, before an advertisement plays for nothing.
  await tx(async c => { for (let n = 2; n <= config.game.adGoldPerDay; n++) await give(c, p.id, 1, 'ad_reward', idem.adReward(p.id, new Date().toISOString().slice(0, 10), n)); });
  const capped = await call('/ads/start', { token: p.token, body: {} });
  eq([capped.status, capped.json.error], [429, 'ad_cap'], 'with the day spent, no ticket, and the reason');
}

section('The limits that guard gold keep counting when Redis does not');
{
  const { addressBucket, check, subjectFor, LIMITS } = await import('../backend/src/ratelimit.js');
  eq(addressBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64', 'an IPv6 address is counted by its /64');
  eq(addressBucket('2001:db8:1:2::1'), addressBucket('2001:0db8:0001:0002:ffff::9'), 'however it is written');
  eq(addressBucket('2001:db8::1'), '2001:db8:0:0::/64', 'with the zeros put back');
  eq(addressBucket('::ffff:203.0.113.9'), '203.0.113.9', 'an IPv4 address written the IPv6 way is IPv4');
  eq(addressBucket('203.0.113.9'), '203.0.113.9', 'and IPv4 is itself');
  eq(subjectFor(LIMITS.auth_signin, '2001:db8:1:2:1::', null), subjectFor(LIMITS.auth_signin, '2001:db8:1:2:9::', null), 'so one home cannot sign in from a billion addresses');

  const multi = redis.multi.bind(redis);
  (redis as unknown as { multi: unknown }).multi = () => { throw new Error('redis is down'); };
  try {
    const subject = `u-test-${Date.now()}`;
    const verdicts = [];
    for (let i = 0; i <= LIMITS.ad_reward.limit; i++) verdicts.push((await check('ad_reward', subject)).allowed);
    eq(verdicts.filter(Boolean).length, LIMITS.ad_reward.limit, 'a limit on gold is still counted with Redis away, in the process');
    eq(verdicts[verdicts.length - 1], false, 'and refuses past it');
    const reads = [];
    for (let i = 0; i < 5; i++) reads.push((await check('lobby_read', subject)).allowed);
    ok(reads.every(Boolean), 'while a read is let through, so an outage of the cache is not an outage of the game');
  } finally { (redis as unknown as { multi: unknown }).multi = multi; }
}

await finish();
