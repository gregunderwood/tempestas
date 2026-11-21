import { inject } from 'vitest';
import { DataSource, type QueryRunner } from 'typeorm';
import { postgresConnectionOptions } from '../../app/common/postgres-connection';
import * as migrations from '..';
import {
  IrreversibleMigration,
  isIrreversible,
} from '../irreversible-migration';
import {
  readMigrationTimestamp,
  type MigrationClass,
} from '../migration-timestamp';
import { addRowsAfter, runStatements } from './rows-added-after';
import {
  ROWS_ONLY_NEW_CODE_WRITES,
  type RowsOnlyNewCodeWrites,
} from './rows-only-new-code-writes';
import { SUPERUSER, runAsSuperuser, runDocker } from './throwaway-postgres';

// Comments carry the pg_dump version, and \restrict carries a key that is random per dump.
const VOLATILE_DUMP_LINE = /^(--|\\restrict |\\unrestrict )/;
const MIGRATIONS_TABLE_COUNTER =
  /^SELECT pg_catalog\.setval\('public\.migrations_id_seq'/;
const ROLLBACK_COPY = 'rollback_copy';

class MarkedIrreversibleFixture9999999999999 extends IrreversibleMigration {
  name = 'MarkedIrreversibleFixture9999999999999';
  irreversibleBecause = 'it is the fixture that proves the refusal';

  async up(queryRunner: QueryRunner) {
    await queryRunner.query(`CREATE TABLE "round_trip_fixture" ("id" integer)`);
  }
}

const throwawayPostgres = inject('throwawayPostgres');
const MAIN_DATABASE = throwawayPostgres.database;

const migrationsInOrder: MigrationClass[] = Object.values(migrations).sort(
  (first, second) =>
    readMigrationTimestamp(first.name) - readMigrationTimestamp(second.name),
);

function connectWith(
  migrationsSoFar: MigrationClass[],
  database: string,
): DataSource {
  const settings: Record<string, string> = {
    DATABASE_HOST: '127.0.0.1',
    DATABASE_PORT: String(throwawayPostgres.port),
    DATABASE_USER: throwawayPostgres.username,
    DATABASE_PASSWORD: throwawayPostgres.password,
    DATABASE_NAME: database,
  };
  return new DataSource({
    ...postgresConnectionOptions((name) => settings[name]),
    migrations: migrationsSoFar,
  });
}

async function withConnection(
  migrationsSoFar: MigrationClass[],
  action: (source: DataSource) => Promise<unknown>,
  database = MAIN_DATABASE,
) {
  const source = await connectWith(migrationsSoFar, database).initialize();
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

const revertLast = (migrationsSoFar: MigrationClass[], database?: string) =>
  withConnection(
    migrationsSoFar,
    (source) => source.undoLastMigration({ transaction: 'each' }),
    database,
  );

function readDatabase(database = MAIN_DATABASE): string {
  const dump = runDocker(
    'exec',
    throwawayPostgres.containerId,
    'pg_dump',
    '--username',
    SUPERUSER,
    '--exclude-table-data=public.migrations',
    database,
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

// A copy, so a revert that succeeds over the new rows leaves the chain for the next migration untouched.
async function withCopyOfMainDatabase(action: (copy: string) => Promise<void>) {
  runAsSuperuser(
    throwawayPostgres.containerId,
    `CREATE DATABASE ${ROLLBACK_COPY} TEMPLATE ${MAIN_DATABASE} OWNER ${throwawayPostgres.username}`,
  );
  try {
    await action(ROLLBACK_COPY);
  } finally {
    runAsSuperuser(
      throwawayPostgres.containerId,
      `DROP DATABASE ${ROLLBACK_COPY} WITH (FORCE)`,
    );
  }
}

async function expectRoundTrip(migrationsSoFar: MigrationClass[]) {
  // Also creates TypeORM's migrations table before the first baseline.
  await applyPending(migrationsSoFar.slice(0, -1));
  const databaseBefore = readDatabase();
  await applyPending(migrationsSoFar);
  const databaseAfterUp = readDatabase();

  const migration = new migrationsSoFar[migrationsSoFar.length - 1]();
  if (isIrreversible(migration)) {
    await expect(revertLast(migrationsSoFar)).rejects.toThrow(
      migration.irreversibleBecause,
    );
    expect(readDatabase()).toBe(databaseAfterUp);
    return;
  }

  await revertLast(migrationsSoFar);
  expect(readDatabase()).toBe(databaseBefore);

  await applyPending(migrationsSoFar);
  expect(readDatabase()).toBe(databaseAfterUp);
}

async function expectRevertOverNewRows(
  migrationsSoFar: MigrationClass[],
  newRows: RowsOnlyNewCodeWrites,
) {
  await withCopyOfMainDatabase(async (copy) => {
    await withConnection(
      migrationsSoFar,
      (source) => runStatements(newRows.statements, source),
      copy,
    );
    const copyWithNewRows = readDatabase(copy);

    if (newRows.revert.outcome === 'reverts') {
      await revertLast(migrationsSoFar, copy);
      return;
    }
    await expect(revertLast(migrationsSoFar, copy)).rejects.toThrow(
      newRows.revert.namingThem,
    );
    expect(readDatabase(copy)).toBe(copyWithNewRows);
  });
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

    it(`${migrationClass.name} reverts, or refuses by name, over rows only its new code writes`, async () => {
      const newRows = ROWS_ONLY_NEW_CODE_WRITES.get(migrationClass.name);
      if (!newRows) {
        throw new Error(
          `Say in rows-only-new-code-writes.ts which rows only ${migrationClass.name}'s new code writes, and whether its down reverts or refuses them`,
        );
      }
      await expectRevertOverNewRows(migrationsSoFar, newRows);
    });
  });

  it('refuses to revert a migration marked irreversible, and changes nothing', async () => {
    await expectRoundTrip([
      ...migrationsInOrder,
      MarkedIrreversibleFixture9999999999999,
    ]);
  });
});
