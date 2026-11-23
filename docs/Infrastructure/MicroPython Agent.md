# MicroPython Agent

## What it is

`apps/agent-micropython` — the MicroPython agent, for a microcontroller with Wi-Fi. It runs on a
Raspberry Pi Pico W today, and another board is a file in `device/boards/`, not a fork. It speaks
the same MQTT contract as the [Linux Agent](Linux%20Agent.md), so the server cannot tell the two
apart beyond `kind` and `capabilities`. It is for a box that only needs a probe and a couple of
relays, where a Pi would need an SD card, an OS and updates.

The first one is `braize`, the crawlspace node: one DS18B20, a heater and a heat tape, both wired
so a dead node leaves them **on**, the same as patji in the [Pumphouse](../Pumphouse.md).

> [!note] Status
> Bench-tested on braize (2026-11-20) against a throwaway broker, relays unloaded, MicroPython
> 1.21.0: announce, samples, both relays with readback, every refusal, a retained replay after
> reconnect, server-offline failsafe, the dead-man tripping at 600 s and clearing, a watchdog
> reboot, a broker restart, and a Wi-Fi drop with a new DHCP lease. Running on elantris since
> 2026-11-20, admitted and under rule control; the lamp tests wait for the wiring.

## Key files

- [../../apps/agent-micropython/device/node_agent.py](../../apps/agent-micropython/device/node_agent.py) — announce, judge commands, dead-man, readings; no hardware imports
- [../../apps/agent-micropython/device/node_runtime.py](../../apps/agent-micropython/device/node_runtime.py) — boot, Wi-Fi, NTP, the broker connection, the main loop, the watchdog
- [../../apps/agent-micropython/device/command_guard.py](../../apps/agent-micropython/device/command_guard.py) — every reason a `gpio/set` is refused
- [../../apps/agent-micropython/device/tempestas_mqtt.py](../../apps/agent-micropython/device/tempestas_mqtt.py) — MQTT 3.1.1 at QoS 0 and 1, rewritten from `umqtt.simple` 1.8.1 (MIT); holds messages that arrive while a publish waits for its acknowledgement
- [../../apps/agent-micropython/device/relay_lines.py](../../apps/agent-micropython/device/relay_lines.py) — driving and releasing the relay pins, read back through the board
- [../../apps/agent-micropython/device/boards/](../../apps/agent-micropython/device/boards/) — one file per board, for everything the chip decides: pin readback, Wi-Fi power saving, whether the watchdog is armed
- [../../apps/agent-micropython/device/ds18b20_probes.py](../../apps/agent-micropython/device/ds18b20_probes.py) — the probes, pinned by ROM, refusing the chip's fake readings
- [../../apps/agent-micropython/device/contract.py](../../apps/agent-micropython/device/contract.py) — the MicroPython mirror of the contract
- [../../apps/agent-micropython/device/settings.py](../../apps/agent-micropython/device/settings.py) — node id, board, broker, pins, probes, failsafe levels
- [../../tools/deploy-agent-micropython.sh](../../tools/deploy-agent-micropython.sh) — copy it onto the board over USB

## The board

| Thing    | Pin                    | Notes                                                               |
| -------- | ---------------------- | ------------------------------------------------------------------- |
| DS18B20  | GP16                   | ROM `28-3ce1d4436ee8` (`28e86e43d4e13c66` as MicroPython prints it) |
| Relay K1 | GP20 (physical pin 26) | Heater, through a contactor: 750 W on low is too much for the relay |
| Relay K2 | GP18 (physical pin 24) | Heat tape                                                           |

The relay board is a "2 Relay Module": two Songle SRD-05VDC-SL-C with optocoupler inputs, active
low, JD-VCC jumper fitted. **Pin driven low energises the relay. Pin released (an input) lets it
go.** The agent never drives a pin high: from 3.3 V into a 5 V optocoupler, high is not reliably
off, and released is.

Level 1 is released, which is also what a reset, a crash or an unpowered Pico does. Both loads hang
off the NC contacts, so level 1 is **load on** and is the failsafe for both lines.

## How it differs from the Linux agent

- **No real-time clock.** The Pico's clock starts at 1970 on every boot. Until NTP has set it, every
  command is refused quietly (no alarm), because `expiresAt` cannot be judged. `hasRtc` is `false`.
- **A hardware watchdog.** The loop feeds it; a hang anywhere resets the board within 8 s, and a
  reset releases every pin.
- **Readback from the registers.** `read_level()` asks the board, which on the Pico W reads the
  SIO output-enable and output registers, not a cached value, so a `gpioResult` reports what the
  pin is doing.
- **No rate guard on the probes yet.** The Python DS18B20 driver refuses a jump of more than
  10 °C/min. This one refuses the power-on 85 °C, all-zero and out-of-range readings, but not a
  plausible-looking spike.
- **One thread.** Messages, sampling and the dead-man share one loop. A probe conversion (750 ms) is
  the longest stall.
- **Nothing acknowledged is lost to a drop.** A command that arrives while a publish waits for its
  PUBACK is acknowledged at once and held. If that wait then fails, the command is still handled
  after the drop, because the broker will not send it again. Alarms and results raised while
  offline (up to 20) are sent after the next announce; nothing else is, because retained state,
  samples and the hello are repeated anyway.

Everything else on the command path matches the Linux agent: a retained command is dropped with
`RETAINED_COMMAND_DROPPED`, a foreign `issuedBy` raises `CONTROLLER_CONFLICT`, an expired command
raises `COMMAND_EXPIRED`, an empty payload is ignored. The dead-man (600 s) drives the failsafe,
then publishes the line states, then the alarm. A server `offline` status is logged and the lines
are held, and a live `online` re-sends the hello, as on the Linux agent.

