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

type MigrationCommand = (source: DataSource) => Promise<void>;

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
    await migrationCommand(source);
    return EXIT_SUCCESS;
  } finally {
    await source.destroy();
  }
}

async function showMigrations(source: DataSource): Promise<void> {
  await source.showMigrations();
}

async function runPendingMigrations(source: DataSource): Promise<void> {
  const applied = await source.runMigrations({ transaction: 'each' });
  if (applied.length === 0) {
    console.log('No migrations were pending.');
  }
  for (const migration of applied) {
    console.log(`Applied ${migration.name}`);
  }
}

async function revertLastMigration(source: DataSource): Promise<void> {
  await source.undoLastMigration({ transaction: 'each' });
}
