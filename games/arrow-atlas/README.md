# Arrow Atlas — backend

Arrow Atlas is a product, not a feature of the portfolio site. It has its own service, its own database, its own
Redis namespace, its own volumes, its own credentials and its own backups. Nothing it owns is shared with
anything else on the VPS, and nothing else on the VPS can reach into it. That is the point: the day it earns its
own domain and its own server, moving it is a restore and a DNS change, not an untangling.

---

## What runs

| Container | Image | Listens on | Reachable from |
|---|---|---|---|
| `arrow-atlas-api` | `ghcr.io/byariyankhan/arrow-atlas-api:main` | `127.0.0.1:8760` | the host nginx only |
| `arrow-atlas-postgres` | `postgres:16-alpine` | nothing published | `arrow-atlas-api`, `arrow-atlas-backup` |
| `arrow-atlas-redis` | `redis:7-alpine` | nothing published | `arrow-atlas-api` |
| `arrow-atlas-backup` | `postgres:16-alpine` | nothing published | — |

Two networks. `arrow-atlas-data` is `internal: true`, so the database and the cache have no route to or from the
internet at all. `arrow-atlas-edge` exists only so the API can reach Google to verify a sign-in token. The API
sits on both; nothing else sits on the edge.

Volumes: `arrow-atlas-postgres-data`, `arrow-atlas-redis-data`, `arrow-atlas-backups`.
Database: `arrow_atlas`, owned by the role `arrow_atlas`.
Every Redis key begins `arrow-atlas:`.

### Who owns what

**PostgreSQL is the only source of truth.** Accounts, sessions, gold, rooms, matches, results, and every
movement of gold ever made. If Redis is wiped, nothing here is lost.

**Redis holds only what can be rebuilt**: who is online, who is watching a room, live race progress, rate-limit
counters, and the pub/sub channel the WebSocket layer fans out through. Everything has a TTL. If it is flushed
mid-match the game keeps running — there is a test for exactly that.

### The gold ledger

Every movement of gold is a row in `gold_ledger` with a unique `idem_key`, written in the same transaction as
the balance change. `payout:ABC123` can exist once. A retried request, a double-clicked button, two API
containers racing — all of them write the second attempt into a unique-violation and change nothing.

`users.gold` is the running total; the ledger is what it is made of. The two must always agree, and every test
suite checks that before it is allowed to pass.

---

## Public URLs

```
REST       https://ariyankhan.com/api/arrow-atlas/v1/...
WebSocket  wss://ariyankhan.com/ws/arrow-atlas
health     http://127.0.0.1/api/arrow-atlas/health   (host-only)
```

The old `/games/api/auth.php` and `/games/api/match.php` paths still answer, with byte-identical responses, so a
browser running a cached copy of the game keeps working through the changeover. They are a compatibility shim
and nothing new should be added to them.

### REST

| Method | Path | What it does |
|---|---|---|
| GET | `/auth/me` | who am I, and which sign-in providers work |
| POST | `/auth/google` | sign in with a Google ID token |
| POST | `/auth/name` | rename |
| POST | `/auth/logout` | end this session |
| POST | `/auth/delete` | delete the account and everything attached |
| GET | `/lobby` | how many are waiting, per stake |
| POST | `/matches` | open a room (`stake`, `open_to_all`, `tier`) |
| GET | `/matches/:code` | the room as you may see it |
| POST | `/matches/:code/join` | take a seat |
| POST | `/matches/:code/start` | host starts an invite-only room |
| POST | `/matches/:code/leave` | walk out, taking your stake |
| POST | `/matches/:code/progress` | how far along you are |
| POST | `/matches/:code/result` | your run is over |

### WebSocket

Client sends `{type:'watch', code}`, `{type:'progress', pct}`, `{type:'resync'}`, `{type:'ping'}`.
Server sends `hello`, `state`, `player_joined_room`, `player_left_room`, `player_connected`,
`player_disconnected`, `countdown_tick`, `match_started`, `progress_updated`, `player_finished`,
`match_finished`, `room_closed`.

The socket carries what is cheap and constant. Anything that moves gold — a stake, a result, a payout — is a
REST call, because those must survive a dropped connection and be safe to send twice. The socket is a speed-up,
never a dependency: if it cannot open, the client falls back to polling and the player notices only latency.

**Reconnect**: on `watch` (and on `resync`) the server replies with the whole authoritative room state, read
from PostgreSQL. A phone that lost signal mid-race asks once and is back in step. It never replays missed
events and never trusts what the client remembered.

### Authentication

One model, two transports. A long random opaque token, stored only as a SHA-256 hash.

