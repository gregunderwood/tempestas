# Agent Guidelines for tempestas

Quick-reference cheat sheet. For deeper docs, follow the links into `docs/`.

**This system runs a propane CO2 generator that doubles as the greenhouse's night heater.**
Getting a relay wrong can kill a crop or start a fire. That is why the safety doc is first in
every list below, and why "it compiles and the tests pass" is not the bar here.

## Before starting any response, ask yourself, does this involve:

- **Anything that can energise a relay, or any GPIO / dead-man / retain / failsafe question** → Read [./docs/Safety.md](./docs/Safety.md) **first**. Non-negotiable.
- **Any code changes** → Read [./docs/Code Quality.md](./docs/Code%20Quality.md) (TS strict, explicit return types, DTO/interface split, comments policy)
- Where a thing belongs / zones vs nodes vs devices / the hardware seam → Read [./docs/Architecture.md](./docs/Architecture.md)
- The MQTT topics, payloads, QoS or retain flags → Read [./docs/Infrastructure/MQTT Contract.md](./docs/Infrastructure/MQTT%20Contract.md)
- Node registration, admission, capabilities, `pending` → Read [./docs/Infrastructure/Nodes.md](./docs/Infrastructure/Nodes.md)
- The Python agent on a node (`apps/hardware`) → Read [./docs/Infrastructure/Node Agent.md](./docs/Infrastructure/Node%20Agent.md)
- Home Assistant, external automation, or "could HA run the rules instead?" → Read [./docs/Infrastructure/Home Assistant.md](./docs/Infrastructure/Home%20Assistant.md)
- Entities, schema decisions, queries → Read [./docs/Infrastructure/Database.md](./docs/Infrastructure/Database.md)
- Reading queries, stats, time windows, retention → Read [./docs/Infrastructure/Readings.md](./docs/Infrastructure/Readings.md)
- Socket events to the browser → Read [./docs/Infrastructure/Realtime.md](./docs/Infrastructure/Realtime.md)
- A schema change → Read [./docs/Infrastructure/Migrations.md](./docs/Infrastructure/Migrations.md)
- Thresholds, hysteresis, the control law, DST → Read [./docs/Rules and Climate.md](./docs/Rules%20and%20Climate.md)
- Pins, polarity, relays, the SCD4x sensor, the boot window → Read [./docs/Hardware.md](./docs/Hardware.md)
- Tests (`*.spec.ts`) → Read [./docs/Testing.md](./docs/Testing.md)
- "What's next" / "where were we" → Read [./docs/Roadmap.md](./docs/Roadmap.md)
- First time in the repo, or nothing runs → Read [./docs/Getting Started/Development setup.md](./docs/Getting%20Started/Development%20setup.md)

## Build/Test/Lint Commands

```bash
docker compose up -d                  # local Postgres 17 on :5433
npm run migration:run                 # apply migrations
npx nx serve server                   # API on :7000, HARDWARE_DRIVER=fake
npx nx serve web                      # Angular dev server (on the Mac, never on the Pi)
npx nx run-many -t lint,test,build    # the gate — all five projects, Python included
npx nx test server --coverage         # also the gate: thresholds are checked ONLY here
npx nx test server                    # one project
npx prettier --write .                # format
```

- **`npx nx run-many -t lint,test,build` is the final step before declaring work done.** Not
  `test` alone: Vitest transpiles without typechecking, so only the webpack/Angular builds
  catch a type error. Two real type errors in phase 4.5 were invisible to a green test run.
- **And `npx nx test server --coverage`**, which is where the thresholds are actually checked.
  They went unrun for four phases and were failing when phase 5 first looked.
- `npm run migration:generate -- apps/server/src/migrations/<Name>` needs the database up.
- There is no `serve` on `libs/domain`; it is consumed through the `@tempestas/domain` alias.

## Who owns what right now

`enabledRoles` on the zone is the machine-readable half of this. This table is the human half,
and during the transition **two independent controllers are acting on one airspace** — keep it
current or somebody wires a second controller onto a live relay.

| Role            | Owner today                        | Notes                                                  |
| --------------- | ---------------------------------- | ------------------------------------------------------ |
| `co2_generator` | **tempestas** (elantris)           | The first and only role tempestas owns                 |
| `exhaust_fan`   | legacy Flask app (greenhouse Pi 5) | Moves over after a full day of verified burner control |
| `lights`        | legacy Flask app (greenhouse Pi 5) | Moves last                                             |

Creating a device row for a role tempestas does not own is **safe** — ownership is explicit in
`enabledRoles`, never inferred from which device rows exist. See [docs/Architecture.md](docs/Architecture.md).

## Architecture

See [docs/Architecture.md](docs/Architecture.md) for full details.

- **Multi-node greenhouse controller.** A _zone_ is an airspace and owns the rules; a _node_ is a
  wiring identity (which box holds this pin); a _device_ is a relay-controlled thing on a node.
