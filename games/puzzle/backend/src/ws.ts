// Live gameplay over one socket per player.
//
// What travels over the socket is what is cheap and constant: who is here, how far along everyone is, the
// countdown, the start. What decides anything — a stake, a result, a payout — stays a REST call, because those
// are durable commands that must survive a dropped connection and be safe to retry. The socket is how the game
// feels alive; it is never how gold moves.
//
// The server stays authoritative. A `progress` message is clamped, refused unless the sender holds a seat in a
// match that is actually being played, and can only ever move forwards. Nothing a client sends is taken as
// fact about anyone else.
import { WebSocketServer, WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'node:http';
import { WS_PATH, config } from './config.js';
import { pool, tx } from './db.js';
import * as R from './rooms.js';
import { userForToken, type User } from './auth.js';
import { subscribeAll, publish, type MatchEvent } from './events.js';
import { liveProgress, online, roomPresence } from './presence.js';
import { check, subjectFor, LIMITS } from './ratelimit.js';
import { cookies } from './httpkit.js';
import { log } from './log.js';

interface Client { socket: WebSocket; user: User; watching: string | null; alive: boolean; }

const clients = new Set<Client>();
/** Which sockets are watching which room, so an event costs one lookup rather than a scan. */
const byRoom = new Map<string, Set<Client>>();

export const wsStats = () => ({
  connections: clients.size,
  rooms_watched: byRoom.size,
  players: new Set([...clients].map(c => c.user.id)).size,
});

const send = (c: Client, payload: unknown): void => {
  if (c.socket.readyState === WebSocket.OPEN) {
    try { c.socket.send(JSON.stringify(payload)); } catch { /* the socket is going away; the sweep will clean up */ }
  }
};

function watch(c: Client, code: string): void {
  unwatch(c);
  c.watching = code;
  let set = byRoom.get(code);
  if (!set) { set = new Set(); byRoom.set(code, set); }
  set.add(c);
}
function unwatch(c: Client): void {
  if (!c.watching) return;
  const set = byRoom.get(c.watching);
  if (set) { set.delete(c); if (!set.size) byRoom.delete(c.watching); }
  c.watching = null;
}

/**
 * The whole truth about a room, read from PostgreSQL.
 *
 * Sent on watch and on reconnect: a phone that lost signal mid-race asks once and is back in step, rather than
 * replaying events it missed or trusting whatever it remembered. This is the resync.
 */
async function sendState(c: Client, code: string, reason: string): Promise<void> {
  const m = await R.matchRow(pool, code);
  if (!m) { send(c, { type: 'no_match', code }); return; }
  const view = await R.matchView(pool, m, c.user.id);
  send(c, { type: 'state', reason, code, at: Date.now(), match: view, live: await liveProgress.all(code) });
}

/** The token a socket may authenticate with: a browser's cookie, or ?token= for a client that cannot set one. */
function tokenFromUpgrade(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim() || null;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const q = url.searchParams.get('token');
  if (q) return q;
  return cookies(req.headers.cookie)[config.auth.cookie] ?? null;
}

export function attachWebSocket(app: FastifyInstance): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  app.server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== WS_PATH) return;                 // not ours: leave it for anything else listening

    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
      || req.socket.remoteAddress || 'unknown';
    const verdict = await check('ws_connect', subjectFor(LIMITS.ws_connect, ip, null));
    if (!verdict.allowed) {
      socket.write(`HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${Math.max(1, verdict.retryAfter)}\r\n\r\n`);
      socket.destroy();
      return;
    }
    const user = await userForToken(tokenFromUpgrade(req));
    if (!user) {
      // Signing in is only needed to play with other people, so an anonymous socket has nothing to watch.
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      const c: Client = { socket: ws, user, watching: null, alive: true };
      clients.add(c);
      void online.seen(user.id);
      send(c, { type: 'hello', user_id: user.id, name: user.name, server_time: Date.now(), heartbeat_seconds: 30 });
      log.info('socket open', { user_id: user.id, connections: clients.size });

      ws.on('pong', () => { c.alive = true; void online.seen(user.id); });

      ws.on('message', async raw => {
        let msg: { type?: string; code?: string; pct?: number; run?: unknown };
        try { msg = JSON.parse(String(raw)) as typeof msg; } catch { return; }
        const code = String(msg.code ?? '').trim().toUpperCase();

        switch (msg.type) {
          case 'ping':
            send(c, { type: 'pong', at: Date.now() });
            await online.seen(user.id);
            return;

          case 'watch': {
            if (!code) return;
            const seats = await R.room(pool, code);
            // only the people actually in a room get its live feed: a code is not a ticket to watch strangers
            if (!seats.some(p => p.user_id === user.id)) { send(c, { type: 'not_yours', code }); return; }
            watch(c, code);
            await roomPresence.join(code, user.id);
            await sendState(c, code, 'watch');
            await publish(code, 'player_connected', { user_id: user.id, name: user.name });
            return;
          }

          case 'resync':
            if (c.watching) await sendState(c, c.watching, 'resync');
            return;

          case 'progress': {
            const target = c.watching;
            if (!target || !Number.isFinite(msg.pct)) return;
            const limit = await check('match_progress', subjectFor(LIMITS.match_progress, ip, user.id));
            if (!limit.allowed) { send(c, { type: 'rate_limited', retry_after: limit.retryAfter }); return; }
            const m = await R.matchRow(pool, target);
            if (!m || m.state !== 'playing') return;
            const seats = await R.room(pool, target);
            if (!seats.some(p => p.user_id === user.id)) return;
            const pct = await tx(t => R.saveProgress(t, target, user.id, Number(msg.pct), R.cleanRun(msg.run)));
            await liveProgress.set(target, user.id, pct);
            await publish(target, 'progress_updated', { user_id: user.id, name: user.name, pct });
            return;
          }

          case 'leave_feed':
            unwatch(c);
            return;
        }
      });

      ws.on('close', async () => {
        const room = c.watching;
        unwatch(c);
        clients.delete(c);
        // only say they are gone if this was their last socket: a reload opens the new one before closing the old
        const stillHere = [...clients].some(o => o.user.id === user.id);
        if (!stillHere) await online.gone(user.id);
        if (room) {
          await roomPresence.leave(room, user.id);
          if (!stillHere) await publish(room, 'player_disconnected', { user_id: user.id, name: user.name });
        }
        log.info('socket closed', { user_id: user.id, connections: clients.size });
      });

      ws.on('error', e => log.err('socket error', e, { user_id: user.id }));
    });
  });

  // Fan out what the game logic publishes, from whichever container raised it.
  void subscribeAll((ev: MatchEvent) => {
    // An invitation is addressed to a player, not to a room: it goes to every socket that player has open,
    // wherever they are in the game, and to nobody else.
    if (ev.code.startsWith(':u')) {
      const id = Number(ev.code.slice(2));
      for (const c of clients) if (c.user.id === id) send(c, ev);
      return;
    }
    const set = byRoom.get(ev.code);
    if (!set) return;
    for (const c of set) send(c, ev);
    // A start or a finish changes everything a client draws, so follow the event with the authoritative state
    // rather than making every client ask for it.
    if (ev.type === 'match_started' || ev.type === 'match_finished' || ev.type === 'room_closed') {
      for (const c of set) void sendState(c, ev.code, ev.type);
    }
  });

  // A socket that stops answering is a socket holding a seat nobody is sitting in.
  const beat = setInterval(() => {
    for (const c of [...clients]) {
      if (!c.alive) { try { c.socket.terminate(); } catch { /* already gone */ } clients.delete(c); unwatch(c); continue; }
      c.alive = false;
      try { c.socket.ping(); } catch { /* the close handler will tidy up */ }
    }
  }, 30_000);
  beat.unref?.();

  // The countdown is a server fact, so the server says it: one tick a second to the rooms that are counting,
  // which keeps every client's clock the same and stops the second joiner seeing a frozen number.
  const ticker = setInterval(async () => {
    for (const code of [...byRoom.keys()]) {
      const m = await R.matchRow(pool, code).catch(() => null);
      if (!m || m.state !== 'open' || m.fills_at === null) continue;
      const left = Math.max(0, Math.round((m.fills_at.getTime() - Date.now()) / 1000));
      for (const c of byRoom.get(code) ?? []) send(c, { type: 'countdown_tick', code, at: Date.now(), data: { fills_in: left } });
    }
  }, 1_000);
  ticker.unref?.();

  app.addHook('onClose', async () => { clearInterval(beat); clearInterval(ticker); wss.close(); });
  log.info('websocket listening', { path: WS_PATH });
}
