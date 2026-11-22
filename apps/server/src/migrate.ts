import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource, MigrationExecutor, type QueryRunner } from 'typeorm';
import {
  postgresConnectionOptions,
  readProcessEnvironment,
  type ReadSetting,
} from './app/common/postgres-connection';
import { ZoneEntity } from './app/zones/models';
import { NodeEntity } from './app/nodes/models';
import { DeviceEntity } from './app/devices/models';
import { SensorReadingEntity } from './app/readings/models';
import * as migrations from './migrations';
import { isIrreversible } from './migrations/irreversible-migration';

const EXIT_SUCCESS = 0;
const EXIT_UNKNOWN_COMMAND = 2;
// tools/deploy.sh migrates before it switches on these statuses from `show`.
export const EXIT_MIGRATIONS_PENDING = 3;
export const EXIT_IRREVERSIBLE_MIGRATIONS_PENDING = 4;
export const EXIT_MIGRATIONS_APPLIED_BUT_NOT_RECORDED = 5;
const MIGRATIONS_TABLE = 'migrations';

// Beside server/ in a release, so each release remembers what it applied and can undo exactly that.
export const APPLIED_MIGRATIONS_FILE = join(
  __dirname,
  '..',
  'applied-migrations.json',
);

export interface MigrationCommandOptions {
  readSetting?: ReadSetting;
  appliedMigrationsFile?: string;
}

type MigrationCommand = (
  source: DataSource,
  appliedMigrationsFile: string,
) => Promise<number>;

const MIGRATION_COMMANDS = new Map<string, MigrationCommand>([
  ['show', showMigrations],
  ['run', runPendingMigrations],
  ['revert', revertLastMigration],
  ['revert-applied', revertAppliedMigrations],
]);

// Listed rather than globbed: a webpack bundle has no directory to scan.
export function createMigrationDataSource(
  readSetting: ReadSetting = readProcessEnvironment,
): DataSource {
  return new DataSource({
    ...postgresConnectionOptions(readSetting),
    logging: ['error', 'schema'],
    entities: [ZoneEntity, NodeEntity, DeviceEntity, SensorReadingEntity],
    migrations: Object.values(migrations),
  });
}

export async function runMigrationCommand(
  command: string,
  {
    readSetting = readProcessEnvironment,
    appliedMigrationsFile = APPLIED_MIGRATIONS_FILE,
  }: MigrationCommandOptions = {},
): Promise<number> {
  const migrationCommand = MIGRATION_COMMANDS.get(command);
  if (!migrationCommand) {
    console.error(
      `Unknown migration command "${command}"; use ${[...MIGRATION_COMMANDS.keys()].join('|')}`,
    );
    return EXIT_UNKNOWN_COMMAND;
  }
  const source = await createMigrationDataSource(readSetting).initialize();
  try {
    return await migrationCommand(source, appliedMigrationsFile);
  } finally {
    await source.destroy();
  }
}

async function showMigrations(source: DataSource): Promise<number> {
  const pending = await new MigrationExecutor(source).getPendingMigrations();
  if (pending.length === 0) {
    console.log('No migrations are pending.');
    return EXIT_SUCCESS;
  }
  for (const migration of pending) {
    console.log(`Pending ${migration.name}`);
  }
  const irreversible = pending.filter(
    (migration) => migration.instance && isIrreversible(migration.instance),
  );
  for (const migration of irreversible) {
    console.log(`Cannot be reverted: ${migration.name}`);
  }
  return irreversible.length > 0
    ? EXIT_IRREVERSIBLE_MIGRATIONS_PENDING
    : EXIT_MIGRATIONS_PENDING;
}

