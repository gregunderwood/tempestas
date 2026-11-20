# Home Assistant

## What it is

How an existing Home Assistant install observes tempestas — device and sensor state, and an alarm
path that survives the server dying — plus the decision **not** to move the control law into HA's
automation engine, and the decision not to build an email or SMS notifier instead.

The shape in one line: **Home Assistant observes over MQTT. It never publishes to
`tempestas/v1/node/…`.**

> [!note] Status
> Nothing here is built. Stage 1 depends on `MqttHardwareService` (**phase 7**); until then
> `HARDWARE_DRIVER=fake` means there is no broker traffic to observe. The engine HA defers to is
> built and evaluating on a 10 s tick as of phase 5, so the question this document settles — where
> the control law lives — is already answered in code.

> [!warning] Home Assistant would be the third controller
> [Safety](../Safety.md) permits exactly one: _"only one controller may hold the heartbeat."_
> During the transition the legacy Flask app and tempestas already act on one airspace. Stage 1
> below keeps HA out of that set entirely, and Stage 2 only ever lets it _ask_.

## Key files

- [../../libs/domain/src/lib/hardware/mqtt-contract.ts](../../libs/domain/src/lib/hardware/mqtt-contract.ts) — the topics HA subscribes to, and the ones it must never publish on
- [../../apps/server/src/app/rules/rules.service.ts](../../apps/server/src/app/rules/rules.service.ts) — computes `staleRoles` every tick; the source of the health topic
- [../../apps/server/src/app/devices/devices.service.ts](../../apps/server/src/app/devices/devices.service.ts) — `drive()`, the single choke point every command funnels through
- [../../libs/domain/src/lib/zones/zone.model.ts](../../libs/domain/src/lib/zones/zone.model.ts) — the rule setpoints, the only thing HA may ever write

## Two stages, and only the first is worth doing soon

**Stage 1 — observe and alert.** HA gets a read-only broker credential and every useful signal the
system already produces. No control, no write path, nothing that can energise a relay. This is where
effectively all of the value is.

**Stage 2 — control, later and optional.** A separate `tempestas/v1/ha/#` inbound namespace that the
server treats as requests through `DevicesService`. Deliberately deferred: nothing about seeing state
or being warned requires it.

## Why not a built-in email or SMS notifier

The convenience arguments are real — HA already has delivery, retries, escalation, quiet hours,
acknowledgement and a mobile app, none of which is interesting to write twice. But the argument that
actually decides it is structural:

**A notifier inside the NestJS process cannot report that the NestJS process died.** Nor can it
report elantris losing power, the SD card going read-only, or the OOM killer taking the server —
which [Safety](../Safety.md) already names as a hazard on this box. Those are precisely the failures
worth waking up for, and every one of them kills the notifier first.

The contract already anticipates this: `tempestas/v1/server/status` is a **retained LWT**, published
by the broker on the server's behalf when it disconnects. The mechanism exists. What it needs is
**an observer outside the failing process** — which is the entire job HA is being hired for.

Two supporting points, neither decisive alone:

- **No delivery secrets in this repo.** An SMTP password or a Twilio key in `/etc/tempestas/` is a
  credential to rotate and leak; HA already holds those and they stay there.
- **Mobile push beats SMS** for this: it can be made to bypass a silenced phone at 2 a.m., which is
  the case that matters, and it costs nothing per message.

> [!warning] Alerting is an operations layer, not a safety layer
> If HA is down, nobody is warned — see the gap in the table below. That is acceptable **only**
> because it is not what stands between a cold night and a dead crop. Stage A in
> [Roadmap](../Roadmap.md) — an independent bimetal thermostat and a small electric heater — is the
> thing that makes a total software failure survivable. Notifications are how you find out in the
> morning, not how the greenhouse stays warm.

## What can go down, and what notices

| Failure                                 | What detects it            | What HA sees                                       |
| --------------------------------------- | -------------------------- | -------------------------------------------------- |
| A node loses power or Wi-Fi             | broker, via the node's LWT | `node/{id}/status` → `offline`, retained           |
| **The brain dies** — process, box, OOM  | broker, via the server LWT | `server/status` → `offline`, retained              |
| Mosquitto dies                          | HA's own MQTT client       | every tempestas entity goes unavailable            |
| A sensor goes quiet, node still online  | the server, Layer 1        | `server/health` → `sensorStale`, with `staleRoles` |
| A node-side fault                       | the node                   | `node/{id}/alarm` — `AlarmCode` and severity       |
| Burner running with no temperature rise | the node                   | `NO_PROGRESS` alarm                                |
| **Home Assistant dies**                 | nothing                    | — nothing. The honest gap; see the warning above.  |

