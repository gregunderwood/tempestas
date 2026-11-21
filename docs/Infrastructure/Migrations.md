# Migrations

## What it is

TypeORM migrations, generated from the entities, applied by the CLI. `synchronize: false` in both
the app and the standalone DataSource — schema changes are reviewed SQL, never an inference at boot.

## Key files

- [../../apps/server/src/typeorm.config.ts](../../apps/server/src/typeorm.config.ts) — the DataSource the CLI uses (globs for entity discovery, unlike the app's explicit list)
- [../../apps/server/src/migrations/](../../apps/server/src/migrations/) — the migrations, in timestamp order
- `scripts` in [../../package.json](../../package.json) — the four `migration:*` commands
- [../../apps/server/src/migrate.ts](../../apps/server/src/migrate.ts) — the same migrations inside the shipped bundle, as `main.js migrate:show|run|revert`

## How it works

```bash
docker compose up -d                                            # the CLI needs the DB running

npm run migration:generate -- apps/server/src/migrations/AddNodeBootId
npm run migration:run
npm run migration:show
npm run migration:revert                                        # one step back
```

The CLI runs through `ts-node -r tsconfig-paths/register` against `apps/server/tsconfig.app.json`,
and loads `apps/server/.env` — a different code path from the running app's `@nestjs/config`. If a
migration cannot see the database, check that file first.

### On elantris

elantris has the build, not a checkout: no `package.json`, no `ts-node`, no source. The server
bundle carries the same migrations, and `tempestas-migrate@.service` runs them from it with the
server's own root-only env file. `tools/deploy.sh` checks for pending migrations **before** it
restarts the server, and stops if there are any: the new code on an unmigrated schema crash-loops.
It decides from `migrate:show`'s exit status, 3 when something is pending, and stops on any status
it does not recognise, so a check that cannot run never reads as "nothing pending". Run by hand,
`systemctl start tempestas-migrate@show.service` therefore reports the job **failed** when
something is pending: that is the answer, not an error. A stopped deploy has not shipped the web
bundle either, so the browser keeps matching the running server.

Running them stays a separate step, then the deploy runs again:

```bash
ssh elantris sudo -n systemctl start tempestas-migrate@run.service && tools/deploy.sh
ssh elantris journalctl -u tempestas-migrate@run.service -n 20 -o cat   # what it applied
```

**`run` and `revert` take a backup first**, through a drop-in that makes them require
`tempestas-backup.service`, and do nothing if it fails. The backup keeps the last 10 dumps in
`/var/backups/tempestas`, and its journal names the file it wrote. After
`tools/install-deploy-privileges.sh`, none of this asks for a password.

A host whose Postgres runs in Docker (greenhouse) has no `postgresql.service` to hang the backup on,
so there `run` and `revert` keep asking for a password, and the backup is by hand first:

```bash
sudo docker exec tempestas-db pg_dump -U tempestas -Fc tempestas > ~/backups/tempestas-$(date +%F)-before-<change>.dump
sudo systemctl start tempestas-migrate@run.service
```

### Naming

`<timestamp>-<PascalCaseName>.ts`, generated. The class name carries the same timestamp
(`AddNodeBootId1788923106173`) and that is what the `migrations` table records.

Name it for what it does to the schema (`AddNodeBootId`, `InitialSchema`), not for the feature that
motivated it.

## Patterns to follow

### ✅ Generate, don't hand-write

```bash
npm run migration:generate -- apps/server/src/migrations/AddNodeBootId
```

The generator diffs the entities against the live database, so it catches the column you forgot to
add to the entity as well as the one you forgot to migrate.

### ✅ Read the generated SQL before committing it

```ts
public async up(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`ALTER TABLE "nodes" ADD "boot_id" text`);
}
```

One column, no surprises. A generated migration that also drops an index or rewrites an enum is
telling you the entities and the database had drifted — understand it before you run it.

### ✅ Let the gate prove the round trip

```bash
npx nx run server:migration-round-trip     # part of the gate, and of tools/deploy.sh
```

A migration whose `down` is wrong is discovered at the worst possible time: during a rollback.
[../../apps/server/src/migrations/round-trip/](../../apps/server/src/migrations/round-trip/) starts a
throwaway `postgres:17` container and runs each migration in order: up, down, then up again, with
`transaction: 'each'` as `tempestas-migrate@` does. After each step it compares a full `pg_dump`
(schema and rows) with the one before, so a `down` that leaves a column or an enum value behind, or
puts back the wrong value, fails and names that migration. The first failure stops the run.

- **It runs on rows, not empty tables.**
  [rows-added-after.ts](../../apps/server/src/migrations/round-trip/rows-added-after.ts) adds a
  greenhouse zone, node, device, reading and pin transition as soon as the migration that creates
  their table has passed. The rows are shaped so every `down` can express them. A migration that
  changes data, or rebuilds an enum, gets a row to work on. Add rows there when a new table arrives.
- **It connects as a non-superuser.** Migrations run as a `tempestas` role that owns its database
  but is not a superuser. A migration that needs superuser rights, such as `CREATE EXTENSION`
  for an untrusted extension, fails here instead of during a deploy.
- **It also tries rows only the new code writes.** These are the rows a rollback meets in
  production: a Pico node, a heater, the pumphouse rules, a reading without humidity, two boots
  sharing a sequence number. For each migration, a copy of the database gets the rows from
  [rows-only-new-code-writes.ts](../../apps/server/src/migrations/round-trip/rows-only-new-code-writes.ts)
  and the revert must do what that file says: either revert, or refuse with a message naming the
  rows and change nothing. Every migration needs an entry, so a new one cannot skip the question.
- **It needs Docker.** It is its own target because each migration builds on the one before.

A unit test also checks that [index.ts](../../apps/server/src/migrations/index.ts) lists every
migration file. The bundle on elantris runs only what that file lists.

### ✅ Mark a migration that cannot be undone

```ts
export class DropLegacyReadings1800000000000 extends IrreversibleMigration {
  name = 'DropLegacyReadings1800000000000';
  irreversibleBecause = 'it drops sensor_readings_legacy, which only the backup still has';

  async up(queryRunner: QueryRunner) {
    await queryRunner.query(`DROP TABLE "sensor_readings_legacy"`);
  }
}
```

Dropping data has no honest `down`. Extend
[../../apps/server/src/migrations/irreversible-migration.ts](../../apps/server/src/migrations/irreversible-migration.ts)
and say why. Its `down` refuses to run with that reason, and points at the deploy's backup or at a
fix forward. The round trip
then checks that a revert is refused and changes nothing. An unmarked migration whose `down` does not
restore the database fails the gate.

### ✅ Add a doc comment when the column needs one

```ts
/**
 * A node's bootId changes on every restart of its agent. Persisted rather than
 * held in memory so a node bounce is detectable across a restart of the server.
 */
export class AddNodeBootId1788923106173 implements MigrationInterface {
```

### ❌ Don't edit a migration that has been applied anywhere

Write a new one. Editing an applied migration leaves the `migrations` table claiming work that the
schema does not reflect. The exception is a guard at the top of a `down`: it changes nothing a
migration did, only whether reverting it refuses with a message instead of a Postgres error.

### ✅ Make a `down` refuse by name

```ts
if (picoNodes.length > 0) {
  throw new Error(`Nodes are still Picos (${slugs}); change or remove them before reverting this migration`);
}
```

When the old schema cannot hold what the new code wrote, check first and throw a message that
names the rows, or counts them, and says what to do. Never delete them to make the revert fit.

Restore a backup only if the deploy being rolled back applied the migration: its backup is minutes
old. A migration applied long ago is older than any backup worth restoring, and restoring one
would lose everything recorded since. Fix those forward with a new migration. The refusal messages
say exactly this.

Four `down`s refuse today on rows elantris has: the Pico, the heating roles, the pumphouse rules
and the readings without humidity. A fifth, repeated sequence numbers, almost certainly does too:
every agent restart begins its count again, and the agents restart on every deploy.

### ❌ Don't rely on `synchronize`

```ts
synchronize: true,   // ❌ never, in any config, for any reason
```

## Pitfalls

- **The generator needs the database running and up to date.** Against a stale database it will
  generate the _difference from stale_, which is a migration that fails for the next person.
- **Expand-contract, once anything is deployed.** Without it, "roll back the image" is a lie —
  the previous image still has to run against the migrated schema. Add the column, deploy, backfill,
  then remove the old one in a later migration.
- **`pg_dump` before migrations on the Pi.** `tempestas-backup.service` does it; never skip it.
- **Enum changes are not free.** TypeORM rewrites the type, which on a large table is a table
  rewrite. `sensor_readings` will be the one that hurts.
- **Destructive operations on populated tables** get a second pair of eyes and a dump first.
- **The CLI globs only the timestamped files.** A plain `migrations/**/*` also matches
  `migrations/index.ts`, the barrel the bundled runner imports, so every migration is seen twice
  and TypeORM refuses with "Duplicate migrations". The bundled runner lists entities and migrations
  explicitly because a webpack bundle has no directory to scan.
- **`uuidExtension: 'pgcrypto'`** makes TypeORM emit `gen_random_uuid()`, built into Postgres 13+,
  rather than `uuid_generate_v4()`, which needs the `uuid-ossp` extension installed.

## When to update this file

- The migration commands or the CLI config change
- A migration goes wrong in a way the next person should be warned about
- Partitioning lands on `sensor_readings` (it changes what "add a column" costs)
