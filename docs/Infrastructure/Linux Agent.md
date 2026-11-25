# Linux Agent

## What it is

`apps/agent-linux` — one Python process per node. It owns that box's sensor and (later)
its relays, and speaks the MQTT contract. Everything else in the system talks to hardware
only through it.

It lives in this repository on purpose: a change to the contract touches both sides in one
commit rather than becoming a two-repo dance that will eventually be done wrong at 2 a.m.

> [!note] Status
> Stage C, end to end. Deployed on elantris under systemd, owning the SCD41 and the three wired
> relay lines, and driving a relay from an MQTT command issued by the server. No burner connected
> yet.

## Key files

- [../../apps/agent-linux/src/tempestas_agent/contract.py](../../apps/agent-linux/src/tempestas_agent/contract.py) — the Python mirror of the MQTT contract
- [../../apps/agent-linux/src/tempestas_agent/agent.py](../../apps/agent-linux/src/tempestas_agent/agent.py) — announce, sample, judge commands, dead-man
- [../../apps/agent-linux/src/tempestas_agent/sensor.py](../../apps/agent-linux/src/tempestas_agent/sensor.py) — raw SCD4x over I²C, and the closed-loop simulator
- [../../apps/agent-linux/src/tempestas_agent/ds18b20.py](../../apps/agent-linux/src/tempestas_agent/ds18b20.py) — DS18B20 probes over the kernel's 1-Wire sysfs
- [../../apps/agent-linux/src/tempestas_agent/gpio.py](../../apps/agent-linux/src/tempestas_agent/gpio.py) — the relay backends: `NoGpio`, `SimulatedGpio`, `LgpioBackend`
- [../../apps/agent-linux/src/tempestas_agent/update_command.py](../../apps/agent-linux/src/tempestas_agent/update_command.py) — judges an `update`, as the reference judge does
- [../../apps/agent-linux/src/tempestas_agent/release_installer.py](../../apps/agent-linux/src/tempestas_agent/release_installer.py) — download, verify, switch `current`
- [../../apps/agent-linux/src/tempestas_agent/update_gate.py](../../apps/agent-linux/src/tempestas_agent/update_gate.py) — the health gate a new release must pass, and the rollback when it does not
- [../../apps/agent-linux/systemd/tempestas-agent-rollback.py](../../apps/agent-linux/systemd/tempestas-agent-rollback.py) — switches back when a new release cannot start at all
- [../../tools/deploy-agent-linux.sh](../../tools/deploy-agent-linux.sh) — test, copy into a release, build the venv when its requirements change, switch, restart
- [../../apps/agent-linux/agent.example.toml](../../apps/agent-linux/agent.example.toml) — every option; the reasoning behind each is on this page

## Running it

```bash
cd apps/agent-linux
uv sync --group dev
uv run tempestas-agent --simulated                      # no hardware at all
uv run tempestas-agent --config /etc/tempestas/agent.toml
uv run pytest -q && uv run ruff check .
```

Nx wires `lint`, `test`, `format` and `serve` through `nx:run-commands`, with
`implicitDependencies: ["domain"]` so editing the contract invalidates the Python tests.

## The anti-drift test

Colocating the agent with the contract only means something if something checks.
`tests/test_contract_matches_typescript.py` **parses** `mqtt-contract.ts` and asserts the
Python mirror agrees — schemas, every topic builder, the update states and the whole QoS/retain
table, including the assertion that commands are never retained.

It has been verified to bite: changing `sample/1` to `sample/2` in the TypeScript, or
flipping `gpioSet` to `retain: true`, fails the Python suite. A formatting change does not
— prettier wrapping a builder onto two lines is not drift, and the regex allows for it.

## The sensor-only posture

**With `gpio.lines` empty the agent has no GPIO whatsoever.** This is structural, not a flag:

1. `gpio.build()` returns `NoGpio` regardless of what else is configured.
2. No chip is opened. Nothing is claimed.
3. `capabilities` omits `gpio` entirely, so the server's pin check refuses to create a
   device on this node at all, and no pin here is addressable.
4. A write to `NoGpio` **raises** rather than quietly doing nothing.

## The GPIO backend

`LgpioBackend` is the real one, over the `lgpio` chardev API. It is an optional dependency
(`uv sync --extra gpio`) because it needs `swig` and `liblgpio-dev` to build, which a Mac
does not have and a sensor-only node does not need.

