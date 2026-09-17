#!/bin/sh
# Arrow Atlas PostgreSQL backups.
#
#   arrow-atlas-backup once     take one backup now and exit
#   arrow-atlas-backup loop     take one every day at ARROW_ATLAS_BACKUP_AT_HOUR (what the container runs)
#   arrow-atlas-backup list     what we have
#
# Three things this does that a bare pg_dump in a cron line does not:
#   * it verifies every dump it writes, by reading the archive's table of contents back. A backup nobody has
#     opened is a hope, not a backup.
#   * it writes outside the live PostgreSQL data directory, to a named volume and a host path, so losing the
#     database volume does not lose the backups with it.
#   * it fails loudly. A non-zero exit, a line on stderr, and a status file the container healthcheck reads, so
#     a backup that has quietly stopped shows up as an unhealthy container instead of a surprise in six months.
set -eu

DIR="${ARROW_ATLAS_BACKUP_DIR:-/backups}"
HOST_DIR="/backups-host"
KEEP_DAYS="${ARROW_ATLAS_BACKUP_KEEP_DAYS:-14}"
AT_HOUR="${ARROW_ATLAS_BACKUP_AT_HOUR:-3}"
DB="${PGDATABASE:-arrow_atlas}"
STATUS="$DIR/last-run.json"

log() { printf '{"ts":"%s","product":"arrow-atlas","component":"backup","msg":"%s"}\n' "$(date -u +%FT%TZ)" "$1"; }
fail() { printf '{"ts":"%s","product":"arrow-atlas","component":"backup","level":"error","msg":"%s"}\n' "$(date -u +%FT%TZ)" "$1" >&2; }

status() {   # status <ok|failed> <file> <bytes> <detail>
  mkdir -p "$DIR"
  printf '{"result":"%s","at":"%s","file":"%s","bytes":%s,"detail":"%s"}\n' \
    "$1" "$(date -u +%FT%TZ)" "$2" "${3:-0}" "${4:-}" > "$STATUS"
}

once() {
  mkdir -p "$DIR"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  out="$DIR/arrow-atlas-$stamp.dump"
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
  tables="$(pg_restore --list "$tmp" 2>/dev/null | grep -c 'TABLE DATA' || true)"
  if [ "${tables:-0}" -lt 5 ]; then
    rm -f "$tmp"; fail "the dump holds only ${tables:-0} tables; expected the full schema"
    status failed "" 0 "only ${tables:-0} tables"; return 1
  fi

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
  find "$DIR" -name 'arrow-atlas-*.dump' -mtime "+$KEEP_DAYS" -print -delete 2>/dev/null | while read -r old; do log "aged out $old"; done
  [ -d "$HOST_DIR" ] && find "$HOST_DIR" -name 'arrow-atlas-*.dump' -mtime "+$KEEP_DAYS" -delete 2>/dev/null || true

  status ok "$out" "$bytes" "$tables tables"
  return 0
}

case "${1:-once}" in
  once) once ;;
  list)
    ls -lh "$DIR"/arrow-atlas-*.dump 2>/dev/null || echo "no backups yet in $DIR"
    [ -f "$STATUS" ] && { echo "last run:"; cat "$STATUS"; } || true
    ;;
  loop)
    log "backup loop started: daily at ${AT_HOUR}:00 UTC, keeping ${KEEP_DAYS} days"
    # One on boot, so a fresh deployment has a backup within the minute rather than within the day.
    once || fail "the first backup failed; carrying on so the schedule still runs"
    while true; do
      now_h="$(date -u +%H)"; now_m="$(date -u +%M)"
      # seconds until the next AT_HOUR:00 UTC
      secs=$(( ( (10#$AT_HOUR - 10#$now_h + 24) % 24 ) * 3600 - 10#$now_m * 60 ))
      [ "$secs" -le 60 ] && secs=$((secs + 86400))
      log "next backup in ${secs}s"
      sleep "$secs"
      once || fail "scheduled backup failed"
    done
    ;;
  *) echo "usage: $0 {once|loop|list}" >&2; exit 2 ;;
esac
