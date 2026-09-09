# MQTT Contract

## What it is

The wire protocol between the server and every node. It is deliberately plain JSON on plain topics
so that a 60-line Python script can speak it and a human can drive it by hand from `mosquitto_pub` —
which is why it is **not** `@nestjs/microservices`, whose envelope and pattern routing would make
both of those impossible.

The contract is code, in [../../libs/domain/src/lib/hardware/mqtt-contract.ts](../../libs/domain/src/lib/hardware/mqtt-contract.ts),
including the QoS and retain flags as a const object — so they cannot drift into folklore.

> [!note] Status
> `MqttHardwareService` is **phase 7, not yet built**. The contract, the topic builders and the
> QoS table already exist and the fake driver is written against the same interface.

## Key files

- [../../libs/domain/src/lib/hardware/mqtt-contract.ts](../../libs/domain/src/lib/hardware/mqtt-contract.ts) — topics, payloads, `mqttQos`, and the safety rules as a header comment
- [../../apps/server/src/app/hardware/hardware.service.ts](../../apps/server/src/app/hardware/hardware.service.ts) — the abstract seam every consumer injects
- [../../apps/server/src/app/hardware/fake-hardware.service.ts](../../apps/server/src/app/hardware/fake-hardware.service.ts) — the simulator that implements it

## The topics

```
tempestas/v1/node/{nodeId}/hello                      node→server  QoS1  retain=false
tempestas/v1/node/{nodeId}/sensor/{sensorId}/sample   node→server  QoS0  retain=false
tempestas/v1/node/{nodeId}/gpio/set                   server→node  QoS1  retain=FALSE ← hazard
tempestas/v1/node/{nodeId}/gpio/sync                  server→node  QoS1  retain=false
tempestas/v1/node/{nodeId}/gpio/state/{pin}           node→server  QoS1  retain=true
tempestas/v1/node/{nodeId}/gpio/result                node→server  QoS1  retain=false
tempestas/v1/node/{nodeId}/control/heartbeat          server→node  QoS0  retain=false
tempestas/v1/node/{nodeId}/alarm                      node→server  QoS1  retain=false
tempestas/v1/node/{nodeId}/status                     node LWT     QoS1  retain=true
tempestas/v1/server/status                            server LWT   QoS1  retain=true
```

`{nodeId}` is the node's **slug**, which is also its broker ACL subject. The server subscribes to
`tempestas/v1/node/+/#` to catch every node at once.

## The four rules in the contract file

These are in the header comment of `mqtt-contract.ts` because they are protocol requirements, not
implementation preferences. Full reasoning in [Safety](../Safety.md).

1. **Commands are never retained.** A retained `gpio/set` replays a burner-on command on every
   reconnect. Guarded three ways: the node drops retained commands and alarms
   `RETAINED_COMMAND_DROPPED`; every command carries `expiresAt`; both ends use `cleanStart`.
2. **Stale is not off.** A node's LWT makes its pins `unknown`, not `0`.
3. **The server has an LWT too**, so every node fails safe when the brain dies, not just one.
4. **Levels, not on/off.** The wire carries electrical levels only; the server owns the
   active-high/active-low translation. The single exception is a node's configured **failsafe
   level**, which must live on the node — when the server is gone there is nobody to ask what
   "safe" means.

## Payloads

Every payload extends `MqttEnvelope`:

```ts
interface MqttEnvelope {
  schema: string;   // "name/major" — consumers reject an unknown major loudly
  node: NodeId;
  ts: string;       // ISO-8601 with offset
  seq?: number;
}
```

- **`hello`** — `kind`, `agentVersion`, `capabilities`, `bootId`. The only channel that carries
  capabilities, which is why an unknown slug can register from a `hello` but not from a status
  message. See [Nodes](Nodes.md).
- **`sample`** — per-measurement `{ value, valid, unit, reason? }` plus a `sensorStatus`. A node
  reports `valid: false, value: null` and **never** substitutes a last-known-good value.
- **`gpio/set`** — `id`, `issuedBy`, `expiresAt`, and `lines: [{ pin, level, label? }]`.
- **`gpio/sync`** — the **full desired state**: `controller`, `epoch`, `dryRun`, `intent[]`.
  Re-asserted on connect and on the heartbeat tick. `dryRun` is the shadow-mode mechanism for
  cutover: the node logs intent and actuates nothing.
- **`gpio/state/{pin}`** — `level` and a `known` flag. Retained, so a reconnecting server learns the
  world without commanding it.
- **`gpio/result`** — per-line `requested` / `readback` / `ok`. A `setPin` resolves only on a
  successful readback; the caller must not persist a state change otherwise.
- **`alarm`** — an `AlarmCode` plus severity. Never retained: a retained alarm resurrects a cleared
  fault.

## Level-triggered, not edge-triggered

The node re-asserts the full desired state of every line on a **5 s heartbeat** rather than sending
one-shot toggles, so any missed message self-heals on the next tick. This is what eliminates both
the old system's ~43,000 loopback HTTP POSTs a day *and* its silent DB↔hardware divergence.

Only one controller may hold the heartbeat — `epoch` is how a second controller takes over cleanly.

## Patterns to follow

### ✅ Build a topic from `mqttTopics`, never a template literal

```ts
import { mqttTopics, mqttQos } from '@tempestas/domain';
client.publish(mqttTopics.gpioSet(slug), payload, mqttQos.gpioSet);
```

Passing `mqttQos.gpioSet` rather than `{ qos: 1, retain: false }` is what keeps the retain flag from
being retyped wrongly at a call site.

### ❌ Don't import `mqtt` outside `app/hardware/`

The whole application is buildable and testable without a broker because of that one rule.

### ❌ Don't add a field without bumping `schema`

Consumers reject an unknown major loudly. A silently-extended payload is how a Python agent and a
TypeScript server end up disagreeing at 2 a.m.

## Verifying it by hand

The highest-value single check in the plan (phase 7):

```bash
mosquitto_sub -v -t 'tempestas/v1/node/+/#'          # watch the whole bus

# toggle a device in the API, confirm a NON-retained gpio/set appears
# hand-publish a sample, watch it persist → evaluate → push over the socket

mosquitto_pub -r -t 'tempestas/v1/node/elantris/gpio/set' -m '{...}'   # MUST be dropped + alarmed
```

## Pitfalls

- **`hello` is not retained.** A late subscriber never sees it, so the server cannot assume it has
  met every node — nodes re-announce, and the fake driver deliberately reproduces this by announcing
  from `onApplicationBootstrap` rather than at construction.
- **A retained `status` for an unknown slug arrives before that node's `hello`.** Ignore it; do not
  half-create a node from it.
- **Per-node credentials and ACLs are not optional.** Any MQTT client can otherwise publish as any
  node, and an MQTT write goes straight to a GPIO pin and a propane burner. Restrict each node to
  `tempestas/v1/node/{its own slug}/#`.
- **QoS 0 for the heartbeat is deliberate.** A missed heartbeat must *look* missed, not be
  redelivered late.

## When to update this file

- A topic, payload field or QoS/retain flag changes (change `mqtt-contract.ts` first — this doc
  describes it, not the other way round)
- A new alarm code is added
- The contract major version moves
