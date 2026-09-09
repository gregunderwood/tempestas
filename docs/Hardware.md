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

**As actually wired on the panel** (2026-09-09):

| Relay channel | `In`        | Pi pin | BCM | Switches                            |
| ------------- | ----------- | ------ | --- | ----------------------------------- |
| **6**         | `In6`       | 29     | 5   | **both** outlets of one box, ganged |
| **7**         | `In7`       | 31     | 6   | one outlet — **CO2 generator**      |
| **8**         | `In8`       | 7      | 4   | one outlet — spare                  |
| 1–5           | `In1`–`In5` | —      | —   | **unwired** — free for bench use    |

The three BCM pins are unchanged from the recommendation — 4, 5 and 6, all of which default to
pull-up at reset — but they landed on a different permutation of the channels. Electrically that is
identical and not worth rewiring.

⚠ **There is no longer a mnemonic to fall back on.** The earlier `In = BCM + 2` rule is gone; the
mapping is arbitrary and only this table is authoritative. Which makes the empirical check below
matter more, not less: drive each pin low in turn and note which `DS` lights, rather than trusting
any arithmetic.

⚠ **The wired channels are 6, 7 and 8 — the three at one end of the board, not the first three.**
Channel _N_ is driven by terminal `In`_N_, so wiring to `In1`–`In3` would drive three unconnected
relays and switch nothing, which presents as a software fault rather than a wiring one.

**The burner goes on channel 7**, one of the two single outlets, reached through **BCM 6 / pin 31**.
Channel 6 gangs both outlets of its box, which is the wrong shape for a combustion appliance —
nothing else should be capable of being switched with it.

BCM 4's 1-Wire caveat now falls on channel 8, the spare, which is the harmless place for it.

⚠ **Label the ganged box.** Two outlets that switch together look exactly like two independent
outlets. Anything plugged into the second one is controlled by whatever the first one is for.

**Loads plug in rather than being hardwired**, and that changes bring-up for the better. Stage C's
"mains loads one at a time in ascending order of consequence" stops being wiring work: plug a desk
lamp into a relay's outlet, watch it switch, unplug it. The CO2 generator goes in last, into a
socket already proven with something harmless.

The five unwired channels are free test channels — their LEDs show switching with no load attached
at all, which is exactly what the boot-window measurement needs.

### The board, from the close-ups (2026-09-09)

|                |                                                                                |
| -------------- | ------------------------------------------------------------------------------ |
| Relays         | **Songle SRD-05VDC-SL-C**, 8 channels, 5 V coils                               |
| Contact rating | **10 A 250 VAC / 10 A 30 VDC**                                                 |
| Signal header  | 10-pin: `Gnd In1 In2 In3 In4 In5 In6 In7 In8 Vcc` — currently **unpopulated**  |
| Supply header  | 3-pin: `Gnd Vcc JDVcc`, with the **jumper fitted across Vcc–JDVcc**            |
| Isolation      | Opto-isolated inputs (one optocoupler per channel), series resistors ~1–1.8 kΩ |
| Per channel    | `DS1–DS8` indicator LEDs, `Q1–Q8` coil drivers, `D1–D8` flyback diodes         |

### ⚠ Do not plug a heater into these outlets

The relay contacts are **10 A**; the outlets they feed are 15 A. Nothing stops someone plugging in a
space heater and asking the contacts for more than they can break. The load side is now limited by
the relay, not by the receptacle, and that is not visible to anyone looking at the wall plate. Label
the box.

### Wire the logic side to 3.3 V, not 5 V

This is the one wiring decision worth getting right before anything is connected, and it follows
from the board being 5 V and the Pi being 3.3 V.

On an active-LOW opto board the input pin sits at the LED's cathode, with the anode at `Vcc` through
a series resistor. Pulling the input to 0 V lights the LED and energises the relay. To _de_-energise,
the Pi drives the pin high — but the Pi's high is **3.3 V**, and if `Vcc` is 5 V there is still
about `(5 − 3.3 − 1.2) / 1 kΩ ≈ 0.5 mA` flowing through the LED. That is enough to hold some
optocouplers partly on, so the relay may buzz or fail to release.

The fix is standard, and it is why the jumper matters:

1. **Remove the `Vcc`–`JDVcc` jumper.** As shipped it ties the coil supply to the logic supply, so
   the coils draw through whatever feeds `Vcc` and the opto isolation is defeated for the supply.
2. **`Vcc` (10-pin header) → the Pi's 3.3 V**, `Gnd` → Pi ground. Now the Pi's high equals the LED's
   anode voltage, so a high is _zero_ volts across the LED and the relay releases cleanly.
3. **`JDVcc` → the Pi's 5 V (pin 4).** That is one wire and no second ground: the board has a single
   ground net, already tied to the Pi at pin 25. Three Songle coils is roughly **220 mA**, which a
   Pi 4 on a decent 3 A supply carries without complaint, and it lands on the 5 V input rail rather
   than the 3.3 V regulator, so the logic side is unaffected.

   Two conditions on that. Use a **good PSU** — coil inrush on a marginal supply is how an SD card
   gets corrupted — and keep the lead short. And **revisit it if more channels are ever wired**:
   eight coils would be ~600 mA, at which point a separate brick stops being optional. The board's
   flyback diodes (D1–D8) handle the switching transients.

