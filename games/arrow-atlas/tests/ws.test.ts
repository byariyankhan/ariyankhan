// The live layer: connecting, watching a room, the countdown the server owns, progress that only moves
// forwards, what a stranger is not allowed to see, and what a reconnecting phone gets back.
import { pool, query, tx } from '../backend/src/db.js';
import { give, idem } from '../backend/src/gold.js';
import { startSession } from '../backend/src/auth.js';
import { eq, finish, ok, reset, section } from './helpers.js';

const BASE = process.env.AA_TEST_BASE ?? 'http://127.0.0.1:8760';
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws/arrow-atlas';
const V = BASE + '/api/arrow-atlas/v1';

async function mint(name: string, gold = 100_000): Promise<{ id: number; token: string }> {
  return tx(async c => {
    const r = await query<{ id: number }>(c,
      `INSERT INTO users (provider, sub, name, gold) VALUES ('test', $1, $2, 0) RETURNING id`,
      [`ws-${name}-${Date.now()}-${Math.random()}`, name]);
    const id = r.rows[0]!.id;
    await give(c, id, gold, 'admin', idem.admin(`ws-mint:${id}`));
    return { id, token: await startSession(c, id, 'app') };
  });
}
const api = async (path: string, token: string, body?: unknown) =>
  (await fetch(V + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })).json() as Promise<Record<string, unknown>>;

/** Open a socket and collect what it says, so a test can wait for a particular message. */
function open(token: string) {
  const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
  const seen: Record<string, unknown>[] = [];
  ws.addEventListener('message', e => { try { seen.push(JSON.parse(String(e.data))); } catch { /* not ours */ } });
  const ready = new Promise<void>((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', () => rej(new Error('the socket would not open')));
  });
  const waitFor = async (type: string, ms = 8_000): Promise<Record<string, unknown>> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const hit = seen.find(m => m.type === type);
      if (hit) return hit;
      await new Promise(r => setTimeout(r, 40));
    }
    throw new Error(`waited ${ms}ms for a "${type}" and got: ${seen.map(m => m.type).join(', ') || 'nothing'}`);
  };
  return { ws, seen, ready, waitFor, send: (o: unknown) => ws.send(JSON.stringify(o)), close: () => ws.close() };
}

// Same reason as the HTTP suite: a room left waiting at the same stake by another suite would be joined rather
// than created, and the countdown test would be watching somebody else's clock.
await reset();

section('A socket needs a real session');
{
  const bad = new WebSocket(`${WS_URL}?token=${'0'.repeat(48)}`);
  const refused = await new Promise<boolean>(res => {
    bad.addEventListener('error', () => res(true));
    bad.addEventListener('open', () => { bad.close(); res(false); });
  });
  ok(refused, 'an unknown token is turned away at the upgrade');
}

section('Connecting, and being told who you are');
const a = await mint('wsAnn'), b = await mint('wsBen');
const sa = open(a.token);
await sa.ready;
{
  const hello = await sa.waitFor('hello');
  eq(hello.user_id, a.id, 'the socket says which account it belongs to');
  ok(typeof hello.server_time === 'number', 'and hands over the server clock, so the client can align to it');
}

section('Watching a room you are in, and not one you are not');
const made = await api('/matches', a.token, { stake: 500, open_to_all: false, tier: 2 }) as { match: { code: string } };
const code = made.match.code;
{
  sa.send({ type: 'watch', code });
  const state = await sa.waitFor('state');
  eq(state.code, code, 'watching returns the authoritative state at once');
  eq((state.match as { state: string }).state, 'open', 'and says the room is still open');

  const sb = open(b.token);
  await sb.ready;
  await sb.waitFor('hello');
  sb.send({ type: 'watch', code });          // b holds no seat in this room yet
  const no = await sb.waitFor('not_yours');
  eq(no.code, code, 'a player with no seat is refused the live feed');
  sb.close();
}

section('A player joining reaches the room over the socket');
{
  await api(`/matches/${code}/join`, b.token, { tier: 2 });
  const ev = await sa.waitFor('player_joined_room');
  eq(ev.code, code, 'the room hears about it');
}

section('The countdown is the server\'s, and it ticks');
{
  const fill = await api('/matches', a.token, { stake: 7000, open_to_all: true, tier: 2 }) as { match: { code: string } };
  const fillCode = fill.match.code;
  const sc = open(a.token); await sc.ready; await sc.waitFor('hello');
  sc.send({ type: 'watch', code: fillCode });
  await sc.waitFor('state');
  const c2 = await mint('wsCarl');
  await api(`/matches/${fillCode}/join`, c2.token, { tier: 2 });   // the second player starts the clock
  const tick1 = await sc.waitFor('countdown_tick', 6_000);
  const first = (tick1.data as { fills_in: number }).fills_in;
  ok(first > 0 && first <= 63, `the first tick is inside the window (${first}s)`);
  // and it actually counts down rather than repeating the same number, which is the bug the old client had
  await new Promise(r => setTimeout(r, 2_200));
  const ticks = sc.seen.filter(m => m.type === 'countdown_tick').map(m => (m.data as { fills_in: number }).fills_in);
  ok(Math.max(...ticks) - Math.min(...ticks) >= 1, `the number moves (${Math.max(...ticks)} -> ${Math.min(...ticks)})`);
  sc.close();
}

section('Progress is clamped, forward-only, and never taken on trust');
{
  await api(`/matches/${code}/start`, a.token, {});
  await sa.waitFor('match_started');
  sa.send({ type: 'progress', pct: 40 });
  const up = await sa.waitFor('progress_updated');
  eq((up.data as { pct: number }).pct, 40, 'progress reaches the room');

  sa.send({ type: 'progress', pct: 10 });              // backwards: must be ignored
  sa.send({ type: 'progress', pct: 900 });             // nonsense: must be clamped
  await new Promise(r => setTimeout(r, 600));
  const seat = await query<{ pct: number }>(pool,
    'SELECT pct FROM match_players WHERE code = $1 AND user_id = $2', [code, a.id]);
  eq(seat.rows[0]!.pct, 100, 'the server keeps the furthest honest value and clamps the rest');
}

section('A reconnecting client is handed the truth, not a guess');
{
  sa.close();
  const again = open(a.token);
  await again.ready;
  await again.waitFor('hello');
  again.send({ type: 'watch', code });
  const state = await again.waitFor('state');
  const m = state.match as { state: string; players: { you: boolean; pct: number }[] };
  eq(m.state, 'playing', 'the match is still being played');
  eq(m.players.find(p => p.you)?.pct, 100, 'and the reconnected player finds their own progress intact');
  ok(state.live !== undefined, 'the live mirror comes with it, so the board redraws without another call');
  again.close();
}

section('A finish reaches the room and closes it out');
{
  const watcher = open(b.token); await watcher.ready; await watcher.waitFor('hello');
  watcher.send({ type: 'watch', code });
  await watcher.waitFor('state');
  await api(`/matches/${code}/result`, a.token, { ms: 3_000, cleared: true });
  const fin = await watcher.waitFor('player_finished');
  eq(fin.code, code, 'the room is told somebody finished');
  await api(`/matches/${code}/result`, b.token, { ms: -1, cleared: false });
  const done = await watcher.waitFor('match_finished');
  eq(done.code, code, 'and told when the match is over');
  watcher.close();
}

await finish();
