// Gold matches: rooms, the clock that fills them, and who gets paid.
//
// This is a faithful port of the rules the PHP service ran, down to the awkward ones that exist because a real
// player hit them: the crown passes when a host walks out, a room back down to one player starts its wait over,
// two people tapping the same coin in the same second end up in the same room rather than two rooms of one, and
// the pot is the size of the stakes that went in even if an account has since been deleted.
//
// What is different is the safety underneath. Gold only ever moves through the ledger, and every step that
// decides something (who started it, who won it) takes the match row with SELECT ... FOR UPDATE, so two
// requests racing produce one outcome rather than two half-outcomes.
import { readFile } from 'node:fs/promises';
import { randomInt } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool, query, tx } from './db.js';
import { config } from './config.js';
import { give, idem, take } from './gold.js';
import { log } from './log.js';
import { publish } from './events.js';

export interface MatchRow {
  code: string; host_id: number | null; stake: number; board: string; tier: number; seed: number;
  state: 'open' | 'playing' | 'done' | 'void'; winner_id: number | null; open_to_all: boolean;
  stakes_in: number; fills_at: Date | null; created_at: Date; started_at: Date | null; settled_at: Date | null;
}
export interface SeatRow {
  seat_id: number; code: string; user_id: number; tier: number; pct: number;
  ms: number | null; finished_at: Date | null; joined_at: Date; name: string; pic: string;
}
export interface PlayerView {
  name: string; pic: string; pct: number; ms: number | null; race_ms: number | null;
  you: boolean; host: boolean; won: boolean; place: number;
}
export interface MatchView {
  code: string; stake: number; state: string; players: PlayerView[]; count: number; seats: number;
  pot: number; host: string; you: '' | 'host' | 'guest'; can_start: boolean; open_to_all: boolean;
  fills_in: number | null; board?: string; tier?: number; seed?: number; your_ms?: number | null;
  winner?: string; you_won?: boolean; draw?: boolean;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I, O, 0 or 1: these get read out loud

// ── Boards ──

let boardIds: string[] | null = null;
/** A country from the tour, picked by the server so no client can choose an easy one. */
export async function pickBoard(): Promise<string | null> {
  if (boardIds === null) {
    try {
      const raw = await readFile(config.game.boardsFile, 'utf8');
      const data = JSON.parse(raw) as { levels?: { id?: string }[] };
      boardIds = (data.levels ?? []).map(l => String(l.id ?? '')).filter(Boolean);
    } catch (e) {
      log.err('could not read the board list', e, { file: config.game.boardsFile });
      boardIds = [];
    }
  }
  return boardIds.length ? boardIds[randomInt(0, boardIds.length)]! : null;
}
export const _resetBoardCache = () => { boardIds = null; };

async function freeCode(c: PoolClient): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
    const hit = await query(c, 'SELECT 1 FROM matches WHERE code = $1', [code]);
    if (hit.rowCount === 0) return code;
  }
  throw new Error('could not find a free match code');
}

// ── Reading a room ──

export async function matchRow(sql: PoolClient | typeof pool, code: string): Promise<MatchRow | null> {
  const r = await query<MatchRow>(sql, 'SELECT * FROM matches WHERE code = $1', [code.trim().toUpperCase()]);
  return r.rows[0] ?? null;
}
/** The same row, held for the rest of the transaction so nobody else can settle or start it underneath us. */
export async function matchRowLocked(c: PoolClient, code: string): Promise<MatchRow | null> {
  const r = await query<MatchRow>(c, 'SELECT * FROM matches WHERE code = $1 FOR UPDATE', [code.trim().toUpperCase()]);
  return r.rows[0] ?? null;
}

export async function room(sql: PoolClient | typeof pool, code: string): Promise<SeatRow[]> {
  const r = await query<SeatRow>(sql,
    `SELECT mp.*, u.name, u.pic FROM match_players mp JOIN users u ON u.id = mp.user_id
      WHERE mp.code = $1 ORDER BY mp.joined_at, mp.seat_id`, [code]);
  return r.rows;
}

