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
tempestas/v1/node/{nodeId}/update                     server→node  QoS1  retain=FALSE ← hazard (1.1)
tempestas/v1/node/{nodeId}/update/status              node→server  QoS1  retain=false  (1.1)
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
3. **The server has an LWT too**, so every node knows when the brain dies. Nodes log it and hold:
   a deploy restarts the server, and the dead-man fails them safe if it does not come back.
4. **Levels, not on/off.** The wire carries electrical levels only; the server owns the
   active-high/active-low translation. The single exception is a node's configured **failsafe
   level**, which must live on the node — when the server is gone there is nobody to ask what
   "safe" means.

## Versions

The contract is versioned `major.minor`, declared once as `MQTT_CONTRACT_MAJOR` and
`MQTT_CONTRACT_MINOR` in `mqtt-contract.ts` and mirrored by both agents' `contract.py`; the
contract-match tests fail if they drift.

| Bump      | Means                                          | A node on a different one                   |
| --------- | ---------------------------------------------- | ------------------------------------------- |
| **Major** | Something removed, renamed or reshaped         | Refused, as `contractVersion` always was    |
| **Minor** | Additions only: an optional field, a new topic | Works; the newer side's additions go unused |
| **Patch** | A fix inside one agent, no contract change     | Works                                       |

**A minor bump never makes a field required.** The side that receives an addition must behave
sensibly without it, because a node on the previous minor will not send it. That is the whole
promise of a minor; break it and the bump was a major.

Each agent reports `agentName` (`agent-linux`, `agent-micropython`) and an `agentVersion` of
`<major>.<minor>.<patch>`, and declares `contractMinor` in its capabilities. The Nodes page shows a
node whose minor differs from the server's as behind or ahead; it does not degrade health.

An agent's minor says what it accepts, not what its mirror knows. It raises its minor only once it
handles that minor's commands, so it may sit behind `MQTT_CONTRACT_MINOR` but never ahead, and the
contract-match tests allow exactly that. A node on minor 1 or later takes `update`.

The patch counts that agent's commits since the contract version last changed, so every change to
an agent raises it, in order, without bumping it by hand. That only holds for released code, so
anything else is marked: [tools/describe-agent-version.sh](../../tools/describe-agent-version.sh)
builds the version, and the deploy scripts stamp it.

| Deployed from            | Reports                   |
| ------------------------ | ------------------------- |
| `origin/main`, clean     | `1.0.4`                   |
| Any other commit         | `1.0.4-dev+ecdbbe7`       |
| With uncommitted changes | `1.0.4-dev+ecdbbe7.dirty` |

A `-dev` version is never released code, and its commit is how to find what is on the node.

An agent older than contract 1.0 sends neither field: it shows the bare version, and an absent
`contractMinor` reads as 0.

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

- **`hello`** — `kind`, `agentName`, `agentVersion`, `capabilities`, `bootId`. The only channel that carries
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
- **`update`** (1.1) — `id`, `issuedBy`, `expiresAt`, `app`, `version`, `manifestUrl`,
  `manifestSha256`. Tells a node to install a version of its own agent. See
  [the update command](#the-update-command).
- **`update/status`** (1.1) — the command's `id`, a `state` and an optional `reason`. Not retained:
  the server keeps the history, and a retained `healthy` would describe an update long gone.

## The update command

Added in contract 1.1, so a 1.0 node never subscribes to it and simply never answers. It can replace
the code on a node that drives a burner relay, so it is a command in every sense `gpio/set` is: the
server is its only legitimate publisher, it expires, and it is never retained.

```ts
interface UpdateCommandPayload extends MqttEnvelope {
  id: string;
  issuedBy: string;
  expiresAt: string;
  app: AgentApp; // 'agent-linux' | 'agent-micropython'
  version: string; // <contract major>.<contract minor>.<patch>
  manifestUrl: string; // http(s)
  manifestSha256: string; // 64 lowercase hex digits
}
```

A node judges it in the same order as `gpio/set`, and answers a refusal in one of three ways.
[`judgeUpdateCommand`](../../libs/domain/src/lib/hardware/update-command.ts) is the reference, and
each agent's own judge must agree with its spec.

| Refusal                                        | Answer                                  |
| ---------------------------------------------- | --------------------------------------- |
| empty payload (a retained clear)               | logged only                             |
| retain flag set                                | alarm `RETAINED_COMMAND_DROPPED`        |
| not JSON, or an unknown schema major           | logged only                             |
| no controller bound yet                        | logged only                             |
| `issuedBy` ≠ bound controller                  | alarm `CONTROLLER_CONFLICT`             |
| clock not set yet (the Pico, before NTP)       | logged only                             |
| past `expiresAt`                               | alarm `COMMAND_EXPIRED`                 |
| missing or unparseable `expiresAt`, or no `id` | logged only                             |
| `app` is not the agent this node runs          | `update/status` `failed`, with a reason |
| `version` is for another contract major        | `update/status` `failed`, with a reason |
| a non-http(s) `manifestUrl`, a malformed hash  | `update/status` `failed`, with a reason |

These are the `gpio/set` rules with one difference: a node with no bound controller yet takes
`gpio/set` from any issuer, but refuses every `update`. Replacing code can wait the few seconds until
the first heartbeat binds the node, and in that window the broker ACL would otherwise be the only
guard. The unset-clock row is the Pico's own guard, checked before expiry: the reference judge
always has a time, so it has no such case. The last three come from the server, which needs to
hear why its update went nowhere. A node never crosses a contract major on its own: that needs
the server to move first.

Integrity rests on two hashes: `manifestSha256` arrives in a command only the server can publish,
and the manifest it pins carries a sha256 for every file. The bundles are not signed. How the server
builds and serves them is in [Deploys](Deploys.md#agent-release-bundles).

Once accepted, the node reports its progress on `update/status`, keyed by the command's `id`:

```
downloading → verifying → installing → restarting → healthy
                                                  ↘ rolled-back
                       any step                   → failed
```

`rolled-back` means the new version was installed and did not come up healthy, so the previous one
is running again. `failed` means it never got that far and nothing changed. Both carry a `reason`.

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
- **Apply all three to `update` as well** (1.1), refuse every update until a controller is bound,
  and refuse an update for another `app` or another contract major with an `update/status` of
  `failed`.
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

### ❌ Don't change a field without bumping the version

An optional addition is a contract minor. Removing, renaming or reshaping a field, or making one
required, is a major, and bumps the payload's `schema` with it: consumers reject an unknown major
loudly. A silently-changed payload is how a Python agent and a TypeScript server end up disagreeing
at 2 a.m.

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
  met every node — nodes re-announce on their own connect and whenever `server/status` turns
  `online` (a live publish, not the retained replay), and the fake driver deliberately reproduces
  this by announcing from `onApplicationBootstrap` rather than at construction.
  The server announces `online` only after the broker acknowledges its subscribe to
  `tempestas/v1/node/#`, so those answering hellos cannot reach the broker ahead of it.
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
- **A node may not publish `gpio/set` or `update` at all**, including to itself. The `issuedBy`
  ownership check still runs, because the ACL is one broker's configuration and the check is the
  contract.
- **Only `tempestas-server` may publish `update`**, and a node may publish only its own
  `update/status`.
- **Only `tempestas-server` may publish `server/status`**, so another node cannot fake the server's
  LWT.
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
