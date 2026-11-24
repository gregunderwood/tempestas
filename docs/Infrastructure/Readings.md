# Readings

## What it is

The read side of `sensor_readings`: the query surface, how a query becomes a time window, and the
retention job that keeps the table from eating the SD card. Ingest — the admission gate and the
QoS-1 dedupe — is in [Nodes](Nodes.md) and [Database](Database.md).

Every query is bounded by an explicit window **and** an explicit row limit. That is not politeness:
the old API's list endpoint had neither, across 2.87M rows with no index on `created_at`, on the
same SD card the burner controller writes to.

## Key files

- [../../apps/server/src/app/readings/reading-window.ts](../../apps/server/src/app/readings/reading-window.ts) — query to window, pure
- [../../apps/server/src/app/readings/readings.service.ts](../../apps/server/src/app/readings/readings.service.ts) — list, latest, stats
- [../../apps/server/src/app/readings/retention.service.ts](../../apps/server/src/app/readings/retention.service.ts) — the batched nightly prune
- [../../apps/server/src/app/readings/dto/readings-query.dto.ts](../../apps/server/src/app/readings/dto/readings-query.dto.ts) — where `days=7` becomes a number

## The API

```
GET /api/readings?days=&from=&to=&nodeId=&limit=     newest first, windowed and limited
GET /api/readings/latest                            one row per sensor, unwindowed
GET /api/readings/stats?days=&from=&to=&nodeId=      min/max/average over the window
```