/**
 * The board is as hard as the room deserves: the middle of everyone's own difficulty, never the size of the
 * stake. Gold buys a bigger pot, never an easier board.
 */
export function roomTier(seats: SeatRow[]): number {
  if (!seats.length) return 2;
  const sum = seats.reduce((a, p) => a + Math.max(0, Math.min(4, p.tier)), 0);
  return Math.max(0, Math.min(4, Math.round(sum / seats.length)));
}

/**
 * Everyone in the room, first place first: whoever cleared the board earliest leads, because the race is won by
 * finishing first and not by the shortest clock; then the players still going, the one furthest along in front;
 * and last anyone who ran out of hearts.
 */
export function orderPlayers(m: MatchRow, seats: SeatRow[], meId: number | null): PlayerView[] {
  const started = m.started_at ? m.started_at.getTime() : 0;
  const rows = seats.map(p => ({
    name: p.name,
    pic: p.pic ?? '',
    pct: p.ms !== null && p.ms > 0 ? 100 : Math.max(0, Math.min(100, p.pct)),
    ms: p.ms,
    race_ms: p.finished_at && p.ms !== null && p.ms > 0 && started ? Math.max(0, p.finished_at.getTime() - started) : null,
    you: meId !== null && p.user_id === meId,
    host: m.host_id !== null && p.user_id === m.host_id,
    won: m.winner_id !== null && p.user_id === m.winner_id,
    _done: p.finished_at ? p.finished_at.getTime() : 0,
  }));
  const rank = (p: { ms: number | null }) => (p.ms !== null && p.ms > 0 ? 0 : p.ms === null ? 1 : 2);
  rows.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (rank(a) === 0) return a._done - b._done;
    return b.pct - a.pct;
  });
  return rows.map(({ _done, ...r }, i) => ({ ...r, place: i + 1 }));
}

async function nameOf(sql: PoolClient | typeof pool, id: number | null, seats?: SeatRow[]): Promise<string> {
  if (!id) return '';
  // The host and the winner are nearly always sitting in the room we have already read, so look there first:
  // it saves a round trip on every single poll, which is the request this game makes most of.
  const seated = seats?.find(p => p.user_id === id);
  if (seated) return seated.name || 'A friend';
  const r = await query<{ name: string }>(sql, 'SELECT name FROM users WHERE id = $1', [id]);
  return r.rows[0]?.name || 'A friend';
}

/**
 * What a player may see. The board only goes to the players, and only once the match has started, so nobody can
 * study it while the room is still filling up.
 */
export async function matchView(sql: PoolClient | typeof pool, m: MatchRow, meId: number | null, known?: SeatRow[]): Promise<MatchView> {
  const seats = known ?? await room(sql, m.code);
  const players = orderPlayers(m, seats, meId);
  const mine = meId !== null && seats.some(p => p.user_id === meId);
  const isHost = meId !== null && m.host_id === meId;
  const view: MatchView = {
    code: m.code,
    stake: m.stake,
    state: m.state,
    players,
    count: players.length,
    seats: config.game.seats,
    pot: m.stake * Math.max(1, m.stakes_in),
    host: await nameOf(sql, m.host_id, seats),
    you: mine ? (isHost ? 'host' : 'guest') : '',
    can_start: isHost && m.state === 'open' && players.length > 1 && !m.open_to_all,
    open_to_all: m.open_to_all,
    // seconds until it begins on its own; null in an invite-only room, or before the second player arrives
    fills_in: m.fills_at === null || m.state !== 'open' ? null : Math.max(0, Math.round((m.fills_at.getTime() - Date.now()) / 1000)),
  };
  if (mine && m.state !== 'open') {
    view.board = m.board;
    view.tier = m.tier;
    view.seed = m.seed;
    view.your_ms = players.find(p => p.you)?.ms ?? null;
  }
  // the pot is paid the instant somebody clears it, so the winner is named long before the match closes
  if (m.winner_id !== null) {
    view.winner = await nameOf(sql, m.winner_id, seats);
    view.you_won = mine && m.winner_id === meId;
  }
  if (m.state === 'done') view.draw = m.winner_id === null;
  return view;
}

