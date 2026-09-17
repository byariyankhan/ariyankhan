// The HTTP surface, exercised over the wire against a running arrow-atlas-api.
//
// Point it at the API directly, or at nginx, with AA_TEST_BASE. Everything here is the outside view: what a
// browser and a phone app can actually do, what they are refused, and what happens when Redis disappears.
import { pool, query, tx } from '../backend/src/db.js';
import { redis } from '../backend/src/redis.js';
import { config } from '../backend/src/config.js';
import { give, idem } from '../backend/src/gold.js';
import { startSession } from '../backend/src/auth.js';
import { eq, finish, ok, reset, section } from './helpers.js';

const BASE = process.env.AA_TEST_BASE ?? 'http://127.0.0.1:8760';
const V = `${BASE}/api/arrow-atlas/v1`;

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

// Start from a clean database so this suite does not depend on what ran before it: a room another suite left
// waiting at the same stake would be joined rather than created, and the test would be asking about a room it
// does not host. The server keeps no state of its own that a truncate would confuse.
await reset();

section('Health says which part is unwell');
{
  const h = await call('/health');
  eq(h.status, 200, 'health answers');
  eq((h.json.postgres as { ok: boolean }).ok, true, 'and reports PostgreSQL up');
  eq((h.json.redis as { ok: boolean }).ok, true, 'and Redis up');
  eq(h.json.product, 'arrow-atlas', 'tagged with the product, not a generic name');
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

section('The old paths answer exactly as they used to');
{
  const mine = await call('/matches', { token: a.token, body: { stake: 500, open_to_all: false, tier: 2 } });
  const code = ((mine.json.match as { code: string }).code);
  const v1 = await call(`/matches/${code}`, { token: a.token });
  const legacy = await call(`/games/api/match.php?a=get&code=${code}`, { token: a.token, base: BASE });
  eq(legacy.status, v1.status, 'the legacy path returns the same status');
  eq(JSON.stringify(legacy.json.match), JSON.stringify(v1.json.match), 'and byte for byte the same match');
  const legacyMe = await call('/games/api/auth.php?a=me', { token: a.token, base: BASE });
  eq(JSON.stringify(legacyMe.json), JSON.stringify((await call('/auth/me', { token: a.token })).json), 'and the same account');
}

section('A result sent twice is still one pot');
{
  const made = await call('/matches', { token: a.token, body: { stake: 500, open_to_all: false, tier: 2 } });
  const code = (made.json.match as { code: string }).code;
  await call(`/matches/${code}/join`, { token: b.token, body: { tier: 2 } });
  await call(`/matches/${code}/start`, { token: a.token, body: {} });
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
  const made = await call('/matches', { token: a.token, body: { stake: 7000, open_to_all: true, tier: 2 } });
  const code = (made.json.match as { code: string }).code;
  const c = await mint('apiCarl');
  await call(`/matches/${code}/join`, { token: c.token, body: { tier: 2 } });
  const r = await call(`/matches/${code}/start`, { token: a.token, body: {} });
  eq(r.status, 409, 'the host is refused');
  eq(r.json.error, 'clock_starts_it', 'because the clock owns the start');
}

section('Rate limits bite, and say so properly');
{
  const spammer = await mint('apiSpam', 5_000_000);
  let limited = 0, allowed = 0, retryAfter = '';
  for (let i = 0; i < 26; i++) {                          // match_create allows 20 a minute
    const r = await call('/matches', { token: spammer.token, body: { stake: 500, open_to_all: false, tier: 2 } });
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
  await redis.flushall();                                 // as if the cache had been restarted from nothing
  const me = await call('/auth/me', { token: a.token });
  eq(me.status, 200, 'signing in still works with an empty Redis');
  const made = await call('/matches', { token: a.token, body: { stake: 500, open_to_all: false, tier: 2 } });
  eq(made.status, 200, 'and a room still opens');
  const code = (made.json.match as { code: string }).code;
  const got = await call(`/matches/${code}`, { token: a.token });
  eq((got.json.match as { code: string }).code, code, 'and reading it back still works');
  // And the things that must never have been in Redis are still in PostgreSQL.
  const still = await query<{ n: number }>(pool, 'SELECT COUNT(*)::int AS n FROM users WHERE id = $1', [a.id]);
  eq(still.rows[0]!.n, 1, 'the account is where it belongs: in PostgreSQL');
}

section('Gold is never for the client to claim');
{
  const made = await call('/matches', { token: a.token, body: { stake: 500, open_to_all: false, tier: 2 } });
  const code = (made.json.match as { code: string }).code;
  await call(`/matches/${code}/join`, { token: b.token, body: { tier: 2 } });
  await call(`/matches/${code}/start`, { token: a.token, body: {} });
  const before = (await call('/auth/me', { token: b.token })).json.user as { gold: number };
  // a client claiming an impossible time, and one claiming somebody else's room
  await call(`/matches/${code}/result`, { token: b.token, body: { ms: -5_000_000, cleared: true } });
  const outsider = await mint('apiOut');
  const stolen = await call(`/matches/${code}/result`, { token: outsider.token, body: { ms: 1, cleared: true } });
  eq(stolen.status, 403, 'a player with no seat cannot report a result');
  const after = (await call('/auth/me', { token: b.token })).json.user as { gold: number };
  ok(after.gold <= before.gold + 1000, 'and no claim invented gold');
}

section('A purse that cannot cover the stake is told so, not charged');
{
  const poor = await mint('apiPoor', 100);
  const r = await call('/matches', { token: poor.token, body: { stake: 500, open_to_all: false, tier: 2 } });
  eq(r.status, 400, 'the room is refused');
  eq(r.json.error, 'not_enough_gold', 'for the honest reason');
  eq((await call('/auth/me', { token: poor.token })).json.user && ((await call('/auth/me', { token: poor.token })).json.user as { gold: number }).gold, 100, 'and the purse is untouched');
}

section('A link cannot delete somebody\u2019s account');
{
  // Reported by a review bot on PR #82, and real: the legacy shim mounted every action for GET, so
  // /games/api/auth.php?a=delete behind a cross-site link deleted the reader's account — the session cookie is
  // SameSite=Lax, which a browser still sends on a top-level navigation. The PHP service answered 405 to any
  // non-POST mutation, and so does this again.
  const victim = await mint('apiVictim', 5_000);
  const byLink = await call(`/games/api/auth.php?a=delete`, { cookie: `${config.auth.cookie}=${victim.token}`, base: BASE });
  eq(byLink.status, 405, 'a GET to the delete action is refused');
  eq(byLink.json.error, 'post_only', 'with the reason the old service gave');
  const still = await query<{ n: number }>(pool, 'SELECT COUNT(*)::int AS n FROM users WHERE id = $1', [victim.id]);
  eq(still.rows[0]!.n, 1, 'and the account is still there');

  // every other mutation, the same way
  for (const a of ['name', 'logout']) {
    const r = await call(`/games/api/auth.php?a=${a}`, { cookie: `${config.auth.cookie}=${victim.token}`, base: BASE });
    eq(r.status, 405, `a GET to ${a} is refused too`);
  }
  for (const a of ['create', 'join', 'start', 'cancel', 'progress', 'result']) {
    const r = await call(`/games/api/match.php?a=${a}&code=ZZZZZZ`, { cookie: `${config.auth.cookie}=${victim.token}`, base: BASE });
    eq(r.status, 405, `a GET to match ${a} is refused`);
  }

  // and the reads a cached client actually needs still work over GET
  const readMe = await call('/games/api/auth.php?a=me', { cookie: `${config.auth.cookie}=${victim.token}`, base: BASE });
  eq(readMe.status, 200, 'but reading the account over GET still works');
  const lobby = await call('/games/api/match.php?a=lobby', { base: BASE });
  eq(lobby.status, 200, 'and so does the lobby');

  // POST still deletes, which is what the dashboard does
  const byPost = await call('/games/api/auth.php?a=delete', { cookie: `${config.auth.cookie}=${victim.token}`, base: BASE, body: {} });
  eq(byPost.status, 200, 'a POST from the dashboard still deletes the account');
  const gone = await query<{ n: number }>(pool, 'SELECT COUNT(*)::int AS n FROM users WHERE id = $1', [victim.id]);
  eq(gone.rows[0]!.n, 0, 'and it is really gone');
}

await finish();