A `gpio/sync` is subscribed to but never applied, as on the Linux agent: only a `gpio/set` drives
a line. The Pico logs each one it ignores, so a sync sent to it shows up on the serial console
rather than vanishing.

## The update command

Contract 1.1 adds `update` and `update/status`, and `contract.py` carries their topics, schemas,
QoS and the `UpdateState` values, matched against the Linux agent's. The agent still reports
contract minor 0, because it does not subscribe to `update` yet; it raises the minor when it does.
Then it judges an update as it judges `gpio/set`, including refusing quietly until NTP has set the
clock, except that it refuses every update until a controller is bound, and refuses an
update for another app or another contract major with an `update/status` of `failed`. The full
rules are in [MQTT Contract](MQTT%20Contract.md#the-update-command).

## Running the tests

The device code is plain MicroPython with its hardware passed in, so the tests run under CPython
with fakes:

```bash
cd apps/agent-micropython
uv run pytest -q && uv run ruff check .
```

Nx wires `lint`, `test` and `format`, with `implicitDependencies: ["domain", "agent-linux"]`.
`tests/test_contract_matches_linux_agent.py` compares this contract with the Linux agent's,
which is itself checked against the TypeScript, so a contract change that misses this agent fails.

CPython is more forgiving than MicroPython. Before deploying, check that every file compiles:

```bash
cd apps/agent-micropython/device
for file in *.py; do uv tool run --from mpy-cross mpy-cross -o /tmp/check.mpy "$file"; done
```

## Installing

### Once per board

1. **Update MicroPython.** Hold BOOTSEL while plugging in, then copy the current `RPI_PICO_W`
   UF2 from micropython.org onto the `RPI-RP2` drive.
2. **Remove the old tutorial scripts.** They hold the home Wi-Fi password in plain text:
   `uv tool run mpremote connect /dev/ttyACM0 rm switch.py + rm temp_sensor.py + rm web_server.py + rm async_web_server.py + rm -r lib/picozero`
3. **Give it a broker account**, as patji has, with an ACL limited to its own node topics.
4. **Write `apps/agent-micropython/device/credentials.py`** from `credentials.example.py`. It is gitignored.

### Every deploy

```bash
tools/deploy-agent-micropython.sh [/dev/ttyACM0]
```

It runs the agent's tests, hard-resets the board, catches it inside `main.py`'s 5 s boot grace,
copies the agent, `boards/<settings.BOARD>.py` as `board.py` and a `deployed_version.py` holding
the version, and resets again. The board
file's `refuse_if_watchdog_armed()` runs first, so a deploy that missed the grace stops before it
copies anything. Watch it with
`uv tool run mpremote connect /dev/ttyACM0 resume repl` — `resume` stops mpremote from
interrupting the agent.

A new file on the board goes in [`tools/lib/agent-files.sh`](../../tools/lib/agent-files.sh), which
this deploy and the server's [release bundles](Deploys.md#agent-release-bundles) both read; one that
holds a node's own settings goes in `MICROPYTHON_NODE_CONFIG`, so it is never bundled.

The version stamp works as it does for the Linux agent (see "The version a node reports" in
[Linux Agent](Linux%20Agent.md)). A board flashed by hand reports `0.0.0+dev`.

### Adding a board

Write `device/boards/<board>.py` with the same four functions as `pico_w.py`, and set
`BOARD = "<board>"` in `settings.py`. `test_boards.py` checks every board offers all four. The
board's own limits still need reading: an ESP32's GPIO registers are elsewhere, its watchdog
timeout range differs, and its Wi-Fi takes no `pm` setting.

## Pitfalls

- **Floats are 32-bit.** Near 2026 an epoch second as a float steps by 128 s, so
  `1795215600.0 + 15 == 1795215600.0 + 60` on the board. Keep time in integers; CPython tests
  will not catch a float creeping back in.
- **`ticks_diff` wraps after about 6.2 days.** Only compare stamps that are refreshed more often
  than that. `FakeClock` wraps the same way, so the tests can show it.
- **Firmware modules shadow `/lib`.** `sys.path` is `['', '.frozen', '/lib']`, so the agent's
  files sit at the root, and the MQTT client is `tempestas_mqtt`, a name no firmware freezes in.
- **The watchdog survives Ctrl-C.** Interrupt a running agent and the board resets itself 8 s later.
  To work in the REPL, reset the board and press Ctrl-C during the boot grace.
- **`credentials.py` sits in plain text on the Pico's flash.** Anyone with a USB cable can read it.
  That is why the broker account is limited to the node's own topics.
- **Serial access needs `dialout`.** A session started before joining the group still lacks it;
  `sg dialout -c "..."` gets around that without logging out.
- **Physical pin numbers are not GP numbers.** GP20 is physical pin 26, not 25. Check against the
  pinout, not memory.
- **A retained command is obeyed if the node is already connected.** The broker sets the retain
  flag only when it replays a stored message to a new subscriber, so the guard catches the replay
  after a reconnect, not a live one. The broker ACL is what stops a live command from anyone but
  the server.
- **`hello` is not retained**, as with the Linux agent. The node re-sends it when
  `server/status` turns `online`, so a controller that starts after the node connected still
  hears it.
- **Migrate the server before the first Pico connects.** Its kind, `pico`, is a Postgres enum value
  added by `AddPicoNodeKind`; an unmigrated server fails to store the hello.

## When to update this file

- A guard, the dead-man or the failsafe behaviour changes
- A pin, a probe, the relay board or a board file changes
- The deploy script or the install steps change
- The rate guard is ported, or the node kind gets its own value
