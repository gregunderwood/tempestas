# Off-the-shelf devices

## What it is

Whether mass-market smart plugs, switches and sensors — Tasmota, ESPHome, Zigbee2MQTT — can be
absorbed as tempestas nodes, where the translation belongs, and which device classes are safe to put
on hardware nobody here controls.

The appeal is real: a relay channel exists only where mains has been run to elantris, and the board
is eight channels of which three are wired. A smart plug is a relay channel anywhere there is an
outlet, added in minutes. The cost is that vendor firmware implements none of the node contract, and
one of the guarantees cannot be recovered by any amount of software on our side.

> [!note] Status
> Nothing here is built. No `pump`, `moisture` or bridge concept exists in the codebase; `DeviceRole`
> is still lights, co2_generator and exhaust_fan. Two open questions below are modelling decisions
> that want settling **before** any of this reaches the database.

## Key files

- [Node Agent](Node%20Agent.md) — the conforming agent a bridge would be a variant of
- [../../libs/domain/src/lib/nodes/node.model.ts](../../libs/domain/src/lib/nodes/node.model.ts) — `NodeCapabilities`, and the rule that nothing branches on `NodeKind`
- [../../libs/domain/src/lib/devices/device.model.ts](../../libs/domain/src/lib/devices/device.model.ts) — `DeviceRole`, `onDelayDuration`
- [Home Assistant](Home%20Assistant.md) — the other route to the same devices, and the ownership hazard shared with this one

## The translation belongs in one bridge, not in each device

Off-the-shelf devices speak their vendor's MQTT dialect, not `tempestas/v1`. There are two places to
fix that, and only one of them scales.

**Not per-device firmware.** ESPHome and Tasmota can both be pushed onto arbitrary topics, so the
envelope and the topic tree are reachable. What is not reachable in YAML or a rules engine is the
rest of what a node owes: the `hello`/capabilities handshake, `judge_command`'s refusals, readback
into `gpio/result`, alarms, and a dead-man that counts heartbeats and drives declared safe levels.
Re-deriving those per device type is how _"a required node behaviour, not a convention"_ quietly
stops being true.

**A bridge node.** The agent already separates the contract from the hardware behind a backend seam:
announce, sample, `judge_command`, dead-man and failsafe are backend-agnostic, and the GPIO backend
is one implementation of a narrow interface. A **vendor-MQTT backend** slots into the same place —
its "lines" are smart plugs, and everything above it is code that already exists and is already
tested.

The server needs no change at all. A bridge presents `NodeCapabilities` like any node: `gpio.pins`
enumerates the plugs, `supportsReadback` tells the truth about whether the device confirms state,
`maxCommandRateHz` covers the slower round trip. A `Device` row points at `(nodeId, gpio)` as
always. Adding a plug is a row, which is the invariant in [Architecture](../Architecture.md) working
as intended.

## What a bridge cannot inherit: reachability

This is the finding that decides everything below it.

The dead-man's guarantee rests on an assumption the GPIO backend satisfies silently: **a managed
line is always reachable.** A pad is on the same die as the process driving it. When the dead-man
expires, or the server's LWT arrives, or the agent restarts and claims at failsafe, the write
_cannot_ fail for want of a network.

A smart plug is reachable only across Wi-Fi and a broker. Every one of those moments — dead-man
expiry, LWT, claim-at-failsafe on restart — becomes best-effort. Worse, the cases that trip the
dead-man correlate with the cases that break reachability: if the bridge lost the brain because the
network is unwell, it will likely fail to drive the plug safe for the same reason.

Two consequences, both structural:

- **The device needs its own safe-state timer**, independent of the bridge. Tasmota's `PulseTime` and
  the ESPHome equivalent auto-off after N seconds with no network at all. That is the only layer that
  survives the failure this section describes, and it can express exactly one safe state: **off**.
- **`issuedBy` has no vendor equivalent.** The agent's strongest guard binds commands to the
  heartbeating controller; a Tasmota plug obeys whoever can publish to its command topic. Broker ACLs
  are the only substitute, which makes them load-bearing rather than hygiene.

## The rule that follows

