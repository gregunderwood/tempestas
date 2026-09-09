# Roadmap

## What it is

Where the rebuild is, what each phase has to prove before it counts as done, and the questions that
need answering before the relevant stage. **This is the "where were we" document** — the previous
session's plan lived only in a chat transcript and had to be excavated from a `.jsonl` file.

Every phase ends in something runnable. **Phases 1–7 need no hardware and no sidecar** — the
`HARDWARE_DRIVER=fake|mqtt` seam is what buys that, which is why it was built in the first commit of
`app/hardware/` rather than retrofitted.

## Status

| #   | Phase                                                                                       | State                   | Checkpoint                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | Provision elantris: Node 22, swap, Postgres, Mosquitto                                      | **partial** — see below | `node -v` = v22.x · `psql -c 'select 1'` · `mosquitto_pub`→`sub` round-trip                                                                                                               |
| 1   | Nx workspace, generators, version pins, prettier/eslint/nvmrc                               | **done**                | `nx run-many -t lint,test,build` green · `tsconfig.base.json` has **`paths`**, not `references` · no `jest*` outside node_modules · `CYPRESS_INSTALL_BINARY=0` on the Pi                  |
| 2   | `libs/domain`: models, MQTT contract, gauge metrics, path alias, dep constraints            | **done**                | a throwaway `import { Reading }` compiles in **both** app builds                                                                                                                          |
| 3   | TypeORM config, entities, `InitialSchema`, seed                                             | **done**                | FK order `zones → nodes → devices → sensor_readings` · `\d+ devices` shows `UNIQUE (node_id, gpio)` and **no** unique index on `role` · revert drops cleanly                              |
| 4   | Devices module, pure `device-state.ts`, `FakeHardwareService`, interlock tests              | **done**                | CRUD + on/off/force-on via curl · a second `POST /on` returns **409** with `canTurnOnAt`                                                                                                  |
| 4.5 | **Node registry** — `hello` ingest, LWT → online, pending/admit lifecycle                   | **done**                | a `hello` for an unknown slug → **pending** row · a sample from it is **discarded** · admit → samples persist                                                                             |
| 5   | Rules engine (pure) + `ClimateResolver` + `enabledRoles` + tests                            | **done**                | with `enabledRoles: ['co2_generator']` and a lights device present, dropping the fake temp to 20 °C drives **only** the burner                                                            |
| 6   | Readings query surface, stats, retention cron, realtime gateway, health                     | **done**                | a socket client gets `reading:latest` every ~10 s and `device:state` on toggle                                                                                                            |
| 7   | `MqttHardwareService`; fake driver spawns **two virtual nodes** with different capabilities |                         | `mosquitto_sub -t 'tempestas/v1/node/+/#' -v` shows a **non-retained** `gpio/set` · hand-publish a sample → persists → evaluates → pushes · `mosquitto_pub -r` is dropped **and alarmed** |
| 8   | Python sidecar on elantris: sensor first, then GPIO                                         |                         | real SCD4x samples arriving over MQTT and landing in Postgres                                                                                                                             |
| 9   | Angular shell, routes, API services, error interceptor, M3 theme                            |                         | an induced 409 raises a snackbar; no `{error}`-in-200 handling anywhere in the source                                                                                                     |
| 10  | Gauge component, dashboard, readings screens                                                |                         | gauge colours match the old thresholds at boundary values; a `null` CO2 renders an em-dash                                                                                                |
| 11  | Devices screens (+ `role`, `onLevel`, node selector) and **nodes screens**                  |                         | `/nodes` becomes a real route with an admit flow                                                                                                                                          |
| 12  | Hardening: token guard, CORS, Mosquitto ACLs, CI on Node 22                                 |                         | `curl -X POST` without the token → 401; GETs unaffected                                                                                                                                   |

### Phase 0 is not finished

Verified on elantris (2026-09-08):

| Item      | State                                                       |
| --------- | ----------------------------------------------------------- |
| Postgres  | ✅ 17.11 native apt, service active                         |
| Mosquitto | ✅ 2.0.21, service active, `pub`→`sub` round-trip confirmed |
| Node 22   | ❌ **not installed** — no `~/.nvm/versions/node`            |
| Swap      | ❌ **none** (`swapon --show` is empty)                      |

Neither gap blocks phases 5–7, which run entirely on the Mac. Both block phase 8. Note the swap gap
against the memory pressure warnings in [Development setup](Getting%20Started/Development%20setup.md) —
the box has 3.7 GiB and no swap at all right now.

The Python side has been part-provisioned by hand: `swig`, `liblgpio-dev`, `python3-dev` and
`build-essential` are installed (the `lgpio` wheel will not build without the first two) and a
scratch venv at `~/scd-venv` validated `import board` → `RASPBERRY_PI_4B` and `adafruit_scd4x`
1.4.13. See [Hardware](Hardware.md).

### What phase 5 turned up

