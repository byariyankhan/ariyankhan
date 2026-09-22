// The HTTP surface of Puzzle – Train Your Brain.
//
// Every action is written once, as a handler over a Caller, and mounted under the versioned prefix that both
// the web client and a phone app ask for. Durable commands stay here even where the socket could carry them:
// a request that changes gold should be something the client can retry and the server can answer once.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { API_PREFIX, config } from './config.js';
import { pool, tx } from './db.js';
import * as R from './rooms.js';
import { adClaim, balance } from './gold.js';
import { deleteUser, endSession, googleVerify, providers, startSession, upsertUser, cleanName } from './auth.js';
import { publish, publishToUser } from './events.js';
import { boardPace, cleanLevels, cleanState, mergeLevels, mergeState, readAll } from './progress.js';
import * as L from './league.js';
import { liveProgress, online, roomPresence } from './presence.js';
import { havePlayedTogether, isRacing, recentPlayers } from './players.js';
import * as push from './push.js';
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
    // The match this account is still in, if any, in the same shape the room screen is drawn from. This is
    // how a phone finds the challenge a browser tab started: the account is one account, and until now the
    // only copy of the code lived in whichever client had opened it.
    const live = me.user ? await R.liveMatchOf(pool, me.user.id) : null;
    const match = live ? await R.matchView(pool, live, me.user!.id) : null;
    await noStore(res).send({ user: shapeUser(me.user), providers: { google: providers().google }, match });
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

  // ── The league ──
  //
  // One table a week, built from the ledger rather than from a counter of its own, and open to a signed-out
  // visitor as well: the league is a reason to sign in, so it has to be visible before you do.

  async league(req: Req, res: Res, me: Caller) {
    if (!(await limited('league_read', req, res, me.user?.id ?? null))) return;
    const season = L.seasonAt();
    await L.ensureSeason(pool, season);
    const [top, mine, last] = await Promise.all([
      L.standings(pool, season, L.TABLE_SIZE),
      me.user ? L.placeOf(pool, season, me.user.id) : Promise.resolve(null),
      L.lastSettled(pool),
    ]);
    await noStore(res).send({
      season: {
        key: season.key,
        starts_at: season.startsAt.getTime(),
        ends_at: season.endsAt.getTime(),
        ends_in_ms: Math.max(0, season.endsAt.getTime() - Date.now()),
      },
      prizes: L.prizeLadder(),
      top: top.map(r => ({ ...r, you: !!me.user && r.user_id === me.user.id })),
      me: mine,
      last: last && {
        key: last.key,
        ends_at: last.ends_at.getTime(),
        paid: last.paid.map(r => ({ ...r, you: !!me.user && r.user_id === me.user.id })),
      },
    });
  },

  // ── Rooms ──

  // ── The tour ──
  //
  // A player's cleared boards belong to the account. The client keeps playing out of its own storage and syncs
  // around it, so none of this is ever in the way of a board: a push that fails costs freshness, not progress.

  async progressRead(req: Req, res: Res, me: Caller) {
    if (!me.user) { await noStore(res).code(401).send({ error: 'signed_out' }); return; }
    if (!(await limited('progress_read', req, res, me.user.id))) return;
    await noStore(res).send(await readAll(pool, me.user.id));
  },

  // Push what this device has, get back the merged whole. One call rather than a read and a write, because a
  // device that has just been handed the truth should adopt it in the same breath as it offers its own.
  async progressPush(req: Req, res: Res, me: Caller) {
    if (!me.user) { await noStore(res).code(401).send({ error: 'signed_out' }); return; }
    if (!(await limited('progress_write', req, res, me.user.id))) return;
    const b = body(req);
    const levels = cleanLevels(b.levels);
    const state = cleanState(b.state);
    const userId = me.user.id;
    const merged = await tx(async c => {
      await mergeLevels(c, userId, levels);
      if (state) await mergeState(c, userId, state);
      return readAll(c, userId);
    });
    await noStore(res).send(merged);
  },

  // Gold for having watched an advertisement.
  //
  // The client cannot be trusted with this and is not asked to be: it reports that an ad finished, and the
  // server decides what that is worth, how often, and whether it counts at all. The rule itself lives beside
  // the ledger in gold.ts, where it can be tested without a web server.
  async adReward(req: Req, res: Res, me: Caller) {
    if (!me.user) { await noStore(res).code(401).send({ error: 'signed_out' }); return; }
    if (!(await limited('ad_reward', req, res, me.user.id))) return;
    const amount = Math.max(0, Math.round(config.game.adGold));
    const perDay = Math.max(0, Math.round(config.game.adGoldPerDay));
    if (amount <= 0 || perDay <= 0) { await noStore(res).code(503).send({ error: 'ads_off' }); return; }

    const out = await tx(c => adClaim(c, me.user!.id, amount, perDay));
    if (out.capped) { await noStore(res).code(429).send({ error: 'ad_cap', gold: out.gold, left: 0, per_day: perDay }); return; }
    await noStore(res).send({ gold: out.gold, granted: out.granted, left: out.left, per_day: perDay, amount });
  },

  // How a cleared board went, against everybody else who has cleared it. Readable signed out: a player who has
  // not made an account still cleared the board, and the answer is about the board rather than about them.
  async pace(req: Req, res: Res, me: Caller) {
    if (!(await limited('board_pace', req, res, me.user?.id ?? null))) return;
    const q = (req.query ?? {}) as { level_id?: string; tier?: string; ms?: string };
    const levelId = String(q.level_id ?? '').slice(0, 64);
    const tier = Number(q.tier ?? NaN);
    const ms = Number(q.ms ?? NaN);
    if (!levelId || !Number.isInteger(tier) || tier < 0 || tier > 3
        || !Number.isFinite(ms) || ms <= 0 || ms > 86_400_000) {
      await noStore(res).code(400).send({ error: 'bad_board' });
      return;
    }
    await noStore(res).send(await boardPace(pool, levelId, tier, Math.round(ms), me.user?.id ?? null));
  },

  async lobby(req: Req, res: Res, me: Caller) {
    if (!(await limited('lobby_read', req, res, me.user?.id ?? null))) return;
    await noStore(res).send({
      waiting: await R.lobbyCounts(),
      gold: me.user ? await balance(pool, me.user.id) : null,
      stakes: config.game.stakes,
    });
  },

  // ── The people you play with ──
  //
  // No friends list, no requests, no search: the game already knows who you have sat at a table with, and
  // that is the whole list. It is also the permission — an invitation may only be sent to somebody you have
  // played with, so there is nothing here a stranger can reach.

  async recent(req: Req, res: Res, me: Caller) {
    if (!me.user) { await noStore(res).code(401).send({ error: 'signed_out' }); return; }
    if (!(await limited('players_read', req, res, me.user.id))) return;
    await noStore(res).send({ players: await recentPlayers(pool, me.user.id) });
  },

  // ── Notifications ──
  // The public half of the keypair, which is what a browser needs before it can subscribe, and an honest
  // answer when this deploy has no keys: the client then says notifications are unavailable rather than
  // offering a switch that does nothing.
  async pushKey(_req: Req, res: Res, _me: Caller) {
    await noStore(res).send({ enabled: push.enabled, key: push.publicKey() });
  },

  async pushSubscribe(req: Req, res: Res, me: Caller) {
    if (!me.user) { await noStore(res).code(401).send({ error: 'signed_out' }); return; }
    if (!(await limited('push_write', req, res, me.user.id))) return;
    if (!push.enabled) { await noStore(res).code(503).send({ error: 'push_off' }); return; }
    const b = body(req);
    const sub = (b.subscription ?? b) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    const endpoint = String(sub.endpoint ?? '').trim();
    const p256dh = String(sub.keys?.p256dh ?? '').trim();
    const auth = String(sub.keys?.auth ?? '').trim();
    // An endpoint is a URL at the browser's own push service and nowhere else: this service will make a
    // request to whatever is stored here, so it is checked before it is kept, not before it is used.
    if (!/^https:\/\/[^\s]+$/i.test(endpoint) || endpoint.length > 1000 || !p256dh || !auth) {
      await noStore(res).code(400).send({ error: 'bad_subscription' }); return;
    }
    await push.saveSubscription(pool, me.user.id, { endpoint, keys: { p256dh, auth } }, String(req.headers['user-agent'] ?? ''));
    await noStore(res).send({ ok: true, on: true });
  },

  async pushUnsubscribe(req: Req, res: Res, me: Caller) {
    if (!me.user) { await noStore(res).code(401).send({ error: 'signed_out' }); return; }
    if (!(await limited('push_write', req, res, me.user.id))) return;
    const endpoint = String(body(req).endpoint ?? '').trim();
    if (endpoint) await push.dropSubscription(pool, me.user.id, endpoint);
    await noStore(res).send({ ok: true, on: endpoint ? await push.hasSubscription(pool, me.user.id) : true });
  },

  async invite(req: Req, res: Res, me: Caller) {
    if (!me.user) { await noStore(res).code(401).send({ error: 'signed_out' }); return; }
    if (!(await limited('match_invite', req, res, me.user.id))) return;
    const code = codeOf(req);
    const to = Number(body(req).user_id ?? 0);
    if (!Number.isInteger(to) || to <= 0 || to === me.user.id) { await noStore(res).code(400).send({ error: 'bad_player' }); return; }

    // The room has to be this player's to invite into, and still open: an invitation to a match already being
    // played is a notification that can only disappoint.
    const m = await R.matchRow(pool, code);
    if (!m) { await noStore(res).code(404).send({ error: 'no_match' }); return; }
    if (m.state !== 'open') { await noStore(res).code(409).send({ error: 'taken' }); return; }
    const seats = await R.room(pool, m.code);
    if (!seats.some(p => p.user_id === me.user!.id)) { await noStore(res).code(403).send({ error: 'not_yours' }); return; }
    if (seats.some(p => p.user_id === to)) { await noStore(res).code(409).send({ error: 'already_in' }); return; }
    if (!(await havePlayedTogether(pool, me.user.id, to))) { await noStore(res).code(403).send({ error: 'not_played_together' }); return; }
    // And not while they are racing. A challenge landing on a board somebody is being timed on is the one
    // notification this game must never send; it can be sent again in a minute, when their board is over.
    if (await isRacing(pool, to)) { await noStore(res).code(409).send({ error: 'in_a_match' }); return; }

    await publishToUser(to, 'invited', {
      code: m.code, stake: m.stake, from: me.user.name, from_id: me.user.id, pic: me.user.pic ?? '',
    });
    // Whether they are reachable right now decides what the sender is told, not whether the invitation was
    // sent: a socket that opens a second later still gets nothing, and saying so is kinder than a silent wait.
    const here = await online.is(to);
    // And if they are not here, their phone is told — the one thing in this game worth interrupting somebody
    // for, because the room it is about will be gone in a few minutes. Somebody with the game open in front of
    // them already has the invitation on their screen and does not need it twice.
    if (!here) void push.sendToUser(to, push.invitedNote(me.user.name, m.stake, m.code));
    await noStore(res).send({ ok: true, delivered: here });
  },

  async create(req: Req, res: Res, me: Caller) {
    if (!me.user) { await noStore(res).code(401).send({ error: 'signed_out' }); return; }
    if (!(await limited('match_create', req, res, me.user.id))) return;
    const b = body(req);
    const made = await R.createMatch(me.user, Number(b.stake ?? 0), Boolean(b.open_to_all), Number(b.tier ?? 2));
    if (!made.ok) {
      // Already in one: 409, and the code, because the only useful answer to "you are already in a match" is
      // the way back to it. The client turns this into a tap rather than a dead end.
      if (made.error === 'in_match') { await noStore(res).code(409).send({ error: 'in_match', match_code: made.code }); return; }
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
      if (out.error === 'in_match') { await noStore(res).code(409).send({ error: 'in_match', match_code: out.code }); return; }
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
      const pct = await tx(c => R.saveProgress(c, code, me.user!.id, Number(body(req).pct), R.cleanRun(body(req).run)));
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
      // gave_up separates the two ways a run ends without the board: the player walked out, or the board won.
      await R.submitResult(c, code, me.user!.id, Number(b.ms ?? -1), b.cleared === true, b.gave_up === true);
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

  app.get(`${v1}/progress`, withCaller(H.progressRead));
  app.post(`${v1}/progress`, withCaller(H.progressPush));

  app.get(`${v1}/boards/pace`, withCaller(H.pace));

  app.post(`${v1}/ads/reward`, withCaller(H.adReward));

  app.get(`${v1}/league`, withCaller(H.league));

  app.get(`${v1}/push/key`, withCaller(H.pushKey));
  app.post(`${v1}/push/subscribe`, withCaller(H.pushSubscribe));
  app.post(`${v1}/push/unsubscribe`, withCaller(H.pushUnsubscribe));

  app.get(`${v1}/lobby`, withCaller(H.lobby));
  app.get(`${v1}/players/recent`, withCaller(H.recent));
  app.post(`${v1}/matches/:code/invite`, withCaller(H.invite));
  app.post(`${v1}/matches`, withCaller(H.create));
  app.get(`${v1}/matches/:code`, withCaller(H.get));
  app.post(`${v1}/matches/:code/join`, withCaller(H.join));
  app.post(`${v1}/matches/:code/start`, withCaller(H.start));
  app.post(`${v1}/matches/:code/leave`, withCaller(H.leave));
  app.post(`${v1}/matches/:code/progress`, withCaller(H.progress));
  app.post(`${v1}/matches/:code/result`, withCaller(H.result));
}
