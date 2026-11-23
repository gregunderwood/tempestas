# Realtime

## What it is

The socket.io contract to the browser: five named events on one connection, and nothing else. No
request/response, no rooms, no per-client subscriptions.

The old feed was a bare `rxjs/webSocket` with no event envelope and no reconnect. A Pi on home WiFi
needs both, which is the whole reason for socket.io here.

## Key files

- [../../libs/domain/src/lib/realtime/realtime.model.ts](../../libs/domain/src/lib/realtime/realtime.model.ts) — event names and payload types
- [../../apps/server/src/app/realtime/realtime.gateway.ts](../../apps/server/src/app/realtime/realtime.gateway.ts) — the fan-out

## The events

| Event            | Payload        | Emitted when                                              |
| ---------------- | -------------- | --------------------------------------------------------- |
| `reading:latest` | `Reading`      | a sample is **persisted** — roughly every 10 s per node   |
| `device:state`   | `Device`       | a relay write succeeded, or `rulesEnabled` changed        |
| `node:state`     | `Node`         | a node is **saved**, or its derived `online` flips        |
| `system:status`  | `SystemStatus` | once per rules evaluation cycle, and at a follower's boot |
| `rules:cycle`    | `RulesCycle`   | once per rules evaluation cycle, on the leader only       |

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
- **`node:state` carries the node as `GET /api/nodes` would return it**, decorated with its
  device count, latest reading and derived `online`, after the row is saved. `NodesService`
  publishes it for every `hello` (so a newly announced pending node, a reboot, an agent upgrade
  and changed capabilities all arrive), every retained `status` (online and offline), and every
  admit, disable and operator edit. A refused admit publishes nothing. Deleting a pending node
  publishes nothing either: the browser that deleted it refetches, and others see it go on their
  next reconnect or reload.
- **Derived `online` also changes with no save**, because it lapses five minutes after the node
  was last heard from (its last sighting or its newest reading). `NodesService` remembers what it
  last published for each node and the evidence behind it, and every persisted reading updates
  that evidence. A reading that brings a stale node back publishes it at once, and a sweep every
  30 s publishes a node whose deadline has passed. The sweep reads only that memory, so a quiet
  greenhouse costs no queries.
- **`system:status` is one event per cycle, not per zone.** `staleRoles` is the union across zones,
  because a quiet sensor anywhere is worth surfacing everywhere.
- **`rules:cycle` is the whole cycle in one message**: every zone's evaluation (inputs,
  decisions, what each device did) plus `failingZones`, the zones the engine refused and why. One
  message so a screen never shows two zones from different ticks, and so a zone that is not being
  evaluated - a heater nobody is controlling - is said in the same breath. Failures for zones that
  no longer exist are dropped. `GET /api/rules/latest-cycle` returns the same message for first paint.

## Replay on connect

A new client immediately receives the last `reading:latest` **per sensor**, the last
`system:status` and the last `rules:cycle`, so a browser opening mid-cycle renders straight
away instead of showing an empty dashboard for ten seconds.

The cached `rules:cycle` is **cleared when the server stops being the leader**: a follower
does not evaluate, and replaying the last cycle it ran would present old decisions as current.
The zones page also flags any evaluation more than a minute old.

`SystemStatus.isLeading` is how a browser learns this controller is a follower. Demotion is a
restart, so a follower publishes its status at boot rather than after its first ten-second tick:
until then a reconnecting browser would keep the old leader's status. A leader does not, because
only its first evaluation can say whether a sensor is stale. On a follower the zones page says the
rules run on the leader instead of flagging an old evaluation.

`device:state` and `node:state` are deliberately **not** replayed. Device and node state are
authoritative from `GET /api/devices` and `GET /api/nodes`, and a cached copy replayed on connect
could contradict them. A client renders them from the API and patches them from the socket.

Devices, readings, the rules cycle, the zones page's zones and nodes, and the nodes screens' nodes
are fetched through `injectLiveSource`. It times a request out after 15 s and **fetches again on
every reconnect**, so a change made while the browser was offline is seen. A failed request is
tried again after 10 s, doubling to at most a minute, and the wait resets on success. Retries and
reconnect refetches are background requests: the error snackbar skips them, because the page
already reports the failure
and a retry every few seconds would keep the snackbar up for good.

A response to an older request never overwrites a newer one, and a request still running when its
page closes is cancelled. Each source is `loading`, `loaded`, `out-of-date` (the last refresh
failed; the previous response is kept) or `failed`. A rules cycle pushed over the socket counts as
loaded, because each one is complete; pushed readings do not, because each covers one sensor.

The client keeps the newest push **per device**, with when it arrived (`RealtimeService.devicePushes`).
`injectLiveDevices` applies every push received after its request was sent, so two devices switched
back to back both show, and a response never overwrites a newer push. `injectLiveReadings` keeps
whichever reading per sensor is newer by `createdAt`, so a push cached before the socket dropped
never hides a fresher fetch.

Nodes work the same way, through `RealtimeService.nodePushes` and `injectLiveNodes`, with one
addition: a node pushed after the request was sent but missing from its response is added, which
is how a node announcing itself as pending appears without a reload. A push from before the
request that the response does not contain is dropped, because that node has since been deleted.

## `system:status` is a safety feature

Layer 1 of the safety design holds last state when readings stop, and says so out loud: _"this is
only sound if the alarm is actually visible."_ `sensorStale` is what raises that banner, which makes
this event a required part of the feature rather than telemetry — and it is why the last status is
cached and replayed, rather than waiting up to 10 s for the next tick.

See [Safety](../Safety.md).

## Ages are measured on the server's clock

Every age the browser shows (rules ran, decided, read) subtracts a server timestamp from "now".
A phone a few minutes off would otherwise show "Rules have not run for over a minute" for good
(phone ahead), or hide a real stall for that long (phone behind).

So `system:status` carries `sentAt`, the server clock as that copy left the server. The gateway
stamps it on every emit **and on every replay**: a replayed status keeps its old `at`, and
measuring skew from that would mistake a stalled server for a browser clock running ahead, which
is exactly the case that hides staleness. `RealtimeService.serverClockOffsetMilliseconds` is
`sentAt` minus the browser's receive time, re-measured on every status, and `injectServerNow`
adds it to the browser clock. Until the first status arrives the offset is zero.

Network delay makes the offset read low by that delay, so an age can be milliseconds short. The
stale-sensor banner itself is unaffected either way: `sensorStale` is decided on the server.

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
- **The reading cache is keyed by `node/sensor`**, so a renamed slug or probe would orphan an entry
  until the next sample. Slugs are immutable after admission, which is why that is safe.
- **`system:status` can arrive before any reading** on a fresh boot, and correctly says
  `sensorStale: true` until fresh samples land — the last readings in the table may be from a
  previous run.

## When to update this file

- An event is added, renamed, or its payload changes (change `realtime.model.ts` first — this doc
  describes it)
- The replay-on-connect behaviour changes
- Rooms, namespaces or per-client filtering are introduced
