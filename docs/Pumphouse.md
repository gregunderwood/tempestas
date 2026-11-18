# Pumphouse

## What it is

Freeze protection for the pumphouse over winter 2026-27: one Pi Zero W node with two or three
temperature probes, a heater and heat tape. It is also the first environment that is not the
greenhouse, so it forces the rules engine to stop assuming every zone is a greenhouse.

> [!note] Status
> **In progress.** Phase 0 is done: elantris's broker is back up with a boot-retry drop-in (see
> [Provisioning](Infrastructure/Provisioning.md)). **A to C are built** and their lasting content
> lives in [Rules and Climate](Rules%20and%20Climate.md) and [Node Agent](Infrastructure/Node%20Agent.md).
> **D is live on elantris** apart from the devices. Next is E: flashing patji.
> The greenhouse season is over, so the greenhouse zone can be changed freely as long as its
> behaviour next season is provably unchanged.

## Decisions already made

| Question                       | Decision                                                                 |
| ------------------------------ | ------------------------------------------------------------------------ |
| Which box                      | The Pi Zero W v1.1 `patji`, reflashed. Host and node keep the name       |
| Names                          | Host and node `patji`; the zone it is admitted to is `pumphouse`         |
| Where the DB and server run    | elantris, unchanged. The Pi runs the agent only, over MQTT               |
| Heat tape when control is lost | **Hold ~10 min, then ON**                                                |
| Heater when control is lost    | **Hold ~10 min, then ON**                                                |
| Why both fail on               | "On just costs electricity, off means frozen pipes"                      |
| Notifications                  | Out of scope. Home Assistant, later                                      |
| Rule design                    | A small fixed menu of rule kinds per role, chosen per zone. Still no DSL |
| Timezone                       | `America/Vancouver` everywhere                                           |
| Setpoints                      | Tape on below 4 °C, off above 6. Heater on below 2 °C, off above 5       |
| Which probe decides            | `min` across all probes: the coldest one. A third probe adds coverage    |

The heater originally failed **off**. That was reversed on 2026-11-17: a heater running through
an outage costs power, a heater that is off costs the pipes. Its own built-in thermostat and
overheat cut-out bound what "on with nobody watching" can do, so **the heater must have both**.

## Hardware

| Part                                   | Notes                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------- |
| Pi Zero W v1.1                         | BCM2835, ARMv6, 512 MB. `chip_label = "pinctrl-bcm2835"`                |
| Gikfun EK1083C DS18B20 probes (5-pack) | 3.0-5.5 V. Red VCC, black GND, yellow DATA. Adapter module with pull-up |
| 4-ch Songle SRD-05VDC-SL-C opto board  | **Mechanical**, active-LOW, JD-VCC jumper. Same family as elantris's    |
| TWTADE JQX-62F-2Z                      | 110 VAC coil, 80 A DPDT (2NO+2NC). Switches the heater                  |

```
Pi Zero                    Songle board                    Loads
 5V ───────────────────── VCC  (jumper fitted, as on elantris)
 GND ──────────────────── GND
 BCM 5 ───────────────── IN1 ─ COM/NC ── 120 V ── JQX-62F coil ── heater on its NO pole(s)
 BCM 6 ───────────────── IN2 ─ COM/NC ── 120 V ── heat tape
 3.3V / GND / BCM 4 ──── Gikfun adapter ── all DS18B20s in parallel
```

**Both loads hang off NC, and that is the failsafe.** A released Songle relay powers the heat
tape and the JQX-62F coil, so a dead, unpowered or booting Pi means **heat**, with no software
running at all. Both lines fail safe at the **same pad level, 1**, and BCM 5 and 6 are pulled up
at reset on the BCM2835, so the boot window lands there too.

Consequences worth knowing:

- Both devices have `onLevel` **1**: "on" means the Songle relay is _released_. In mild weather
  each IN coil is energised continuously to hold its load off. That is ~70 mA each and fine.
- **At the end of the season, unplug the heater and the tape.** With this wiring a Pi that dies
  in May turns both on and leaves them on.
