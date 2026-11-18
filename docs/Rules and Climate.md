# Rules and Climate

## What it is

The control law: what each zone actually does, at which setpoints, and why. The greenhouse rules
were ported faithfully from the Python system, with three deliberate behaviour changes and one
landmine. Since 2026-11 a zone picks its rules from a fixed menu of **rule kinds**, which is how the
pumphouse runs on the same engine with none of the greenhouse's numbers.

**Source of truth for the port is the _uncommitted_ `set_device_states.py` running on the greenhouse
Pi right now** — not any doc, and not any committed version. The committed versions and the old
`CLAUDE.md` both carry stale thresholds.

> [!note] Status
> Built, phase 5; rule kinds per role added 2026-11 for the [pumphouse](Pumphouse.md). The engine
> is [../apps/server/src/app/rules/rules.engine.ts](../apps/server/src/app/rules/rules.engine.ts),
> evaluated every 10 s by `RulesService`, and `GET /api/rules/last-evaluation` shows what it saw.

## Key files

- [../libs/domain/src/lib/zones/zone.model.ts](../libs/domain/src/lib/zones/zone.model.ts) — `ZoneRulesConfig`, the `RoleRule` kinds, `StalePolicy`, `SensorPolicy`
- [../libs/domain/src/lib/rules/rules.model.ts](../libs/domain/src/lib/rules/rules.model.ts) — `RulesInput`, `RuleDecision`, `RuleReason`
- [../libs/domain/src/lib/devices/device.model.ts](../libs/domain/src/lib/devices/device.model.ts) — `DeviceRole`, which automation binds to
- [../apps/server/src/app/rules/rules.engine.ts](../apps/server/src/app/rules/rules.engine.ts) — the control law, pure
- [../apps/server/src/app/rules/rules-config.ts](../apps/server/src/app/rules/rules-config.ts) — `parseZoneRulesConfig`, the gate between the jsonb and the engine
- [../apps/server/src/app/rules/climate-resolver.ts](../apps/server/src/app/rules/climate-resolver.ts) — sensor policy, pure
- [../apps/server/src/app/rules/local-time.ts](../apps/server/src/app/rules/local-time.ts) — the only place an instant becomes a wall clock
- [../apps/server/src/app/rules/rules.service.ts](../apps/server/src/app/rules/rules.service.ts) — the impure shell: load, resolve, evaluate, dispatch
- [../apps/server/src/app/devices/device-state.ts](../apps/server/src/app/devices/device-state.ts) — the interlocks the decisions run into

## A zone's rules

A zone's `rules_config` jsonb names, per role, one **kind** from a fixed menu and that kind's
numbers. It cannot invent logic: a new kind is a code change with tests, never a config change.
There is still no DSL, and that reasoning stands — a predicate language with one user is a liability
when a mis-click controls a propane burner.

| Kind                  | Does                                                                        | Used by                   |
| --------------------- | --------------------------------------------------------------------------- | ------------------------- |
| `thermostat`          | `heat`: on below `onAtC`, off above `offAtC`. `cool`: the mirror            | exhaust fan, heater, tape |
| `daylight-thermostat` | A thermostat inside the zone's daylight window, unconditionally off outside | greenhouse lights         |
| `co2-burner`          | Day enrichment with a CO2 dead band, night frost protection ignoring CO2    | greenhouse CO2 generator  |

Every thermostat comparison is **strict**, so the setpoints themselves sit inside the dead band.

```jsonc
// greenhouse, as running (enabledRoles: ["co2_generator"])
"daylight": { "start": "06:30", "end": "18:30" },
"rules": {
  "lights":        { "kind": "daylight-thermostat", "mode": "heat", "onAtC": 26, "offAtC": 27, "onStale": "hold" },
  "co2_generator": { "kind": "co2-burner", "dayOffAtC": 28, "nightOnBelowC": 3,
                     "co2OnPpm": 1400, "co2OffPpm": 1500, "onStale": "hold" },
  "exhaust_fan":   { "kind": "thermostat", "mode": "cool", "onAtC": 30, "offAtC": 29.5, "onStale": "hold" }
}
// pumphouse (enabledRoles: ["heater", "heat_tape"]) - no daylight window, nothing reads one
"rules": {
  "heat_tape": { "kind": "thermostat", "mode": "heat", "onAtC": 4, "offAtC": 6, "onStale": "on" },
  "heater":    { "kind": "thermostat", "mode": "heat", "onAtC": 2, "offAtC": 5, "onStale": "on" }
}
```

- **The daylight window belongs to the zone**, not to a rule. Lights and burner share it, so they
  cannot disagree about when night is, and the readings screens split day from night at it.
  `daylight-thermostat` and `co2-burner` require one.
- **A zone may carry a rule for a role it does not own.** The greenhouse keeps its lights and fan
  settings across the transition; `enabledRoles` alone says what is controlled.
