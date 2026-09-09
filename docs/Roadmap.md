# Roadmap

## What it is

Where the rebuild is, what each phase has to prove before it counts as done, and the questions that
need answering before the relevant stage. **This is the "where were we" document** — the previous
session's plan lived only in a chat transcript and had to be excavated from a `.jsonl` file.

Every phase ends in something runnable. **Phases 1–7 need no hardware and no sidecar** — the
`HARDWARE_DRIVER=fake|mqtt` seam is what buys that, which is why it was built in the first commit of
`app/hardware/` rather than retrofitted.

## Status

| #   | Phase                                                                                       | State           | Checkpoint                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | Provision elantris: Node 22, swap, Postgres, Mosquitto                                      | **done**        | `node -v` = v22.x · `psql -c 'select 1'` · `mosquitto_pub`→`sub` round-trip                                                                                                               |
| 1   | Nx workspace, generators, version pins, prettier/eslint/nvmrc                               | **done**        | `nx run-many -t lint,test,build` green · `tsconfig.base.json` has **`paths`**, not `references` · no `jest*` outside node_modules · `CYPRESS_INSTALL_BINARY=0` on the Pi                  |
| 2   | `libs/domain`: models, MQTT contract, gauge metrics, path alias, dep constraints            | **done**        | a throwaway `import { Reading }` compiles in **both** app builds                                                                                                                          |
| 3   | TypeORM config, entities, `InitialSchema`, seed                                             | **done**        | FK order `zones → nodes → devices → sensor_readings` · `\d+ devices` shows `UNIQUE (node_id, gpio)` and **no** unique index on `role` · revert drops cleanly                              |
| 4   | Devices module, pure `device-state.ts`, `FakeHardwareService`, interlock tests              | **done**        | CRUD + on/off/force-on via curl · a second `POST /on` returns **409** with `canTurnOnAt`                                                                                                  |
| 4.5 | **Node registry** — `hello` ingest, LWT → online, pending/admit lifecycle                   | **done**        | a `hello` for an unknown slug → **pending** row · a sample from it is **discarded** · admit → samples persist                                                                             |
| 5   | Rules engine (pure) + `ClimateResolver` + `enabledRoles` + tests                            | **done**        | with `enabledRoles: ['co2_generator']` and a lights device present, dropping the fake temp to 20 °C drives **only** the burner                                                            |
| 6   | Readings query surface, stats, retention cron, realtime gateway, health                     | **done**        | a socket client gets `reading:latest` every ~10 s and `device:state` on toggle                                                                                                            |
| 7   | `MqttHardwareService`; fake driver spawns **two virtual nodes** with different capabilities | **done**        | `mosquitto_sub -t 'tempestas/v1/node/+/#' -v` shows a **non-retained** `gpio/set` · hand-publish a sample → persists → evaluates → pushes · `mosquitto_pub -r` is dropped **and alarmed** |
| 8   | Python sidecar on elantris: sensor first, then GPIO                                         | **in progress** | real SCD4x samples arriving over MQTT and landing in Postgres                                                                                                                             |
| 9   | Angular shell, routes, API services, error interceptor, M3 theme                            | **done**        | an induced 409 raises a snackbar; no `{error}`-in-200 handling anywhere in the source                                                                                                     |
| 10  | Gauge component, dashboard, readings screens                                                | **next**        | gauge colours match the old thresholds at boundary values; a `null` CO2 renders an em-dash                                                                                                |
| 11  | Devices screens (+ `role`, `onLevel`, node selector) and **nodes screens**                  |                 | `/nodes` becomes a real route with an admit flow                                                                                                                                          |
| 12  | Hardening: token guard, CORS, Mosquitto ACLs, CI on Node 22                                 |                 | `curl -X POST` without the token → 401; GETs unaffected                                                                                                                                   |

### Phase 0, as actually provisioned

Checkpoint verified on elantris: `node -v` = v22.x, `psql -c 'select 1'`, and a
`mosquitto_pub`→`mosquitto_sub` round-trip. All three pass.