A device class may live on off-the-shelf hardware **iff its declared safe state is `off`**, because
`off` is the only safe state cheap firmware can hold on its own.

| Role                      | Declared safe state                | Off-the-shelf?                            |
| ------------------------- | ---------------------------------- | ----------------------------------------- |
| `exhaust_fan`             | **off** — benign either way        | ✅ Yes                                    |
| A pump (not yet modelled) | **off** — and off is the interlock | ✅ Yes, the best fit of any device        |
| `lights`                  | brief hold, then off               | ~ Acceptable; the hold is not expressible |
| `co2_generator`           | **long hold at night**             | ❌ Never                                  |

The burner is excluded twice over: no vendor firmware can express "hold, night-aware", and the one
timer that does survive a network partition implements the opposite of what a night heater needs.

### The fan is the case worth doing first

`exhaust_fan` is still on the legacy Flask app, waiting on a cutover that currently implies mains
work at elantris. On a smart plug it can move to tempestas **without being wired to elantris at
all** — no relay channel, no dependence on the two faulty channels being diagnosed. It decouples a
roadmap step from the physical rewire, on the one role whose safe state is unambiguous.

## Sensors are cheaper, but a CO2 sensor is not harmless

An input cannot energise anything directly, so the admission gate and per-node ACLs are the whole
story for most of them. Adding temperature and humidity coverage is genuinely low-consequence, and
the microclimate split between the two boards means more measurement points have real value.

**CO2 is the exception.** The day branch is `t < 26 AND co2 < 1500`: a sensor reading low in the
afternoon turns a propane burner on. `Safety` rule 4 protects against a _null_ — `+Infinity` keeps
the branch off — but a sensor that is confidently wrong produces a number, not a null, and nothing
downstream can tell the difference.

So introduce a CO2 sensor **outside the burner's decision** and leave it there until it has earned
its place. The mechanism already exists:

```jsonc
"byRole": { "co2_generator": { "source": "node:elantris" } }
```

The new sensor contributes to display and to the zone mean; the burner keeps reading the sensor whose
calibration history is known. Fold it in after weeks of agreement, not on the day it arrives.

## Buying constraints

### CO2

- **True NDIR only.** SCD30/SCD40/SCD41 or MH-Z19. Cheap "CO2" sensors (SGP30, CCS811) measure VOCs
  and infer a CO2-shaped number — not a CO2 measurement, and it fails by reading plausibly.
- **Range to at least 5000 ppm.** Consumer air-quality units often stop at 2000; this greenhouse
  reaches ~2500.
- **ABC must be disableable.** Automatic Baseline Correction assumes the space returns to ~400 ppm
  outdoor air regularly. An enriched greenhouse never does, so ABC drags the calibration
  progressively wrong with no error and no warning. Most consumer units do not expose the setting.
- Expect a self-heating offset of its own, usually worse inside a sealed consumer enclosure.

Given all three, an ESP32 plus an SCD41 running the existing agent is a serious contender: it speaks
the contract natively, needs no bridge, and keeps calibration under our control. CO2 is the one
measurement not worth handing to vendor firmware.

### Soil moisture

- **Capacitive only.** Resistive two-prong probes electrolyse and corrode within weeks.
- **The reading is relative, not absolute.** It drifts with soil salinity, temperature and above all
  placement — a probe near an emitter reads wet indefinitely, one at the pot edge reads dry. Two
  probes in one pot can disagree substantially. Absolute volumetric water content needs a
  TEROS-12-class probe at many times the price.
- Practical options: an Ecowitt WH51 class sensor (capacitive, weatherproof, long battery, gateway to
  MQTT, several per gateway); Zigbee soil sensors via Zigbee2MQTT, checking the device list first;
  BLE units like Flower Care, which need a proxy and are known to drift at the probe.

### Switches

- Check the plug's own rating, and remember the relay contacts are **10 A** feeding 15 A outlets — a
  plug downstream of a relay does not raise that ceiling.
- Pumps are inductive; allow headroom for inrush. A peristaltic or small aquarium pump is trivial, a
  submersible or pressure pump is not.

## Pumps and irrigation

A pump is the device class that fits off-the-shelf hardware best, and the one whose control law is
least like anything here today.

