// Every knob Arrow Atlas turns, in one place. The game rules keep the values the PHP service ran with, so a
// migrated player finds the game they left; the infrastructure values come from the environment, so the same
// image runs on this VPS today and on an Arrow Atlas VPS later without a rebuild.
const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} is not a number: ${raw}`);
  return n;
};
const str = (name: string, fallback = ''): string => (process.env[name] ?? fallback).trim();
const bool = (name: string, fallback: boolean): boolean => {
  const raw = str(name);
  return raw === '' ? fallback : /^(1|true|yes|on)$/i.test(raw);
};

export const PRODUCT = 'arrow-atlas';           // the product boundary: database, Redis keys, volumes, logs
export const API_PREFIX = '/api/puzzle/v1';
export const WS_PATH = '/ws/puzzle';
// What the game was called before it was Puzzle – Train Your Brain. Every client already out there — a page
// held in a cache, an installed copy that has not fetched a new script yet — asks for these, and will for as
// long as those copies exist. They are answered by rewriting to the names above, in one place, so the rest of
// the service only knows the new ones and this pair can be deleted the day nothing asks for them.
export const LEGACY_API_PREFIX = '/api/arrow-atlas/v1';
export const LEGACY_WS_PATH = '/ws/arrow-atlas';

export const config = {
  product: PRODUCT,
  env: str('NODE_ENV', 'production'),
  port: num('PORT', 8760),
  host: str('HOST', '0.0.0.0'),
  // Where the browser should reach this service. Empty means "same origin as the page", which is what
  // ariyankhan.com wants today; set it to https://api.arrowatlas.com and the client follows without a rewrite.
  publicApiBase: str('ARROW_ATLAS_PUBLIC_API_BASE'),
  publicWsBase: str('ARROW_ATLAS_PUBLIC_WS_BASE'),
  // Which origins may call the API with credentials. Empty = same-origin only, which is the web case; a phone
  // app sends no Origin at all and is allowed through on its Bearer token.
  allowedOrigins: str('ARROW_ATLAS_ALLOWED_ORIGINS').split(',').map(s => s.trim()).filter(Boolean),
  trustProxy: bool('ARROW_ATLAS_TRUST_PROXY', true),
  cookieSecure: bool('ARROW_ATLAS_COOKIE_SECURE', true),

  pg: {
    host: str('ARROW_ATLAS_PG_HOST', 'arrow-atlas-postgres'),
    port: num('ARROW_ATLAS_PG_PORT', 5432),
    database: str('ARROW_ATLAS_PG_DATABASE', 'arrow_atlas'),
    user: str('ARROW_ATLAS_PG_USER', 'arrow_atlas'),
    password: str('ARROW_ATLAS_PG_PASSWORD'),
    max: num('ARROW_ATLAS_PG_POOL_MAX', 16),
    idleTimeoutMillis: num('ARROW_ATLAS_PG_IDLE_MS', 30_000),
    connectionTimeoutMillis: num('ARROW_ATLAS_PG_CONNECT_MS', 5_000),
    statementTimeoutMillis: num('ARROW_ATLAS_PG_STATEMENT_MS', 10_000),
  },

  redis: {
    host: str('ARROW_ATLAS_REDIS_HOST', 'arrow-atlas-redis'),
    port: num('ARROW_ATLAS_REDIS_PORT', 6379),
    password: str('ARROW_ATLAS_REDIS_PASSWORD'),
    // Every key this product writes starts here, so a second game can never collide with Arrow Atlas.
    prefix: str('ARROW_ATLAS_REDIS_PREFIX', 'arrow-atlas:'),
    db: num('ARROW_ATLAS_REDIS_DB', 0),
  },

  auth: {
    cookie: str('ARROW_ATLAS_COOKIE_NAME', 'aa_session'),
    sessionDays: num('ARROW_ATLAS_SESSION_DAYS', 180),
    googleClientId: str('GOOGLE_CLIENT_ID'),
  },

  // ── Game rules, carried over unchanged from the PHP service ──
  game: {
    signupGold: num('ARROW_ATLAS_SIGNUP_GOLD', 10_000),
    // The tables a player can sit at. Five of them, three orders of magnitude apart at the top, so a new
    // account and one that has been winning for a month both have somewhere to play.
    stakes: str('ARROW_ATLAS_STAKES', '500,1000,10000,1000000,10000000').split(',').map(s => Number(s.trim())).filter(n => n > 0),
    seats: num('ARROW_ATLAS_MATCH_SEATS', 7),
    fillSeconds: num('ARROW_ATLAS_FILL_SECONDS', 63),
    lonelySeconds: num('ARROW_ATLAS_LONELY_SECONDS', 120),
    matchHours: num('ARROW_ATLAS_MATCH_HOURS', 24),
    // The board list the server picks from, so no client can choose an easy country.
    boardsFile: str('ARROW_ATLAS_BOARDS_FILE', '/srv/arrow-atlas/data/arrow-atlas.json'),
  },

  // ── The league ──
  //
  // One week, and the ten who won the most gold at the tables are paid. Tenth place is the base and every
  // place above it doubles, so 10th takes 10K and 1st takes 10K x 2^9 = 5.12M. All three are settings rather
  // than constants because the right size for them is a question about the economy, not about the code: turn
  // the base down and the whole ladder comes down with it, in proportion.
  league: {
    hours: num('ARROW_ATLAS_LEAGUE_HOURS', 168),      // 168 = one week
    ranks: num('ARROW_ATLAS_LEAGUE_RANKS', 10),
    baseGold: num('ARROW_ATLAS_LEAGUE_BASE_GOLD', 10_000),   // what last place in the prizes is paid
  },

  // How often the housekeeping loop runs. The PHP service swept on every request, which is what made a busy
  // lobby slow; one timer in one process does the same work without taxing the players.
  sweepSeconds: num('ARROW_ATLAS_SWEEP_SECONDS', 2),
  logLevel: str('ARROW_ATLAS_LOG_LEVEL', 'info'),
} as const;

export type Config = typeof config;