| Item         | State                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Postgres     | ✅ 17.11 native apt, service active                                                                                      |
| Mosquitto    | ✅ 2.0.21, active, round-trip confirmed. **Listener is loopback-only** — see below                                       |
| Node 22      | ✅ v22.23.2 via nvm, arm64 prebuilt, `default` alias set                                                                 |
| Swap         | ✅ zram 2 GiB at priority **100**, plus a 1 GiB `/var/swapfile` at priority **-2**                                       |
| journald cap | ✅ `99-tempestas.conf`: persistent, 200M cap, 25M/file, 14-day retention, compressed, rate-limited, `ForwardToSyslog=no` |
| Timezone     | ✅ America/Vancouver — but the app still resolves `TEMPESTAS_TZ`, never the host                                         |

Two corrections to an earlier survey of this box, both from looking in the wrong place:

- **Swap was never missing.** The first check ran `swapon --show`, which lives in `/usr/sbin` and is
  not on the login PATH, and its empty output was read as "no swap". `free -h` had shown 2 GiB all
  along, backed by zram. `/usr/sbin` is now on the PATH in `~/.profile` so that is harder to repeat.
- **The journald cap was already applied**, in `/etc/systemd/journald.conf.d/99-tempestas.conf`, and
  more thoroughly than the plan asks: persistent storage, a 200M cap with 25M per file, 14-day
  retention, compression, rate limiting and `ForwardToSyslog=no` so nothing is written twice. The
  first check read only `/etc/systemd/journald.conf` and missed the drop-in directory.

The disk swapfile is a deliberate substitution for the plan's 2 GiB `dphys-swapfile`: zram is
RAM-backed, so it does not help when RAM itself is exhausted, and the plan's stated justification for
disk swap — Angular production builds — is something since ruled out on this box entirely. A 1 GiB
file at the lowest priority is a backstop against the OOM killer reaching the burner controller, and
because zram sits at priority 100 the kernel exhausts that first, so in normal running the file is
never touched.

### Still open on this box

- **The Mosquitto listener is loopback-only** (Mosquitto 2.x default). That is fine for phase 8,
  where the sidecar runs on the box, and it blocks the Mac-drives-real-hardware loop that
  [Development setup](Getting%20Started/Development%20setup.md) describes. Opening it needs
  `allow_anonymous false` with per-node credentials and ACLs applied at the same time — an MQTT
  write goes straight to a GPIO pin and a propane burner — so it is a deliberate step.
- **The systemd watchdog is deliberately NOT enabled**, and the ordering is why: a watchdog reboot is
  only safe once `/boot/firmware/config.txt` carries the `gpio=` defaults, and it does not yet.
  Enabling it first would mean a kernel hang reboots into a boot window that commands the burner
  relay on. Firmware defaults first (Stage C step 2), watchdog second.
- **The sudo password is unchanged, by decision (2026-09-09).** It was written into `/etc/fstab` and
  a journald drop-in during phase 0 provisioning by a `sudo -S` wrapper that ate stdin; both files
  have been cleaned. The box is LAN-only, has no relays wired and nothing exposed, so rotation waits
  until the system is running rather than interrupting bring-up. Do it before anything is wired to
  mains, and note the same string is reused as a seeded dev-app password elsewhere.
- **Postgres SD-card tuning is deferred.** `synchronous_commit = off`, `wal_compression = on`,
  `shared_buffers = 256MB`, `checkpoint_timeout = 15min` are still to apply, and nothing uses that
  database yet — the server runs against Docker Postgres on the Mac. It belongs with deployment.

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

### What phase 7 found

The checkpoint was run against a real Mosquitto with `tools/virtual-node.cjs`, and it earned its
billing as the highest-value check in the plan. Three defects surfaced that no unit test would have:

