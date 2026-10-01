# Arrow Atlas — backend

Arrow Atlas is a product, not a feature of the portfolio site. It has its own service, its own database, its own
Redis namespace, its own volumes, its own credentials and its own backups. Nothing it owns is shared with
anything else on the VPS, and nothing else on the VPS can reach into it. That is the point: the day it earns its
own domain and its own server, moving it is a restore and a DNS change, not an untangling.

---

## What runs

| Container | Image | Listens on | Reachable from |
|---|---|---|---|
| `puzzle-api` | `node:22-alpine`, builds this repo at start | `127.0.0.1:8760` | the host nginx only |
| `puzzle-postgres` | `postgres:16-alpine` | nothing published | `puzzle-api`, `puzzle-backup` |
| `puzzle-redis` | `redis:7-alpine` | nothing published | `puzzle-api` |
| `puzzle-backup` | `postgres:16-alpine` | nothing published | — |

Volumes: `puzzle-postgres-data`, `puzzle-redis-data`, `puzzle-backups`, and `puzzle-site` —
the checkout the API fetches, which the backup container reads its two scripts from.

Two networks. `puzzle-data` is `internal: true`, so the database and the cache have no route to or from the
internet at all. `puzzle-edge` exists only so the API can reach Google to verify a sign-in token. The API
sits on both; nothing else sits on the edge.

Database: `puzzle`, owned by the role `puzzle`.
Every Redis key begins `puzzle:`.

### Who owns what

**PostgreSQL is the only source of truth.** Accounts, sessions, gold, rooms, matches, results, and every
movement of gold ever made. If Redis is wiped, nothing here is lost.

**Redis holds only what can be rebuilt**: who is online, who is watching a room, live race progress, rate-limit
counters, and the pub/sub channel the WebSocket layer fans out through. Everything has a TTL. If it is flushed
mid-match the game keeps running — there is a test for exactly that.

### One match at a time

An account is in one live match at a time, and can always find out which. The rule exists because the same
account is often signed in twice — a phone and a browser — and a challenge started in one of them used to be
invisible to the other: the room's code lived in whichever client had opened it, so closing a tab lost the
room while the seat, and the stake in it, stayed exactly where they were. From there the account could open a
second match, and its result went to whichever board it happened to be looking at.

Three things hold it together:

- **`/auth/me` carries the live match**, in the same shape the room screen is drawn from. A device that has
  never heard of the room finds it the moment it signs in, and goes there: straight onto the board if it is
  being played, into the waiting room if it has not started.
- **Opening or accepting a second match is refused** with `409 in_match`, and the refusal names the room
  already held — `{"error":"in_match","match_code":"ABC123"}` — because the only useful answer to "you are
  already in a match" is the way back to it.
- **A board nobody is on is cleared.** The client posts its progress on a timer while a race is on screen,
  whether or not the number has moved, and that stamps `match_players.last_seen_at`. When every unfinished
  seat in a playing match has been quiet for `PUZZLE_IDLE_MINUTES` (10), the sweeper closes it: settled if
  somebody actually finished, so their win stands, and voided with every stake handed back if nobody did —
  taking gold for a board that was never a contest is a fine for closing a tab, not a rule. The old
  twenty-four hour sweep is still there behind it as a backstop.

Finishing a run frees the account immediately, before the match even settles; so does leaving a room that has
not started.

**The board travels with the seat.** The client posts a small snapshot of its run with its progress — the
indices of the arrows that have gone, hearts, hints and checks used and allowed, wrong taps, and a move
counter — into `match_players.run`, and `/auth/me` and the match view hand it back as `your_run`. A device
resuming the match puts it onto the freshly drawn board before anyone is told the board is ready. The server
replaces it only with a snapshot of at least as many moves, so a tab left open on a stale board cannot put
back what the phone has since cleared; and a device whose poll brings back a run ahead of its own board
applies it rather than fighting it, which is how that tab catches up. The server derives nothing from it —
`pct` and `ms` still decide the race — and `cleanRun` drops anything that is not a small, well-formed board.

