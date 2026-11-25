# Architecture

## What it is

A multi-node greenhouse controller. One box (`elantris`) is both the first node and the brain: it
runs Postgres, the NestJS API, the Angular app, the Mosquitto broker and a Python agent driving its
own sensor and relays. Every other node — another Pi, an ESP32 — is a thin agent that speaks the
same MQTT contract and owns nothing but its own hardware.

The shape that matters: **adding or removing a node must not require a code change.**

## Key files

- [../apps/server/src/app/app.module.ts](../apps/server/src/app/app.module.ts) — module wiring, TypeORM config, throttler
- [../apps/server/src/app/hardware/hardware.service.ts](../apps/server/src/app/hardware/hardware.service.ts) — the single seam to physical hardware
- [../apps/server/src/app/hardware/hardware.module.ts](../apps/server/src/app/hardware/hardware.module.ts) — the `HARDWARE_DRIVER=fake|mqtt` switch
- [../libs/domain/src/index.ts](../libs/domain/src/index.ts) — the shared contract, and the invariant comment at the top of it
- [../eslint.config.mjs](../eslint.config.mjs) — the module boundaries that enforce all of the above

## How it works

### Zones, nodes, devices

```
Zone "greenhouse"  ── rules_config: a rule per role, enabledRoles, sensorPolicy, daylight
   ├── Node "elantris"        rpi     · SCD-4x + relays · CO2 generator
   ├── Node "greenhouse-pi5"  rpi     · lights + fans (legacy, for now)
   └── Node "north-end"       esp32   · sensor only
```

**Rules scope to the zone, not the node.** A node is a _wiring and transport_ identity: which box
owns this pin, which box holds this sensor. A rule operates on an _airspace_ — one greenhouse, one
temperature, one CO2 concentration, with sensors at each end and relays wherever the wiring landed.
Scoping rules to nodes would mean the node holding the burner cannot see the thermometer at the
other end.

Consequences you will meet in the schema:

- `Device` has both `node_id` and `zone_id`. `UNIQUE (node_id, gpio)` — pin 17 on a Pi and pin 17 on
  an ESP32 are different pins.
- `SensorReading` has `node_id` and `sensor_id`, and `created_at` is **server-stamped on receipt**.
  An ESP32 has no RTC, so a node's own clock is diagnostic data, never the time axis.
- No unique constraint on `role`. Roles repeat ("fans", plural) and every device sharing a
  `(zone, role)` gets the same decision, each still filtered by its own `rulesEnabled`.

### Cross-node rules, without a rule engine

A **sensor policy** in the zone's `rules_config` covers "sensors at each end" as data — a zone
default, overridden on any role's rule:

```jsonc
{
  "enabledRoles": ["co2_generator"],
  "sensorPolicy": { "default": { "source": "mean", "maxAgeMs": 120000 } },
  "rules": {
    "exhaust_fan": { "kind": "thermostat", "mode": "cool", "onAtC": 30, "offAtC": 29.5, "onStale": "hold", "sensor": { "source": "max" } },
    "co2_generator": { "kind": "co2-burner", /* ... */ "sensor": { "source": "node:elantris" } },
  },
}
```

`source` is one of `mean | max | min | node:<slug>`. Four options, not a predicate language.

**There is deliberately no `Rule` entity and no DSL.** Each role names one **kind** from a fixed menu
written in code — `thermostat`, `daylight-thermostat`, `co2-burner` — and supplies its numbers. A new
environment such as the pumphouse is configuration; a new kind of rule is a code change with tests.
A DSL with one user is a liability when a mis-click controls a burner. The tripwire for revisiting is
unchanged: a non-developer needing to author a rule. See [Rules and Climate](Rules%20and%20Climate.md).

### Ownership is explicit, never inferred

`enabledRoles` decides what tempestas controls. It is **not** derived from which device rows exist:

1. An empty device list is ambiguous — "the other Pi owns lights" and "someone deleted the row"
   must not behave identically on a system that runs a heater in winter.
2. Devices get re-entered by hand before cutover. With inference, creating a `lights` row would
   immediately start driving relays the legacy app is also driving. With explicit ownership,
   creating the row is safe and the cutover is one flag.
3. It is auditable and reversible — one field with an update trail, not an emergent property.

Both no-ops (role not owned; role owned but no devices) are first-class, carry distinct `reason`
codes, and are **silent at INFO**. At 8,640 evaluations a day, "lights not owned" logged per
evaluation would bury the one message that matters.

### Layers

```
Angular (apps/web)
    │  HTTP + socket.io, DTOs from @tempestas/domain
NestJS controller           thin: route, validate, delegate
    │
NestJS service              owns the invariants (interlocks, admission, ingest)
    │
pure module                 device-state.ts, node-registry.ts, rules/ — no I/O, no Date
    │
TypeORM repository          entities in app/<feature>/models.ts
    │
Postgres
```

Sideways, at the service layer only:

```
HardwareService (abstract)  ──fake──►  FakeHardwareService   closed-loop simulator
                            ──mqtt──►  MqttHardwareService   Mosquitto → node agents
```

### The hardware seam