The second row is the one that justifies the whole integration. It is also the only row tempestas
can never cover for itself.

## What the server must publish

Three additions, all **server→observer**. Nodes neither subscribe to nor are affected by any of
them, so none of the `mqttQos` guarantees for nodes change. They belong in `mqtt-contract.ts` and
[MQTT Contract](MQTT%20Contract.md) alongside the rest, rather than living only in HA's config.

```
tempestas/v1/server/health             server→obs  QoS1  retain=true   sensorStale, staleRoles, degraded
tempestas/v1/device/{deviceId}/state   server→obs  QoS1  retain=true   on | off | unknown
homeassistant/{component}/{id}/config  server→HA   QoS1  retain=true   discovery
```

**Why a device state topic rather than reusing `gpio/state`.** `gpio/state` is per pin, carries an
electrical **level**, and reports `known: false` when stale. Turning that into "the burner is on"
needs `onLevel` and the `onAt`/`offAt` derivation, both of which are server-side by rule 4 of the
contract — the server owns polarity precisely so no consumer has to. An HA switch reading raw levels
would render **four of the five relays backwards**. HA must never see a level.

**Discovery is retained and derived from `NodeCapabilities.sensors`**, so a newly admitted node
appears in HA with no HA-side edit, and an HA restart repopulates itself from the broker. That keeps
faith with the invariant in [Architecture](../Architecture.md): adding a node is data, not code.

Publish points: discovery on node admission and on capability change; `server/health` on the rules
tick, where `staleRoles` is already computed; `device/{id}/state` from `DevicesService.drive()`,
after the write succeeds — the same "publish first, persist only on success" ordering, so a state
topic can never claim a transition that the hardware refused.

## The entity map

| HA entity                              | Source topic                  | Notes                                                  |
| -------------------------------------- | ----------------------------- | ------------------------------------------------------ |
| `sensor.{node}_temperature`            | `node/{id}/sensor/{s}/sample` | `device_class: temperature`, °C                        |
| `sensor.{node}_humidity`               | same                          | `device_class: humidity`                               |
| `sensor.{node}_co2`                    | same                          | `device_class: carbon_dioxide`, ppm                    |
| `binary_sensor.{node}_online`          | `node/{id}/status`            | `device_class: connectivity`, from the LWT             |
| `binary_sensor.tempestas_server`       | `server/status`               | `device_class: connectivity` — **the important one**   |
| `binary_sensor.tempestas_sensor_stale` | `server/health`               | `device_class: problem`; attributes carry `staleRoles` |
| `binary_sensor.{device}_relay`         | `device/{id}/state`           | Polarity already applied; never derived from a level   |
| `sensor.{role}_reason`                 | `server/health`               | The `RuleReason` — answers "why is the burner off?"    |

Every sensor takes `availability_topic: tempestas/v1/node/{id}/status`, so a dropped node greys its
entities out instead of freezing them on a last-known value. **Stale must not read as fresh** in HA
any more than it does in the Angular app.

A measurement with `valid: false` templates to `none`, which HA renders as `unknown`. That is the
correct rendering and it preserves rule 4 of [Safety](../Safety.md) — a null CO2 is unknown, never
zero — across the boundary into a system that knows nothing about burners.

`sensor.{role}_reason` is worth more than it looks. It is the HA-side answer to the defect
`GET /api/rules/last-evaluation` exists to fix: a burner that is off because of `dead-band` and one
that is off because of `no-sensor` are indistinguishable from the relay alone.

## The automations worth having

Sketches, not copy-paste — the value here is which conditions deserve a notification, not HA syntax.

