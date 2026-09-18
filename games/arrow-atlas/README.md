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

Volumes: `arrow-atlas-postgres-data`, `arrow-atlas-redis-data`, `arrow-atlas-backups`, and `arrow-atlas-site` —
the checkout the API fetches, which the backup container reads its two scripts from.

Two networks. `arrow-atlas-data` is `internal: true`, so the database and the cache have no route to or from the
internet at all. `arrow-atlas-edge` exists only so the API can reach Google to verify a sign-in token. The API
sits on both; nothing else sits on the edge.

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

### The tour

A player's cleared boards belong to the account, not to the phone they were cleared on. Two devices sync in
whatever order they happen to be opened, so the merge has to be commutative, and it is done by the database in
one `ON CONFLICT` clause rather than read-modify-written by the service:

* a flag (`cleared`, `skipped`, `quiz`) only ever goes from false to true;
* more stars wins; at equal stars the faster time wins;
* so pushing A then B lands where B then A lands, and pushing the same thing twice changes nothing the second
  time. An old phone opened after a month uploads a worse run and moves nothing.

`users.state` carries the small things a device needs before it can draw the right tour at all — the home
country, the difficulty ladder, the daily boards — shallow-merged for the same reason, so a device that has
never heard of a key cannot delete it by pushing without it. The client keeps playing out of its own storage
and syncs around it: a push that fails costs freshness, not progress.

One rule lives in the client rather than the server, and only because the server cannot know it: a home
country **guessed** from the connection is not the player's answer, so it never travels. Only one chosen in
Settings does.

### The league

Every week the gold won at the gold tables is counted and the ten best are paid. Tenth place takes the base
prize and every place above it doubles it, so with the defaults (`ARROW_ATLAS_LEAGUE_BASE_GOLD` 10,000 and
`ARROW_ATLAS_LEAGUE_RANKS` 10): 10th 10K, 9th 20K, 8th 40K … 1st 5.12M, and the whole ladder comes to 10.23M
gold a week.

Three decisions hold it up:

* **Earning is net.** A week's earning is every movement of gold a table caused — stakes paid, pots won,
  refunds — added up. Counting gross winnings instead would reward two accounts passing the same gold back and
  forth, because each pass would add to a total out of nothing; netting makes that pointless, since the pair
  together always nets zero. Signup gold, admin corrections and last week's prize are excluded, so a prize
  never feeds the next league. A week you lost on is a negative number and no placing at all.
* **The standings are a query, not a counter.** `gold_ledger` already records every movement with its time, so
  any week's table can be derived whenever it is asked for, and there is no second running total to drift away
  from the balances. A partial index over the five play reasons serves the scan.
* **A season is paid once.** The `league_seasons` row is taken with `FOR UPDATE SKIP LOCKED`, every prize is a
  gold movement keyed `league:<season>:<user>`, and `settled_at` is stamped in the same transaction. Two
  containers sweeping together, a restart mid-settlement or a plain retry all end with one payment. The
  finished table is then frozen into `league_prizes`, names included, so a player deleting their account the
  day after does not change what last week said.

Seasons are counted from a fixed Monday, so a restart cannot produce a half-length week, and a service that was
off for a fortnight comes back, fills in the weeks it missed and settles them oldest first.

**On the size of the prizes.** The biggest pot a table can pay today is seven seats at 7,000 — 42,000 gold to
the winner. First place in the league is 5.12M, which is around 120 of those. That is deliberate on the
product's side, but it means the league, not the tables, is where most gold in the game now comes from; turn
`ARROW_ATLAS_LEAGUE_BASE_GOLD` down and the whole ladder comes down with it, in proportion, without a deploy of
anything but the environment.

---

## Public URLs

```
REST       https://ariyankhan.com/api/arrow-atlas/v1/...
WebSocket  wss://ariyankhan.com/ws/arrow-atlas
health     http://127.0.0.1/api/arrow-atlas/health   (host-only)
```

There is one surface and it is versioned. The `/games/api/*.php` paths the PHP service answered were kept
alive as a compatibility shim through the changeover and have been removed now that every client asks for
`/v1`; a `/v2` would be mounted beside `/v1` rather than replacing it, which is the whole reason the version is
in the path.

### REST

| Method | Path | What it does |
|---|---|---|
| GET | `/auth/me` | who am I, and which sign-in providers work |
| POST | `/auth/google` | sign in with a Google ID token |
| POST | `/auth/name` | rename |
| POST | `/auth/logout` | end this session |
| POST | `/auth/delete` | delete the account and everything attached |
| GET | `/progress` | the whole tour this account has played |
| POST | `/progress` | push what a device has; the merged whole comes back |
| GET | `/league` | this week's table, your place in it, the prizes, and last week's result |
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
| `league_read` | 90 / min | IP |
| `progress_read` | 60 / min | account |
| `progress_write` | 60 / min | account |
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

**The faster alternative, now that the image exists.** `.github/workflows/arrow-atlas-api.yml` runs every suite
against real PostgreSQL and Redis service containers on each push and pull request, and on a push to `main` it
builds the image and publishes it to `ghcr.io`. Switching to it is three things: set `ARROW_ATLAS_IMAGE` in
`.env`, replace the API service's `image:` line with `image: ${ARROW_ATLAS_IMAGE}`, and delete its `command:`
block. A deploy then becomes `docker compose pull` rather than a two-to-four minute build on a 2-vCPU box at
every restart. Production still fetches and builds, because that is what it was cut over with and it works;
this is the next thing to change, not an urgent one.