**A match is a run of boards.** A room is opened for one, three or five boards (`PUZZLE_MATCH_LENGTHS`,
default `1,3,5`; `/lobby` lists them and `POST /matches` takes `boards`), and the server picks that many
countries when the seats fill, so both players see the same boards in the same order. `pct` counts across
the whole run — board two of three starts at a third — and the snapshot carries the board index (`bi`), so
a device resuming the match lands on the right board. Clearing the last board finishes the run; running out
of hearts on any board ends it there.

### Who the player is, behind two proxies

A request arrives through Cloudflare and then nginx, and each appends the address it saw to
`X-Forwarded-For`. The service trusts exactly those (`PUZZLE_TRUSTED_PROXIES`, default
`loopback,linklocal,uniquelocal,cloudflare` — proxy-addr's names plus Cloudflare's published ranges, or any
CIDR), so `req.ip` and the socket's `clientIp` are the rightmost address that is not a proxy of ours, and an
`X-Forwarded-For` a script invents is ignored rather than believed. Before this the leftmost entry was
trusted, and every per-address limit was a suggestion. The read limits a signed-in player hits every two
seconds (`auth_read`, `lobby_read`, `match_read`) count against the account where there is one, so eight
players behind one carrier NAT do not share an address's allowance.

`/health` (the full report: containers, versions, error text) answers only to the host, which nginx enforces
at `/api/puzzle/health`; the one under the public prefix says `{ok}` from a reading at most ten seconds old.
A request Fastify itself refused — unreadable JSON, a body over the limit — is answered with its own 4xx as
`bad_request`, not dressed up as a 500. A tier that is not one of the five is `400 bad_tier`; a `pct` that is
not a number is `400 bad_pct`; a push endpoint is stored only when it points at a push service browsers use
(`PUZZLE_PUSH_HOSTS`), since this service will make a request to it. Taking a seat holds an advisory lock on
the account (`seatLock`), so a double tap on Create cannot seat one account twice; two first sign-ins at once
land on the same row (`ON CONFLICT DO NOTHING`); a subscribe to Redis that failed at boot is asked again
when the connection comes up; an upgrade that fails on our side is answered and closed rather than left
hanging until the proxy's hour; and a connection whose ROLLBACK failed is destroyed, not returned to the pool.

### The gold ledger

Every movement of gold is a row in `gold_ledger` with a unique `idem_key`, written in the same transaction as
the balance change. `payout:ABC123` can exist once. A retried request, a double-clicked button, two API
containers racing — all of them write the second attempt into a unique-violation and change nothing.

`users.gold` is the running total; the ledger is what it is made of. The two must always agree, and every test
suite checks that before it is allowed to pass.

### What the server does not take on trust

The ledger makes sure gold is never paid twice; these make sure it is not paid for nothing.

* **A clear is believed only once it could have happened.** Whether a board was cleared is the client's word,
  and it decides the pot. `submitResult` counts a clear only once `now() - started_at`, on the server's own
  clock, is at least `boards × PUZZLE_MIN_BOARD_MS` (default 6,000: the easiest board has about 22 arrows, and
  a quarter of a second an arrow is quicker than any honest clear). Sooner, nothing is written and the answer
  is `409 too_early` with `retry_after` (seconds) and `retry_after_ms`; the client keeps the result on the
  device (`aa:v1:pendingResult`) and sends it again when told, across a reload too. Lag only makes a result
  later, so an honest player is never refused. A loss can be reported at any moment. What this does not stop is
  a bot that plays the board at a believable pace: that needs the server to rebuild the board and replay the
  moves, which is a project of its own.
* **The welcome gold is once per Google account.** Deleting an account leaves a row in `account_tombstones`
  (`019_account_tombstones.sql`): the provider and `sha256('puzzle-tombstone:' + provider + ':' + sub)`, never
  the id itself, plus the day's advertisement claims. A sign-in that makes a new account for a hash found there
  makes it with 0 gold (`gold_granted` says so), and the day's advertisement cap carries over. Sign-ins that
  would make an account and account deletions are also limited per address (`account_create`,
  `account_delete_ip`).