* **Browser** — an HttpOnly, SameSite=Lax, Secure cookie. JavaScript never sees the token.
* **App** — the same token in the sign-in response body, sent back as `Authorization: Bearer <token>`. Send
  `{"client":"app"}` with the sign-in to get it. The WebSocket takes it as `?token=` where a header cannot be set.

No JWT. This game has one backend, so a token it can revoke the instant an account is deleted beats one it has
to wait out.

### Rate limits

Per endpoint, counted in Redis, `429` with `Retry-After` when exceeded. If Redis is unreachable the limiter
allows the request and says so loudly in the log: a game that stops letting people in because a cache is down
has turned a degraded service into an outage.

| Limit | Allowance | Counted by |
|---|---|---|
| `auth_signin` | 10 / 5 min | IP |
| `auth_read` | 120 / min | IP |
| `auth_write` | 20 / 5 min | account |
| `account_delete` | 5 / hour | account |
| `match_create` | 20 / min | account |
| `match_join` | 40 / min | account |
| `match_read` | 240 / min | IP |
| `match_progress` | 120 / min | account |
| `match_result` | 20 / min | account |
| `lobby_read` | 120 / min | IP |
| `ws_connect` | 60 / min | IP |

`ARROW_ATLAS_RATE_MULTIPLIER` scales all of them. Production leaves it at 1.

---

## Deploying

```bash
cd games/arrow-atlas/deploy
cp .env.example .env          # fill in the two passwords and GOOGLE_CLIENT_ID
mkdir -p /var/backups/arrow-atlas

docker compose pull
docker compose up -d
docker compose ps             # all four healthy
curl -s localhost:8760/health | jq
```

nginx, once:

```bash
mkdir -p /etc/nginx/snippets
cp games/arrow-atlas/deploy/nginx-arrow-atlas.conf     /etc/nginx/snippets/arrow-atlas.conf
cp games/arrow-atlas/deploy/nginx-arrow-atlas-map.conf /etc/nginx/conf.d/arrow-atlas-map.conf
cp deploy/nginx-ariyankhan.conf /etc/nginx/sites-available/ariyankhan.conf
nginx -t && systemctl reload nginx
```

`ariyankhan.conf` already carries `include /etc/nginx/snippets/arrow-atlas.conf;`. ASR, Bookween and the
portfolio have their own server blocks and are untouched by any of this.

Schema migrations run themselves on boot, behind an advisory lock, so two containers starting together apply
them once.

---

## Moving the existing SQLite data

Do this once, at cutover, and never again — the importer refuses to run a second time into a database that
already holds players.

```bash
# 1. Back up what exists, and keep it.
docker exec ariyankhan-web sh -c 'cat /var/lib/arrow-atlas/arrow-atlas.sqlite' > /var/backups/arrow-atlas/pre-migration-$(date -u +%Y%m%dT%H%M%SZ).sqlite

# 2. Put it where the API can read it and import.
docker cp /var/backups/arrow-atlas/pre-migration-*.sqlite arrow-atlas-api:/tmp/legacy.sqlite
docker exec arrow-atlas-api node dist/import-sqlite.js /tmp/legacy.sqlite

# 3. Read the report. It must end with "all checks passed".
```

The importer preserves account ids and match codes, carries live sessions over (so nobody is signed out),
writes each account's gold as an opening ledger entry (so balances and ledger agree from day one), and keeps
`stakes_in` at the number of stakes actually paid — which is why a match whose loser has since deleted their
account still pays the winner the full pot.

Then it proves it: row counts, gold totals before and after, ledger reconciliation, referential integrity, no
negative balances, and that the next sign-up will not collide with a migrated id.

**Never delete the SQLite backup.**

---

## Backups

`arrow-atlas-backup` takes one on boot and then daily at `ARROW_ATLAS_BACKUP_AT_HOUR` UTC. Each dump is written
with `pg_dump -Fc`, **read back with `pg_restore --list` before it is accepted**, and copied to
`/var/backups/arrow-atlas` on the host so losing the Docker volume does not lose the history. Dumps older than
`ARROW_ATLAS_BACKUP_KEEP_DAYS` are removed. The container's healthcheck goes red if the newest dump is more
than a day old, so a backup that has quietly stopped shows up as an unhealthy container.

```bash
docker exec arrow-atlas-backup arrow-atlas-backup list     # what we have
docker exec arrow-atlas-backup arrow-atlas-backup once     # take one now
```

### Restoring

