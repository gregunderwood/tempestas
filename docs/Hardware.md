# Hardware

## What it is

The physical facts: which box, which pin, which polarity, which sensor, and the quirks that have
already caused bugs. None of this is discoverable from the code, and several items contradict the
old repo's `CLAUDE.md` — where the light pins are reversed and the thresholds are stale. **Trust
this file over that one.**

⚠ Read [Safety](Safety.md) before wiring or energising anything.

## The boxes

| Host         | Board                  | OS                           | Role                                                                                       |
| ------------ | ---------------------- | ---------------------------- | ------------------------------------------------------------------------------------------ |
| `elantris`   | Raspberry Pi 4B, arm64 | Debian 13 (trixie), headless | The first node **and** the brain. `192.168.2.70`, user `gunderwood`, Wi-Fi (`wlan0`)       |
| `greenhouse` | Raspberry Pi 5         | 32-bit userland              | Runs the legacy Flask app on lights + fans. Later reflashed to arm64 and demoted to a node |

Node-to-node TCP works (ports 22 and 80 open from elantris to greenhouse). **ICMP is filtered on
both greenhouse and the Mac, so `ping` fails misleadingly** — that is not a connectivity problem.
There is no MQTT broker anywhere else on the LAN; Mosquitto on elantris is a clean install.

## elantris's own relay board

⚠ **This is a different board from the greenhouse's existing wiring**, and confusing the two would
be expensive. The table further down is the **greenhouse Pi 5's** hardwired loads, which stay where
they are. elantris gets its own purpose-built panel, photographed 2026-09-09.

A plywood panel carrying: two 2-gang metal outlet boxes (four outlets), a blue 8-channel relay
board, two barrier terminal blocks, a mains inlet box, and an empty set of standoffs where the Pi
mounts. Three channels are wired:

| Relay | Switches                         | Intended load          |
| ----- | -------------------------------- | ---------------------- |
| 1     | Box A, outlet 1                  | —                      |
| 2     | Box A, outlet 2                  | —                      |
| 3     | Box B, **both** outlets (ganged) | —                      |
| 4–8   | **unwired**                      | free for bench testing |

**Loads plug in rather than being hardwired**, and that changes bring-up for the better. Stage C's
"mains loads one at a time in ascending order of consequence" stops being wiring work: plug a desk
lamp into a relay's outlet, watch it switch, unplug it. The CO2 generator goes in last, into a
socket already proven with something harmless.

The five unwired channels are free test channels — their LEDs show switching with no load attached
at all, which is exactly what the boot-window measurement needs.

### Still unknown, and gating

Neither is answerable from a photograph:

- **Active-LOW or active-HIGH?** Blue 8-channel boards are usually opto-isolated and active-LOW, but
  "usually" does not decide which level de-energises a propane burner. The silkscreen says.
- **Is there a JD-VCC jumper, and where is it?** It decides whether the relay coils are isolated
  from the Pi's 5 V rail or backfeeding it. A close-up of the header end of the board answers both
  this and the polarity question.
- **Do the inputs have their own pull-ups?** Still a multimeter question - see open question 2.

### Choosing pins: a free extra layer

Nothing is wired to the Pi yet, so the pin numbers are still a choice, and the choice is worth
making deliberately. On the BCM2711, **GPIO 0-8 default to pull-UP at reset and GPIO 9-27 default to
pull-DOWN**. For an active-LOW relay board that means a line on GPIO 5, 6, 7 or 8 sits at the
de-energised level through the whole boot window, where BCM 12/16/20/21 - the greenhouse's existing
choices - sit at the energised one.

BCM 2 and 3 are the SCD4x's I2C bus and BCM 0/1 are the HAT EEPROM pins, so the realistic candidates
are **BCM 4, 5, 6, 7, 8**.

This is a cheap additional layer, **not** a replacement for the measurement. The internal pull-up is
~50 kΩ (~66 µA), which the plan already calls too weak to trust against an opto-isolator input, and
what a high-impedance input actually does depends on the relay board's own circuit. Choose these
pins anyway - it costs nothing and removes one way to be wrong.

## The devices

