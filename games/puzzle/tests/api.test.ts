// The HTTP surface, exercised over the wire against a running arrow-atlas-api.
//
// Point it at the API directly, or at nginx, with AA_TEST_BASE. Everything here is the outside view: what a
// browser and a phone app can actually do, what they are refused, and what happens when Redis disappears.
import { pool, query, tx } from '../backend/src/db.js';
import { redis } from '../backend/src/redis.js';
import { config } from '../backend/src/config.js';
import { give, idem } from '../backend/src/gold.js';
import { startSession } from '../backend/src/auth.js';
import { online } from '../backend/src/presence.js';
import { eq, finish, ok, reset, section } from './helpers.js';

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

  // The game was renamed; its wire was not renamed out from under the copies already running. A page held in
  // a cache, or an installed app that has not fetched a new script, asks the old prefix and must be answered.
  const legacy = await call('/lobby', { base: `${BASE}/api/arrow-atlas/v1` });
  eq(legacy.status, 200, 'the prefix the game had before its rename still answers');
  const now = await call('/lobby');
  eq(JSON.stringify(Object.keys(legacy.json).sort()), JSON.stringify(Object.keys(now.json).sort()),
     'and answers with the same thing as the name it goes by now');
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
  const made = await call('/matches', { token: a.token, body: { stake: config.game.stakes[1], open_to_all: true, tier: 2 } });
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

section('The tour syncs over the wire, and only for the signed in');
{
  const out = await call('/progress', {});
  eq(out.status, 401, 'a stranger cannot read a tour');

  const p = await mint('apiProgress', 1_000);
  const push = await call('/progress', { token: p.token, body: { levels: { bd: { cleared: true, stars: 3, ms: 41_000 } }, state: { home: 'bd' } } });
  eq(push.status, 200, 'a push is accepted');
  eq(((push.json.levels as Record<string, { stars: number }>).bd)?.stars, 3, 'and answers with the merged tour');
  eq((push.json.state as { home: string })?.home, 'bd', 'settings included');

  const read = await call('/progress', { token: p.token });
  eq(read.status, 200, 'and it can be read back');
  eq(((read.json.levels as Record<string, { ms: number }>).bd)?.ms, 41_000, 'with the time that was sent');

  // the merge rule, through the routes rather than through the module
  await call('/progress', { token: p.token, body: { levels: { bd: { cleared: true, stars: 1, ms: 300_000 } } } });
  const after = await call('/progress', { token: p.token });
  eq(((after.json.levels as Record<string, { stars: number }>).bd)?.stars, 3, 'a worse run sent afterwards does not win');
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
  const made = await call('/matches', { token: me.token, body: { stake: config.game.stakes[0], open_to_all: false } });
  const code = (made.json.match as { code: string }).code;
  await call(`/matches/${code}/join`, { token: rival.token, body: {} });
  await call(`/matches/${code}/start`, { token: me.token, body: {} });
  await call(`/matches/${code}/result`, { token: me.token, body: { ms: 3_000, cleared: true } });

  const after = await call('/league', { token: me.token });
  const place = after.json.me as { rank: number | null; earning: number };
  eq(place.rank, 1, 'the winner is first in a league nobody else has won in');
  eq(place.earning, config.game.stakes[0], 'having won the other seat\u2019s stake');
  const top = after.json.top as { name: string; you: boolean }[];
  ok(top.some(r => r.you), 'and the row is marked as theirs');
  const loser = await call('/league', { token: rival.token });
  const lost = loser.json.me as { rank: number | null; earning: number };
  ok(typeof lost.rank === 'number' && lost.rank > 1, 'the player who lost their stake is still in the table, below the winner');
  eq(lost.earning, -(config.game.stakes[0] ?? 0), 'with the stake they lost standing as their week so far');
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
  await call(`/matches/${code}/start`, { token: host.token, body: {} });
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
  await call(`/matches/${busyCode}/start`, { token: mate.token, body: {} });
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
  eq((await call('/boards/pace?level_id=050&tier=0&ms=0')).status, 400, 'and a time of nothing');

  const quiet = await call('/boards/pace?level_id=pace-board&tier=1&ms=30000');
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
                      VALUES ($1, 'pace-board', true, $2, 3, 1, 40)`, [u.rows[0]!.id, ms]);
    }
  });
  const nearly = await call('/boards/pace?level_id=pace-board&tier=1&ms=30000', { token: me.token });
  eq(nearly.json.n, 19, 'nineteen clears are counted');
  eq(nearly.json.beats_pct, undefined, 'but still no percentage: a share of nineteen is a guess dressed as a fact');

  // The twentieth crosses the floor, and now the answer is worth saying.
  await tx(async c => {
    const u = await query<{ id: number }>(c,
      `INSERT INTO users (provider, sub, name, gold) VALUES ('test', $1, 'pacer19', 0) RETURNING id`,
      [`pace-19-${Date.now()}-${Math.random()}`]);
    await query(c, `INSERT INTO progress (user_id, level_id, cleared, ms, stars, tier, arrows)
                    VALUES ($1, 'pace-board', true, 29000, 3, 1, 40)`, [u.rows[0]!.id]);
  });
  const slow = await call('/boards/pace?level_id=pace-board&tier=1&ms=40000', { token: me.token });
  eq(slow.json.n, 20, 'twenty clears are enough');
  eq(slow.json.beats_pct, 0, 'a run slower than all of them beats none of them');
  const quick = await call('/boards/pace?level_id=pace-board&tier=1&ms=9000', { token: me.token });
  eq(quick.json.beats_pct, 100, 'and one faster than all of them beats them all');
  const middling = await call('/boards/pace?level_id=pace-board&tier=1&ms=20000', { token: me.token });
  ok((middling.json.beats_pct as number) > 40 && (middling.json.beats_pct as number) < 60,
     `a middling run lands in the middle (${middling.json.beats_pct}%)`);

  // The difficulty is part of the question: the same board on Master is a different board to compare against.
  eq((await call('/boards/pace?level_id=pace-board&tier=3&ms=20000')).json.n, 0, 'another difficulty is another table');

  // A player is never compared with themselves.
  await call('/progress', { token: me.token, body: { levels: { 'pace-board': { cleared: true, ms: 1, stars: 3, tier: 1, arrows: 40 } } } });
  eq((await call('/boards/pace?level_id=pace-board&tier=1&ms=20000', { token: me.token })).json.n, 20,
     'their own row is left out of the count');
}

await finish();
