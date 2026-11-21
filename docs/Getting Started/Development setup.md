# Development setup

Everything up to phase 7 runs on the Mac with **no Pi, no broker and no relays** — that is what the
`HARDWARE_DRIVER=fake` seam is for.

## Prerequisites

- Node 22 (`nvm use` — the repo pins it in `.nvmrc` and in `engines`)
- Docker (local Postgres only; production Postgres on the Pi is native apt)
- `mosquitto-clients` for phase 7 onward (`brew install mosquitto`)

## Develop against the simulator, not the greenhouse

`HARDWARE_DRIVER=fake` is the local default, and with the controller now living on elantris that is
a safety property rather than a convenience: **only one controller may hold the heartbeat**, so a
dev server pointed at the real broker would be a second writer on a relay holding a propane burner.
The fake driver cannot reach any hardware at all.

It is a closed loop, not a random number generator, and its constants come from the real greenhouse:

|               |                                                                                     |
| ------------- | ----------------------------------------------------------------------------------- |
| Leakage       | a **fraction of the gradient** to outside air (~420 ppm), never a flat rate         |
| Burner output | ~91 ppm/min gross, ramping in over ~2.5 min                                         |
| Burner heat   | ~1 °C per 15 min of run time                                                        |
| Humidity      | derived from water content and temperature, so RH falls as the burner warms the air |

The gradient-proportional leak is the part that matters. It is why the burner easily out-runs
leakage at baseline and barely beats it near the setpoint — the behaviour that made a single CO2
threshold chatter on the real hardware and forced a dead band. **A simulator with a flat decay rate
hides exactly that**, and would have made the fix look unnecessary.

The fake node is wired like elantris — BCM 5 is the CO2 generator — so a device created against the
simulator works unchanged against the real panel.

## Setup

```bash
nvm use
npm ci
docker compose up -d          # Postgres 17, container tempestas-db, host port 5433
cp apps/server/.env.example apps/server/.env
npm run migration:run
npx nx serve server           # http://localhost:7000/api
npx nx serve web              # http://localhost:4200
```

`apps/server/.env` is **gitignored**; `apps/server/.env.example` is the committed template and its
defaults work as-is — 5433, `HARDWARE_DRIVER=fake`, `TEMPESTAS_TZ=America/Vancouver`. Port **5433**,
not 5432, because 5432 on this machine belongs to another project.

Both the app (`@nestjs/config`) and the migration CLI (`typeorm.config.ts`) read that one file, so a
value missing from it fails in two different-looking ways.

## Verify it works

```bash
curl -s localhost:7000/api/health | python3 -m json.tool     # {"status":"ok","db":true,...}
curl -s localhost:7000/api/nodes  | python3 -m json.tool
```

On first boot the fake driver announces two simulated nodes, so the log should contain a **WARN that
a node is pending** and, ten seconds later, a WARN that its readings are being discarded. That is
the admission gate working, not a problem — admit it:

```bash
NODE_ID=$(curl -s localhost:7000/api/nodes | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['id'])")
ZONE_ID=$(docker exec tempestas-db psql -U tempestas -d tempestas -tAc "select id from zones limit 1;")
curl -s -X POST localhost:7000/api/nodes/$NODE_ID/admit \
  -H 'Content-Type: application/json' -d "{\"zoneId\":\"$ZONE_ID\"}"
```

## The fake hardware driver

`HARDWARE_DRIVER=fake` spawns two simulated nodes with **deliberately different shapes** —
`sim-pi` (5 GPIO pins + a sensor) and `sim-esp32` (sensor only, no GPIO). That proves the multi-node
path and the capability model with zero hardware.

It is a **closed loop**: the burner raises temperature and CO2, the fan lowers them, on a diurnal
baseline. So the rules engine is genuinely exercised — burner on → CO2 climbs → rule turns it off.
Ticks every 10 s.

Anything other than `fake` or `mqtt` throws at boot rather than falling back to the simulator.

## Seeding a zone and a device

A device needs a node and a zone to exist first (FK order: `zones → nodes → devices`). Nodes create
themselves from `hello`; zones and devices do not:

```bash
docker exec -i tempestas-db psql -U tempestas -d tempestas <<'SQL'
INSERT INTO zones (slug, display_name, rules_config) VALUES (
  'greenhouse', 'Greenhouse',
  '{"enabledRoles":["co2_generator"],
    "sensorPolicy":{"default":{"source":"mean","maxAgeMs":120000}},
    "daylight":{"start":"06:30","end":"18:30"},
    "rules":{
      "lights":{"kind":"daylight-thermostat","mode":"heat","onAtC":26,"offAtC":27,"onStale":"hold"},
      "co2_generator":{"kind":"co2-burner","dayOffAtC":28,"nightOnBelowC":3,
                       "co2OnPpm":1400,"co2OffPpm":1500,"onStale":"hold"},
      "exhaust_fan":{"kind":"thermostat","mode":"cool","onAtC":30,"offAtC":29.5,"onStale":"hold"}},
    "timezone":"America/Vancouver"}'
) ON CONFLICT (slug) DO NOTHING;
SQL
```