**The chip is selected by label, never by number.** `/dev/gpiochip4` is a symlink to
`gpiochip0` on a Pi 4 and a real chip on a Pi 5; one build has to be right on both. The label
comes from the kernel's own `GPIO_GET_CHIPINFO` ioctl — the same thing `gpiodetect` reads —
and a label that is not present refuses to start, naming what was found. Opening the wrong
chip would not fail: it would drive line 5 of `raspberrypi-exp-gpio` and report success.

### Three things measured on the hardware, not read in a datasheet

Each one contradicts what was assumed, and each has a test and a comment next to the code.

| Behaviour                                                                                                                    | What it forces                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `gpio_claim_output` sets direction, level **and** bias in one call                                                           | Claim at the **failsafe** level, so the pad is never an output at a level nobody chose                                    |
| A **second claim on a line this handle already holds keeps the old level** and returns success                               | Claim happens exactly once; a second `claim()` raises rather than being a silent no-op                                    |
| **Releasing does not revert the pad.** `gpio_free` and `SIGKILL` both leave it an output driving its last level, bias intact | See [Safety](../Safety.md#the-boot-window-hazard) — this is why claim-at-failsafe is the recovery, not state preservation |

### The rest of the contract

- **The bias pulls toward the declared failsafe level**, not toward a fixed direction —
  `SET_PULL_UP` for an active-LOW relay, `SET_PULL_DOWN` for an active-HIGH one. Generalised so
  a future board with mixed polarity does not depend on anyone remembering.
- **The claim readback is a startup gate.** A line that claims successfully but reads back at the
  wrong level refuses to start. A broken board is cheapest to find before the first command.
- **`level()` reads the pad**, never a cache, and returns `None` on a read error. Unknown is a real
  answer; reporting a burner relay as off because a read failed is not.
- **`failsafe()` deliberately never raises.** The dead-man drives the failsafe and _then_ publishes
  its alarm; a raise here would lose the one message a human needs at that moment. Every line is
  attempted even after an earlier one fails, and each failure logs at ERROR.
- **`close()` drives the failsafe and stops.** No `gpio_free`, no `gpiochip_close` — freeing is the
  operation that hurt the old system, and there is nothing to gain by it when the process is about
  to exit anyway.

## Deployment

### Every deploy

```bash
tools/deploy-agent-linux.sh [host ...]   # elantris and patji when none are named
```

It runs the agent's lint and tests, then on each host:

1. Builds the venv again only when its requirements changed (see [the venv](#the-venv)), first, so
   a redeploy of the running version does not leave its new code beside the old venv for minutes.
2. Copies the code under a dot-name, stamps the version, and renames it into
   `~/tempestas/agent-linux/releases/<version>` in one step, exchanged with one already there. A
   redeploy of the running version never edits the tree the agent is running from.
3. Swaps in that venv and makes the release `current`, back to back so no start pairs code with
   the wrong venv, and puts the old venv back if `current` cannot follow. Then prunes old releases. An update still waiting on its gate is replaced, and
   the server hears `failed`: "replaced by a hand deploy of <version>".
4. Restarts the agent, unless the host's unit still runs the agent from before the release layout.
   Then it prints the one-time install from [Updates](#updates) instead. The replaced venv is
   removed only once the agent is active again. If it is not, the deploy stops and says where the
   replaced venv is kept, `~/tempestas/agent-linux/.venv-replaced`; a later deploy that builds no
   venv leaves it there, so a broken build can still be swapped back by hand.

A restart drives the relays to their fail-safe levels until the server commands them again.

### The release layout

```
~/tempestas/agent-linux/
  releases/<version>/   one per release, the newest three kept, plus the running and previous one
  current ->            releases/<version>, the one the unit runs
  venv/                 shared by every release; requirements.txt records what it was built from
  update-state/         pending.json while an update is on its gate, outcome.json until reported
```

It sits apart from the server's `~/tempestas/releases` and `current`, so neither deploy can touch
the other's. A hand deploy and an update both change the code by switching `current`, so the unit
never changes between them.

### The venv

The hosts have no `uv`, and patji is an armv6 Pi Zero, so the venv is plain
`python3 -m venv --system-site-packages`. The system packages give it the distro's `lgpio`, which
cannot be built on armv6. pip installs the rest from `uv export --frozen --no-dev --no-emit-project`,
so the same `uv.lock` pins the hosts and the workstation. A rebuild happens beside the old venv,
which the running agent keeps using, and is swapped in only once pip has finished, together with
the switch of `current` and just before the restart. On a Pi Zero it takes a few minutes.

Every release shares the venv, so an update must not change it. A node refuses a bundle whose
`uv.lock` differs from the running release's with `failed`: "its dependencies differ from this
node's, so it needs tools/deploy-agent-linux.sh".

### The version a node reports

`hello` names the app, `agent-linux`, and an `agentVersion` of
`<contract major>.<contract minor>.<patch>`, for example `1.0.3`; a deploy from anything but a clean
`origin/main` is marked `-dev+<commit>`. The deploy script writes it to
`tempestas_agent/deployed_version.py` on the host, and
[tools/describe-agent-version.sh](../../tools/describe-agent-version.sh) builds it for both agents. A
checkout that was never deployed by the script reports `0.0.0+dev`. What each number promises is in
[MQTT Contract](MQTT%20Contract.md#versions); the version in `pyproject.toml` is not used.

### The unit

The unit lives at [../../apps/agent-linux/systemd/tempestas-agent.service](../../apps/agent-linux/systemd/tempestas-agent.service)
and is installed from the release a deploy copied, then `sudo install`-ed — never by piping content
into a root-owned file, which is how a password once ended up inside `/etc/fstab`. The full
install, with the rollback unit, is in [Updates](#updates).

```bash
systemd-analyze verify /etc/systemd/system/tempestas-agent.service \
  /etc/systemd/system/tempestas-agent-rollback.service   # must be silent
```

`systemd-analyze verify` is part of the procedure, not a nicety. It found two real defects in a
unit that had been running for weeks:

| Defect                                                     | Effect                                                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `StartLimitIntervalSec` / `StartLimitBurst` in `[Service]` | Ignored with `Unknown key`. The 5-in-300s limit was never applied; the 10 s default was |
| `%20` in the `Documentation=` URL                          | `%` is a systemd specifier, so the whole line was dropped as `Invalid slot`. Use `%%20` |

Both are the same shape of bug: a directive that reads as enforced and is not. Check what is
actually in effect with `systemctl show tempestas-agent -p StartLimitIntervalUSec`.

### What the unit is doing and why

- **`Type=notify`.** The agent calls `sd_notify("READY=1")` after the chip is claimed and the sensor
  has started, so it can fail safe on its own. It does not wait for the broker, which it keeps
  retrying, so `active` says nothing about MQTT. Readiness is a fact; the old system guessed at it
  with an unconditional `sleep 15` in the unit and another `sleep 5` in the app.
- **`SupplementaryGroups=i2c gpio`.** `/dev/gpiochip0` is `crw-rw---- root:gpio`. Listed explicitly
  rather than inherited from the account, so the unit states what it needs.
- **`Restart=on-failure`, never `always`,** with the start limit in `[Unit]`. `RestartSec=5` is not
  cosmetic: a `SIGKILL` leaves the pads driving whatever they last drove, so the thing that turns a
  burner off is this unit coming back and claiming at the failsafe. Five seconds is the width of
  that exposure.
- **No `PrivateDevices=yes`.** It would give the unit a scrubbed `/dev` with no `/dev/i2c-1` and no
  `/dev/gpiochip0` — a lockdown that breaks the sensor and every relay in exchange for tidiness.
- **`RestartForceExitStatus=75` and `SuccessExitStatus=75`.** The agent exits 75 once an update is
  installed, so systemd starts it again on the new `current`. The second line matters as much as
  the first: without it, exit 75 counts as a failure, and `OnFailure=` rolls the update back before
  it ever runs. The end-to-end run caught exactly that.
- **`OnFailure=tempestas-agent-rollback.service`.** It fires on every failed run, not only once the
  start limit gives up, so the script decides. That needs systemd 254 or later, where a restarting
  unit passes through `failed`; before it, the unit reached `failed` only at the start limit. Every
  host runs 257 on trixie. The deploy script warns about a host with less but still deploys to it,
  so a fix can reach it; do not send such a host updates from the server. The script switches back
  only when the release that failed is an update still waiting on its gate, and only on its third
  failed run if it had said `hello`. Otherwise it exits 1 and changes nothing, and as an
  `ExecCondition=` that skips the unit rather than marking it failed after every ordinary crash. A
  rollback that itself fails exits 255, which does mark the unit failed.
- **`WatchdogSec=60`.** The gate is judged by the new release's own main loop, so a release that
  hangs after its `hello` would otherwise never be rolled back. The main loop pings the watchdog on
  every pass and through the wait between samples, so only a pass that hangs trips it, and any
  sample interval is fine. Sixty seconds is well above the longest pass, an SCD4x self-test of
  10 s. systemd then kills the agent with `SIGABRT`; `faulthandler` writes where every thread was
  to the journal first, and the failed run goes through `OnFailure=` like any other. It applies
  outside updates too: a hung agent is restarted rather than left holding its lines. A callback
  that raises ends paho's network thread for good, so the main loop also fails the run once that
  thread has died, rather than run on unable to hear.
- **No ordering against the I²C bus.** systemd only creates `.device` units for devices udev tags
  for it, and i2c is not one, so `After=dev-i2c\x2d1.device` looks like ordering while doing
  nothing. The agent opens the bus, fails fast, and the restart retries.

### Verified on the box, not just configured

| Check                                             | Result                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------- |
| Start with GPIO configured                        | Claims BCM 5/6/4 at their failsafe; all three de-energised          |
| `relay-check.py` against the live service         | Refused, `GpioBusy`, naming the holder                              |
| A second agent                                    | Refused by the `flock`, exit 3                                      |
| Agent started while a relay was already energised | Relay dropped by the claim — the recovery path, observed            |
| `kill -9` the agent                               | systemd restarted it in ~5 s, re-claimed at failsafe, `NRestarts=1` |
| Cold reboot                                       | Active 21.6 s after boot, lines claimed, relays dark, `NRestarts=0` |

## Guards on the command path

`judge_command` is pure, so each of these is asserted directly rather than reasoned about:

| Refusal                       | Why                                                                                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| empty payload                 | It is how a retained command is **cleared**. Reacting to it loops against whoever cleared it — so this one is silent, with no alarm                               |
| retain flag set               | A retained command replays on every reconnect. Catches the replay-on-subscribe case                                                                               |
| `issuedBy` ≠ bound controller | **The check that matters.** The retain flag is only set when delivery is caused by a new subscription, so a retained command published mid-session looks ordinary |
| past `expiresAt`              | A command delivered late must be refused, not obeyed                                                                                                              |
| unknown schema major          | Parse hopefully and two sides disagree about what a field means                                                                                                   |

The node binds to whichever controller heartbeats at it. Before the first heartbeat there is
nothing to compare against, so any issuer is accepted — refusing everything would mean a node
could never be commanded at all.

## The update command

The agent reports contract minor 2 and subscribes to `update`. The refusals above apply to it,
except that it refuses every update until a controller is bound, and it also refuses an update
for another app or another contract major with an `update/status` of `failed`. The full rules
are in [MQTT Contract](MQTT%20Contract.md#the-update-command), and what happens to an accepted
one is in [Updates](#updates).

## Updates

An accepted update runs on a worker thread, so samples and heartbeats carry on meanwhile:

1. **`downloading`.** The node fetches the manifest and checks it against the command's
   `manifestSha256`. Then it downloads every listed file into `releases/.<version>`, a dot-name a
   crash leaves unfinished rather than half-installed. Each fetch has 120 s in all, so a server
   that trickles bytes cannot hold the update open forever.
2. **`verifying`.** Every file's sha256 must match the manifest, and its `uv.lock` must match the
   running release's (see [the venv](#the-venv)).
3. **`installing`.** It renames the release into place, writes `pending.json`, then switches
   `current`. Pending is written first, so a crash between the two reads as a failed start, never
   as no update.
4. **`restarting`.** It stops gracefully and exits 75, and systemd starts the new release.

A graceful stop drives every line to its failsafe before the exit, so the five seconds of
`RestartSec` hold the failsafe, not the last level.

### The health gate

The new release finds `pending.json` naming itself and has `GATE_SECONDS`, 120, to prove itself:
a `hello`, then a heartbeat from the server after that `hello` that names the new version as the
one it accepted, which the server does only once it has stored that `hello`. That means the
broker, the credentials and the server's view of the node all work, and that the server took this
release's `hello`, not just any message from the node. A heartbeat still naming the old version,
or none, does not count. If the gate runs out that way, the reason says so: "the server did not
accept 1.2.1's hello in 120s: it still names 1.2.0". A server from before contract 1.2 names no
version, and then any heartbeat after the `hello` passes, unless an earlier heartbeat did name one.

A `hello` the server failed to store, for example in a database blip, would otherwise fail the
gate, as nothing else sends it again. So while heartbeats name another version, `null` or nothing
after naming one, the agent says `hello` again on the next heartbeat at least `HELLO_REPEAT_S`,
20 s, after the last one, until the gate settles. The failure reason names the last refusal heard, even if heartbeats stopped after it.

The 120 s count only while the broker is connected and the server is online. The clock runs once
the node has said `hello` and the server is known to be online, and stops when the server reports
itself offline or the connection drops. So a server deploy or a broker restart during the gate is no
verdict, and a good release is not rolled back for it. A broker that is down when the new release
starts is retried too, rather than failing the start. The cost is that a release that never reaches
the broker at all waits rather than rolling back.
It shows as offline on the Nodes page, and `tools/deploy-agent-linux.sh` replaces it.

- **Passed**: it records `healthy`, clears pending, prunes old releases, and reports.
- **Not passed**: it switches `current` back, records `rolled-back` with the reason, and exits 75.
  The previous release reports the outcome once it connects.
- **Replaced by a hand deploy**: the gate is dropped without passing or rolling back, and the
  deploy's restart starts the release it copied. The agent, the installer, the rollback script
  and a hand deploy all take `update-state/switch.lock` around every read-then-switch of
  `current`, so none can undo another. The deploy also holds it while it puts a copied release in
  place, and nothing ever points `current` at a release directory that is missing: a gate that
  fails with nothing to roll back to reports `failed` and keeps the release it has.

- **Cannot start at all**: the release never gets to judge itself. The unit fails,
  `tempestas-agent-rollback.service` runs the root-owned script, which switches back and starts the
  agent again, and the previous release reports `rolled-back`: "<v> did not start, so <prev> runs
  again".
- **Crashes after its `hello`**: the agent records the `hello` in `update-state/started.json`, and
  the script forgives such a release two failed runs, counted in `failed-runs.json`, before it
  switches back on the third. A reboot inside the gate, where the agent fails fast until I²C is
  ready, does not roll back a release that works. A release that never said `hello` is switched back
  on its first failure. The previous release then reports "<v> kept failing after it started".

An outcome stays in `outcome.json` until the broker has acknowledged it while the server was
online. It is sent again on every connect and whenever the server comes back, so neither a dropped
connection, a server deploy nor a crash can lose it. Until then the node refuses a new update, since
installing one clears the record. A download cut off by a restart leaves `releases/.<v>` behind,
and the agent removes it at its next start. It also refuses one while it cannot read the last update's state
at all. Only the main loop acts on the gate; the MQTT callbacks just note the `hello`, the
heartbeat and the server's comings and goings, so a heartbeat arriving at the deadline cannot both
pass and fail it.

The script lives in `/usr/local/lib/tempestas`, outside every release, so an update can never
change the code that rescues it from itself. It imports nothing from the agent, for the same
reason.

### Once per host

A deploy copies the units and the script with the release. To install them, on the host:

```bash
release=~/tempestas/agent-linux/current
sudo install -d -m 0755 /usr/local/lib/tempestas
sudo install -m 0644 -o root -g root $release/systemd/tempestas-agent-rollback.py /usr/local/lib/tempestas/
sudo install -m 0644 -o root -g root $release/systemd/tempestas-agent.service \
  $release/systemd/tempestas-agent-rollback.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl restart tempestas-agent
```

Do it after the first deploy with this layout, which builds the release and the venv but leaves
the old agent running and prints these lines. The old checkout in `~/tempestas/apps/agent-linux`
is unused after that and can be removed. Later deploys compare the installed copies with the
release's and print these lines again whenever they differ; an update over MQTT cannot install
them, so a change to the units or the script needs a deploy, or these lines by hand.

### Verified end to end

On real systemd (a user unit mirroring this one), a local broker, and bundles served over http:

| Scenario                                  | Result                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| Update to a working release               | `downloading` → `restarting`, `hello` from the new version, `healthy`   |
| Update to a release that crashes on start | Rolled back on its first failed run; the previous release says why      |
| Update that never gets a heartbeat        | Gate failed at 120 s, switched back, `rolled-back` "heard no heartbeat" |
| Update to the version already running     | `failed`, "this node already runs 1.1.4"; nothing changed               |
| Exit 75 without `SuccessExitStatus=75`    | The good update was rolled back at once: the reason the line is there   |

## Announcing line state

`gpio/state` is **retained**, which makes it the value a controller reads to reconcile after a
restart. So every path that changes a line publishes it, through one method — `publish_gpio_state`:

- **after a command**, per pin in the command;
- **on every connect**, for every managed line. Without this, a controller that restarts reads the
  level from _before_ the agent's last restart rather than the failsafe its claim just applied;
- **on entering the failsafe**, via `enter_failsafe`, which orders it deliberately: **hardware,
  then state, then alarm**, so anything reacting to the alarm already has the truth.

The level published is read back from the pad, never from intent, and an unreadable pad is published
as `known: false` with a null level. Unknown is not off.

This exists because it was missing, and the miss was only visible on real hardware: the node failed
safe on the server's LWT, de-energised the relay, and left a retained message on the bus saying a
burner relay was energised. See
[rule 3b in Safety](../Safety.md#3b-a-node-that-changes-a-line-on-its-own-must-say-so).

## The dead-man

Enforced locally, counting server heartbeats, with no server involvement — it has to work when
the brain is gone entirely, which is the one case where nobody else can help. On expiry it
drives every managed line to its **declared** safe level and alarms `DEADMAN_TRIPPED`.

The config **refuses to start** if any managed line has no declared safe level. A line nobody
has decided about is not acceptable on a board where one of them is a propane burner.

The agent also watches the server's own LWT, but `server/status = offline` only logs a warning: a
deploy restarts the server, so the dead-man alone decides when the lines fail safe. When the
status turns `online` again the agent re-sends its `hello`, so a server that was down while the
node restarted still learns the new boot id. The retained `online` replayed on the agent's own
connect is skipped, since the connect has just announced.

## The sensor

A raw `smbus2` driver derived from the greenhouse's own `scd4x_healthcheck.py`, **not**
`adafruit-circuitpython-scd4x` on Blinka. That drops a large dependency tree and its
swig/liblgpio build requirement, and fixes a real bug: the datasheet says `data_ready` is true
when the **low 11 bits** are non-zero, which the raw driver checks and the Adafruit driver does
not — it tests the whole word.

**Never invent a reading.** A zero or implausible CO2 is reported `valid: false` with a reason
and a null value, never as `0` and never as the last known good value. A dead sensor stuck on a
low reading would otherwise run a propane burner indefinitely. Note the asymmetry: an invalid
CO2 still yields a usable sample, because temperature is what most rules read — but a sample
with no valid _temperature_ is dropped whole, since half a sample is not a degraded reading, it
is a phantom one.

### Configuration commands are NACKed while measuring

Found on real hardware, not read in a datasheet: once `start_periodic_measurement` is running,
every configuration command returns `Errno 121 Remote I/O error`. So all configuration **and any
read-back of it** has to happen inside the idle window at startup, which is why
`applied_offset_c` is an attribute captured during `start()` rather than a method you can call
later. `tests/test_sensor.py` pins that ordering with a fake bus that records command words.

The temperature offset, altitude and ASC are applied at **every** startup, never trusted to
persist: the Adafruit setter the old system used never called `persist_settings`, so anything set
through it was lost to every power cycle. The offset and ASC are then read back; altitude is not.

### The CO2 range guard

`judge_co2` refuses a word outside `[co2_min_ppm, co2_max_ppm]` (300 to 5000 by default). The
guard used to be `0 < raw < 40000`, the chip's whole output width, and a dying SCD41 walked
straight through it: on 2026-09-12 elantris stored 293 ppm and 15,723 ppm as genuine.

Low readings are the dangerous direction. The rules engine resolves `node:<slug>` to a single
sample with no averaging, so one spurious low reading is a command to light the burner. A refused
reading is absent, and Safety rule 4 turns absent into +Infinity, which keeps the burner off.

The floor is 300, not outdoor air. A crop in a closed house genuinely depletes below 400, and a
sensor reading somewhat low should go inaccurate rather than silent: on 2026-09-14 elantris
converged on exactly 400 and everything beneath it vanished, which made a miscalibrated sensor
impossible to tell from a dead one. Below 300 stays refused, because no mechanism here produces it
and low is the direction that calls for CO2. A sealed house with a heavy crop lowers the floor in
config rather than losing the guard. The ceiling is the SCD4x's specified range; the chip can emit
up to 40000. The bounds are config rather than constants because they describe this greenhouse
as much as the chip.

### Automatic self-calibration is off by default

Sensirion ship ASC enabled. It treats the lowest reading of roughly the past week as 400 ppm
outdoor air. An enriched greenhouse never returns there, so ASC keeps revising the baseline toward
a number the air never reaches, and the sensor reads progressively low, with no error and nothing
downstream able to tell. Low is the direction that calls for more CO2. Nothing touched ASC before
2026-09-12, so every earlier reading was taken on a sensor quietly recalibrating itself.

`automatic_self_calibration = true` is right for a sensor-only node in unenriched air, where it
needs no manual recalibration. The applied value is in the startup log line (`asc=ON`/`asc=off`),
because a sensor drifting under ASC looks exactly like a greenhouse getting leaner.

### The rate guard

The range guard sees impossible values; `RateGuard` sees impossible **changes**. On 2026-09-13 the
sensor emitted jumps of 154, 184 and 489 ppm between consecutive 10-second samples, all inside the
range, the worst at 2933 ppm/min.

The limit is calibrated against a known-good day, not theory. 100 ppm/min is the fastest the
greenhouse has genuinely moved, but that is a net rate over minutes. Per-sample rates carry the
sensor's quantisation noise over a 10-second window and reach 285 ppm/min at p99 on a healthy
sensor, peaking near 390. A 200 ppm/min limit refused 2.8% of a clean day, more than it refused of
a degraded one; 400 refuses nothing clean and 1.1% degraded. Zero disables it.

Three cases have to be handled or the guard is worse than nothing:

- **A gap.** After a restart, or with time going backwards, there is no usable reference, so the
  reading is accepted and becomes the new baseline. The range guard still applies.
- **A genuine step.** Forced recalibration moves the whole scale at once. After `resync_after`
  consecutive refusals the guard proposes the reading as a candidate, and re-baselines only when
  the next reading lands within `corroborate_within` of it. Re-baselining unconditionally is what
  let 3647 ppm through on 2026-09-15 while an overheated sensor was spewing: a failing sensor
  refuses just as persistently as a real step, but a real step settles and garbage scatters.
- **A refusal never becomes the reference,** or one spike drags the guard along behind it.

The arithmetic is unit-free, and the DS18B20 backend reuses it per probe at 10 °C/min with a
1 °C corroboration window.

### Forced recalibration

`tools/scd4x_frc.py --target <ppm>` is the repair for a baseline that has gone wrong. On elantris a
failing sensor emitted a cluster of lows near 300 ppm, ASC took them for fresh air, and everything
afterwards read about 115 ppm high. Disabling ASC stops further drift but freezes the bad
correction; only an FRC undoes it.

- The sensor needs **at least 3 minutes** of periodic measurement in the reference air first (the
  tool settles for 4), and measurement must be stopped for the command itself.
- The chip returns the correction offset by `0x8000`, and `0xFFFF` means it refused. The
  correction is the adjustment made, so its sign is the opposite of the error the sensor carried.
  A correction above 250 ppm is a reason to distrust the sensor, not to celebrate the fix.
- Only calibrate when you can say what the air actually is. Outdoor air is about 420-430 ppm. A
  greenhouse approaches it only with the door open and time to mix; a crop in daylight pulls it
  below outdoor, and a closed house at night sits well above. A wrong reference does not fail, it
  moves the error and looks just as authoritative.
- The tool refuses a spread above 40 ppm across the last six readings, and a trend above
  0.5 ppm/min across the settle. Spread alone cost a calibration on 2026-09-12: readings fell
  599 to 571 at a steady 1.5 ppm/min while the last six sat within 11 ppm of each other.

`tools/scd4x_check.py` runs the chip's self-test and samples for a while. Both tools refuse to run
while the agent is active: the SCD4x answers one reader, and two pollers interleave into nonsense.
Only a definite `inactive` or `failed` from `systemctl is-active` counts as stopped. If `systemctl`
is missing, times out, cannot reach systemd, or reports the service mid-transition, they assume the
agent is running and refuse; `--force` overrides that once you have checked by hand.

## DS18B20 probes

patji, the pumphouse node, reads two or three waterproof DS18B20s on one 1-Wire bus (BCM4, the
`w1-gpio` overlay) through `/sys/bus/w1/devices/<rom>/w1_slave`. A backend is a **sensor set**:
it lists its sensors and returns a reading per sensor, and each probe is published as its own
`sample` on its own topic. The single-sensor backends are wrapped by `SingleSensor` and did not
change.

- **Pinned by ROM id, never by bus order.** A probe on the bus that is not configured is logged
  and ignored, so plugging one in cannot change what the rules read until somebody names it.
- **Three plausible numbers that are not measurements are refused by name:** a CRC the kernel
  marks `NO`, `85.000` (the power-on reset value, returned with a valid CRC after a brown-out),
  and an **all-zero scratchpad**. That last one passes the CRC, because the CRC of zeros is
  zero, and decodes as exactly 0 °C. A shorted data line reads that way, and it is a believable
  pumphouse temperature.
- Range -40 to 60 °C, and `RateGuard` per probe at 10 °C/min.
- **A refused probe is absent, not published invalid.** The others still publish. The server's
  `min` carries on with what remains, and `/api/health` names the probe that went quiet.
- A failing probe logs once when it starts failing and once when it recovers, not every cycle.
- CO2 and humidity go out as `valid: false, reason: "NOT_MEASURED"`, so the contract is
  unchanged. `capabilities.sensors` declares `metrics: ["temperature"]` per probe, which is what
  keeps empty dials off the dashboard.
- A missing bus is logged at ERROR and is not fatal. The agent still owns the heater relays, and
  their failsafe does not need a thermometer.

## Pitfalls

- **`uv` is not on a login PATH by default.** It installs to `~/.local/bin`; a
  non-interactive `ssh host cmd` will not find it.
- **systemd cannot use `uv run` or nvm.** A unit needs the absolute interpreter path from the
  venv, for the same reason it needs one for node.
- **Two agents with the same `node_id` fight over one MQTT client id.** The broker evicts the
  older one, firing its will, and the two then alternate `hello`s with different boot ids —
  which reads in the server log as a node rebooting in a loop. Check for a stray process
  before believing that.
- **`pkill -f tempestas-agent` may not match** the process you mean; `uv run` and the venv
  entrypoint appear differently. Kill by PID.
- **The MQTT session is clean.** A persistent session is a queue of commands waiting to replay on
  reconnect, which for a relay that may be holding a burner is a hazard rather than a convenience.
- **The retained `gpio/state` is republished on every connect.** Otherwise a restarting controller
  reads the level from before the agent's own restart, not the failsafe its claim just applied.
- **A graceful stop publishes `status: offline` explicitly.** MQTT suppresses the will on a
  clean disconnect, so without that the node is left looking online forever.
- **`hello` is not retained,** so a node announces on its own MQTT connect and again whenever
  `server/status` turns `online`. Without the second, a node that restarted while the server was
  down kept its old boot id on the server, and every sample was dropped as a duplicate of the old
  boot's `seq`.
- **Five starts in 300 s hits the start limit, and an update's restart counts as one.** A burst
  of deploys and updates can trip it, and `OnFailure=` then rolls back an update that was fine.
  `systemctl reset-failed tempestas-agent` clears the count.
- **A change to the dependencies cannot arrive as an update.** The venv is shared, so the node
  refuses it and the server shows why; deploy it with `tools/deploy-agent-linux.sh`.
- **`systemctl stop` is a clean exit and does NOT trigger `Restart=on-failure`.** Stopping the
  agent therefore leaves the pads holding whatever they last drove, with nothing supervising them.
  Drive the failsafe before a long stop, or expect `relay-check.py` to be what turns things off.

## When to update this file

- A guard is added to or changed on the command path
- A guard, bias rule or failsafe behaviour in the GPIO backend changes
- The systemd unit changes, or a new deployment check earns a row in the table above
- The release layout, the health gate or the rollback changes
- The sensor driver changes, or another sensor kind is supported
- The dead-man behaviour or its configuration changes
