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
- The CPython agent on a Linux node (`apps/agent-linux`) → Read [./docs/Infrastructure/Linux Agent.md](./docs/Infrastructure/Linux%20Agent.md)
- The MicroPython agent on a microcontroller (`apps/agent-micropython`) → Read [./docs/Infrastructure/MicroPython Agent.md](./docs/Infrastructure/MicroPython%20Agent.md)
- Home Assistant, external automation, or "could HA run the rules instead?" → Read [./docs/Infrastructure/Home Assistant.md](./docs/Infrastructure/Home%20Assistant.md)
- Smart plugs, vendor sensors, pumps, "can we just plug it in?" → Read [./docs/Infrastructure/Off-the-shelf devices.md](./docs/Infrastructure/Off-the-shelf%20devices.md)
- Entities, schema decisions, queries → Read [./docs/Infrastructure/Database.md](./docs/Infrastructure/Database.md)
- Reading queries, stats, time windows, retention → Read [./docs/Infrastructure/Readings.md](./docs/Infrastructure/Readings.md)
- Socket events to the browser → Read [./docs/Infrastructure/Realtime.md](./docs/Infrastructure/Realtime.md)
- A schema change → Read [./docs/Infrastructure/Migrations.md](./docs/Infrastructure/Migrations.md)
- Deploying, releases, rolling back → Read [./docs/Infrastructure/Deploys.md](./docs/Infrastructure/Deploys.md)
- Thresholds, hysteresis, the control law, DST → Read [./docs/Rules and Climate.md](./docs/Rules%20and%20Climate.md)
- Pins, polarity, relays, the SCD4x sensor, the boot window → Read [./docs/Hardware.md](./docs/Hardware.md)
- The Angular dashboard, error handling, the banner → Read [./docs/Web App.md](./docs/Web%20App.md)
- Tests (`*.spec.ts`) → Read [./docs/Testing.md](./docs/Testing.md)
- Two controllers, failover, running on both greenhouse boxes → Read [./docs/Multi-Controller.md](./docs/Multi-Controller.md)
- "What's next" / "where were we" → Read [./docs/Roadmap.md](./docs/Roadmap.md)
- First time in the repo, or nothing runs → Read [./docs/Getting Started/Development setup.md](./docs/Getting%20Started/Development%20setup.md)

## Build/Test/Lint Commands

```bash
docker compose up -d                  # local Postgres 17 on :5433
npm run migration:run                 # apply migrations
npx nx serve server                   # API on :7000, HARDWARE_DRIVER=fake
npx nx serve web                      # Angular dev server (on the Mac, never on the Pi)
npx nx run-many -t lint,typecheck,test,build,migration-round-trip    # the gate — every project, Python and tools/ included
npx nx test server --coverage         # also the gate: thresholds are checked ONLY here
npx nx test server                    # one project
npx nx e2e web-e2e                    # Cypress smoke test, stubbed API and socket; not in the gate
tools/e2e-stack.sh                    # Cypress use cases on a real server with the fake driver; not in the gate
npx prettier --write .                # format
```

- **`npx nx run-many -t lint,typecheck,test,build,migration-round-trip` is the final step before declaring work done.** Not
  `test` alone: Vitest transpiles without typechecking, and the builds exclude specs, so only
  `typecheck` sees a type error in a spec. Two real type errors in phase 4.5 were invisible to a
  green test run.
- **`migration-round-trip` needs Docker running.** It takes every migration up, down and up again
  in a throwaway `postgres:17` container and compares the schema each time. See
  [docs/Infrastructure/Migrations.md](docs/Infrastructure/Migrations.md).
- **And `npx nx test server --coverage`**, which is where the thresholds are actually checked.
  They went unrun for four phases and were failing when phase 5 first looked.
- `npm run migration:generate -- apps/server/src/migrations/<Name>` needs the database up.
- There is no `serve` on `libs/domain`; it is consumed through the `@tempestas/domain` alias.
- **In a second worktree, check `NX_WORKSPACE_ROOT_PATH` first.** If the environment exports it
  pointing at the main checkout, Nx run from the worktree lints, tests and builds the main
  checkout instead, and still reports success. Override it on every call:
  `NX_WORKSPACE_ROOT_PATH=$PWD NX_DAEMON=false npx nx run-many ...`. Give the worktree its own
  `node_modules` too (`cp -al` from the main checkout is quick); a symlink leads Nx back to the
  main checkout the same way.