// One transaction, so a migration that fails halfway down the list leaves none of them applied.
async function runPendingMigrations(
  source: DataSource,
  appliedMigrationsFile: string,
): Promise<number> {
  // Read before migrating, so an unreadable record stops the run before it changes anything.
  const appliedBefore = readAppliedMigrations(appliedMigrationsFile);
  const applied = await source.runMigrations({ transaction: 'all' });
  if (applied.length === 0) {
    console.log('No migrations were pending.');
  }
  const appliedNames = applied.map((migration) => migration.name);
  for (const name of appliedNames) {
    console.log(`Applied ${name}`);
  }
  try {
    writeAppliedMigrations(appliedMigrationsFile, [
      ...appliedBefore,
      ...appliedNames,
    ]);
  } catch (writeError) {
    console.error(
      `Applied ${appliedNames.join(', ')}, but could not record them in ${appliedMigrationsFile} ` +
        `(${String(writeError)}), so revert-applied cannot undo them; revert by hand`,
    );
    return EXIT_MIGRATIONS_APPLIED_BUT_NOT_RECORDED;
  }
  return EXIT_SUCCESS;
}

async function revertLastMigration(source: DataSource): Promise<number> {
  await source.undoLastMigration({ transaction: 'each' });
  return EXIT_SUCCESS;
}

async function revertAppliedMigrations(
  source: DataSource,
  appliedMigrationsFile: string,
): Promise<number> {
  const newestFirst = readAppliedMigrations(appliedMigrationsFile).reverse();
  if (newestFirst.length === 0) {
    console.log(
      'This release applied no migrations, so there is nothing to revert.',
    );
    return EXIT_SUCCESS;
  }
  await requireNewestExecuted(source, newestFirst);
  await revertMigrations(source, newestFirst);
  for (const name of newestFirst) {
    console.log(`Reverted ${name}`);
  }
  writeAppliedMigrations(appliedMigrationsFile, []);
  return EXIT_SUCCESS;
}

// By insertion order, not timestamp: a branch merged late can apply an older timestamp after a newer one.
async function requireNewestExecuted(
  source: DataSource,
  newestFirst: string[],
) {
  const executed: { name: string }[] = await source.query(
    `SELECT "name" FROM "${MIGRATIONS_TABLE}" ORDER BY "id" DESC LIMIT $1`,
    [newestFirst.length],
  );
  const newestExecuted = executed.map((row) => row.name);
  if (newestExecuted.join() !== newestFirst.join()) {
    throw new Error(
      `This release applied ${newestFirst.join(', ')}, but the newest applied migrations are ` +
        `${newestExecuted.join(', ') || 'none'}; revert by hand`,
    );
  }
}

// One transaction: every down runs or none does, so a refusal never leaves the schema between releases.
export async function revertMigrations(
  source: DataSource,
  newestFirst: string[],
): Promise<void> {
  const queryRunner = source.createQueryRunner();
  await queryRunner.startTransaction();
  try {
    for (const name of newestFirst) {
      await revertOneMigration(source, queryRunner, name);
    }
    await queryRunner.commitTransaction();
  } catch (revertError) {
    await queryRunner.rollbackTransaction();
    throw revertError;
  } finally {
    await queryRunner.release();
  }
}

async function revertOneMigration(
  source: DataSource,
  queryRunner: QueryRunner,
  name: string,
) {
  const migration = source.migrations.find(
    (candidate) => candidate.name === name,
  );
  if (!migration) {
    throw new Error(`${name} is not in this build, so it cannot be reverted`);
  }
  await migration.down(queryRunner);
  await queryRunner.query(
    `DELETE FROM "${MIGRATIONS_TABLE}" WHERE "name" = $1`,
    [name],
  );
}

function readAppliedMigrations(appliedMigrationsFile: string): string[] {
  if (!existsSync(appliedMigrationsFile)) {
    return [];
  }
  return JSON.parse(readFileSync(appliedMigrationsFile, 'utf8')) as string[];
}

function writeAppliedMigrations(
  appliedMigrationsFile: string,
  names: string[],
) {
  writeFileSync(appliedMigrationsFile, `${JSON.stringify(names, null, 2)}\n`);
}