// ── Sitting down, standing up ──

/** Take a seat and pay the stake. Returns the seat id, or a reason it could not happen. */
async function sit(c: PoolClient, m: MatchRow, userId: number, tier: number): Promise<number | 'not_enough_gold'> {
  const ins = await query<{ seat_id: number }>(c,
    `INSERT INTO match_players (code, user_id, tier) VALUES ($1, $2, $3)
     ON CONFLICT (code, user_id) DO NOTHING RETURNING seat_id`,
    [m.code, userId, Math.max(0, Math.min(4, tier))]);
  if (ins.rowCount === 0) return 0;                      // already sitting here: nothing to pay, nothing to do
  const seatId = ins.rows[0]!.seat_id;
  const paid = await take(c, userId, m.stake, idem.stake(seatId), m.code);
  if (!paid) return 'not_enough_gold';                   // the transaction is about to roll back
  await query(c, 'UPDATE matches SET stakes_in = stakes_in + 1 WHERE code = $1', [m.code]);
  return seatId;
}

/**
 * A player has just sat down. Seven of them and the match begins there and then; in a room that fills itself
 * from online, the second of them starts the clock. An invite-only room still waits for its host.
 */
async function roomJoined(c: PoolClient, code: string): Promise<'started' | 'counting' | null> {
  const m = await matchRowLocked(c, code);
  if (!m || m.state !== 'open' || !m.open_to_all) return null;
  const seats = await room(c, code);
  if (seats.length >= config.game.seats) return (await startRoom(c, code)) ? 'started' : null;
  if (seats.length < 2 || m.fills_at !== null) return null;
  const upd = await query(c,
    `UPDATE matches SET fills_at = now() + ($2 || ' seconds')::interval
      WHERE code = $1 AND state = 'open' AND fills_at IS NULL`, [code, String(config.game.fillSeconds)]);
  return upd.rowCount ? 'counting' : null;
}

/**
 * Deal the board to the players who actually turned up. Guarded on 'open', so the host pressing Start and the
 * clock running out cannot both begin the same match.
 */
export async function startRoom(c: PoolClient, code: string): Promise<boolean> {
  const seats = await room(c, code);
  const upd = await query(c,
    `UPDATE matches SET state = 'playing', started_at = now(), tier = $2 WHERE code = $1 AND state = 'open'`,
    [code, roomTier(seats)]);
  return upd.rowCount === 1;
}

/**
 * Walking out of a room takes your own stake with you and nothing else. Only the last one out closes the room:
 * if the host leaves with people still in it, the next of them by joining order takes the crown and the room
 * carries on without them. A room back down to one player stops its clock and starts its wait over, so the
 * player left behind is not swept up a moment later for a wait somebody else did.
 */
export async function leaveRoom(c: PoolClient, code: string, userId: number): Promise<'left' | 'closed' | null> {
  const m = await matchRowLocked(c, code);
  if (!m || m.state !== 'open') return null;
  const seats = await room(c, code);
  const mine = seats.find(p => p.user_id === userId);
  if (!mine) return null;               // no seat in this room, so there is no stake of theirs to hand back
  const rest = seats.filter(p => p.user_id !== userId);

  if (!rest.length) {
    await query(c, `UPDATE matches SET state = 'void', settled_at = now() WHERE code = $1 AND state = 'open'`, [code]);
  } else {
    const host = m.host_id === userId ? rest[0]!.user_id : m.host_id;
    const alone = rest.length < 2;
    await query(c,
      `UPDATE matches SET host_id = $2,
              fills_at  = CASE WHEN $3 THEN NULL  ELSE fills_at  END,
              created_at = CASE WHEN $3 THEN now() ELSE created_at END
        WHERE code = $1 AND state = 'open'`, [code, host, alone]);
  }
  await query(c, 'DELETE FROM match_players WHERE code = $1 AND user_id = $2', [code, userId]);
  await query(c, 'UPDATE matches SET stakes_in = GREATEST(0, stakes_in - 1) WHERE code = $1', [code]);
  await give(c, userId, m.stake, 'leave_refund', idem.leaveRefund(mine.seat_id), code);
  return rest.length ? 'left' : 'closed';
}