* **Advertisement gold needs a ticket.** `POST /ads/start` hands out one (Redis, ten minutes, one open per
  account, and `429 ad_cap` instead when the day is spent, so nobody watches for nothing); `POST /ads/reward
  {ticket}` spends it, once, and not before `PUZZLE_AD_MIN_SECONDS` (15) since it was issued (`409 too_early`
  otherwise). A claim with no ticket is `400 no_ticket`. Rewarded advertisements on the web cannot be
  verified, so this is a bound, not proof; the daily cap (`PUZZLE_AD_GOLD_PER_DAY`) is counted from
  `date_trunc('day', now(), 'UTC')`, whatever the session's time zone.

### The tour

A player's cleared boards belong to the account, not to the phone they were cleared on. Two devices sync in
whatever order they happen to be opened, so the merge has to be commutative, and it is done by the database in
one `ON CONFLICT` clause rather than read-modify-written by the service:

* a flag (`cleared`, `skipped`, `quiz`) only ever goes from false to true;
* more stars wins; at equal stars the faster time wins;
* so pushing A then B lands where B then A lands, and pushing the same thing twice changes nothing the second
  time. An old phone opened after a month uploads a worse run and moves nothing.

`users.state` carries the small things a device needs before it can draw the right tour at all — the home
country, the difficulty ladder — and the records of play that are not boards: the daily boards, the daily
training, the streaks, and what each device took off the rank. A key a device does not send is left alone. A
key it does send is merged by its own rule, never simply replaced (`combineState` in `progress.ts`, read and
written under the row's lock inside the push's transaction):

* `train` — per day, each round's best score; hints used, rounds played and the per-round counts the larger;
* `daily` — per day, the better run (more stars, then the faster time), the quiz answered if either answered it;
* `loss` — per device, the larger count (at most 256 devices: past that the largest are kept, so a new device
  still gets in and a browser long cleared makes room);
* `playStreak`, `dailyStreak` — a streak is a run of `count` days ending on `last`, so two of them are two runs
  on the calendar: if they overlap or meet they are one run, earlier start to later end; with a gap between
  them the later run stands. A day after the UTC date plus one is a clock that runs ahead and is refused (and
  the client never keeps or adopts a streak that ends after its own today);
* anything else (home, the difficulty ladder) — the last device to say it.

Every one of those is commutative and idempotent, like the boards. It used to be a one-level merge
(`state || incoming`), which replaced the whole `train` map, the whole `daily` map and the streaks with the
pushing device's copy and handed that copy straight back, so the phone and the website each saw only their own
training and their own streak. Nothing is dropped for being old -- the rank adds up the arrows of every daily
board ever cleared and a round's goal counts every day it was played -- so the account keeps the newest 1000
days of each (`STATE_KEEP_DAYS`), which is years of play. A device sends its last 120 (`STATE_SEND_DAYS`), so a
push stays about 30 KB of state however long somebody has played, and 400 after any gap longer than that
(signed out for months, a stretch of failed pushes), so what it played meanwhile still arrives. The tour sync
alone may send 256 KB (`PROGRESS_BODY_LIMIT`, on its own route: a whole tour of 600 boards with its counts is
about 115 KB; every other route keeps 64 KB), its state up to 128 KB; each record is cleaned field by field, the
other settings are kept only while small. The row is locked `FOR NO KEY UPDATE`, not `FOR UPDATE`: the push's
own inserts hold KEY SHARE locks on it through their foreign key, and `FOR UPDATE` deadlocked two devices
pushing at once (the api suite has the six-at-once case). On the device, a setting changed while its push was in
the air stays; the next push says it.

The client keeps playing out of its own storage and syncs around it: a push that fails costs freshness, not
progress. That is also why a failure here goes unseen, so it is worth knowing the one that happened: the tier
check on `progress` said 0..3 after the ladder grew a fifth step, Master (4), and every push carrying a Master
board failed whole, from that device, every time, until `018_master_tier.sql` widened it. Nothing was lost —
each device had kept everything — and the next push after the fix brought it all.