```yaml
# The one tempestas structurally cannot do for itself.
- alias: Greenhouse brain offline
  trigger:
    - platform: state
      entity_id: binary_sensor.tempestas_server
      to: 'off'
      for: '00:01:00'
  action:
    - service: notify.mobile_app_phone
      data:
        title: Greenhouse brain offline
        message: No server heartbeat for a minute. Relays are on their node dead-man.

# Layer 1 depends on someone noticing. This is that someone.
- alias: Greenhouse sensor stale
  trigger:
    - platform: state
      entity_id: binary_sensor.tempestas_sensor_stale
      to: 'on'
      for: '00:05:00'
  action:
    - service: notify.mobile_app_phone
      data:
        message: >-
          Readings stopped for {{ state_attr('binary_sensor.tempestas_sensor_stale',
          'staleRoles') | join(', ') }}. Holding last state.

# Node-side faults, straight off the alarm topic.
- alias: Greenhouse node alarm
  trigger:
    - platform: mqtt
      topic: tempestas/v1/node/+/alarm
  condition: "{{ trigger.payload_json.severity in ['warning', 'critical'] }}"
  action:
    - service: notify.mobile_app_phone
      data:
        title: '{{ trigger.payload_json.code }}'
        message: '{{ trigger.payload_json.node }}: {{ trigger.payload_json.message }}'
```

Escalate only the first and the `critical` branch of the third. A node offline for two minutes is
worth a notification; it is not worth an alarm that repeats until acknowledged.

`DEADMAN_TRIPPED` and `NO_PROGRESS` deserve special handling — the first means a node stopped
trusting the brain, the second means the burner is running and the greenhouse is not warming.
Neither is self-correcting.

## Per-device: what HA sees and what it may drive

Ownership is `enabledRoles`, never inferred from which device rows exist, so this table moves as
roles transfer. It mirrors the ownership table in [AGENTS.md](../../AGENTS.md) and the device table
in [Hardware](../Hardware.md).

| Device            | BCM | Polarity        | Owner today   | HA may observe                        | HA may drive (Stage 2)                 |
| ----------------- | --- | --------------- | ------------- | ------------------------------------- | -------------------------------------- |
| **CO2 Generator** | 16  | active-LOW      | **tempestas** | State, availability, reason, cooldown | Yes — `rulesEnabled` and manual on/off |
| **Exhaust Fan**   | 20  | active-LOW      | legacy Flask  | Only via the `greenhouse-legacy` node | **No** — not tempestas' relay to drive |
| **Lights**        | 21  | active-LOW      | legacy Flask  | Same                                  | **No**                                 |
| **Single Light**  | 26  | active-**HIGH** | legacy Flask  | Same                                  | **No**                                 |
| **Extra Relay**   | 12  | active-LOW      | nobody        | No device row                         | **No** — unidentified; open question 1 |

Bind HA entities to `role`, never to `name`. Resolving devices by display name is what let a rename
silently disable a rule in the old system.

No role is safe to delegate wholesale, even after cutover. The exhaust fan interacts with the burner
— an open vent while it runs is the waste-and-control problem in [Safety](../Safety.md) — and the
dead-man table treats lights as heat-contributing. There is no consequence-free role here.

## Stage 2: if control is ever wanted

The engine is level-triggered and re-asserts full desired state on every 10 s tick, so an HA switch
that turns a rules-owned device on is reverted within seconds. It is not a control; it is a race.
Each tempestas-owned device is therefore **two** entities:

| Entity                 | Request                   | Meaning                                             |
| ---------------------- | ------------------------- | --------------------------------------------------- |
| `switch.{device}_auto` | `rulesEnabled` true/false | Hand the device to the engine, or take it back      |
| `switch.{device}`      | `on` / `off`              | Manual state — authoritative only while auto is off |

Requests arrive on `tempestas/v1/ha/device/{deviceId}/set`, **never retained**, and are handled by
calling `DevicesService` — the same path as the REST verbs, so every interlock, the cooldown and the
admission gate all still apply. State still comes back on `device/{id}/state`, never optimistically:
a refused request must leave the entity showing what the hardware is actually doing.

> [!danger] `force-on` is not a switch
> It bypasses the anti-short-cycle interlock on a propane burner. An HA automation with a retry loop
> becomes repeated ignition attempts — the failure that got the boot-time relay click test deleted.
> Expose it as a script with a confirmation, or not at all.

## Where HA's scheduler does earn its place

The engine stays; its _inputs_ are a different question. HA is better than anything this repo would
build at three things, all outside the safety envelope:

- **Setpoints on a schedule** — seasonal photoperiod, a warmer night while seedlings are out.
- **Outdoor context.** tempestas has no outdoor data source at all. "Hard freeze forecast tonight,
  raise `nightOnBelowC`" is unreachable without one.
- **Alarm routing**, above.

So the seam is **HA proposes, tempestas disposes**: HA may write rule setpoints, never device
state. The rule _kinds_ stay out of its reach.