- **A per-role sensor override** is the rule's own `sensor`, e.g.
  `"sensor": { "source": "node:elantris" }`. The zone's `sensorPolicy.default` covers the rest.
- They live server-side. Operational policy that controls a heater is never shipped as consts in
  the browser bundle, where a stale cache could disagree about a setpoint.

### The config is validated, strictly

`parseZoneRulesConfig` runs on every evaluation. Before it existed a typo was whatever the engine
made of it: a misspelled setpoint read as `undefined`, every comparison against it was false, and the
role sat in its dead band forever reporting a calm-looking `dead-band`. On a heater that is a freeze.

It refuses unknown keys (the typo that matters most is in an optional field, which would otherwise
silently fall back), an unknown kind, a band that is backwards or zero-width, a missing `onStale`,
an owned role with no rule, and a day-dependent rule with no daylight window. A zone that fails is
**not evaluated at all** — half-evaluating it would hide that the other half is uncontrolled — and
it is named, with every error and its JSON path, in `GET /api/health` `problems`.

## The greenhouse rules

**Lights** (`daylight-thermostat`) — a heat source, 1 °C hysteresis. Inside the window: `t < 26` on;
`t > 27` off; `26–27` dead band, no action. Outside the window: unconditionally off.

**CO2 generator** (`co2-burner`) — doubles as the heater, and the two branches are genuinely
different rules:

- _Day:_ off at or above `dayOffAtC` (28 as running). Below it, on under 1400 ppm, off at 1500,
  holding between. A **null CO2 coerces to `+Infinity`** so it stays off.
- _Night:_ CO2 is irrelevant — pure frost protection, on iff `t < 3`.
- No temperature hysteresis on either branch. Anti-cycling comes from `onDelayDuration = 300`.

**Exhaust fan** (`thermostat`, `cool`) — time-independent: `t > 30` on, `t < 29.5` off, dead band
between.

Time windows are **minutes since midnight, start inclusive, end exclusive**, and midnight-crossing
aware.

## The engine is a pure function

```ts
evaluateRules(input: RulesInput): RuleDecision[]
```

No DB, no I/O, no `Date`. The caller resolves the zone, resolves the IANA timezone, and passes
`minutesSinceMidnightLocal` as a **number**. That is what makes the DST tests possible and is the
single most important structural decision in the port.

## How a reading becomes a decision

```
sample (per node)
   │  ReadingsIngestService — admission gate, then persist
   ▼
parseZoneRulesConfig — refuses the whole zone on any error
   ▼
ClimateResolver — applies each rule's sensor policy, or the zone default
   │  mean | max | min | node:<slug>, with maxAgeMs collapsing staleness into "no sensor"
   ▼
evaluateRules(minutesSinceMidnightLocal, config, enabledRoles, climateByRole)
   │  RuleDecision[] — { role, desired, reason, sourceNodeIds }
   ▼
DevicesService — per device sharing that (zone, role), filtered by its own rulesEnabled
   │  the interlocks apply here: already-on, cooldown, node admitted
   ▼
HardwareService.setPin — publish, await readback, then persist
```

`sourceNodeIds` is carried through so the UI and the logs can say **which sensors a decision came
from**. A decision whose provenance is unknowable is a decision nobody can debug.

## Three deliberate behaviour changes

Each is a change from the Python system, and each is intentional:

1. **Lights no longer require both device rows to exist.** The Python `if self._light() and
self._lights()` meant deleting one light silently disabled the other.
2. **`rulesEnabled` is per-device, not per-group.**
3. **Log only on state _change_.** At 8,640 evaluations a day × N devices, INFO-per-evaluation
   buries everything and fills the SD card.

Plus one addition: **`GET /api/rules/last-evaluation`**, returning the last decisions with every
input that produced them — resolved climate, provenance, local time, ownership, staleness, and what
each device did with the decision. The absence of this endpoint is what made the Python version
opaque: it logged what it did but never what it saw, so "the burner is off" and "the rule never ran"
looked identical.

`POST /api/rules/evaluate` forces one now, on the same code path as the scheduled tick. It drives
real relays, so it is a POST and it sits behind the shared token with the other mutating verbs.

### The no-ops, and the stale cases

| Reason           | Meaning                                                                       |
| ---------------- | ----------------------------------------------------------------------------- |
| `role-not-owned` | `enabledRoles` does not include this role. Devices are not even looked up     |
| `no-sensor`      | No node reports for this role at all — a configuration gap                    |
| `sensor-stale`   | Sensors existed and went quiet, and the rule says `onStale: "hold"`           |
| `stale-failsafe` | Sensors went quiet, and the rule says `onStale: "on"` or `"off"` — so it does |
| `dead-band`      | Inside the hysteresis band; changing state here is what causes cycling        |

