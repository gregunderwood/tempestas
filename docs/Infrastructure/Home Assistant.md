# Home Assistant

## What it is

How an existing Home Assistant install can observe tempestas and drive the parts of it that are safe
to drive — and, just as importantly, the decision **not** to move the control law into HA's
automation engine.

The shape of the integration in one line: **Home Assistant observes over MQTT and requests over the
REST API. It never publishes to `tempestas/v1/node/…`.**

> [!note] Status
> Nothing here is built. It depends on `MqttHardwareService` (**phase 7**) for anything to observe
> and on the token guard (**phase 12**) for anything to authenticate. The engine it defers to is
> built and evaluating on a 10 s tick as of phase 5, so the question this document settles — where
> the control law lives — is already answered in code.

> [!warning] Home Assistant would be the third controller
> [Safety](../Safety.md) permits exactly one: _"only one controller may hold the heartbeat."_
> During the transition the legacy Flask app and tempestas already act on one airspace. Every rule
> below exists to keep HA out of that set.

## Key files

- [../../libs/domain/src/lib/hardware/mqtt-contract.ts](../../libs/domain/src/lib/hardware/mqtt-contract.ts) — the topics HA subscribes to, and the ones it must never publish on
- [../../apps/server/src/app/devices/devices.controller.ts](../../apps/server/src/app/devices/devices.controller.ts) — the verbs HA calls
- [../../apps/server/src/app/devices/devices.service.ts](../../apps/server/src/app/devices/devices.service.ts) — `drive()`, the single choke point every request funnels through
- [../../libs/domain/src/lib/zones/zone.model.ts](../../libs/domain/src/lib/zones/zone.model.ts) — `RulesThresholds`, the setpoints HA is allowed to move

## Why not simply let Home Assistant run the rules

HA has a mature scheduler, a template engine, a trace UI and a mobile app. The question of whether
to use it instead of [Rules and Climate](../Rules%20and%20Climate.md) is a fair one, and the answer
is no — for reasons specific to this system rather than a preference for owning code.

**The failure direction has to be decided, not emergent.** A null CO2 coerces to `+Infinity` so the
enrichment branch stays off; a stale sensor holds last state and alarms rather than failing off or
on. In HA, an `unknown` entity inside a `numeric_state` trigger simply does not fire, and inside a
template renders whichever way the expression happens to collapse. Both are _silent_. The
distinction `RulesInput` draws between a role with no sensor and a role whose sensor went quiet —
a configuration gap versus an incident worth waking somebody for — has no natural expression in an
automation and would survive only as folklore spread across several of them.

**The engine has to be testable against time it is not currently experiencing.** `evaluateRules` is
pure and takes `minutesSinceMidnightLocal` as a number, which is what makes the DST tests possible.
There is no way to unit-test an HA automation against a synthetic cold night in March.

**Shadow mode has no HA equivalent.** Stage D diffs two decision streams for 3–7 days with the
relays connected to nothing, and every divergence is a rules-porting bug caught before it can hurt
anything. It relies on `dryRun` in `GpioSyncPayload` — compute the decision, publish the intent,
actuate nothing. HA automations either run or do not run; there is no mode in which one produces a
decision for inspection without acting on it. Moving the rules to HA means flying the cutover blind.

**"Why did nothing happen" must be answerable.** `GET /api/rules/last-evaluation` exists because the
Python system logged what it did but never what it saw, so a burner that stayed off was
indistinguishable from a rule that never ran. HA's traces explain automations that _fired_; they
structurally cannot explain one that did not. Adopting HA's engine reintroduces precisely the defect
the endpoint was built to remove.

**It would make combustion heating depend on HA's uptime.** The deployment split in
[Roadmap](../Roadmap.md) keeps the whole safety path native and Docker-free, on the reasoning that a
container runtime must never sit in front of the safety-critical process. HA is a container or an
appliance OS, usually on another box, upgraded often and occasionally with breaking automation
changes. On a 3.7 GiB Pi where the OOM killer is already named a safety hazard, it is also the
largest process anyone could add.

**And it inverts the architecture.** Whoever runs the rules holds the heartbeat and the `epoch`.
Making that HA turns the API, the interlocks in `device-state.ts` and the Angular app into clients
of an automation engine, rather than removing anything.

## Where HA's scheduler does earn its place

The engine stays; the _inputs_ to it are a different question. HA is genuinely better than anything
this repo would build at three things, and all three sit outside the safety envelope:

- **Setpoints on a schedule** — seasonal photoperiod, a warmer night while seedlings are out —
  edited in a UI instead of a deploy.
- **Outdoor context.** tempestas has no outdoor data source at all. "Hard freeze forecast tonight,
  raise `co2NightOnTemp`" is a capability it cannot reach on its own.
- **Alarm routing.** See below; this is the strongest single reason to integrate.

So the seam is **HA proposes, tempestas disposes**: HA may write `RulesThresholds`, never device
state. The engine still decides, still holds last state on a stale sensor, still runs every
interlock.

> [!danger] Clamp every setpoint the API accepts
> A setpoint write is a burner command through a side door: `co2NightOnTemp: 40` runs the burner
> continuously and breaks no rule in `drive()`. The DTO must enforce per-field ranges server-side,
> and `role-not-owned` still applies. Without the clamps this seam is more dangerous than the
> device verbs it was meant to avoid.

## Why to integrate at all: the alarm path

Layer 1 in [Safety](../Safety.md) holds last state when readings stop and depends on a human
noticing — _"this is only sound if the alarm is actually visible."_ Today "visible" means a banner
in an Angular tab that may not be open.

