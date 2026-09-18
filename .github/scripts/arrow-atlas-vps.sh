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

  # Where the rows came from. An account or a match stamped before the cutover can only be in PostgreSQL
  # because the importer carried it over — this instance was created on the day of the cutover, so a row older
  # than that is the migration's own evidence, and it is worth reading before anything SQLite is deleted.
  note "oldest match:        $(psqlc 'select coalesce(min(created_at)::text,'"'"'none'"'"') from matches')"
  note "account ids:         $(psqlc 'select coalesce(min(id)::text || '"'"' to '"'"' || max(id)::text, '"'"'none'"'"') from users')"
  note "and the ledger, by reason:"
  psqlc "select '  ' || reason || ' ' || count(*) || ' rows, net ' || sum(delta)
         from gold_ledger group by reason order by reason" | sed 's/^/      /'

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

  # Whether the automatic path works, asserted rather than eyeballed. The container's own healthcheck fails if
  # the newest dump is more than a day old, so a healthy backup container and a dump younger than 25 hours are
  # the same guarantee said twice — and neither of them is satisfied by a backup somebody took by hand once.
  h=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' arrow-atlas-backup 2>/dev/null)
  [ "$h" = "healthy" ] && ok "the backup container reports healthy, which is its own way of saying the newest dump is under a day old" \
                       || bad "the backup container is $h"
  if [ -n "$d" ]; then
    mtime=$(docker exec arrow-atlas-backup stat -c %Y "$d" 2>/dev/null)
    if [ -n "$mtime" ]; then
      age=$(( ( $(date -u +%s) - mtime ) / 60 ))
      if [ "$age" -lt 1500 ]; then ok "and it is $age minutes old, inside the 25-hour guarantee"
      else bad "the newest dump is $age minutes old, which is outside it"; fi
    else
      bad "could not read the newest dump's age"
    fi
  fi
  hour=$(docker exec arrow-atlas-backup sh -c 'echo "${ARROW_ATLAS_BACKUP_AT_HOUR:-3}"' 2>/dev/null)
  keep=$(docker exec arrow-atlas-backup sh -c 'echo "${ARROW_ATLAS_BACKUP_KEEP_DAYS:-14}"' 2>/dev/null)
  note "the schedule: daily at ${hour}:00 UTC, once more on every container start, keeping ${keep} days"
  docker exec arrow-atlas-backup sh -c 'cat /backups/last-run.json' 2>/dev/null | sed 's/^/      last recorded run: /'
  echo
  note "and the copies kept on the host, outside Docker:"
  $SUDO ls -la "$HOST_BACKUPS"/*.dump 2>/dev/null | sed 's/^/    /' || note "    none on the host yet"
}

# ─────────────────────────────────────────────────────────────────────── modes

# Why a container will not come up. inspect says what its state is; only its own log says why, and a container
# that keeps restarting has already thrown its reason away by the time anyone opens a terminal. Read-only.
# How this host can reach GitHub, if at all. Read-only, and no key material is printed: `ssh -T` answers with
# the name of whatever the key is attached to, which is what decides the question — an account key can read
# every repository, a deploy key only the one it was made for.
#
# The point is Bookween: that project is private too, and it deploys by having the VPS pull the repository
# itself over a read-only deploy key, then rebuilding from that checkout. Nothing there fetches a tarball over
# an unauthenticated URL, which is why nothing there broke when a repository went private. If this host can
# already read this repository the same way, Arrow Atlas can work exactly like it.
mode_git_access() {
  echo "Arrow Atlas — what this host can read from GitHub  ($(hostname), $(date -u))"

  say "the source directory the containers are configured from"
  SRC=/var/www/ariyankhan-src
  if $SUDO test -d "$SRC/.git"; then
    ok "$SRC is a git checkout"
    note "remote:  $($SUDO git -C "$SRC" remote get-url origin 2>/dev/null || echo 'none')"
    note "branch:  $($SUDO git -C "$SRC" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
    note "commit:  $($SUDO git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo '?')"
  elif $SUDO test -d "$SRC"; then
    note "$SRC exists but is not a git checkout"
  else
    note "$SRC is not there at all"
  fi

  say "keys this host holds (names and fingerprints only)"
  for f in /root/.ssh/id_* /root/.ssh/*deploy* /root/.ssh/*bookween* /root/.ssh/*ariyankhan*; do
    case "$f" in *.pub) continue ;; esac
    $SUDO test -f "$f" || continue
    note "$f  $($SUDO ssh-keygen -lf "$f" 2>/dev/null | awk '{print $1, $2, $4}')"
  done
  $SUDO test -f /root/.ssh/config && note "and an ssh config naming: $($SUDO grep -iE '^host ' /root/.ssh/config | tr '\n' ' ')"

  say "what GitHub says when this host connects"
  # A deploy key answers with the repository it belongs to; an account key answers with the account name.
  $SUDO ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -T git@github.com 2>&1 | sed 's/^/      /'

  say "and whether it can read this repository"
  if $SUDO git ls-remote --heads git@github.com:byariyankhan/ariyankhan.git main >/dev/null 2>&1; then
    ok "git@github.com:byariyankhan/ariyankhan.git is readable from here"
  else
    bad "this host cannot read byariyankhan/ariyankhan over SSH yet"
  fi
  if $SUDO git ls-remote --heads git@github.com:byariyankhan/bookween.git main >/dev/null 2>&1; then
    note "(it can read byariyankhan/bookween, which is how that project deploys)"
  fi
}

mode_logs() {
  echo "Arrow Atlas — what the API says about itself  ($(hostname), $(date -u))"
  report_containers
  say "arrow-atlas-api, as Docker sees it"
  docker inspect -f 'status={{.State.Status}}  restarts={{.RestartCount}}  last exit={{.State.ExitCode}}  health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
    arrow-atlas-api 2>&1 | sed 's/^/      /'
  say "the last of its log"
  docker logs --tail 150 arrow-atlas-api 2>&1 | sed 's/^/      /'
  say "and what the health probe last got back"
  docker inspect -f '{{if .State.Health}}{{range .State.Health.Log}}{{.End}} exit={{.ExitCode}} {{.Output}}
{{end}}{{end}}' arrow-atlas-api 2>&1 | tail -6 | sed 's/^/      /'
}

# Put this checkout on the VPS and start the API from it.
#
# The API fetches its own source from GitHub when it starts, which works only while the repository can be read
# without a key. It cannot: every start now answers 404, and because the old command emptied the volume before
# fetching, there was nothing left to fall back on and the container restarted forever. This sends the source
# down the connection the ops workflow already has — no token on the host, nothing secret in the repository —
# installs the compose file that came with it, and starts the API from what was sent. Needs confirm=DEPLOY.
# Make the site container survive a restart it cannot fetch through.
#
# ariyankhan-web is defined by hPanel's own copy of a compose file, and its start command empties
# /var/www/html and then fetches the branch from GitHub. While the repository cannot be read without a key
# that fetch fails — and because the emptying comes first, a restart would leave the site with no files at
# all. Nobody has to run anything for that to happen: a reboot, an out-of-memory kill or a click in hPanel is
# enough.
#
# This replaces that one command with the staging-and-swap version, and nothing else in the file: the
# environment, ports and volumes hPanel wrote are left byte for byte as they are. It refuses unless the
# command it finds is the one it expects, validates the result before applying it, and puts the backup back
# if the container does not come up healthy.
mode_web_safe_fetch() {
  echo "Arrow Atlas — make the site survive a restart  ($(hostname), $(date -u))"
  have ariyankhan-web || { bad "no ariyankhan-web container here"; return; }
  TGZ=/tmp/arrow-atlas-site.tgz
  command -v python3 >/dev/null || { bad "python3 is not on this host, and editing YAML without it is not worth the risk"; return; }

  PROJ=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' ariyankhan-web 2>/dev/null)
  SVC=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' ariyankhan-web 2>/dev/null)
  [ -n "$PROJ" ] && [ -n "$SVC" ] && $SUDO test -f "$PROJ/docker-compose.yml" \
    || { bad "cannot find the compose file behind ariyankhan-web"; return; }
  note "$PROJ/docker-compose.yml, service $SVC"

  say "1. what it runs at the moment"
  # A command block holds no secrets — it is the shell the container starts with — so it can be shown.
  $SUDO python3 - "$PROJ/docker-compose.yml" "$SVC" <<'PY' || { bad "could not read the command out of it"; return; }
import sys, io
path, svc = sys.argv[1], sys.argv[2]
lines = io.open(path, encoding='utf-8').read().split('\n')
out = []
inside = False
for i, l in enumerate(lines):
    if l.strip().startswith('command:') and inside:
        indent = len(l) - len(l.lstrip())
        out.append(l)
        for m in lines[i+1:]:
            if m.strip() and (len(m) - len(m.lstrip())) <= indent: break
            out.append(m)
        break
    if l.startswith('  ') and l.strip().endswith(':') and not l.startswith('    '):
        inside = l.strip()[:-1] == svc
print('\n'.join('      ' + o for o in out) if out else '      (no command block)')
PY

  say "2. the same file with only that command replaced"
  $SUDO cp -a "$PROJ/docker-compose.yml" "$HOST_BACKUPS/web-compose.yml.before-$STAMP" \
    && kept "$HOST_BACKUPS/web-compose.yml.before-$STAMP  (the way back)"
  if $SUDO python3 - "$PROJ/docker-compose.yml" "$SVC" <<'PY'
import sys, io
path, svc = sys.argv[1], sys.argv[2]
src = io.open(path, encoding='utf-8').read()
lines = src.split('\n')
start = end = None
inside = False
for i, l in enumerate(lines):
    if l.startswith('  ') and not l.startswith('    ') and l.strip().endswith(':'):
        inside = l.strip()[:-1] == svc
    if inside and l.strip().startswith('command:'):
        indent = len(l) - len(l.lstrip())
        start = i
        end = len(lines)
        for j in range(i + 1, len(lines)):
            m = lines[j]
            if m.strip() and (len(m) - len(m.lstrip())) <= indent:
                end = j
                break
        break
if start is None:
    print('no command block for that service', file=sys.stderr); raise SystemExit(2)
block = '\n'.join(lines[start:end])
# Only the command this was written for. Anything else has been changed by hand since, and a blind
# replacement would be a guess at what somebody meant.
if 'holding the door open' in block:
    print('already safe', file=sys.stderr); raise SystemExit(4)
for needle in ('codeload.github.com', 'web-entrypoint.sh'):
    if needle not in block:
        print('the command is not one this recognises (%s missing); leaving it alone' % needle, file=sys.stderr)
        raise SystemExit(3)
pad = ' ' * (len(lines[start]) - len(lines[start].lstrip()))
new = [
    pad + 'command:',
    pad + '  - bash',
    pad + '  - -c',
    pad + '  - |',
    pad + '    set -e',
    pad + '    # Fetched beside the site and swapped in whole. Emptying the document root first and fetching',
    pad + '    # afterwards means a bad minute at GitHub leaves nothing to serve. With GITHUB_TOKEN set the',
    pad + '    # fetch goes through the API, so a private repository works too; without one it is the public',
    pad + '    # tarball, and if that fails the files already here are served rather than deleted.',
    # Every $ the shell is meant to see is written $$: compose interpolates the single ones itself, and a
    # branch name or a token quietly turning into nothing is exactly the kind of bug that only shows up on a
    # restart nobody is watching.
    pad + '    fetch() {',
    pad + '      if [ -n "$${GITHUB_TOKEN:-}" ]; then',
    pad + '        curl -fsSL -H "Authorization: Bearer $$GITHUB_TOKEN" \\',
    pad + '          "https://api.github.com/repos/byariyankhan/ariyankhan/tarball/$$SITE_BRANCH"',
    pad + '      else',
    pad + '        curl -fsSL "https://codeload.github.com/byariyankhan/ariyankhan/tar.gz/refs/heads/$$SITE_BRANCH"',
    pad + '      fi',
    pad + '    }',
    pad + '    echo "[deploy] fetching branch $$SITE_BRANCH"',
    pad + '    rm -rf /var/www/.next-site && mkdir -p /var/www/.next-site',
    pad + '    if fetch | tar -xz --strip-components=1 -C /var/www/.next-site && [ -f /var/www/.next-site/index.html ]; then',
    pad + '      find /var/www/html -mindepth 1 -maxdepth 1 -exec rm -rf {} +',
    pad + '      (cd /var/www/.next-site && tar -cf - .) | (cd /var/www/html && tar -xf -)',
    pad + '      echo "[deploy] fetched $$(date -u)"',
    pad + '    elif [ -f /var/www/html/index.html ]; then',
    pad + '      echo "[deploy] could not fetch $$SITE_BRANCH; serving the copy already here"',
    pad + '    else',
    pad + '      # Coming up with nothing to serve is better than not coming up: a container that exits here',
    pad + '      # cannot be given the files by hand either, and that is how a site with a private repository',
    pad + '      # behind it goes from "an old copy" to "nothing at all". A holding page keeps the door open.',
    pad + '      echo "[deploy] nothing to serve yet; holding the door open"',
    pad + '      mkdir -p /var/www/html',
    pad + '      printf "%s" "<!doctype html><title>ariyankhan.com</title><p>Updating, one moment.</p>" > /var/www/html/index.html',
    pad + '    fi',
    pad + '    rm -rf /var/www/.next-site',
    pad + '    # The entrypoint is itself part of the checkout, so a container with nothing fetched has no',
    pad + '    # entrypoint to exec either — and exec-ing a missing file is how a holding page still ends in a',
    pad + '    # restart loop. Apache alone is enough to serve what is there and to answer the health check.',
    pad + '    if [ -f /var/www/html/deploy/web-entrypoint.sh ]; then',
    pad + '      exec bash /var/www/html/deploy/web-entrypoint.sh',
    pad + '    else',
    pad + '      echo "[deploy] no entrypoint in the document root; serving what is here"',
    pad + '      exec apache2-foreground',
    pad + '    fi',
]
io.open(path, 'w', encoding='utf-8').write('\n'.join(lines[:start] + new + lines[end:]))
PY
  then ok "written"
  else
    case "$?" in
      4) note "it is already the safe version; nothing to do"; return ;;
      *) bad "left the file alone"; return ;;
    esac
  fi

  say "3. does compose still understand it"
  if ( cd "$PROJ" && $SUDO docker compose config -q ) 2>/dev/null; then
    ok "the file parses and resolves"
  else
    bad "compose refused it; putting the backup back"
    $SUDO cp -a "$HOST_BACKUPS/web-compose.yml.before-$STAMP" "$PROJ/docker-compose.yml"
    return
  fi

  say "4. and the site, restarted onto it"
  # Recreating the container throws away its filesystem, and /var/www/html is part of that filesystem rather
  # than a volume — so the files that were copied into the old one are gone the moment this runs. That is why
  # the command above must come up with nothing, and why the checkout is put back in here, before anything is
  # asked of the health check.
  [ -s "$TGZ" ] || { bad "no checkout arrived; refusing to recreate a container with nothing to put in it"; return; }
  ( cd "$PROJ" && $SUDO docker compose create --force-recreate "$SVC" ) 2>&1 | sed 's/^/      /'
  running ariyankhan-web && note "it was still running; it will be started again below"
  rm -rf /tmp/aa-site && mkdir -p /tmp/aa-site
  if tar -xzf "$TGZ" -C /tmp/aa-site && [ -f /tmp/aa-site/arrow-atlas.html ]; then
    if docker cp /tmp/aa-site/. ariyankhan-web:/var/www/html 2>&1 | sed 's/^/      /'; then
      ok "the site's files are in the new container, before it starts"
    else
      bad "could not copy the site into the container"; rm -rf /tmp/aa-site; return
    fi
  else
    bad "the tarball does not hold the site"; rm -rf /tmp/aa-site; return
  fi
  rm -rf /tmp/aa-site
  ( cd "$PROJ" && $SUDO docker compose start "$SVC" ) 2>&1 | sed 's/^/      /'
  h=""
  for i in $(seq 1 30); do
    h=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' ariyankhan-web 2>/dev/null)
    [ "$h" = "healthy" ] && break
    sleep 5
  done
  live=$(curl -fsS -m 10 "https://$DOMAIN/arrow-atlas.html" 2>/dev/null | grep -o 'js/arrow-atlas\.js?v=[0-9]*' | head -1)
  if [ "$h" = "healthy" ] && [ -n "$live" ]; then
    ok "ariyankhan-web is healthy and the page still serves ($live)"
    docker logs --tail 6 ariyankhan-web 2>&1 | sed 's/^/      /'
  else
    bad "ariyankhan-web is ${h:-gone} and the page returned ${live:-nothing}; putting the backup back"
    $SUDO cp -a "$HOST_BACKUPS/web-compose.yml.before-$STAMP" "$PROJ/docker-compose.yml"
    ( cd "$PROJ" && $SUDO docker compose up -d --force-recreate "$SVC" ) >/dev/null 2>&1
    docker logs --tail 20 ariyankhan-web 2>&1 | sed 's/^/      /'
  fi
}

mode_push_source() {
  echo "Arrow Atlas — send this checkout and start the API from it  ($(hostname), $(date -u))"
  TGZ=/tmp/arrow-atlas-site.tgz
  [ -s "$TGZ" ] || { bad "no source arrived at $TGZ"; return; }
  note "$(du -h "$TGZ" | cut -f1) arrived"
  tar -tzf "$TGZ" ./games/arrow-atlas/backend/package.json >/dev/null 2>&1 \
    || { bad "that tarball is not this repository"; return; }
  ok "it carries the API's own package.json"

  say "1. into the volume the API builds from"
  if docker run --rm -v arrow-atlas-site:/site -v "$TGZ":/src.tgz:ro alpine:3.20 \
       sh -c 'find /site -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar -xzf /src.tgz -C /site'; then
    ok "the checkout is in arrow-atlas-site"
  else
    bad "could not write the volume"; return
  fi

  say "2. the compose file that came with it"
  PROJ=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' arrow-atlas-api 2>/dev/null)
  [ -n "$PROJ" ] && $SUDO test -d "$PROJ" || { bad "cannot find the project directory of arrow-atlas-api"; return; }
  note "$PROJ"
  $SUDO cp -a "$PROJ/docker-compose.yml" "$HOST_BACKUPS/docker-compose.yml.before-$STAMP" 2>/dev/null \
    && kept "$HOST_BACKUPS/docker-compose.yml.before-$STAMP  (the way back)"
  # Only this one file, and only out of the tarball just verified: the project's .env, which holds every
  # secret this deployment has, is never read, written or moved by any line here.
  tar -xzf "$TGZ" -O ./games/arrow-atlas/deploy/docker-compose.yml > /tmp/aa-compose.yml 2>/dev/null
  [ -s /tmp/aa-compose.yml ] || { bad "the tarball has no compose file"; return; }
  $SUDO install -m 644 /tmp/aa-compose.yml "$PROJ/docker-compose.yml" && ok "installed" || { bad "could not install it"; return; }
  rm -f /tmp/aa-compose.yml

  say "3. and the API, started from what is now on disk"
  ( cd "$PROJ" && $SUDO docker compose up -d --force-recreate arrow-atlas-api ) >/dev/null 2>&1 \
    || { bad "docker compose refused to bring it up"; docker logs --tail 30 arrow-atlas-api 2>&1 | sed 's/^/      /'; return; }
  note "it still installs and builds TypeScript, which takes a couple of minutes on 2 vCPU"
  h=""
  for i in $(seq 1 60); do
    h=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' arrow-atlas-api 2>/dev/null)
    [ "$h" = "healthy" ] && break
    sleep 10
  done
  [ "$h" = "healthy" ] && ok "arrow-atlas-api is healthy" || bad "arrow-atlas-api is $h after ten minutes"
  docker logs --tail 20 arrow-atlas-api 2>&1 | sed 's/^/      /'

  # And the client, into the container that serves the site. Not by restarting it: that container is defined
  # by hPanel's own copy of a compose file, which still empties the document root before fetching — restarting
  # it while GitHub answers 404 would leave the whole site with nothing to serve. Copying the files in over
  # the top has neither problem, and the page is read from disk on every request, so it takes effect at once.
  say "4. the client, into the portfolio container"
  if ! have ariyankhan-web; then note "no ariyankhan-web here; nothing to do"; return; fi
  docker cp "$TGZ" ariyankhan-web:/tmp/arrow-atlas-site.tgz >/dev/null 2>&1 || { bad "could not hand it to ariyankhan-web"; return; }
  # mail-config.local.php is written at start from the container's environment and is in no checkout, so the
  # document root is written over rather than emptied: the contact form keeps the settings it is running with.
  if docker exec ariyankhan-web bash -c '
       set -e
       rm -rf /tmp/site && mkdir -p /tmp/site
       tar -xzf /tmp/arrow-atlas-site.tgz -C /tmp/site
       [ -f /tmp/site/arrow-atlas.html ] || { echo "that is not the site"; exit 1; }
       cp -a /tmp/site/. /var/www/html/
       chown -R www-data:www-data /var/www/html || true
       rm -rf /tmp/site /tmp/arrow-atlas-site.tgz' >/dev/null 2>&1; then
    ok "the client is in place"
  else
    bad "could not put the client in place"; return
  fi
  want=$(tar -xzf "$TGZ" -O ./arrow-atlas.html 2>/dev/null | grep -o 'js/arrow-atlas\.js?v=[0-9]*' | head -1)
  live=$(curl -fsS -H 'X-Forwarded-Proto: https' "https://$DOMAIN/arrow-atlas.html" 2>/dev/null | grep -o 'js/arrow-atlas\.js?v=[0-9]*' | head -1)
  [ -n "$want" ] && [ "$want" = "$live" ] && ok "the page asks for $live, which is what this checkout ships" \
    || bad "the page asks for ${live:-nothing} and this checkout ships ${want:-nothing}"
}

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
    # hPanel's Docker Manager keeps its own copy of this compose file, so an edit in the repository does not
    # reach it. Saying which of the two settings are still there is more useful than assuming either way.
    for v in AA_DATA_DIR GOOGLE_CLIENT_ID; do
      if docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' ariyankhan-web | grep -q "^$v="; then
        note "still set on the container: $v  (the repository no longer sets it; hPanel's own copy of the compose file does)"
      fi
    done
    # The contact form is configured from the container's environment, which the entrypoint turns into
    # mail-config.local.php at start. Names and whether they hold anything — never the values.
    note "contact form settings on the container:"
    env_dump=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' ariyankhan-web 2>/dev/null)
    for v in TO_EMAIL FROM_EMAIL FROM_NAME SMTP_HOST SMTP_USER SMTP_PASS SMTP_PORT MAIL_DRIVER SITE_URL; do
      line=$(printf '%s\n' "$env_dump" | grep "^$v=" | head -1)
      case "$line" in
        "")    printf '      %-12s not set\n' "$v" ;;
        "$v=") printf '      %-12s set but empty\n' "$v" ;;
        *)     printf '      %-12s present\n' "$v" ;;
      esac
    done

    # And what those settings became: the addresses a message will actually carry. The two credentials are
    # reported as set-or-not and by length alone — an address is meant to be read by whoever receives the
    # mail, a relay key is not, and this output goes into a public build log.
    note "the addresses the form will use:"
    docker exec ariyankhan-web php -r '
      $c = @include "/var/www/html/mail-config.local.php";
      if (!is_array($c)) { echo "      (the config file is not there)\n"; exit(0); }
      foreach (["driver","site_url","to_email","from_email","from_name","smtp_host","smtp_port"] as $k) {
        printf("      %-11s %s\n", $k, isset($c[$k]) && $c[$k] !== "" ? $c[$k] : "(unset)");
      }
      foreach (["smtp_user","smtp_pass"] as $k) {
        $v = $c[$k] ?? "";
        printf("      %-11s %s\n", $k, $v !== "" ? "set, " . strlen((string) $v) . " characters (not printed)" : "(unset)");
      }
    ' 2>/dev/null || note "      (could not read it)"
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

  say "1. the last check that can only be made while the SQLite file still exists"
  # Once this file is gone, so is any way of asking what it held. So ask now, and refuse to delete anything if
  # the answer is wrong. Counts alone will not do: a match has been played since the cutover, so PostgreSQL
  # legitimately holds more rows than SQLite, and gold legitimately moved. What must be true is that every
  # account and every match that was in SQLite is in PostgreSQL — by id and by code, not by how many there are.
  # The PHP container has the SQLite driver, because it is what the old service read this file with.
  if have ariyankhan-web && docker exec ariyankhan-web sh -c 'test -f /var/lib/arrow-atlas/arrow-atlas.sqlite' 2>/dev/null; then
    lite=$(docker exec ariyankhan-web php -r '
      $d = new PDO("sqlite:/var/lib/arrow-atlas/arrow-atlas.sqlite");
      $ids   = $d->query("SELECT id FROM users ORDER BY id")->fetchAll(PDO::FETCH_COLUMN);
      $codes = $d->query("SELECT code FROM matches ORDER BY code")->fetchAll(PDO::FETCH_COLUMN);
      $seats = (int) $d->query("SELECT COUNT(*) FROM match_players")->fetchColumn();
      echo count($ids), "|", count($codes), "|", $seats, "|",
           implode(",", array_map("intval", $ids)), "|",
           implode(",", array_map(fn($c) => "\x27" . preg_replace("/[^A-Za-z0-9]/", "", $c) . "\x27", $codes));
    ' 2>/dev/null) || lite=""
    if [ -z "$lite" ]; then
      bad "could not read the SQLite file to compare it; refusing to delete it unread"
      return
    fi
    n_users=$(printf '%s' "$lite"  | cut -d'|' -f1)
    n_codes=$(printf '%s' "$lite"  | cut -d'|' -f2)
    n_seats=$(printf '%s' "$lite"  | cut -d'|' -f3)
    ids=$(printf '%s' "$lite"      | cut -d'|' -f4)
    codes=$(printf '%s' "$lite"    | cut -d'|' -f5)
    note "SQLite held $n_users accounts, $n_codes matches and $n_seats seats"

    # `in ()` is a syntax error, so an empty list is answered as zero found rather than asked about.
    found_u=0; [ -n "$ids" ]   && found_u=$(psqlc "select count(*) from users   where id   in ($ids)")
    found_m=0; [ -n "$codes" ] && found_m=$(psqlc "select count(*) from matches where code in ($codes)")
    note "PostgreSQL holds $found_u of those accounts and $found_m of those matches"
    if [ "$found_u" = "$n_users" ] && [ "$found_m" = "$n_codes" ]; then
      ok "every account and every match that was in SQLite is in PostgreSQL, by id and by code"
    else
      bad "something that was in SQLite is not in PostgreSQL; refusing to delete the only copy of the source"
      return
    fi

    # And nothing shrank: PostgreSQL has at least the rows SQLite did. It may have more, because people have
    # been playing on it, which is the whole point of the cutover having happened.
    for pair in "users:$n_users" "matches:$n_codes" "match_players:$n_seats"; do
      t=${pair%%:*}; was=${pair##*:}
      now=$(psqlc "select count(*) from $t")
      if [ "$now" -ge "$was" ]; then ok "$(printf '%-14s %s in SQLite, %s now' "$t" "$was" "$now")"
      else bad "$t went down: $was in SQLite, only $now now"; return; fi
    done
  else
    note "there is no SQLite file left to compare"
  fi

  say "2. the old SQLite database, out of the portfolio container"
  if have ariyankhan-web; then
    docker exec ariyankhan-web sh -c 'ls -1 /var/lib/arrow-atlas/ 2>/dev/null' | sed 's/^/      was: /' || true
    docker exec ariyankhan-web sh -c 'rm -f /var/lib/arrow-atlas/arrow-atlas.sqlite /var/lib/arrow-atlas/arrow-atlas.sqlite-wal /var/lib/arrow-atlas/arrow-atlas.sqlite-shm' \
      && gone "ariyankhan-web:/var/lib/arrow-atlas/arrow-atlas.sqlite (and its -wal/-shm)" \
      || bad "could not remove the SQLite file"
    docker exec ariyankhan-web sh -c 'ls -la /var/lib/arrow-atlas/ 2>/dev/null' | sed 's/^/      now: /' || true
  else
    note "ariyankhan-web is not here; nothing to do"
  fi

  say "3. the legacy PHP API out of the live web root"
  # The next re-fetch would drop it anyway, since main no longer carries games/api — this makes it true now.
  if have ariyankhan-web && docker exec ariyankhan-web sh -c 'test -d /var/www/html/games/api' 2>/dev/null; then
    docker exec ariyankhan-web sh -c 'rm -rf /var/www/html/games/api' \
      && gone "ariyankhan-web:/var/www/html/games/api" || bad "could not remove games/api"
  else
    note "already gone"
  fi

  say "4. the pre-migration SQLite backups on the host"
  n=0
  for f in "$HOST_BACKUPS"/pre-migration-*.sqlite "$HOST_BACKUPS"/*.sqlite; do
    [ -e "$f" ] || continue
    $SUDO rm -f "$f" && { gone "$f"; n=$((n+1)); } || bad "could not remove $f"
  done
  [ "$n" = "0" ] && note "there were none left"

  say "5. the temporary copies made during the cutover"
  for f in /tmp/legacy.sqlite /tmp/arrow-atlas.sqlite /tmp/aa.sqlite /tmp/pre-migration-*.sqlite; do
    [ -e "$f" ] && { $SUDO rm -f "$f" && gone "host $f"; }
  done
  for c in arrow-atlas-api ariyankhan-web; do
    have "$c" || continue
    docker exec "$c" sh -c 'rm -f /tmp/legacy.sqlite /tmp/arrow-atlas.sqlite /tmp/aa.sqlite /tmp/pre-migration-*.sqlite' 2>/dev/null \
      && gone "$c:/tmp legacy copies"
  done

  say "6. nginx: verify what is live, keep a backup of it in its final form, then drop the pre-cutover one"
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

  say "7. what was deliberately left alone"
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

mode_deploy_site() {
  echo "Arrow Atlas — ship the client  ($(date -u))"
  # Only the portfolio container, which re-fetches main at start. The game's backend keeps running throughout:
  # a change to the page, the stylesheet or the client has no business interrupting a match in progress.
  have ariyankhan-web || { bad "ariyankhan-web is not here"; return; }

  before=$(curl -sS -m 20 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/arrow-atlas.html" \
    | grep -o 'js/arrow-atlas.js?v=[0-9]*' | head -1)
  note "the page asks for ${before:-<nothing found>} right now"

  docker restart ariyankhan-web >/dev/null && ok "restarting, which re-fetches main" || { bad "could not restart it"; return; }
  h=""
  for i in $(seq 1 36); do
    h=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' ariyankhan-web 2>/dev/null)
    [ "$h" = "healthy" ] && break
    sleep 5
  done
  [ "$h" = "healthy" ] && ok "ariyankhan-web is healthy again" || { bad "ariyankhan-web is $h after three minutes"; return; }

  after=$(curl -sS -m 20 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/arrow-atlas.html" \
    | grep -o 'js/arrow-atlas.js?v=[0-9]*' | head -1)
  note "and now ${after:-<nothing found>}"
  [ -n "$after" ] || bad "the page no longer names a client at all"

  # The game itself was not restarted, so it should not have noticed any of this.
  s=$(docker inspect -f '{{.State.Status}}{{if .State.Health}}/{{.State.Health.Status}}{{end}}' arrow-atlas-api 2>/dev/null || echo absent)
  case "$s" in
    running/healthy|running) ok "arrow-atlas-api untouched and still $s" ;;
    *)                       bad "arrow-atlas-api is $s" ;;
  esac
  hc_code=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/arrow-atlas/v1/lobby" 2>/dev/null || echo 000)
  [ "$hc_code" = "200" ] && ok "and the game's API still answers (200)" || bad "the game's API answered $hc_code"
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
  hc "v1 lobby"                   200 "https://$DOMAIN/api/arrow-atlas/v1/lobby"
  hc "the legacy PHP path is gone" 404 "https://$DOMAIN/games/api/auth.php?a=me"
  hc "and so is the PHP file"     404 "https://$DOMAIN/games/api/match.php"
  hc "other PHP still runs"       405 "https://$DOMAIN/send-mail.php"
  # A GET only proves the file is there. This is a POST that trips the contact form's own honeypot, so it
  # stops before it would send anything — but it stops *after* the handler has checked that it has somewhere
  # to send to, which is the part that fails silently when the container comes up without TO_EMAIL or the
  # SMTP settings. 200 means the form can actually deliver; 500 means every visitor who writes in is refused.
  hc "the contact form can send"  200 "https://$DOMAIN/send-mail.php" \
     -X POST -H 'Content-Type: application/json' -d '{"website":"health-check"}'
  # 200, not 403. These requests come from the VPS over loopback, and the health location allows 127.0.0.1
  # and denies everything else on the real peer address — so being served here is the allowlist working. That
  # it is refused from off the machine is a different question, asked from a GitHub runner by vps-smoke.yml,
  # because only a request that actually crosses the internet can answer it.
  hc "health answers the host"    200 "https://$DOMAIN/api/arrow-atlas/health"

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
  logs)          mode_logs ;;
  git-access)    mode_git_access ;;
  push-source)   mode_push_source ;;
  web-safe-fetch) mode_web_safe_fetch ;;
  backup-verify) mode_backup_verify ;;
  cleanup)       mode_cleanup ;;
  deploy)        mode_deploy ;;
  deploy-site)   mode_deploy_site ;;
  health)        mode_health ;;
  *) echo "::error::unknown mode: $MODE"; exit 2 ;;
esac

echo
if [ "$fail" = "0" ]; then echo "── $MODE: everything checked out"; else echo "── $MODE: something above failed"; fi
exit "$fail"