/**
 * Deleting an account must not strand the rooms it was sitting in. Every room that has not started is left
 * properly, which passes the crown on and hands the stake back. A match already being played keeps its
 * stakes_in, so the pot stays the size of what was staked and the finishing order still adds up; the seat row
 * itself goes with the account, by cascade.
 */
export async function releasePlayer(c: PoolClient, userId: number): Promise<void> {
  const open = await query<{ code: string }>(c,
    `SELECT m.code FROM matches m JOIN match_players p ON p.code = m.code
      WHERE p.user_id = $1 AND m.state = 'open'`, [userId]);
  for (const r of open.rows) await leaveRoom(c, r.code, userId);
}

// ── Finding each other ──

/**
 * The room to walk into at this stake: the one that has been waiting longest and still has a seat. Waiting
 * longest, not emptiest, so the player who has been sitting there gets their match first.
 */
export async function openRoom(c: PoolClient, stake: number, userId: number, before: Date | null = null): Promise<string | null> {
  const r = await query<{ code: string }>(c,
    `SELECT m.code FROM matches m
      WHERE m.state = 'open' AND m.open_to_all AND m.stake = $1
        AND (SELECT COUNT(*) FROM match_players p WHERE p.code = m.code) < $2
        AND NOT EXISTS (SELECT 1 FROM match_players p WHERE p.code = m.code AND p.user_id = $3)
        AND ($4::timestamptz IS NULL OR m.created_at < $4)
      ORDER BY m.created_at LIMIT 1`, [stake, config.game.seats, userId, before]);
  return r.rows[0]?.code ?? null;
}

/**
 * Two players tapping the same coin in the same second would each open a room and then sit in it alone, never
 * meeting. So for as long as a player is the only one in a room that fills itself, every poll looks for an
 * older one to walk into instead: the seat moves across with the stake already on it, and the room left behind
 * closes with nobody in it to hand anything back to. Only ever towards an older room, so two of them cannot
 * swap places forever.
 */
/** Could a requeue possibly apply? Cheap enough to ask on every poll, so the transaction is opened only when it could. */
export function requeueWorthTrying(m: MatchRow, seats: SeatRow[], userId: number): boolean {
  return m.state === 'open' && m.open_to_all && seats.length === 1 && seats[0]!.user_id === userId;
}

export async function requeue(c: PoolClient, m: MatchRow, userId: number): Promise<string | null> {
  if (m.state !== 'open' || !m.open_to_all) return null;
  const seats = await room(c, m.code);
  if (seats.length !== 1 || seats[0]!.user_id !== userId) return null;
  const older = await openRoom(c, m.stake, userId, m.created_at);
  if (older === null) return null;

  const locked = await matchRowLocked(c, m.code);
  if (!locked || locked.state !== 'open') return null;
  const target = await matchRowLocked(c, older);
  if (!target || target.state !== 'open') return null;
  const targetSeats = await room(c, older);
  if (targetSeats.length >= config.game.seats) return null;

  const tier = seats[0]!.tier;
  await query(c, `UPDATE matches SET state = 'void', settled_at = now() WHERE code = $1`, [m.code]);
  await query(c, 'DELETE FROM match_players WHERE code = $1 AND user_id = $2', [m.code, userId]);
  await query(c, 'UPDATE matches SET stakes_in = GREATEST(0, stakes_in - 1) WHERE code = $1', [m.code]);
  // the stake travels with the seat: hand it back here, pay it in there, both inside this one transaction
  await give(c, userId, m.stake, 'leave_refund', idem.leaveRefund(seats[0]!.seat_id), m.code);
  const seated = await sit(c, target, userId, tier);
  if (seated === 'not_enough_gold') throw new Error('requeue could not re-stake');
  await roomJoined(c, older);
  return older;
}