The live checkpoint exposed a real defect in the phase-4.5 ingest path, since fixed: the QoS-1
dedupe key was `(node_id, sensor_id, node_seq)`, but **a node's sequence counter restarts at 1 when
its agent restarts** - an ESP32 has nowhere cheap to persist one. Every sample after a node reboot
collided with the previous boot's rows and was dropped. The symptom is indistinguishable from a
stale sensor: readings simply stop, the rules engine holds last state, and nothing above debug level
says why. The key is now scoped to the node's `boot_id`.

That is the class of bug the live checkpoints exist to catch - it passed 153 unit tests and a clean
build, because every test mocked the repository that the constraint lives in.

Coverage thresholds were also failing, and had been unrun since they were written in phase 1. They
now pass at 98.8% lines / 100% functions over `app/devices` and `app/rules`, and `--coverage` is
part of the documented gate.

### What phase 6 decided

**`sensor_readings` will not be partitioned.** The plan called for range-partitioning by month from
day one, but Postgres requires a unique constraint on a partitioned table to include every partition
key column — and adding `created_at` to the QoS-1 dedupe key destroys it, since a redelivered
duplicate carries a different `created_at`. Duplicate rows mean duplicate rules evaluations, so the
dedupe wins. At 90-day retention this table is ~1.5M rows steady state, which needs no partitioning.
Revisit if retention passes a year or the node count reaches double figures.

**Insert batching is deferred, not forgotten.** Buffering 6 samples and writing every 60 s would cut
commits 6×, but the rules engine reads the latest reading per node from this table every 10 s — a
60 s buffer puts every control decision up to a minute behind the sensor and adds a crash window.
If SD write volume becomes binding, boot from a USB3 SSD (open question 5) instead.

**Stats windows are settled**, which closes open question 7: `to` is never in the future, `days=n`
is calendar-aligned through the zone's timezone, no parameters means a rolling 24 hours, and a
reversed range is refused rather than swapped.

Phase 7 is the highest-value checkpoint in the plan: it validates the entire node contract **before
any sidecar exists**, and the two-virtual-node trick proves the multi-node path with zero hardware.

### What phase 4.5 left for later

- `online` stays `true` after the server stops in `fake` mode (no broker, no LWT). Real MQTT's
  retained status resolves it — phase 7.
- The literal `mosquitto_pub` form of the 4.5 checkpoint needs the MQTT driver — phase 7.
- A `disabled` node is refused commands in **both** directions, so the API cannot turn a burner off
  on a node you just disabled. Deliberate: the node's own dead-man should drop that line (phase 8),
  not a command from a server that declared the node untrusted. Revisit if the dead-man work changes
  the reasoning.

## Hardware bring-up and cutover

Software phases and hardware stages are independent; nothing below needs phases beyond 8.

**Stage A — the one cheap purchase worth making first.** If there is no independent backup heat, an
off-system **bimetal thermostat plus a small electric heater set to ~2 °C** decouples "don't freeze"
from "the software is healthy". Every dead-man decision downstream gets easier and more aggressive
once it exists, and a bad deploy at 2 a.m. in January stops being a crop-loss event. A **CO alarm**
is the other cheap independent device worth having near a burner.

**Stage B — sensor only, on the bench.** Run `scd4x_healthcheck.py`, record the serial and
self-test. Bring the agent up in **sim mode** first and verify the whole topic tree with
`mosquitto_sub -v`. Then switch to the real sensor with **`gpio.lines` empty** — the agent
physically cannot touch a pin. Run 48 h against greenhouse's live stream; different rooms, so expect
an offset, but the shape and CO2 baseline should track. Tune `temperature_offset_c`.

**Stage C — relays on the bench, nothing connected to the greenhouse.** This stage exists to answer
the boot-window hazard empirically. Do not skip a step:

1. Baseline `gpioget` before any change (captured: all `inactive`).
2. Add the `gpio=` defaults to `config.txt`, reboot, re-check — expect `active active active active
inactive`. This proves the boot-window fix.
3. Connect the relay board with **no mains load, LEDs only**. Power-cycle and watch which relays
   click during boot. **If any active-low relay energises before the agent starts, external
   pull-ups are mandatory before mains.**
4. `kill -9` the agent and watch the gap. Same test, same conclusion.
5. Verify the safety surface against the LEDs: readback failure, dead-man trip, max-on latch,
   min-dwell clamp, retained-command rejection, expired-command rejection.
6. Then mains loads **one at a time in ascending order of consequence**: exhaust fan → lights →
   single light → extra relay → **CO2 generator last**.

**Stage D — shadow mode.** Move elantris into the greenhouse, sensor connected, **relays connected
to nothing**, global `dry_run: true` so NestJS computes and publishes intent that the agent logs but
never actuates. Diff the two decision streams for **3–7 days spanning at least one cold night and
one hot day**. Every divergence is a rules-porting bug. This is nearly free — the two Pis coexist
happily because only one is wired — and it is the only way to find those bugs before they can hurt
anything.

**Stage E — cutover, on a mild day, mid-morning, with a person present.** `pg_dump` greenhouse
first. Stop and disable the three old units; power the Pi 5 down but **do not wipe it**. Move the
wiring pin-for-pin. **Power on with the gas valve still shut** and confirm no relay clicks at boot;
then `dry_run: false` and watch a full cycle on fan and lights only. Open the gas valve, observe one
complete burner cycle with the CO alarm in the room. Watch 24 h.