HA turns that into a phone notification with escalation: `sensorStale`, and once phase 7 lands the
`AlarmCode` stream — `DEADMAN_TRIPPED`, `NO_PROGRESS`, `READBACK_MISMATCH`, `SAFE_STATE_ENTERED`.
Those are the events worth waking somebody for, and routing them well is exactly what HA is for.

This is **additive**. The banner remains a required part of the feature; the alarm path must not
come to depend on a second system that can itself be down.

## Per-device: what HA sees and what it may drive

Ownership is `enabledRoles`, never inferred from which device rows exist, so this table moves as
roles transfer. It mirrors the ownership table in [AGENTS.md](../../AGENTS.md) and the device table
in [Hardware](../Hardware.md).

| Device            | BCM | Polarity        | Owner today   | HA may observe                                            | HA may drive                                              |
| ----------------- | --- | --------------- | ------------- | --------------------------------------------------------- | --------------------------------------------------------- |
| **CO2 Generator** | 16  | active-LOW      | **tempestas** | `isOn`, `canTurnOn`, `canTurnOnAt`, retained `gpio/state` | Yes — via `rulesEnabled` and manual on/off                |
| **Exhaust Fan**   | 20  | active-LOW      | legacy Flask  | Only through the `greenhouse-legacy` virtual node         | **No** — not tempestas' relay to drive                    |
| **Lights**        | 21  | active-LOW      | legacy Flask  | Same                                                      | **No**                                                    |
| **Single Light**  | 26  | active-**HIGH** | legacy Flask  | Same                                                      | **No**                                                    |
| **Extra Relay**   | 12  | active-LOW      | nobody        | No device row                                             | **No** — unidentified and active-low; see open question 1 |

Bind HA entities to `role`, never to `name`. Resolving devices by display name is what let a rename
silently disable a rule in the old system.

No role is safe to delegate wholesale, including after cutover. The exhaust fan interacts with the
burner — an open vent while the burner runs is the waste-and-control problem in
[Safety](../Safety.md) — and the dead-man table treats lights as heat-contributing. There is no
consequence-free role here.

## Modelling a device: two entities, not one

The engine is level-triggered and re-asserts full desired state on every 10 s tick, so an HA switch
that calls `POST /on` against a rules-owned device is reverted within seconds. It is not a
control; it is a race. Each tempestas-owned device is therefore **two** entities:

| Entity                 | Call                                      | Meaning                                                         |
| ---------------------- | ----------------------------------------- | --------------------------------------------------------------- |
| `switch.<device>_auto` | `PATCH /api/devices/:id` `{rulesEnabled}` | Hand the device to the engine, or take it back                  |
| `switch.<device>`      | `POST /api/devices/:id/on` \| `/off`      | Manual state — authoritative only while `rulesEnabled` is false |

State comes from `GET /api/devices`, where `isOn` is server-authoritative and derived from
`onAt`/`offAt`. **Never optimistic**: a `409 DeviceCooldown` surfaces in HA as an unspecific
failure, so an optimistic switch would show the burner running while it sat out its 300 s lockout.

> [!danger] `force-on` is not a switch
> It bypasses the anti-short-cycle interlock on a propane burner. An HA automation with a retry loop
> then becomes repeated ignition attempts — the failure that got the boot-time relay click test
> deleted. Expose it as a script with a confirmation, or not at all.

## Enforcement

Two mechanisms, both cheap, both chosen so the rules above hold structurally rather than by
convention:

1. **A read-only broker ACL for HA** — `topic read tempestas/v1/#`, no write. "HA never publishes to
   node topics" then stops being a convention. An MQTT write goes straight to a GPIO pin, which is
   why [Safety](../Safety.md) ranks securing Mosquitto above every other auth concern.
2. **`X-Tempestas-Token` on mutating verbs** (phase 12). GETs stay open, so every sensor and every
   state poll needs no credential; only the switches do.

## Where it fits

After **phase 7** — before that `HARDWARE_DRIVER=fake` means there is no broker traffic to observe.
Sensor entities want the phase 6 readings surface, and the switches want phase 12's token. It is an
addition to phase 12 rather than a phase of its own.

It also answers open question 6 ("one dashboard, not one per node"): HA is not a second dashboard in
the sense that question rules out. It is an observer and an alarm router, and it owns no node.

## Pitfalls

- **A setpoint is a burner command.** The clamps are the whole safety of the setpoint seam.
- **`gpio/set` looks trivially publishable from HA** and is the single thing that must never happen.
  A hand-written MQTT switch would also fail `expiresAt` and trip `CONTROLLER_CONFLICT` — but the
  ACL is what makes it impossible rather than merely wrong.
- **HA entity state must never lead the server's.** Poll `GET /api/devices`; treat every mutating
  call as a request that may be refused with a 409.
- **`POST /api/rules/evaluate` is not a refresh button.** It runs the real dispatch path and drives
  real relays. HA has nothing to gain by calling it — the scheduled tick is already 10 s — and an
  automation that polls it is an automation that actuates a burner on a timer nobody reviewed.
- **Alarms routed to HA do not retire the Angular banner.** Layer 1 depends on visibility, and a
  notification path that shares a failure mode with the thing it reports on is not visibility.

## When to update this file

- A role moves into `enabledRoles` — the per-device table changes with it
- The setpoint endpoint is built, or its clamps change
- The token guard or the Mosquitto ACLs land
- Home Assistant is given any capability beyond observing and requesting
