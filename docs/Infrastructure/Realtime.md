# Realtime

## What it is

The socket.io contract to the browser: three named events on one connection, and nothing else. No
request/response, no rooms, no per-client subscriptions.

The old feed was a bare `rxjs/webSocket` with no event envelope and no reconnect. A Pi on home WiFi
needs both, which is the whole reason for socket.io here.

## Key files

- [../../libs/domain/src/lib/realtime/realtime.model.ts](../../libs/domain/src/lib/realtime/realtime.model.ts) — event names and payload types
- [../../apps/server/src/app/realtime/realtime.gateway.ts](../../apps/server/src/app/realtime/realtime.gateway.ts) — the fan-out

## The events

| Event            | Payload        | Emitted when                                            |
| ---------------- | -------------- | ------------------------------------------------------- |
| `reading:latest` | `Reading`      | a sample is **persisted** — roughly every 10 s per node |
| `device:state`   | `Device`       | a relay write succeeded, or `rulesEnabled` changed      |
| `system:status`  | `SystemStatus` | once per rules evaluation cycle                         |

`REALTIME_EVENTS` and `RealtimePayloads` in `@tempestas/domain` are the contract; a client that
imports them cannot mis-type a handler.

## What is published, and when

The timing is the interesting part, and it is the same discipline as everywhere else in this repo:
**publish what happened, after it happened.**

- **`reading:latest` carries the row that was written** — its server-stamped `id` and `created_at`
  come back from `RETURNING`, not from a reconstruction of the sample. Nothing is published for a
  duplicate absorbed by `ON CONFLICT DO NOTHING`, and nothing for a sample discarded because its
  node is not admitted. Unbelievable data never reaches the dashboard for the same reason it never
  reaches the table.
- **`device:state` is published only after the hardware acknowledged AND the row saved.** An
  interlock refusal or a readback mismatch publishes nothing, so the dashboard cannot show a state
  the relay never reached. This is the same ordering `drive()` uses for the database.
- **`system:status` is one event per cycle, not per zone.** `staleRoles` is the union across zones,
  because a quiet sensor anywhere is worth surfacing everywhere.

## Replay on connect

A new client immediately receives the last `reading:latest` **per node** and the last
`system:status`, so a browser opening mid-cycle renders straight away instead of showing an empty
dashboard for ten seconds.

`device:state` is deliberately **not** replayed. Device state is authoritative from
`GET /api/devices`, and a cached copy replayed on connect could contradict it. A client renders
devices from the API and patches them from the socket.

## `system:status` is a safety feature

Layer 1 of the safety design holds last state when readings stop, and says so out loud: _"this is
only sound if the alarm is actually visible."_ `sensorStale` is what raises that banner, which makes
this event a required part of the feature rather than telemetry — and it is why the last status is
cached and replayed, rather than waiting up to 10 s for the next tick.

See [Safety](../Safety.md).

## Patterns to follow

### ✅ Publish after the durable write

```ts
await this.devices.save(device);
const dto = this.toDto(device);
this.realtime.publishDeviceState(dto);
```

### ❌ Don't publish an intention

```ts
this.realtime.publishDeviceState({ ...dto, isOn: true });   // ❌ before the relay confirmed
await this.hardware.setPin(...);
```

### ✅ A socket failure never reaches the caller

Every publisher is mid-way through something that matters more than the dashboard — an ingest, a
relay write, a rules evaluation. `emit` is wrapped and logs at warn; none of those callers should
fail because a browser went away.

### ❌ Don't put a decision in the gateway

It holds no repository and makes no decision. Its only state is the last-value cache that exists
for replay.

## Pitfalls

- **Everything is broadcast.** There is one namespace and no rooms, so every client sees every
  node's readings. That is correct for a LAN dashboard and would not be for anything multi-tenant.
- **CORS is set on the gateway separately from the HTTP app.** Both allow `localhost:*` and
  `192.168.*`; changing one does not change the other.
- **The reading cache is keyed by node slug**, so a renamed slug would orphan an entry until the
  next sample. Slugs are immutable after admission, which is why that is safe.
- **`system:status` can arrive before any reading** on a fresh boot, and correctly says
  `sensorStale: true` until fresh samples land — the last readings in the table may be from a
  previous run.

## When to update this file

- An event is added, renamed, or its payload changes (change `realtime.model.ts` first — this doc
  describes it)
- The replay-on-connect behaviour changes
- Rooms, namespaces or per-client filtering are introduced