**Dose by time; gate by sensor; never trigger on the sensor.** "Run until the sensor says wet" with a
stuck-dry probe floods the bench continuously — the irrigation form of a dead CO2 sensor stuck low
running the burner forever. A bounded dose on a minimum interval, with moisture as a _veto_ ("skip,
still wet"), means a failed or missing reading declines to water rather than watering without end.
That is the same polarity as the null-CO2 rule, applied to a different medium.

`onDelayDuration` already expresses the minimum interval. The missing half is a **maximum on-time**,
which appears in Stage C's verification list as the max-on latch and exists nowhere in the code.
For a pump it is not an extra safeguard, it is the primary one, and it belongs on the device's own
timer for the reachability reason above.

**The real protection is physical.** A reservoir that cannot hold more than one safe dose, a float
switch, drip trays. Same argument as independent backup heat: software is the second line. And a
mains pump in a greenhouse wants GFCI/RCD without discussion — or better, a 12 V pump, so the plug
switches a PSU rather than mains next to water.

## Two open questions to settle before any of this reaches the database

1. **Irrigation is not climate-shaped.** `RulesThresholds` is setpoints, hysteresis and a time
   window; watering is dose, interval and veto. Forcing it into `ZoneRulesConfig` produces exactly
   the config that needs a paragraph to explain what it does. It wants its own shape and its own pure
   evaluator — the same pattern, not the same struct.
2. **Soil is not airspace.** A zone is deliberately _"one airspace, one temperature, one CO2
   concentration"_, which is why rules scope to it. Two benches in one airspace need independent
   watering, so `zoneId` does not provide the scoping. Either a smaller unit exists, or a pump and
   its probe scope themselves.

Both are cheap to decide now and expensive to change once there are rows.

## Ownership and the broker

Home Assistant auto-discovers Tasmota and Zigbee2MQTT devices the moment they appear. If HA holds a
plug and tempestas commands it, that is the contended-relay failure this repo keeps guarding
against, arriving by a new route. **One owner per device**, recorded the way `enabledRoles` records
role ownership.

Keep vendor traffic in its own tree and out of `tempestas/v1/#`, and give the bridge the only
credential that can write to vendor command topics. With `issuedBy` unavailable on the vendor side,
the ACL is the guard.

Ownership now has a shape to live in. [Multi-Controller](../Multi-Controller.md#configuration-two-tiers-split-by-who-can-know)
splits config into **inventory** — what exists and how to reach it, written by whichever box can
physically reach the device — and **policy**, written only by the leader. Discovery writes inventory;
promoting an entry into a device with a role is a human act on the leader. So a device HA finds
cannot become something tempestas commands without somebody adopting it, which is this section's
rule enforced by the schema rather than by remembering.

That doc also carries the **reachability classes** the bridge introduces: a broker-reachable plug can
be commanded by any box that reaches a broker, while a Zigbee device is reachable only through the
box holding its dongle — a per-device single point of failure with no failover at all.

## Where it fits

After the agent's backend seam is stable, and not before phase 7. The bridge is a second backend
plus a config file, not a new service. Sensors can be admitted earlier than switches, since the
admission gate already covers them and a pinned `sensorPolicy` keeps a new one out of the burner's
decision.

## Pitfalls

- **A dead-man that has to cross a network is not a dead-man.** It is best-effort, and it fails in
  the same conditions that trigger it. The device's own auto-off is the layer that survives.
- **`off` is the only safe state cheap firmware can hold.** Every device-class judgement here follows
  from that one sentence.
- **A confidently wrong sensor is worse than a null.** Null is handled; plausible-and-wrong is not.
- **Never trigger irrigation on a moisture threshold.** Gate with it instead.
- **`issuedBy` does not exist on vendor devices.** Broker ACLs are load-bearing, not hygiene.
- **HA will find these devices by itself.** Decide the owner before plugging anything in.

## When to update this file

- A bridge backend is built, or the agent's backend seam changes
- A `pump` or moisture role is added, and with it the irrigation config shape
- Either open question above is answered — the decision moves to the doc it belongs in
- A device class is admitted to or removed from the off-the-shelf list