Then one role at a time, each rollback a single config edit: add the legacy system as a `virtual`
node so vent state is visible to the burner rule → reflash the Pi 5 to arm64 and admit it as a node
→ move `exhaust_fan` into `enabledRoles`, verify a full day, then `lights`.

**Rollback:** the old Pi is untouched and one wire-swap away — target under 15 minutes. **Rehearse
it once in daylight before the real cutover**; a rollback first performed at 1 a.m. in a cold
greenhouse is not a rollback procedure. Keep a printed card in the greenhouse with the commands and
wiring, and don't reformat the Pi 5's SD card for at least a month.

## Deployment (phases 8+, not yet built)

| Component               | Runtime                                                       | Why                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Python node agent       | **native systemd**                                            | Needs `/dev/gpiochip0`, `/dev/i2c-1`, group membership — and must start even if dockerd is broken. Never put a container runtime in front of the safety-critical process |
| Mosquitto               | **native systemd**                                            | The agent depends on it; keep the whole safety path Docker-free (~8 MiB)                                                                                                 |
| Postgres 17             | **native apt**                                                | One canonical data directory managed by `pg_ctlcluster`, no bind-mount path to typo. Saves ~200 MiB of duplicated page cache on a 3.7 GiB box                            |
| NestJS + Angular bundle | **Docker**, built on the Mac, pushed to GHCR, pulled over SSH | The Mac is arm64, so images build natively with no QEMU                                                                                                                  |

Other decisions already made: **Caddy** over nginx (automatic WebSocket upgrade — the
`map $http_upgrade` footgun is sitting in the current greenhouse nginx.conf; SPA fallback in one
line). **Tailscale** rather than ngrok. Plain HTTP on the LAN; never exposed to the internet.
Hardware watchdog on. Nightly `pg_dump -Fc` **pushed off-box** to the Mac — a backup living only on
the same SD card is not a backup — plus one restore drill, because an untested backup is a
hypothesis. Keep `/etc/tempestas/`, the Mosquitto config, the Caddyfile and all units **in the
repo**, installed by a `provision.sh`, so Postgres is the only stateful thing.

The app and agent write JSON to **stdout and own no files**; journald caps itself
(`SystemMaxUse=200M`, `MaxRetentionSec=14day`). That is the structural fix for the old system's
5.4 GB log — it grew unbounded because the app owned its own file and nothing capped it.

## Open questions

Answer each before its stage, not before starting.

1. **What does "Extra Relay" (BCM 12) actually control?** `on_delay_duration = 0` suggests something
   benign, but it is unknown and active-LOW. Identify it before it is ever wired to elantris.
   _(Blocks Stage C step 6.)_
2. **Does the relay board have input pull-ups, and is it low-level-trigger with a jumper?** This
   decides whether external pull-ups are mandatory. Ten minutes with a multimeter, and it gates the
   whole relay bring-up. _(Blocks Stage C.)_
3. **How long should a node hold the burner on at night after losing the brain?** The one dead-man
   case that isn't obvious, since the burner is the night heater. Long enough to ride out a restart
   or a WiFi blip; short enough that a dead controller doesn't leave it burning until morning.
   _(Blocks phase 8.)_
4. **Is there any independent backup heat?** If yes, the dead-man can be aggressive and question 3
   gets easy. If no, the hold has to be long, and Stage A is the single best resilience purchase
   available.
5. **Boot elantris from a USB3 SSD?** Strong recommendation. One hour, removes the SD endurance
   question permanently.
6. **Confirm one dashboard, not one per node.** The web UI is served only by elantris; other nodes
   are agents with no UI.
7. ~~**Stats default window.**~~ **Answered in phase 6:** a rolling 24 hours by default, `days=n`
   aligned to local midnight, and `to` clamped so it is never in the future. See
   [Readings](Infrastructure/Readings.md#how-a-query-becomes-a-window).

## Known platform risks

- **Never build or `nx serve` on the Pi.** See [Development setup](Getting%20Started/Development%20setup.md).
- **Cypress ships no official arm64 Linux binary.** `CYPRESS_INSTALL_BINARY=0` on the Pi; e2e on the
  Mac only.
- **Angular Material 20 is M3 and dropped `deeppurple-amber`**, the theme the current app uses.
  Take a prebuilt (`azure-blue`) or define a custom M3 theme. Budget an hour; don't discover it in
  phase 9.
- **SD card writes** ~150–250 MB/day before amplification. Mitigations in [Hardware](Hardware.md).
- **Boot-state divergence** between server and node after either restarts — mitigated by a full
  desired-state sync on connect plus retained per-pin state topics, so divergence is detectable.

## When to update this file

- A phase is finished (move it to **done**, and record anything it deferred)
- A checkpoint changes
- An open question is answered — replace it with the decision, in the doc where the decision belongs
- A bring-up stage completes
