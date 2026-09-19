#!/bin/sh
# Puzzle PostgreSQL backups.
#
#   puzzle-backup once     take one backup now and exit
#   puzzle-backup loop     take one every day at PUZZLE_BACKUP_AT_HOUR (what the container runs)
#   puzzle-backup list     what we have
#
# Three things this does that a bare pg_dump in a cron line does not:
#   * it verifies every dump it writes, by reading the archive's table of contents back. A backup nobody has
#     opened is a hope, not a backup.
#   * it writes outside the live PostgreSQL data directory, to a named volume and a host path, so losing the
#     database volume does not lose the backups with it.
#   * it fails loudly. A non-zero exit, a line on stderr, and a status file the container healthcheck reads, so
#     a backup that has quietly stopped shows up as an unhealthy container instead of a surprise in six months.
set -eu

DIR="${PUZZLE_BACKUP_DIR:-/backups}"
HOST_DIR="/backups-host"
KEEP_DAYS="${PUZZLE_BACKUP_KEEP_DAYS:-14}"
AT_HOUR="${PUZZLE_BACKUP_AT_HOUR:-3}"
AT_HOUR="${AT_HOUR#0}"; [ -n "$AT_HOUR" ] || AT_HOUR=0   # "03" is an illegal octal number in POSIX arithmetic
DB="${PGDATABASE:-puzzle}"
STATUS="$DIR/last-run.json"
# The tables a dump of this game must contain. Checked by name, in both this script and restore.sh, so the two
# never disagree about what a good backup looks like.
CORE_TABLES="users sessions matches match_players gold_ledger"

log() { printf '{"ts":"%s","product":"puzzle","component":"backup","msg":"%s"}\n' "$(date -u +%FT%TZ)" "$1"; }
fail() { printf '{"ts":"%s","product":"puzzle","component":"backup","level":"error","msg":"%s"}\n' "$(date -u +%FT%TZ)" "$1" >&2; }

status() {   # status <ok|failed> <file> <bytes> <detail>
  mkdir -p "$DIR"
  printf '{"result":"%s","at":"%s","file":"%s","bytes":%s,"detail":"%s"}\n' \
    "$1" "$(date -u +%FT%TZ)" "$2" "${3:-0}" "${4:-}" > "$STATUS"
}

once() {
  mkdir -p "$DIR"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  out="$DIR/puzzle-$stamp.dump"
  tmp="$out.partial"

  log "starting backup of $DB"
  # -Fc is PostgreSQL's own compressed archive: restorable selectively, and readable by pg_restore --list.
  if ! pg_dump --format=custom --compress=6 --no-owner --no-privileges --file="$tmp" "$DB"; then
    rm -f "$tmp"; fail "pg_dump failed for $DB"; status failed "" 0 "pg_dump failed"; return 1
  fi

  # Read it back. An archive whose table of contents will not parse is not a backup.
  if ! pg_restore --list "$tmp" > /dev/null 2>&1; then
    rm -f "$tmp"; fail "the dump did not verify"; status failed "" 0 "verify failed"; return 1
  fi
  # Name the tables rather than counting them. A count cannot tell a dump that is missing the accounts from one
  # that simply has a table fewer than it used to, and those are not the same news at all.
  toc="$(pg_restore --list "$tmp" 2>/dev/null)"
  missing=""
  for t in $CORE_TABLES; do
    printf '%s' "$toc" | grep -q "TABLE DATA public $t " || missing="$missing $t"
  done
  if [ -n "$missing" ]; then
    rm -f "$tmp"; fail "the dump is missing:$missing"
    status failed "" 0 "missing$missing"; return 1
  fi
  tables="$(printf '%s' "$toc" | grep -c 'TABLE DATA' || true)"

  mv "$tmp" "$out"
  bytes="$(wc -c < "$out" | tr -d ' ')"
  log "backup written: $out ($bytes bytes, $tables tables)"

  # A second copy where the host can see it, so a lost Docker volume is not a lost history.
  if [ -d "$HOST_DIR" ] && [ -w "$HOST_DIR" ]; then
    cp "$out" "$HOST_DIR/" && log "copied to the host at $HOST_DIR"
  else
    log "no writable host directory at $HOST_DIR; keeping the volume copy only"
  fi

  # Retention, applied to both copies. -mtime +N deletes what is older than N days.
  # Both spellings: dumps taken before the game was renamed age out on the same schedule as the new ones.
  find "$DIR" \( -name 'puzzle-*.dump' -o -name 'arrow-atlas-*.dump' \) -mtime "+$KEEP_DAYS" -print -delete 2>/dev/null | while read -r old; do log "aged out $old"; done
  [ -d "$HOST_DIR" ] && find "$HOST_DIR" \( -name 'puzzle-*.dump' -o -name 'arrow-atlas-*.dump' \) -mtime "+$KEEP_DAYS" -delete 2>/dev/null || true

  status ok "$out" "$bytes" "$tables tables"
  return 0
}

case "${1:-once}" in
  once) once ;;
  list)
    ls -lh "$DIR"/puzzle-*.dump "$DIR"/arrow-atlas-*.dump 2>/dev/null || echo "no backups yet in $DIR"
    [ -f "$STATUS" ] && { echo "last run:"; cat "$STATUS"; } || true
    ;;
  loop)
    log "backup loop started: daily at ${AT_HOUR}:00 UTC, keeping ${KEEP_DAYS} days"

    # One on boot, so a fresh deployment has a backup within the minute rather than within the day.
    #
    # On a first deploy this container is usually ready before the API has finished building and running its
    # migrations, so the database is empty and the first attempt is correctly refused for having no tables in
    # it. Waiting until tomorrow for the next one would leave the healthcheck red for a day over nothing, so
    # keep trying every minute until one succeeds. After that the daily schedule takes over.
    tries=0
    until once; do
      tries=$(( tries + 1 ))
      if [ "$tries" -ge 60 ]; then
        fail "no backup has succeeded in an hour of trying; leaving it to the schedule"
        break
      fi
      log "retrying in 60s (attempt $tries) — on a fresh deploy the schema may not exist yet"
      sleep 60
    done
    while true; do
      # Seconds until the next AT_HOUR:00 UTC, counted from the epoch rather than from the hour and minute.
      # This container runs Alpine's /bin/sh, where bash's 10# base notation is a syntax error and a bare "08"
      # is an illegal octal number — either one would kill the loop under set -e and leave Compose restarting
      # it forever instead of backing anything up. Epoch seconds have no leading zero to trip over.
      now=$(date -u +%s)
      secs=$(( AT_HOUR * 3600 - now % 86400 ))
      [ "$secs" -le 60 ] && secs=$(( secs + 86400 ))
      log "next backup in ${secs}s"
      sleep "$secs"
      once || fail "scheduled backup failed"
    done
    ;;
  *) echo "usage: $0 {once|loop|list}" >&2; exit 2 ;;
esac
