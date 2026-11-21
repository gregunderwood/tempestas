import { DataSource } from 'typeorm';
import {
  postgresConnectionOptions,
  readProcessEnvironment,
} from './app/common/postgres-connection';
import { ZoneEntity } from './app/zones/models';
import { NodeEntity } from './app/nodes/models';
import { DeviceEntity } from './app/devices/models';
import { SensorReadingEntity } from './app/readings/models';
import * as migrations from './migrations';

const EXIT_SUCCESS = 0;
const EXIT_UNKNOWN_COMMAND = 2;
// tools/deploy.sh refuses to restart the server on this status from `show`.
export const EXIT_MIGRATIONS_PENDING = 3;

type MigrationCommand = (source: DataSource) => Promise<number>;

const MIGRATION_COMMANDS = new Map<string, MigrationCommand>([
  ['show', showMigrations],
  ['run', runPendingMigrations],
  ['revert', revertLastMigration],
]);

// Listed rather than globbed: a webpack bundle has no directory to scan.
export function createMigrationDataSource(): DataSource {
  return new DataSource({
    ...postgresConnectionOptions(readProcessEnvironment),
    logging: ['error', 'schema'],
    entities: [ZoneEntity, NodeEntity, DeviceEntity, SensorReadingEntity],
    migrations: Object.values(migrations),
  });
}

export async function runMigrationCommand(command: string): Promise<number> {
  const source = await createMigrationDataSource().initialize();
  try {
    const migrationCommand = MIGRATION_COMMANDS.get(command);
    if (!migrationCommand) {
      console.error(
        `Unknown migration command "${command}"; use show|run|revert`,
      );
      return EXIT_UNKNOWN_COMMAND;
    }
    return await migrationCommand(source);
  } finally {
    await source.destroy();
  }
}

async function showMigrations(source: DataSource): Promise<number> {
  const hasPendingMigrations = await source.showMigrations();
  return hasPendingMigrations ? EXIT_MIGRATIONS_PENDING : EXIT_SUCCESS;
}

async function runPendingMigrations(source: DataSource): Promise<number> {
  const applied = await source.runMigrations({ transaction: 'each' });
  if (applied.length === 0) {
    console.log('No migrations were pending.');
  }
  for (const migration of applied) {
    console.log(`Applied ${migration.name}`);
  }
  return EXIT_SUCCESS;
}

async function revertLastMigration(source: DataSource): Promise<number> {
  await source.undoLastMigration({ transaction: 'each' });
  return EXIT_SUCCESS;
}
