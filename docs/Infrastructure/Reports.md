# Reports

## What it is

Summaries the raw tables never gave: how hard each device worked, and how it cycled. One server
module, `apps/server/src/app/reports`, with one endpoint per report, the response types in
`libs/domain/src/lib/reports`, and a card per report on the web Reports screen. Equipment runtime is
the first; the next reports follow the same shape.

## Key files

- [../../apps/server/src/app/reports/equipment-runtime.ts](../../apps/server/src/app/reports/equipment-runtime.ts) — transitions to per-day runtime, pure
- [../../apps/server/src/app/reports/reports.service.ts](../../apps/server/src/app/reports/reports.service.ts) — loads the rows, resolves each zone's timezone
- [../../libs/domain/src/lib/reports/equipment-runtime.model.ts](../../libs/domain/src/lib/reports/equipment-runtime.model.ts) — the wire types
- [../../apps/web/src/app/features/reports/equipment-runtime-card.ts](../../apps/web/src/app/features/reports/equipment-runtime-card.ts) — the card

## The API

```
GET /api/reports/equipment-runtime?days=     per device per day; days defaults to 30, caps at 90
```

## Equipment runtime

Built from `pin_transitions`, per device per calendar day in the **device's zone**: hours on, off
and unknown, starts, and the shortest run. The rows in the window are read together with the row in
force when it opened, so the first day does not start as unknown.

- **Unknown is not off.** An `energised = null` span, time before any history, and time after an
  offline node was last heard all count as unknown, and the three hour figures add up to the day.
- **Calendar days, not 24-hour blocks.** A DST day is 23 or 25 hours long.
- **Hours split at the zone's midnight; a run does not.** A run that crosses midnight puts its hours
  on both days, but counts as one start on the day it began, at its whole length. Cutting it in two
  would invent a short run, which is exactly what this report exists to spot.
- **A start follows a known off.** A node reappearing with the relay on is not a start.
- **The shortest run counts only runs closed by a known off.** A run ended by an unknown or still
  going is a lower bound, not a length.
- **An offline node's open run is cut at its last-seen time**, the later of its last connection and
  its latest reading, and every day it touches is marked. While the node is online, the run goes to
  now.
- History on a pin from before its device row claimed it belongs to no device and is left out.

Not here yet: propane used. It needs a burn rate on each device, and so a migration.

## When to update this file

- A report is added, or a default or cap changes
- The runtime rules above change
