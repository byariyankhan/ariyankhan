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
  /** every board of the match, comma-separated, first one also in `board`; empty on a match from before 016 */
  boards: string;
  state: 'open' | 'playing' | 'done' | 'void'; winner_id: number | null; open_to_all: boolean;
  stakes_in: number; fills_at: Date | null; created_at: Date; started_at: Date | null; settled_at: Date | null;
  // paid_at and winner_name survive the winner deleting their account; winner_id does not
  paid_at: Date | null; winner_name: string;
}
export interface SeatRow {
  seat_id: number; code: string; user_id: number; tier: number; pct: number;
  ms: number | null; gave_up: boolean; finished_at: Date | null; joined_at: Date; name: string; pic: string;
  run: RunState | null;
}

/**
 * The board as a player left it: which arrows have gone, what is left of the lifelines, and a move counter
 * that only ever climbs. It is the client's own snapshot, held here so the next device can pick the board up
 * where this one put it down; the server derives nothing from it and never looks inside except to validate.
 */
export interface RunState {
  moves: number; gone: number[]; lives: number; wrong: number;
  hintsUsed: number; hintsMax: number; checksUsed: number; checksMax: number;
  /** which board of the match this run is on, from 0; absent on a one-board match */
  bi?: number;
}

const RUN_INTS = ['moves', 'lives', 'wrong', 'hintsUsed', 'hintsMax', 'checksUsed', 'checksMax'] as const;

/**
 * A run snapshot the client sent, or null if it is not one. Shape and bounds only: a board has at most a few
 * hundred arrows, the counters are small, and a snapshot is a few hundred bytes. Anything outside that is not
 * a board, whatever it claims to be, and is dropped without touching the seat.
 */
export function cleanRun(raw: unknown): RunState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const ints: Record<string, number> = {};
  for (const k of RUN_INTS) {
    const v = r[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 100_000) return null;
    ints[k] = v;
  }
  if (!Array.isArray(r.gone) || r.gone.length > 2_000) return null;
  const gone = new Set<number>();
  for (const g of r.gone) {
    if (typeof g !== 'number' || !Number.isInteger(g) || g < 0 || g > 10_000) return null;
    gone.add(g);
  }
  const bi = r.bi === undefined ? undefined : (typeof r.bi === 'number' && Number.isInteger(r.bi) && r.bi >= 0 && r.bi < 20 ? r.bi : null);
  if (bi === null) return null;
  return {
    moves: ints.moves!, lives: ints.lives!, wrong: ints.wrong!,
    hintsUsed: ints.hintsUsed!, hintsMax: ints.hintsMax!, checksUsed: ints.checksUsed!, checksMax: ints.checksMax!,
    gone: [...gone].sort((a, b) => a - b),
    ...(bi !== undefined ? { bi } : {}),
  };
}
export interface PlayerView {
  name: string; pic: string; pct: number; ms: number | null; gave_up: boolean; race_ms: number | null;
  /** what this player took from the pot, once the pot has been paid; 0 for everybody who took nothing */
  prize?: number;
  you: boolean; host: boolean; won: boolean; place: number;
}
export interface MatchView {
  code: string; stake: number; state: string; players: PlayerView[]; count: number; seats: number;
  pot: number; host: string; you: '' | 'host' | 'guest'; can_start: boolean; open_to_all: boolean;
  /** what the table pays for second and third, both 0 at a table too small for places */
  prizes: { second: number; third: number };
  fills_in: number | null; board?: string; tier?: number; seed?: number; your_ms?: number | null;
  /** how many boards the match plays: known to everybody; which boards, only to the seated once it starts */
  boards_n: number; boards?: string[];
  /** the board as this player last left it, for a device that was not the one playing; absent until they move */
  your_run?: RunState | null;
  // How long the match has been running, as this server counts it. The client starts its own clock from this
  // rather than from a timestamp, because a device with a wrong clock would then show a wrong race.
  age_ms?: number;
  winner?: string; you_won?: boolean; draw?: boolean;
}

