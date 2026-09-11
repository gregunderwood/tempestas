# Multi-Controller

## What it is

The plan for running tempestas on **both** greenhouse boxes — elantris at the entrance and the Pi 5
at the far end, currently running the legacy Flask app — so each owns its own hardware, keeps its
own history, serves its own UI, and can take over the other's job.

> [!note] Status
> Designed, not built. The one prerequisite — epoch fencing — is a gap in the agent today.

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

| What                                  | Where it belongs                                                       |
| ------------------------------------- | ---------------------------------------------------------------------- |
| Zones, thresholds, device definitions | **config in the repo**, provisioned to both boxes. Reviewed, versioned |
| Current relay state                   | already on the bus — retained `gpio/state`                             |
| Latest readings                       | already on the bus                                                     |
| Anti-short-cycle timestamps           | the only genuinely shared operational state — see below                |
| Reading history, stats                | per box, and needs no agreement at all                                 |

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

A zone is an airspace, and we measured that the two ends of this greenhouse are **not the same air**
— corrected sensors still differ, and the entrance end is ventilated while the far end sits under
canopy (see [Roadmap](Roadmap.md#the-two-boards-are-not-in-the-same-air)).

So the unit of leadership may not be the greenhouse at all. Each box owns its own zone and its own
relays by default, and can **assume the other's zone** when asked. The normal case then involves no
election whatsoever, the failure case is a deliberate widening of scope, and it matches both the
physical layout and the wiring.

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
2. **Config as code** for zones and devices, so a second box is _provisioned_ rather than replicated.
3. **Follower ingest** — a non-leader still persists readings and tracks pin state.
4. **Promote / demote**, with the epoch bumped on promotion and a refusal if a higher one is seen.
5. **Broker bridging**, once there is a second box to bridge to.
6. Automatic failover with a witness — only if still wanted by then.

## When to update this file

- Fencing, promotion or the epoch rule changes
- The broker topology changes
- The unit of leadership changes (greenhouse-wide vs per-zone)
- Any of this stops being a plan and becomes something that runs