`onStale` is **required on every rule**, not defaulted: what a heater does when its thermometer dies
is a decision somebody has to have made, per environment. The greenhouse holds, because failing the
burner off can freeze the crop and forcing it on can cook it. The pumphouse says `on`, because a
heater left running costs electricity and a heater left off costs the pipes. Either way a stale role
logs at ERROR and raises the banner — `sensor-stale` is separate from `no-sensor` precisely so it can
shout.

## ⚠ The porting landmine

Python's `can_turn_on` is `self.can_turn_on_at() < datetime.utcnow()`. For a device that has
**never been on**, `can_turn_on_at()` internally returns `datetime.utcnow()` — a _second, later_
call — so `t0 < t1` is **True**.

Port that with a single injected `now` and you get `now < now` → **False**, and a freshly created
device can never be turned on, by rules or by hand. **The never-on branch uses `<=`.** It has an
explicit regression test in `device-state.spec.ts`; do not "simplify" it back.

## Time and DST

Luxon, server-side only, with an explicit IANA zone from `TEMPESTAS_TZ` (`America/Vancouver`).

**The app must never read the host locale.** The Python bug being fixed is precisely that: it
resolved local time through the host's _current_ UTC offset, so a six-month-old reading was
interpreted with today's offset and every historical query was wrong by an hour across a DST
boundary.

The tests that matter, and that the Python version fails: explicit UTC instants across the March and
November boundaries, including the two distinct instants that both read 01:30 local, and a
six-month-old reading resolving with _its own_ offset.

## Pitfalls

- **A `null` CO2 is not zero.** `null → +Infinity` keeps the daytime branch off. Any code that
  defaults a missing CO2 to `0` inverts a safety behaviour into a hazard.
- **The night branch must not read CO2 at all.** A CO2 ceiling or a stale-CO2 guard applied
  globally would shut the heat off on a cold night. See [Safety](Safety.md).
- **What a stale sensor does is the rule's `onStale`.** The greenhouse holds last state and a
  human decides; the pumphouse turns heat on. Both log at ERROR and raise the banner.
- **Postgres reorders jsonb keys**, so the order of the `rules` object is meaningless. Roles are
  always evaluated and reported in the engine's `ROLE_ORDER`, and a new role must be added there —
  a spec fails if one is missing.
- **`role` is what automation binds to, not the name.** The old system resolved devices by display
  name (`'Lights'`, `'CO2 Generator'`), so renaming a device in the UI silently disabled its rule.
- **Roles are not unique.** Every device sharing a `(zone, role)` gets the same decision. Do not add
  a unique index on `role`.
- **Stats default window.** The Python default runs from _yesterday_ 23:59:59 to _today_ 23:59:59 —
  it includes the future, almost certainly by accident. Default to `now - 24h → now`, keeping
  end-of-day only when an explicit `?days=n` is given.

## The CO2 dead band, and why it is not one setpoint

`co2OnPpm: 1400` / `co2OffPpm: 1500`. Below 1400 the burner runs, at or above 1500 it stops, and
**between them it holds** — the same shape as the lights and exhaust-fan bands, which the CO2 rule
originally lacked.

The numbers are measured, not chosen. Watching a real burner in the greenhouse:

|                                          |                |
| ---------------------------------------- | -------------- |
| Charge rate from baseline (~520 ppm)     | ~88 ppm/min    |
| Charge rate near 1450 ppm                | ~15–20 ppm/min |
| Decay with the burner off, near 1550 ppm | ~28 ppm/min    |
| Overshoot after cut-out                  | ~65–105 ppm    |
| Lag before output shows at the sensor    | ~2.5 min       |

Leak rate scales with the gradient to outside air, so the burner barely out-runs it near the
setpoint and easily beats it at baseline. That is why a single threshold was untenable: the rule cut
at 1509 ppm and wanted the burner back on at 1494 — a **15 ppm band**. Ignition cycling is the main
wear mechanism on a propane appliance, and the gas spent lighting it dwarfs a few seconds of burn.
The device's 300 s minimum-off was doing all the damping, which it was never meant to do; it is a
floor, not a control law.

With the band, expect roughly six minutes climbing and three and a half falling. Because of the
overshoot the real oscillation is nearer **1360–1610** than 1400–1500.

> [!note] A person at the panel trips it
> Exhaled breath is ~40,000 ppm. Someone working next to the SCD41 spikes it past 1500 within
> seconds and it decays a minute later — a sharp spike and collapse, quite unlike the slow
> monotonic rise of real combustion. It only ever turns the burner _off_, so it is harmless, but
> readings taken while somebody is at the panel cannot be trusted.

## When to update this file

- A setpoint gains or loses a dead band
- A setpoint changes (and it changes in the zone's `rules_config`, not in code)
- A rule kind changes, or a new kind joins the menu
- A role is added
- The sensor policy gains a `source` option
- A new deliberate divergence from the Python behaviour is made