// ── What a board pays ──
//
// First took the whole pot, and that is a good rule for two players and a bad one for five: the moment somebody
// clears it, everybody else is playing for nothing and knows it. They stop, which is the opposite of what a
// room full of people is for.
//
// So from three players up, a board pays three places. Second gets its stake back — finish second and the
// board cost you nothing, which is the whole reason to keep going after somebody has won. Third gets a tenth
// of its stake, which is not a prize so much as a reason to finish. First takes everything else, and on any
// room bigger than three that is still the great majority of the pot.
//
// A place is earned by CLEARING the board, in the order they were cleared — never by ranking above somebody
// who gave up. A place nobody claims is not paid: it goes to first when the room closes, which is the one
// moment it is certain nobody is coming.
export const PLACES_FROM = 3;          // two players is a duel, and a duel has one winner
export const THIRD_DIVISOR = 10;       // third takes a tenth of what it staked

/** What second and third are owed at this table, and what first therefore cannot have. */
export function placePrizes(stake: number, players: number): { second: number; third: number; reserved: number } {
  if (players < PLACES_FROM) return { second: 0, third: 0, reserved: 0 };
  const second = stake, third = Math.floor(stake / THIRD_DIVISOR);
  return { second, third, reserved: second + third };
}

/**
 * What each player has been paid out of this pot, by user id. Empty until the pot is paid, and the same
 * arithmetic settleMatch uses — including the unclaimed places, which are first's only once the room is
 * closed, because until then somebody may still be coming for them.
 */
function paidOut(m: MatchRow, seats: SeatRow[]): Map<number, number> {
  const out = new Map<number, number>();
  if (m.paid_at === null) return out;
  const players = Math.max(1, m.stakes_in), pot = m.stake * players;
  const { winnerId, behind } = standings(m, seats);
  if (winnerId !== null) out.set(winnerId, prizeAt(0, pot, m.stake, players));
  let claimed = 0;
  for (let i = 0; i < behind.length && i < PLACES_FROM - 1; i++) {
    const prize = prizeAt(i + 1, pot, m.stake, players);
    claimed += prize;
    out.set(behind[i]!.user_id, prize);
  }
  if (m.state === 'done' && winnerId !== null) {
    const { reserved } = placePrizes(m.stake, players);
    out.set(winnerId, (out.get(winnerId) ?? 0) + (reserved - claimed));
  }
  return out;
}

/** Everyone who cleared the board, in the order they cleared it. The prize places, and nobody else. */
const clearedInOrder = (seats: SeatRow[]): SeatRow[] => seats
  .filter(p => p.ms !== null && p.ms > 0 && p.finished_at !== null)
  .sort((a, b) => a.finished_at!.getTime() - b.finished_at!.getTime());

/**
 * Who is standing where. First is the winner the match recorded, not simply whoever is at the head of the
 * list now: an account deleted mid-match takes its seat row with it, and reading the list alone would promote
 * everybody behind it by one and pay second place twice. With the winner gone the row is NULL, and then there
 * is no first to pay — the places behind it are still owed, and what first would have taken is not invented.
 */
function standings(m: MatchRow, seats: SeatRow[]): { winnerId: number | null; behind: SeatRow[] } {
  const order = clearedInOrder(seats);
  const winnerId = m.paid_at !== null ? m.winner_id : (order[0]?.user_id ?? null);
  return { winnerId, behind: order.filter(p => p.user_id !== winnerId) };
}

