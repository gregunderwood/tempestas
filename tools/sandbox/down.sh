#!/usr/bin/env bash
# Stop everything the sandbox started, and nothing else.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="${TEMPESTAS_SANDBOX_RUN:-$HERE/run}"
[[ -f "$RUN/pids" ]] || { echo "nothing recorded in $RUN/pids"; exit 0; }
while read -r name pid; do
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null && echo "stopped $name ($pid)"
  fi
done < "$RUN/pids"
: > "$RUN/pids"

# A process orphaned by a crash is missing from the pid file, and the next up.sh would run against it.
for PAT in "tempestas-sim" "tempestas-agent" "sandbox/run/app/server/main.js"; do
  pkill -f "$PAT" 2>/dev/null && echo "swept stray $PAT"
done

for NAME in tempestas-sandbox-elantris tempestas-sandbox-greenhouse; do
  docker rm -f "$NAME" >/dev/null 2>&1 && echo "stopped $NAME"
done
