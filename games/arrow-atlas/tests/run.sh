#!/bin/bash
# Run the Arrow Atlas test suites.
#
# The suites live beside the backend rather than inside it, so they need its node_modules on their resolution
# path; a symlink is the least surprising way to give them one, and it is ignored by git.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BE="$HERE/../backend"
[ -d "$BE/node_modules" ] || { echo "run 'npm install' in $BE first"; exit 1; }
[ -e "$HERE/node_modules" ] || ln -s "$BE/node_modules" "$HERE/node_modules"

# Local runs read backend/.env.dev; CI and the container pass the same variables in the environment.
if [ -f "$BE/.env.dev" ] && [ -z "${ARROW_ATLAS_PG_HOST:-}" ]; then set -a; . "$BE/.env.dev"; set +a; fi

SUITES=("${@}")
if [ ${#SUITES[@]} -eq 0 ]; then SUITES=(economy migration api); fi

fail=0
for s in "${SUITES[@]}"; do
  f="$HERE/$s.test.ts"
  [ -f "$f" ] || { echo "no such suite: $s"; fail=1; continue; }
  echo "───────────────────────────────── $s"
  ( cd "$BE" && npx tsx "$f" ) || fail=1
done
echo
[ $fail -eq 0 ] && echo "every suite passed" || echo "some suites failed"
exit $fail
