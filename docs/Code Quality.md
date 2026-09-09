# Code Quality

## What it is

tempestas's quality bar: TypeScript strict everywhere, Nx-enforced module boundaries, a shared
contract library that the Angular app, the NestJS API and (via generated schemas) the Python agents
all agree on, Vitest for tests, Prettier for formatting.

The aim is that a session opening this repo cold can tell where a thing belongs, and that the
invariants which keep a burner safe are visible in the code rather than remembered.

## Key files

- [../tsconfig.base.json](../tsconfig.base.json) — strict, and the `@tempestas/domain` path alias
- [../eslint.config.mjs](../eslint.config.mjs) — `@nx/enforce-module-boundaries`, including the banned imports inside `libs/domain`
- [../.prettierrc](../.prettierrc) — single quotes, 2-space tabs
- [../.nvmrc](../.nvmrc) / `engines` in [../package.json](../package.json) — Node 22, kept in step
- [../libs/domain/src/index.ts](../libs/domain/src/index.ts) — the invariant that governs the whole library, stated at the top of it

## How it works

### Final-step commands (always run before declaring work done)

```bash
npx nx run-many -t lint,test,build     # the gate
npx nx test server --coverage          # the thresholds are only checked here
npx prettier --write .                 # format
```

**`test` alone is not enough.** Vitest transpiles without typechecking, so a type error passes a
green test run and only fails in the webpack/Angular builds. Phase 4.5 shipped two of them —
`Object.hasOwn` against a `lib: es2020` target, and a union that needed `=== false` to narrow —
both invisible until `build` ran.

### TypeScript

- `strict: true` from commit one. Every old Angular component assumed loose nulls; all of them are
  being rewritten, so enabling strict up front was free. Retrofitting it later never happens.
- **Explicit return types on every exported function and method.** Including `: void`, `: Promise<void>`
  and the DTO type on a service method — an inferred return type is where an accidental `any` or a
  widened union enters a contract.
- `target: es2015` / `lib: ["es2020", "dom"]` at the base; `apps/server` raises `target` to es2021.
  Anything newer than es2020 in the standard library (`Object.hasOwn`, `Array.prototype.at`) will
  compile under Vitest and fail the build.
- Path alias `@tempestas/domain` → `libs/domain/src/index.ts`. Populated `paths`, not project
  references — the Nx 22 TS-solution setup was deliberately declined.

### Runtime and frameworks

- Node 22 (`.nvmrc`, and `engines` pins `>=22 <23`). CI must match.
- NestJS 11 for the API, TypeORM 0.3, Postgres 17. `synchronize: false`, always.
- Angular 20, **standalone components**, Angular Material M3, no SSR. A LAN-only dashboard gains
  nothing from SSR and pays memory on a 4 GB Pi.
- Luxon for time, server-side only, with an explicit IANA zone from `TEMPESTAS_TZ`.

## Patterns to follow

### The shared contract

#### ✅ Anything crossing a process boundary is typed in `@tempestas/domain`

```ts
import { ApiErrorCode, NodeStatus, type Device, type Node } from '@tempestas/domain';
```

#### ✅ A NestJS DTO class lives in the server and `implements` the shared interface

```ts
// apps/server/src/app/nodes/dto/admit-node.dto.ts
export class AdmitNodeDto implements AdmitNodePayload {
  @IsOptional() @IsUUID() zoneId?: string;
  @IsOptional() @IsString() displayName?: string;
}
```

That keeps `class-validator` and `reflect-metadata` out of the browser bundle while still failing
compilation if the two sides disagree.

#### ❌ Don't put a decorator, or a framework import, in `libs/domain`

```ts
// libs/domain/src/lib/nodes/admit.dto.ts
import { IsUUID } from 'class-validator'; // ❌ eslint: bannedExternalImports
export class AdmitNodeDto {
  @IsUUID() zoneId?: string;
}
```

#### ❌ Don't hand-duplicate a type across the two apps

The reference monorepo ships `paths: {}` and duplicates every DTO. That is the mistake this alias
exists to prevent.

### Wire types

#### ✅ Timestamps cross the wire as ISO-8601 `string`, never `Date`

```ts
export interface Reading {
  createdAt: string; // ISO-8601, server-stamped on receipt
}
```

The old API emitted `created_at` as the naive string `"%m/%d/%Y, %H:%M:%S"`, which forced three
separate `new Date(`${x} UTC`)` hacks in the Angular client. Typing these as `string` makes that
hack unwriteable.

#### ✅ Electrical levels, not on/off

```ts
export type GpioLevel = 0 | 1;
onLevel: GpioLevel; // per-device: four relays are active-LOW, one active-HIGH
```

The old `on_state` arrived over the wire as bool, string or int depending on the code path.

### Errors

#### ✅ A real HTTP status with a machine-readable code

```ts
throw new ConflictException({
  code: ApiErrorCode.DeviceCooldown,
  message: `${device.name} is within its minimum-off time`,
  details: { canTurnOnAt: canTurnOnAt(device)?.toISOString() ?? null },
});
```

`details` is where the client gets what it needs to render a useful state instead of a toast.

#### ❌ Don't return an error inside a 200

```ts
return { error: 'device is already on' }; // ❌
```

The old API did this everywhere, with no interceptor and no `catchError` anywhere in the client —
four near-identical `if (res.error)` blocks instead.

#### ❌ Don't throw a bare `Error` from a request path

It becomes a 500 with no `code`, and the Angular interceptor has nothing to branch on.

