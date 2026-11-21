#!/usr/bin/env bash
# Seed both boxes' databases like production: one zone, both nodes admitted, every device wired
# with its real polarity. Both, because boxes differ in who may write, not in who may know.
set -euo pipefail

LEADER="${LEADER:-http://127.0.0.1:7010}"
FOLLOWER="${FOLLOWER:-http://127.0.0.1:7011}"

ZONE_SQL=$(cat <<'SQL'
INSERT INTO zones (slug, display_name, rules_config) VALUES (
  'greenhouse', 'Greenhouse',
  '{
     "enabledRoles": ["co2_generator"],
     "sensorPolicy": { "default": { "source": "mean", "maxAgeMs": 120000 } },
     "daylight": { "start": "06:30", "end": "18:30" },
     "rules": {
       "lights": { "kind": "daylight-thermostat", "mode": "heat", "onAtC": 26, "offAtC": 27, "onStale": "hold" },
       "co2_generator": {
         "kind": "co2-burner", "dayOffAtC": 28, "nightOnBelowC": 3,
         "co2OnPpm": 1400, "co2OffPpm": 1500, "onStale": "hold",
         "sensor": { "source": "node:elantris" }
       },
       "exhaust_fan": { "kind": "thermostat", "mode": "cool", "onAtC": 30, "offAtC": 29.5, "onStale": "hold" }
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

# The admit route takes the node's UUID; the slug is only its MQTT topic segment.
node_uuid() {
  curl -sf "$1/api/nodes" | python3 -c "
import json, sys
slug = sys.argv[1]
for node in json.load(sys.stdin):
    if node.get('slug') == slug:
        print(node['id']); break
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

# Independent databases mean independent primary keys, so the zone UUID is resolved per box.
zone_uuid() {
  docker exec -i "tempestas-sandbox-$1" psql -qtAX -U tempestas -d tempestas \
    -c "select id from zones where slug = 'greenhouse';" | tr -d '[:space:]'
}

create_device() {
  local api=$1 zone_id=$2 node=$3 name=$4 gpio=$5 on_level=$6 role=$7 delay=$8
  local response
  response=$(curl -s -X POST "$api/api/devices" -H 'Content-Type: application/json' -d "{
      \"nodeId\": \"$node\", \"zoneId\": \"$zone_id\", \"name\": \"$name\",
      \"gpio\": $gpio, \"onLevel\": $on_level, \"role\": $role,
      \"onDelayDuration\": $delay, \"rulesEnabled\": false
    }")
  if grep -q '"id"' <<<"$response"; then
    echo "   $name (BCM $gpio, ON=$on_level)"
  else
    echo "   $name NOT created: $(head -c 160 <<<"$response")"
  fi
}

# Until config replication exists, each box gets the same rows, deliberately, from this one place.
for pair in "$LEADER elantris" "$FOLLOWER greenhouse"; do
  set -- $pair; API=$1; BOX=$2
  ZONE=$(zone_uuid "$BOX")
  echo "==> devices on $API (zone $ZONE)"
  #                                 node        name             BCM onLevel role                 delay
  create_device "$API" "$ZONE" elantris   "CO2 Generator"    5  0 '"co2_generator"' 300
  create_device "$API" "$ZONE" greenhouse "HPS Lights"      21  0 '"lights"'        900
  create_device "$API" "$ZONE" greenhouse "Exhaust Fan"     20  0 '"exhaust_fan"'    60
  # Active-HIGH: the one row where copying the board default lights a lamp.
  create_device "$API" "$ZONE" greenhouse "MH Light"        26  1 '"lights"'        900
  create_device "$API" "$ZONE" greenhouse "Extra Relay"     12  0 'null'              0
done

echo
echo "seeded. Nothing has rulesEnabled - turn one on deliberately:"
echo "  curl -X PATCH $LEADER/api/devices/<id> -H 'Content-Type: application/json' -d '{\"rulesEnabled\":true}'"