A push keeps only ids that could be boards of the game (`levelIdOk`): a country from the file the server deals
from (`PUZZLE_BOARDS_FILE`), or `d:<country>`, `f:<id>`, `n:<id>` and `s:<id>` with an optional `~<lap>`,
checked by shape so a board the client ships first is never refused. An account holds at most 5,000 boards
(`MAX_LEVEL_ROWS`; boards it has keep merging, new ones past the line are dropped), counts from at most 16
devices (`MAX_STAT_DEVICES`; a new one replaces the one quietest longest), counts up to 10,000 a board and an
hour a clear, 60 training puzzles per round per day (`MAX_SERIALS`), and a merged blob of at most 512 KB
(`MAX_BLOB_BYTES`, the oldest days going first). Without those, every push could add 600 invented rows, and
the answer to every push, all of them, could be grown until it ran the server out of memory.

One rule lives in the client rather than the server, and only because the server cannot know it: a home
country **guessed** from the connection is not the player's answer, so it never travels. Only one chosen in
Settings does.

### Which boards are hard

Every device counts what each tour board costs it — started, cleared, hearts run out, and the hints, hearts
and seconds a clear took — on the phone, signed in or not, online or not, and posts the totals with the tour
sync (`stats` and `device` on `POST /progress`). `level_stats` keeps a row per account and device, so two
phones add up, and every count only grows, so a repeated post changes nothing. The `level_difficulty` view
answers the question per board, anonymously: `GET /boards/difficulty` serves it (never fewer than three
players behind a line, whatever `?min=` asks, and worked out at most every five minutes), the `stats` mode of
puzzle-ops prints it on the VPS, and `games/puzzle/tools/hardest.py` prints it with the countries' names and
a score (fail rate, plus a tenth of a point per hint and per heart an average clear costs). The pace a result
card shows (`/boards/pace`) counts only clears of at least 150 ms an arrow.

### The league

Every week the gold won at the gold tables is counted and the ten best are paid. Tenth place takes the base
prize and every place above it doubles it, so with the defaults (`PUZZLE_LEAGUE_BASE_GOLD` 10,000 and
`PUZZLE_LEAGUE_RANKS` 10): 10th 10K, 9th 20K, 8th 40K … 1st 5.12M, and the whole ladder comes to 10.23M
gold a week.

Three decisions hold it up:

* **Earning is net.** A week's earning is every movement of gold a table caused — stakes paid, pots won,
  refunds — added up. Counting gross winnings instead would reward two accounts passing the same gold back and
  forth, because each pass would add to a total out of nothing; netting makes that pointless, since the pair
  together always nets zero. Signup gold, admin corrections and last week's prize are excluded, so a prize
  never feeds the next league. A week you lost on is a negative number and no placing at all.
* **A win counts against the people who paid for it.** Netting stops a pair gaining together, but the table
  ranks people one at a time, and each Google account brings gold of its own to lose. So in each match a
  winner's gain is shared over the losers in proportion to what each lost, netted per pair of players over the
  week, with no cap per opponent (a win counts as much as the loss it came from; the old 100,000 cap is gone),
  and gold whose loser has deleted their account (and with it their stake) is nobody's. A prize needs
  `PUZZLE_LEAGUE_MIN_OPPONENTS` (3) different people played at started tables in the week; those lines rank
  first, so the table's ranks are the prize places, and every row says `opponents` and `eligible`. A friends'
  room counts. A match counts in the week its room was opened.
* **The standings are a query, not a counter.** `gold_ledger` already records every movement with its time, so
  any week's table can be derived whenever it is asked for, and there is no second running total to drift away
  from the balances. `standings`, `placeOf` and `settleDue` all read one function (`table`), so they cannot
  disagree; `/league` keeps it for 20 seconds (a result drops it) and writes nothing — the season's row is the
  league timer's to make.
* **A season is paid once.** The `league_seasons` row is taken with `FOR UPDATE SKIP LOCKED`, every prize is a
  gold movement keyed `league:<season>:<user>`, and `settled_at` is stamped in the same transaction. Two
  containers sweeping together, a restart mid-settlement or a plain retry all end with one payment. The
  finished table is then frozen into `league_prizes`, names included, so a player deleting their account the
  day after does not change what last week said.