**Or from GitHub, without a shell on the server.** `.github/workflows/arrow-atlas-ops.yml` is dispatch-only and
has five modes: `inspect` and `health` read, `backup-verify` takes one dump and restores it into a scratch
database, `cleanup` deletes legacy artifacts, and `deploy` installs the nginx snippet from the checkout (after
`nginx -t` accepts it, keeping the previous one) and restarts the two containers that re-fetch this repository.
`cleanup` and `deploy` each refuse to run without their confirmation word. Nothing in it names a container,
path or volume outside Arrow Atlas and the portfolio's own web container.

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

## Where the data came from

Arrow Atlas ran on SQLite inside the portfolio's PHP container until September 2026. The cutover moved every
account, session, match, seat and gold balance into PostgreSQL in one pass, with account ids and match codes
preserved, live sessions carried over so nobody was signed out, and each balance written as an opening ledger
entry so balances and the ledger agreed from the first minute. `matches.stakes_in` kept the number of stakes
actually paid, which is why a match whose loser has since deleted their account still pays the winner the full
pot.

The importer, the SQLite file and its backups are all gone: they were deleted after a fresh PostgreSQL dump was
taken and restored into a scratch database to prove it worked. What is left of that history is this paragraph,
the `stakes_in` column, and the pre-2026-09-17 rows in `matches` — which are the point of the whole exercise.

---

## Backups

`arrow-atlas-backup` runs `backup.sh` from the repository checkout that `arrow-atlas-api` fetches, mounted
read-only from the `arrow-atlas-site` volume. That is how it gets the script without a network of its own: it
sits only on the internal network, and `postgres:16-alpine` ships no `curl`. On a first deploy it waits for the
checkout to appear, which takes seconds, and logs while it waits.

It takes a backup on boot and then daily at `ARROW_ATLAS_BACKUP_AT_HOUR` UTC. Each dump is written
with `pg_dump -Fc`, **read back with `pg_restore --list` before it is accepted** — by name, so a dump missing
`users`, `sessions`, `matches`, `match_players` or `gold_ledger` is refused and says which — and copied to
`/var/backups/arrow-atlas` on the host so losing the Docker volume does not lose the history. Dumps older than
`ARROW_ATLAS_BACKUP_KEEP_DAYS` are removed. The container's healthcheck goes red if the newest dump is more
than a day old, so a backup that has quietly stopped shows up as an unhealthy container.

```bash
docker exec arrow-atlas-backup sh -c 'sh $ARROW_ATLAS_SCRIPTS_DIR/backup.sh list'   # what we have
docker exec arrow-atlas-backup sh -c 'sh $ARROW_ATLAS_SCRIPTS_DIR/backup.sh once'   # take one now
```

### Restoring

```bash
# Prove a dump is restorable, without touching the game. Run this occasionally.
docker exec arrow-atlas-backup sh -c 'sh $ARROW_ATLAS_SCRIPTS_DIR/restore.sh verify /backups/arrow-atlas-20260917T030000Z.dump'

# Restore into a database you name, to look at it.
docker exec arrow-atlas-backup sh -c 'sh $ARROW_ATLAS_SCRIPTS_DIR/restore.sh into /backups/....dump arrow_atlas_yesterday'

# Replace the live database. Saves the current one first, to /backups/pre-restore-<stamp>.dump.
docker compose stop arrow-atlas-api
docker exec -e CONFIRM=yes arrow-atlas-backup sh -c 'sh $ARROW_ATLAS_SCRIPTS_DIR/restore.sh live /backups/....dump'
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

**The routing is wrong** — `deploy` keeps the snippet it replaced as
`/var/backups/arrow-atlas/arrow-atlas.conf.before-<stamp>`, and it puts that file back itself if `nginx -t`
refuses the new one. By hand it is a `cp` and a reload.

There is no going back to the PHP service. It was deleted, with its SQLite file and the importer, once a
PostgreSQL dump had been taken and proved restorable — and the accounts and gold created since the cutover
exist only in PostgreSQL anyway, so that route stopped being a rollback the moment somebody played a match.
The rollback that matters is the one above: a dump, verified, restored.

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

bash ../tests/run.sh                       # all four
bash ../tests/run.sh economy api           # or just some
```

The suites need a real PostgreSQL and a real Redis, because what they test is transactions and expiry. CI runs
them against service containers on every push and pull request.

They import Node's own built-ins and the backend's source, and nothing by bare package name: `tests/` has no
`node_modules` of its own, so a bare import there would not resolve. The socket suites use Node's built-in
`WebSocket`, which is the same API the browser client uses. CI has a step that fails on a bare import rather
than letting it turn into a module-not-found error halfway through a run.

| Suite | What it covers |
|---|---|
| `economy` | stakes, pots, payouts, draws, leaving, the crown, requeue, idempotency, overdrafts |
| `progress` | the merge rule: convergence in either order, a stale device undoing nothing, first sign-in, what a client sends being cleaned |
| `api` | both transports, rate limits, a Redis flush, that a link cannot reach anything that changes state, claims the client may not make |
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
