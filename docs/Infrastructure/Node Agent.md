# Node Agent

## What it is

`apps/hardware` — one Python process per node. It owns that box's sensor and (later)
its relays, and speaks the MQTT contract. Everything else in the system talks to hardware
only through it.

It lives in this repository on purpose: a change to the contract touches both sides in one
commit rather than becoming a two-repo dance that will eventually be done wrong at 2 a.m.

> [!note] Status
> Stage B. The agent runs against the real SCD41 on elantris and publishes real samples.
> **It has no GPIO backend at all** — see [The Stage B posture](#the-stage-b-posture).

## Key files

- [../../apps/hardware/src/tempestas_agent/contract.py](../../apps/hardware/src/tempestas_agent/contract.py) — the Python mirror of the MQTT contract
- [../../apps/hardware/src/tempestas_agent/agent.py](../../apps/hardware/src/tempestas_agent/agent.py) — announce, sample, judge commands, dead-man
- [../../apps/hardware/src/tempestas_agent/sensor.py](../../apps/hardware/src/tempestas_agent/sensor.py) — raw SCD4x over I²C, and the closed-loop simulator
- [../../apps/hardware/src/tempestas_agent/gpio.py](../../apps/hardware/src/tempestas_agent/gpio.py) — the seam where a relay backend will go
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

## The Stage B posture

**With `gpio.lines` empty the agent has no GPIO whatsoever.** This is structural, not a flag:

1. `gpio.build()` returns `NoGpio`, and the real backend does not exist — asking for one
   raises `NotImplementedError` naming Stage C.
2. No chip is opened. Nothing is claimed.
3. `capabilities` omits `gpio` entirely, so the server's pin check refuses to create a
   device on this node at all, and no pin here is addressable.
4. A write to `NoGpio` **raises** rather than quietly doing nothing.

The real `lgpio` backend is deliberately unwritten. Writing untested relay-driving code now
would produce something that looks ready before the boot-window hazard has been measured —
and that hazard is the gate: BCM 9–27 default to pull-down and four of the five relays are
active-LOW, so an unclaimed line commands its relay **on**. See
[Safety](../Safety.md#the-boot-window-hazard).

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

## When to update this file

- A guard is added to or changed on the command path
- The GPIO backend gains a real implementation (and the Stage B posture stops being true)
- The sensor driver changes, or another sensor kind is supported
- The dead-man behaviour or its configuration changes