### The boot window may be much less dangerous on this board

The plan's boot-window analysis assumed a directly-driven board, where a pulled-down input energises
the relay. This board is opto-isolated with a ~1 kΩ series resistor, which changes the arithmetic: a
Pi pin at reset is an input with a ~50 kΩ pull-down, so the current available through the LED is
about `(5 − 1.2) / 51 kΩ ≈ 75 µA`. An optocoupler needs milliamps. **75 µA should not turn it on.**

That is a reason for optimism, not a conclusion. Confirm it empirically, and it takes under a
minute with no load attached:

1. Power the board, leave `In1` disconnected. The relay should stay released and `DS1` dark.
2. Tie `In1` to `Gnd`. It should click and `DS1` should light — which also **proves the polarity**
   rather than inferring it from the topology.
3. Connect it to a Pi pin, hold the pin low through a reboot, and watch what the LED does across the
   whole boot window.

If step 1 passes, the firmware `gpio=` defaults and the external pull-ups become belt-and-braces on
this board rather than mandatory. If it fails, they are mandatory exactly as the plan says.

### Choosing pins: a free extra layer

Nothing is wired to the Pi yet, so the pin numbers are still a choice, and the choice is worth
making deliberately. On the BCM2711, **GPIO 0-8 default to pull-UP at reset and GPIO 9-27 default to
pull-DOWN**. For an active-LOW relay board that means a line on GPIO 5, 6, 7 or 8 sits at the
de-energised level through the whole boot window, where BCM 12/16/20/21 - the greenhouse's existing
choices - sit at the energised one.

BCM 2 and 3 are the SCD4x's I2C bus and BCM 0/1 are the HAT EEPROM pins, so the realistic candidates
are **BCM 4, 5, 6, 7, 8**. Use **BCM 4, 5, 6 → `In6`, `In7`, `In8`** — a monotonic mapping with the
checkable rule `In = BCM + 2`.

⚠ **BCM numbers and `In` numbers are separate numbering systems that now overlap.** There is a
`BCM 6` and an `In6`, and they are not connected to each other. The `gpio` column on a device row is
the **BCM** number; the relay channel is the `In` number. Name which one you mean, every time.

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

### The device row to create on elantris

Once the bench test has confirmed the polarity, this is the row — note `gpio` is the **BCM** number,
not the relay channel:

| field             | value                                           |
| ----------------- | ----------------------------------------------- |
| `nodeId`          | `elantris` (the slug)                           |
| `name`            | CO2 Generator                                   |
| `gpio`            | **6** — BCM 6 (pin 31), which is `In7`, relay 7 |
| `onLevel`         | **0** — active LOW, _pending the bench test_    |
| `onDelayDuration` | 300 (the anti-short-cycle minimum-off)          |
| `role`            | `co2_generator`                                 |

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

- **The driver is raw `smbus2`, not Blinka.** The plan proposed
  `adafruit-circuitpython-scd4x` first and a raw driver later; the raw one already existed in
  `scd4x_healthcheck.py` and had been correct on this hardware for a year, so it went in from the
  start. It drops a large dependency tree and its swig/liblgpio build requirement, and it fixes a
  real bug: the datasheet says `data_ready` is true when the **low 11 bits** are non-zero
  (`& 0x07FF`), which the healthcheck script gets right and the Adafruit driver does not — it tests
  the whole word.
- **Temperature offset: measured 2026-09-09 against two references.** At 21:06:17Z the SCD41
  reported **19.31 °C / 77.8 % RH** with two LCD hygrometers beside it reading **21.4 °C / 61 %** and
  **21.6 °C / 64 %** — so it runs **2.19 °C cold** with a stored offset of **6.56 °C**, and the
  corrected value is **≈ 4.37 °C**, close to the SCD4x factory default of 4 °C.

  The humidity error is mostly a _consequence_ of that, not a second fault. Holding the reference
  water content fixed, a sensor that thinks it is 19.31 °C should report 71.5 % where the true value
  is 62.5 %; it reported 77.8 %, leaving 6.3 points unexplained — inside the combined tolerance of
  the SCD4x (±6 % RH) and a cheap LCD hygrometer (±5 %). Correct the temperature and the humidity
  largely corrects itself.

  ⚠ **This is a bench figure and it is not yet the one to commit to.** The offset must be tuned at
  the _installed_ equilibrium, and the number depends entirely on where the sensor physically ends
  up — see below. Applying it mid-soak would also put a step discontinuity through the dataset; the
  soak can be bias-corrected in post instead, now that the bias is known.

- **Put the sensor in the air it is measuring, not in the enclosure.** On a STEMMA QT cable it can
  sit well away from the Pi and the relay coils. Inside the panel it would read the enclosure rather
  than the greenhouse, and the offset would spend its life fighting self-heating that changes with
  relay duty. Outside, the bench figure above roughly transfers and stays stable.

- **Apply the offset at every startup** rather than depending on persistence. The Adafruit setter
  never calls `persist_settings`, so anything set through it is volatile — and even where a value
  has survived, re-applying it costs one I2C write and removes the question.
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