Seasons are counted from a fixed Monday, so a restart cannot produce a half-length week, and a service that was
off for a fortnight comes back, fills in the weeks it missed and settles them oldest first.

**On the size of the prizes.** The tables run 500, 1K, 10K, 1M and 10M, so the biggest pot is seven seats at
10M — 70M gold to the winner, against 5.12M for first place in the league. The league is a bonus on top of a
week's play rather than the main way gold enters the game, which is the right way round. If the ladder ever
needs to keep pace with the tables, `PUZZLE_LEAGUE_BASE_GOLD` moves all ten places at once, in
proportion, without a deploy of anything but the environment.

---

### Notifications

Two things are worth interrupting somebody for: an invitation, because the room it is about waits minutes,
and the league paying out, because the gold is real. Nothing else is sent. A browser gets them through Web
Push — `push_subscriptions`, and the VAPID keys the `push-keys` mode of puzzle-ops generates on the host. The
app gets them through Firebase Cloud Messaging — `push_tokens`, and a service account the `fcm-key` mode
writes into the host's `.env` as `PUZZLE_FCM_SERVICE_ACCOUNT` from a repository secret. `sendToUser` tells
every device the account has, on both; either channel left unconfigured is simply that channel off, and
`/push/key` says which are on. Dead endpoints and dead tokens delete themselves as the push service reports
them. No Firebase SDK is involved on the server: `fcm.ts` signs a JWT with the account's key and posts to
FCM's HTTP v1 endpoint.

There is one more, and it is the only one a player may decline on its own: **a nudge at seven in the
evening** (`PUZZLE_REMINDER_HOUR`), local to the device — each registers the zone it is in — to anyone with
notifications on who has not been on a board in the last few hours (`PUZZLE_REMINDER_QUIET_HOURS`). Once a
day per zone and once per player, remembered in Redis; with Redis gone the evening is skipped rather than
repeated. `POST /push/reminder {on}` is the switch, and `/auth/me` reports it.

An invitation is not limited on the asking. The answer to being asked too often is **mute**
(`POST /players/mute`, `/players/unmute`, `GET /players/muted`): a muted player's invitations reach nobody,
on any device, and they leave the muter's list of people to ask; the sender is told only what they would be
told about somebody who is not online. The invite reply says where it went — `reach` is `live` (on their
screen), `push` (their phone or browser will ring) or `none` (send the link). The mute is checked before
"are they racing", so a muted sender cannot learn that the muter is on a board; a full room answers
`room_full` at the invitation rather than at the join; and "played together" (`havePlayedTogether`,
`recentPlayers`) means a match that actually **started** — a room somebody sat in for a minute, or one the
sweeper voided, gives nobody the right to ring a phone. A phone rings **once in ten minutes per sender**, and at
most six times a day (`invring:<from>:<to>`, `invringday`), whatever room it is for — a room costs nothing to
open and leave, so "once per room" let one sender ring somebody twenty times a minute; the card on an open
screen is shown once per room a minute and five times in ten minutes per sender (`invpop`, `invpops`); with
Redis away, nothing rings and nothing pops up. "Online" means a socket open **and** the page in
front of them — the page sends `{type:'away', hidden}` on the socket when it is hidden or back
(`online.away`, three hours), and an invitation to somebody hidden rings their phone instead.

## Public URLs

