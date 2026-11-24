# Nodes

## What it is

The node registry: how a node comes to exist, what it is allowed to do before a human approves it,
and who owns which of its fields. The admission gate is a **safety feature** — a stray ESP32 on the
WiFi must not be able to inject a temperature reading that starts a combustion burner.

## Key files

- [../../apps/server/src/app/nodes/node-registry.ts](../../apps/server/src/app/nodes/node-registry.ts) — the decisions, as pure functions
- [../../apps/server/src/app/nodes/nodes.service.ts](../../apps/server/src/app/nodes/nodes.service.ts) — the subscriptions and the lifecycle
- [../../apps/server/src/app/readings/readings-ingest.service.ts](../../apps/server/src/app/readings/readings-ingest.service.ts) — where the gate is enforced on inbound data
- [../../apps/server/src/app/devices/devices.service.ts](../../apps/server/src/app/devices/devices.service.ts) — where it is enforced on outbound commands
- [../../libs/domain/src/lib/nodes/node.model.ts](../../libs/domain/src/lib/nodes/node.model.ts) — `NodeKind`, `NodeStatus`, `NodeCapabilities`
- [../../apps/server/src/app/nodes/node-update-rules.ts](../../apps/server/src/app/nodes/node-update-rules.ts) — when an update may be sent, and what a node's report does to it
- [../../apps/server/src/app/nodes/node-updates.service.ts](../../apps/server/src/app/nodes/node-updates.service.ts) — sends updates and keeps each one in `node_updates`

## The lifecycle

```
        hello (unknown slug)
                │
                ▼
          ┌──────────┐   admit    ┌──────────┐   disable   ┌──────────┐
          │ pending  │───────────►│ admitted │────────────►│ disabled │
          └──────────┘            └──────────┘             └──────────┘
                │                       ▲                        │
             delete                     └────────admit───────────┘
                │
                ▼
           (gone; returns as pending on its next hello)
```

| Status     | Readings      | Commands |
| ---------- | ------------- | -------- |
| `pending`  | **discarded** | none     |
| `admitted` | persisted     | yes      |
| `disabled` | **discarded** | none     |

`pending` is inert in both directions. `disabled` is the terminal state for a node that should never
be believed again — and unlike deleting it, a `hello` cannot bring it back, because **a hello never
moves status**.

## Who owns what

This split is the whole point of `node-registry.ts`, and `patchFromHello`'s return type enforces it
by simply not having the other fields:

| Owner                 | Fields                                                        |
| --------------------- | ------------------------------------------------------------- |
| The node, via `hello` | `kind`, `capabilities`, `agentName`, `agentVersion`, `bootId` |
| The node, via its LWT | `online`, `lastSeenAt`                                        |
| A human, via the API  | `status`, `displayName`, `location`, `zoneId`                 |

A node that re-announces itself therefore cannot admit itself, un-admit itself, undo a rejection, or
rename what an operator called it.

## How it works

`NodesService` subscribes to `hello$` and `availability$` and funnels both through **one serial
queue**. They arrive from the broker with no ordering guarantee between them, and a `hello` racing
its own status message would otherwise produce two rows for one slug. A failure in one task logs and
never breaks the chain — an unreachable database during one `hello` must not silently unsubscribe
the registry for the life of the process.

**`hello` from an unknown slug** creates a `pending` row with `displayName = slug` (the nodes list
has to render something for a node nobody has looked at yet) and logs at **WARN** — the one registry
event that needs a human.

**`hello` from a known slug** refreshes the node-owned fields and classifies the result, which is
what the log line is for:

| Outcome                | Level | Meaning                                                          |
| ---------------------- | ----- | ---------------------------------------------------------------- |
| `rebooted`             | log   | `bootId` changed. Phase 7 uses this to re-assert pin state       |
| `capabilities-changed` | warn  | A device may now be bound to a pin the node no longer exposes    |
| `agent-upgraded`       | log   | Only the version moved                                           |
| `seen`                 | debug | Re-announced, unchanged — must stay quiet or it buries the WARNs |

**Availability** sets `online`. Only an _online_ transition updates `lastSeenAt`: leaving it alone on
an LWT is what makes "offline since" answerable at all. Going offline logs at WARN and says the
thing that matters — **its pin states are now unknown, not off**.

