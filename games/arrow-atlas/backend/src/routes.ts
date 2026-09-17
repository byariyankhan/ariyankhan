// The Arrow Atlas HTTP surface.
//
// Every action is written once, as a handler over a Caller, and then mounted twice: at the versioned path a
// phone app and the current web client use, and at the old PHP query-string paths so a browser running a cached
// copy of the game keeps working through the changeover. The handlers are shared, so the two surfaces cannot
// drift apart, and the legacy mount can be deleted one day without touching any logic.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { API_PREFIX, config } from './config.js';
import { pool, tx } from './db.js';
import * as R from './rooms.js';
import { balance } from './gold.js';
import { deleteUser, endSession, googleVerify, providers, startSession, upsertUser, cleanName } from './auth.js';
import { publish } from './events.js';
import { liveProgress, roomPresence } from './presence.js';
import { body, caller, clearSessionCookie, limited, noStore, setSessionCookie, shapeUser, type Caller } from './httpkit.js';
import { log } from './log.js';

type Req = FastifyRequest; type Res = FastifyReply;

const codeOf = (req: Req): string => {
  const p = (req.params ?? {}) as { code?: string };
  const q = (req.query ?? {}) as { code?: string };
  const b = body(req);
  return String(p.code ?? q.code ?? b.code ?? '').trim().toUpperCase();
};

/** The answer every match route gives: the room as this caller may see it, and what they now hold. */
async function replyMatch(
  res: Res, code: string, me: Caller, extra: Record<string, unknown> = {},
  known?: { m: R.MatchRow; seats: Awaited<ReturnType<typeof R.room>> },
): Promise<void> {
  const m = known?.m ?? await R.matchRow(pool, code);
  if (!m) { await noStore(res).code(404).send({ error: 'no_match' }); return; }
  const seats = known?.seats ?? await R.room(pool, m.code);
  const [view, gold] = await Promise.all([
    R.matchView(pool, m, me.user?.id ?? null, seats),
    me.user ? balance(pool, me.user.id) : Promise.resolve(null),
  ]);
  await noStore(res).send({ match: view, gold, ...extra });
}

// ── Accounts ──

