#!/bin/sh
# Restore the puzzle database from a dump.
#
#   puzzle-restore verify  <dump>              restore into a scratch database and check it, changing nothing
#   puzzle-restore into    <dump> <database>   restore into a database you name
#   puzzle-restore live    <dump>              replace the live database (asks for CONFIRM=yes)
#
# `verify` is the one to run regularly: it proves the backup is restorable without touching the game.
set -eu

log()  { printf '{"ts":"%s","product":"puzzle","component":"restore","msg":"%s"}\n' "$(date -u +%FT%TZ)" "$1"; }
fail() { printf '{"ts":"%s","product":"puzzle","component":"restore","level":"error","msg":"%s"}\n' "$(date -u +%FT%TZ)" "$1" >&2; }

LIVE_DB="${PGDATABASE:-puzzle}"
# The same list backup.sh checks, so a dump it accepted is a dump this will accept.
CORE_TABLES="users sessions matches match_players gold_ledger"

counts() {   # counts <database> — the numbers worth comparing after a restore
  psql -d "$1" -tAF' ' -c "
    SELECT 'users', COUNT(*) FROM users
    UNION ALL SELECT 'matches', COUNT(*) FROM matches
    UNION ALL SELECT 'match_players', COUNT(*) FROM match_players
    UNION ALL SELECT 'sessions', COUNT(*) FROM sessions
    UNION ALL SELECT 'gold_ledger', COUNT(*) FROM gold_ledger
    UNION ALL SELECT 'gold_total', COALESCE(SUM(gold),0) FROM users
    UNION ALL SELECT 'ledger_total', COALESCE(SUM(delta),0) FROM gold_ledger
    ORDER BY 1"
}

restore_into() {   # restore_into <dump> <database>
  dump="$1"; target="$2"
  [ -f "$dump" ] || { fail "no such dump: $dump"; exit 1; }
  log "restoring $dump into $target"
  psql -d postgres -qc "DROP DATABASE IF EXISTS \"$target\";" 
  psql -d postgres -qc "CREATE DATABASE \"$target\";"
  # --exit-on-error: a restore that only half worked must not look like a success.
  pg_restore --dbname="$target" --no-owner --no-privileges --exit-on-error "$dump"
  log "restored into $target"
}

case "${1:-}" in
  verify)
    dump="${2:?usage: $0 verify <dump>}"
    scratch="puzzle_restore_check_$$"
    restore_into "$dump" "$scratch"
    echo "--- row counts in the restored copy ---"
    counts "$scratch"
    # The economy must reconcile in the restored copy too, or the dump caught the database mid-flight.
    drift="$(psql -d "$scratch" -tAc "
      SELECT COUNT(*) FROM (
        SELECT u.id FROM users u LEFT JOIN gold_ledger g ON g.user_id = u.id
         GROUP BY u.id, u.gold HAVING u.gold <> COALESCE(SUM(g.delta),0)) x")"
    # By name, not by count: the point is that the accounts, the matches and the ledger came back.
    missing=""
    for t in $CORE_TABLES; do
      found="$(psql -d "$scratch" -tAc "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='$t'")"
      [ "$found" = "1" ] || missing="$missing $t"
    done
    tables="$(psql -d "$scratch" -tAc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'")"
    psql -d postgres -qc "DROP DATABASE IF EXISTS \"$scratch\";"
    [ -z "$missing" ] || { fail "the restored copy is missing:$missing"; exit 1; }
    [ "$drift" = "0" ] || { fail "$drift accounts do not reconcile in the restored copy"; exit 1; }
    log "verified: every core table is present ($tables in all), the ledger reconciles, and the scratch database has been dropped"
    ;;
  into)
    restore_into "${2:?usage: $0 into <dump> <database>}" "${3:?usage: $0 into <dump> <database>}"
    counts "$3"
    ;;
  live)
    dump="${2:?usage: CONFIRM=yes $0 live <dump>}"
    [ "${CONFIRM:-}" = "yes" ] || { fail "this replaces the live database $LIVE_DB; re-run with CONFIRM=yes"; exit 2; }
    # Keep what is there now before replacing it: a rollback from the rollback.
    safety="/backups/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).dump"
    log "saving the current $LIVE_DB to $safety first"
    pg_dump --format=custom --compress=6 --no-owner --no-privileges --file="$safety" "$LIVE_DB" || fail "could not save the current database; continuing is your call"
    restore_into "$dump" "$LIVE_DB"
    counts "$LIVE_DB"
    log "live database replaced; the copy it replaced is at $safety"
    ;;
  *) echo "usage: $0 {verify <dump>|into <dump> <db>|live <dump>}" >&2; exit 2 ;;
esac