**Availability for an unregistered slug is ignored.** Registration needs `capabilities`, and only
`hello` carries them; a retained status for a slug we have never met is either a node that has not
re-announced yet or a stale retained message.

## Capabilities

```ts
interface NodeCapabilities {
  contractVersion: 1;
  gpio?: { pins: number[]; supportsReadback: boolean }; // absent = sensor-only node
  sensors: SensorCapability[]; // empty = actuator-only node
  maxCommandRateHz?: number; // an ESP32 handles commands more slowly
  hasRtc: boolean; // an ESP32 has none: its clock is diagnostic
}
```

`gpio.pins` is the constraint the database cannot express: a device may only claim a pin the node
says it exposes. `DevicesService.assertPinAvailable` returns `409 PIN_NOT_AVAILABLE` with the
available pins in `details`.

**Nothing outside display may branch on `kind`.** The server asks "does this node expose pin N?" and
"which metrics does this sensor publish?" — both answered here. That is what makes an ESP32 a YAML
file (ESPHome has native MQTT and built-in SCD4x support) rather than a code change.

## The API

```
GET    /api/nodes                # includes deviceCount, latestReadingAt, availableUpdate and updates
GET    /api/nodes/:id
PUT    /api/nodes/:id            # displayName, location, zoneId — nothing else
POST   /api/nodes/:id/admit      # optional { zoneId, displayName, location }
POST   /api/nodes/:id/disable
POST   /api/nodes/:id/update     # sends the node its availableUpdate
POST   /api/nodes/:id/roll-back  # sends the node updates.rollBackVersion
DELETE /api/nodes/:id            # pending only
```