`HardwareService` is an abstract class with `setPin`, `syncPins` and `sendUpdate`, and the
observables `samples$`, `availability$`, `hello$`, `pinStates$` and `updateStatuses$`. Every
consumer injects the abstract class. The fake plays an update through in a few seconds and says
hello again on the new version, so the node page can be tried without a node.

- **Nothing outside `app/hardware/` may import `mqtt`.** Not `@nestjs/microservices` either: its
  envelope and pattern routing would make the contract harder for a 60-line Python script to speak
  and impossible to drive by hand from `mosquitto_pub`.
- `HARDWARE_DRIVER=fake` binds the simulator; anything else that is not `mqtt` throws at boot.
  Failing loudly beats silently falling back to a simulator on a box that controls a burner.
- The fake driver is a **closed loop**, not a random number generator: the burner raises temperature
  and CO2, the fan lowers them. So "burner on → CO2 climbs → rule turns it off" is observable with
  no hardware, and the rules engine is genuinely exercised.
- Its constants come from the greenhouse on 2026-09-10 with the real generator, but it is a shape
  model, not a fitted one. The field numbers are internally inconsistent (decay with the burner off
  implies a smaller leak coefficient than the gain near the setpoint does, most likely mixing lag
  between burner and sensor), so the simulator takes the cleanest measurements and claims no more
  precision than that.

### The uniformity invariant

**NestJS never branches on node kind.** It asks only "does this node expose pin N?" and "which
metrics does this sensor publish?" — both answered by `capabilities`. A Pi and an ESP32 differ only
in the contents of that jsonb column. Enforce this in review: a `if (node.kind === ...)` outside a
display concern is a bug.

## Patterns to follow

### ✅ Keep controllers thin

```ts
@Post(':id/admit')
@HttpCode(200)
admit(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AdmitNodeDto): Promise<Node> {
  return this.nodes.admit(id, dto);
}
```

### ❌ Don't put an invariant in a controller

```ts
@Post(':id/on')
async turnOn(@Param('id') id: string) {
  const device = await this.repo.findOne(...);
  if (device.onAt > device.offAt) throw new ConflictException();  // ❌
  await this.mqtt.publish(...);                                   // ❌ two ways to drive a pin
}
```

An interlock enforced in two places is enforced in neither. The rules engine calls the same service
method the HTTP route does — that is why the Python version's rules engine POSTed to its own REST
API over loopback 43,000 times a day, and why this one doesn't have to.

### ✅ Extract decisions into a pure module and test them there

```ts
// node-registry.ts — no repository, no subscription, no clock
export function acceptsSamples(status: NodeStatus): boolean {
  return status === NodeStatus.Admitted;
}
```

### ❌ Don't reach for the repository from a pure module

If a function needs the database to decide, it is a service method. If it needs the current time,
time is a parameter. See [Testing](Testing.md).

### ✅ Cross a process boundary only with a `@tempestas/domain` type

```ts
import type { Device, Node, Reading } from '@tempestas/domain';
```

### ❌ Don't hand-duplicate a DTO

The reference monorepo (`lvcc`) ships `paths: {}` in its `tsconfig.base.json` and hand-duplicates
every DTO between its API and its app. That is the specific mistake this layout exists to prevent.

## Pitfalls

- **`libs/domain` is interfaces, enums and const objects only.** No decorators, no framework
  imports — `@nx/enforce-module-boundaries` bans `@angular/*`, `@nestjs/*`, `typeorm`,
  `class-validator`, `mqtt`, `socket.io` and `rxjs` inside it. NestJS DTO classes live in the
  server and `implements` the shared interface, so class-validator never reaches the browser.
- **Entities are listed explicitly** in `app.module.ts`, not discovered by glob: a webpack bundle
  has no directory to scan. Add a new entity in both `app.module.ts` and its feature module's
  `TypeOrmModule.forFeature`.
- **The API serves the built web bundle itself**, not a reverse proxy: one process on the box, and
  the socket.io upgrade stays inside Nest, so the `map $http_upgrade` mistake in the old
  greenhouse's `nginx.conf` cannot be made. It is registered only when the bundle exists, because a
  static root that does not exist turns every unmatched route into a 500. `/api` and `/socket.io`
  are excluded from the SPA fallback; without that an unknown API path returns `index.html` with a
  200, and a client cannot tell a missing route from a working one.
- **The `ValidationPipe` is global**, with `whitelist` and `forbidNonWhitelisted`, so unknown keys
  are rejected rather than stripped silently. `lvcc` installs class-validator and never wires it
  up, so its DTOs are decorative.
- **`GET /api/health` always answers 200**, even when degraded. The body carries the verdict and
  the reasons; a non-200 would make a load balancer or a phone shortcut hide exactly what somebody
  is trying to read.
- **`app/hardware/` is `@Global()`.** Injecting `HardwareService` needs no import; injecting a
  repository still does.
- **A service that subscribes to a hardware observable must serialise its writes.** `hello` and
  the availability LWT arrive with no ordering guarantee between them, and a hello racing its own
  status message will otherwise produce two rows for one slug.

## When to update this file

- A new top-level module appears in `apps/server/src/app/`
- The zone/node/device relationship changes
- The hardware seam gains a method or an observable
- A new `depConstraints` entry lands in `eslint.config.mjs`
