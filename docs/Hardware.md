# Hardware

## What it is

The physical facts: which box, which pin, which polarity, which sensor, and the quirks that have
already caused bugs. None of this is discoverable from the code, and several items contradict the
old repo's `CLAUDE.md` — where the light pins are reversed and the thresholds are stale. **Trust
this file over that one.**

⚠ Read [Safety](Safety.md) before wiring or energising anything.

## The boxes

| Host         | Board                           | OS                                   | Role                                                                                                                                                                |
| ------------ | ------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `elantris`   | Raspberry Pi 4B, arm64          | Debian 13 (trixie), headless         | The first node **and** the brain. `192.168.2.70`, user `gunderwood`, Wi-Fi (`wlan0`)                                                                                |
| `greenhouse` | Raspberry Pi 5                  | 32-bit userland                      | Runs the legacy Flask app on lights + fans. Later reflashed to arm64 and demoted to a node                                                                          |
| `patji`      | Raspberry Pi Zero W v1.1, ARMv6 | Raspberry Pi OS Lite 32-bit (trixie) | The [pumphouse](Pumphouse.md) node: DS18B20s, heater, heat tape. `192.168.2.40` by DHCP reservation                                                                 |
| `braize`     | Raspberry Pi Pico W (RP2040)    | MicroPython                          | The crawlspace node: one DS18B20, heater, heat tape. `192.168.2.60` by DHCP reservation (MAC `28:cd:c1:0b:6d:8f`). See [Pico Agent](Infrastructure/Pico%20Agent.md) |

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

| Relay channel | `In`        | Pi pin | BCM | Switches                                                |
| ------------- | ----------- | ------ | --- | ------------------------------------------------------- |
| **6**         | `In6`       | 29     | 5   | **both** outlets of one box, ganged — **CO2 generator** |
| **7**         | `In7`       | 31     | 6   | one outlet — ⚠ load side unproven                       |
| **8**         | `In8`       | 7      | 4   | one outlet — ⚠ load side unproven                       |
| 1–5           | `In1`–`In5` | —      | —   | **unwired** — free for bench use                        |

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

**The burner goes on channel 6**, reached through **BCM 5 / pin 29** — not the choice the reasoning
below would have made, but the choice the hardware forced.

Bench-tested 2026-09-09: **channel 6 switches its load reliably. Channels 7 and 8 energise — the
coil pulls in and the indicator lights — but no power reaches their outlets.** The fault is on the
output side of those two channels and is not yet diagnosed; the likeliest candidate is the load
landing on `NC` instead of `NO`, which a continuity check across each screw block will settle. Both
channels are sound from the controller's point of view, so nothing in software is blocked by it.

⚠ **Channel 6 gangs both outlets of its box, and the burner is now on it.** That is the shape this
document previously argued against, so the mitigation has to be explicit: **only one of the two
outlets is ever occupied.** Anything plugged into the second is energised whenever the burner is.
That is a procedural control where a physical one would be better — fit a blank insert or tape over
the unused half, and label the box. The moment a second appliance appears there, it is being
switched by a combustion controller that knows nothing about it.

Once 7 or 8 is fixed, move the burner to a single outlet and this caveat goes away.

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

### Drive the logic side at 5 V, jumper fitted

**This reverses an earlier recommendation in this file, which was wrong.** The reasoning and the
correction are both kept, because the wrong version was argued confidently and someone will
otherwise re-derive it.

As wired and working:

| Pi pin | To    |                                                |
| ------ | ----- | ---------------------------------------------- |
| **4**  | `Vcc` | 5 V — logic **and**, via the jumper, the coils |
| 25     | `Gnd` | one ground net on the board                    |
| 29     | `In6` | BCM 5                                          |
| 31     | `In7` | BCM 6                                          |
| 7      | `In8` | BCM 4                                          |

The `Vcc`–`JDVcc` jumper stays **fitted**.

#### What the wrong version argued

On an active-LOW opto board the input sits at the LED's cathode with the anode at `Vcc`. With
`Vcc` at 5 V, the Pi's 3.3 V "off" still leaves about `(5 − 3.3 − 1.2) / 1.8 kΩ ≈ 0.5 mA` through
the LED, which can hold an optocoupler partly on so the relay never cleanly releases. Running the
logic at 3.3 V makes "off" zero volts across the LED. That effect is real.

#### Why it was the wrong trade here

It fixes a release problem this board does not have, and creates a pull-in problem it does. The
LED drive current when the pin is pulled low, with the `182` (1.8 kΩ) resistors this board carries:

| `Vcc` | LED current |
| ----- | ----------- |
| 5 V   | **2.11 mA** |
| 3.3 V | **1.17 mA** |

