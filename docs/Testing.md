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

An `exclude` list keeps modules, controllers, DTOs, entities and `*.fixtures.ts` test helpers out of
the measurement. A controller here is one line of delegation and a DTO is a declaration; counting
them makes the number describe how much boilerplate exists rather than whether the interlocks are
tested. A fixture runs in full whenever a test uses it, so counting it only inflates the number.

## Key files

- [../vitest.workspace.ts](../vitest.workspace.ts) — discovers each project's own vitest config
- [../apps/server/src/app/devices/device-state.spec.ts](../apps/server/src/app/devices/device-state.spec.ts) — the interlock boundaries
- [../apps/server/src/app/nodes/node-registry.spec.ts](../apps/server/src/app/nodes/node-registry.spec.ts) — the admission gate as pure functions
- [../apps/server/src/app/hardware/fake-hardware.service.spec.ts](../apps/server/src/app/hardware/fake-hardware.service.spec.ts) — proves the simulator is a closed loop
- [../apps/server/src/app/common/clock.ts](../apps/server/src/app/common/clock.ts) — `Clock` / `SystemClock` / `FixedClock`

## How it works

### Run commands

```bash
npx nx run-many -t lint,typecheck,test,build,migration-round-trip     # the gate — always this before declaring done
npx nx test server                     # one project
npx nx test server -- device-state     # one file, by substring
```

`tools/` is an Nx project too, where it sits: `tools:test` runs the `node:test` specs in
`tools/lib/`, and `tools:lint` runs eslint over its `.mjs` and `.cjs` scripts. The shell and Python
scripts there are not checked.

`migration-round-trip` needs Docker: it runs every migration against a throwaway Postgres. Its
config is [../apps/server/vitest.round-trip.config.ts](../apps/server/vitest.round-trip.config.ts),
named so the workspace does not pick it up as part of `test`.

Vitest globals are on: `describe`, `it`, `expect` and `vi` need no import.

**A green `test` run does not mean it compiles.** Vitest transpiles without typechecking. Only
`build` will catch a type error. This has already bitten twice.

### The e2e smoke test

The smoke test is one Cypress spec, [../apps/web-e2e/src/e2e/smoke.cy.ts](../apps/web-e2e/src/e2e/smoke.cy.ts).
It checks that the shell loads, that the dashboard shows a node card, and that the rail and the
phone menu both reach Zones and Nodes. It needs no server, broker or database:

```bash
npx nx e2e web-e2e     # starts nx serve web itself, runs headless, 15 to 40 s
```

- **The API is stubbed with `cy.intercept`** in
  [../apps/web-e2e/src/support/stub-api.ts](../apps/web-e2e/src/support/stub-api.ts). Any `/api`
  call it does not know gets a 501 instead of reaching the dev proxy, which has no server behind
  it.
- **The socket is a fake `WebSocket`**, installed before the app loads, in
  [../apps/web-e2e/src/support/fake-realtime-server.ts](../apps/web-e2e/src/support/fake-realtime-server.ts).
  `cy.intercept` cannot answer a websocket, and Socket.IO tries the websocket transport first.
  The fake speaks just enough Engine.IO and Socket.IO to connect and push the events it is given.
  Readings reach the dashboard only over it, so the node card proves the socket path works.
- **Fixtures are typed against `@tempestas/domain`**, so a contract change breaks
  `web-e2e:typecheck` in the gate even though the spec itself is not run there.
- **It runs only the specs in `src/e2e/`.**
  [../apps/web-e2e/cypress.config.ts](../apps/web-e2e/cypress.config.ts) narrows the Nx preset's
  `src/**/*.cy.ts` to them, because the stack specs fail without the server `tools/e2e-stack.sh`
  starts.
- **It is not in the gate.** Cypress has no arm64 Linux binary (see Pitfalls), so the gate would
  fail on the Pi, and a dev server start makes it the slowest target by far.
- **From a VS Code terminal, unset `ELECTRON_RUN_AS_NODE`.** VS Code exports it, and Cypress then
  fails to start with `bad option: --no-sandbox`. Use `env -u ELECTRON_RUN_AS_NODE npx nx e2e web-e2e`.

### Use cases on a real stack

The smoke test stubs the server, so it cannot show a behaviour that runs through it, such as
updating a node. The specs in [../apps/web-e2e/src/stack](../apps/web-e2e/src/stack) drive those
use cases through the page against a real server instead:

```bash
tools/e2e-stack.sh                         # every stack spec, headless, about 2 minutes in all
tools/e2e-stack.sh --spec apps/web-e2e/src/stack/node-update.cy.ts --headed
```

