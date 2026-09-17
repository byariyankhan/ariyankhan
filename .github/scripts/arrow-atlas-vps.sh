#!/usr/bin/env bash
# Runs on the VPS, piped in over SSH by .github/workflows/arrow-atlas-ops.yml. See that file for the modes.
#
# Two rules hold everywhere below:
#
#   * Nothing addresses a container, path or volume that is not Arrow Atlas's or the portfolio's own web
#     container. ASR and Bookween are never named, so no command here can reach them.
#   * No secret is printed. The PostgreSQL password is read inside the container from its own environment
#     and handed to psql through PGPASSWORD, which never appears in a log line.
#
# `set -e` is deliberately absent: the read-only modes run every check and add up the failures themselves,
# which is more useful than stopping at the first one. The destructive modes check their own preconditions.
set -uo pipefail

MODE="${MODE:-inspect}"
DOMAIN="${DOMAIN:-ariyankhan.com}"
SNIPPET_B64="${SNIPPET_B64:-}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
AA_CONTAINERS="arrow-atlas-api arrow-atlas-postgres arrow-atlas-redis arrow-atlas-backup"
HOST_BACKUPS=/var/backups/arrow-atlas
fail=0

SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO=sudo

say()  { printf '\n== %s\n' "$*"; }
ok()   { printf 'PASS  %s\n' "$*"; }
bad()  { printf 'FAIL  %s\n' "$*"; fail=1; }
note() { printf '      %s\n' "$*"; }
gone() { printf 'GONE  %s\n' "$*"; }
kept() { printf 'KEPT  %s\n' "$*"; }

have() { docker inspect "$1" >/dev/null 2>&1; }
running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ]; }

# One SQL statement, answered without the password ever leaving the container.
psqlc() {
  docker exec arrow-atlas-postgres sh -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$0"' "$1"
}

# backup.sh / restore.sh live in the checkout that arrow-atlas-api fetched, mounted read-only into the
# backup container. This is the same call the README documents.
aabackup() { docker exec arrow-atlas-backup sh -c "sh \$ARROW_ATLAS_SCRIPTS_DIR/$1" ; }

newest_dump() {
  docker exec arrow-atlas-backup sh -c \
    'ls -1t /backups/arrow-atlas-*.dump 2>/dev/null | head -1'
}

# ─────────────────────────────────────────────────────────────────────── shared reports

report_containers() {
  say "containers"
  for c in $AA_CONTAINERS ariyankhan-web; do
    if have "$c"; then
      printf '  %-22s %s\n' "$c" "$(docker inspect -f '{{.State.Status}}{{if .State.Health}} ({{.State.Health.Status}}){{end}}' "$c")"
    else
      printf '  %-22s absent\n' "$c"
    fi
  done
}

report_data() {
  say "what PostgreSQL actually holds"
  if ! running arrow-atlas-postgres; then bad "arrow-atlas-postgres is not running"; return; fi
  psqlc "select 'users        ' || count(*) from users
         union all select 'sessions     ' || count(*) from sessions
         union all select 'matches      ' || count(*) from matches
         union all select 'match_players' || count(*) from match_players
         union all select 'gold_ledger  ' || count(*) from gold_ledger" | sed 's/^/  /' \
    || bad "could not read the row counts"

  echo
  note "gold in circulation: $(psqlc 'select coalesce(sum(gold),0) from users')"
  note "oldest account:      $(psqlc 'select coalesce(min(created_at)::text,'"'"'none'"'"') from users')"
  note "newest account:      $(psqlc 'select coalesce(max(created_at)::text,'"'"'none'"'"') from users')"
  note "matches settled:     $(psqlc 'select count(*) from matches where paid_at is not null')"

  drift=$(psqlc "select count(*) from (
            select u.id from users u left join gold_ledger g on g.user_id = u.id
            group by u.id, u.gold having coalesce(sum(g.delta),0) <> u.gold) d")
  if [ "$drift" = "0" ]; then ok "every balance matches its ledger"
  else bad "$drift account(s) disagree with the ledger"; fi
}

