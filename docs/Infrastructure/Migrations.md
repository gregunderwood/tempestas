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
Running them stays a separate step:

```bash
ssh -t elantris sudo systemctl start tempestas-backup.service        # pg_dump to /var/backups/tempestas
ssh -t elantris sudo systemctl start tempestas-migrate@run.service
ssh -t elantris sudo systemctl restart tempestas-server.service
journalctl -u tempestas-migrate@run.service -n 20 -o cat              # what it applied
```

The backup unit keeps the last 10 dumps, and its journal names the file it wrote. After
`tools/install-deploy-privileges.sh`, none of these asks for a password.

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

### ✅ Prove the round trip

```bash
npm run migration:run && npm run migration:revert && npm run migration:run
```

A migration whose `down` is wrong is discovered at the worst possible time. It costs ten seconds
to check.

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
schema does not reflect.

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
