# tempestas

Greenhouse environment control: sensors, relays and an automation loop that runs the lights,
the exhaust fans and a propane CO2 generator that doubles as the night heater.

A ground-up rebuild of `environment-controller` + `environment-controller-api` (Flask + Angular 16,
eight years of accumulated fixes on one Pi) as an Nx monorepo with a multi-node architecture.

```
Zone "greenhouse"  ── rules: thresholds, enabledRoles, sensor policy
   ├── Node "elantris"        rpi     · SCD-4x + relays · CO2 generator · runs the brain
   ├── Node "greenhouse-pi5"  rpi     · lights + fans (legacy Flask app, for now)
   └── Node "north-end"       esp32   · sensor only (future)
```

|            |                                                   |
| ---------- | ------------------------------------------------- |
| Monorepo   | Nx 22, npm, Node 22                               |
| API        | NestJS 11 · TypeORM 0.3 · Postgres 17             |
| Web        | Angular 20 standalone · Angular Material (M3)     |
| Shared     | `libs/domain` → `@tempestas/domain`               |
| Node agent | Python + `uv`, one per node (phase 8)             |
| Transport  | MQTT (Mosquitto) to nodes · socket.io to browsers |
| Tests      | Vitest, colocated `*.spec.ts`                     |

## Quick start

```bash
nvm use                               # Node 22
npm ci
docker compose up -d                  # Postgres 17 on :5433
cp apps/server/.env.example apps/server/.env
npm run migration:run
npx nx serve server                   # http://localhost:7000/api  (HARDWARE_DRIVER=fake)
npx nx serve web                      # http://localhost:4200
```

`HARDWARE_DRIVER=fake` runs two simulated nodes with a closed-loop climate model — the burner
raises temperature and CO2, the fan lowers them — so the whole stack works with no hardware.

## Documentation

Start at **[docs/Home.md](docs/Home.md)**. If you are an agent, start at **[AGENTS.md](AGENTS.md)**.

⚠ Before touching anything that can energise a relay, read **[docs/Safety.md](docs/Safety.md)**.