const H = {
  async me(req: Req, res: Res, me: Caller) {
    if (!(await limited('auth_read', req, res, me.user?.id ?? null))) return;
    await noStore(res).send({ user: shapeUser(me.user), providers: { google: providers().google } });
  },

  async google(req: Req, res: Res, me: Caller) {
    if (!(await limited('auth_signin', req, res, null))) return;
    const clientId = providers().google;
    if (!clientId) { await noStore(res).code(503).send({ error: 'google_not_configured' }); return; }
    const credential = String(body(req).credential ?? '');
    const claims = await googleVerify(credential, clientId);
    if (!claims) { await noStore(res).code(401).send({ error: 'bad_token' }); return; }

    // An app asks for the token in the body; a browser gets it as a cookie and never sees it in JavaScript.
    const wantsToken = me.client === 'app' || body(req).client === 'app';
    const out = await tx(async c => {
      const { user, created } = await upsertUser(c, 'google', claims);
      const token = await startSession(c, user.id, wantsToken ? 'app' : 'web');
      return { user, created, token };
    });
    if (!wantsToken) setSessionCookie(res, out.token);
    log.info('signed in', { user_id: out.user.id, created: out.created, client: wantsToken ? 'app' : 'web' });
    await noStore(res).send({
      user: shapeUser(out.user),
      gold_granted: out.created ? config.game.signupGold : 0,
      ...(wantsToken ? { token: out.token, expires_in_days: config.auth.sessionDays } : {}),
    });
  },

  async rename(req: Req, res: Res, me: Caller) {
    if (!me.user) { await noStore(res).code(401).send({ error: 'signed_out' }); return; }
    if (!(await limited('auth_write', req, res, me.user.id))) return;
    const name = cleanName(String(body(req).name ?? ''));
    if (!name) { await noStore(res).code(400).send({ error: 'empty_name' }); return; }
    await pool.query('UPDATE users SET name = $2 WHERE id = $1', [me.user.id, name]);
    await noStore(res).send({ user: shapeUser({ ...me.user, name }) });
  },

  async logout(_req: Req, res: Res, me: Caller) {
    await endSession(me.token);
    clearSessionCookie(res);
    await noStore(res).send({ user: null });
  },

  async destroy(req: Req, res: Res, me: Caller) {
    if (!me.user) { await noStore(res).code(401).send({ error: 'signed_out' }); return; }
    if (!(await limited('account_delete', req, res, me.user.id))) return;
    await deleteUser(me.user.id, R.releasePlayer);
    clearSessionCookie(res);
    log.info('account deleted', { user_id: me.user.id });
    await noStore(res).send({ user: null, deleted: true });
  },

  // ── Rooms ──

  async lobby(req: Req, res: Res, me: Caller) {
    if (!(await limited('lobby_read', req, res, me.user?.id ?? null))) return;
    await noStore(res).send({
      waiting: await R.lobbyCounts(),
      gold: me.user ? await balance(pool, me.user.id) : null,
      stakes: config.game.stakes,
    });
  },

  async create(req: Req, res: Res, me: Caller) {
    if (!me.user) { await noStore(res).code(401).send({ error: 'signed_out' }); return; }
    if (!(await limited('match_create', req, res, me.user.id))) return;
    const b = body(req);
    const made = await R.createMatch(me.user, Number(b.stake ?? 0), Boolean(b.open_to_all), Number(b.tier ?? 2));
    if (!made.ok) {
      const status = made.error === 'no_boards' ? 503 : 400;
      await noStore(res).code(status).send({ error: made.error, ...(made.gold !== undefined ? { gold: made.gold } : {}) });
      return;
    }
    if (made.joined) await publish(made.code, 'player_joined_room', { name: me.user.name });
    await replyMatch(res, made.code, me);
  },

  async get(req: Req, res: Res, me: Caller) {
    if (!(await limited('match_read', req, res, me.user?.id ?? null))) return;
    const code = codeOf(req);
    const m = await R.matchRow(pool, code);
    if (!m) { await noStore(res).code(404).send({ error: 'no_match' }); return; }
    const seats = await R.room(pool, m.code);
    // Still sitting alone in a room that fills itself? Walk into an older one if one has turned up since. This
    // is the request every client makes twice a minute, so the transaction is only opened when it could do
    // something — which is the rare case of a room with exactly one player in it.
    if (me.user && R.requeueWorthTrying(m, seats, me.user.id)) {
      const moved = await tx(async c => {
        const locked = await R.matchRowLocked(c, code);
        return locked ? R.requeue(c, locked, me.user!.id) : null;
      });
      if (moved) { await publish(moved, 'player_joined_room', { name: me.user.name }); await replyMatch(res, moved, me); return; }
    }
    await replyMatch(res, m.code, me, {}, { m, seats });
  },

  async join(req: Req, res: Res, me: Caller) {
    if (!me.user) { await noStore(res).code(401).send({ error: 'signed_out' }); return; }
    if (!(await limited('match_join', req, res, me.user.id))) return;
    const code = codeOf(req);
    const out = await tx(c => R.joinRoomTx(c, me.user!.id, code, Number(body(req).tier ?? 2)));
    if (!out.ok) {
      const status = out.error === 'no_match' ? 404 : out.error === 'not_enough_gold' ? 400 : 409;
      await noStore(res).code(status).send({ error: out.error, ...(out.gold !== undefined ? { gold: out.gold } : {}) });
      return;
    }
    if (!out.already) await publish(out.code, 'player_joined_room', { name: me.user.name });
    if (out.started) await R.announceStart(out.code);
    await replyMatch(res, out.code, me);
  },

  async start(req: Req, res: Res, me: Caller) {
    if (!me.user) { await noStore(res).code(401).send({ error: 'signed_out' }); return; }
    if (!(await limited('match_join', req, res, me.user.id))) return;
    const code = codeOf(req);
    const outcome = await tx(async c => {
      const m = await R.matchRowLocked(c, code);
      if (!m) return 'no_match' as const;
      if (m.host_id !== me.user!.id) return 'not_host' as const;
      if (m.state !== 'open') return 'taken' as const;
      if (m.open_to_all) return 'clock_starts_it' as const;   // only the clock starts a room that fills itself
      if ((await R.room(c, code)).length < 2) return 'need_two' as const;
      return (await R.startRoom(c, code)) ? 'started' as const : 'taken' as const;
    });
    if (outcome !== 'started') {
      const status = outcome === 'no_match' ? 404 : outcome === 'not_host' ? 403 : outcome === 'need_two' ? 400 : 409;
      await noStore(res).code(status).send({ error: outcome });
      return;
    }
    await R.announceStart(code);
    await replyMatch(res, code, me);
  },

  /** Leaving the room. Anyone in it may go, and they take their own stake with them. */
  async leave(req: Req, res: Res, me: Caller) {
    if (!me.user) { await noStore(res).code(401).send({ error: 'signed_out' }); return; }
    if (!(await limited('match_join', req, res, me.user.id))) return;
    const code = codeOf(req);
    const m = await R.matchRow(pool, code);
    if (!m) { await noStore(res).code(404).send({ error: 'no_match' }); return; }
    if (m.state !== 'open') { await noStore(res).code(409).send({ error: 'taken' }); return; }
    const out = await tx(c => R.leaveRoom(c, code, me.user!.id));
    if (out === null) { await noStore(res).code(403).send({ error: 'not_yours' }); return; }
    await publish(code, out === 'closed' ? 'room_closed' : 'player_left_room', { name: me.user.name });
    await roomPresence.leave(code, me.user.id);
    const after = await R.matchRow(pool, code);
    await noStore(res).send({
      match: after ? await R.matchView(pool, after, me.user.id) : null,
      gold: await balance(pool, me.user.id),
      closed: after?.state === 'void',
    });
  },

  async progress(req: Req, res: Res, me: Caller) {
    if (!me.user) { await noStore(res).code(401).send({ error: 'signed_out' }); return; }
    if (!(await limited('match_progress', req, res, me.user.id))) return;
    const code = codeOf(req);
    const m = await R.matchRow(pool, code);
    if (!m) { await noStore(res).code(404).send({ error: 'no_match' }); return; }
    const seats = await R.room(pool, code);
    if (!seats.some(p => p.user_id === me.user!.id)) { await noStore(res).code(403).send({ error: 'not_yours' }); return; }
    if (m.state === 'playing' && body(req).pct !== undefined) {
      const pct = await tx(c => R.saveProgress(c, code, me.user!.id, Number(body(req).pct)));
      await liveProgress.set(code, me.user.id, pct);
      await publish(code, 'progress_updated', { user_id: me.user.id, name: me.user.name, pct });
    }
    await replyMatch(res, code, me);
  },

  async result(req: Req, res: Res, me: Caller) {
    if (!me.user) { await noStore(res).code(401).send({ error: 'signed_out' }); return; }
    if (!(await limited('match_result', req, res, me.user.id))) return;
    const code = codeOf(req);
    const m = await R.matchRow(pool, code);
    if (!m) { await noStore(res).code(404).send({ error: 'no_match' }); return; }
    const seats = await R.room(pool, code);
    if (!seats.some(p => p.user_id === me.user!.id)) { await noStore(res).code(403).send({ error: 'not_yours' }); return; }
    if (m.state !== 'playing') { await replyMatch(res, code, me); return; }

    const b = body(req);
    const settled = await tx(async c => {
      await R.submitResult(c, code, me.user!.id, Number(b.ms ?? -1), b.cleared === true);
      return R.settleMatch(c, code);
    });
    await publish(code, 'player_finished', { user_id: me.user.id, name: me.user.name, cleared: b.cleared === true });
    if (settled?.state === 'done') { await publish(code, 'match_finished', { winner_id: settled.winner_id }); await liveProgress.clear(code); }
    await replyMatch(res, code, me);
  },
};

