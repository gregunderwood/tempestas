# Reports

## What it is

Summaries the raw tables never gave: how hard each device worked, how it cycled, how close the
pumphouse came to freezing, how long each zone spent where its rules are set to hold it, and which
nodes went quiet or rebooted. One server module, `apps/server/src/app/reports`, with one endpoint
per report, the response types in `libs/domain/src/lib/reports`, and a section per report on the
web Reports screen. Equipment runtime was the first, freeze margin the second, time in range the
third and node health the fourth; the next reports follow the same shape.

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
- [../../apps/server/src/app/reports/time-in-range.ts](../../apps/server/src/app/reports/time-in-range.ts) — a zone's periods to hours below, in range, above and without readings, pure
- [../../apps/server/src/app/reports/zone-band.ts](../../apps/server/src/app/reports/zone-band.ts) — the band, from the zone's heat and cool thermostat rules
- [../../apps/server/src/app/reports/report-periods.ts](../../apps/server/src/app/reports/report-periods.ts) — a zone's recent nights, or days and nights, from its daylight window
- [../../apps/server/src/app/reports/time-in-range.service.ts](../../apps/server/src/app/reports/time-in-range.service.ts) — finds the zones with nodes, their periods, held readings and extremes
- [../../apps/web/src/app/features/reports/time-in-range-card.ts](../../apps/web/src/app/features/reports/time-in-range-card.ts) — the card, one per zone with a node
- [../../apps/server/src/app/readings/reading-breaks.ts](../../apps/server/src/app/readings/reading-breaks.ts) — the gaps and boot changes in `sensor_readings`, found in Postgres
- [../../apps/server/src/app/reports/node-health.ts](../../apps/server/src/app/reports/node-health.ts) — breaks and updates to each node's gaps, reboots and version changes, pure
- [../../apps/server/src/app/reports/node-health.service.ts](../../apps/server/src/app/reports/node-health.service.ts) — loads the admitted nodes, their breaks and their healthy updates
- [../../apps/web/src/app/features/reports/node-health-card.ts](../../apps/web/src/app/features/reports/node-health-card.ts) — the card, one per admitted node

## The API

