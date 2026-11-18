# Node Agent

## What it is

`apps/hardware` — one Python process per node. It owns that box's sensor and (later)
its relays, and speaks the MQTT contract. Everything else in the system talks to hardware
only through it.

It lives in this repository on purpose: a change to the contract touches both sides in one
commit rather than becoming a two-repo dance that will eventually be done wrong at 2 a.m.

> [!note] Status
> Stage C, end to end. Deployed on elantris under systemd, owning the SCD41 and the three wired
> relay lines, and driving a relay from an MQTT command issued by the server. No burner connected
> yet.

## Key files

- [../../apps/hardware/src/tempestas_agent/contract.py](../../apps/hardware/src/tempestas_agent/contract.py) — the Python mirror of the MQTT contract
- [../../apps/hardware/src/tempestas_agent/agent.py](../../apps/hardware/src/tempestas_agent/agent.py) — announce, sample, judge commands, dead-man
- [../../apps/hardware/src/tempestas_agent/sensor.py](../../apps/hardware/src/tempestas_agent/sensor.py) — raw SCD4x over I²C, and the closed-loop simulator
- [../../apps/hardware/src/tempestas_agent/ds18b20.py](../../apps/hardware/src/tempestas_agent/ds18b20.py) — DS18B20 probes over the kernel's 1-Wire sysfs
- [../../apps/hardware/src/tempestas_agent/gpio.py](../../apps/hardware/src/tempestas_agent/gpio.py) — the relay backends: `NoGpio`, `SimulatedGpio`, `LgpioBackend`
- [../../apps/hardware/agent.example.toml](../../apps/hardware/agent.example.toml) — every option, with the reasoning

## Running it

```bash
cd apps/hardware
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
Python mirror agrees — schemas, every topic builder, and the whole QoS/retain table,
including the assertion that commands are never retained.

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

The unit lives at [../../apps/hardware/systemd/tempestas-agent.service](../../apps/hardware/systemd/tempestas-agent.service)
and is installed by staging it in the repo checkout and then `sudo install`-ing it — never by
piping content into a root-owned file, which is how a password once ended up inside `/etc/fstab`.

```bash
sudo install -m 0644 -o root -g root \
  ~/tempestas/apps/hardware/systemd/tempestas-agent.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl restart tempestas-agent
systemd-analyze verify /etc/systemd/system/tempestas-agent.service   # must be silent
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

- **`Type=notify`.** The agent calls `sd_notify("READY=1")` after the chip is claimed, the sensor
  has started, and MQTT is connected. Readiness is a fact; the old system guessed at it with an
  unconditional `sleep 15` in the unit and another `sleep 5` in the app.
- **`SupplementaryGroups=i2c gpio`.** `/dev/gpiochip0` is `crw-rw---- root:gpio`. Listed explicitly
  rather than inherited from the account, so the unit states what it needs.
- **`Restart=on-failure`, never `always`,** with the start limit in `[Unit]`. `RestartSec=5` is not
  cosmetic: a `SIGKILL` leaves the pads driving whatever they last drove, so the thing that turns a
  burner off is this unit coming back and claiming at the failsafe. Five seconds is the width of
  that exposure.
- **No `PrivateDevices=yes`.** It would give the unit a scrubbed `/dev` with no `/dev/i2c-1` and no
  `/dev/gpiochip0` — a lockdown that breaks the sensor and every relay in exchange for tidiness.
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

The agent also watches the server's own LWT: `server/status = offline` means fail safe now
rather than waiting out the dead-man.

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

## DS18B20 probes

The pumphouse node reads two or three waterproof DS18B20s on one 1-Wire bus (BCM4, the
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
- **A graceful stop publishes `status: offline` explicitly.** MQTT suppresses the will on a
  clean disconnect, so without that the node is left looking online forever.
- **`hello` is not retained,** so a node announces only on its own MQTT connect. A controller that
  starts while the node is already connected sees the retained `status` but never the capabilities,
  and cannot admit it. Restart the agent to make it re-announce.
- **`systemctl stop` is a clean exit and does NOT trigger `Restart=on-failure`.** Stopping the
  agent therefore leaves the pads holding whatever they last drove, with nothing supervising them.
  Drive the failsafe before a long stop, or expect `relay-check.py` to be what turns things off.

## When to update this file

- A guard is added to or changed on the command path
- A guard, bias rule or failsafe behaviour in the GPIO backend changes
- The systemd unit changes, or a new deployment check earns a row in the table above
- The sensor driver changes, or another sensor kind is supported
- The dead-man behaviour or its configuration changes
