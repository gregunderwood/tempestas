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

for NAME in tempestas-sandbox-elantris tempestas-sandbox-greenhouse; do
  docker rm -f "$NAME" >/dev/null 2>&1 && echo "stopped $NAME"
done
