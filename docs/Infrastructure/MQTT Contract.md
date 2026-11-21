# MQTT Contract

## What it is

The wire protocol between the server and every node. It is deliberately plain JSON on plain topics
so that a 60-line Python script can speak it and a human can drive it by hand from `mosquitto_pub` —
which is why it is **not** `@nestjs/microservices`, whose envelope and pattern routing would make
both of those impossible.

The contract is code, in [../../libs/domain/src/lib/hardware/mqtt-contract.ts](../../libs/domain/src/lib/hardware/mqtt-contract.ts),
including the QoS and retain flags as a const object — so they cannot drift into folklore.

> [!note] Status
> Built, phase 7. [`MqttHardwareService`](../../apps/server/src/app/hardware/mqtt-hardware.service.ts)
> is the driver; everything decidable without a socket is in
> [`mqtt-codec.ts`](../../apps/server/src/app/hardware/mqtt-codec.ts) as pure functions. Verified
> end to end against a real Mosquitto with [`tools/virtual-node.cjs`](../../tools/virtual-node.cjs).

## Key files

- [../../libs/domain/src/lib/hardware/mqtt-contract.ts](../../libs/domain/src/lib/hardware/mqtt-contract.ts) — topics, payloads and `mqttQos`
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

## The four rules of the contract

These are protocol requirements, not implementation preferences, and every change to
`mqtt-contract.ts` must keep them. Full reasoning in [Safety](../Safety.md).

1. **Commands are never retained** — and the retain flag alone does **not** enforce it. See
   [the retained-command trap](#the-retained-command-trap) below, which is the most important thing
   on this page.
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
  schema: string; // "name/major" — consumers reject an unknown major loudly
  node: NodeId;
  ts: string; // ISO-8601 with offset
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

## The retained-command trap

⚠ **Found by testing phase 7 against a real broker, not by reading the spec.** A retained
`gpio/set` was published while the server and the node were both already connected. Both received
it with **`retain=0`**, the node obeyed it, and it stayed retained on the broker to replay on every
future reconnect.

The cause is in the MQTT specification: a delivered PUBLISH carries the retain flag **only when it
is delivered because of a new subscription**. Published to an existing subscriber it is
indistinguishable from a legitimate command. So "drop anything with the retain flag" catches the
replay-on-reconnect case and nothing else.

What actually defends the burner, in order of strength:

| Layer                                                       | Stops                      | Status                              |
| ----------------------------------------------------------- | -------------------------- | ----------------------------------- |
| Broker ACL — only the server may publish commands           | delivery at all            | **phase 12**                        |
| Ownership check — `issuedBy` must be the current controller | obeying a foreign command  | node: **phase 8**; server: **done** |
| `expiresAt` on every command                                | a late or replayed command | done                                |
| `cleanStart` on both ends                                   | a queued session replaying | done                                |
| Retain-flag drop                                            | replay on reconnect        | done                                |

The server now treats **any** command it did not issue as `CONTROLLER_CONFLICT`, whatever the retain
flag says, logs it at ERROR, and **clears the retained slot** by publishing a zero-length retained
payload. It cannot stop the delivery — that is the ACL's job — but it stops the message lurking.

## Required agent behaviour

A node is not free to interpret this contract loosely. These are obligations, and the virtual node
in `tools/` implements all of them as a reference:

- **Refuse a command whose `issuedBy` is not the controller you are bound to**, and alarm
  `CONTROLLER_CONFLICT`. This is the layer that stops a foreign command being obeyed.
- **Drop any inbound command carrying the retain flag** and alarm `RETAINED_COMMAND_DROPPED`.
- **Refuse a command past its `expiresAt`** and alarm `COMMAND_EXPIRED`.
- **Ignore an empty command payload.** A zero-length payload is how a retained command is cleared;
  parsing it throws, and reacting to it creates a publish loop.
- **Publish `status: offline` (retained) before a clean shutdown.** MQTT **suppresses the will on a
  graceful DISCONNECT**, so the LWT covers a crash or a network drop but _not_ an orderly stop. A
  node that exits cleanly without doing this is left looking online forever. (Also verified the hard
  way: a `client.end()` in testing fired no will at all.)
- **Enforce your own dead-man locally**, counting server heartbeats. It has to work when the brain
  is gone entirely.

## Level-triggered, not edge-triggered

The node re-asserts the full desired state of every line on a **5 s heartbeat** rather than sending
one-shot toggles, so any missed message self-heals on the next tick. This is what eliminates both
the old system's ~43,000 loopback HTTP POSTs a day _and_ its silent DB↔hardware divergence.

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
- **QoS 0 for the heartbeat is deliberate.** A missed heartbeat must _look_ missed, not be
  redelivered late.

## Broker credentials and ACLs

The broker refuses anonymous clients and scopes every credential to its own topics. The files are
[../../apps/broker/mosquitto/tempestas.conf](../../apps/broker/mosquitto/tempestas.conf) and
[../../apps/broker/mosquitto/tempestas.acl](../../apps/broker/mosquitto/tempestas.acl); the
reasoning and the identity table are in
[Safety](../Safety.md#authentication-is-an-interlock-not-security).

What this means for anything speaking the contract:

- **A node may not publish another node's topics**, so `node` in a payload can be trusted to match
  the topic it arrived on. That is an ACL guarantee, not a parsing one.
- **A node may not publish `gpio/set` at all**, including to itself. The `issuedBy` ownership check
  still runs, because the ACL is one broker's configuration and the check is the contract.
- **Only `tempestas-server` may publish `server/status`**, so a node watching the server's LWT
  cannot be tricked into failing safe by another node.
- **Read and write are separate grants.** A credential that publishes samples cannot subscribe to
  them - which is why a logger needs its own read-only identity rather than borrowing a node's.

> [!warning] Verifying an ACL
> A publish denied by an ACL is **silent at QoS 0** - no error, no disconnect, indistinguishable
> from success. Test with `mosquitto_pub -q 1 -V 5 -d` and read the `PUBACK` reason code: `RC:0` or
> `RC:16` is accepted, `RC:135` is Not authorized.

Reload after an ACL edit with `sudo systemctl reload mosquitto`; a restart is not needed.

## When to update this file

- A topic, payload field or QoS/retain flag changes (change `mqtt-contract.ts` first — this doc
  describes it, not the other way round)
- An MQTT identity is added, or an ACL grant changes
- A new alarm code is added
- The contract major version moves