report_legacy() {
  say "legacy SQLite and PHP artifacts"

  if have ariyankhan-web; then
    out=$(docker exec ariyankhan-web sh -c 'ls -la /var/lib/arrow-atlas 2>/dev/null' || true)
    if printf '%s' "$out" | grep -q 'sqlite'; then
      printf '%s\n' "$out" | grep 'sqlite' | sed 's/^/  present  ariyankhan-web:\/var\/lib\/arrow-atlas\/  /'
    else
      note "ariyankhan-web:/var/lib/arrow-atlas/ holds no SQLite file"
    fi
    if docker exec ariyankhan-web sh -c 'test -d /var/www/html/games/api' 2>/dev/null; then
      note "present  ariyankhan-web:/var/www/html/games/api  ($(docker exec ariyankhan-web sh -c 'ls /var/www/html/games/api' | tr '\n' ' '))"
    else
      note "the live web root no longer carries games/api"
    fi
  fi

  echo
  note "host $HOST_BACKUPS:"
  $SUDO ls -la "$HOST_BACKUPS" 2>/dev/null | sed 's/^/    /' || note "    (no such directory)"

  echo
  note "legacy copies left in /tmp:"
  $SUDO ls -la /tmp 2>/dev/null | grep -iE 'sqlite|legacy' | sed 's/^/    host  /' || note "    host: none"
  for c in arrow-atlas-api ariyankhan-web; do
    have "$c" || continue
    docker exec "$c" sh -c 'ls -la /tmp 2>/dev/null' 2>/dev/null | grep -iE 'sqlite|legacy' \
      | sed "s/^/    $c  /" || note "    $c: none"
  done

  echo
  note "volumes that still exist:"
  docker volume ls --format '{{.Name}}' | grep -iE 'aa-data|arrow' | sed 's/^/    /' || note "    none"
}

report_nginx() {
  say "nginx"
  for f in /etc/nginx/snippets/arrow-atlas.conf /etc/nginx/conf.d/arrow-atlas-map.conf /etc/nginx/sites-available/ariyankhan.conf; do
    if $SUDO test -f "$f"; then
      printf '  %-52s %s bytes\n' "$f" "$($SUDO stat -c %s "$f")"
    else
      printf '  %-52s missing\n' "$f"
    fi
  done

  echo
  if $SUDO grep -qs 'games/api' /etc/nginx/snippets/arrow-atlas.conf; then
    note "the snippet still proxies /games/api/ (the compatibility route)"
  else
    note "the snippet has no /games/api/ route"
  fi

  echo
  note "pre-cutover config backups (only Arrow Atlas's and the portfolio's own):"
  $SUDO find /etc/nginx -maxdepth 3 \
    \( -name 'ariyankhan.conf.*' -o -name 'arrow-atlas*.conf.*' -o -name '*pre-cutover*' -o -name '*pre-arrow*' \) \
    -printf '    %p  %s bytes  %TY-%Tm-%Td\n' 2>/dev/null || true
  $SUDO ls -la "$HOST_BACKUPS"/nginx-* 2>/dev/null | sed 's/^/    /' || true

  echo
  $SUDO nginx -t 2>&1 | sed 's/^/  /'
}

