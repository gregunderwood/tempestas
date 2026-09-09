# Testing

## What it is

Vitest, colocated `*.spec.ts`, and a deliberately **narrow** coverage target. The old repo had zero
real tests — `tests/services/set_device_states_test.py` is an empty file — so the temptation is to
test everything. Resist it. This system runs a heater in a greenhouse in winter; effort goes where a
wrong answer has physical consequences.

Coverage **thresholds** are enforced on exactly two paths, both in
[../apps/server/vitest.config.ts](../apps/server/vitest.config.ts): `src/app/devices/**` and
`src/app/rules/**`, at 90% lines / 90% functions / 85% branches / 90% statements. `libs/domain`
collects coverage but sets no thresholds. Everything else is smoke-tested.

Coverage only runs when asked — `npx nx test server --coverage` — and it is **part of the gate**,
because a threshold nobody runs is decoration. It went unrun through phases 1-4 and was failing when
phase 5 first checked it.

An `exclude` list keeps modules, controllers, DTOs and entities out of the measurement. A controller
here is one line of delegation and a DTO is a declaration; counting them makes the number describe
how much boilerplate exists rather than whether the interlocks are tested.

## Key files

- [../vitest.workspace.ts](../vitest.workspace.ts) — discovers each project's own vitest config
- [../apps/server/src/app/devices/device-state.spec.ts](../apps/server/src/app/devices/device-state.spec.ts) — the interlock boundaries
- [../apps/server/src/app/nodes/node-registry.spec.ts](../apps/server/src/app/nodes/node-registry.spec.ts) — the admission gate as pure functions
- [../apps/server/src/app/hardware/fake-hardware.service.spec.ts](../apps/server/src/app/hardware/fake-hardware.service.spec.ts) — proves the simulator is a closed loop
- [../apps/server/src/app/common/clock.ts](../apps/server/src/app/common/clock.ts) — `Clock` / `SystemClock` / `FixedClock`

## How it works

### Run commands

```bash
npx nx run-many -t lint,test,build     # the gate — always this before declaring done
npx nx test server                     # one project
npx nx test server -- device-state     # one file, by substring
```

Vitest globals are on: `describe`, `it`, `expect` and `vi` need no import.

**A green `test` run does not mean it compiles.** Vitest transpiles without typechecking. Only
`build` will catch a type error. This has already bitten twice.

### The rule that makes the important tests possible

**No code in `rules/` or `device-state.ts` may call `new Date()`.** Time enters as an argument, and
services take an injected `Clock`:

```ts
const service = new DevicesService(repo, nodeRepo, hardware, new FixedClock(NOW));
```

That is what lets a cooldown boundary be asserted to the second, and what makes the DST cases
writeable at all.

### Three kinds of test, in descending order of value

1. **Pure decision functions.** `device-state.ts`, `node-registry.ts`, `rules/`. No mocks, no
   fixtures beyond a literal, one assertion per behaviour. Most of the safety-relevant coverage
   lives here and it is the cheapest to write.
2. **Service tests with hand-rolled fakes.** An in-memory table object rather than a mocking
   framework, so a whole lifecycle can be asserted end to end (`makeService([...])` in
   `nodes.service.spec.ts`). No `@nestjs/testing` module compilation — the services take
   constructor arguments, so `new Service(...)` is enough and runs in milliseconds.
3. **The fake hardware driver as an integration seam.** Because it is a closed loop, "burner on →
   CO2 climbs → rule turns it off" is assertable with no Pi, no broker and no relays.

## Patterns to follow

### ✅ Name the behaviour and the reason, not the method

```ts
it('refuses during the cooldown and publishes NOTHING', ...)
it('never changes the status of a node that already exists', ...)
it('does not treat an LWT as a sighting', ...)
```

A test name is the shortest place to record why the behaviour matters. `it('should return false')`
records nothing.

### ✅ Put the "why" above the test when it encodes a safety property

```ts
// The gate would be theatre if a node could re-announce its way past it.
it('never changes the status of a node that already exists', async () => { ... });
```

### ✅ Assert the boundary, not the middle

```ts
expect(dto.canTurnOnAt).toBe('2026-01-10T12:04:00.000Z'); // offAt + exactly 300s
```