The server validates this on every evaluation and refuses the whole zone on any error, naming it in
`GET /api/health` — see [Rules and Climate](../Rules%20and%20Climate.md#the-config-is-validated-strictly).

**Use `docker exec -i`.** Without `-i` stdin is not forwarded and the heredoc silently never
arrives — the command appears to succeed and inserts nothing.

## Running the checks

```bash
npx nx run-many -t lint,test,build     # the gate, always, before declaring work done
npx nx test server                     # one project
npx prettier --write .
```

`test` alone cannot catch a type error — Vitest transpiles without typechecking. See
[Testing](../Testing.md).

## Running against a real broker (phase 7+)

`HARDWARE_DRIVER=mqtt` needs a broker. Locally:

```bash
brew install mosquitto
/opt/homebrew/sbin/mosquitto -c tools/mosquitto.dev.conf     # loopback, anonymous

HARDWARE_DRIVER=mqtt MQTT_URL=mqtt://127.0.0.1:1883 npx nx serve server
node tools/virtual-node.cjs bench-pi 2 300                   # a node that speaks the contract
mosquitto_sub -h 127.0.0.1 -v -t 'tempestas/v1/#' -F '%I %t %r %p'
```

`tools/mosquitto.dev.conf` is **loopback and anonymous, for development only**. The real broker gets
`allow_anonymous false` with per-node credentials and ACLs — an MQTT write goes straight to a GPIO
pin and a propane burner, which is why [Safety](../Safety.md) ranks securing Mosquitto above every
other auth concern. Note that elantris's broker is deliberately still localhost-only.

The virtual node advertises five GPIO pins and one SCD4x, answers commands with a matching readback,
and implements the guards a real agent must. `kill -9` it to watch its last will fire; a clean exit
deliberately does not fire one.

Useful things to watch for on the bus:

```bash
# retained messages only - a COMMAND must never appear here
mosquitto_sub -h 127.0.0.1 -v -t 'tempestas/v1/#' -F '%t %r' --retained-only -W 3

# inject a rogue retained command; the server must alarm CONTROLLER_CONFLICT and clear it
mosquitto_pub -h 127.0.0.1 -r -q 1 -t 'tempestas/v1/node/bench-pi/gpio/set' \
  -m '{"schema":"gpioSet/1","node":"bench-pi","ts":"2026-01-01T00:00:00Z","id":"rogue",
       "issuedBy":"attacker","expiresAt":"2099-01-01T00:00:00Z","lines":[{"pin":16,"level":0}]}'
```

## Working against real hardware

MQTT hands you a better loop than remote development does. Because the transport is MQTT over the
LAN rather than in-process GPIO, **the Nx dev stack runs on the Mac and drives the actual sensor and
actual relays on elantris**:

```
Mac: nx serve web + nx serve server ──MQTT──► Mosquitto on elantris ──► real SCD4x + real relays
```

Full dev speed, real hardware, zero Pi RAM cost.

⚠ **Never run `nx serve` or a production build on the Pi.** VS Code Remote-SSH plus tsserver on an
Nx monorepo is 1–2 GiB, and an Angular dev server another 1.5–2.5 GiB, against 3.7 GiB total. That
puts Postgres and the sidecar in reach of the OOM killer, and on this box the OOM killer can take
out the burner controller. It is a safety problem wearing a performance costume.

**Remote-SSH is still fine, scoped:** open `apps/agent-linux/` as the Remote-SSH folder rather than the
monorepo root, so no tsserver indexes the TypeScript side. Use it for the sidecar, systemd units,
the Caddyfile and ops work.

Guard rail: only one controller may hold the heartbeat. Starting the Mac's NestJS must stop the
Pi's, or bump the controller `epoch` to take over cleanly.

## Troubleshooting

**`ECONNREFUSED 127.0.0.1:5433`** — `docker compose up -d`, then check `docker ps` shows
`tempestas-db` as healthy.

**Migrations say "already loaded" but a column is missing** — `npm run migration:show`. The CLI uses
`apps/server/src/typeorm.config.ts`, which loads `apps/server/.env`, and that is a different code
path from the running app's `@nestjs/config`.

**No readings appear** — check the log for `Discarding readings from "..."`. A node's readings are
discarded until it is admitted, by design.

**`ping elantris` fails** — ICMP is filtered. Use `nc -z elantris 22`.

**A lint or test target printed nothing and passed** — Nx cache hit. `--skip-nx-cache` if you are
chasing a flake.
