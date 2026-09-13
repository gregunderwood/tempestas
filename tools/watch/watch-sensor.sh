#!/usr/bin/env bash
# Does shading the SCD41 stop the faults?
#
# Before the cover: 0 bad below 25C, 22% at 25-30, 26% at 30-35, 40% above 35.
# Two outcomes mean different things, so this reports the band as well as the
# rate:
#   die never gets hot now   -> symptom avoided, part NOT exonerated
#   gets hot and stays clean -> it was the sun, the part is fine
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API="http://192.168.2.70:7000/api"
prev=""
ticks=0

while :; do
  out=$(curl -sf --max-time 20 "$API/readings?nodeId=elantris&limit=120" 2>/dev/null \
        | python3 "$HERE/sensor-stats.py" 2>/dev/null)
  now=$(TZ=America/Vancouver date +%H:%M)
  if [[ -z "$out" ]]; then
    echo "[$now] controller unreachable"; sleep 60; continue
  fi
  set -- $out
  tmax=$1; pct=$2; bad=$3; n=$4; band=$5
  verdict=clean; [[ "$pct" -gt 5 ]] && verdict=FAULTING
  state="$band:$verdict"

  if [[ "$state" != "$prev" ]]; then
    echo "[$now] $(echo "$band" | tr a-z A-Z) peak ${tmax}C - ${bad}/${n} bad (${pct}%) $verdict"
    prev="$state"
  elif (( ticks % 6 == 0 )); then
    echo "[$now] $band peak ${tmax}C - ${bad}/${n} bad (${pct}%)"
  fi
  ticks=$((ticks+1))
  sleep 300
done
