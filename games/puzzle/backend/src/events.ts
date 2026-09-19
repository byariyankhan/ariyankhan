// What just happened in a room, on its way to the people watching it.
//
// The game logic publishes; the WebSocket layer subscribes. They talk through Redis rather than through each
// other, so a second copy of this service fans out events raised by the first one without either of them
// knowing the other exists. If Redis is down the publish is dropped rather than raised: the clients fall back
// to asking over REST, which is slower but still correct.
import { redis, redisSub, k, soft } from './redis.js';
import { log } from './log.js';

export type MatchEventKind =
  | 'player_joined_room' | 'player_left_room' | 'player_connected' | 'player_disconnected'
  | 'countdown_started' | 'countdown_tick' | 'match_started'
  | 'progress_updated' | 'player_finished' | 'match_finished' | 'room_closed'
  // Not about a room at all: somebody asking one particular player to come and sit at theirs.
  | 'invited';

export interface MatchEvent {
  type: MatchEventKind;
  code: string;
  at: number;                       // server clock, so a client can tell how stale an event is
  data?: Record<string, unknown>;
}

const channel = (code: string) => k('match', code, 'events');
const PATTERN_SUFFIX = ':events';

export async function publish(code: string, type: MatchEventKind, data?: Record<string, unknown>): Promise<void> {
  const ev: MatchEvent = { type, code, at: Date.now(), ...(data ? { data } : {}) };
  await soft(() => redis.publish(channel(code), JSON.stringify(ev)), 0);
}

/**
 * The one event addressed to a person rather than to a room.
 *
 * It travels on the same pattern the socket layer already subscribes to, under a code no room can have — a
 * room code is letters and digits, and this one starts with a colon — so a second container delivers it to a
 * player connected to the first without either of them knowing the other exists.
 */
export const userChannel = (userId: number): string => `:u${userId}`;

export async function publishToUser(userId: number, type: MatchEventKind, data?: Record<string, unknown>): Promise<void> {
  await publish(userChannel(userId), type, data);
}

type Handler = (ev: MatchEvent) => void;
const handlers = new Set<Handler>();
let listening = false;

/** Listen to every room at once; the socket layer decides which of them each client cares about. */
export async function subscribeAll(h: Handler): Promise<() => void> {
  handlers.add(h);
  if (!listening) {
    listening = true;
    const pattern = k('match', '*') + PATTERN_SUFFIX;
    redisSub.on('pmessage', (_pattern: string, _chan: string, payload: string) => {
      let ev: MatchEvent;
      try { ev = JSON.parse(payload) as MatchEvent; } catch { return; }
      for (const fn of handlers) { try { fn(ev); } catch (e) { log.err('event handler threw', e, { type: ev.type }); } }
    });
    await soft(() => redisSub.psubscribe(pattern), 0);
    log.info('subscribed to room events', { pattern });
  }
  return () => { handlers.delete(h); };
}