**The retain flag does not detect a retained command.** A retained `gpio/set` published while the
server and node were both connected arrived with `retain=0`, the node obeyed it, and it stayed on
the bus to replay on every future reconnect. MQTT only sets that flag when delivery is _caused by a
new subscription_. The server now rejects any command it did not issue as `CONTROLLER_CONFLICT` and
clears the retained slot; delivery can only be stopped by broker ACLs. See
[MQTT Contract](Infrastructure/MQTT%20Contract.md#the-retained-command-trap).

**A graceful disconnect fires no will.** A virtual node calling `client.end()` produced no LWT at
all, and the registry went on reporting it online. The will covers a crash, not an orderly stop, so
anything that stops cleanly must publish its own retained `status: offline` first.

**An offline node was a 500.** The driver threw a bare `Error`, so an expected condition reached the
client as "Internal server error" with nothing to branch on — the exact failure mode this project
exists to remove. Hardware failures now carry an `ApiErrorCode` and translate: `NODE_OFFLINE` and
`READBACK_MISMATCH` to 409, `HARDWARE_UNREACHABLE` to 503.

Also worth recording, because it validated a design decision: the node's retained `status` and its
first sample both arrived **before** its `hello`. Both were correctly refused — registration needs
capabilities and only `hello` carries them.

### Phase 8 / Stage B so far

The agent is built and running against the real SCD41 on elantris, publishing real samples over
MQTT. What is done and what is not:

| Stage B step                                              | State                                           |
| --------------------------------------------------------- | ----------------------------------------------- |
| 1. `scd4x_healthcheck.py`, record serial and self-test    | ✅ serial `5fd90b073b7a`, self-test PASS        |
| 2. Agent in **sim mode**, whole topic tree verified       | ✅ against the Mac's broker and the real server |
| 3. Real sensor with `gpio.lines` **empty**                | ✅ on elantris, sensor-only, no chip opened     |
| 4. 48 h against greenhouse's live stream, tune the offset | 🔄 **running since 2026-09-09 20:06Z**          |

Both run under systemd and survive a reboot — verified by rebooting the box, which also confirmed
the `/etc/fstab` swap repair holds. `tempestas-stage-b-soak.service` writes one CSV row a minute to
`~/tempestas/soak/stage-b-soak.csv`, with elantris's own sample beside the greenhouse's live reading.

**Baseline at the start of the soak** (elantris indoors, greenhouse in the sun):

|             | elantris                | greenhouse     |
| ----------- | ----------------------- | -------------- |
| Temperature | ~18.8 °C                | ~29.6 °C       |
| Humidity    | ~83 %                   | ~67 %          |
| CO2         | ~810 ppm, rising slowly | ~410 ppm, flat |

Two things to read out of the soak, in this order:

1. **Does the shape track?** Different rooms, so the absolute values are not supposed to match. What
   must track is the diurnal shape and the CO2 baseline behaviour.
2. **Is `temperature_offset_c` too large?** The chip holds **6.56 °C**. A settled indoor reading of
   18.8 °C at 83 % RH is a suspicious pair: the SCD4x derives humidity through the same temperature
   compensation, so an offset that is too big reads _cold and damp together_ — which is this shape.
   Check both against a reference thermometer and hygrometer in the same spot before concluding
   anything. Note also that the first few minutes after a restart are warm-up transient: this run
   opened at 20.7 °C / 75 % and settled over about five minutes.

### Mounting the Pi does not have to wait for the soak

Worth separating two things the plan runs together: **mounting the Pi to the panel is not the same
as wiring its GPIO.** The Stage B posture is `gpio.lines = []`, which is enforced by the agent
having no GPIO backend at all - so the Pi can be screwed to the panel, powered, and moved, with the
relay ribbon simply not connected, and nothing about that posture changes. Leave the relay board
unpowered too, and there is no path to a relay at all.

That matters because of what the bench soak can and cannot tell us:

- **Shape and CO2 baseline: valid now.** Two sensors in different rooms should still track each
  other's diurnal shape, and the CO2 baseline behaviour is informative wherever the box sits.
- **The temperature offset: not really.** The plan is explicit that the offset must be tuned "at the
  installed self-heating equilibrium, not in open air". A Pi on a bench and a Pi mounted on a panel
  beside eight relay coils are different thermal environments, so an offset tuned now has to be
  re-tuned after mounting regardless.

Which suggests a better sequence than the plan's, and it is strictly less work:

1. Let the bench soak run long enough to confirm shape and plumbing - it has already proved the
   pipeline end to end.
2. Mount the Pi to the panel, **relay ribbon disconnected, relay board unpowered**.
3. Move the panel into the greenhouse.
4. Re-run the soak there. Now both sensors are in **the same air**, so the difference between them
   is the offset error rather than a room difference - a direct calibration instead of an inference
   - and the Pi is at its real installed equilibrium.

Step 4 is a better instrument than the plan's step 4, because "different rooms, so expect an offset"
stops being a caveat and becomes a measurement.

### Stage C, partially done

The bench sequence is further along than the phase table suggests, because the panel arrived built:

| Stage C step                                          | State                                                 |
| ----------------------------------------------------- | ----------------------------------------------------- |
| 1. Baseline `gpioget` before any change               | ✅ all lines inactive                                 |
| 2. `gpio=` defaults in `config.txt`, reboot, re-check | ⬜ **not needed on this board** — see open question 2 |
| 3. Relays connected, watch for clicks during boot     | ✅ all three stayed de-energised through a full boot  |
| 4. `kill -9` the agent and watch the gap              | ⬜ moot until the agent owns the lines                |
| 5. Verify the safety surface against the LEDs         | ⬜ needs the `lgpio` backend                          |
| 6. Loads one at a time, burner last                   | 🔄 **channel 6 switches its load; 7 and 8 do not**    |

Channels 7 and 8 energise but no power reaches their outlets — an output-side wiring fault, not
diagnosed yet, and not blocking: both are sound from the controller's side. The burner therefore
moves to **channel 6** with the standing condition that only one of its two ganged outlets is ever
occupied. See [Hardware](Hardware.md#elantriss-own-relay-board).

GPIO is **not** implemented and that is deliberate — see
[Node Agent](Infrastructure/Node%20Agent.md#the-stage-b-posture). Deployment (a systemd unit, the
`flock`, `Type=notify`, `OOMScoreAdjust`) is also still to do; the agent has only been run in the
foreground.

The samples currently reach elantris's own broker, which is loopback-only, so they do not reach the
server on the Mac. Closing that loop needs the broker listener decision above.

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
6. Then loads **one at a time in ascending order of consequence**. On elantris's panel this is far
   easier than the plan assumed, because loads plug in rather than being wired: a desk lamp into
   relay 1's outlet, watch it switch, unplug it; repeat per channel; **the CO2 generator last**,
   into a socket already proven with something harmless.

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

1. ~~**What does "Extra Relay" (BCM 12) control?**~~ **Moot for elantris (2026-09-09).** That was the
   greenhouse Pi 5's mystery channel. elantris has its own panel with three known outlet-wired
   relays and five unwired ones, so nothing unidentified is in reach. The question still stands for
   the Pi 5 itself, before that board is ever touched again.
2. ~~**Relay board polarity, pull-ups and JD-VCC.**~~ **Answered on the bench, 2026-09-09.**
   - **Active LOW, measured.** Driving a line low energises; releasing it de-energises. Confirmed on
     all three wired channels.
   - **The boot window is clean on this board.** BCM 4, 5 and 6 come up as unclaimed inputs held
     high by their internal pull-ups, and all three relays stayed de-energised through a full boot,
     observed directly. The opto isolation plus a ~1.8 kΩ series resistor means the Pi's ~50 kΩ
     pull-down could never deliver the milliamps an optocoupler needs. The firmware `gpio=` defaults
     and external pull-ups drop from mandatory to belt-and-braces **on this board** — they remain
     mandatory on the greenhouse Pi's directly-driven one.
   - **Logic runs at 5 V with the jumper fitted**, reversing an earlier recommendation in these
     docs. See [Hardware](Hardware.md#drive-the-logic-side-at-5-v-jumper-fitted).

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
