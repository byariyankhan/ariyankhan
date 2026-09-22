// Rate limits, counted in Redis, scoped per endpoint rather than one blunt number for the whole API.
//
// The limits below are chosen from what the game actually does: the client polls its room about once every two
// seconds, so a room read has to allow far more than a sign-in does. Anything that moves gold is tightest.
//
// If Redis is unreachable the limiter allows the request. A game that stops letting people log in because a
// cache is down has turned a degraded service into an outage; PostgreSQL still enforces every rule that
// matters, and the outage is logged loudly enough to act on.
import { redis, k } from './redis.js';
import { log } from './log.js';
import { config } from './config.js';

// Every limit below is multiplied by this. It exists so the limits can be loosened on a busy day, or lifted
// out of the way when load-testing the service itself rather than the limiter, without editing the table.
// Production leaves it at 1.
const SCALE = config.rateMultiplier;

export interface Limit { name: string; limit: number; windowSeconds: number; by: 'ip' | 'user'; }

/** Every limit this service enforces, in one table, so they can be read and documented at a glance. */
export const LIMITS = {
  auth_signin:   { name: 'auth_signin',   limit: 10,  windowSeconds: 300, by: 'ip'   },
  auth_read:     { name: 'auth_read',     limit: 120, windowSeconds: 60,  by: 'user' },
  auth_write:    { name: 'auth_write',    limit: 20,  windowSeconds: 300, by: 'user' },
  account_delete:{ name: 'account_delete',limit: 5,   windowSeconds: 3600,by: 'user' },
  // An ad takes about thirty seconds to watch, and the daily cap is the real bound; this is only here to stop
  // a script hammering the endpoint between caps.
  ad_reward:     { name: 'ad_reward',     limit: 20,  windowSeconds: 600, by: 'user' },
  match_create:  { name: 'match_create',  limit: 20,  windowSeconds: 60,  by: 'user' },
  match_join:    { name: 'match_join',    limit: 40,  windowSeconds: 60,  by: 'user' },
  // Read by the account where there is one: a room is polled every two seconds while the socket is down,
  // and eight players behind one carrier NAT would otherwise share one address's allowance.
  match_read:    { name: 'match_read',    limit: 240, windowSeconds: 60,  by: 'user' },
  match_progress:{ name: 'match_progress',limit: 120, windowSeconds: 60,  by: 'user' },
  match_result:  { name: 'match_result',  limit: 20,  windowSeconds: 60,  by: 'user' },
  lobby_read:    { name: 'lobby_read',    limit: 120, windowSeconds: 60,  by: 'user' },
  // The league screen polls its countdown, and a signed-out visitor may read it too, so this is counted
  // against the address rather than the account.
  league_read:   { name: 'league_read',   limit: 90,  windowSeconds: 60,  by: 'ip'   },
  // Progress is read once when a device wakes up and written once per board cleared, so neither of these is
  // a hot path. The write limit is per account and generous enough for the first sync after a long spell
  // offline, which pushes the whole tour in one request rather than as two hundred.
  progress_read: { name: 'progress_read', limit: 60,  windowSeconds: 60,  by: 'user' },
  // One read per board cleared, and a board takes a minute at least. Signed out it is counted by address.
  board_pace:    { name: 'board_pace',   limit: 40,  windowSeconds: 60,  by: 'user' },
  progress_write:{ name: 'progress_write',limit: 60,  windowSeconds: 60,  by: 'user' },
  ws_connect:    { name: 'ws_connect',    limit: 60,  windowSeconds: 60,  by: 'ip'   },
  // The recent players list is read when the dashboard opens and when an invite panel is opened, so it is not
  // a hot path; the invite itself is a notification on somebody else's screen, which is why it is the tightest
  // limit here that does not move gold.
  players_read:  { name: 'players_read',  limit: 60,  windowSeconds: 60,  by: 'user' },
  match_invite:  { name: 'match_invite',  limit: 20,  windowSeconds: 60,  by: 'user' },
  // Subscribing happens once per browser, and again whenever the browser rotates the subscription on its own.
  // Ten a minute is far more than that and still stops a loop from filling the table.
  push_write:    { name: 'push_write',    limit: 10,  windowSeconds: 60,  by: 'user' },
} as const satisfies Record<string, Limit>;

export type LimitName = keyof typeof LIMITS;

export interface Verdict { allowed: boolean; remaining: number; retryAfter: number; limit: number; }

/**
 * A fixed window per (limit, subject). Two Redis commands, pipelined, and the key expires itself.
 *
 * A fixed window can let through up to twice the limit across a boundary. For protecting a small game from
 * abuse that is a fair trade for how cheap and how obvious it is; the tight limits are on actions the database
 * already makes safe, so the limiter is a shield, not the rule.
 */
export async function check(which: LimitName, subject: string): Promise<Verdict> {
  const base = LIMITS[which];
  const cfg: Limit = SCALE === 1 ? base : { ...base, limit: base.limit * SCALE };
  const window = Math.floor(Date.now() / 1000 / cfg.windowSeconds);
  const key = k('rate', cfg.name, subject, window);
  try {
    const [[, count]] = await redis.multi().incr(key).expire(key, cfg.windowSeconds + 1).exec() as [[Error | null, number], unknown];
    const used = Number(count);
    const allowed = used <= cfg.limit;
    return {
      allowed,
      remaining: Math.max(0, cfg.limit - used),
      retryAfter: allowed ? 0 : (window + 1) * cfg.windowSeconds - Math.floor(Date.now() / 1000),
      limit: cfg.limit,
    };
  } catch (e) {
    log.err('rate limiter unavailable, allowing the request', e, { limit: cfg.name });
    return { allowed: true, remaining: cfg.limit, retryAfter: 0, limit: cfg.limit };
  }
}

/** The subject a limit counts against: the account where we know it, the address where we do not. */
export const subjectFor = (cfg: Limit, ip: string, userId: number | null): string =>
  cfg.by === 'user' && userId !== null ? `u${userId}` : `ip${ip}`;