/** What the player in this place (0-based, by clear order) takes from a pot of this size. */
function prizeAt(place: number, pot: number, stake: number, players: number): number {
  const { second, third, reserved } = placePrizes(stake, players);
  if (place === 0) return pot - reserved;
  if (place === 1) return second;
  if (place === 2) return third;
  return 0;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I, O, 0 or 1: these get read out loud

// ── Boards ──

let boardIds: string[] | null = null;
let boardSet: ReadonlySet<string> | null = null;
async function loadBoards(): Promise<string[]> {
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
  return boardIds;
}
/** Every country board the tour has, from the same file the server deals from: what a synced level id may be. */
export async function boardIdSet(): Promise<ReadonlySet<string>> {
  if (boardSet === null) boardSet = new Set(await loadBoards());
  return boardSet;
}
/** A country from the tour, picked by the server so no client can choose an easy one. */
export async function pickBoard(): Promise<string | null> {
  const ids = await loadBoards();
  return ids.length ? ids[randomInt(0, ids.length)]! : null;
}
/** `n` different boards, for a match that plays them in a row. Fewer only if the tour itself has fewer. */
export async function pickBoards(n: number): Promise<string[]> {
  const first = await pickBoard();
  if (first === null) return [];
  const out = [first];
  const ids = boardIds ?? [];
  let guard = 0;
  while (out.length < Math.min(n, ids.length) && guard++ < 200) {
    const b = ids[randomInt(0, ids.length)]!;
    if (!out.includes(b)) out.push(b);
  }
  return out;
}
/** The boards of a match, in order: the list if there is one, the single board otherwise. */
export const boardsOf = (m: { board: string; boards: string }): string[] =>
  m.boards ? m.boards.split(',').filter(Boolean) : [m.board];
export const _resetBoardCache = () => { boardIds = null; boardSet = null; };

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

/**
 * The match this account is still sitting in, if any.
 *
 * <p>One row, because a player is allowed one live match at a time — that rule is enforced where rooms are
 * made and joined, and this is what both of them ask. It is also what a second device asks on sign-in: an
 * account signed in on a phone and in a browser is one account, and a challenge started in one of them is a
 * challenge the other has to be able to find. Without this the browser holds the only copy of the code, and
 * closing the tab loses the room while the seat, and the stake in it, stay where they are.
 *
 * <p>A seat counts as live while `ms IS NULL` — the run has not been handed in — and the match is still open
 * or being played. Playing comes before waiting, because a board with a clock running is the more urgent of
 * the two, and the newest of those before the rest.
 */
export async function liveMatchOf(sql: PoolClient | typeof pool, userId: number): Promise<MatchRow | null> {
  const r = await query<MatchRow>(sql,
    `SELECT m.* FROM matches m
       JOIN match_players p ON p.code = m.code
      WHERE p.user_id = $1 AND p.ms IS NULL AND m.state IN ('open', 'playing')
      ORDER BY (m.state = 'playing') DESC, m.created_at DESC
      LIMIT 1`, [userId]);
  return r.rows[0] ?? null;
}

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
 * and last anyone whose run ended without it — out of hearts, or walked away.
 */
export function orderPlayers(m: MatchRow, seats: SeatRow[], meId: number | null): PlayerView[] {
  const started = m.started_at ? m.started_at.getTime() : 0;
  const paid = paidOut(m, seats);
  const rows = seats.map(p => ({
    name: p.name,
    pic: p.pic ?? '',
    pct: p.ms !== null && p.ms > 0 ? 100 : Math.max(0, Math.min(100, p.pct)),
    ms: p.ms,
    // which of the two ways a run can end without the board being cleared; false on a cleared one
    gave_up: p.ms !== null && p.ms <= 0 && p.gave_up,
    prize: paid.get(p.user_id) ?? 0,
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
  const started = m.started_at ? m.started_at.getTime() : 0;
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
    prizes: (({ second, third }) => ({ second, third }))(placePrizes(m.stake, Math.max(1, m.stakes_in))),
    host: await nameOf(sql, m.host_id, seats),
    you: mine ? (isHost ? 'host' : 'guest') : '',
    can_start: isHost && m.state === 'open' && players.length > 1 && !m.open_to_all,
    open_to_all: m.open_to_all,
    boards_n: boardsOf(m).length,
    // seconds until it begins on its own; null in an invite-only room, or before the second player arrives
    fills_in: m.fills_at === null || m.state !== 'open' ? null : Math.max(0, Math.round((m.fills_at.getTime() - Date.now()) / 1000)),
  };
  if (mine && m.state !== 'open') {
    view.board = m.board;
    view.boards = boardsOf(m);
    view.tier = m.tier;
    view.seed = m.seed;
    view.your_ms = players.find(p => p.you)?.ms ?? null;
    view.your_run = seats.find(p => p.user_id === meId)?.run ?? null;
    // The race began when the match did, for everyone in it at once. The clock on the board is counted from
    // here, so the time a player watches is the time they are ranked on — waiting, thinking and all.
    if (started) view.age_ms = Math.max(0, Date.now() - started);
  }
  // The pot is paid the instant somebody clears it, so the winner is named long before the match closes. The
  // name is read from the snapshot taken at settlement, so a winner who has since deleted their account is still
  // the winner rather than the match quietly becoming a draw.
  if (m.paid_at !== null) {
    view.winner = m.winner_name || await nameOf(sql, m.winner_id, seats);
    view.you_won = mine && m.winner_id !== null && m.winner_id === meId;
  }
  if (m.state === 'done') view.draw = m.paid_at === null;
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
  if (upd.rowCount !== 1) return false;
  // Everybody's clock starts here. An invitation can sit open for a day before a friend accepts it, and the
  // seat that has been waiting all that time was last heard from when it sat down — without this the sweeper
  // would look at a board one second old and see a room nobody had visited since yesterday.
  await query(c, 'UPDATE match_players SET last_seen_at = now() WHERE code = $1', [code]);
  return true;
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

  const everyoneIn = seats.every(p => p.ms !== null);
  const players = Math.max(1, m.stakes_in);
  const pot = m.stake * players;
  const first = clearedInOrder(seats)[0]?.user_id ?? null;

  // paid_at is the guard, not winner_id: an account deletion nulls the foreign key and cascades the payout's
  // ledger row away, which used to make a settled match look unsettled and pay the same pot twice.
  let paid = m.paid_at !== null;
  let winner = m.winner_id;
  if (!paid && first !== null) {
    const name = seats.find(p => p.user_id === first)?.name ?? '';
    const upd = await query(c,
      `UPDATE matches SET winner_id = $2, winner_name = $3, paid_at = now(), settled_at = now()
        WHERE code = $1 AND state = 'playing' AND paid_at IS NULL`, [code, first, name]);
    if (upd.rowCount === 1) {
      await give(c, first, prizeAt(0, pot, m.stake, players), 'payout', idem.payout(code), code);
      winner = first; paid = true;
      log.info('pot paid', { code, winner_id: first, first: prizeAt(0, pot, m.stake, players), pot, players });
    }
  }
  // Second and third, as they arrive. Each has its own key, so a result that is sent twice pays once, and a
  // place that never fills is simply never paid.
  const { winnerId, behind } = standings({ ...m, winner_id: winner, paid_at: paid ? (m.paid_at ?? new Date()) : null }, seats);
  if (paid) {
    for (let i = 0; i < behind.length && i < PLACES_FROM - 1; i++) {
      const prize = prizeAt(i + 1, pot, m.stake, players);
      if (prize > 0) await give(c, behind[i]!.user_id, prize, 'payout', idem.place(code, behind[i]!.user_id), code);
    }
  }
  if (!everyoneIn) return { ...m, winner_id: winner, paid_at: paid ? (m.paid_at ?? new Date()) : null };

  const closed = await query(c,
    `UPDATE matches SET state = 'done', settled_at = now() WHERE code = $1 AND state = 'playing'`, [code]);
  if (closed.rowCount === 1 && !paid) {
    // nobody cleared it: every stake goes back, one refund per player, each with its own key
    for (const p of seats) await give(c, p.user_id, m.stake, 'draw_refund', idem.drawRefund(code, p.user_id), code);
  }
  // The room is closed, so a place still empty is a place nobody is coming for: what it was holding goes to
  // first, which is where it would have gone if the table had been too small for places at all.
  if (closed.rowCount === 1 && paid && winnerId !== null) {
    const { reserved } = placePrizes(m.stake, players);
    let claimed = 0;
    for (let i = 0; i < behind.length && i < PLACES_FROM - 1; i++) claimed += prizeAt(i + 1, pot, m.stake, players);
    const left = reserved - claimed;
    if (left > 0) await give(c, winnerId, left, 'payout', idem.placesLeft(code), code);
  }
  return { ...m, state: closed.rowCount === 1 ? 'done' : m.state, winner_id: winner,
           paid_at: paid ? (m.paid_at ?? new Date()) : null };
}

/** What happened to a result: counted, or refused as too early with how long until it would be counted. */
export type ResultVerdict = { ok: true; recorded: boolean } | { ok: false; why: 'too_early'; retryMs: number };

/** The least time, on the server's clock, a match of this many boards can honestly be cleared in. */
export const clearFloorMs = (boards: number): number => Math.max(1, boards) * Math.max(0, config.game.minBoardMs);

/**
 * A player's run is over. The first result counts and the server stamps the moment it arrived, because
 * finishing first is what wins — not the shortest clock. Sending the same result again changes nothing, which
 * is what lets the client retry a request it never saw an answer to.
 *
 * Whether the board was cleared is the client's word, and it is the word that decides the pot. So a clear is
 * believed only once the match has been running, by this server's own clock, for as long as the fastest
 * honest clear of that many boards takes (clearFloorMs). Earlier, nothing is written and the answer is
 * too_early with how long to wait: a script posting "cleared" the instant the board is dealt used to take the
 * pot from every player at the table. The floor is on the server's clock, so a slow phone or a slow network
 * only ever makes an honest result later, never too early -- and the client sends it again when told to.
 * Running out of hearts or giving up is a loss, and a loss can be reported at any time.
 */
export async function submitResult(c: PoolClient, code: string, userId: number, ms: number, cleared: boolean, gaveUp = false): Promise<ResultVerdict> {
  const value = cleared && ms > 0 ? Math.min(ms, 24 * 3600 * 1000) : -1;
  if (value > 0) {
    // The row is held so the age is read against the same start a settlement will see.
    const r = await query<{ age_ms: number | null; boards: string; board: string }>(c,
      `SELECT (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::float8 AS age_ms, boards, board
         FROM matches WHERE code = $1 FOR UPDATE`, [code]);
    const row = r.rows[0];
    const floor = row ? clearFloorMs(boardsOf(row).length) : 0;
    const age = row?.age_ms ?? 0;
    if (row && age < floor) return { ok: false, why: 'too_early', retryMs: Math.ceil(floor - age) };
  }
  const upd = await query(c,
    `UPDATE match_players SET ms = $3, finished_at = now(), pct = $4, gave_up = $5
      WHERE code = $1 AND user_id = $2 AND ms IS NULL`,
    [code, userId, value, value > 0 ? 100 : 0, value > 0 ? false : gaveUp]);
  return { ok: true, recorded: (upd.rowCount ?? 0) > 0 };
}

/**
 * How far along a player is. Never goes backwards, and never moves a player who has already finished.
 *
 * <p>It also stamps the seat as seen, which is the whole of the heartbeat: the client posts this on a timer
 * while a race is on screen whether or not the number has moved, so a player staring at a hard board is as
 * present as one clearing arrows. The write used to be refused outright when the percentage had not grown,
 * which threw that away — a player thinking looked exactly like a player who had closed the tab.
 */
export async function saveProgress(c: PoolClient, code: string, userId: number, pct: number, run: RunState | null = null): Promise<number> {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  // The run is replaced only by a snapshot with at least as many moves as the one held. Two devices can be
  // signed in to the same account, and the one that was left behind keeps posting the board as it last saw
  // it; without this, a tab forgotten on a desk would put every arrow back that the phone had since cleared.
  // At least as many, not more: the same snapshot posted twice is the ordinary case, not a conflict.
  const upd = await query<{ pct: number }>(c,
    `UPDATE match_players
        SET pct = GREATEST(pct, $3), last_seen_at = now(),
            run = CASE WHEN $4::jsonb IS NULL THEN run
                       WHEN run IS NULL OR COALESCE((run->>'moves')::int, 0) <= ($4::jsonb->>'moves')::int THEN $4::jsonb
                       ELSE run END
      WHERE code = $1 AND user_id = $2 AND ms IS NULL RETURNING pct`,
    [code, userId, clamped, run ? JSON.stringify(run) : null]);
  return upd.rows[0]?.pct ?? clamped;
}

// ── Opening a room ──

export type CreateResult =
  | { ok: true; code: string; joined?: string }
  | { ok: false; error: 'bad_stake' | 'bad_length' | 'not_enough_gold' | 'no_boards'; gold?: number }
  | { ok: false; error: 'in_match'; code: string };

export async function createMatch(me: { id: number }, stake: number, openToAll: boolean, tier: number, length = 1): Promise<CreateResult> {
  if (!config.game.stakes.includes(stake)) return { ok: false, error: 'bad_stake' };
  if (!config.game.lengths.includes(length)) return { ok: false, error: 'bad_length' };
  const boards = await pickBoards(length);
  const board = boards[0];
  if (board === undefined) return { ok: false, error: 'no_boards' };

  return tx<CreateResult>(async c => {
    // A player is in one match at a time. Two were possible before, and the way it happened was not exotic:
    // a challenge started in a browser tab, the tab closed, the app opened, a new challenge started there.
    // The account then held two seats and two stakes, its result went to whichever board it happened to be
    // looking at, and the other room sat with a player who was never coming back. Refusing here is the half
    // of the fix that stops it; telling the client which room it already has is the half that makes the
    // refusal useful, because the answer to "you are already in a match" is a way back to it.
    await seatLock(c, me.id);
    const live = await liveMatchOf(c, me.id);
    if (live) return { ok: false, error: 'in_match', code: live.code };

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
      `INSERT INTO matches (code, host_id, stake, board, boards, tier, seed, state, open_to_all)
       VALUES ($1, $2, $3, $4, $5, 2, $6, 'open', $7)`,
      [code, me.id, stake, board, boards.join(','), randomInt(100_000, 1_000_000), openToAll]);
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
  | { ok: false; error: 'no_match' | 'taken' | 'room_full' | 'not_enough_gold'; gold?: number }
  | { ok: false; error: 'in_match'; code: string };

/** Sit down in a room. Used by a friend opening an invitation link and by a player asking for any free seat. */
/**
 * The one-match rule is checked by reading, and two transactions can read "no live match" at the same moment:
 * a double tap on Create, or Create in one tab and Accept in another, seated one account twice and took two
 * stakes. This lock makes the account's seat-taking serial -- held to the end of the transaction, so the
 * second one waits, then sees the first one's seat. It is taken before any row lock, always, so the two
 * never wait on each other in opposite orders.
 */
async function seatLock(c: PoolClient, userId: number): Promise<void> {
  await c.query('SELECT pg_advisory_xact_lock($1, $2)', [SEAT_LOCK, userId]);
}
const SEAT_LOCK = 7301;

export async function joinRoomTx(c: PoolClient, userId: number, code: string, tier: number): Promise<JoinResult> {
  await seatLock(c, userId);
  const m = await matchRowLocked(c, code);
  if (!m) return { ok: false, error: 'no_match' };
  if (m.state !== 'open') return { ok: false, error: 'taken' };
  const seats = await room(c, m.code);
  // Already in this one: that is not a second match, it is a link opened twice or a device catching up.
  if (seats.some(p => p.user_id === userId)) return { ok: true, code: m.code, already: true, started: false };
  if (seats.length >= config.game.seats) return { ok: false, error: 'room_full' };
  // In a different one, though, and an invitation cannot be accepted until that is finished or left.
  const live = await liveMatchOf(c, userId);
  if (live) return { ok: false, error: 'in_match', code: live.code };

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

  // a board nobody has been heard from on is cleared, so the seat -- and the account in it -- is free again
  const idle = await query<{ code: string }>(pool,
    `SELECT m.code FROM matches m
      WHERE m.state = 'playing'
        AND m.started_at IS NOT NULL
        AND m.started_at < now() - ($1 || ' minutes')::interval
        AND NOT EXISTS (
              SELECT 1 FROM match_players p
               WHERE p.code = m.code AND p.ms IS NULL
                 AND p.last_seen_at > now() - ($1 || ' minutes')::interval)
      LIMIT 50`, [String(config.game.idleMinutes)]);
  for (const r of idle.rows) {
    const how = await tx(async c => {
      const m = await matchRowLocked(c, r.code);
      if (!m || m.state !== 'playing') return null;
      const seats = await room(c, r.code);
      // Somebody played it: the board was a real race, and whoever finished has earned what they finished
      // for. The rest are counted as losses, which is what they would have been had they stayed.
      if (seats.some(p => p.finished_at !== null)) {
        await query(c, `UPDATE match_players SET ms = -1, finished_at = now() WHERE code = $1 AND ms IS NULL`, [r.code]);
        await settleMatch(c, r.code);
        return 'settled' as const;
      }
      // Nobody played it at all. Taking the stakes off people for a board that was never a contest is not a
      // rule, it is a fine for closing a tab, so the room is voided and every stake goes back where it came
      // from -- the same way an invitation nobody accepted is handed back.
      const upd = await query(c, `UPDATE matches SET state = 'void', settled_at = now() WHERE code = $1 AND state = 'playing'`, [r.code]);
      if (upd.rowCount !== 1) return null;
      for (const p of seats) await give(c, p.user_id, m.stake, 'expire_refund', idem.expireRefund(r.code, p.user_id), r.code);
      return 'voided' as const;
    });
    if (how === 'settled') { out.settled.push(r.code); await publish(r.code, 'match_finished', { reason: 'idle' }); }
    if (how === 'voided') { out.voided.push(r.code); await publish(r.code, 'room_closed', { reason: 'idle' }); }
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
  await publish(code, 'match_started', { board: m.board, boards: boardsOf(m), tier: m.tier, seed: m.seed, started_at: m.started_at?.getTime() ?? null });
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