Every threshold gets its boundary values: `25.9 / 26.0 / 27.0 / 27.1`, window edges
`06:29 / 06:30 / 18:29 / 18:30`, `onDelayDuration === 0`, and the `onAt === offAt` tie.

### ✅ Assert that nothing happened, when nothing happening is the point

```ts
await expect(service.turnOn('dev-1')).rejects.toMatchObject({
  response: { code: ApiErrorCode.DeviceCooldown },
});
expect(setPin).not.toHaveBeenCalled();
expect(save).not.toHaveBeenCalled();
```

A refusal that still published, or still persisted, is the bug. Half of these tests exist to prove
a *non-*effect.

### ✅ Hand-rolled fakes over deep mock chains

```ts
const nodeRepo = {
  findOne: vi.fn(async ({ where }) => rows.find(...) ?? null),
  save: vi.fn(async (row) => { if (!rows.includes(row)) rows.push(row); return row; }),
} as unknown as Repository<NodeEntity>;
```

The `as unknown as Repository<T>` cast is accepted here: the alternative is a full TypeORM double,
which tests TypeORM rather than the service.

### ❌ Don't mock the thing under test's own logic

```ts
const service = new NodesService(...);
vi.spyOn(service, 'resolveForSample').mockResolvedValue(...);   // ❌ in a NodesService spec
```

Mock it in the _consumer's_ spec (`readings-ingest.service.spec.ts` does), never in its own.

### ❌ Don't let a spec depend on wall-clock time

```ts
const service = new DevicesService(repo, nodeRepo, hardware, new SystemClock()); // ❌
```

### ❌ Don't leave a `jest` artifact anywhere

`find . -name 'jest*' -not -path './node_modules/*'` must come back empty. The reference monorepo
left Jest configs behind after moving to Vitest and both runners half-work.

## Pitfalls

- **Thresholds cover `app/devices` and `app/rules` only**, and via the coverage `include` list —
  a new safety-critical module needs adding to that list or its coverage silently doesn't count.
  Adding a threshold to `app/readings` or `app/nodes` is not the goal; adding a boundary case to
  `app/rules` is.
- **The DST tests are the reason for the port**, and they live in
  [../apps/server/src/app/rules/local-time.spec.ts](../apps/server/src/app/rules/local-time.spec.ts):
  explicit UTC instants across the March and November `America/Vancouver` boundaries, the two
  distinct instants that both read 01:30 local, and a January and a July instant at the same UTC
  wall time resolving an hour apart. The Python version fails the last of those. Note what they
  deliberately do _not_ assert: the two 01:30 instants get the _same_ minute-of-day, because "is it
  night?" has one answer at 01:30 however often 01:30 happens.
- **The never-been-on interlock is a known porting landmine.** Python's `can_turn_on` compares
  `can_turn_on_at() < utcnow()` where the never-on branch internally returns _its own_ `utcnow()` —
  so `t0 < t1` is True. Ported with a single injected `now`, `now < now` is False and a freshly
  created device can never be turned on. The never-on branch uses `<=`, and it has a regression test.
- **Cypress ships no official arm64 Linux binary.** Set `CYPRESS_INSTALL_BINARY=0` on the Pi so
  `npm ci` doesn't stall; e2e runs on the Mac only.
- **Nx caches test results.** A silent pass may be a cache hit. `--skip-nx-cache` when chasing a flake.
- **A `vi.fn()` with no implementation resolves `undefined`.** For a repository `save` that the code
  reads back from, give it `async (row) => row` or the assertion fails somewhere unrelated.

## Safety behaviours that need fault injection (phase 7+)

Each of these should be driven through a fault-injection topic so it is regression-tested rather
than hoped for: dead-man trip (stop NestJS, all lines to failsafe within 30 s), readback mismatch,
max-on latch, min-dwell clamp, expired command, retained-command rejection, controller conflict,
sensor timeout.

The highest-value single check in the whole plan is the phase 7 contract test: watch
`mosquitto_sub -v -t 'tempestas/v1/node/+/#'`, toggle a device, confirm a **non-retained**
`gpio/set` appears, hand-publish a sample and watch it persist → evaluate → push over the socket.
And `mosquitto_pub -r` of a `gpio/set` **must** be dropped and alarmed.

## When to update this file

- A new coverage-enforced path is added
- A new class of test appears (fault injection, contract, e2e)
- A porting landmine or boundary case is discovered that future work must not undo
