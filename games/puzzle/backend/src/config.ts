// Every knob this service turns, in one place. The game rules keep the values the PHP service ran with, so a
// migrated player finds the game they left; the infrastructure values come from the environment, so the same
// image runs on this VPS today and on a VPS of the game's own later without a rebuild.
//
// Every variable is PUZZLE_*. They answered to ARROW_ATLAS_* as well for as long as that was what the .env on
// the host called them; the host has been renamed, so this reads one name again.
const envOf = (name: string): string | undefined => process.env[name];
const num = (name: string, fallback: number): number => {
  const raw = envOf(name);
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} is not a number: ${raw}`);
  return n;
};
const str = (name: string, fallback = ''): string => (envOf(name) ?? fallback).trim();
const bool = (name: string, fallback: boolean): boolean => {
  const raw = str(name);
  return raw === '' ? fallback : /^(1|true|yes|on)$/i.test(raw);
};

export const PRODUCT = 'puzzle';                // the product boundary: Redis keys, logs, the health line
export const API_PREFIX = '/api/puzzle/v1';
export const WS_PATH = '/ws/puzzle';

export const config = {
  product: PRODUCT,
  version: str('PUZZLE_VERSION', 'dev'),
  migrationsDir: str('PUZZLE_MIGRATIONS_DIR'),
  rateMultiplier: Math.max(1, num('PUZZLE_RATE_MULTIPLIER', 1)),
  env: str('NODE_ENV', 'production'),
  port: num('PORT', 8760),
  host: str('HOST', '0.0.0.0'),
  // Where the browser should reach this service. Empty means "same origin as the page", which is what
  // ariyankhan.com wants today; set it to a host of the game's own and the client follows without a rewrite.
  publicApiBase: str('PUZZLE_PUBLIC_API_BASE'),
  publicWsBase: str('PUZZLE_PUBLIC_WS_BASE'),
  // Which origins may call the API with credentials. Empty = same-origin only, which is the web case; a phone
  // app sends no Origin at all and is allowed through on its Bearer token.
  allowedOrigins: str('PUZZLE_ALLOWED_ORIGINS').split(',').map(s => s.trim()).filter(Boolean),
  trustProxy: bool('PUZZLE_TRUST_PROXY', true),
  cookieSecure: bool('PUZZLE_COOKIE_SECURE', true),

  pg: {
    // The container names, not the product's name: renaming those is a separate job with a database in it.
    host: str('PUZZLE_PG_HOST', 'puzzle-postgres'),
    port: num('PUZZLE_PG_PORT', 5432),
    database: str('PUZZLE_PG_DATABASE', 'puzzle'),
    user: str('PUZZLE_PG_USER', 'puzzle'),
    password: str('PUZZLE_PG_PASSWORD'),
    max: num('PUZZLE_PG_POOL_MAX', 16),
    idleTimeoutMillis: num('PUZZLE_PG_IDLE_MS', 30_000),
    connectionTimeoutMillis: num('PUZZLE_PG_CONNECT_MS', 5_000),
    statementTimeoutMillis: num('PUZZLE_PG_STATEMENT_MS', 10_000),
  },

  redis: {
    host: str('PUZZLE_REDIS_HOST', 'puzzle-redis'),
    port: num('PUZZLE_REDIS_PORT', 6379),
    password: str('PUZZLE_REDIS_PASSWORD'),
    // Every key this product writes starts here, so a second game can never collide with this one.
    prefix: str('PUZZLE_REDIS_PREFIX', 'puzzle:'),
    db: num('PUZZLE_REDIS_DB', 0),
  },

  auth: {
    cookie: str('PUZZLE_COOKIE_NAME', 'aa_session'),
    sessionDays: num('PUZZLE_SESSION_DAYS', 180),
    googleClientId: str('GOOGLE_CLIENT_ID'),
  },

  // ── Game rules, carried over unchanged from the PHP service ──
  game: {
    signupGold: num('PUZZLE_SIGNUP_GOLD', 10_000),
    // What watching an advertisement is worth, and how many a day count. 500 is exactly one seat at the
    // smallest table, which is the whole intent: an ad buys a game, not a fortune. Ten a day is 5,000 -- half
    // a signup grant -- so the faucet cannot inflate an economy whose top table is 10,000,000.
    adGold: num('PUZZLE_AD_GOLD', 500),
    adGoldPerDay: num('PUZZLE_AD_GOLD_PER_DAY', 10),
    // The tables a player can sit at. Five of them, three orders of magnitude apart at the top, so a new
    // account and one that has been winning for a month both have somewhere to play.
    stakes: str('PUZZLE_STAKES', '500,1000,10000,1000000,10000000').split(',').map(s => Number(s.trim())).filter(n => n > 0),
    seats: num('PUZZLE_MATCH_SEATS', 7),
    fillSeconds: num('PUZZLE_FILL_SECONDS', 63),
    lonelySeconds: num('PUZZLE_LONELY_SECONDS', 120),
    matchHours: num('PUZZLE_MATCH_HOURS', 24),
    // The board list the server picks from, so no client can choose an easy country.
    boardsFile: str('PUZZLE_BOARDS_FILE', '/srv/puzzle/site/games/data/puzzle.json'),
  },

  // ── The league ──
  //
  // One week, and the ten who won the most gold at the tables are paid. Tenth place is the base and every
  // place above it doubles, so 10th takes 10K and 1st takes 10K x 2^9 = 5.12M. All three are settings rather
  // than constants because the right size for them is a question about the economy, not about the code: turn
  // the base down and the whole ladder comes down with it, in proportion.
  league: {
    hours: num('PUZZLE_LEAGUE_HOURS', 168),      // 168 = one week
    ranks: num('PUZZLE_LEAGUE_RANKS', 10),
    baseGold: num('PUZZLE_LEAGUE_BASE_GOLD', 10_000),   // what last place in the prizes is paid
  },

  // How often the housekeeping loop runs. The PHP service swept on every request, which is what made a busy
  // lobby slow; one timer in one process does the same work without taxing the players.
  sweepSeconds: num('PUZZLE_SWEEP_SECONDS', 2),
  logLevel: str('PUZZLE_LOG_LEVEL', 'info'),
} as const;

export type Config = typeof config;
