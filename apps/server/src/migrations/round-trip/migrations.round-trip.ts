import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inject } from 'vitest';
import { DataSource, type QueryRunner } from 'typeorm';
import { postgresConnectionOptions } from '../../app/common/postgres-connection';
import * as migrations from '..';
import {
  AddNodeAgentName1795330000000,
  AddPicoNodeKind1795220722652,
} from '..';
import {
  EXIT_MIGRATIONS_PENDING,
  revertMigrations,
  runMigrationCommand,
} from '../../migrate';
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
const COMMAND_DATABASE = 'command_cycle';

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
  return new DataSource({
    ...postgresConnectionOptions(readSettingFor(database)),
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

// The transaction mode tempestas-migrate@run uses, and the revert tempestas-migrate@revert-applied uses.
const applyPending = (migrationsSoFar: MigrationClass[]) =>
  withConnection(migrationsSoFar, (source) =>
    source.runMigrations({ transaction: 'all' }),
  );

const revertNewest = (
  migrationsSoFar: MigrationClass[],
  newestFirst: MigrationClass[],
  database?: string,
) =>
  withConnection(
    migrationsSoFar,
    (source) =>
      revertMigrations(
        source,
        newestFirst.map((migrationClass) => migrationClass.name),
      ),
    database,
  );

const revertLast = (migrationsSoFar: MigrationClass[], database?: string) =>
  revertNewest(migrationsSoFar, migrationsSoFar.slice(-1), database);

function readSettingFor(database: string) {
  const settings: Record<string, string> = {
    DATABASE_HOST: '127.0.0.1',
    DATABASE_PORT: String(throwawayPostgres.port),
    DATABASE_USER: throwawayPostgres.username,
    DATABASE_PASSWORD: throwawayPostgres.password,
    DATABASE_NAME: database,
  };
  return (name: string) => settings[name];
}

function readDump(database: string, ...dumpOptions: string[]): string {
  const dump = runDocker(
    'exec',
    throwawayPostgres.containerId,
    'pg_dump',
    '--username',
    SUPERUSER,
    ...dumpOptions,
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

const readDatabase = (database = MAIN_DATABASE) =>
  readDump(database, '--exclude-table-data=public.migrations');

const readSchema = (database = MAIN_DATABASE) =>
  readDump(database, '--schema-only');

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

// Returns the schema from before the migration, for the revert over new rows to return to.
async function expectRoundTrip(migrationsSoFar: MigrationClass[]) {
  // Also creates TypeORM's migrations table before the first baseline.
  await applyPending(migrationsSoFar.slice(0, -1));
  const schemaBefore = readSchema();
  const databaseBefore = readDatabase();
  await applyPending(migrationsSoFar);
  const databaseAfterUp = readDatabase();

  const migration = new migrationsSoFar[migrationsSoFar.length - 1]();
  if (isIrreversible(migration)) {
    await expect(revertLast(migrationsSoFar)).rejects.toThrow(
      migration.irreversibleBecause,
    );
    expect(readDatabase()).toBe(databaseAfterUp);
    return schemaBefore;
  }

  await revertLast(migrationsSoFar);
  expect(readDatabase()).toBe(databaseBefore);

  await applyPending(migrationsSoFar);
  expect(readDatabase()).toBe(databaseAfterUp);
  return schemaBefore;
}

async function expectRevertOverNewRows(
  migrationsSoFar: MigrationClass[],
  newRows: RowsOnlyNewCodeWrites,
  schemaBefore: string,
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
      expect(readSchema(copy)).toBe(schemaBefore);
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
    let schemaBefore: string | undefined;

    it(`${migrationClass.name} goes up, down and up again to the same schema and rows`, async () => {
      schemaBefore = await expectRoundTrip(migrationsSoFar);
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
      if (schemaBefore === undefined) {
        throw new Error(
          `Run ${migrationClass.name}'s round trip first: this check starts from the database it leaves`,
        );
      }
      await expectRevertOverNewRows(migrationsSoFar, newRows, schemaBefore);
    });
  });

  // A rollback over a deploy that applied several must never stop between them.
  it('reverts several migrations all together or not at all', async () => {
    await withCopyOfMainDatabase(async (copy) => {
      await withConnection(
        migrationsInOrder,
        (source) =>
          source.query(
            `INSERT INTO nodes (slug, display_name, kind, capabilities) VALUES ('braize', 'Braize', 'pico', '{}')`,
          ),
        copy,
      );
      const copyBeforeRevert = readDatabase(copy);

      await expect(
        revertNewest(
          migrationsInOrder,
          [AddNodeAgentName1795330000000, AddPicoNodeKind1795220722652],
          copy,
        ),
      ).rejects.toThrow(/braize/);
      expect(readDatabase(copy)).toBe(copyBeforeRevert);
    });
  });

  it('shows, runs and reverts what it applied through the commands the units call', async () => {
    runAsSuperuser(
      throwawayPostgres.containerId,
      `CREATE DATABASE ${COMMAND_DATABASE} OWNER ${throwawayPostgres.username}`,
    );
    const options = {
      readSetting: readSettingFor(COMMAND_DATABASE),
      appliedMigrationsFile: join(
        mkdtempSync(join(tmpdir(), 'release-')),
        'applied-migrations.json',
      ),
    };
    expect(await runMigrationCommand('show', options)).toBe(
      EXIT_MIGRATIONS_PENDING,
    );
    // After show, whose connection installs pgcrypto as the server's does, and with TypeORM's own table.
    await withConnection(
      [],
      (source) => source.runMigrations(),
      COMMAND_DATABASE,
    );
    const schemaBeforeAnyMigration = readSchema(COMMAND_DATABASE);

    await runMigrationCommand('run', options);
    expect(await runMigrationCommand('show', options)).toBe(0);
    expect(
      JSON.parse(readFileSync(options.appliedMigrationsFile, 'utf8')),
    ).toEqual(migrationsInOrder.map((migrationClass) => migrationClass.name));

    await runMigrationCommand('revert-applied', options);
    expect(await runMigrationCommand('show', options)).toBe(
      EXIT_MIGRATIONS_PENDING,
    );
    expect(readSchema(COMMAND_DATABASE)).toBe(schemaBeforeAnyMigration);
  });

  it('refuses to revert a migration marked irreversible, and changes nothing', async () => {
    await expectRoundTrip([
      ...migrationsInOrder,
      MarkedIrreversibleFixture9999999999999,
    ]);
  });
});
