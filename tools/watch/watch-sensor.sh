#!/usr/bin/env bash
# Does shading the SCD41 stop the faults? Why it reports the band as well as the rate: README.md.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API="http://192.168.2.70:7000/api"
FAULTING_ABOVE_PCT=5
POLL_SECONDS=300
UNREACHABLE_RETRY_SECONDS=60
SUMMARY_EVERY_TICKS=6
previous_state=""
ticks=0

while :; do
  stats=$(curl -sf --max-time 20 "$API/readings?nodeId=elantris&limit=120" 2>/dev/null \
        | python3 "$HERE/sensor-stats.py" 2>/dev/null)
  now=$(TZ=America/Vancouver date +%H:%M)
  if [[ -z "$stats" ]]; then
    echo "[$now] controller unreachable"; sleep "$UNREACHABLE_RETRY_SECONDS"; continue
  fi
  set -- $stats
  peak_temp=$1; bad_pct=$2; bad_count=$3; total=$4; band=$5
  verdict=clean; [[ "$bad_pct" -gt "$FAULTING_ABOVE_PCT" ]] && verdict=FAULTING
  state="$band:$verdict"

  if [[ "$state" != "$previous_state" ]]; then
    echo "[$now] $(echo "$band" | tr a-z A-Z) peak ${peak_temp}C - ${bad_count}/${total} bad (${bad_pct}%) $verdict"
    previous_state="$state"
  elif (( ticks % SUMMARY_EVERY_TICKS == 0 )); then
    echo "[$now] $band peak ${peak_temp}C - ${bad_count}/${total} bad (${bad_pct}%)"
  fi
  ticks=$((ticks+1))
  sleep "$POLL_SECONDS"
done
