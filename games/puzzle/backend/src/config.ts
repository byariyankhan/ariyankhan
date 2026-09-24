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
  // Who may speak for the player. nginx on this host and Cloudflare in front of it each append the address
  // they saw to X-Forwarded-For, so the player's own address is the first one, counted from the right, that is
  // not on this list -- and an X-Forwarded-For a script invents on the left is ignored rather than believed,
  // which is what keeps the per-address rate limits meaning something. Names are proxy-addr's (loopback,
  // linklocal, uniquelocal) plus `cloudflare` for its published ranges; anything else is a CIDR.
  trustedProxies: str('PUZZLE_TRUSTED_PROXIES', 'loopback,linklocal,uniquelocal,cloudflare').split(',').map(s => s.trim()).filter(Boolean),
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
    // The least time between asking for an advertisement ticket and claiming its gold. The web's rewarded
    // advertisements cannot be verified, so this is a bound rather than proof: ten claims take a script at least
    // this long each, and no claim can come without a ticket asked for first. Fifteen seconds is shorter than
    // the rewarded advertisements the networks serve, so a player who watched one through never waits on it.
    adMinSeconds: num('PUZZLE_AD_MIN_SECONDS', 15),
    // The tables a player can sit at. Five of them, three orders of magnitude apart at the top, so a new
    // account and one that has been winning for a month both have somewhere to play.
    stakes: str('PUZZLE_STAKES', '500,1000,10000,1000000,10000000').split(',').map(s => Number(s.trim())).filter(n => n > 0),
    // How long a match may be, in boards. The client offers exactly these.
    lengths: str('PUZZLE_MATCH_LENGTHS', '1,3,5').split(',').map(s => Number(s.trim())).filter(n => n >= 1 && n <= 9),
    seats: num('PUZZLE_MATCH_SEATS', 7),
    fillSeconds: num('PUZZLE_FILL_SECONDS', 63),
    lonelySeconds: num('PUZZLE_LONELY_SECONDS', 120),
    matchHours: num('PUZZLE_MATCH_HOURS', 24),
    // How long a board that has begun may go unheard from before the room is cleared. The client posts its
    // progress on a timer while a race is on screen, so this is not "how long a board may take" -- somebody
    // can stare at one arrow for an hour and still be heard from every few seconds. It is how long after the
    // last sign of life a seat is treated as empty, and the account freed to play again. Twenty-four hours
    // was the only answer before, which is the rest of the day to a player who shut a tab by mistake.
    idleMinutes: num('PUZZLE_IDLE_MINUTES', 10),
    // The fastest a board can honestly be cleared, on the server's own clock. A result that says "cleared" is
    // counted only once now - started_at is at least this times the number of boards; earlier, it is answered
    // 409 too_early and the client sends it again when told to. The easiest board the game deals has about 22
    // arrows (ARROWS_GUESS in the client), and finding and tapping one free arrow takes a very quick human a
    // quarter of a second at the least, so six seconds is under the fastest believable clear rather than near a
    // normal one. It is a floor on the server's clock, so lag only ever makes a result later, never too early.
    minBoardMs: num('PUZZLE_MIN_BOARD_MS', 6_000),
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
    // What one player's week can take from any single opponent, netted over the week. Without it a prize could
    // be bought with accounts: open a friends' room with a second account and let it lose. A hundred thousand
    // is ten signup grants -- ten straight wins at the 10,000 table against the same person -- so honest
    // play between friends still counts, and the rest of a big week has to be won from other people.
    opponentCap: num('PUZZLE_LEAGUE_OPPONENT_CAP', 100_000),
    // And a prize needs at least this many different people played in the week, so a week of two accounts
    // passing gold back and forth is a place on the board and never a payment.
    minOpponents: num('PUZZLE_LEAGUE_MIN_OPPONENTS', 3),
  },

  // ── Reaching a player who is not looking at the game ──
  //
  // Web Push, for the two things that happen while somebody is away: a friend asking them to a match, and the
  // league paying out. The keypair identifies this server to the browsers' push services; the private half is
  // a secret and lives only in the environment of the host that runs this, never in the repository. With
  // nothing set, notifications are simply off — every send is a no-op and the endpoints say so.
  push: {
    publicKey: str('PUZZLE_VAPID_PUBLIC'),
    privateKey: str('PUZZLE_VAPID_PRIVATE'),
    // Who the push service should complain to about us; a mailto: or a URL, per the VAPID spec.
    subject: str('PUZZLE_VAPID_SUBJECT', 'mailto:ariyanfiles@gmail.com'),
    // How long a push service should hold a notification for a phone that is off. An invitation is worth
    // nothing tomorrow (the room is gone), so it expires with the room; the league can wait a day.
    ttlSeconds: num('PUZZLE_PUSH_TTL', 3600),
    // Where a browser's push endpoint may point. This service makes a request to whatever it stores here, so
    // it stores only addresses at the push services browsers actually use, never one inside our own network.
    hosts: str('PUZZLE_PUSH_HOSTS', 'fcm.googleapis.com,android.googleapis.com,push.services.mozilla.com,notify.windows.com,wns.windows.com,push.apple.com,push.samsungosp.com,push.opera.com').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  },

  // ── The app's notifications ──
  // The Firebase service account, as the JSON Firebase hands out -- raw, or base64 so it fits on one .env
  // line, which is how the fcm-key mode of puzzle-ops writes it. A secret: it lives in the host's .env and
  // nowhere else. Empty means the app's notifications are simply off, the way no VAPID keys mean the
  // browser's are.
  fcm: {
    serviceAccount: str('PUZZLE_FCM_SERVICE_ACCOUNT'),
  },

  // ── The evening nudge ──
  // Once a day at this hour, local to the device, to anyone with notifications on who has not played in
  // quietHours. defaultTz is for a device that does not say where it is.
  reminder: {
    hour: num('PUZZLE_REMINDER_HOUR', 19),
    quietHours: num('PUZZLE_REMINDER_QUIET_HOURS', 4),
    defaultTz: str('PUZZLE_REMINDER_TZ', 'Asia/Dhaka'),
  },

  // How often the housekeeping loop runs. The PHP service swept on every request, which is what made a busy
  // lobby slow; one timer in one process does the same work without taxing the players.
  sweepSeconds: num('PUZZLE_SWEEP_SECONDS', 2),
  logLevel: str('PUZZLE_LOG_LEVEL', 'info'),
} as const;

export type Config = typeof config;