```
REST       https://ariyankhan.com/api/puzzle/v1/...
WebSocket  wss://ariyankhan.com/ws/puzzle
health     http://127.0.0.1/api/puzzle/health   (host-only)
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
| POST | `/auth/handoff` | signed in here (a browser): a code the app can trade for a session, bound to the app's `nonce`; five minutes, one use |
| POST | `/auth/handoff/redeem` | `code` + `nonce` → a session (cookie, or a token for a Bearer client); limited like a sign-in, and a wrong nonce burns the code |
| POST | `/auth/name` | rename |
| POST | `/auth/logout` | end this session |
| POST | `/auth/delete` | delete the account and everything attached |
| GET | `/progress` | the whole tour this account has played |
| POST | `/progress` | push what a device has (`levels`, `state`, and the board counts as `stats` + `device`); the merged whole comes back |
| GET | `/boards/difficulty` | per board, how often it beats people and what a clear costs; anonymous, `?min=` players |
| GET | `/league` | this week's table, your place in it, the prizes, and last week's result |
| POST | `/ads/start` | a ticket for one advertisement's gold, asked for before it is shown; `429 ad_cap` when the day is spent |
| POST | `/ads/reward` | the gold, for `{ticket}`: once, and not sooner than an advertisement's length after the ticket |
| GET | `/lobby` | the tables the server seats, and how many are waiting at each |
| POST | `/matches` | open a room (`stake`, `open_to_all`, `tier`, `boards`) |
| GET | `/matches/:code` | the room as you may see it |
| POST | `/matches/:code/join` | take a seat |
| POST | `/matches/:code/start` | host starts an invite-only room |
| POST | `/matches/:code/leave` | walk out, taking your stake |
| POST | `/matches/:code/progress` | how far along you are |
| POST | `/matches/:code/result` | your run is over; a clear sooner than the board could be cleared is `409 too_early`, to be sent again after `retry_after` |
| GET | `/push/key` | whether notifications are on: the VAPID public key for a browser, and whether phones can be reached |
| POST | `/push/subscribe` | a browser's push subscription, for this account |
| POST | `/push/unsubscribe` | let it go |
| POST | `/push/token` | a phone's Firebase registration token, for this account |
| POST | `/push/token/drop` | let it go |
| POST | `/push/reminder` | whether this account wants the evening nudge |
| GET | `/players/recent` | the people you have played with, and whether they are here |
| GET | `/players/muted` | whose invitations you have muted |
| POST | `/players/mute` | mute somebody (`user_id`); they are never told |
| POST | `/players/unmute` | the way back |

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

**What a socket may ask**: ten messages a second with bursts of twenty (a message over it is dropped, and a
socket far past it is closed with 1008), six sockets per account in a process (the seventh is refused at the
upgrade with 429), `watch` only for a room that is open or playing (a finished one is answered
`{type:'closed'}`) and nothing when it is the room already watched, and a `resync` answered at most once in
two seconds, the last ask of a burst at the end of them.

### Authentication

One model, two transports. A long random opaque token, stored only as a SHA-256 hash.

* **Browser** — an HttpOnly, SameSite=Lax, Secure cookie. JavaScript never sees the token.
* **App** — the same token in the sign-in response body, sent back as `Authorization: Bearer <token>`. Send
  `{"client":"app"}` with the sign-in to get it. The WebSocket takes it as `?token=` where a header cannot be set.

No JWT. This game has one backend, so a token it can revoke the instant an account is deleted beats one it has
to wait out.

### Rate limits

Per endpoint, counted in Redis, `429` with `Retry-After` when exceeded. An address is counted as itself for
IPv4 and by its **/64** for IPv6, which one connection can pick a fresh address from for every request. If
Redis is unreachable the limiter allows the request and says so in the log (once in half a minute per limit):
a game that stops letting people in because a cache is down has turned a degraded service into an outage. The
limits marked strict guard gold, a new account or somebody's phone, and those are counted in the process
instead while Redis is away.

| Limit | Allowance | Counted by |
|---|---|---|
| `auth_signin` | 10 / 5 min | IP (strict) |
| `auth_read` | 120 / min | IP |
| `auth_write` | 20 / 5 min | account |
| `account_delete` | 5 / hour | account (strict) |
| `account_delete_ip` | 5 / hour | IP (strict) |
| `account_create` | 10 / hour, sign-ins that would make an account | IP (strict) |
| `ad_start`, `ad_reward` | 20 / 10 min each | account (strict) |
| `match_invite` | 20 / min | account (strict) |
| `push_write` | 10 / min | account (strict) |
| `match_create` | 20 / min | account |
| `match_join` | 40 / min | account |
| `match_read` | 240 / min | IP |
| `match_progress` | 120 / min | account |
| `match_result` | 20 / min | account (strict) |
| `lobby_read` | 120 / min | IP |
| `league_read` | 90 / min | IP |
| `progress_read` | 60 / min | account |
| `progress_write` | 60 / min | account |
| `ws_connect` | 60 / min | IP |

`PUZZLE_RATE_MULTIPLIER` scales all of them. Production leaves it at 1.

---

## Deploying

Every container comes from a public image on Docker Hub, and the two that need this repository's code fetch it
themselves at start — the same pattern `ariyankhan-web` already uses on this VPS. That means the whole project
can be handed to Hostinger as raw compose YAML: no registry, no credentials, nothing to bind-mount, no build
context on the server.

```bash
cd games/puzzle/deploy
cp .env.example .env          # fill in the two passwords and GOOGLE_CLIENT_ID
mkdir -p /var/backups/puzzle