/** How many are sitting in a room that fills itself, per stake, so the picker can say where the people are. */
export async function lobbyCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const s of config.game.stakes) out[String(s)] = 0;
  const r = await query<{ stake: number; n: number }>(pool,
    `SELECT m.stake, COUNT(*)::bigint AS n FROM match_players p JOIN matches m ON m.code = p.code
      WHERE m.state = 'open' AND m.open_to_all GROUP BY m.stake`);
  for (const row of r.rows) if (row.stake in out || String(row.stake) in out) out[String(row.stake)] = Number(row.n);
  return out;
}

// ── Winning ──

/**
 * The first player to clear the board takes the whole pot the moment their result lands: nobody waits on the
 * rest. The others play on for second, third, fourth place — the places are still theirs to win, the gold is
 * not. The match itself only closes once everyone has reported, and if not one of them cleared it every stake
 * goes back.
 *
 * The row is locked for the duration, and the payout carries the match's own idempotency key, so two results
 * arriving in the same millisecond pay one pot to one winner.
 */
export async function settleMatch(c: PoolClient, code: string): Promise<MatchRow | null> {
  const m = await matchRowLocked(c, code);
  if (!m) return null;
  const seats = await room(c, code);
  if (!seats.length) return m;

  let first: number | null = null, best: number | null = null, everyoneIn = true;
  for (const p of seats) {
    if (p.ms === null) { everyoneIn = false; continue; }
    if (p.ms <= 0) continue;                                     // out of hearts: a place, never the pot
    const done = p.finished_at ? p.finished_at.getTime() : 0;
    if (best === null || done < best) { best = done; first = p.user_id; }
  }

  let winner = m.winner_id;
  if (winner === null && first !== null) {
    const upd = await query(c,
      `UPDATE matches SET winner_id = $2, settled_at = now()
        WHERE code = $1 AND state = 'playing' AND winner_id IS NULL`, [code, first]);
    if (upd.rowCount === 1) {
      await give(c, first, m.stake * Math.max(1, m.stakes_in), 'payout', idem.payout(code), code);
      winner = first;
      log.info('pot paid', { code, winner_id: first, pot: m.stake * Math.max(1, m.stakes_in) });
    }
  }
  if (!everyoneIn) return { ...m, winner_id: winner };            // the rest are still playing for their place

  const closed = await query(c,
    `UPDATE matches SET state = 'done', settled_at = now() WHERE code = $1 AND state = 'playing'`, [code]);
  if (closed.rowCount === 1 && winner === null) {
    // nobody cleared it: every stake goes back, one refund per player, each with its own key
    for (const p of seats) await give(c, p.user_id, m.stake, 'draw_refund', idem.drawRefund(code, p.user_id), code);
  }
  return { ...m, state: closed.rowCount === 1 ? 'done' : m.state, winner_id: winner };
}

/**
 * A player's run is over. The first result counts and the server stamps the moment it arrived, because
 * finishing first is what wins — not the shortest clock. Sending the same result again changes nothing, which
 * is what lets the client retry a request it never saw an answer to.
 */
export async function submitResult(c: PoolClient, code: string, userId: number, ms: number, cleared: boolean): Promise<void> {
  const value = cleared && ms > 0 ? Math.min(ms, 24 * 3600 * 1000) : -1;
  await query(c,
    `UPDATE match_players SET ms = $3, finished_at = now(), pct = $4
      WHERE code = $1 AND user_id = $2 AND ms IS NULL`,
    [code, userId, value, value > 0 ? 100 : 0]);
}

/** How far along a player is. Never goes backwards, and never moves a player who has already finished. */
export async function saveProgress(c: PoolClient, code: string, userId: number, pct: number): Promise<number> {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  const upd = await query<{ pct: number }>(c,
    `UPDATE match_players SET pct = $3 WHERE code = $1 AND user_id = $2 AND ms IS NULL AND pct < $3 RETURNING pct`,
    [code, userId, clamped]);
  return upd.rows[0]?.pct ?? clamped;
}

// ── Opening a room ──

export type CreateResult =
  | { ok: true; code: string; joined?: string }
  | { ok: false; error: 'bad_stake' | 'not_enough_gold' | 'no_boards'; gold?: number };

