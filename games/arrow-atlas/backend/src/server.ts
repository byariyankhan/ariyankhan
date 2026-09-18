// arrow-atlas-api: the whole Arrow Atlas backend in one process — REST, WebSocket and the housekeeping timer.
//
// Keeping them together is deliberate while there is one container: the socket layer reads the same PostgreSQL
// rows the REST handlers write, so there is nothing to keep in step. It is also cheap to split later, because
// events already travel through Redis rather than through memory: run this image with the sweeper off and only
// REST mounted, run it again with only the socket, and no client contract changes.
import Fastify from 'fastify';
import { API_PREFIX, WS_PATH, config } from './config.js';
import { closeDb, dbHealthy, pool } from './db.js';
import { closeRedis, redisHealthy } from './redis.js';
import { migrate } from './migrate.js';
import { registerRoutes } from './routes.js';
import { attachWebSocket, wsStats } from './ws.js';
import { startSweeper, stopSweeper } from './rooms.js';
import { startLeagueTimer, stopLeagueTimer } from './league.js';
import { pruneSessions } from './auth.js';
import { online } from './presence.js';
import { log } from './log.js';

const app = Fastify({
  logger: false,                          // we write our own structured lines, with redaction
  trustProxy: config.trustProxy,           // the host nginx is in front; req.ip must be the player, not the proxy
  bodyLimit: 64 * 1024,
});

// ── Cross-origin ──
//
// The web client is same-origin today, so it needs none of this. It exists for the day Arrow Atlas moves to
// api.arrowatlas.com, and for a phone app, which sends no Origin at all and is authorised by its Bearer token.
app.addHook('onRequest', async (req, reply) => {
  const origin = req.headers.origin;
  if (origin && config.allowedOrigins.includes(origin)) {
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Access-Control-Allow-Credentials', 'true');
    reply.header('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    reply.header('Access-Control-Max-Age', '600');
    await reply.code(204).send();
  }
});

app.setErrorHandler(async (err, req, reply) => {
  // The player gets a shape they can handle; the detail goes to the log, never to the response.
  log.err('request failed', err, { method: req.method, url: req.url });
  if (!reply.sent) await reply.header('Cache-Control', 'no-store').code(500).send({ error: 'server_error' });
});

app.setNotFoundHandler(async (_req, reply) => {
  await reply.header('Cache-Control', 'no-store').code(404).send({ error: 'not_found' });
});

// ── Health ──
//
// Enough to tell which part is unwell without guessing: if the API answers but reports postgres down, it is not
// nginx and it is not the API.
async function health() {
  const [db, cache] = await Promise.all([dbHealthy(), redisHealthy()]);
  const ws = wsStats();
  return {
    ok: db.ok,                    // Redis being down degrades the game; PostgreSQL being down stops it
    product: config.product,
    version: process.env.ARROW_ATLAS_VERSION || 'dev',
    uptime_seconds: Math.round(process.uptime()),
    postgres: db,
    redis: cache,
    websocket: ws,
    online_players: await online.count(),
  };
}
for (const path of ['/health', `${API_PREFIX}/health`]) {
  app.get(path, async (_req, reply) => {
    const h = await health();
    await reply.header('Cache-Control', 'no-store').code(h.ok ? 200 : 503).send(h);
  });
}
// A liveness probe must not touch the database: it answers "this process is running", nothing more.
app.get('/health/live', async (_req, reply) => reply.header('Cache-Control', 'no-store').send({ ok: true }));

registerRoutes(app);

// ── Boot ──

async function main(): Promise<void> {
  if (!config.pg.password && config.env === 'production') throw new Error('ARROW_ATLAS_PG_PASSWORD is not set');
  await migrate();
  attachWebSocket(app);
  startSweeper();
  startLeagueTimer();

  // Expired sessions are swept hourly rather than on every request: nobody is waiting for it.
  const pruner = setInterval(() => { void pruneSessions().catch(e => log.err('session prune failed', e)); }, 3_600_000);
  pruner.unref?.();

  await app.listen({ port: config.port, host: config.host });
  log.info('arrow-atlas-api listening', {
    port: config.port, api: API_PREFIX, ws: WS_PATH,
    postgres: `${config.pg.host}:${config.pg.port}/${config.pg.database}`,
    redis: `${config.redis.host}:${config.redis.port}`,
  });
}

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  log.info('shutting down', { signal });
  stopSweeper();
  stopLeagueTimer();
  // Stop taking new work, let what is in flight finish, then let go of the connections.
  await app.close().catch(e => log.err('http close failed', e));
  await closeRedis().catch(() => {});
  await closeDb().catch(() => {});
  process.exit(0);
}
for (const s of ['SIGTERM', 'SIGINT'] as const) process.on(s, () => void shutdown(s));

process.on('unhandledRejection', e => log.err('unhandled rejection', e));
process.on('uncaughtException', e => { log.err('uncaught exception', e); void shutdown('uncaughtException'); });

main().catch(e => { log.err('failed to start', e); void pool.end().finally(() => process.exit(1)); });
