# Reports

## What it is

Summaries the raw tables never gave: how hard each device worked, how it cycled, and how close the
pumphouse came to freezing. One server module, `apps/server/src/app/reports`, with one endpoint per
report, the response types in `libs/domain/src/lib/reports`, and a section per report on the web
Reports screen. Equipment runtime was the first and freeze margin the second; the next reports
follow the same shape.

## Key files

- [../../apps/server/src/app/reports/equipment-runtime.ts](../../apps/server/src/app/reports/equipment-runtime.ts) — transitions to per-day runtime, pure
- [../../apps/server/src/app/devices/relay-spans.ts](../../apps/server/src/app/devices/relay-spans.ts) — transitions to on, off and unknown spans, pure; shared with the zones page's history
- [../../apps/server/src/app/reports/reports.service.ts](../../apps/server/src/app/reports/reports.service.ts) — loads the rows, resolves each zone's timezone
- [../../libs/domain/src/lib/reports/equipment-runtime.model.ts](../../libs/domain/src/lib/reports/equipment-runtime.model.ts) — the wire types
- [../../apps/web/src/app/features/reports/equipment-runtime-card.ts](../../apps/web/src/app/features/reports/equipment-runtime-card.ts) — the card
- [../../apps/web/src/app/features/reports/propane-units.ts](../../apps/web/src/app/features/reports/propane-units.ts) — litres to pounds, rounding, the remembered unit
- [../../apps/server/src/app/reports/freeze-margin.ts](../../apps/server/src/app/reports/freeze-margin.ts) — a zone's nights to coldest moment, heat then, hours below and concern, pure
- [../../apps/server/src/app/reports/heating-setpoints.ts](../../apps/server/src/app/reports/heating-setpoints.ts) — the warning temperature, borrowed from the zone's heat rules
- [../../apps/server/src/app/reports/freeze-margin.service.ts](../../apps/server/src/app/reports/freeze-margin.service.ts) — finds the heated zones, their nights, readings and relay spans
- [../../apps/web/src/app/features/reports/freeze-margin-card.ts](../../apps/web/src/app/features/reports/freeze-margin-card.ts) — the card, one per heated zone

## The API

```
GET /api/reports/equipment-runtime?days=     per device per day; days defaults to 30, caps at 90
GET /api/reports/freeze-margin?nights=       per heated zone per night; nights defaults to 30, caps at 90
```

## Equipment runtime

Built from `pin_transitions`, per device per calendar day in the **device's zone**: hours on, off
and unknown, starts, and the shortest run. The rows in the window are read together with the row in
force when it opened, so the first day does not start as unknown.

- **Unknown is not off.** An `energised = null` span, time with no history, and the time a node was
  offline all count as unknown, and the three hour figures add up to the part of the day the device
  existed.
- **A device's days start when it was added.** Time before its row was created is not unknown, it
  is nothing: a day that ended before then is marked `isBeforeDeviceAdded` with no hours, draws no
  bar and is left out of the day-by-day table, so a new device does not show weeks of grey.
- **Calendar days, not 24-hour blocks.** A DST day is 23 or 25 hours long.
- **Hours split at the zone's midnight; a run does not.** A run that crosses midnight puts its hours
  on both days, but counts as one start on the day it began, at its whole length. Cutting it in two
  would invent a short run, which is exactly what this report exists to spot.
- **A start follows a known off.** A node reappearing with the relay on is not a start.
- **The shortest run counts only runs closed by a known off.** A run ended by an unknown or still
  going is a lower bound, not a length.
- **A run is cut when its node went offline**, and every day it touches is marked. The transition
  log writes a `node-offline` row, unknown, for each of the node's known pins when its offline status
  arrives, so a run before an outage ends there even after the node comes back.
- **An open run on an offline node with no such row is cut at its last-seen time**, the later of its
  last connection and its latest reading. That covers history from before the `node-offline` row
  existed. While the node is online, the run goes to now.
- An outage that began while the server was down is stamped when the server started and read the
  retained offline status, so the run before it counts as on until then.
- History on a pin from before its device row claimed it belongs to no device and is left out.

### Propane used

An estimate for every device with a burner rating, per day and in total. Mainly the heater and the
CO2 generator, but it is keyed on the rating, never on the role.

- **The rating is the nameplate's gas input**, `inputBtuPerHour` on the device, set with
  `POST /api/devices` or `PUT /api/devices/:id` like its other settings. It is input, not heat
  output, so efficiency never enters into it. Null, the default, means no estimate and nothing
  extra on the card.
- **Litres = hours on × BTU/hr ÷ 24,000 BTU per litre**, `PROPANE_BTU_PER_LITRE` in
  `equipment-runtime.ts`, from Natural Resources Canada's 25.31 MJ/L for propane. Litres, because
  Superior Propane bills by the litre.
- **Only hours known to be on count.** Unknown hours are not estimated, and the card says so.
- **The server sends unrounded litres; the browser converts and rounds.** Pounds are litres × about
  1.12 lb/L, from liquid propane at about 0.51 kg/L, so the two units always agree. One litres or
  pounds toggle above the cards switches all of them. It starts on litres and is remembered in the
  browser, like the card arrangement, so each browser keeps its own.
- **Today's rating applies to the whole window.** Changing a device's rating recalculates every day
  in the report at the new one; the rating is not stored with each transition. A rating is a fixed
  nameplate figure, so it changes only to correct a mistake, and then the old figures were wrong
  too.

Not here: cost. The price per litre changes through the year.

## Freeze margin

The pumphouse's job is to never freeze, and a heater that has quietly stopped working otherwise
shows up as frozen pipes. For every zone with a `heater` or `heat_tape` device, one row per night,
newest first, tonight included while it runs.

- **A night is the zone's dark hours**, from its daylight window, the same periods as
  `/api/readings/stats/day-night`. A zone with no window, like the pumphouse, uses the deployment
  default of 06:30 to 18:30 in its own timezone.
- **The coldest reading is the coldest probe in the zone**, any of the zone's nodes, because the
  pumphouse heat runs on `min`. It is the exact reading, with its probe and time.
- **The heat at that moment comes from the same `relay-spans.ts`** as equipment runtime. A device
  with no span covering the moment is **unknown, never off**.
- **The warning temperature is borrowed from the rules**: the highest heat on-setpoint among the
  zone's heater and heat tape `thermostat` rules, since below it at least one heat source should
  already be running. Without one it is `DEFAULT_FREEZE_WARNING_C`, 3 °C, and the card says which.
  A `daylight-thermostat` is off at night by design, so it never lends a setpoint.
- **Hours below** count the 10-minute stretches in which any of the zone's probes read below the
  warning, from the same `bucketTemperatures` as the zones page's history. Hours with readings sit
  beside them, so a gap in the readings is not read as hours above the warning.
- **A concern flags a night**, judged against each device's own on-setpoint at the coldest moment:
  - `heat-off-while-cold`: below a device's setpoint, and that device was known off.
  - `heat-unknown-while-cold`: below a device's setpoint, and nothing was heard from it.
  - `cold-despite-heat`: every device owed heat was on, and it still came within
    `FREEZE_MARGIN_ALARM_C`, 1 °C, of freezing.
- **A role pinned to one probe** is still judged against the coldest probe, so it can be flagged
  for a cold corner its rule never reads. The pumphouse uses `min`, where the two agree.

The CO2 generator doubles as the greenhouse's night heater, but it is not one of `HEATING_ROLES`, so
the greenhouse is not in this report.

## When to update this file

- A report is added, or a default or cap changes
- The runtime or freeze margin rules above change