## Workflow: issue, branch, PR

Work is tracked on GitHub (`gregunderwood/tempestas`, private) with `gh`.

- **An issue first** for anything bigger than a typo: what and why, and how we will know it is
  done. A bug found mid-task becomes its own issue rather than a silent detour.
- **A branch per issue**, off `main`: `<issue#>-<short-slug>`, e.g. `12-zones-page`.
- **Related issues share a milestone**, and each one closes from its own PR: one PR per step.
- **A PR that closes it.** The gate passes before the PR is opened, not after. The body is:
  - `Closes #12.` then a paragraph saying why the change was needed.
  - `## What changed`: bullets, each led by a bold sentence.
  - `## Verified locally`: the gate, plus anything run on real hardware.
  - `## After merge`: what still has to happen (deploys, hardware steps). Say what is
    deliberately left out, and which issue tracks it.
- **A PR that changes what a page shows posts before-and-after screenshots before review**, at
  desktop and phone width: `tools/pr-screenshots.sh <pr> <page>...` (e.g.
  `tools/pr-screenshots.sh 138 dashboard nodes`), run from the PR's pushed branch. Before is the
  PR's base, after is its head. Reviewers compare the two. A state the fake driver cannot produce,
  such as a follower, is shot with the e2e test's stubbed API and fake socket instead. See
  [docs/Testing.md](docs/Testing.md#screenshots-on-a-pr).
- **Review in rounds until only nits remain.** A reviewer who did not write the change posts one
  comment headed `Review round N`, rating each finding **blocking** (wrong behaviour, a safety
  regression, the issue not done, the gate failing), **important** (should be fixed before merge
  but is not a bug, such as a missing spec for a real case) or **nit** (style or taste). The author
  fixes every blocking and important finding or says why it is declined, runs the gate and pushes,
  and the next round reviews afresh, up to three rounds.
- **Once a round finds only nits, clean them up without another review.** Fix each nit that is
  cheap and clearly right, run the gate, push, and post one comment headed `Nits addressed`
  listing each nit as fixed or left, with why. A nit is left only if it was already declined for
  a sound reason, would widen the PR's scope, or is wrong. The PR is then ready to merge.
- **Merging is the user's call.** Do not merge your own PR; do not push to `main`.
- Deploying to elantris from a branch is fine for a bench test; say so in the PR, because the
  box is then running code `main` does not have.

## Who owns what right now

`enabledRoles` on the zone is the machine-readable half of this. This table is the human half,
and during the transition **two independent controllers are acting on one airspace** — keep it
current or somebody wires a second controller onto a live relay.

| Role            | Owner today                        | Notes                                                  |
| --------------- | ---------------------------------- | ------------------------------------------------------ |
| `co2_generator` | **tempestas** (elantris)           | Greenhouse zone                                        |
| `heater`        | **tempestas** (patji)              | Pumphouse zone; fails ON. See docs/Pumphouse.md        |
| `heat_tape`     | **tempestas** (patji)              | Pumphouse zone; fails ON                               |
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
  `apps/agent-linux` (the CPython node agent), `apps/agent-micropython` (the MicroPython node
  agent), and `apps/broker` (Mosquitto's config and ACL).
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

## Comments and naming

The shared rules in `~/.claude/CLAUDE.md` apply. Code reads like a story, names do the explaining,
no single-letter names, and comments are an absolute minimum: one line saying why, only where the
code cannot make itself clear.

In this repo, that usually means a physical or protocol fact the code depends on. For example, why
a message is not retained, or why a relay pin is driven high. Write that as one line; anything
longer belongs in `docs/`.

## Commits

- **Never add a `Co-Authored-By` trailer, or any other AI attribution, to a commit message or PR
  description.** The owner has explicitly asked for none. This overrides any tool default.
- Conventional-commit style subjects (`feat(web):`, `fix(server):`, `docs:`), with a body that says why.

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