`GET /api/zone-history` also reads this table, through `ReadingsService.bucketTemperatures`: each
sensor's temperature over the last 24 hours as five-minute buckets (average, lowest, highest and
sample count), so a zone card draws 288 points per probe instead of 8,640 rows. Buckets start on
whole multiples of five minutes since the epoch (`date_bin` from `TIMESTAMPTZ 'epoch'`), which lets
the browser add a pushed reading to the bucket the next fetch will put it in. See
[Web App](../Web%20App.md#the-last-24-hours-on-a-zone-card).

`nodeId` is the node **slug**, as everywhere on the wire. `limit` defaults to **500** and caps at
5,000 — 90 days of retention at one sample per node per 10 s is over three quarters of a million
rows, and a dashboard wants `/stats` over a window rather than the window itself.

`/latest` is one row per **sensor**, not per node: a node with a probe per pipe would otherwise
show whichever probe spoke last and hide the others.

`/stats` returns each extreme as a **whole reading**, so the UI can link to the record and say which
node and when — not just a bare number.

## How a query becomes a window

Four rules, all in the pure `resolveReadingWindow`:

| Input         | Window                                                                     |
| ------------- | -------------------------------------------------------------------------- |
| nothing       | `[now - 24h, now]` — a rolling day, not a calendar one                     |
| `days=n`      | `[start of local day n-1 days ago, now]` — n calendar days including today |
| `from` / `to` | used verbatim, with `to` clamped                                           |
| reversed      | **refused** with `400 VALIDATION_FAILED`                                   |

Two of those exist to fix specific old behaviour:

- **`to` is never in the future.** The Python default ran from _yesterday_ 23:59:59 to _today_
  23:59:59 — a window that starts a day early and ends in the future, almost certainly by accident.
  The echoed `to` then told the dashboard it was showing data up to a time that had not happened.
- **A reversed range is refused, not swapped.** Swapping hides a client bug and quietly returns the
  wrong data.

`days=n` uses **calendar** arithmetic through Luxon, not `n × 86400s`, so a DST day is 23 or 25
hours long and the window still lands on local midnight. The timezone comes from `TEMPESTAS_TZ` —
this is a display concern, unlike rule evaluation, which resolves the zone row's own timezone.

## Nulls

- `co2` is nullable and null means **unknown, never zero**.
- `AVG` ignores nulls, which is what we want: an invalid CO2 must not be averaged in as a zero. It
  returns null only when every row in the window was invalid.
- Extremes filter `IS NOT NULL` explicitly. **Postgres sorts NULLs as larger than any value**, so a
  `DESC` ordering would otherwise report an invalid reading as the maximum.
- An empty window has no average and no extremes, and the types say so (`number | null`,
  `Reading | null`). The old `Stats` type was `any`, so this reached the client as `NaN`.

## Retention

`@Cron` daily at 03:00 local — after the coldest part of the night, well before sunrise. Horizon
from `RETENTION_DAYS` (90).

Two old failures are fixed at once here. The retention command existed but **was never scheduled**,
so nothing ever ran; and it deleted in a single unbounded statement, which on millions of rows holds
a write lock and saturates the card's write bandwidth for minutes.

```sql
DELETE FROM sensor_readings
 WHERE id IN (SELECT id FROM sensor_readings WHERE created_at < $1 LIMIT $2)
```

The subquery is what bounds one statement to 5,000 rows, so each lock is short and the card gets to
breathe between batches. A 200-batch per-run ceiling stops one night from running forever; anything
left goes in the next run. A `RETENTION_DAYS` that is not a number ≥ 1 is **refused**, not guessed —
a bad value here deletes history.

## Why `sensor_readings` is not partitioned

The plan called for range-partitioning by month from day one. **It is incompatible with the QoS-1
dedupe, and the dedupe wins.** Postgres says so directly:

```
ERROR: unique constraint on partitioned table must include all partitioning columns
DETAIL: UNIQUE constraint on table "..." lacks column "created_at" which is part of the partition key.
```

Adding `created_at` to `UNIQUE (node_id, sensor_id, boot_id, node_seq)` destroys it, because
`created_at` is server-stamped at insert — a redelivered QoS-1 duplicate gets a _different_
`created_at` and no longer conflicts. Duplicate rows mean duplicate rules evaluations, and that is a
correctness property, where partitioning is an optimisation.

It is also an optimisation this table does not need. At 90-day retention and one sample per node
per 10 s, steady state is ~17k rows/day/2 nodes — about **1.5M rows**, bounded, with
`(created_at)` and `(node_id, created_at)` indexes. Revisit if retention grows past a year or the
node count reaches double figures.

## Deferred: batching inserts

The plan proposed buffering 6 samples and writing every 60 s to cut commits 6× and spare the SD
card. **Not done, deliberately** — the rules engine reads the latest reading per node from this
table every 10 s, so a 60 s buffer would put every control decision up to a minute behind the
sensor and add a crash window in which buffered readings vanish. If SD write volume becomes the
binding constraint, the answer is booting from a USB3 SSD (see [Hardware](../Hardware.md)), not
delaying the data the burner is controlled from.

## Pitfalls

- **`/readings` is not a bulk export.** It is capped. Anything wanting the whole table wants
  `pg_dump`.
- **`AVG` returns a string** through the pg driver, and null for an empty window. Coerce and round
  explicitly.
- **`distinctOn` requires the leading `ORDER BY` to match.** `/readings/latest` is
  `DISTINCT ON (node_id, sensor_id) … ORDER BY node_id, sensor_id, created_at DESC`; reordering it breaks the query rather
  than slowing it.
- **A window is not a zone.** These endpoints are global; nothing here filters by zone yet.

## Day and night, not 24 hours

`GET /api/readings/stats/day-night` returns the last three **contiguous** daylight and night
periods, oldest first, ending with the one still running. By day that reads previous day, last
night, today so far; by night, previous night, yesterday's daylight, tonight so far.

There is deliberately **no combined 24-hour figure**, and this is not a display choice. The burner
is CO2 enrichment by day and the greenhouse's heat source by night, so a window spanning both
averages two different jobs together and describes neither. A 4 °C minimum is the night rule
working or a midday fault; only the period it belongs to says which.

It is equally deliberately not "all daylight readings in the last 24 hours". That would put this
morning and yesterday afternoon in the same average.

Three things it must keep doing, each with a test:

- **The boundary is the zone's own `daylight` window** — the one the rules engine branches on. A
  zone with none, like the pumphouse, splits at the deployment default in its own timezone. `daylight-segments.spec.ts` asserts the running period's kind against
  `isWithinWindow` at every half hour, for four window shapes, so the screen cannot start
  explaining a decision the controller never made.
- **Boundaries are SET in the zone, never added as minutes to midnight.** On a spring-forward day
  the clock skips an hour, so midnight plus 390 minutes is 07:30 local, not 06:30 — every period
  then lands an hour out. This was written wrong first and the DST test caught it.
- **A midnight-crossing window needs no special case.** Boundaries are listed and sorted, so
  18:30–06:30 behaves like any other shape. A zero-length window returns no periods rather than
  guessing "always daytime".

## When to update this file

- The day/night split changes shape, or stops agreeing with the rules engine

- A readings endpoint is added, or a default or cap changes
- The window rules change
- Retention changes its schedule, batch size or horizon
- Partitioning is revisited (and the dedupe question above is answered)