- **It starts the same throwaway stack as the PR screenshots**, from
  [../tools/lib/fake-stack.sh](../tools/lib/fake-stack.sh): a database `tempestas_e2e_stack`, the
  zones copied from the dev database, the server with `HARDWARE_DRIVER=fake`, both simulated nodes
  admitted, and `nx serve web` proxied to it. Ports 7030 and 4230, or `E2E_STACK_SERVER_PORT` and
  `E2E_STACK_WEB_PORT`. It tears everything down, even on failure.
- **It offers fake `agent-linux` releases 1.1.0 and 1.1.1**, written by
  [../tools/lib/write-fake-agent-releases.mjs](../tools/lib/write-fake-agent-releases.mjs), with
  `AGENT_RELEASES_URL` set, so the simulated Pi is offered an update and then a roll back.
- **The specs share one server**, so they run in order and leave it as they found it: the update
  spec rolls the Pi back to 1.1.0.
- **It runs only the specs in `src/stack/`**, with
  [../apps/web-e2e/cypress.stack.config.ts](../apps/web-e2e/cypress.stack.config.ts).
- **Options after the script name go to `cypress run`**, such as `--spec` or `--headed`. Cypress
  reads a `--spec` path from the directory you run the script in, so from the repo root it starts
  with `apps/web-e2e/`.
- **It is not in the gate**, for the same reasons as the smoke test, and it needs Docker.

### Screenshots on a PR

A diff does not show what a page looks like on a phone, or what it looked like before. Any PR that
changes what a page shows posts before-and-after screenshots at desktop and phone width before
review, and the reviewer compares them:

```bash
tools/pr-screenshots.sh 138 dashboard nodes nodes/sim-pi       # <pr> then page paths
tools/pr-screenshots.sh --after-only 138 reports/new-report    # a page that did not exist before
tools/pr-screenshots.sh --history 139 reports                   # with 30 days of simulated history
```

Run it from a checkout of the PR's branch, committed and pushed: it refuses if `HEAD` is not the
PR's head commit or if tracked files have changes. It then:

- **checks out the base** for "before": the merge-base of the PR with its base branch, in a
  temporary worktree, so before and after differ only by this PR. `--after-only` skips it.
- **starts a stack for each side in turn**: a fresh database `tempestas_pr_<pr>_before` or
  `_after` in `tempestas-db`, migrated with that side's own migrations, the zones copied from the
  dev database `tempestas`, the server with `HARDWARE_DRIVER=fake`, both simulated nodes admitted
  and a device created on each relay pin with its zone's roles, so the rules switch them and the
  pages show equipment, and `nx serve web` proxied to it.
- **seeds 30 days of history with `--history`**, using this checkout's seeders on both sides:
  `tools/seed-runtime-history.mjs` after the devices are created, and
  `tools/seed-reading-history.mjs` after the first real readings arrive. See below.
- **uses ports 7020 and 4220**, and refuses to start if anything listens on either. Other ports:
  `PR_SCREENSHOTS_SERVER_PORT` and `PR_SCREENSHOTS_WEB_PORT`.
- **takes each page at 1280 px and 390 px** with headless Chrome.
- **adds a commit to the `pr-screenshots` branch** with the images in `<pr>/`, through a temporary
  worktree, so no checkout changes branch. If another run pushed first, it replays its commit on
  top and tries again.
- **posts one "Screenshots" comment**, a Before and After table per page, or updates it on a rerun,
  with each image pinned to that commit.
- **tears everything down**, even on failure: the processes stopped, both databases dropped, both
  temporary worktrees removed.

**Never delete or force-push `pr-screenshots`.** Each comment links its images by commit, and a
commit that is no longer reachable breaks the images on every old PR. Prune old folders with a
new commit instead.

### Video of a PR

A screenshot shows one moment. For a PR about behaviour, such as a press, a confirmation, then a
node working through an update, the reviewer watches the stack specs run instead:

```bash
tools/pr-video.sh 164                                             # every stack spec
tools/pr-video.sh 164 apps/web-e2e/src/stack/node-update.cy.ts    # only these
tools/pr-video.sh --player-url https://claude.ai/artifact/... 164
```

Like the screenshots, it runs from the PR's pushed, clean head. It then:

- **records the specs** with `tools/e2e-stack.sh --config video=true`. A failing spec stops it, so
  only a passing run is posted. The video is 1920 × 1080, so the app shows at full size beside
  Cypress's log of each command, and `scrollBehavior: 'center'` keeps what a step acts on in view.
- **notes where each test starts** in its video. The support file in
  [../apps/web-e2e/src/support/stack.ts](../apps/web-e2e/src/support/stack.ts) reports each test,
  and the config writes `<spec>.test-starts.json` beside the video. The player and the comment
  list these as steps.
- **converts each mp4 to a GIF** with the ffmpeg Cypress ships with, or one on the `PATH`. GitHub
  plays a GIF inline in a comment but not an mp4 posted through the API.