Verified live from the greenhouse Postgres. These get re-entered by hand into the fresh database.

| name          | gpio | on_delay (s) | on level               | rules today | goes where                   |
| ------------- | ---- | ------------ | ---------------------- | ----------- | ---------------------------- |
| CO2 Generator | 16   | 300          | **LOW** (active-low)   | disabled    | → **elantris / tempestas**   |
| Exhaust Fan   | 20   | 60           | LOW                    | enabled     | stays on the Pi 5 for now    |
| Lights        | 21   | 900          | LOW                    | enabled     | stays on the Pi 5 for now    |
| Single Light  | 26   | 900          | **HIGH** (active-high) | enabled     | stays on the Pi 5 for now    |
| Extra Relay   | 12   | 0            | LOW                    | disabled    | spare — **unknown function** |

Two things this table settles:

- **Active-high vs active-low is per-device data, not a constant.** Four relays are active-LOW
  (standard opto-isolated boards); `Single Light` is active-HIGH. That is why `onLevel` is a column
  and why a node receives explicit electrical levels rather than "on"/"off".
- **The CO2 handover is clean.** `CO2 Generator` already has automation disabled on the old system,
  so moving it is a wiring change plus enabling the rule here — not two controllers contending for
  one device.

⚠ **`Extra Relay` (BCM 12) is unidentified and active-LOW.** `on_delay_duration = 0` suggests
something benign, but until somebody traces the wire, treat it as hazardous and do not wire it to
elantris.

## Select the GPIO chip by label, not by number

Verified on elantris: `gpiodetect` reports only `gpiochip0 [pinctrl-bcm2711]` (58 lines) and
`gpiochip1 [raspberrypi-exp-gpio]`. **There is no real chip 4** — `/dev/gpiochip4` is a
compatibility symlink to `gpiochip0`.

The old code probes `[4, 0, 1, 2, 3]` and opens chip 4 first because a **Pi 5's** RP1 bank _is_
chip 4. On elantris that works only by the accident of the symlink. Since the Pi 5 will eventually
run the _same_ sidecar, the node selects its chip by **label** — `pinctrl-bcm2711` on a Pi 4,
`pinctrl-rp1` on a Pi 5 — and fails loudly if neither is found. One sidecar build, correct on both
boards, instead of a probe order that happens to work.

## The boot-window hazard

