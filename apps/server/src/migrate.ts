import { DataSource } from 'typeorm';
import { ZoneEntity } from './app/zones/models';
import { NodeEntity } from './app/nodes/models';
import { DeviceEntity } from './app/devices/models';
import { SensorReadingEntity } from './app/readings/models';
import * as migrations from './migrations';

/**
 * Running migrations on a deployed box, from inside the shipped bundle.
 *
 * The TypeORM CLI needs `ts-node`, `tsconfig-paths` and the TypeScript source,
 * which would mean installing the whole devDependency tree on a 3.7 GiB Pi to
 * run a schema change. This carries the same DataSource in the artifact that
 * is already there.
 *
 * Entities and migrations are listed explicitly rather than globbed: a webpack
 * bundle has no directory to scan, which is the same reason `app.module.ts`
 * lists its entities.
 *
 * It never runs by itself. Deployment restarts the service; applying a schema
 * change to the only copy of the greenhouse's history is a separate, deliberate
 * command with a human reading `show` first.
 */
export function migrationDataSource(): DataSource {
  return new DataSource({
    type: 'postgres',
    host: process.env['DATABASE_HOST'] ?? '127.0.0.1',
    port: Number(process.env['DATABASE_PORT'] ?? 5432),
    username: process.env['DATABASE_USER'] ?? 'tempestas',
    password: process.env['DATABASE_PASSWORD'] ?? 'tempestas',
    database: process.env['DATABASE_NAME'] ?? 'tempestas',
    uuidExtension: 'pgcrypto',
    // Never true. Schema changes go through reviewed migrations only.
    synchronize: false,
    logging: ['error', 'schema'],
    entities: [ZoneEntity, NodeEntity, DeviceEntity, SensorReadingEntity],
    migrations: Object.values(migrations),
  });
}

export async function runMigrationCommand(command: string): Promise<number> {
  const source = await migrationDataSource().initialize();
  try {
    if (command === 'show') {
      // `true` logs each migration and whether it has been applied.
      await source.showMigrations();
      return 0;
    }
    if (command === 'run') {
      const applied = await source.runMigrations({ transaction: 'each' });
      if (applied.length === 0) {
        console.log('No migrations were pending.');
      }
      for (const m of applied) {
        console.log(`Applied ${m.name}`);
      }
      return 0;
    }
    if (command === 'revert') {
      await source.undoLastMigration({ transaction: 'each' });
      return 0;
    }
    console.error(
      `Unknown migration command "${command}"; use show|run|revert`,
    );
    return 2;
  } finally {
    await source.destroy();
  }
}
