# Multi-Controller

## What it is

The plan for running tempestas on **both** greenhouse boxes — elantris at the entrance and the Pi 5
at the far end, currently running the legacy Flask app — so each owns its own hardware, keeps its
own history, serves its own UI, and can take over the other's job.

> [!note] Status
> Designed, not built. The one prerequisite — epoch fencing — is a gap in the agent today.

## What is actually at each end

Not hypothetical. This is the running inventory as of 2026-09-10 — see
[Hardware](Hardware.md#the-greenhouse-pi-5s-relay-board) for the wiring detail.

|             | `elantris` — entrance              | `greenhouse` — far end                                                             |
| ----------- | ---------------------------------- | ---------------------------------------------------------------------------------- |
| Board       | Pi 4B, trixie arm64                | Pi 5, 32-bit userland, legacy Flask                                                |
| Relay board | 8 channel                          | **4 channel, 10 A**, plus a standalone module for the MH light                     |
| Drives      | CO2 generator (relay 6 / BCM 5)    | HPS lights via contactor (21), MH light via its own module (26), exhaust fans (20) |
| Spare       | five unwired channels              | one channel wired to nothing (12)                                                  |
| Sensor      | SCD41, **calibrated**, by the door | SCD41, uncalibrated, **under the canopy**                                          |
| History     | days                               | **2.89 M readings since 2025-08-23**, still logging every 10 s                     |

Three things fall out of that table, and each one shapes the design:

- **The far end has no spare capacity worth planning around.** Four board channels, three in use,
  one empty — plus a fifth load, the MH light, already off-board on its own relay module. A failover story in which elantris's CO2 generator gets re-driven from the far end is not
  physically available — nothing is wired between them. Failover means _the other box keeps running
  its own loads_, not that either can assume the other's wiring.
- **The CO2 channel at the far end goes dark, and stays wired.** CO2 moves to elantris, so BCM 16
  keeps its relay and loses its job. Leaving a de-energised channel in place is cheaper than
  rewiring, but it is exactly the sort of thing that gets rediscovered in two years by somebody
  who assumes it still works.
- **The year of history lives on the box that is not the leader.** Which is the strongest argument
  in this document for per-box databases.
- **The far end mixes relay polarities.** Its HPS lights are active-LOW through the board, its MH
  light active-HIGH through a separate module. Device rows carry `onLevel` individually for exactly
  this reason, and provisioning config as code has to preserve it per device — a board-wide default
  would light a lamp.

## The shape of the problem

Two controllers on one relay is the failure this whole system is built to prevent.
[Safety](Safety.md) puts it plainly: only one controller may hold the heartbeat. Failover means
deliberately handing that over, and the hard part is that **two machines cannot agree on who is
leader**. With two participants there is no majority, so "it is dead" and "I cannot reach it" are
indistinguishable. Every automatic scheme on two nodes degenerates into either split-brain or both
sides refusing to act.

The way out is not to make the election correct. It is to **make a wrong election harmless**.

## Fencing: the one thing that must be built first

A node already refuses a command whose `issuedBy` is not its bound controller. What it does not do
is defend that binding:

```python
if isinstance(controller, str) and controller != self.bound_controller:
    log.warning("bound to controller %s (epoch %s)", controller, body.get("epoch"))
    self.bound_controller = controller
```

The `epoch` is **logged and never compared**, so a node binds to whichever controller heartbeated
most recently. Two controllers today would ping-pong the binding and each would be obeyed while it
held it.

Make `epoch` a monotonic fencing token:

- A node records the highest epoch it has ever seen and **never accepts a lower one**.
- A controller takes over by heartbeating at a **higher** epoch.
- A command from anything other than the currently bound controller is refused and alarmed, as now.

That single change moves the safety guarantee off the network and into the node. The relay is the
thing that must have one writer, and **the node can guarantee that alone**, without agreeing with
anybody. A stale leader that still believes it is in charge is then merely noisy: its commands are
refused at the actuator.

This is why the rest of the design can be simple.

## The database is a historian, not the source of truth

The instinct is to replicate Postgres so either box can take over. Don't — that turns one hard
problem into two. Ask instead what **control** actually needs, and where it already lives:

| What                                  | Where it belongs                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| Zones, thresholds, device definitions | **replicated config** — see [Configuration](#configuration-two-tiers-split-by-who-can-know) |
| Current relay state                   | already on the bus — retained `gpio/state`                                                  |
| Latest readings                       | already on the bus                                                                          |
| Anti-short-cycle timestamps           | the only genuinely shared operational state — see below                                     |
| Reading history, stats                | per box, and needs no agreement at all                                                      |

The far-end box has **2.89 million readings going back to 2025-08-23**, a full season of the actual
greenhouse. That is not a cache to be rebuilt from a leader — it is the only copy, and it belongs to
the box that holds it. Any design that makes one database authoritative has to answer what happens
to a year of history when the authoritative box is the other one. Per-box historians make the
question disappear.

**Both boxes ingest everything, always. Only the leader commands.** A follower is fully subscribed,
persisting every reading and tracking every `gpio/state`, so it is never behind — takeover is
instant because there is nothing to catch up on. Two independent historians that happen to agree,
rather than one replicated one that has to.

The exception is the interlock. `onAt`/`offAt` drive the 300 s minimum-off, and a successor that
does not know when the burner last stopped could relight it too soon. Two options, in preference
order:

1. **Derive it from the retained `gpio/state` timestamp** — the node already publishes when the
   line changed, and that is the truth the interlock cares about.
2. Publish device state on its own retained topic, making it explicit rather than inferred.

## Configuration: two tiers, split by who can know

> [!note] This replaces an earlier answer
> This document used to say config lived **in the repo**, provisioned to both boxes. That was
> dodging the problem, not solving it: it means a deploy to two machines to change a CO2 setpoint
> from 1500 to 1450 ppm, for a value that wants tuning seasonally. The intent is a UI that creates
> zones, assigns nodes, configures devices and writes rules.

The difficulty is that config then has **two legitimate writers with different rights**, and the
split is not a preference — it follows from what each box is physically able to know.

| Tier          | Holds                                      | Written by                           | Why it must be that way                                                                  |
| ------------- | ------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------- |
| **Inventory** | What exists and how to reach it            | **Each box, for what it can reach**  | Only the box holding a Zigbee dongle can enumerate its own paired devices                |
| **Policy**    | Zones, roles, thresholds, schedules, rules | **The leader only**, fenced by epoch | Anything that can energise something needs one writer, and the epoch already provides it |

Both tiers are published as **versioned retained documents** and materialised by every box into its
own Postgres. Neither is merged: ownership partitions the keyspace, so there is no conflict to
resolve and no merge semantics to define.

### Single writer, not single holder

The point that is easy to misread. **Every box holds a complete, current copy of the policy at all
times** — the leader is merely the only one allowed to _change_ it. Promotion therefore involves no
setup and no catch-up: the successor already has the policy, in two independent places.

1. **Retained on its own broker.** Brokers are bridged, so the document sits on the local mosquitto.
2. **Materialised in its own Postgres**, applied version by version as it arrived.

A follower's UI shows policy read-only and says so — _"following elantris — promote this box to
edit"_ — rather than silently accepting edits it cannot publish.

### Publish the whole document, not per-entity topics

Config is a referential graph: a rule references a role, a device references a node and a zone.
Per-entity topics let a follower observe a rule before the device it names. One document per tier,
published atomically, carrying `{epoch, version, schemaVersion, updatedAt, updatedBy}`, removes that
failure entirely. It is kilobytes; there is nothing to optimise.

A follower applies a policy document only if `epoch >=` its highest seen **and** `version >` its
current — the same fencing rule as commands, doing a second job. It refuses a `schemaVersion` it
does not understand rather than partially applying it.

### Discovery proposes; a human adopts

Off-the-shelf devices announce themselves, and Home Assistant will find them whether or not anyone
asked (see [Off-the-shelf devices](Infrastructure/Off-the-shelf%20devices.md)). So discovery writes
**inventory** and nothing else. Turning an inventory entry into a device with a role is a policy
write, performed by a person, on the leader.

**No machine ever creates a row that can energise something.** That also makes the doc's _"one owner
per device"_ a schema constraint rather than a rule somebody has to remember.

### Policy transfers for free; reachability does not

Promoting the far end hands over every rule and threshold intact. It does **not** hand over:

- **Devices wired to the box that is gone.** The CO2 generator is on elantris's relay 6 / BCM 5.
  A successor has authority over it and no copper to it.
- **A pinned sensor source.** `"sensor": { "source": "node:elantris" }` on the burner's rule dangles.
  [Safety](Safety.md) rule 4 turns the missing reading into `+Infinity`, so the burner stays off —
  it fails safe, but it fails _silently useless_. Make that degrade loudly.
- **Radio-bound devices.** Paired to one box's dongle, gone with it.

Which is why the device row should record its **reachability class**, because it decides what
failover can even mean:

| Class                | Example                   | Commandable by                 | On failover                                                         |
| -------------------- | ------------------------- | ------------------------------ | ------------------------------------------------------------------- |
| **Pin**              | relay 6 · BCM 5           | only its own node              | Node keeps driving it; control moves, wiring does not               |
| **Broker-reachable** | Tasmota / ESPHome plug    | any box that reaches a broker  | Clean — but `issuedBy` does not exist, so the ACL is the only guard |
| **Radio-bound**      | Zigbee / BLE via a dongle | only the box holding the radio | **None.** A per-device single point of failure                      |

With that recorded, promotion can state plainly which devices the operator is _not_ getting.

### Foundations to lay before there are rows

Cheap now, expensive later, and all of them matter even with a single box:

1. **Split config from runtime state on `devices`.** `onAt`/`offAt` change every cycle and sit on the
   same row as `gpio`, `onLevel` and `role`. Config cannot be replicated until they are separated.
2. **Make the address re-bindable.** Identity is the uuid; `(nodeId, gpio)` is a mutable attribute.
   A plug that is factory reset or replaced then keeps its role binding and its history instead of
   being deleted and recreated.
3. **Record reachability class and owner** per device, per the table above.
4. **Treat a device's own safe-state timer as _verified_ config.** Tasmota's `PulseTime` is the only
   layer that survives a partition, and a factory reset clears it silently. Config must be reconciled
   against the device, not merely replicated between boxes.
5. **Inventory is not devices.** A discovered thing is a proposal until adopted.
6. **Verify `onLevel` by driving it, not by typing it.** It is the field that lights the MH lamp if
   wrong. A device with `supportsReadback` can confirm itself, so the config discovery wrote is also
   the config that can be auto-verified.

### Persist the epoch high-water mark on the node

The fencing token is only as good as the node's memory of it. A node that forgets its highest-seen
epoch across a restart will accept a rebuilt controller starting fresh at a low epoch — and then two
controllers are both being obeyed, which is the failure this entire document exists to prevent.
**Write it to disk, read it at startup.**

## Leadership is deliberate, not automatic

Given fencing, a wrong answer is safe, so the election can be as simple as a human deciding.

- **Promote** bumps the epoch and starts heartbeating. Nodes adopt the higher epoch.
- **Demote** stops heartbeating. The old leader's commands would be refused anyway.
- A promotion **refuses** if it can see a higher epoch already in flight.

That is enough for "take over if wanted", it cannot split-brain, and it needs no consensus library.
Automatic failover can come later, and when it does the honest way to get it is a **third witness**
— a Mac, or a cheap third box — not two machines trying to agree.

## The broker is the real single point of failure

Mosquitto runs only on elantris. If elantris is the thing that dies, there is no bus at all, and the
far-end box cannot command anything no matter which of them thinks it is leader. Controller failover
over a single broker is theatre.

So: **a broker on each box**, bridged for `tempestas/v1/#`, with each agent connecting to its
**local** broker. A partition then degrades into two halves that each still control their own
hardware, which is the behaviour worth having. Bridging needs care over retained messages and loop
prevention, and that is the main new operational risk this design introduces.

## Locality: the reframe worth considering

A zone is an airspace, and the two ends of this greenhouse are not measuring the same thing. The
entrance sensor sits by the door, in the first air disturbed whenever anyone opens it. The far-end
sensor sits **directly under the plant canopy**, which is the environment the entire system exists
to control.

So the best instrument is on the box that is not the leader, and **the leader is partly controlling
on a proxy**. A paired sample taken two seconds apart put the entrance ~143 ppm richer in CO2 than
the canopy (1181 vs 1038) while their water vapour pressure agreed to within 2.5 % — see
[Hardware](Hardware.md#the-far-end-sensor-is-the-one-over-the-plants). Read carefully, that pair
says the air is fairly well mixed for moisture but **enrichment injected at the entrance arrives
thinner where the plants are**. It also says the raw 4 °C temperature gap between the two is mostly
an uncalibrated offset, not a gradient — the canopy sensor has never had one set.

Two consequences:

- **Calibrate the canopy sensor before any rule is allowed to depend on it.** It is in the state
  elantris was in when it read ~3 °C warm, and a CO2 or temperature threshold read off it today
  would be enforcing the wrong number.
- **The unit of leadership may not be the greenhouse at all.** Each box owns its own zone and its
  own relays by default, and can **assume the other's zone** when asked. The normal case then
  involves no election whatsoever, the failure case is a deliberate widening of scope, and it
  matches both the physical layout and the wiring — which, given that nothing is cross-wired
  between the two boxes, is the only kind of takeover the hardware actually permits.

## What this does not replace

> [!warning] Failover is control quality, not life safety
> Stage A of the [Roadmap](Roadmap.md) — an off-system bimetal thermostat and a small heater at
> ~2 °C — is the real answer to "the controller died on a January night". It is cheap, depends on
> no software, and survives a failure that takes out both boxes, the broker and
> the network together. Build it first. Every decision here gets less fraught once "don't freeze" is
> decoupled from "the software is healthy".

## Order of work

1. **Epoch fencing in the agent** — monotonic, refuse lower, alarm on an attempted takeover. Small,
   testable with no hardware, and it unblocks everything else.
2. **Calibrate the canopy SCD41**, a prerequisite for trusting anything the far end reports — it
   has never had an offset set. No software needed.
3. **Schema foundations** — split config from runtime state, make the address re-bindable, record
   reachability and owner. Single box, no distribution, but everything below depends on it.
4. **Policy as a versioned document** with an append-only change log, written through the UI. Still
   one box; this is where the repo-config answer is actually replaced.
5. **Explicit "sync config from leader"** with a visible diff — the manual form of replication, worth
   shipping before the automatic one because it is a few hours' work and the same mental model.
6. **Follower ingest** — a non-leader still persists readings and tracks pin state.
7. **Promote / demote**, with the epoch bumped on promotion and a refusal if a higher one is seen.
8. **Replicate both config tiers as retained documents**; follower UI goes read-only for policy.
9. **Broker bridging**, once there is a second box to bridge to.
10. Automatic failover with a witness — only if still wanted by then.

## When to update this file

- Fencing, promotion or the epoch rule changes
- The broker topology changes
- The unit of leadership changes (greenhouse-wide vs per-zone)
- The config tiers, their ownership, or the reachability classes change
- Any of this stops being a plan and becomes something that runs