- **adds a commit to `pr-screenshots`** with the GIFs and mp4s in `<pr>/`, the same way as the
  screenshots, and posts or updates one "Video" comment. For each spec, the comment gives its
  tests as steps, the GIF inline, a slot for the player link, and a link to download the mp4.
- **writes a player page to `dist/pr-video/<pr>/`**: `index.html` from
  [../tools/pr-video/player.html](../tools/pr-video/player.html), `videos.json`, and the mp4s. It
  plays each video with speed from 0.25× to 2×, frame stepping, and a jump to each test.

The script cannot publish the player, because it is a claude.ai artifact. Claude publishes
`index.html` with `videos.json` and the mp4s as its files, then runs `--player-url`, which puts
the link in the comment's slot. After a new recording, republish to the same artifact and run
`--player-url` again, since the new comment has the slot back.

The artifact is private: anyone else reviewing needs it shared from the page's Share menu.
Nothing removes old videos from `pr-screenshots` or old player pages yet. That is fine while one
person works on the project.

### Simulated runtime history

The server stamps every `pin_transitions` row with the real time, so a fresh stack has minutes of
history, and a report over 30 days shows nothing. `tools/seed-runtime-history.mjs <database>`
writes 30 days of it for every device already in a database:

```bash
node tools/seed-runtime-history.mjs tempestas   # the everyday dev database
```

- **Only a dev or screenshot database.** The name must be `tempestas_dev`, `tempestas_dev_<suffix>`
  or `tempestas_pr_<n>_before|after`, or `tempestas` itself when the `tempestas-db` container was
  started by this repo's `docker compose` (it carries the compose service label `db`). Production
  uses the same container and database names but starts its container with `docker run`, so there
  `tempestas` is refused. It only ever reaches the `tempestas-db` container: no MQTT, no GPIO.
- **Plausible, and the same every run.** Heating roles run mostly at night in the zone's timezone,
  longest on the cold nights the readings seeder shows, fans and lights by day. Six days ago
  short-cycles from 10:00 to 14:00. Twelve days ago the first node by slug drops out from 01:30 to
  05:00: a `node-offline` row, unknown, as the server writes it, then a known row when it returns.
  The pattern is seeded from each line and day, not random.
- **Rerunnable.** It replaces each device pin's rows from local midnight 30 days back to now, ends
  on the state the pin is in now so the server carries on from it, and moves each device's
  `created_at` back to the start of that window, so the report counts all 30 days.
- **Its specs** run in the gate as `tools:test` (`npx nx test tools`, which runs
  `node --test tools/lib/*.test.mjs`). They need no Docker and no database: the refusal specs stop
  before any `psql`, and a missing `docker` only makes `tempestas` refused too.

### Simulated temperature readings

The zone history chart shows the last 24 hours and the reports look back 30 days, but a fresh stack
has only the readings since it started. `tools/seed-reading-history.mjs <database>` writes 30 days
of `sensor_readings` for every probe that has reported, so run it once the stack has its first
readings:

```bash
node tools/seed-runtime-history.mjs tempestas
node tools/seed-reading-history.mjs tempestas
```

- **Only a dev or screenshot database**, by the same rule as the runtime history above.
- **One reading a minute per probe**, from local midnight 30 days back: about 44,000 rows a probe,
  so about 88,000 on a screenshot stack's two probes.
- **Plausible, and the same every run.** Coldest at 06:00 and warmest at 15:00 in the zone's
  timezone, eased between the two, with a little noise and a small fixed offset per probe. Each
  night's coldness is shared with the runtime history, so the heaters run longest on the cold
  nights. The nights 4 and 17 days ago drop to about 0.6 °C, for the freeze-margin report to flag;
  every other night stays above about 2 °C. Humidity and CO2 are written only if the probe has
  ever reported them, and are null otherwise.
- **Never touches a real reading.** Each seeded row has `boot_id` `seeded-history`. A rerun deletes
  only those rows, for the probes it reseeds, so it never doubles them. Each probe's seed stops just
  before its first real reading at or after the window start, so nothing at or after that reading
  is written over, and real readings older than the window are left alone. Its last hour leans
  toward that first real reading, so the chart does not jump where the seed ends. A probe that
  already has a real reading at the window start gets none, and one with no real reading in the
  window is skipped, so a long-dead sensor never looks alive.

A screenshot cannot show interaction, and the fake driver always leads. For a state reached by
clicking (an open menu, a drag) or one the fake driver cannot produce (a follower), take the
screenshots with Cypress against the e2e test's stubbed API and fake socket, on the base and on the
branch, and add them to the same branch the same way.

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
- `tools/pr-screenshots.sh` changes how it starts its stack or where it stores images
- `tools/seed-runtime-history.mjs` or `tools/seed-reading-history.mjs` changes which databases it
  accepts or what history it writes
- A porting landmine or boundary case is discovered that future work must not undo