export async function createMatch(me: { id: number }, stake: number, openToAll: boolean, tier: number): Promise<CreateResult> {
  if (!config.game.stakes.includes(stake)) return { ok: false, error: 'bad_stake' };
  const board = await pickBoard();
  if (board === null) return { ok: false, error: 'no_boards' };

  return tx<CreateResult>(async c => {
    // with open_to_all on, walk into the room already waiting at this stake rather than opening a second one
    if (openToAll) {
      const waiting = await openRoom(c, stake, me.id);
      if (waiting !== null) {
        const joined = await joinRoomTx(c, me.id, waiting, tier);
        if (joined.ok) return { ok: true, code: waiting, joined: waiting };
        if (joined.error === 'not_enough_gold') return { ok: false, error: 'not_enough_gold', gold: joined.gold };
        // the room filled up or started while we looked at it: fall through and open our own
      }
    }
    const code = await freeCode(c);
    await query(c,
      `INSERT INTO matches (code, host_id, stake, board, tier, seed, state, open_to_all)
       VALUES ($1, $2, $3, $4, 2, $5, 'open', $6)`,
      [code, me.id, stake, board, randomInt(100_000, 1_000_000), openToAll]);
    const m = (await matchRowLocked(c, code))!;
    const seated = await sit(c, m, me.id, tier);
    if (seated === 'not_enough_gold') {
      const gold = (await query<{ gold: number }>(c, 'SELECT gold FROM users WHERE id = $1', [me.id])).rows[0]?.gold ?? 0;
      throw Object.assign(new Error('not_enough_gold'), { aaError: 'not_enough_gold', aaGold: gold });
    }
    return { ok: true, code };
  }).catch((e: unknown): CreateResult => {
    const tagged = e as { aaError?: string; aaGold?: number };
    if (tagged.aaError === 'not_enough_gold') return { ok: false, error: 'not_enough_gold', gold: tagged.aaGold ?? 0 };
    throw e;
  });
}

export type JoinResult =
  | { ok: true; code: string; already: boolean; started: boolean }
  | { ok: false; error: 'no_match' | 'taken' | 'room_full' | 'not_enough_gold'; gold?: number };

/** Sit down in a room. Used by a friend opening an invitation link and by a player asking for any free seat. */
export async function joinRoomTx(c: PoolClient, userId: number, code: string, tier: number): Promise<JoinResult> {
  const m = await matchRowLocked(c, code);
  if (!m) return { ok: false, error: 'no_match' };
  if (m.state !== 'open') return { ok: false, error: 'taken' };
  const seats = await room(c, m.code);
  if (seats.some(p => p.user_id === userId)) return { ok: true, code: m.code, already: true, started: false };
  if (seats.length >= config.game.seats) return { ok: false, error: 'room_full' };

  const seated = await sit(c, m, userId, tier);
  if (seated === 'not_enough_gold') {
    const gold = (await query<{ gold: number }>(c, 'SELECT gold FROM users WHERE id = $1', [userId])).rows[0]?.gold ?? 0;
    return { ok: false, error: 'not_enough_gold', gold };
  }
  const outcome = await roomJoined(c, m.code);   // seven of them start at once; the second starts the clock
  return { ok: true, code: m.code, already: false, started: outcome === 'started' };
}

// ── Housekeeping ──
//
// The PHP service ran all of this on every single HTTP request, which is what made a busy lobby slower every
// week it was up: each poll scanned the whole match history twice and took the write lock to do it. Here it is
// one timer in one process, and every query below is served by a partial index over the few rooms that are
// still open or playing, so the cost does not grow with the history.

export interface SweepReport { started: string[]; voided: string[]; settled: string[]; }