Unclaimed active-low lines command their relays **ON**, and a line is unclaimed through the whole
boot window and every crash gap. This is the most dangerous property of the build and it is not yet
mitigated. Full detail, the measurement that gates it, and the three required mitigations are in
[Safety](Safety.md#the-boot-window-hazard).

## The sensor

**SCD-4x (Adafruit SCD-41, STEMMA QT)** on I²C, `/dev/i2c-1`, address `0x62`. Currently one per node;
the capability model allows several.

Measured on elantris (2026-09-09), with `scd4x_healthcheck.py`:

|                             |                           |
| --------------------------- | ------------------------- |
| Serial                      | `5fd90b073b7a`            |
| Internal self-test          | **PASS** (`0x0000`)       |
| Live read                   | 636 ppm, 21.4 °C, 64 % RH |
| Stored `temperature_offset` | **6.56 °C**               |

That offset is worth a note, because the plan predicted the opposite. It assumed the value would
have been lost — the Adafruit setter never calls `persist_settings`, so it is volatile. The chip
currently holds 6.56 °C, close to the ~6 °C the plan expected somebody to have set. **This is not
yet evidence that it persisted**: the sensor has been powered continuously since it was set, so the
NVM question is still open and only a power cycle settles it. Applying the offset at every startup
stays correct either way, and the agent now logs the value it reads back at boot.

- **Phase 1 uses `adafruit-circuitpython-scd4x` on Blinka** — already installed and a year in
  production. Phase 2 may replace it behind the same interface with a raw `smbus2` driver derived
  from the existing `scd4x_healthcheck.py`, which already implements the protocol with CRC-8. That
  also fixes a subtle bug: the datasheet says `data_ready` is true when the **low 11 bits** are
  non-zero (`& 0x07FF`, which the healthcheck script gets right) where the Adafruit driver tests the
  whole word.
- **Temperature offset.** The sensor reads ~2 °C high against two independent references. The SCD4x
  default offset is 4 °C, so the correct value is 6 °C — but the Adafruit setter does **not** call
  `persist_settings`, so it is volatile and has almost certainly been reset by every power cycle
  since it was set. **Apply it at every startup** rather than depending on persistence, and tune it
  at the installed self-heating equilibrium, not in open air.
- **Never invent data.** On a zero CO2 the agent publishes `valid: false, value: null`. It does not
  substitute the last known good value as the old code does — see [Safety](Safety.md).
- **Configuration commands are NACKed while periodic measurement is running** (`Errno 121 Remote
I/O error`). Everything that configures the chip, _and any read-back of that configuration_, has
  to happen in the idle window at startup. Found by doing it wrong on real hardware; the ordering
  is now pinned by a test with a fake bus that records command words.
- **Calibration is destructive and there is no terminal on MQTT.** Two-phase confirm
  (`prepare` → single-use token → `commit`), preconditions the agent enforces and refuses on
  (periodic measurement running ≥ 3 min, CO2 σ < 20 ppm over 60 s), and a config gate defaulting to
  off. Target **420 ppm as a required parameter with no default** — the two existing scripts
  disagree (400 vs 500), and forcing the caller to state it stops that recurring.

## Building the Python environment on trixie

Debian 13 is PEP 668 externally-managed. Dependencies go through **`uv`** (always-a-venv, and
`uv.lock` is genuinely reproducible). The gotcha, found the hard way:

```bash
# The pip `lgpio` wheel (pulled in by adafruit-blinka) will NOT build without these two.
sudo apt install -y swig liblgpio-dev python3-dev build-essential
python3 -m venv .venv          # fully isolated - NOT --system-site-packages
.venv/bin/pip install -r requirements.txt
```

`swig` provides the SWIG codegen and `liblgpio-dev` provides `-llgpio` to link against; gcc, make
and python3-dev are already present. Verified working: `import board` reports board_id
`RASPBERRY_PI_4B`, `adafruit_scd4x` 1.4.13 imports.

**Never install `RPi.GPIO`, `rpi-lgpio` or `gpiozero`** into that venv — see [Safety](Safety.md).

## Pitfalls

- **`i2cdetect` lives in `/usr/sbin`**, which is not on a normal user's `PATH`.
- **systemd cannot see nvm.** It is a shell function, so units need the absolute interpreter path —
  on elantris that is `/home/gunderwood/.nvm/versions/node/v22.23.2/bin/node`.
- **`sudo -S` consumes stdin, so `echo config | sudo tee /etc/thing` writes the PASSWORD into the
  file.** Not hypothetical: it put a sudo password into `/etc/fstab` and a journald drop-in on this
  box. Stage privileged writes as the normal user and then `sudo install -m 644 /tmp/staged
/etc/thing`, which takes no stdin — and validate afterwards, since `findmnt --verify` catches
  fstab damage immediately.
- **Check `.conf.d/` before concluding a setting is unset.** Reading only
  `/etc/systemd/journald.conf` reported an uncapped journal that a drop-in had already capped.
- **`ping` to greenhouse or the Mac fails by design** (ICMP filtered). Test with `nc -z host port`.
- **SD card endurance.** ~150–250 MB/day of writes before erase-block amplification.
  `synchronous_commit = off` (which is _not_ `fsync=off` — worst case is losing under a second of
  sensor rows), batched inserts, `wal_compression`, capped journald. **Booting from a USB3 SSD is
  the strong recommendation** — one hour of work, removes the endurance question permanently.
- **Wi-Fi-only nodes are a reliability factor.** The existing `wifi_monitor.sh` watchdog exists for
  exactly this reason and should carry over per node.

## When to update this file

- A device is added, moved, rewired, or its polarity or pin changes
- `Extra Relay` is finally identified
- A node is added to the LAN, or an IP/hostname changes
- A sensor is replaced, or its offset is re-tuned
- A new build dependency is discovered on a fresh OS image