### Pure logic

#### ✅ Decisions live in their own file, with time as a parameter

```ts
// device-state.ts
export function canTurnOn(device: DeviceLike, now: Date): boolean { ... }

// node-registry.ts
export function acceptsCommands(status: NodeStatus): boolean { ... }
```

#### ❌ No `new Date()` in `rules/` or `device-state.ts`

Time enters as an argument. That is what makes the DST tests possible, and DST correctness is one of
the reasons for the port. See [Testing](Testing.md) and [Rules and Climate](Rules%20and%20Climate.md).

### Naming

- `camelCase` variables and functions, `PascalCase` types/classes/enums, `SCREAMING_SNAKE_CASE`
  for module constants (`DISCARD_LOG_INTERVAL_MS`, `BURNER_PIN`).
- Files: `kebab-case.ts`; the entity file in every feature folder is `models.ts`; pure modules are
  named for what they decide (`device-state.ts`, `node-registry.ts`).
- DB columns are `snake_case` in SQL and `camelCase` in the entity: `@Column({ name: 'on_delay_duration' })`.
- **Name variables for what they hold.** `(first, second)` or `(rule, other)` over `(a, b)`; the one
  concession is a tight local map/filter over a well-named collection.
- A node's `slug` is its MQTT topic segment and its broker ACL subject. On the wire and in DTOs,
  `nodeId` means the **slug**; in an entity, `nodeId` means the **uuid FK**. This bit once — a
  hardware call addressed to a uuid — so translate explicitly at the service boundary.

### Logging

Use the injected Nest `Logger`, never `console.log`. Log level carries meaning here:

- **`warn`** — a human needs to do something (a node is pending, readings are being discarded, a
  node went offline and its pins are now unknown).
- **`log`** — a state change worth a line (a device driven, a node rebooted, ownership changed).
- **`debug`** — the repetitive truth (a node re-announced unchanged, a duplicate sample ignored).

**Log on change, not per evaluation.** At 8,640 evaluations a day, INFO-per-evaluation buries
everything and fills the SD card. Where a repeating event must be visible, log the first and then
a rate-limited summary carrying a count — see `ReadingsIngestService.noteDiscard`.

### Comments

Comments here carry **safety and hardware rationale**, and that is a deliberate departure from the
house style in other Sign In Solutions repos, where the default is no comment at all. One
maintainer, combustion hardware, and long gaps between sessions change the calculus: a future
session re-deriving "why is this command not retained?" from scratch is the failure being prevented.

#### ✅ Comment the invariant and what breaks without it

```ts
// Publish FIRST and await the acknowledgement, persist only on success. The old
// system did the reverse: a failed GPIO write was logged and the row updated
// anyway, so the UI confidently showed a heater as running when it was not.
```

#### ✅ Comment the physical or protocol fact behind a constant

```ts
/** Four of the five relays are active-LOW, so 0 means energised. */
const ON_LEVEL_ACTIVE_LOW = 0;
```

#### ❌ Don't restate the code

```ts
// find the node by its slug
const node = await this.nodes.findOne({ where: { slug } }); // ❌
```

#### ❌ Don't reference tickets, phases-in-flight, or "as discussed"

```ts
// [phase 4.5] added the admission gate here                  // ❌
```

The docs and the commit history are the time capsule; a comment reads as current understanding.
Naming a _future_ phase for work this file will need is fine (`MqttHardwareService lands in phase 7`)
— naming the phase that produced the current line is not.

#### ❌ Don't speculate about future problems

```ts
// if this becomes slow we may need to cache the node lookup                // ❌
```

If it becomes real, fix it then, in its own commit with its own context.

#### ❌ Don't let a comment explain a block that should be simplified

If it takes a paragraph to say _what_ the code does, extract a named function. A paragraph on _why
it must be this way_ is fine and often required.

## Pitfalls

- **`npx nx run-many -t lint,test,build` is non-negotiable.** See above — `test` cannot see a type error.
- **`libs/domain` bans `rxjs`.** An observable in the shared contract would drag a framework into
  the Python-facing types. Streams are a server concern.
- **Postgres reorders `jsonb` keys.** Never compare a jsonb column with `JSON.stringify`; compare
  key sets. `node-registry.ts` has a `deepEquals` for exactly this.
- **`pg` parses `timestamp without time zone` as local time.** Every timestamp column is
  `timestamptz`. A migration that forgets it should fail loudly.
- **Coverage thresholds apply to `app/devices` and `app/rules` only**, by an `include` list in
  `apps/server/vitest.config.ts`, with modules/controllers/DTOs/entities excluded. They are checked
  only under `--coverage`, so that belongs in the gate. See [Testing](Testing.md).
- **Nx caches `lint` and `test`.** A "passing" run that printed nothing may be a cache hit; that is
  fine, but if you are chasing a flake, `--skip-nx-cache`.
- **Don't add a dependency for one helper.** The dependency list is deliberately short; every
  package is one more thing to build on an arm64 box.
- **`ngx-gauge`, `RPi.GPIO`, `rpi-lgpio` and `gpiozero` are banned by name.** The first targets
  Angular 15/16 and fights Angular 20 peer deps; the other three fight our lgpio handle for the
  same lines. See [Safety](Safety.md).

## When to update this file

- A compiler flag, lint rule or `depConstraints` entry changes
- Prettier config changes
- A new convention becomes worth enforcing repo-wide (a new error class, a new logging pattern)
- The comment policy is revisited
