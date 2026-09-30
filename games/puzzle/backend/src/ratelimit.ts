// Rate limits, counted in Redis, scoped per endpoint rather than one blunt number for the whole API.
//
// The limits below are chosen from what the game actually does: the client polls its room about once every two
// seconds, so a room read has to allow far more than a sign-in does. Anything that moves gold is tightest.
//
// If Redis is unreachable, most limits allow the request. A game that stops letting people read a room because
// a cache is down has turned a degraded service into an outage; PostgreSQL still enforces every rule that
// matters, and the outage is logged loudly enough to act on. The few limits that stand between a script and
// gold, a phone ringing or a new account (`strict` below) are counted in this process instead while Redis is
// away, so an outage is never the moment they stop meaning anything.
import { redis, k } from './redis.js';
import { log } from './log.js';
import { config } from './config.js';

// Every limit below is multiplied by this. It exists so the limits can be loosened on a busy day, or lifted
// out of the way when load-testing the service itself rather than the limiter, without editing the table.
// Production leaves it at 1.
const SCALE = config.rateMultiplier;

export interface Limit { name: string; limit: number; windowSeconds: number; by: 'ip' | 'user'; strict?: boolean; }

/** Every limit this service enforces, in one table, so they can be read and documented at a glance. */
export const LIMITS = {
  auth_signin:   { name: 'auth_signin',   limit: 10,  windowSeconds: 300, by: 'ip',   strict: true },
  auth_read:     { name: 'auth_read',     limit: 120, windowSeconds: 60,  by: 'user' },
  auth_write:    { name: 'auth_write',    limit: 20,  windowSeconds: 300, by: 'user' },
  account_delete:{ name: 'account_delete',limit: 5,   windowSeconds: 3600,by: 'user', strict: true },
  // Per address as well: every account deleted and made again is a new user id, so the limit above never
  // sees the same subject twice. A sign-in that would make a new account is counted the same way -- the
  // welcome gold is paid once per Google account (see account_tombstones), and this is what bounds how many
  // new Google accounts one connection can bring in an hour. Generous, because a carrier can put a whole
  // town behind one address.
  account_delete_ip: { name: 'account_delete_ip', limit: 5,  windowSeconds: 3600, by: 'ip', strict: true },
  account_create:    { name: 'account_create',    limit: 100, windowSeconds: 3600, by: 'ip', strict: true },   // a carrier's shared address is many honest people
  // An ad takes about thirty seconds to watch, and the daily cap is the real bound; this is only here to stop
  // a script hammering the endpoint between caps.
  ad_reward:     { name: 'ad_reward',     limit: 20,  windowSeconds: 600, by: 'user', strict: true },
  // The ticket an advertisement's gold is claimed with: one per advertisement shown.
  ad_start:      { name: 'ad_start',      limit: 20,  windowSeconds: 600, by: 'user', strict: true },
  match_create:  { name: 'match_create',  limit: 20,  windowSeconds: 60,  by: 'user' },
  match_join:    { name: 'match_join',    limit: 40,  windowSeconds: 60,  by: 'user' },
  // Read by the account where there is one: a room is polled every two seconds while the socket is down,
  // and eight players behind one carrier NAT would otherwise share one address's allowance.
  match_read:    { name: 'match_read',    limit: 240, windowSeconds: 60,  by: 'user' },
  match_progress:{ name: 'match_progress',limit: 120, windowSeconds: 60,  by: 'user' },
  match_result:  { name: 'match_result',  limit: 20,  windowSeconds: 60,  by: 'user', strict: true },
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
  match_invite:  { name: 'match_invite',  limit: 20,  windowSeconds: 60,  by: 'user', strict: true },
  // Subscribing happens once per browser, and again whenever the browser rotates the subscription on its own.
  // Ten a minute is far more than that and still stops a loop from filling the table.
  push_write:    { name: 'push_write',    limit: 10,  windowSeconds: 60,  by: 'user', strict: true },
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
    // Said once in a while per limit, not once per request: an outage is one fact, not a line for every player.
    const now = Date.now();
    if (now - (outageLogged.get(cfg.name) ?? 0) > 30_000) {
      outageLogged.set(cfg.name, now);
      log.err(cfg.strict ? 'rate limiter unavailable, counting in this process' : 'rate limiter unavailable, allowing the request', e, { limit: cfg.name });
    }
    if (cfg.strict) return local(cfg, subject, window);
    return { allowed: true, remaining: cfg.limit, retryAfter: 0, limit: cfg.limit };
  }
}
const outageLogged = new Map<string, number>();

// The same fixed window, counted in this process: what a strict limit falls back to while Redis is away. Two
// containers each count their own, so the limit is at most doubled -- still a limit, which is the point.
const fallback = new Map<string, number>();
function local(cfg: Limit, subject: string, window: number): Verdict {
  if (fallback.size > 50_000) fallback.clear();          // a flood of subjects must not become a leak
  const key = `${cfg.name}:${subject}:${window}`;
  const used = (fallback.get(key) ?? 0) + 1;
  fallback.set(key, used);
  const allowed = used <= cfg.limit;
  return {
    allowed,
    remaining: Math.max(0, cfg.limit - used),
    retryAfter: allowed ? 0 : (window + 1) * cfg.windowSeconds - Math.floor(Date.now() / 1000),
    limit: cfg.limit,
  };
}

/**
 * The address a limit counts, as a bucket. An IPv6 address is counted by its /64: one home connection is
 * handed a whole /64 and can take a fresh address from it for every request, so counting single addresses
 * would give one person billions of allowances. An IPv4 address written the IPv6 way is IPv4.
 */
export function addressBucket(ip: string): string {
  const raw = (ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const v4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw);
  if (v4) return v4[1]!;
  if (!raw.includes(':')) return raw;
  const [head = '', tail] = raw.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

/** The subject a limit counts against: the account where we know it, the address (or its /64) where we do not. */
export const subjectFor = (cfg: Limit, ip: string, userId: number | null): string =>
  cfg.by === 'user' && userId !== null ? `u${userId}` : `ip${addressBucket(ip)}`;