export async function sweep(): Promise<SweepReport> {
  const out: SweepReport = { started: [], voided: [], settled: [] };

  // somebody walked out and left a clock ticking over a room of one: it goes back to waiting
  await query(pool, `UPDATE matches SET fills_at = NULL
     WHERE state = 'open' AND fills_at IS NOT NULL
       AND (SELECT COUNT(*) FROM match_players p WHERE p.code = matches.code) < 2`);

  // the clock has run out on rooms that fill themselves: start the ones that found company
  const due = await query<{ code: string }>(pool,
    `SELECT code FROM matches WHERE state = 'open' AND open_to_all AND fills_at IS NOT NULL AND fills_at <= now() LIMIT 50`);
  for (const r of due.rows) {
    const started = await tx(async c => {
      const m = await matchRowLocked(c, r.code);
      if (!m || m.state !== 'open') return false;
      if ((await room(c, r.code)).length < 2) return false;
      return startRoom(c, r.code);
    });
    if (started) { out.started.push(r.code); await announceStart(r.code); }
  }

  // a public room nobody joined is handed back soon, not a day later
  const lonely = await query<{ code: string }>(pool,
    `SELECT code FROM matches WHERE state = 'open' AND open_to_all AND fills_at IS NULL
        AND created_at < now() - ($1 || ' seconds')::interval LIMIT 50`, [String(config.game.lonelySeconds)]);
  // an invitation nobody accepted is refunded after a day
  const stale = await query<{ code: string }>(pool,
    `SELECT code FROM matches WHERE state = 'open'
        AND created_at < now() - ($1 || ' hours')::interval LIMIT 50`, [String(config.game.matchHours)]);

  for (const r of [...lonely.rows, ...stale.rows]) {
    const voided = await tx(async c => {
      const m = await matchRowLocked(c, r.code);
      if (!m || m.state !== 'open') return false;
      const seats = await room(c, r.code);
      const upd = await query(c, `UPDATE matches SET state = 'void', settled_at = now() WHERE code = $1 AND state = 'open'`, [r.code]);
      if (upd.rowCount !== 1) return false;
      for (const p of seats) await give(c, p.user_id, m.stake, 'expire_refund', idem.expireRefund(r.code, p.user_id), r.code);
      return true;
    });
    if (voided) { out.voided.push(r.code); await publish(r.code, 'room_closed', { reason: 'expired' }); }
  }

  // a match where someone never finished is settled a day later, with the missing run counted as a loss
  const hanging = await query<{ code: string }>(pool,
    `SELECT code FROM matches WHERE state = 'playing'
        AND created_at < now() - ($1 || ' hours')::interval LIMIT 50`, [String(config.game.matchHours)]);
  for (const r of hanging.rows) {
    const done = await tx(async c => {
      const seats = await room(c, r.code);
      if (!seats.length) {
        // every account that was in it has since been deleted: close the row rather than sweep it forever
        await query(c, `UPDATE matches SET state = 'void', settled_at = now() WHERE code = $1 AND state = 'playing'`, [r.code]);
        return true;
      }
      await query(c, `UPDATE match_players SET ms = -1, finished_at = now() WHERE code = $1 AND ms IS NULL`, [r.code]);
      await settleMatch(c, r.code);
      return true;
    });
    if (done) { out.settled.push(r.code); await publish(r.code, 'match_finished', { reason: 'timed_out' }); }
  }
  return out;
}

/** Tell the room it has begun, with everything a client needs to draw the board without asking again. */
export async function announceStart(code: string): Promise<void> {
  const m = await matchRow(pool, code);
  if (!m) return;
  await publish(code, 'match_started', { board: m.board, tier: m.tier, seed: m.seed, started_at: m.started_at?.getTime() ?? null });
}

let sweepTimer: NodeJS.Timeout | null = null;
export function startSweeper(): void {
  if (sweepTimer) return;
  let running = false;
  sweepTimer = setInterval(() => {
    if (running) return;                    // a slow sweep must not stack up behind itself
    running = true;
    sweep()
      .then(r => { if (r.started.length || r.voided.length || r.settled.length) log.info('sweep', r as unknown as Record<string, unknown>); })
      .catch(e => log.err('sweep failed', e))
      .finally(() => { running = false; });
  }, Math.max(500, config.sweepSeconds * 1000));
  log.info('sweeper started', { every_seconds: config.sweepSeconds });
}
export function stopSweeper(): void { if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; } }
