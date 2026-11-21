import { inject } from 'vitest';
import { DataSource, type MigrationInterface, type QueryRunner } from 'typeorm';
import { postgresConnectionOptions } from '../../app/common/postgres-connection';
import * as migrations from '..';
import {
  IrreversibleMigration,
  isIrreversible,
} from '../irreversible-migration';
import { addRowsAfter } from './rows-added-after';
import {
  SUPERUSER,
  runDocker,
  type ThrowawayPostgres,
} from './throwaway-postgres';

type MigrationClass = new () => MigrationInterface;

const TRAILING_TIMESTAMP = /\d+$/;
// Comments carry the pg_dump version, and \restrict carries a key that is random per dump.
const VOLATILE_DUMP_LINE = /^(--|\\restrict |\\unrestrict )/;
const MIGRATIONS_TABLE_COUNTER =
  /^SELECT pg_catalog\.setval\('public\.migrations_id_seq'/;

class MarkedIrreversibleFixture9999999999999 extends IrreversibleMigration {
  name = 'MarkedIrreversibleFixture9999999999999';
  irreversibleBecause = 'it is the fixture that proves the refusal';

  async up(queryRunner: QueryRunner) {
    await queryRunner.query(`CREATE TABLE "round_trip_fixture" ("id" integer)`);
  }
}

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

function readDatabase(postgres: ThrowawayPostgres): string {
  const dump = runDocker(
    'exec',
    postgres.containerId,
    'pg_dump',
    '--username',
    SUPERUSER,
    '--exclude-table-data=public.migrations',
    postgres.database,
  );
  return dump
    .split('\n')
    .filter(
      (line) =>
        line.trim() !== '' &&
        !VOLATILE_DUMP_LINE.test(line) &&
        !MIGRATIONS_TABLE_COUNTER.test(line),
    )
    .join('\n');
}

async function expectRoundTrip(migrationsSoFar: MigrationClass[]) {
  // Also creates TypeORM's migrations table before the first baseline.
  await applyPending(migrationsSoFar.slice(0, -1));
  const databaseBefore = readDatabase(throwawayPostgres);
  await applyPending(migrationsSoFar);
  const databaseAfterUp = readDatabase(throwawayPostgres);

  const migration = new migrationsSoFar[migrationsSoFar.length - 1]();
  if (isIrreversible(migration)) {
    await expect(revertLast(migrationsSoFar)).rejects.toThrow(
      migration.irreversibleBecause,
    );
    expect(readDatabase(throwawayPostgres)).toBe(databaseAfterUp);
    return;
  }

  await revertLast(migrationsSoFar);
  expect(readDatabase(throwawayPostgres)).toBe(databaseBefore);

  await applyPending(migrationsSoFar);
  expect(readDatabase(throwawayPostgres)).toBe(databaseAfterUp);
}

describe('every migration, in order, on a database with a row in each table', () => {
  migrationsInOrder.forEach((migrationClass, position) => {
    const migrationsSoFar = migrationsInOrder.slice(0, position + 1);

    it(`${migrationClass.name} goes up, down and up again to the same schema and rows`, async () => {
      await expectRoundTrip(migrationsSoFar);
      await withConnection(migrationsSoFar, (source) =>
        addRowsAfter(migrationClass.name, source),
      );
    });
  });

  it('refuses to revert a migration marked irreversible, and changes nothing', async () => {
    await expectRoundTrip([
      ...migrationsInOrder,
      MarkedIrreversibleFixture9999999999999,
    ]);
  });
});
