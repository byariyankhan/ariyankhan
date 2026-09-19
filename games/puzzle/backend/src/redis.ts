// Redis holds only what Arrow Atlas can afford to lose: who is online, live race progress, countdown mirrors,
// rate-limit counters, and the pub/sub channel that lets one API process tell another what just happened.
// Every key is prefixed with the product, and everything perishable carries a TTL. If this whole server is
// flushed, accounts, gold and finished matches are untouched in PostgreSQL and the game keeps running.
import Redis from 'ioredis';
import { config } from './config.js';
import { log } from './log.js';

const opts = {
  host: config.redis.host,
  port: config.redis.port,
  db: config.redis.db,
  ...(config.redis.password ? { password: config.redis.password } : {}),
  // Never let a Redis hiccup become a hung request: fail fast and let the caller carry on without it.
  maxRetriesPerRequest: 2,
  enableOfflineQueue: false,
  connectTimeout: 3_000,
  lazyConnect: false,
  retryStrategy: (times: number) => Math.min(times * 200, 3_000),
};

export const redis = new Redis(opts);
// A connection in subscriber mode can run no other command, so the fan-out gets its own.
export const redisSub = new Redis(opts);

let warned = false;
for (const [name, client] of [['redis', redis], ['redis-sub', redisSub]] as const) {
  client.on('error', (e: Error) => {
    if (warned) return;          // a dropped Redis retries every few hundred ms; say it once, not forever
    warned = true;
    log.err(`${name} error`, e);
    setTimeout(() => { warned = false; }, 30_000);
  });
  client.on('ready', () => log.info(`${name} ready`, { host: config.redis.host, port: config.redis.port }));
}

/** Product-scoped key. `k('room', code)` -> `arrow-atlas:room:ABC123`. */
export const k = (...parts: (string | number)[]): string => config.redis.prefix + parts.join(':');

/**
 * Run a Redis command, returning `fallback` if Redis is unreachable.
 *
 * Nothing in here is the source of truth, so a Redis outage must degrade the game (no live presence) rather
 * than break it (no login). Callers get a value they can use instead of an exception they must handle.
 */
export async function soft<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch { return fallback; }
}

export async function redisHealthy(): Promise<{ ok: boolean; detail?: string }> {
  try {
    const pong = await redis.ping();
    return { ok: pong === 'PONG' };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([redis.quit(), redisSub.quit()]);
}
