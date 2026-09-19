// Load the new service the way the old one was loaded, so the two sets of numbers mean the same thing.
//
//   npx tsx ../tests/load.ts read  30 8     GET  a room, the poll every client used to make
//   npx tsx ../tests/load.ts write 30 8     POST progress, the write path during a race
//   npx tsx ../tests/load.ts ws    200      open N sockets, watch rooms, push progress, measure the fan-out
import { readFileSync } from 'node:fs';

const BASE = process.env.AA_TEST_BASE ?? 'http://127.0.0.1:8760';
const V = `${BASE}/api/puzzle/v1`;
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws/puzzle';
const tokens = readFileSync(new URL('./load-tokens.txt', import.meta.url), 'utf8').split('\n').filter(Boolean);
const codes = readFileSync(new URL('./load-codes.txt', import.meta.url), 'utf8').split('\n').filter(Boolean);

const noteWhy = (code: string) => {
  const w = (globalThis as { __aaWhy?: Map<string, number> }).__aaWhy;
  if (w) w.set(code, (w.get(code) ?? 0) + 1);
};
const pct = (sorted: number[], q: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]! : 0;
const report = (label: string, lat: number[], elapsed: number, errors: number, extra = '') => {
  const s = [...lat].sort((a, b) => a - b);
  console.log(`${label.padEnd(22)} req=${String(lat.length).padEnd(7)} ${(lat.length / elapsed).toFixed(0).padStart(6)} req/s   ` +
    `p50=${pct(s, .5).toFixed(1).padStart(7)}ms p95=${pct(s, .95).toFixed(1).padStart(7)}ms p99=${pct(s, .99).toFixed(1).padStart(7)}ms ` +
    `max=${pct(s, 1).toFixed(1).padStart(7)}ms  errors=${errors}${extra}`);
};

/** Keep `conc` requests in flight for `secs`, and record how long each took. */
async function hammer(label: string, conc: number, secs: number, one: (i: number) => Promise<boolean>): Promise<void> {
  const lat: number[] = []; let errors = 0, i = 0;
  const why = new Map<string, number>();
  (globalThis as { __aaWhy?: Map<string, number> }).__aaWhy = why;
  const until = Date.now() + secs * 1000;
  const worker = async () => {
    while (Date.now() < until) {
      const t = performance.now();
      const ok = await one(i++).catch(() => false);
      lat.push(performance.now() - t);
      if (!ok) errors++;
    }
  };
  const t0 = performance.now();
  await Promise.all(Array.from({ length: conc }, worker));
  const reasons = [...why.entries()].map(([k2, n]) => `${k2}x${n}`).join(' ');
  report(label, lat, (performance.now() - t0) / 1000, errors, reasons ? `  (${reasons})` : '');
  if (errors > lat.length * 0.01) console.log(`  !! ${errors} of ${lat.length} failed — this number measures the failure path, not the service`);
}

const mode = process.argv[2] ?? 'read';
const conc = Number(process.argv[3] ?? 30);
const secs = Number(process.argv[4] ?? 8);

if (mode === 'read') {
  await hammer(`READ conc=${conc}`, conc, secs, async i => {
    const r = await fetch(`${V}/matches/${codes[i % codes.length]}`, {
      headers: { Authorization: `Bearer ${tokens[i % tokens.length]}` },
    });
    await r.json().catch(() => ({}));
    if (!r.ok) noteWhy(String(r.status));
    return r.ok;
  });
}

if (mode === 'write') {
  // Put the seeded rooms into play so progress has somewhere to land, then post progress as the players.
  const pairs: [string, string][] = [];
  const { pool, query } = await import('../backend/src/db.js');
  await query(pool, `UPDATE matches SET state='playing', started_at=now() WHERE state='open'`);
  const rows = await query<{ code: string; user_id: number }>(pool,
    `SELECT p.code, p.user_id FROM match_players p JOIN matches m ON m.code=p.code WHERE m.state='playing'`);
  for (const r of rows.rows) { const t = tokens[r.user_id - 1]; if (t) pairs.push([r.code, t]); }
  await pool.end();
  console.log(`(${pairs.length} seated players in live races)`);
  await hammer(`WRITE conc=${conc}`, conc, secs, async i => {
    const [code, token] = pairs[i % pairs.length]!;
    const r = await fetch(`${V}/matches/${code}/progress`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pct: i % 100 }),
    });
    if (!r.ok) noteWhy(String(r.status));
    return r.ok;
  });
}

if (mode === 'ws') {
  const want = Number(process.argv[3] ?? 200);
  const seconds = Number(process.argv[4] ?? 10);
  const { pool, query } = await import('../backend/src/db.js');
  await query(pool, `UPDATE matches SET state='playing', started_at=now() WHERE state='open'`);
  const rows = await query<{ code: string; user_id: number }>(pool,
    `SELECT p.code, p.user_id FROM match_players p JOIN matches m ON m.code=p.code WHERE m.state='playing' LIMIT ${want}`);
  await pool.end();

  let open = 0, failed = 0, received = 0, sent = 0;
  const connectMs: number[] = [], firstStateMs: number[] = [];
  const sockets: WebSocket[] = [];

  await Promise.all(rows.rows.map(r => new Promise<void>(res => {
    const token = tokens[r.user_id - 1];
    if (!token) { failed++; return res(); }
    const t0 = performance.now();
    const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
    sockets.push(ws);
    let asked = 0;
    ws.addEventListener('open', () => { open++; connectMs.push(performance.now() - t0); asked = performance.now(); ws.send(JSON.stringify({ type: 'watch', code: r.code })); });
    ws.addEventListener('message', e => {
      received++;
      try { if (JSON.parse(String(e.data)).type === 'state' && asked) { firstStateMs.push(performance.now() - asked); asked = 0; res(); } } catch { /* ignore */ }
    });
    ws.addEventListener('error', () => { failed++; res(); });
    setTimeout(res, 20_000);
  })));
  console.log(`sockets: ${open} open, ${failed} failed`);
  report('WS connect', connectMs, 1, failed);
  report('WS first state', firstStateMs, 1, 0);

  // Now push progress over every socket, once a second each, and count what comes back.
  const before = received;
  const t0 = performance.now();
  const push = setInterval(() => {
    for (const ws of sockets) if (ws.readyState === 1) { ws.send(JSON.stringify({ type: 'progress', pct: Math.floor(Math.random() * 100) })); sent++; }
  }, 1000);
  await new Promise(r => setTimeout(r, seconds * 1000));
  clearInterval(push);
  const elapsed = (performance.now() - t0) / 1000;
  console.log(`\nover ${elapsed.toFixed(1)}s with ${open} sockets: ${sent} progress messages sent, ` +
    `${received - before} events received (${((received - before) / elapsed).toFixed(0)} events/s fanned out)`);
  for (const ws of sockets) ws.close();
  setTimeout(() => process.exit(0), 500);
}