report_backups() {
  say "the PostgreSQL backup system"
  if ! running arrow-atlas-backup; then bad "arrow-atlas-backup is not running"; return; fi
  aabackup 'backup.sh list' | sed 's/^/  /' || bad "backup.sh list failed"
  d=$(newest_dump)
  if [ -n "$d" ]; then ok "newest dump: $d"; else bad "there is no dump at all"; fi
  echo
  note "and the copies kept on the host, outside Docker:"
  $SUDO ls -la "$HOST_BACKUPS"/*.dump 2>/dev/null | sed 's/^/    /' || note "    none on the host yet"
}

# ─────────────────────────────────────────────────────────────────────── modes

mode_inspect() {
  echo "Arrow Atlas — inspect  ($(hostname), $(date -u))"
  report_containers
  report_data
  report_legacy
  report_nginx
  report_backups

  say "how the portfolio container is defined"
  if have ariyankhan-web; then
    wd=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' ariyankhan-web 2>/dev/null)
    note "compose working_dir: ${wd:-<none: not started by compose>}"
    [ -n "$wd" ] && { $SUDO ls -la "$wd" 2>/dev/null | sed 's/^/    /' || true; }
    note "mounts:"
    docker inspect -f '{{range .Mounts}}    {{.Type}} {{.Name}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' ariyankhan-web
  fi

  say "and the Arrow Atlas project"
  wd=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' arrow-atlas-api 2>/dev/null)
  note "compose working_dir: ${wd:-<none>}"
  [ -n "$wd" ] && { $SUDO ls -la "$wd" 2>/dev/null | sed 's/^/    /' || true; }
}

mode_backup_verify() {
  echo "Arrow Atlas — one fresh backup, then prove it restores  ($(date -u))"
  running arrow-atlas-postgres || { bad "PostgreSQL is not running; not taking a backup of nothing"; return; }
  running arrow-atlas-backup   || { bad "the backup container is not running"; return; }

  report_data

  say "the counts this dump has to come back with"
  before=$(psqlc "select count(*) || ' ' || coalesce(sum(gold),0) from users")
  note "users and gold before: $before"

  say "taking one now"
  aabackup 'backup.sh once' 2>&1 | sed 's/^/  /' || { bad "the backup itself failed"; return; }

  d=$(newest_dump)
  [ -n "$d" ] || { bad "no dump appeared"; return; }
  ok "took $d"
  note "size: $(docker exec arrow-atlas-backup sh -c "stat -c %s '$d'") bytes"

  say "restoring it into a scratch database and reading it back"
  # `verify` restores into a scratch database, counts every core table, reconciles the ledger inside the
  # restored copy, and drops the scratch database again. It is the only check that means anything.
  if docker exec arrow-atlas-backup sh -c "sh \$ARROW_ATLAS_SCRIPTS_DIR/restore.sh verify '$d'" 2>&1 | sed 's/^/  /'; then
    ok "the dump restores and the restored copy reconciles"
  else
    bad "the restore verification failed — nothing may be deleted"
  fi

  say "and it is on the host too, not only in the volume"
  base=$(basename "$d")
  if $SUDO test -f "$HOST_BACKUPS/$base"; then ok "$HOST_BACKUPS/$base"
  else bad "$base was not copied to $HOST_BACKUPS"; fi

  after=$(psqlc "select count(*) || ' ' || coalesce(sum(gold),0) from users")
  [ "$before" = "$after" ] && ok "the live database was not touched ($after)" || bad "the live database changed: $before -> $after"
}

mode_cleanup() {
  echo "Arrow Atlas — deleting the legacy artifacts, and only those  ($(date -u))"

  # The gate, again, here: a verified dump must exist before anything is deleted. backup-verify is a
  # separate run and this cannot see its result, so it re-establishes the fact rather than assuming it.
  say "the gate: there must be a dump that restores"
  running arrow-atlas-backup || { bad "the backup container is not running; refusing to delete anything"; return; }
  d=$(newest_dump)
  [ -n "$d" ] || { bad "there is no PostgreSQL dump; refusing to delete anything"; return; }
  note "checking $d"
  if docker exec arrow-atlas-backup sh -c "sh \$ARROW_ATLAS_SCRIPTS_DIR/restore.sh verify '$d'" >/tmp/aa-verify.log 2>&1; then
    ok "$d restores and reconciles"
    tail -6 /tmp/aa-verify.log | sed 's/^/      /'
  else
    bad "that dump does not verify; refusing to delete anything"
    tail -20 /tmp/aa-verify.log | sed 's/^/      /'
    return
  fi

  say "1. the old SQLite database, out of the portfolio container"
  if have ariyankhan-web; then
    docker exec ariyankhan-web sh -c 'ls -1 /var/lib/arrow-atlas/ 2>/dev/null' | sed 's/^/      was: /' || true
    docker exec ariyankhan-web sh -c 'rm -f /var/lib/arrow-atlas/arrow-atlas.sqlite /var/lib/arrow-atlas/arrow-atlas.sqlite-wal /var/lib/arrow-atlas/arrow-atlas.sqlite-shm' \
      && gone "ariyankhan-web:/var/lib/arrow-atlas/arrow-atlas.sqlite (and its -wal/-shm)" \
      || bad "could not remove the SQLite file"
    docker exec ariyankhan-web sh -c 'ls -la /var/lib/arrow-atlas/ 2>/dev/null' | sed 's/^/      now: /' || true
  else
    note "ariyankhan-web is not here; nothing to do"
  fi

  say "2. the legacy PHP API out of the live web root"
  # The next re-fetch would drop it anyway, since main no longer carries games/api — this makes it true now.
  if have ariyankhan-web && docker exec ariyankhan-web sh -c 'test -d /var/www/html/games/api' 2>/dev/null; then
    docker exec ariyankhan-web sh -c 'rm -rf /var/www/html/games/api' \
      && gone "ariyankhan-web:/var/www/html/games/api" || bad "could not remove games/api"
  else
    note "already gone"
  fi

  say "3. the pre-migration SQLite backups on the host"
  n=0
  for f in "$HOST_BACKUPS"/pre-migration-*.sqlite "$HOST_BACKUPS"/*.sqlite; do
    [ -e "$f" ] || continue
    $SUDO rm -f "$f" && { gone "$f"; n=$((n+1)); } || bad "could not remove $f"
  done
  [ "$n" = "0" ] && note "there were none left"

  say "4. the temporary copies made during the cutover"
  for f in /tmp/legacy.sqlite /tmp/arrow-atlas.sqlite /tmp/aa.sqlite /tmp/pre-migration-*.sqlite; do
    [ -e "$f" ] && { $SUDO rm -f "$f" && gone "host $f"; }
  done
  for c in arrow-atlas-api ariyankhan-web; do
    have "$c" || continue
    docker exec "$c" sh -c 'rm -f /tmp/legacy.sqlite /tmp/arrow-atlas.sqlite /tmp/aa.sqlite /tmp/pre-migration-*.sqlite' 2>/dev/null \
      && gone "$c:/tmp legacy copies"
  done

  say "5. nginx: verify what is live, keep a backup of it in its final form, then drop the pre-cutover one"
  if ! $SUDO nginx -t >/tmp/aa-nginx.log 2>&1; then
    bad "the live nginx config does not pass nginx -t; not touching any nginx backup"
    sed 's/^/      /' /tmp/aa-nginx.log
  else
    ok "nginx -t accepts the live config"
    $SUDO mkdir -p "$HOST_BACKUPS"
    FINAL="$HOST_BACKUPS/nginx-final-$STAMP.tar.gz"
    $SUDO tar -czf "$FINAL" \
        -C / \
        etc/nginx/nginx.conf \
        etc/nginx/sites-available/ariyankhan.conf \
        $( $SUDO test -f /etc/nginx/snippets/arrow-atlas.conf && echo etc/nginx/snippets/arrow-atlas.conf ) \
        $( $SUDO test -f /etc/nginx/conf.d/arrow-atlas-map.conf && echo etc/nginx/conf.d/arrow-atlas-map.conf ) \
      && { kept "$FINAL  ($($SUDO stat -c %s "$FINAL") bytes) — the config as it stands now"
           $SUDO tar -tzf "$FINAL" | sed 's/^/        /'; } \
      || { bad "could not write the final-form nginx backup; keeping the old one"; return; }

    # Only now, and only files whose names are Arrow Atlas's or the portfolio's own. ASR and Bookween keep
    # every file they have: no pattern here can match one.
    n=0
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      $SUDO rm -f "$f" && { gone "$f"; n=$((n+1)); }
    done <<EOF
$($SUDO find /etc/nginx -maxdepth 3 \( -name 'ariyankhan.conf.*' -o -name 'arrow-atlas*.conf.*' -o -name '*ariyankhan*pre-cutover*' -o -name '*ariyankhan*pre-arrow*' -o -name 'ariyankhan.conf.bak' \) 2>/dev/null)
EOF
    [ "$n" = "0" ] && note "there was no pre-cutover nginx backup left to remove"
  fi

  say "6. what was deliberately left alone"
  kept "PostgreSQL, Redis, the Node API, the WebSocket route, the volumes and .env"
  kept "the PostgreSQL dumps and the backup/restore tooling"
  kept "$HOST_BACKUPS/*.dump"
  kept "ASR and Bookween — no command in this script names them"

  report_legacy
}

mode_deploy() {
  echo "Arrow Atlas — deploy  ($(date -u))"

  say "1. the nginx snippet from the repository"
  [ -n "$SNIPPET_B64" ] || { bad "no snippet was sent"; return; }
  printf '%s' "$SNIPPET_B64" | base64 -d > /tmp/arrow-atlas.conf.new || { bad "could not decode the snippet"; return; }
  note "$(wc -l < /tmp/arrow-atlas.conf.new) lines, $(wc -c < /tmp/arrow-atlas.conf.new) bytes"
  if grep -q 'games/api' /tmp/arrow-atlas.conf.new; then
    bad "the snippet still carries a /games/api/ route; that is what this deploy is supposed to remove"
    return
  fi
  ok "no /games/api/ route in it"

  if $SUDO test -f /etc/nginx/snippets/arrow-atlas.conf; then
    $SUDO cp -a /etc/nginx/snippets/arrow-atlas.conf "$HOST_BACKUPS/arrow-atlas.conf.before-$STAMP"
    kept "$HOST_BACKUPS/arrow-atlas.conf.before-$STAMP  (the way back, if the new one misbehaves)"
  fi
  $SUDO install -m 644 /tmp/arrow-atlas.conf.new /etc/nginx/snippets/arrow-atlas.conf || { bad "could not install it"; return; }
  if $SUDO nginx -t 2>&1 | sed 's/^/      /'; then
    $SUDO systemctl reload nginx && ok "nginx reloaded with the new snippet"
  else
    bad "nginx -t refused the new snippet; putting the old one back"
    $SUDO cp -a "$HOST_BACKUPS/arrow-atlas.conf.before-$STAMP" /etc/nginx/snippets/arrow-atlas.conf
    $SUDO nginx -t && $SUDO systemctl reload nginx
    return
  fi

  say "2. the API re-fetches the repository when it restarts"
  docker restart arrow-atlas-api >/dev/null && ok "restarting" || { bad "could not restart arrow-atlas-api"; return; }
  note "its first start after a fetch builds TypeScript, which takes a couple of minutes on 2 vCPU"
  for i in $(seq 1 60); do
    h=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' arrow-atlas-api 2>/dev/null)
    [ "$h" = "healthy" ] && break
    sleep 10
  done
  [ "$h" = "healthy" ] && ok "arrow-atlas-api is healthy again" || bad "arrow-atlas-api is $h after ten minutes"
  docker logs --tail 15 arrow-atlas-api 2>&1 | sed 's/^/      /'

  say "3. and the portfolio re-fetches main, which is what ships the client"
  if have ariyankhan-web; then
    docker restart ariyankhan-web >/dev/null && ok "restarting ariyankhan-web" || bad "could not restart it"
    for i in $(seq 1 30); do
      h=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' ariyankhan-web 2>/dev/null)
      [ "$h" = "healthy" ] && break
      sleep 5
    done
    [ "$h" = "healthy" ] && ok "ariyankhan-web is healthy" || bad "ariyankhan-web is $h"
  fi
}

mode_health() {
  echo "Arrow Atlas — health  ($(hostname), $(date -u))"
  R=(--resolve "$DOMAIN:443:127.0.0.1")

  say "the four containers"
  for c in $AA_CONTAINERS; do
    s=$(docker inspect -f '{{.State.Status}}{{if .State.Health}}/{{.State.Health.Status}}{{end}}' "$c" 2>/dev/null || echo absent)
    case "$s" in
      running/healthy|running) ok "$(printf '%-22s %s' "$c" "$s")" ;;
      *)                       bad "$(printf '%-22s %s' "$c" "$s")" ;;
    esac
  done

  say "the API, from the host"
  curl -sS -m 15 localhost:8760/health | head -c 400 | sed 's/^/  /' ; echo

  say "through nginx, over the real TLS name"
  hc() {
    label="$1"; want="$2"; url="$3"; shift 3
    code=$(curl -sS -m 20 -o /tmp/aa-body -w '%{http_code}' "${R[@]}" "$@" "$url" 2>/dev/null || echo 000)
    if [ "$code" = "$want" ]; then ok "$(printf '%-46s %s' "$label" "$code")"
    else bad "$(printf '%-46s %s (want %s)' "$label" "$code" "$want")"; head -c 200 /tmp/aa-body | sed 's/^/        /'; echo; fi
  }
  hc "home page"                  200 "https://$DOMAIN/"
  hc "the Arrow Atlas page"       200 "https://$DOMAIN/arrow-atlas.html"
  hc "the client itself"          200 "https://$DOMAIN/js/arrow-atlas.js"
  hc "v1 auth/me"                 200 "https://$DOMAIN/api/arrow-atlas/v1/auth/me"
  hc "v1 lobby"                   200 "https://$DOMAIN/api/arrow-atlas/v1/match/lobby"
  hc "the legacy PHP path is gone" 404 "https://$DOMAIN/games/api/auth.php?a=me"
  hc "and so is the PHP file"     404 "https://$DOMAIN/games/api/match.php"
  hc "other PHP still runs"       405 "https://$DOMAIN/send-mail.php"
  hc "health is not public"       403 "https://$DOMAIN/api/arrow-atlas/health"

  say "the client the page actually asks for"
  curl -sS -m 20 "${R[@]}" "https://$DOMAIN/arrow-atlas.html" | grep -o 'js/arrow-atlas.js?v=[0-9]*' | head -1 | sed 's/^/  /'

  say "the WebSocket route"
  # A handshake without a session must be refused with 401, not 404: 404 would mean nginx has no route.
  code=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' "${R[@]}" \
      -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
      -H 'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==' \
      "https://$DOMAIN/ws/arrow-atlas" 2>/dev/null || echo 000)
  case "$code" in
    401) ok "the route is there and refuses an unauthenticated handshake (401)" ;;
    404) bad "404 — nginx has no /ws/arrow-atlas route" ;;
    *)   note "handshake answered $code" ;;
  esac

  report_data
  report_backups

  say "nothing legacy is left"
  if have ariyankhan-web; then
    if docker exec ariyankhan-web sh -c 'ls /var/lib/arrow-atlas/*.sqlite* >/dev/null 2>&1'; then
      bad "a SQLite file is still in the portfolio container"
    else ok "no SQLite file in the portfolio container"; fi
    if docker exec ariyankhan-web sh -c 'test -d /var/www/html/games/api' 2>/dev/null; then
      bad "the legacy PHP API is still in the web root"
    else ok "no legacy PHP API in the web root"; fi
  fi
  if $SUDO ls "$HOST_BACKUPS"/*.sqlite >/dev/null 2>&1; then bad "a pre-migration SQLite backup is still on the host"
  else ok "no SQLite backup left on the host"; fi
  if $SUDO grep -qs 'games/api' /etc/nginx/snippets/arrow-atlas.conf; then bad "nginx still proxies /games/api/"
  else ok "nginx has no /games/api/ route"; fi
  if docker exec arrow-atlas-api sh -c 'ls /srv/arrow-atlas/site/games/arrow-atlas/backend/dist/import-sqlite.js' >/dev/null 2>&1; then
    bad "the SQLite importer is still in the deployed build"
  else ok "the SQLite importer is not in the deployed build"; fi

  report_nginx
}

case "$MODE" in
  inspect)       mode_inspect ;;
  backup-verify) mode_backup_verify ;;
  cleanup)       mode_cleanup ;;
  deploy)        mode_deploy ;;
  health)        mode_health ;;
  *) echo "::error::unknown mode: $MODE"; exit 2 ;;
esac

echo
if [ "$fail" = "0" ]; then echo "── $MODE: everything checked out"; else echo "── $MODE: something above failed"; fi
exit "$fail"
