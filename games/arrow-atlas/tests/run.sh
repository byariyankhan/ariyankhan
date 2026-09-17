#!/bin/bash
# Run the Arrow Atlas test suites.
#
#   ./run.sh                      all of them
#   ./run.sh economy api          just those
#
# The suites import nothing but Node's own built-ins and the backend's source, which is why they can sit beside
# the backend rather than inside it and still resolve: a relative import into backend/src carries that package's
# own dependencies with it. A bare `import x from 'some-package'` in a test file would not resolve, and CI has a
# step that says so rather than failing later with a confusing module error.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BE="$HERE/../backend"
[ -d "$BE/node_modules" ] || { echo "run 'npm install' in $BE first"; exit 1; }

# Local runs read backend/.env.dev; CI and the container pass the same variables in the environment.
if [ -f "$BE/.env.dev" ] && [ -z "${ARROW_ATLAS_PG_HOST:-}" ]; then set -a; . "$BE/.env.dev"; set +a; fi

SUITES=("${@}")
if [ ${#SUITES[@]} -eq 0 ]; then SUITES=(economy api ws); fi

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
