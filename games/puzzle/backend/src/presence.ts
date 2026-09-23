// Who is online, and who is watching which room. All of it is ephemeral by design: it lives in Redis with a
// TTL, it is rebuilt from the sockets that are actually connected, and losing it costs a client one reconnect.
import { redis, k, soft } from './redis.js';

const ONLINE_TTL = 70;     // a socket refreshes this well inside the window; a dead one simply lapses

export const online = {
  /** Mark a player as here. Called on connect and on every heartbeat. */
  async seen(userId: number): Promise<void> {
    await soft(() => redis.setex(k('presence', 'user', userId), ONLINE_TTL, '1'), 'OK');
  },
  async gone(userId: number): Promise<void> {
    await soft(() => redis.del(k('presence', 'user', userId)), 0);
  },
  async is(userId: number): Promise<boolean> {
    return (await soft(() => redis.exists(k('presence', 'user', userId)), 0)) === 1;
  },
  /**
   * A socket that is open is not a player who is looking. A tab left open on a desk keeps its socket alive
   * for hours, and an invitation delivered to it reaches nobody -- so the page says when it is hidden, and an
   * invitation to somebody hidden rings their phone as if they were away. Kept longer than the socket, so a
   * tab closed while hidden stays "away" rather than flipping back to reachable.
   */
  async away(userId: number, hidden: boolean): Promise<void> {
    if (hidden) await soft(() => redis.setex(k('presence', 'away', userId), 3 * 3600, '1'), 'OK');
    else await soft(() => redis.del(k('presence', 'away', userId)), 0);
  },
  async isAway(userId: number): Promise<boolean> {
    return (await soft(() => redis.exists(k('presence', 'away', userId)), 0)) === 1;
  },
  /** How many distinct players this process can see. Reported by /health for the dashboards. */
  async count(): Promise<number> {
    return soft(async () => {
      let cursor = '0', n = 0;
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', k('presence', 'user', '*'), 'COUNT', 500);
        cursor = next; n += keys.length;
      } while (cursor !== '0');
      return n;
    }, 0);
  },
};

/** Who is in a room right now, as opposed to who holds a seat in it: used to show "connected" dots. */
export const roomPresence = {
  async join(code: string, userId: number): Promise<void> {
    await soft(async () => {
      await redis.sadd(k('room', code, 'present'), String(userId));
      await redis.expire(k('room', code, 'present'), ONLINE_TTL * 4);
    }, undefined);
  },
  async leave(code: string, userId: number): Promise<void> {
    await soft(() => redis.srem(k('room', code, 'present'), String(userId)), 0);
  },
  async members(code: string): Promise<number[]> {
    const raw = await soft(() => redis.smembers(k('room', code, 'present')), [] as string[]);
    return raw.map(Number).filter(Number.isFinite);
  },
};

/**
 * Live race progress, mirrored here so a hundred spectators cost one Redis read rather than a hundred database
 * reads. PostgreSQL still holds the authoritative pct; this is the copy that gets read constantly.
 */
export const liveProgress = {
  async set(code: string, userId: number, pct: number): Promise<void> {
    await soft(async () => {
      await redis.hset(k('match', code, 'progress'), String(userId), String(pct));
      await redis.expire(k('match', code, 'progress'), 3600);
    }, undefined);
  },
  async all(code: string): Promise<Record<number, number>> {
    const raw = await soft(() => redis.hgetall(k('match', code, 'progress')), {} as Record<string, string>);
    const out: Record<number, number> = {};
    for (const [id, pct] of Object.entries(raw)) out[Number(id)] = Number(pct);
    return out;
  },
  async clear(code: string): Promise<void> {
    await soft(() => redis.del(k('match', code, 'progress')), 0);
  },
};