docker compose up -d
docker compose ps             # all four healthy — the API's first start builds, so give it a minute or two
docker compose logs -f puzzle-api
curl -s localhost:8760/health
```

**The faster alternative, now that the image exists.** `.github/workflows/puzzle-api.yml` runs every suite
against real PostgreSQL and Redis service containers on each push and pull request, and on a push to `main` it
builds the image and publishes it to `ghcr.io`. Switching to it is three things: set `PUZZLE_IMAGE` in
`.env`, replace the API service's `image:` line with `image: ${PUZZLE_IMAGE}`, and delete its `command:`
block. A deploy then becomes `docker compose pull` rather than a two-to-four minute build on a 2-vCPU box at
every restart. Production still fetches and builds, because that is what it was cut over with and it works;
this is the next thing to change, not an urgent one.

**Or from GitHub, without a shell on the server.** `.github/workflows/puzzle-ops.yml` is dispatch-only and
has five modes: `inspect` and `health` read, `backup-verify` takes one dump and restores it into a scratch
database, `cleanup` deletes legacy artifacts, and `deploy` installs the nginx snippet from the checkout (after
`nginx -t` accepts it, keeping the previous one) and restarts the two containers that re-fetch this repository.
`cleanup` and `deploy` each refuse to run without their confirmation word. Nothing in it names a container,
path or volume outside Arrow Atlas and the portfolio's own web container.

nginx, once:

```bash
mkdir -p /etc/nginx/snippets
cp games/puzzle/deploy/nginx-puzzle.conf     /etc/nginx/snippets/arrow-atlas.conf
cp games/puzzle/deploy/nginx-puzzle-map.conf /etc/nginx/conf.d/arrow-atlas-map.conf
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

`puzzle-backup` runs `backup.sh` from the repository checkout that `puzzle-api` fetches, mounted
read-only from the `puzzle-site` volume. That is how it gets the script without a network of its own: it
sits only on the internal network, and `postgres:16-alpine` ships no `curl`. On a first deploy it waits for the
checkout to appear, which takes seconds, and logs while it waits.

It takes a backup on boot and then daily at `PUZZLE_BACKUP_AT_HOUR` UTC. Each dump is written
with `pg_dump -Fc`, **read back with `pg_restore --list` before it is accepted** — by name, so a dump missing
`users`, `sessions`, `matches`, `match_players` or `gold_ledger` is refused and says which — and copied to
`/var/backups/puzzle` on the host so losing the Docker volume does not lose the history. Dumps older than
`PUZZLE_BACKUP_KEEP_DAYS` are removed. The container's healthcheck goes red if the newest dump is more
than a day old, so a backup that has quietly stopped shows up as an unhealthy container.

```bash
docker exec puzzle-backup sh -c 'sh $PUZZLE_SCRIPTS_DIR/backup.sh list'   # what we have
docker exec puzzle-backup sh -c 'sh $PUZZLE_SCRIPTS_DIR/backup.sh once'   # take one now
```

### Restoring

