#!/usr/bin/env bash
# Seed the sandbox to mirror production: one zone, both nodes admitted, and
# every device wired as the real boxes are - polarity included.
#
# Seeded into BOTH databases. Per-box databases are the design, and the
# follower needs the same rows to render the same UI; the difference between
# the boxes is who may WRITE, not who may know.
set -euo pipefail

LEADER="${LEADER:-http://127.0.0.1:7010}"
FOLLOWER="${FOLLOWER:-http://127.0.0.1:7011}"

ZONE_SQL=$(cat <<'SQL'
INSERT INTO zones (slug, display_name, rules_config) VALUES (
  'greenhouse', 'Greenhouse',
  '{
     "enabledRoles": ["co2_generator"],
     "sensorPolicy": {
       "default": { "source": "zone-mean", "maxAgeMs": 120000 },
       "byRole": { "co2_generator": { "source": "node:elantris" } }
     },
     "thresholds": {
       "startTime": "06:30", "endTime": "18:30",
       "lightsOnTemp": 26, "lightsOffTemp": 27,
       "co2OffTemp": 26, "co2NightOnTemp": 3,
       "exhaustOnTemp": 30, "exhaustOffTemp": 29.5,
       "co2OnPpm": 1400, "co2OffPpm": 1500
     },
     "timezone": "America/Vancouver"
   }'
) ON CONFLICT (slug) DO UPDATE SET rules_config = EXCLUDED.rules_config;
SQL
)

for NAME in elantris greenhouse; do
  echo "==> zone into $NAME's database"
  docker exec -i "tempestas-sandbox-$NAME" psql -q -U tempestas -d tempestas <<<"$ZONE_SQL"
done

# The admit route takes the node's UUID, not its slug - the slug is the MQTT
# topic segment, and the two are deliberately different identifiers.
node_uuid() {
  curl -sf "$1/api/nodes" | python3 -c "
import json,sys
want = sys.argv[1]
for n in json.load(sys.stdin):
    if n.get('slug') == want:
        print(n['id']); break
" "$2"
}

admit() {
  local api=$1 node=$2
  local id
  id=$(node_uuid "$api" "$node")
  if [[ -z "$id" ]]; then
    echo "   $node has not said hello yet - nothing to admit"
    return 1
  fi
  if curl -sf -X POST "$api/api/nodes/$id/admit" -H 'Content-Type: application/json' \
       -d '{"displayName":"'"$node"'"}' >/dev/null; then
    echo "   admitted $node ($id)"
  else
    echo "   $node already admitted"
  fi
}

for API in "$LEADER" "$FOLLOWER"; do
  echo "==> admitting nodes on $API"
  admit "$API" elantris || true
  admit "$API" greenhouse || true
done

# Devices are created through the LEADER's API only. A follower refuses to
# command, but it will happily hold rows - and creating them twice by hand is
# exactly the config-divergence problem the two-tier design exists to solve.
# Until replication is built, the sandbox seeds both the same way the operator
# would: deliberately, from one place, into each.
# zoneId is a UUID, and it differs between the two databases - independent
# databases mean independent primary keys. Resolve it per box.
zone_uuid() {
  docker exec -i "tempestas-sandbox-$1" psql -qtAX -U tempestas -d tempestas \
    -c "select id from zones where slug = 'greenhouse';" | tr -d '[:space:]'
}

device() {
  local api=$1 zoneid=$2 node=$3 name=$4 gpio=$5 onlevel=$6 role=$7 delay=$8
  local out
  out=$(curl -s -X POST "$api/api/devices" -H 'Content-Type: application/json' -d "{
      \"nodeId\": \"$node\", \"zoneId\": \"$zoneid\", \"name\": \"$name\",
      \"gpio\": $gpio, \"onLevel\": $onlevel, \"role\": $role,
      \"onDelayDuration\": $delay, \"rulesEnabled\": false
    }")
  if grep -q '"id"' <<<"$out"; then
    echo "   $name (BCM $gpio, ON=$onlevel)"
  else
    echo "   $name NOT created: $(head -c 160 <<<"$out")"
  fi
}

for pair in "$LEADER elantris" "$FOLLOWER greenhouse"; do
  set -- $pair; API=$1; BOX=$2
  ZONE=$(zone_uuid "$BOX")
  echo "==> devices on $API (zone $ZONE)"
  #                          node        name             BCM onLevel role                 delay
  device "$API" "$ZONE" elantris   "CO2 Generator"    5  0 '"co2_generator"' 300
  device "$API" "$ZONE" greenhouse "HPS Lights"      21  0 '"lights"'        900
  device "$API" "$ZONE" greenhouse "Exhaust Fan"     20  0 '"exhaust_fan"'    60
  # ACTIVE-HIGH. The one row where copying the board default lights a lamp.
  device "$API" "$ZONE" greenhouse "MH Light"        26  1 '"lights"'        900
  device "$API" "$ZONE" greenhouse "Extra Relay"     12  0 'null'              0
done

echo
echo "seeded. Nothing has rulesEnabled - turn one on deliberately:"
echo "  curl -X PATCH $LEADER/api/devices/<id> -H 'Content-Type: application/json' -d '{\"rulesEnabled\":true}'"