- Probes wire in parallel to the one adapter: red to VCC, black to GND, yellow to DATA. Three is
  as easy as two.
- Probes on **3.3 V**, not 5 V, so DATA never presents 5 V to a GPIO.
- ⚠ Before wiring the JQX-62F, read the coil voltage **on the relay**. The listing title says
  110 VAC but its description text says DC 12V. A 12 VDC coil on 120 VAC burns out.
- ⚠ The heat tape goes straight through a Songle contact (10 A / 125 VAC). Read the tape's
  wattage; keep it under ~5 A (600 W) for margin on a cheap contact.
- Mains, open screw terminals and a damp pumphouse: everything in an enclosure.

### What each failure does

| Failure                            | Tape and heater          | Covered by                                      |
| ---------------------------------- | ------------------------ | ----------------------------------------------- |
| Pi unpowered, or booting           | ON                       | NC wiring, BCM 5/6 reset pull-ups, `gpio=` line |
| Agent crashed, restarting          | ON within ~5 s           | Claim at failsafe on restart                    |
| WiFi drop, or elantris unreachable | hold for 10 min, then ON | Node dead-man, `deadman_s = 600`                |
| tempestas-server stops or crashes  | ON **at once**           | The agent fails safe on the server's LWT        |
| Probes dead, node and server fine  | ON after `maxAgeMs`      | **New:** per-role `onStale: 'on'` (section A)   |
| Everything fine                    | rule                     | Thermostat rules                                |

Two rows deserve a note:

- **The server row skips the hold.** The agent treats the server's last-will as "fail safe now"
  rather than waiting out the dead-man. For a burner that is right; here it means a server
  restart (every deploy) turns the heater on until the server re-asserts a few seconds later. One
  extra heater cycle per deploy is accepted rather than adding a per-node switch for it.
- **The probes row is the one wiring cannot cover, and today's engine gets it wrong.** A stale
  sensor holds last state for every role, so a heater that was off when the probes died would stay
  off however cold it got.

## The work, in order

Each section is one or more commits that leave the greenhouse working. The gate after each is
`npx nx run-many -t lint,test,build` plus `npx nx test server --coverage`.

### A. Rule kinds per role (domain + engine) — ✅ built

Built as planned, with two additions found on the way: `daylight` moved up to the zone (lights,
burner and the readings screens all read one window), and roles are always evaluated in a fixed
`ROLE_ORDER` because Postgres hands jsonb keys back reordered. The migration was run forward and
back against Postgres 17 with the live greenhouse row: revert restored it byte for byte, and refused
(and rolled back) with a pumphouse zone present. What follows is the plan as written.

Today [rules.engine.ts](../apps/server/src/app/rules/rules.engine.ts) runs three role-specific
bodies against one greenhouse-shaped `RulesThresholds` that every zone must carry. Replace the
flat thresholds with a per-role rule, where the rule names one of a few **kinds written in code**:

```ts
type RoleRule =
  | ThermostatRule // heat: on below onAtC, off above offAtC; cool: the mirror
  | WindowedThermostatRule // lights: a thermostat that is only on inside a time window
  | Co2BurnerRule; // the existing day-enrichment / night-frost body, unchanged

interface RuleCommon {
  /** What to do when this role's sensors go stale. Today's behaviour is 'hold'. */
  onStale: 'hold' | 'on' | 'off';
  sensor?: SensorPolicy; // replaces sensorPolicy.byRole; zone default still applies
}

interface ZoneRulesConfig {
  enabledRoles: DeviceRole[]; // unchanged - ownership stays explicit
  sensorPolicy: { default: SensorPolicy };
  rules: Partial<Record<DeviceRole, RoleRule>>; // must cover every enabled role
  timezone: string;
}
```

- **The engine dispatches on `rule.kind`, not on the role.** The greenhouse's exhaust fan
  becomes a `cool` thermostat, so the pumphouse needs no new rule body at all, only data.
- **New roles:** `DeviceRole.Heater = 'heater'`, `DeviceRole.HeatTape = 'heat_tape'`.
- **`onStale`:** `'hold'` is today's behaviour, a no-op with reason `sensor-stale`. `'on'`
  and `'off'` drive the role, with a new reason `stale-failsafe`. Either way it still logs at
  ERROR and raises the banner. It is a fallback, not a silent fix.
