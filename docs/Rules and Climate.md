# Rules and Climate

## What it is

The control law: what the greenhouse actually does, at which thresholds, and why. Ported faithfully
from the Python system, with three deliberate behaviour changes and one landmine.

**Source of truth for the port is the *uncommitted* `set_device_states.py` running on the greenhouse
Pi right now** — not any doc, and not any committed version. The committed versions and the old
`CLAUDE.md` both carry stale thresholds.

> [!note] Status
> The engine itself is **phase 5, not yet built**. The types it consumes already exist in
> `libs/domain` (`ZoneRulesConfig`, `RulesInput`, `RuleDecision`, `RuleReason`). This document is
> the specification it is written against.

## Key files

- [../libs/domain/src/lib/zones/zone.model.ts](../libs/domain/src/lib/zones/zone.model.ts) — `RulesThresholds`, `SensorPolicy`, `SensorSource`
- [../libs/domain/src/lib/rules/rules.model.ts](../libs/domain/src/lib/rules/rules.model.ts) — `RulesInput`, `RuleDecision`, `RuleReason`
- [../libs/domain/src/lib/devices/device.model.ts](../libs/domain/src/lib/devices/device.model.ts) — `DeviceRole`, which automation binds to
- [../apps/server/src/app/devices/device-state.ts](../apps/server/src/app/devices/device-state.ts) — the interlocks the decisions run into

## The constants

```
startTime 06:30   endTime 18:30
lightsOnTemp 26   lightsOffTemp 27
co2OffTemp 26     co2NightOnTemp 3     co2ThresholdPpm 1500
exhaustOnTemp 30  exhaustOffTemp 29.5
```

They live in the zone's `rules_config` jsonb, server-side. Operational policy that controls a heater
is never shipped as consts in the browser bundle, where a stale cache could disagree about a setpoint.

## The three rules

**Lights** — a heat source, 1 °C hysteresis. Inside the window: `t < 26` on; `t > 27` off; `26–27`
dead band, no action. Outside the window: unconditionally off.

**CO2 generator** — doubles as the heater, and the two branches are genuinely different rules:

- *Day:* on iff `t < 26 AND co2 < 1500`. A **null CO2 coerces to `+Infinity`** so it stays off.
- *Night:* CO2 is irrelevant — pure frost protection, on iff `t < 3`.
- No hysteresis on either branch. Anti-cycling comes only from `onDelayDuration = 300`.

**Exhaust fan** — time-independent: `t > 30` on, `t < 29.5` off, dead band between.

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
ClimateResolver — applies the zone's sensorPolicy per role
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
3. **Log only on state *change*.** At 8,640 evaluations a day × N devices, INFO-per-evaluation
   buries everything and fills the SD card.

Plus one addition: **`GET /api/rules/last-evaluation`**, returning the last decisions with their
inputs and reasons. The absence of this endpoint is what made the Python version opaque.

## ⚠ The porting landmine

Python's `can_turn_on` is `self.can_turn_on_at() < datetime.utcnow()`. For a device that has
**never been on**, `can_turn_on_at()` internally returns `datetime.utcnow()` — a *second, later*
call — so `t0 < t1` is **True**.

Port that with a single injected `now` and you get `now < now` → **False**, and a freshly created
device can never be turned on, by rules or by hand. **The never-on branch uses `<=`.** It has an
explicit regression test in `device-state.spec.ts`; do not "simplify" it back.

## Time and DST

Luxon, server-side only, with an explicit IANA zone from `TEMPESTAS_TZ` (`America/Vancouver`).

**The app must never read the host locale.** The Python bug being fixed is precisely that: it
resolved local time through the host's *current* UTC offset, so a six-month-old reading was
interpreted with today's offset and every historical query was wrong by an hour across a DST
boundary.

The tests that matter, and that the Python version fails: explicit UTC instants across the March and
November boundaries, including the two distinct instants that both read 01:30 local, and a
six-month-old reading resolving with *its own* offset.

## Pitfalls

- **A `null` CO2 is not zero.** `null → +Infinity` keeps the daytime branch off. Any code that
  defaults a missing CO2 to `0` inverts a safety behaviour into a hazard.
- **The night branch must not read CO2 at all.** A CO2 ceiling or a stale-CO2 guard applied
  globally would shut the heat off on a cold night. See [Safety](Safety.md).
- **A stale sensor holds last state**, logs at ERROR, and raises a banner. It does not fail
  everything off, and it does not force heat on. A human decides.
- **`role` is what automation binds to, not the name.** The old system resolved devices by display
  name (`'Lights'`, `'CO2 Generator'`), so renaming a device in the UI silently disabled its rule.
- **Roles are not unique.** Every device sharing a `(zone, role)` gets the same decision. Do not add
  a unique index on `role`.
- **Stats default window.** The Python default runs from *yesterday* 23:59:59 to *today* 23:59:59 —
  it includes the future, almost certainly by accident. Default to `now - 24h → now`, keeping
  end-of-day only when an explicit `?days=n` is given.

## When to update this file

- A threshold changes (and it changes in the zone's `rules_config`, not in code)
- A rule body changes, or a fourth rule appears
- The sensor policy gains a `source` option
- A new deliberate divergence from the Python behaviour is made