```
GET /api/reports/equipment-runtime?days=     per device per day; days defaults to 30, caps at 90
GET /api/reports/freeze-margin?nights=       per heated zone per night; nights defaults to 30, caps at 90
GET /api/reports/time-in-range?days=         per zone per day and night; days defaults to 30, caps at 90
GET /api/reports/node-health?days=           per admitted node; days defaults to 30, caps at 90
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
- **The coldest reading is the coldest probe in the zone**, any of the zone's nodes. It is the exact
  reading, with its probe and time.
- **The heat at that moment comes from the same `relay-spans.ts`** as equipment runtime. A device
  with no span covering the moment is **unknown, never off**.
- **The warning temperature is borrowed from the rules**: the highest heat on-setpoint among the
  zone's heater and heat tape `thermostat` rules, since below it at least one heat source should
  already be running. Without one it is `DEFAULT_FREEZE_WARNING_C`, 3 °C, and the card says which.
  A `daylight-thermostat` is off at night by design, so it never lends a setpoint.
- **Hours below** count the 10-minute stretches in which any of the zone's probes read below the
  warning, from the same `bucketTemperatures` as the zones page's history. Hours with readings sit
  beside them, so a gap in the readings is not read as hours above the warning.
- **Heat is owed by the rule's own reading.** At the coldest moment each device is judged by its
  rule's sensor source (`min`, `max`, `mean`, `node:` or `sensor:`), picked the way the climate
  resolver picks it, against its own on-setpoint. Each probe counts at its lowest in that moment's
  10-minute bucket, so a doubtful night leans towards a flag. A source with no probe reporting then
  owes nothing. The wire carries the verdict as `isHeatOwed`.
- **A concern flags a night**:
  - `heat-off-while-cold`: heat was owed, and that device was known off.
  - `heat-unknown-while-cold`: heat was owed, and nothing was heard from the device.
  - `cold-despite-heat`: every device owed heat was on, and the coldest reading still came within
    `FREEZE_MARGIN_ALARM_C`, 1 °C, of freezing.

The CO2 generator doubles as the greenhouse's night heater, but it is not one of `HEATING_ROLES`, so
the greenhouse is not in this report.

## Time in range

How long each zone spent where its rules are set to hold it. For every zone with a node, one row per
daylight and per night period, newest first, the running one included.

- **The band is the rules' own.** Below is under a `heater` or `heat_tape` `thermostat` rule's heat
  on-setpoint, and above is over an `exhaust_fan` `thermostat` rule's cool on-setpoint, both from
  `rules_config`, with no per-zone setting of its own. The report measures whether the rules held
  the zone where they are set to, not where the plants would like to be.
- **A zone with no heating rule has no lower bound, and one with no cooling rule no upper bound.**
  The card says so rather than inventing one. The greenhouse's lights (`daylight-thermostat`) and
  the CO2 generator's night frost protection (`co2-burner`) are not heating rules here, and a
  `daylight-thermostat` never lends a bound, since it is off by design half the time.
- **Each bound is read by its rule's own sensor source**, `min`, `max`, `mean`, `node:` or
  `sensor:`, as the climate resolver picks it. A source with no probe reporting in a stretch falls
  back to the probe that would trip it first: the coldest for a heat rule, the warmest for a cool one.
- **Below wins a tie.** A stretch under a heat setpoint by one probe and over a cool one by another
  counts as below.
- **Periods are the zone's daylight window**, the same as `/api/readings/stats/day-night`, with the
  deployment default for a zone with none. There is no combined 24-hour figure, for the reason in
  [Readings](Readings.md#day-and-night-not-24-hours).
- **A reading holds until the next one from its probe, for at most
  `TIME_IN_RANGE_LONGEST_HELD_MINUTES`, 1 minute.** Computed in SQL with `LEAD` over
  `sensor_readings` and summed into 5-minute buckets per probe, each probe's average judged against
  the band. A hold that runs past its bucket's end goes on in the next bucket, so a node that never
  missed a sample has no hours without readings. A stretch counts for as long as its longest-held
  probe held in it.
- **The 1-minute cap assumes every node samples at least once a minute.** A node sampling less
  often shows part of each period as without readings. Holding for each node's own
  `sampleIntervalMs` would lift that.
- **A bucket goes to the period that holds its start.** A daylight edge off the 5-minute grid,
  such as `06:02`, gives the whole `06:00` bucket to the night, and the day then starts with a
  few minutes without readings.
- **Hours without readings** are the rest of the period, so a gap is never counted as in range.
- **Each period has its extremes**, each the exact reading with its probe and time: a night's lowest
  temperature and humidity, and a day's highest temperature, humidity and CO2. A metric no probe
  reported is left out.

Only temperature has hours below, in range and above: nothing in `rules_config` bands humidity, and
CO2's only numbers are the burner's enrichment dead band, which switches the burner rather than
describing where the air should sit.

## Node health

A night with no readings otherwise just disappears from the averages, and a node that rebooted five
times looks like one that ran all week. Per admitted node, over the last 30 days, newest first:

- **Gaps** are silences longer than `NODE_HEALTH_GAP_MINUTES`, 5 minutes, between one reading from
  the node and the next, any sensor. That is 30 samples at the Linux agent's 10 s interval. The
  threshold is the same for every node, so one set to sample less often than every 5 minutes would
  show a gap between every pair of readings. A silence that runs up to now is an ongoing gap. Postgres walks the
  readings with `LAG`, so a month of 10 s samples never reaches Node.
- **Reboots** are changes of `boot_id` from one reading to the next, stamped at the first reading of
  the new boot. A null boot id predates the column and proves nothing, and the dev seeder's
  `seeded-history` rows are left out, so the seed meeting the first real reading is not a reboot. A
  reboot that left a long enough silence is a gap as well. The Linux agent makes a new boot id each
  time its process starts, so a restart of the agent, including every update, counts as a reboot.
- **Agent version changes** are the `node_updates` rows that finished `healthy`. Only updates run
  from the Nodes page are recorded; an agent installed by hand or by a deploy script changes
  `agent_version` on the node with no history, so it is not listed.
- **Stale-sensor holds are not recorded.** When a role's sensors go stale the rules hold its last
  state and only log it, so this report cannot list those periods. Recording them is
  [#182](https://github.com/gregunderwood/tempestas/issues/182).
- A gap that straddles the start of the window is not counted, and a node with no sensors has no
  readings to read gaps or reboots from; its card lists updates only.

The other reports should mark periods with gaps rather than average over them; this report is where
the gaps themselves are listed.

## When to update this file

- A report is added, or a default or cap changes
- The runtime, freeze margin, time in range or node health rules above change