> [!danger] Clamp every setpoint the API accepts
> A setpoint write is a burner command through a side door: `nightOnBelowC: 40` runs the burner
> continuously and breaks no rule in `drive()`. The DTO must enforce per-field ranges server-side.
> Without the clamps this seam is more dangerous than the device verbs it was meant to avoid.

## Why not simply let Home Assistant run the rules

HA has a mature scheduler, a template engine and a trace UI. Using it instead of
[Rules and Climate](../Rules%20and%20Climate.md) is a fair question, and the answer is no — for
reasons specific to this system rather than a preference for owning code.

**The failure direction has to be decided, not emergent.** A null CO2 coerces to `+Infinity` so the
enrichment branch stays off; a stale sensor holds last state and alarms. In HA, an `unknown` entity
in a `numeric_state` trigger simply does not fire, and in a template renders whichever way the
expression happens to collapse. Both are _silent_. The distinction `RulesInput` draws between a role
with no sensor and a role whose sensor went quiet — a configuration gap versus an incident worth
waking somebody for — has no natural expression in an automation.

**The engine has to be testable against time it is not currently experiencing.** `evaluateRules` is
pure and takes `minutesSinceMidnightLocal` as a number, which is what makes the DST tests possible.
There is no way to unit-test an HA automation against a synthetic cold night in March.

**Shadow mode has no HA equivalent.** Stage D diffs two decision streams for 3–7 days with the
relays connected to nothing, and every divergence is a rules-porting bug caught before it can hurt
anything. It relies on `dryRun` in `GpioSyncPayload` — compute the decision, publish the intent,
actuate nothing. HA automations either run or do not run. Moving the rules there means flying the
cutover blind.

**"Why did nothing happen" must be answerable.** `GET /api/rules/last-evaluation` exists because the
Python system logged what it did but never what it saw. HA's traces explain automations that
_fired_; they structurally cannot explain one that did not.

**It would make combustion heating depend on HA's uptime.** The deployment split in
[Roadmap](../Roadmap.md) keeps the safety path native and Docker-free, on the reasoning that a
container runtime must never sit in front of the safety-critical process. Note the asymmetry with
alerting: HA observing is free to fail, because failing means only that a notification is missed.

**And it inverts the architecture.** Whoever runs the rules holds the heartbeat and the `epoch`.

## Enforcement

The rules above hold structurally, not by convention. An MQTT write goes straight to a GPIO pin,
which is why [Safety](../Safety.md) ranks securing Mosquitto above every other auth concern.

Stage 1 — a dedicated `homeassistant` broker user:

```
user homeassistant
topic read tempestas/v1/#
topic readwrite homeassistant/#
```

Stage 2 adds exactly one line, and no other:

```
topic write tempestas/v1/ha/#
```

**No write to `tempestas/v1/node/#` at any stage.** A hand-written HA MQTT switch aimed at
`gpio/set` would also fail `expiresAt` and trip `CONTROLLER_CONFLICT` — but the ACL is what makes it
impossible rather than merely wrong.

## Where it fits

Stage 1 lands after **phase 7**, as an addition to phase 12 rather than a phase of its own. The
server-side work is one publisher: discovery configs on admission, a health topic on the rules tick,
a device state topic in `drive()`.

It also answers open question 6 ("one dashboard, not one per node"): HA is not a second dashboard in
the sense that question rules out. It observes, it routes alarms, and it owns no node.

## Pitfalls

- **HA must never see an electrical level.** Four of five relays are active-LOW; polarity is
  server-side by contract. Publish translated device state, not `gpio/state`.
- **Alerting must not share a failure domain with the thing it reports on.** That is the whole
  reason HA is worth wiring up, and the reason a built-in notifier is not.
- **Alarms routed to HA do not retire the Angular banner.** Layer 1 depends on visibility, and a
  path that can be down when the incident happens is not visibility on its own.
- **A setpoint is a burner command.** The clamps are the entire safety of the Stage 2 setpoint seam.
- **`POST /api/rules/evaluate` is not a refresh button.** It runs the real dispatch path and drives
  real relays. The scheduled tick is already 10 s; an automation that polls it actuates a burner on
  a timer nobody reviewed.
- **HA entity state must never lead the server's.** Treat every Stage 2 request as one that may be
  refused.

## When to update this file

- A role moves into `enabledRoles` — the per-device table changes with it
- The `server/health` or `device/{id}/state` topics are added to the contract
- Stage 2 is built, or the setpoint endpoint and its clamps are
- The Mosquitto ACLs land
- Home Assistant is given any capability beyond observing
