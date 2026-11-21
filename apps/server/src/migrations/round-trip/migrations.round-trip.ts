import { inject } from 'vitest';
import { DataSource, type MigrationInterface } from 'typeorm';
import { postgresConnectionOptions } from '../../app/common/postgres-connection';
import * as migrations from '..';
import { isIrreversible } from '../irreversible-migration';
import { runDocker, type ThrowawayPostgres } from './throwaway-postgres';

type MigrationClass = new () => MigrationInterface;

const TRAILING_TIMESTAMP = /\d+$/;
// Comments carry the pg_dump version, and \restrict carries a key that is random per dump.
const VOLATILE_DUMP_LINE = /^(--|\\restrict |\\unrestrict )/;

const throwawayPostgres = inject('throwawayPostgres');

const migrationsInOrder: MigrationClass[] = Object.values(migrations).sort(
  (first, second) => readTimestamp(first) - readTimestamp(second),
);

function readTimestamp(migrationClass: MigrationClass): number {
  return Number(TRAILING_TIMESTAMP.exec(migrationClass.name)?.[0]);
}

function connectWith(migrationsSoFar: MigrationClass[]): DataSource {
  const settings: Record<string, string> = {
    DATABASE_HOST: '127.0.0.1',
    DATABASE_PORT: String(throwawayPostgres.port),
    DATABASE_USER: throwawayPostgres.username,
    DATABASE_PASSWORD: throwawayPostgres.password,
    DATABASE_NAME: throwawayPostgres.database,
  };
  return new DataSource({
    ...postgresConnectionOptions((name) => settings[name]),
    migrations: migrationsSoFar,
  });
}

async function withConnection(
  migrationsSoFar: MigrationClass[],
  action: (source: DataSource) => Promise<unknown>,
) {
  const source = await connectWith(migrationsSoFar).initialize();
  try {
    await action(source);
  } finally {
    await source.destroy();
  }
}

// The same transaction mode tempestas-migrate@run and @revert use.
const applyPending = (migrationsSoFar: MigrationClass[]) =>
  withConnection(migrationsSoFar, (source) =>
    source.runMigrations({ transaction: 'each' }),
  );

const revertLast = (migrationsSoFar: MigrationClass[]) =>
  withConnection(migrationsSoFar, (source) =>
    source.undoLastMigration({ transaction: 'each' }),
  );

function readSchema(postgres: ThrowawayPostgres): string {
  const dump = runDocker(
    'exec',
    postgres.containerId,
    'pg_dump',
    '--schema-only',
    '--username',
    postgres.username,
    postgres.database,
  );
  return dump
    .split('\n')
    .filter((line) => line.trim() !== '' && !VOLATILE_DUMP_LINE.test(line))
    .join('\n');
}

describe('every migration, applied in order on an empty database', () => {
  migrationsInOrder.forEach((migrationClass, position) => {
    const migrationsBefore = migrationsInOrder.slice(0, position);
    const migrationsSoFar = migrationsInOrder.slice(0, position + 1);

    it(`${migrationClass.name} goes up, down and up again to the same schema`, async () => {
      // Also creates TypeORM's migrations table, and catches up after an earlier failure.
      await applyPending(migrationsBefore);
      const schemaBefore = readSchema(throwawayPostgres);
      await applyPending(migrationsSoFar);
      const schemaAfterUp = readSchema(throwawayPostgres);

      const migration = new migrationClass();
      if (isIrreversible(migration)) {
        expect(migration.irreversibleBecause.trim()).not.toBe('');
        return;
      }

      await revertLast(migrationsSoFar);
      expect(readSchema(throwawayPostgres)).toBe(schemaBefore);

      await applyPending(migrationsSoFar);
      expect(readSchema(throwawayPostgres)).toBe(schemaAfterUp);
    });
  });
});
