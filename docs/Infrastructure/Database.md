# Database

## What it is

Postgres 17 with TypeORM 0.3. Entities live beside the feature that owns them as
`app/<feature>/models.ts`; services own the queries. `synchronize` is **never** true — every schema
change goes through a reviewed migration.

Local development runs Postgres in Docker on port **5433**. Production on the Pi runs Postgres
**natively from apt** — see the pitfalls, this one has already cost 386 MB of history once.

## Key files

- [../../apps/server/src/app/zones/models.ts](../../apps/server/src/app/zones/models.ts)
- [../../apps/server/src/app/nodes/models.ts](../../apps/server/src/app/nodes/models.ts)
- [../../apps/server/src/app/devices/models.ts](../../apps/server/src/app/devices/models.ts)
- [../../apps/server/src/app/readings/models.ts](../../apps/server/src/app/readings/models.ts)
- [../../apps/server/src/app/app.module.ts](../../apps/server/src/app/app.module.ts) — the explicit entity list
- [../../apps/server/src/typeorm.config.ts](../../apps/server/src/typeorm.config.ts) — the standalone DataSource for the CLI

## The schema

```
zones ──┬── nodes ──┬── devices          UNIQUE (node_id, gpio)
        │           └── sensor_readings  UNIQUE (node_id, sensor_id, boot_id, node_seq)
        └── devices (zone_id)
```

FK creation order is `zones → nodes → devices → sensor_readings`.

### `zones`

The airspace, and the owner of `rules_config` (jsonb): thresholds, `enabledRoles`, and the per-role
`sensorPolicy`. Operational policy that controls a heater lives server-side as data, never as consts
in the browser bundle where a stale cache could disagree about a setpoint.

### `nodes`

A wiring and transport identity. `slug` is unique and **immutable after admission** — it is the MQTT
topic segment and the broker ACL subject, so renaming it would orphan the node's whole topic
subtree. `display_name` is the editable one.

`capabilities` (jsonb) is what makes a node data rather than code: the pins it exposes, the sensors
it carries, whether it has an RTC. Nothing in the server may branch on `kind`.

`status` (`pending | admitted | disabled`) is the admission gate — see [Nodes](Nodes.md).
`online` and `last_seen_at` are driven by the retained LWT and persisted so the list view is one
query. `boot_id` changes on every restart of a node's agent, persisted so a bounce is detectable
across a restart of the _server_ too.

### `devices`

A relay-controlled thing. **Note what is not here: there is no `is_on` column.** On/off is derived
from `on_at > off_at`, and the anti-short-cycle interlock from `off_at + on_delay_duration`. See
`device-state.ts`.

- `UNIQUE (node_id, gpio)`, deliberately **not** unique on `gpio` alone — pin 17 on a Pi and pin 17
  on an ESP32 are different pins.
- `INDEX (zone_id, role)` because rules look devices up by `(zone, role)`.
- **No unique constraint on `role`.** Roles repeat, and all devices sharing one get the same
  decision, each still filtered by its own `rules_enabled`.
- `on_level` is a per-device column, not a constant: four relays are active-LOW, one active-HIGH.

### `sensor_readings`

- `INDEX (created_at)` and `INDEX (node_id, created_at)`. The old schema had **no index on
  `created_at`** across 2.87M rows while every query ordered or filtered on it.
- `UNIQUE (node_id, sensor_id, boot_id, node_seq)` with `ON CONFLICT DO NOTHING` on insert, to
  absorb MQTT QoS-1 duplicates. A duplicate sample would mean a duplicate rules evaluation.
  **Scoped to the boot, not just the node:** a node's sequence counter restarts at 1 when its agent
  does, so a `(node, sensor, seq)` key silently swallowed every sample after a reboot until the
  counter passed its previous high-water mark. The symptom was indistinguishable from a stale
  sensor. `boot_id` is copied from `nodes.boot_id` at ingest and is also useful provenance — it says
  which run of which agent produced the row.