- **Rules scope to the zone, not the node** — a rule reads a sensor at one end of the greenhouse
  and actuates a relay at the other.
- **Nx monorepo**: `apps/server` (NestJS), `apps/web` (Angular), `libs/domain` (shared contract),
  `apps/hardware` (Python node agent, phase 8).
- **One seam to hardware**: the abstract `HardwareService`. Nothing outside `app/hardware/` may
  import `mqtt`. `HARDWARE_DRIVER=fake|mqtt` is what lets everything be built and tested with no
  Pi, no sidecar and no relays.
- **NestJS never branches on node kind.** It asks "does this node expose pin N?" and "which
  metrics does this sensor publish?", both answered by `capabilities`. That is what makes adding
  a Pi, or an ESP32, data rather than code.

## Safety rules that constrain ordinary code

The full set with reasoning is in [docs/Safety.md](docs/Safety.md). These four get broken by
accident most often:

- **Commands are never retained.** A retained `gpio/set` replays a burner-on command on every
  reconnect. State and status are retained; commands are not.
- **Stale is not off.** When a node drops, its pins become _unknown_, not `0`. Only a fresh
  retained `gpio/state` or a successful sync restores known state.
- **Publish first, persist only on success.** The old system logged a failed GPIO write and
  updated the row anyway, so the UI confidently showed a heater running when it was not.
- **A null CO2 means unknown, never zero.** It coerces to `+Infinity` so the daytime enrichment
  branch stays off. A dead sensor stuck low would otherwise run the burner forever.

## Code Style

See [docs/Code Quality.md](docs/Code%20Quality.md) for full details.

- TypeScript strict, **explicit return types on every exported function and method**
- `@tempestas/domain` for anything crossing a process boundary; interfaces and consts only, no
  framework imports (enforced by `@nx/enforce-module-boundaries`)
- NestJS DTO classes live in the server and `implements` the shared interface, so class-validator
  never reaches the browser bundle
- Errors are real HTTP status codes with a machine-readable `ApiErrorCode` — never `{error}` in a 200
- Pure logic (interlocks, rules) lives in its own file with no `new Date()`; time enters as an argument
- Prettier: single quotes, 2 spaces
- Tests colocated as `*.spec.ts`, Vitest only — no Jest artifacts anywhere

## Comments

Comments here carry **safety and hardware rationale**, and that is a deliberate departure from
the house style in other Sign In Solutions repos. The bar is still high, just aimed differently:

- **Do** record why a line is safe, what breaks if it is reordered, and the physical or protocol
  fact behind a constant. A future session re-deriving "why is this not retained?" from scratch is
  the failure mode being prevented — this is a one-maintainer system controlling combustion.
- **Don't** restate what the code says. `// find the node by slug` above a `findOne({where:{slug}})`
  is noise; delete it.
- **Don't** reference tickets, PRs, phases-in-flight, or "as discussed" — the docs and the commit
  history are the time capsule. A comment reads as current understanding.
- **Don't** speculate about future problems. If it becomes real, fix it then.
- If a block needs a paragraph to explain _what it does_, simplify the block. A paragraph
  explaining _why it must be this way_ is fine and often required.

## Pitfalls that have already bitten

- **`hello` is not retained**, so a subscriber that attaches late never sees it. The fake driver
  announces from `onApplicationBootstrap` for exactly this reason — Nest runs every
  `onModuleInit` first, so the registry is subscribed before any node speaks.
- **Postgres reorders `jsonb` object keys.** Comparing `capabilities` with `JSON.stringify` logs a
  false "capabilities changed" on every restart. Compare key sets, not serialisations.
- **A node's sequence counter restarts at 1 when its agent restarts.** Anything keyed on `node_seq`
  must also be keyed on the node's `boot_id`, or it silently drops everything after a reboot — which
  presents as a stale sensor, not as an error.
- **The MQTT retain flag is only set when delivery is caused by a new subscription.** A retained
  command published to an already-connected client is indistinguishable from a real one. Detect
  foreign commands by ownership (`issuedBy`), never by the retain flag.
- **A graceful MQTT disconnect fires no last will.** Anything stopping cleanly must publish its own
  retained `status: offline`.
- **A hardware failure must carry an `ApiErrorCode`.** A bare `Error` from the driver becomes a 500
  that no client can branch on; `DevicesService` translates `HardwareError` into a real status.
- **A mocked repository cannot fail a database constraint.** The dedupe bug above passed 153 unit
  tests and a clean build. Where a constraint carries the guarantee, verify it against real
  Postgres.
- **Never `synchronize: true`.** Schema changes go through reviewed migrations.
- **Never build or run `nx serve` on the Pi.** An Angular dev server plus tsserver puts Postgres
  and the sidecar in reach of the OOM killer, and the OOM killer can take out the burner
  controller. Develop on the Mac against the Pi's real hardware over MQTT.