```bash
# Prove a dump is restorable, without touching the game. Run this occasionally.
docker exec arrow-atlas-backup arrow-atlas-restore verify /backups/arrow-atlas-20260917T030000Z.dump

# Restore into a database you name, to look at it.
docker exec arrow-atlas-backup arrow-atlas-restore into /backups/....dump arrow_atlas_yesterday

# Replace the live database. Saves the current one first, to /backups/pre-restore-<stamp>.dump.
docker compose stop arrow-atlas-api
docker exec -e CONFIRM=yes arrow-atlas-backup arrow-atlas-restore live /backups/....dump
docker compose start arrow-atlas-api
```

`verify` restores into a scratch database, counts the rows, checks that the ledger reconciles, and drops the
scratch database again. It is the only way to know a backup works.

---

## Rolling back

**The API misbehaves, the data is fine** — the fastest fix, and the usual one:

```bash
cd games/arrow-atlas/deploy
ARROW_ATLAS_IMAGE=ghcr.io/byariyankhan/arrow-atlas-api:<previous-sha> docker compose up -d arrow-atlas-api
```

**The data is wrong** — restore the newest good dump, as above.

**Back to the PHP service entirely** — possible until the old code is deleted, and the reason it is still in the
repository:

1. `docker compose -p arrow-atlas stop arrow-atlas-api`
2. Comment the `include /etc/nginx/snippets/arrow-atlas.conf;` line out of `ariyankhan.conf`, `nginx -t`,
   `systemctl reload nginx`. `/games/api/*.php` goes back to the `ariyankhan-web` container.
3. The SQLite file in the `aa-data` volume is exactly as it was: the importer only ever read it.

What that loses: anything that happened after the cutover, because it happened in PostgreSQL. Decide quickly,
or decide to go forward instead.

---

## Moving Arrow Atlas to its own VPS and domain

The work this whole layout exists to make short:

1. **Deploy the same project.** Copy `games/arrow-atlas/` to the new server, `cp .env.example .env`, fill in
   fresh passwords, `docker compose up -d`. The image comes from ghcr; nothing is built on the server.
2. **Carry the data across.** On the old server `arrow-atlas-backup once`, copy the dump over, and on the new
   one `arrow-atlas-restore live <dump>`. Verify it first with `arrow-atlas-restore verify`.
3. **Persistent assets.** There are none beyond PostgreSQL: profile pictures are Google URLs, and boards are
   baked into the image.
4. **Point the client at it.** Two meta tags in `arrow-atlas.html`:
   ```html
   <meta name="arrow-atlas-api" content="https://api.arrowatlas.com" />
   <meta name="arrow-atlas-ws"  content="wss://api.arrowatlas.com" />
   ```
   and set `ARROW_ATLAS_ALLOWED_ORIGINS` to the origins the page is served from, so the browser may send
   credentials cross-origin. No JavaScript changes.
5. **nginx and DNS.** Include the same `nginx-arrow-atlas.conf` in the new server block — the file does not
   change — point DNS at the new server, and get a certificate.
6. **Verify**, then remove the include from `ariyankhan.conf`.

What makes this short is what is *not* in the way: no shared database, no shared Redis keyspace, no shared
volumes, no other game's tables, and a client that never hardcoded a hostname.

---

## Working on it

```bash
cd games/arrow-atlas/backend
npm install
cp .env.example .env.dev       # point it at a local PostgreSQL and Redis
npm run migrate
npx tsx src/server.ts

bash ../tests/run.sh                       # economy, migration, api
bash ../tests/run.sh economy migration api ws
```

The suites need a real PostgreSQL and a real Redis, because what they test is transactions and expiry. CI runs
them against service containers on every push.

| Suite | What it covers |
|---|---|
| `economy` | stakes, pots, payouts, draws, leaving, the crown, requeue, idempotency, overdrafts |
| `migration` | the SQLite import: counts, ids, gold, sessions, pot sizes, refusal to run twice |
| `api` | both transports, rate limits, legacy compatibility, a Redis flush, claims the client may not make |
| `ws` | connect, authorisation, the countdown, clamped progress, reconnect resync, finish events |

Every suite ends by checking that the ledger accounts for every balance.

### Load testing

```bash
npx tsx ../tests/loadseed.ts 4000 500000     # 4000 players behind 500k finished matches
npx tsx ../tests/load.ts read  60 8
npx tsx ../tests/load.ts write 60 8
npx tsx ../tests/load.ts ws    2800 10
```

Raise `ARROW_ATLAS_RATE_MULTIPLIER` when load testing, or you will be measuring the rate limiter. The runner
says so if more than a hundredth of its requests failed, which is how that mistake gets caught.
