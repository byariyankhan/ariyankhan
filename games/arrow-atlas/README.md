# Arrow Atlas — backend

Arrow Atlas is a product, not a feature of the portfolio site. It has its own service, its own database, its own
Redis namespace, its own volumes, its own credentials and its own backups. Nothing it owns is shared with
anything else on the VPS, and nothing else on the VPS can reach into it. That is the point: the day it earns its
own domain and its own server, moving it is a restore and a DNS change, not an untangling.

---

## What runs

| Container | Image | Listens on | Reachable from |
|---|---|---|---|
| `arrow-atlas-api` | `node:22-alpine`, builds this repo at start | `127.0.0.1:8760` | the host nginx only |
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

Every container comes from a public image on Docker Hub, and the two that need this repository's code fetch it
themselves at start — the same pattern `ariyankhan-web` already uses on this VPS. That means the whole project
can be handed to Hostinger as raw compose YAML: no registry, no credentials, nothing to bind-mount, no build
context on the server.

```bash
cd games/arrow-atlas/deploy
cp .env.example .env          # fill in the two passwords and GOOGLE_CLIENT_ID
mkdir -p /var/backups/arrow-atlas

docker compose up -d
docker compose ps             # all four healthy — the API's first start builds, so give it a minute or two
docker compose logs -f arrow-atlas-api
curl -s localhost:8760/health
```

**A faster, reproducible alternative.** `.github/workflows/arrow-atlas-api.yml` builds the image, runs all four
test suites against real PostgreSQL and Redis containers, and publishes to `ghcr.io`. It is not running yet:
GitHub Actions has never run in this repository (zero workflow runs in its whole history), so it is presumably
switched off under **Settings → Actions → General**. Turn it on and a deploy becomes a pull rather than a build:
set `ARROW_ATLAS_IMAGE` in `.env`, replace the API service's `image:` line with `image: ${ARROW_ATLAS_IMAGE}`,
and delete its `command:` block. Until then the fetch-and-build above is what works, and it is what the rest of
this site already does.

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

## What the numbers mean on this VPS

The load tests below were run on a 4-core machine. This VPS is a Hostinger KVM 2: **2 vCPU, 8 GB RAM**, shared
with the portfolio, ASR and Bookween. Expect roughly half the measured throughput here, and read the figures as
what the service does per core rather than as a player count.

The four new containers add about 1 GB of resident memory: PostgreSQL with its defaults, Redis capped at 256 MB,
the Node service, and a backup container that sleeps between runs.

What actually moves the needle is not throughput but how much the client asks for. With the socket up, a client
watching a room polls every 15 seconds instead of every 2, and pushes its own progress over the socket rather
than as a request each time — roughly a sixth of the HTTP traffic per player that the old service took.

---

## Cutting over

In order, and not out of it. Steps 2 and 3 need a shell on the VPS (hPanel → VPS → Browser terminal).

```bash
# 0. A snapshot first, so there is a way back that does not depend on anything below working.
#    hPanel → VPS → Snapshots → Create snapshot

# 1. Bring the backend up. Nothing routes to it yet, so the live game is untouched either way.
cd /var/www/ariyankhan-src/games/arrow-atlas/deploy    # or wherever the repo is checked out
cp .env.example .env && $EDITOR .env                   # two passwords, GOOGLE_CLIENT_ID
mkdir -p /var/backups/arrow-atlas
docker compose up -d
docker compose logs -f arrow-atlas-api                 # wait for "arrow-atlas-api listening"
curl -s localhost:8760/health                          # postgres ok, redis ok

# 2. Move the data. Back it up first, and keep the backup.
mkdir -p /var/backups/arrow-atlas
docker exec ariyankhan-web cat /var/lib/arrow-atlas/arrow-atlas.sqlite \
  > /var/backups/arrow-atlas/pre-migration-$(date -u +%Y%m%dT%H%M%SZ).sqlite
ls -lh /var/backups/arrow-atlas/                       # it must not be empty
docker cp /var/backups/arrow-atlas/pre-migration-*.sqlite arrow-atlas-api:/tmp/legacy.sqlite
docker exec arrow-atlas-api sh -c 'cd /srv/arrow-atlas/site/games/arrow-atlas/backend && node dist/import-sqlite.js /tmp/legacy.sqlite'
#    It must end with "all checks passed". If it does not, stop here: nothing is routed yet, so nothing is broken.

# 3. Route to it.
mkdir -p /etc/nginx/snippets
cp ../../../games/arrow-atlas/deploy/nginx-arrow-atlas.conf     /etc/nginx/snippets/arrow-atlas.conf
cp ../../../games/arrow-atlas/deploy/nginx-arrow-atlas-map.conf /etc/nginx/conf.d/arrow-atlas-map.conf
cp ../../../deploy/nginx-ariyankhan.conf /etc/nginx/sites-available/ariyankhan.conf
nginx -t && systemctl reload nginx

# 4. Check, from outside.
curl -s https://ariyankhan.com/api/arrow-atlas/v1/auth/me      # {"user":null,...}
curl -s https://ariyankhan.com/games/api/auth.php?a=me         # the same, through the old path
```

Then merge and redeploy the `ariyankhan` project so the new client ships. Not before: the new client asks for
`/api/arrow-atlas/v1`, and until step 3 that path does not exist.

**If anything looks wrong after step 4**, the fastest way back is one line — comment the
`include /etc/nginx/snippets/arrow-atlas.conf;` out of `ariyankhan.conf`, `nginx -t && systemctl reload nginx`.
The PHP service and its SQLite file are exactly as they were; the importer only ever read them.

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
docker exec arrow-atlas-backup /srv/arrow-atlas/bin/backup.sh list     # what we have
docker exec arrow-atlas-backup /srv/arrow-atlas/bin/backup.sh once     # take one now
```

### Restoring

```bash
# Prove a dump is restorable, without touching the game. Run this occasionally.
docker exec arrow-atlas-backup /srv/arrow-atlas/bin/restore.sh verify /backups/arrow-atlas-20260917T030000Z.dump

# Restore into a database you name, to look at it.
docker exec arrow-atlas-backup /srv/arrow-atlas/bin/restore.sh into /backups/....dump arrow_atlas_yesterday

# Replace the live database. Saves the current one first, to /backups/pre-restore-<stamp>.dump.
docker compose stop arrow-atlas-api
docker exec -e CONFIRM=yes arrow-atlas-backup /srv/arrow-atlas/bin/restore.sh live /backups/....dump
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
2. **Carry the data across.** On the old server `backup.sh once`, copy the dump over, and on the new
   one `restore.sh live <dump>`. Verify it first with `restore.sh verify`.
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