A PC817 at ~1 mA transfers poorly, so its output transistor does not saturate, so the coil driver
only partly turns on and the coil sits near its pull-in threshold. On a 5 V Songle coil that is the
difference between switching and almost switching.

#### The residual, which is real and accepted

Pi GPIOs are **not 5 V tolerant**. When a pin is not driving — at boot, or unclaimed — the board
pulls it up toward `Vcc` through that resistor and the Pi's input protection clamps it near 3.9 V.
It is out of spec, it is what essentially every Pi-plus-relay-board does, and the pull-up-at-reset
pins chosen here make it milder. The clean fix, if it is ever wanted, is a buffer or a relay board
designed for 3.3 V logic — not a configuration change.

#### The lesson worth keeping

The symptom that triggered the 3.3 V change — "relays click, load does not follow" — turned out to
be **the same on both voltages**, and was an output-side wiring fault on two channels. The voltage
was never the cause. Check that a symptom actually tracks a change before attributing it to that
change.

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

## The greenhouse Pi 5's relay board

A different board from elantris's, with a different channel count and a **contactor in the lights
path**. Confirmed against the running system 2026-09-10.

**4 channels, 10 A each**
([B07DN8DTRW](https://www.amazon.ca/dp/B07DN8DTRW)) — not the 8-channel board elantris uses. Four
channels is the whole budget, and all four are already spoken for. A fifth load — the MH light —
hangs off a separate relay module on its own pin.

| BCM | Drives             | Switched by                                              |
| --- | ------------------ | -------------------------------------------------------- |
| 21  | **HPS lights** (2) | 4-ch board → **contactor** — the board carries no load   |
| 20  | Exhaust fans       | 4-ch board directly — the only load it switches itself   |
| 16  | CO2 generator      | 4-ch board — **going dark**, CO2 moves to elantris       |
| 12  | nothing            | 4-ch board, no outlet on the other end                   |
| 26  | **MH light** (1)   | **Its own relay module**, not the 4-ch board — see below |

That is five loads across four board channels, which is the thing to get straight: **the MH light
does not use the 4-channel board at all.**

### The lights run through a contactor, not the relay board

The two HPS lights' load comes through a separate higher-current relay
([B08JHPKBKB](https://www.amazon.ca/dp/B08JHPKBKB)), and the 10 A board channel only drives that
relay's coil. So BCM 21 switches a **coil**, not a ballast.

This matters for more than wiring accuracy:

- **Two HPS ballasts are not a 10 A load you want on a hobby relay board.** The inrush on a magnetic
  ballast dwarfs its running current, and the contactor exists precisely so that surge lands on a
  part rated for it. Do not "simplify" this by moving the lights onto a board channel directly.
- **There is a second device between the pin and the light.** A stuck contactor looks exactly like a
  working relay from the Pi's side. Pin state is not proof the lights changed — which is the same
  argument [Safety](Safety.md) makes for reading state back rather than assuming it.

### `Extra Relay` (BCM 12) is identified — it drives nothing

Resolved 2026-09-10: the channel is connected to the board and **has no outlet or load on the other
end**. It is a spare, not a mystery, and the old ⚠ against it is withdrawn.

That makes it the obvious channel for the first far-end device that needs one, and the safest
possible target for a live bench test, since energising it cannot switch anything.

### The MH light is on its own relay module

There are two light fixtures and they are wired differently, which is why there are two light rows:

|             | **HPS lights**                                                             | **MH light**                                                             |
| ----------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Count       | 2 fixtures                                                                 | 1 fixture                                                                |
| Pin         | BCM 21                                                                     | BCM 26                                                                   |
| Switched by | 4-ch board → contactor ([B08JHPKBKB](https://www.amazon.ca/dp/B08JHPKBKB)) | its own relay module ([B00WV7GMA2](https://www.amazon.ca/dp/B00WV7GMA2)) |
| On level    | **LOW** (active-low)                                                       | **HIGH** (active-high)                                                   |

**The two fixtures have opposite polarity**, because they are switched by different hardware. This
is the single best argument in the system for `onLevel` being per-device data rather than a board
constant — one greenhouse, one Pi, two lights, two conventions. A migration that assumed "the
greenhouse board is active-low" would light the MH lamp the moment the pin was claimed.

Read live, BCM 26 is the only one of the five pins resting LOW:

```
12: op dh pd | hi     16: op dh pd | hi     20: op dh pd | hi
21: op dh pd | hi     26: op dl pd | lo   ← active-HIGH, so this is OFF
```

That is **correct and expected**, not an anomaly: LOW on an active-high line is off, exactly as HIGH
on the four active-low lines is off. All five loads are currently de-energised. The inverse is the
trap — a pin resting HIGH would mean the MH lamp is lit.

## The devices

Verified live from the greenhouse Postgres. These get re-entered by hand into the fresh database.

| name          | gpio | on_delay (s) | on level               | rules today | goes where                                |
| ------------- | ---- | ------------ | ---------------------- | ----------- | ----------------------------------------- |
| CO2 Generator | 16   | 300          | **LOW** (active-low)   | disabled    | → **elantris**; channel goes dark         |
| Exhaust Fan   | 20   | 60           | LOW                    | enabled     | stays at the far end                      |
| Lights        | 21   | 900          | LOW                    | enabled     | stays at the far end, via contactor       |
| Single Light  | 26   | 900          | **HIGH** (active-high) | enabled     | ⚠ **no channel** — trace before migrating |
| Extra Relay   | 12   | 0            | LOW                    | disabled    | spare, drives nothing                     |

Two things this table settles:

- **Active-high vs active-low is per-device data, not a constant.** Four relays are active-LOW
  (the 4-channel opto-isolated board); `MH Light` is active-HIGH on its own module. That is why `onLevel` is a column
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
| `gpio`            | **5** — BCM 5 (pin 29), which is `In6`, relay 6 |
| `onLevel`         | **0** — active LOW, _pending the bench test_    |
| `onDelayDuration` | 300 (the anti-short-cycle minimum-off)          |
| `role`            | `co2_generator`                                 |

`Extra Relay` (BCM 12) is **no longer unidentified** — it is a board channel with nothing on the
far end. See [above](#extra-relay-bcm-12-is-identified--it-drives-nothing). The open question has
closed too: `MH Light` (BCM 26) is the single Metal Halide fixture on its own relay module.

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

### Where the three sensors sit

The greenhouse runs roughly north-south. Not surveyed, but close enough that
the compass points mean something.

| Node         | Position                    | Air                                                     |
| ------------ | --------------------------- | ------------------------------------------------------- |
| `elantris`   | **North end**, the entrance | Ventilated. First air disturbed whenever the door opens |
| `greenhouse` | **West wall, south end**    | Under canopy, at the grow site                          |
| `patji`      | **East wall, middle**       | Under canopy, mid-house                                 |

That is a triangle rather than a line, and it is the first arrangement able to
answer a question the design has been carrying unresolved: **is this one zone or
two?**

A zone is defined as one airspace - one temperature, one CO2 concentration -
and two sensors 143 ppm apart can only tell you they disagree. A third point
between them distinguishes the two explanations:

- **A gradient.** patji reads between the other two, roughly in proportion to
  distance. One airspace that is simply not well mixed, and a zone mean is a
  fair summary of it.
- **A step.** patji reads close to `greenhouse` and both sit far from
  `elantris`. Then the entrance is a different airspace from the growing area,
  the zone mean is an average of two unlike things, and the zone wants
  splitting.

Worth resisting the urge to decide this early. The reading that settles it is
patji against `greenhouse` across a burn cycle, once patji has an offset - and
`elantris`'s sensor was failing when patji was installed, so the north point is
untrustworthy until it is replaced.

### The far-end sensor is the one over the plants

There are two SCD41s, and they are **not interchangeable**:

|        | `elantris`                     | `greenhouse`                         |
| ------ | ------------------------------ | ------------------------------------ |
| Where  | By the greenhouse **entrance** | **Directly under the plant canopy**  |
| Air    | Ventilated, near the door      | Sheltered, at the grow site          |
| Offset | Tuned: **3.2 °C** (see below)  | **Never set** — factory default only |

The canopy sensor measures **what the plants are actually in**. The entrance sensor measures the
airspace nearest the door, which is the first air disturbed whenever the greenhouse is opened and
the first to track outdoor temperature. For a question like "is the canopy too hot" or "did the
enrichment reach the plants", the far-end sensor is the better instrument and the entrance one is a
proxy — even though the entrance box is the one with the calibrated sensor and the CO2 generator.

That inverts the obvious reading of the [Multi-Controller](Multi-Controller.md) design. The leader is
whichever box holds the heartbeat, but **the best measurement of the growing environment lives on the
follower**, so a leader at the entrance is controlling partly on a proxy. Two consequences worth
holding onto:

- **Readings must cross the bus regardless of who leads.** This is already how the design works —
  both boxes ingest everything — but it is load-bearing, not merely tidy.
- **Calibrate the canopy sensor before trusting it for control.** It is running on the SCD4x factory
  default offset with no compensation for its mounting or self-heating, which is the same state
  elantris was in when it was reading ~3 °C warm.

#### One paired sample, 2 s apart (2026-09-10 18:43)

|      | entrance (corrected) | canopy (**uncalibrated**) |
| ---- | -------------------- | ------------------------- |
| Temp | 20.97 °C             | 24.93 °C                  |
| RH   | 64.9 %               | 52.4 %                    |
| CO2  | 1181 ppm             | 1038 ppm                  |

Do not read the 4 °C gap as a 4 °C gradient. Run both through Magnus and the **water vapour
pressure agrees to ~2.5 %** (16.08 vs 16.48 hPa) — which is what two sensors in _well-mixed air_
look like when one has an uncorrected temperature offset, because the SCD4x derives RH from the same
internal temperature it is reporting. The temperature difference is mostly instrument, not climate.

**CO2 is the honest tracer**, because it is injected at the entrance rather than being a derived
quantity: ~143 ppm higher at the entrance than at the canopy, in the same minute. That gap is a real
mixing gradient, and it is the measurement that says enrichment at the entrance arrives thinner
where the plants are. One paired sample is not a result — confirm it across a burn cycle before
sizing anything on it.

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

## Calibrating the SCD41's temperature offset

The SCD4x **subtracts** its stored offset from the raw internal temperature, so a sensor reading
**cold means the offset is too big** — reduce it by the measured error. It is set from
`temperature_offset_c` in the node's `agent.toml` at every startup and never trusted to persist,
because the chip's value has almost certainly been reset by some power cycle since anyone set it.

Tune it at the **installed self-heating equilibrium**, never in open air and never while the box is
still warming. After the panel was mounted the SCD41 climbed ~19.1 → 21.8 °C over twenty minutes
while the greenhouse itself was also warming, so a single snapshot was worthless. Take two or three
**simultaneous** pairs — a co-located reference meter plus the sensor at that timestamp — spaced
about 30 minutes apart; when the derived error stops changing, it has equilibrated.

Two rules that come out of doing it wrong once:

- **Pair only with a co-located reference.** The legacy controller's sensor is at the other end of
  the greenhouse in different air — see [Roadmap](Roadmap.md#the-two-boards-are-not-in-the-same-air).
- **Under-correcting is the safer error.** A sensor reading cold makes the heater run _more_.

### The humidity cross-check

Relative humidity is temperature-compensated, so the temperature error can be confirmed
**independently** — without using the reference hygrometers to derive it. Take the vapour pressure
the SCD41's own T and RH imply, then ask what RH that same air would read at the reference
temperature:

```
es(T) = 6.112 * exp(17.62 * T / (243.12 + T))       # hPa, Magnus
e     = (sensor_rh / 100) * es(sensor_t)            # what the sensor implies is in the air
rh    = 100 * e / es(reference_t)                   # what that air reads at the true temperature
```

On 2026-09-10 the SCD41 read 20.07 °C / 78.1 % against references averaging 23.43 °C / 63.5 %. A
3.36 °C correction predicts **63.6 %** — 0.1 of a point off the meters. Two independent
measurements agreeing on one number.

This is also why **"reads cold and damp together" is one fault, not two**: a single temperature
error produces both symptoms, so a large RH discrepancy is evidence _about temperature_ rather than
a second problem to chase.

### Direct sun makes a cheap reference meter useless

The trap that nearly produced a 6 °C correction instead of a 3 °C one. Two paired readings 38
minutes apart disagreed completely, and what settled which to believe was **the raw die
temperature**, backed out as `reported + offset`:

|                      | 21:05, meters shaded | 21:43, meter held in bright sun |
| -------------------- | -------------------- | ------------------------------- |
| Implied error        | 3.36 °C              | 6.05 °C                         |
| Humidity cross-check | **+0.1 pts**         | −4.9 pts                        |
| Implied self-heating | 3.2 °C               | 0.5 °C                          |

Across that window the SCD41's raw die sat at **26.5 → 27.0 °C**, essentially flat, while the meters
beside it climbed 23.8 → 26.4 °C. A bare breakout cannot hold within half a degree while its air
rises 2.5 °C, so the meters were reading sun rather than air.

Three checks, each of which catches this on its own:

- **Back out the raw die temperature** and confirm it moves with the reference. A flat die under a
  climbing reference means the reference is being heated by something the sensor is not in.
- **Run the humidity cross-check.** Sun on a meter raises its temperature without changing the air's
  water content, so the predicted RH stops matching.
- **Compare the implied self-heating with Sensirion's 4 °C default.** A figure near zero, or far
  above 4, is usually the measurement rather than the sensor.

Measure in stable shade or after sunset. A greenhouse under direct solar gain is the worst condition
for this, and it is exactly when somebody is most likely to be out there looking at it.

## When to update this file

- A device is added, moved, rewired, or its polarity or pin changes
- A light fixture is rewired, or either the contactor or the MH relay module is changed
- A node is added to the LAN, or an IP/hostname changes
- A sensor is replaced, or its offset is re-tuned
- A new build dependency is discovered on a fresh OS image