// ── Mounting ──

const withCaller = (fn: (req: Req, res: Res, me: Caller) => Promise<void>) =>
  async (req: Req, res: Res) => { await fn(req, res, await caller(req)); };

export function registerRoutes(app: FastifyInstance): void {
  const v1 = API_PREFIX;

  app.get(`${v1}/auth/me`, withCaller(H.me));
  app.post(`${v1}/auth/google`, withCaller(H.google));
  app.post(`${v1}/auth/name`, withCaller(H.rename));
  app.post(`${v1}/auth/logout`, withCaller(H.logout));
  app.post(`${v1}/auth/delete`, withCaller(H.destroy));

  app.get(`${v1}/lobby`, withCaller(H.lobby));
  app.post(`${v1}/matches`, withCaller(H.create));
  app.get(`${v1}/matches/:code`, withCaller(H.get));
  app.post(`${v1}/matches/:code/join`, withCaller(H.join));
  app.post(`${v1}/matches/:code/start`, withCaller(H.start));
  app.post(`${v1}/matches/:code/leave`, withCaller(H.leave));
  app.post(`${v1}/matches/:code/progress`, withCaller(H.progress));
  app.post(`${v1}/matches/:code/result`, withCaller(H.result));

  // ── The old surface, kept alive for clients holding a cached copy of the game ──
  //
  // These are the exact paths and query strings the PHP service answered, returning the exact same shapes.
  // Nothing new should be added here; it exists so the changeover is invisible, and it can be removed once the
  // service worker has handed every player the new client.
  const legacyAuth: Record<string, (req: Req, res: Res, me: Caller) => Promise<void>> = {
    me: H.me, google: H.google, name: H.rename, logout: H.logout, delete: H.destroy,
  };
  const legacyMatch: Record<string, (req: Req, res: Res, me: Caller) => Promise<void>> = {
    create: H.create, get: H.get, join: H.join, start: H.start,
    cancel: H.leave, progress: H.progress, result: H.result, lobby: H.lobby,
  };
  // Which of them a GET may reach. The PHP service answered `post_only` with a 405 to everything else, and that
  // 405 was not politeness: the session cookie is SameSite=Lax, which a browser still sends on a top-level
  // cross-site GET, so `?a=delete` behind a link would have deleted the reader's account. Anything that changes
  // something is POST-only here for exactly the same reason.
  const legacyReads: Record<string, Set<string>> = {
    auth: new Set(['me']),
    match: new Set(['get', 'lobby']),
  };

  const legacy = (
    surface: 'auth' | 'match',
    table: Record<string, (req: Req, res: Res, me: Caller) => Promise<void>>,
    fallback: string,
  ) => async (req: Req, res: Res) => {
    const a = String(((req.query ?? {}) as { a?: string }).a ?? fallback);
    const fn = table[a];
    if (!fn) { await noStore(res).code(404).send({ error: 'unknown_action' }); return; }
    if (req.method !== 'POST' && !legacyReads[surface]!.has(a)) {
      await noStore(res).code(405).send({ error: 'post_only' });
      return;
    }
    await fn(req, res, await caller(req));
  };

  for (const method of ['get', 'post'] as const) {
    app[method]('/games/api/auth.php', legacy('auth', legacyAuth, 'me'));
    app[method]('/games/api/match.php', legacy('match', legacyMatch, 'get'));
  }
}