- `created_at` is **server-stamped on receipt** and is the authoritative time axis. `node_ts` is the
  node's own clock, diagnostic only — an ESP32 has no RTC.
- `co2` is nullable, and null means **unknown, never zero**.

## Patterns to follow

### ✅ The service owns the query; the entity file owns the shape

```ts
constructor(
  @InjectRepository(NodeEntity) private readonly nodes: Repository<NodeEntity>,
) {}
```

There is no repository layer between the two — with this few entities it would be ceremony. The
boundary that matters is that nothing outside a service touches a repository.

### ✅ Register a new entity in both places

`app.module.ts`'s `entities: [...]` **and** the feature module's `TypeOrmModule.forFeature([...])`.
The list is explicit, not a glob: a webpack bundle has no directory to scan.

### ✅ Translate slug ↔ uuid explicitly at the service boundary

```ts
// `nodeId` on the wire is the node SLUG; the FK is the node's uuid.
const node = await this.nodes.findOne({ where: { slug: dto.nodeId } });
row.nodeId = node.id;
```

This bit once — hardware calls addressed to a uuid instead of a topic segment.

### ✅ Aggregate once for a list view

```ts
const counts = await this.devices.createQueryBuilder('d').select('d.nodeId', 'nodeId').addSelect('COUNT(*)', 'count').where('d.nodeId IN (:...ids)', { ids }).groupBy('d.nodeId').getRawMany();
```

`deviceCount` and `latestReadingAt` on the nodes list are two grouped aggregates, so the endpoint
stays three round-trips regardless of node count — not one query per node.

### ✅ Absorb a duplicate in the database, not with a read

```ts
await this.readings.createQueryBuilder().insert().values({ ... }).orIgnore().execute();
```

A `SELECT` then `INSERT` has a race. `orIgnore()` emits `ON CONFLICT DO NOTHING`; an empty
`result.raw` means the row already existed.

### ❌ Don't add a derived column

```ts
@Column({ type: 'boolean' }) isOn!: boolean;   // ❌
```

`isOn` is `on_at > off_at`. A stored flag is a second source of truth that will disagree with the
hardware exactly when it matters.

### ❌ Don't use `timestamp without time zone`

`pg` parses it as **local** time. Every timestamp column is `timestamptz`.

## Pitfalls

- **Mount the Postgres volume at `/var/lib/postgresql/data`.** The reference stack's compose file
  mounts `.dbdata:/var/lib/postgres` — a path Postgres ignores — which is how 386 MB of greenhouse
  history ended up living only in a container layer where it was nearly lost. On the Pi, Postgres
  is native apt for exactly this reason: one canonical data directory, no path to typo.
- **`docker exec` without `-i` does not forward stdin.** A heredoc of SQL silently never arrives and
  the command looks like it succeeded.
- **`node_seq` is a `bigint`**, which TypeORM represents as a **string** in TS. Insert
  `String(seq)`, not the number.
- **A NULL `node_seq` or `boot_id` defeats the dedupe** — NULLs are distinct in a unique index. That
  is why the MQTT contract asks every node for a `seq`, and why the registry records a `boot_id`
  from the first `hello`.
- **Deleting a node cascades its readings away.** `sensor_readings.node_id` is `ON DELETE CASCADE`,
  which is why only a `pending` node may be deleted; `disable` is the operation that means "stop
  trusting this" and keeps the data.
- **Devices are `ON DELETE RESTRICT` against their node**, so a node with devices cannot be deleted
  out from under them.
- **Retention has to be batched.** An unbounded `DELETE` of millions of rows locks an SD card for
  minutes. The old system had the retention command written but never scheduled.
- **Range-partition `sensor_readings` by month from day one** (planned, phase 6). Retrofitting
  partitioning onto 3M rows later is painful.

## When to update this file

- An entity, index or constraint is added or changed
- A schema decision is made that the DDL alone doesn't explain
- The local database's port or container name changes