```bash
# Prove a dump is restorable, without touching the game. Run this occasionally.
docker exec puzzle-backup sh -c 'sh $PUZZLE_SCRIPTS_DIR/restore.sh verify /backups/puzzle-20260917T030000Z.dump'

# Restore into a database you name, to look at it.
docker exec puzzle-backup sh -c 'sh $PUZZLE_SCRIPTS_DIR/restore.sh into /backups/....dump puzzle_yesterday'

# Replace the live database. Saves the current one first, to /backups/pre-restore-<stamp>.dump.
docker compose stop puzzle-api
docker exec -e CONFIRM=yes puzzle-backup sh -c 'sh $PUZZLE_SCRIPTS_DIR/restore.sh live /backups/....dump'
docker compose start puzzle-api
```

`verify` restores into a scratch database, counts the rows, checks that the ledger reconciles, and drops the
scratch database again. It is the only way to know a backup works.

---

## Rolling back

**The API misbehaves, the data is fine** — the fastest fix, and the usual one:

```bash
cd games/puzzle/deploy
PUZZLE_IMAGE=ghcr.io/byariyankhan/puzzle-api:<previous-sha> docker compose up -d puzzle-api
```

**The data is wrong** — restore the newest good dump, as above.

**The routing is wrong** — `deploy` keeps the snippet it replaced as
`/var/backups/puzzle/arrow-atlas.conf.before-<stamp>` (the snippet keeps its installed filename), and it puts that file back itself if `nginx -t`
refuses the new one. By hand it is a `cp` and a reload.

There is no going back to the PHP service. It was deleted, with its SQLite file and the importer, once a
PostgreSQL dump had been taken and proved restorable — and the accounts and gold created since the cutover
exist only in PostgreSQL anyway, so that route stopped being a rollback the moment somebody played a match.
The rollback that matters is the one above: a dump, verified, restored.

---

## Moving Arrow Atlas to its own VPS and domain

The work this whole layout exists to make short:

1. **Deploy the same project.** Copy `games/puzzle/` to the new server, `cp .env.example .env`, fill in
   fresh passwords, `docker compose up -d`. The image comes from ghcr; nothing is built on the server.
2. **Carry the data across.** On the old server `backup.sh once`, copy the dump over, and on the new
   one `restore.sh live <dump>`. Verify it first with `restore.sh verify`.
3. **Persistent assets.** There are none beyond PostgreSQL: profile pictures are Google URLs, and boards are
   baked into the image.
4. **Point the client at it.** Two meta tags in `puzzle/index.html`:
   ```html
   <meta name="puzzle-api" content="https://api.arrowatlas.com" />
   <meta name="puzzle-ws"  content="wss://api.example.com" />
   ```
   and set `PUZZLE_ALLOWED_ORIGINS` to the origins the page is served from, so the browser may send
   credentials cross-origin. No JavaScript changes.
5. **nginx and DNS.** Include the same `nginx-puzzle.conf` in the new server block — the file does not
   change — point DNS at the new server, and get a certificate.
6. **Verify**, then remove the include from `ariyankhan.conf`.

What makes this short is what is *not* in the way: no shared database, no shared Redis keyspace, no shared
volumes, no other game's tables, and a client that never hardcoded a hostname.

---

## Working on it

```bash
cd games/puzzle/backend
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

Raise `PUZZLE_RATE_MULTIPLIER` when load testing, or you will be measuring the rate limiter. The runner
says so if more than a hundredth of its requests failed, which is how that mistake gets caught.

## Devices with no account (September 2026)

`push_tokens.user_id` and `push_subscriptions.user_id` are nullable since `017_anon_push.sql`, and both
tables carry `reminder`. A signed-out device posts its token or subscription like a signed-in one (the
`/push/*` routes take a stranger, limited by address); the row stands with no user and the device's own
nudge answer. The evening sweep (`reminder.ts`, `deviceTargets`) reaches those rows by time zone, using
`seen_at` (refreshed on every open) for the quiet hours an account gets from `last_played_at`, and sends
`dailyNote('')`, which carries no name. Invitations and the league still go by user only. The same token
posted after a sign-in takes the account (the upsert), and `/push/reminder` with no session takes a
`token` or `endpoint` and flips that row's own switch; signed in, it still flips `users.reminder`.