- **The config is validated on load.** `rules_config` is hand-edited jsonb with no checking today.
  A pure `parseZoneRulesConfig()` rejects an unknown kind, a missing rule for an enabled role, or a
  heat thermostat whose on-setpoint is not below its off-setpoint. A zone that fails is not
  evaluated, logs at ERROR, and appears in `GET /api/health` `problems`. A typo must not become a
  heater rule.
- **Migration** rewrites the greenhouse zone into the new shape, number for number:
  `co2OffTemp 28` (the live value, not the docs' 26), `co2NightOnTemp 3`, `co2OnPpm 1400`,
  `co2OffPpm 1500`, window `06:30-18:30`, lights `26/27`, exhaust `30/29.5`, all `onStale:
'hold'`. A `down` that restores the flat shape. Verified against real Postgres, not just a
  mocked repository (see the AGENTS pitfall).
- **Proof of no change:** the existing engine specs are run against a greenhouse config built
  through the migration's shape and must pass unmodified.
- Docs: [Rules and Climate](Rules%20and%20Climate.md) is rewritten around rule kinds, and the
  "no DSL" reasoning stays: the menu grows by code review, never by config.

### B. Several sensors on one node (server + web) — ✅ built

Built as planned with one simplification: the codec does **not** look up the sensor's capability
to decide whether humidity is required. Humidity is now treated exactly like CO2, an invalid or
missing value is stored as null, because no rule reads humidity and the capability lookup would
have put a database read in the decode path for nothing. The gauges are where the declared metrics
matter, and they use them. Also found: Section A added `heater` and `heat_tape` to the TypeScript
enum but not to the Postgres `devices_role_enum`, so a pumphouse device row could not have been
inserted. `AddHeatingRoles` fixes that. What follows is the plan as written.

Three things in the server assume one sensor per node:

| Where                                                                                       | Today                                                           | Change                                                                  |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `latestSamplesForZone` in [rules.service.ts](../apps/server/src/app/rules/rules.service.ts) | `DISTINCT ON (node_id)`, so a second probe overwrites the first | `DISTINCT ON (node_id, sensor_id)`, and `NodeSample` carries `sensorId` |
| `sensor_readings.humidity`                                                                  | `NOT NULL`                                                      | Nullable, by migration                                                  |
| `decodeSample` in [mqtt-codec.ts](../apps/server/src/app/hardware/mqtt-codec.ts)            | Rejects a sample without valid humidity                         | Requires humidity only if that sensor's capability lists `humidity`     |

Plus:

- A new sensor source **`sensor:<node>/<sensorId>`** beside `node:<slug>`, so a role can be
  pinned to one probe. `sourceNodeIds` gains a sibling `sourceSensorIds` for provenance.
- **A probe that dies beside a working one must not vanish silently.** With `min`, the fresh
  filter just drops it and the rule carries on with one probe. That is the right control
  behaviour, but it gets an entry in health `problems` so a dead probe is visible.
- Web: the dashboard card renders gauges from the sensor's declared metrics, one temperature per
  probe, and nothing for metrics the sensor does not have. Today it assumes humidity and CO2.
- The realtime reading event's `humidity` becomes nullable.

### C. The DS18B20 backend (agent) — ✅ built

Built as planned against a fake sysfs tree. There were two additions. First, an **all-zero
scratchpad** is refused: its CRC is zero, so the kernel reports `YES` and `t=0`, which is what
a shorted data line looks like. Second, the not-measured reason is `NOT_MEASURED`, in the same
form as the agent's other reasons. Any number of probes works, so a third is only a
`[[sensor.probes]]` entry. What follows is the plan as written.

```toml
[sensor]
kind = "ds18b20"
sample_interval_s = 10.0

# Pinned by ROM id, never by discovery order - the same reason GPIO chips are
# chosen by label. A probe on the bus that is not listed is logged and ignored.
[[sensor.probes]]
rom = "28-xxxxxxxxxxxx"
sensor_id = "pipes"

[[sensor.probes]]
rom = "28-yyyyyyyyyyyy"
sensor_id = "air"

# Optional third, if one turns up - any number works.
# [[sensor.probes]]
# rom = "28-zzzzzzzzzzzz"
# sensor_id = "floor"
```

ROM ids are read off the bus at bring-up (`ls /sys/bus/w1/devices/`), one probe plugged in at a
time, and each probe is labelled at its cable end with the name it was given.

- Reads `/sys/bus/w1/devices/<rom>/w1_slave` and **requires the CRC line to say `YES`**.
- Refuses `85.000` (the chip's power-on reset value, which a brown-out returns as a plausible
  reading) and `-127`/missing (a disconnected probe). Range-guards -40 to 60 °C and reuses
  `RateGuard` for impossible jumps. The rule stands: never invent a reading.
- The agent's sample loop moves from one backend returning one reading to one returning a reading
  **per sensor id**. Each probe is published as its own sample with its own `sensor`, and
  `capabilities.sensors` lists each probe with `metrics: ["temperature"]`.
- **No contract change.** `sample/1` keeps all three measurement keys, and CO2 and humidity go
  out as `valid: false, reason: "not-measured"`. Optional keys would be a schema bump for no gain.
- Tests use a fake sysfs tree: good read, CRC `NO`, `85.000`, missing device, unlisted probe.
- `test_contract_matches_typescript.py` must still pass untouched, which proves the claim above.

### D. The node, the broker, the devices — ✅ done on elantris, devices wait for E

Done on 2026-11-17. The server and the elantris agent were deployed from the `pumphouse` branch,
and the three migrations ran after a `pg_dump` to `~/backups/` on elantris. The greenhouse zone
converted number for number. The ACL's `patji` block is now the heater node's, not the old
sensor-only one. The credential was generated on elantris and is kept at
`/etc/tempestas/patji-agent.env` (0600 root), ready to be copied to the Pi as its `agent.env`.
It was verified with MQTT v5: own topics RC:0, another node's sample and its own `gpio/set`
RC:135. (For one day the identity was called `pumphouse`; on 2026-11-18 it was renamed back
to `patji`, with the password unchanged, and `pumphouse` is now refused.) The
zone came from [tools/pumphouse-zone.sql](../tools/pumphouse-zone.sql) and evaluates as
`no-sensor` until the node exists.

Two things were found on the way. `tools/deploy.sh` refused to deploy because a browser tab
held a client socket on :7000; it now checks listeners only. And the Provisioning advice to
`chown root:root` the password file took the broker down for every client on reload (see
Provisioning). **The devices are not created yet:** they need the node admitted, which needs
the Pi flashed (E). The probe ROM ids in `patji.toml` are placeholders that the agent
refuses to start with until they are read off the bus. The plan as written follows.

- [apps/hardware/nodes/patji.toml](../apps/hardware/nodes/patji.toml): `node_id = "patji"`,
  `lines = [5, 6]`, `chip_label = "pinctrl-bcm2835"`, failsafe `5 = 1` and `6 = 1`,
  **`deadman_s = 600`**. That is the "hold, then on": both lines fail to the same "on", so a
  single node-wide timer gives the hold with no agent change. A WiFi blip shorter than ten
  minutes changes nothing.
- [tempestas.acl](../apps/hardware/mosquitto/tempestas.acl): a `patji` identity scoped like
  `elantris` (its own subtree, never `gpio/set`), replacing its old sensor-only block. The password is
  generated **on elantris** and verified with MQTT v5, both per Provisioning.
- The agent unit: `SupplementaryGroups=gpio` only. 1-wire sysfs is world-readable, and there is
  no I²C on this box.
- Pumphouse zone, via SQL in a script under `tools/`. There is no zones API, and data for one
  installation does not belong in a migration every dev database runs.

  ```
  enabledRoles: ['heater', 'heat_tape'], sensorPolicy.default: { source: 'min', maxAgeMs: 120000 }
  heat_tape: thermostat heat, on below 4, off above 6, onStale 'on'
  heater:    thermostat heat, on below 2, off above 5, onStale 'on'
  timezone:  America/Vancouver
  ```

- Devices, through the API after admission. **Both `onLevel` 1**, because both hang off NC:

  | Name      | BCM | onLevel | onDelayDuration | role        |
  | --------- | --- | ------- | --------------- | ----------- |
  | Heater    | 5   | **1**   | 300             | `heater`    |
  | Heat tape | 6   | **1**   | 60              | `heat_tape` |

### E. Flash and install

**The OS: Raspberry Pi OS Lite (32-bit), the 2026-10-06 release, Debian 13 Trixie.** It is the
current release, and the 32-bit armhf build is the only one the Zero W's ARMv6 core runs. The
64-bit images are not an option on this board. Lite, because there is no display and every
megabyte of the 512 matters. Fallback: **Raspberry Pi OS (Legacy, 32-bit) Lite**, Bookworm, same
date. patji ran Bookworm 12.14 before this reflash, so it is proven on the board.

**1. Before flashing: the address.** patji keeps a fixed address through a **DHCP reservation
on the router** (192.168.2.1), the same as the other hosts. That means no static config on the
Pi, nothing to forget on a reflash, and one place that lists every host.

| Host        | Address          |
| ----------- | ---------------- |
| celestine   | 192.168.2.20     |
| **patji**   | **192.168.2.40** |
| greenhouse  | 192.168.2.50     |
| elantris    | 192.168.2.70     |
| silverlight | 192.168.2.200    |

The router already held a reservation for patji at `.40` from its sensor-node days, kept on
2026-11-18. The Zero W's WiFi MAC (`b8:27:eb:…`) is fixed per board, so the reservation
survives every reflash and there is nothing to do on the router. (patji was seen at `.252` in
its old logs, presumably before the reservation existed.)

**2. Flash with Raspberry Pi Imager**, device "Raspberry Pi Zero", OS "Raspberry Pi OS (other) →
Raspberry Pi OS Lite (32-bit)". In the customisation screens:

- Hostname **`patji`**
- User **`gunderwood`**, with a password as well. It is the console fallback, and `sudo` asks
  for it.
- WiFi: the house SSID, country **CA**
- Locale: timezone `America/Vancouver`, keyboard `us`
- SSH: on, **public key only**, with the laptop's key `~/.ssh/id_rsa.pub`
  (`SHA256:o48WBt95…`, the same key elantris and greenhouse trust). Password login stays off.
- Telemetry off

Then, before ejecting, add to `/boot/firmware/config.txt` on the card (`bootfs`):

```
dtoverlay=w1-gpio            # gpiopin=4 is the default
gpio=5,6=op,dh               # relays released (loads ON) from ~1 s after power-on
```

The `gpio=` line belongs there before the first boot, not after: from then on, the board can
be powered with the relays attached and the loads stay on through every boot.

**3. First boot.** WiFi on a Zero W takes a minute or two, and the first boot resizes the
filesystem and reboots once.

```
ssh patji                                  # 192.168.2.40, via the laptop's ~/.ssh/config
```

If it is not at `.40`, `ssh patji.local` (mDNS) and compare `cat /sys/class/net/wlan0/address`
with the router's reservation. Check
`date` reads `MST -0700` (Trixie's tzdata knows BC's change, Node's does not; see G).

**4. The box.**

- `sudo apt update && sudo apt full-upgrade`
- Hardware watchdog: `RuntimeWatchdogSec=15` in `/etc/systemd/system.conf`
- `sudo apt install python3-lgpio python3-venv rsync`
- `ls /sys/bus/w1/devices/` lists `w1_bus_master1` even with no probes: the overlay is loaded

**5. The agent.** Code is rsynced from the laptop; nothing is built on the Pi.

- `python3 -m venv --system-site-packages .venv && .venv/bin/pip install -e .`. There is no
  `uv` on ARMv6, and the apt `lgpio` saves an afternoon of compiling.
- The credential, without it ever passing through the laptop's terminal:
  `ssh elantris sudo cat /etc/tempestas/patji-agent.env | ssh patji 'sudo install -d -m 0755 /etc/tempestas && sudo tee /etc/tempestas/agent.env >/dev/null && sudo chmod 0600 /etc/tempestas/agent.env'`
- [patji.toml](../apps/hardware/nodes/patji.toml) to `~/tempestas/etc/agent.toml`. It will not
  start until the probe ROMs are filled in, which happens when the board is built (F).
- The agent unit with `SupplementaryGroups=gpio` only, `systemd-analyze verify`ed, and enabled.

**6. Then the board** (relays, contactor, probes). Read each ROM with one probe plugged in at a
time, fill in `patji.toml`, start the agent, admit `patji` to the `pumphouse` zone, and create
the two devices from D. Then the bench test.

### F. Bench test, before it goes outside

A lamp stands in for each load. Every row of the failure table above is exercised, not inferred:

Start with both loads commanded **off** (probes warm), so every failure is visible as lamps
coming on:

- [ ] Every probe reports, with distinct sensor ids, and the node is admitted
- [ ] Each relay switches from the API and from the rule, using a probe in ice water
- [ ] Unpower the Pi: both lamps on
- [ ] `kill -9` the agent: both on within ~5 s, back under rule control after
- [ ] Block the Pi from the broker (firewall rule on elantris): nothing for 10 min, then both on,
      and the server re-asserts when unblocked
- [ ] Stop `tempestas-server`: both on at once (LWT), back under rule control when it returns
- [ ] Unplug every probe: `stale-failsafe` within `maxAgeMs`, both on, banner up
- [ ] Unplug one probe: control continues on the rest, health reports the dead one
- [ ] Cold reboot: no chatter through boot, then the rule takes over
- [ ] Then out to the pumphouse, and watch a day of WiFi before trusting it

### G. Node's timezone data is older than the OS's

Found while answering the timezone question, and independent of the pumphouse. **BC moved to
permanent UTC-7 on 2026-11-01.** elantris's tzdata (2026b) knows that: `America/Vancouver` is
now `MST -0700`. Node 22.23.2 bundles its own ICU tzdata (2026a), which does not, and still
falls back to PST, UTC-8.

The server resolves local time through `Intl` ([local-time.ts](../apps/server/src/app/rules/local-time.ts)),
so since 1 November it has been running **an hour behind** the wall clock. It shows in the logs,
where Nest's timestamps trail journald's by an hour. Thermostats do not read the clock, so the
pumphouse is unaffected. The greenhouse's 06:30-18:30 window, and every local time the API
reports, is out.

Two parts, both needed:

1. **Fix it:** run Node with ICU data that has 2026b. Either a Node release that bundles it, or
   point `NODE_ICU_DATA` at a current `icudt*.dat`. Then `node -p "new Date().toLocaleString('en-CA',{timeZone:'America/Vancouver',timeZoneName:'short'})"`
   must agree with `date` on the box.
2. **Make it loud next time:** at startup the server compares its own UTC offset for each zone's
   timezone against the OS's (`TZ=<zone> date +%z`), and a disagreement is an ERROR and a health
   `problem`. Two clocks quietly disagreeing about local time on a system with time-windowed
   rules is exactly the class of failure this repo already pays for once (the old DST bug).

### H. Housekeeping

- Delete `tools/stage-b-soak.py` and `apps/hardware/systemd/tempestas-stage-b-soak.service`. Its
  job, tuning elantris's temperature offset, was done on 2026-09-10, and the legacy controller it
  reads from is off for the season. The unit is already disabled on elantris; remove it there too.

## Open questions

None blocking. To revisit after the first week outside:

1. **Dead-man length.** 600 s is a guess at "longer than a WiFi blip". If the logs show
   `DEADMAN_TRIPPED` often, the link is the problem, not the number.
2. **Probe placement.** Coldest pipe and the air to start, a third wherever it turns up. If one
   spot is always the minimum, the others are only backups, which is still worth having.

## When to update this file

- A section above is built: mark it, and move its lasting content into the doc it belongs to
- The wiring, a load, or the failsafe posture changes
- An open question is answered