`availableUpdate` is the newer agent version the server could send the node, or `null`. The
bundles it comes from are listed at `GET /api/agent-releases`; see
[Agent release bundles](Deploys.md#agent-release-bundles).

## Updating a node from the web

`POST /api/nodes/:id/update` sends the node an
[`update` command](MQTT%20Contract.md#the-update-command) for its `availableUpdate`, and answers
`202` once the broker has it. The node does the rest and reports each step on `update/status`.

- **One node at a time.** The server refuses with `409 UPDATE_IN_PROGRESS` while any node's update
  is still in progress, so a bad release cannot take out every node at once. Two quick presses are
  queued, so the second sees the first.
- **Only an admitted, online node, from the leader**, and only once `AGENT_RELEASES_URL` is set
  (`409 UPDATES_NOT_CONFIGURED`): it is the address the node downloads the bundle from, as the
  node sees the server. `updates.blockedBecause` says which of these stands in the way, so the page
  disables the button and says why before anyone presses it.
- **Every update is a row in `node_updates`**, keyed by the command's `id`: from and to versions,
  whether it was a roll back, the last state the node reported, the outcome and its reason. A
  status is matched by `id` and by the node it came from, so a node cannot report on another's
  update. `updates.lastUpdate` is the newest row.
- **Five minutes with no final state is `timed-out`**, with the last state heard as the reason, and
  frees the next update. The node may still finish: a final state it sends later replaces the
  time-out, since the node knows what happened and the server only stopped waiting.
- **Roll back** sends the version the node ran before its last healthy update, while that bundle
  is still offered. It is offered only straight after that update: once the node has moved on, or
  for a roll back itself, there is nothing to undo. It is an ordinary update to an older version,
  with the same checks and the same automatic rollback on the node.

Each change republishes every node over `node:state`, because one node starting an update blocks
the others.

**There is no `POST /api/nodes`.** A node comes into existence by announcing itself; the only thing a
human does is admit it. That asymmetry keeps the registry a record of what is actually on the
network rather than a wish list somebody typed.

`admit` is **idempotent** — a double-clicked button must not raise a 409 at an operator — and it is
also where the node gets its zone, because a node with no zone has nowhere to put its devices and no
`rules_config` to be evaluated against.

## Patterns to follow

### ✅ Ask the registry, don't re-derive the rule

```ts
if (!acceptsCommands(device.node.status)) {
  throw new ConflictException({ code: ApiErrorCode.NodeNotAdmitted, ... });
}
```

### ✅ Return a reason, not a boolean, when the caller has to log it

```ts
type SampleResolution = { accepted: true; node: NodeEntity } | { accepted: false; reason: 'unknown-node' | 'pending' | 'disabled' };
```

Narrow it with `resolution.accepted === false`, not `!resolution.accepted` — the equality comparison
against the literal is what narrows the union under this TS config.

### ❌ Don't let a `hello` write a human-owned field

```ts
Object.assign(existing, { ...patch, status: NodeStatus.Admitted }); // ❌ the gate is now theatre
```

### ❌ Don't delete a node to reject it

Deleting cascades its readings away and it returns as `pending` on its next hello. `disable` is the
reject operation, and it keeps the history.

## Pitfalls

- **`hello` is not retained**, so subscribe before anything announces. The fake driver announces
  from `onApplicationBootstrap` because Nest runs every `onModuleInit` first — get this wrong and
  every hello is silently lost.
- **Postgres reorders `jsonb` keys**, so comparing `capabilities` with `JSON.stringify` reports a
  capability change on every restart. `node-registry.ts` compares key sets.
- **A `null` `bootId`** is a row first seen before the column existed. Do not report a reboot you
  cannot prove — a lie in the log used to diagnose the next outage is worse than a missing line.
- **Discarded readings are logged once, then rate-limited.** A pending node produces ~8,640 discards
  a day; logging each would bury the WARN saying it needs admitting.
- **A node's `online` stays `true` after the server stops** in `fake` mode — there is no broker and
  no LWT. With a real broker the retained status resolves it on reconnect.

## `online` is derived, not just stored

The stored flag is set by a node's retained status and cleared by its last will. That is not
enough on its own: **a node that vanishes while the controller is down is never corrected**,
because nobody is connected to receive the will. Observed with three nodes still reported online
28 hours after they were last heard from.

So the flag is ANDed with evidence of life — `isNodeOnline` in
[../../apps/server/src/app/nodes/node-registry.ts](../../apps/server/src/app/nodes/node-registry.ts):

```
online = stored.online AND max(lastSeenAt, latestReadingAt) is within 5 minutes
```

Two things about it are easy to get wrong:

- **`lastSeenAt` alone will not do.** It only advances on an ONLINE transition, so for a node that
  has been connected all day it is the time it _connected_, not the time it was last heard. An age
  check on it alone marks a perfectly healthy node offline. A reading is the per-sample evidence,
  and unlike an in-memory timestamp it survives a restart.
- **It only ever narrows.** A node the registry already believes offline stays offline. Stale is
  not online.

`NodesService.counts()` applies the same rule in SQL, with `EXISTS` over the
`(node_id, created_at)` index rather than a `MAX()` across the table. The two must agree or the
health endpoint contradicts the nodes screen.

The window is 5 minutes: generous next to a 10 s sample interval and a ~45 s broker will, so a
WiFi blip does not flap the dashboard, while a node that genuinely vanished shows as gone within
minutes.

> [!note] Wanted: a retire / decommission flow
> `DELETE /api/nodes/:id` refuses anything that is not `pending`, and disabling does not make a
> node deletable either, so there is no supported way to take a node out of service. The guard
> itself is right — deleting an admitted node would take its devices with it, and one of those
> could be driving a relay.
>
> Agreed as wanted, deliberately deferred (2026-09-10). It is a design question rather than a
> missing endpoint, and the questions to answer first are:
>
> - What happens to the node's **devices**? Deleted, or orphaned and hidden? A device row is what
>   the interlock and the rules engine read.
> - What happens to its **readings**? They are the history behind every average on the node screen,
>   and retention already expires them on its own schedule.
> - Does retiring **drive its pins to their failsafe first**? Retiring a node that is holding a
>   burner on is the case that decides the whole shape.
> - Is it reversible? A node that re-announces after being retired should probably return as
>   `pending` rather than silently resuming.

## When to update this file

- The rule for deriving `online` changes, or its window does

- A status is added, or a transition changes
- `NodeCapabilities` gains a field
- The nodes API gains or loses an endpoint
- The ownership table above changes
