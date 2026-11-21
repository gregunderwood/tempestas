import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXIT_IRREVERSIBLE_MIGRATIONS_PENDING,
  EXIT_MIGRATIONS_PENDING,
  runMigrationCommand,
} from './migrate';
import { IrreversibleMigration } from './migrations/irreversible-migration';

class DropsLegacyReadings1800000000000 extends IrreversibleMigration {
  name = 'DropsLegacyReadings1800000000000';
  irreversibleBecause = 'it drops a table';
  async up() {
    return undefined;
  }
}

const database = vi.hoisted(() => ({
  pending: [] as { name: string; instance: object }[],
  appliedByRun: [] as { name: string }[],
  newestExecuted: [] as { name: string }[],
  revertedNames: [] as string[],
  wasCommitted: false,
}));

vi.mock('typeorm', async (importOriginal) => {
  const typeorm = await importOriginal<typeof import('typeorm')>();
  class FakeDataSource {
    migrations = [{ name: 'AddA1', down: async () => undefined }];
    async initialize() {
      return this;
    }
    async destroy() {
      return undefined;
    }
    async runMigrations() {
      return database.appliedByRun;
    }
    async query() {
      return database.newestExecuted;
    }
    createQueryRunner() {
      return {
        startTransaction: async () => undefined,
        commitTransaction: async () => {
          database.wasCommitted = true;
        },
        rollbackTransaction: async () => undefined,
        release: async () => undefined,
        query: async (_sql: string, [name]: string[]) => {
          database.revertedNames.push(name);
        },
      };
    }
  }
  class FakeMigrationExecutor {
    async getPendingMigrations() {
      return database.pending;
    }
  }
  return {
    ...typeorm,
    DataSource: FakeDataSource,
    MigrationExecutor: FakeMigrationExecutor,
  };
});

function makeAppliedMigrationsFile(names?: string[]): string {
  const file = join(mkdtempSync(join(tmpdir(), 'applied-')), 'applied.json');
  if (names) {
    writeFileSync(file, JSON.stringify(names));
  }
  return file;
}

const readNames = (file: string): string[] =>
  JSON.parse(readFileSync(file, 'utf8'));

beforeEach(() => {
  database.pending = [];
  database.appliedByRun = [];
  database.newestExecuted = [];
  database.revertedNames = [];
  database.wasCommitted = false;
});

// tools/deploy.sh decides whether to migrate, and whether to ask for a flag, from these statuses alone.
describe('migrate:show', () => {
  it('exits 0 when nothing is pending', async () => {
    expect(await runMigrationCommand('show')).toBe(0);
  });

  it('exits with the pending status when a migration is pending', async () => {
    database.pending = [{ name: 'AddA1', instance: {} }];
    expect(await runMigrationCommand('show')).toBe(EXIT_MIGRATIONS_PENDING);
  });

  it('exits with its own status when a pending migration cannot be reverted', async () => {
    database.pending = [
      { name: 'AddA1', instance: {} },
      {
        name: 'DropsLegacyReadings1800000000000',
        instance: new DropsLegacyReadings1800000000000(),
      },
    ];
    expect(await runMigrationCommand('show')).toBe(
      EXIT_IRREVERSIBLE_MIGRATIONS_PENDING,
    );
  });
});

describe('migrate:run', () => {
  it('records what it applied beside what this release applied before', async () => {
    const appliedMigrationsFile = makeAppliedMigrationsFile(['AddA1']);
    database.appliedByRun = [{ name: 'AddB2' }];

    await runMigrationCommand('run', { appliedMigrationsFile });

    expect(readNames(appliedMigrationsFile)).toEqual(['AddA1', 'AddB2']);
  });

  // A second run with nothing pending must not make the release forget what it applied.
  it('keeps the record when nothing was pending', async () => {
    const appliedMigrationsFile = makeAppliedMigrationsFile(['AddA1']);

    await runMigrationCommand('run', { appliedMigrationsFile });

    expect(readNames(appliedMigrationsFile)).toEqual(['AddA1']);
  });
});

describe('migrate:revert-applied', () => {
  it('does nothing when this release applied nothing', async () => {
    const appliedMigrationsFile = makeAppliedMigrationsFile();

    expect(
      await runMigrationCommand('revert-applied', { appliedMigrationsFile }),
    ).toBe(0);
    expect(database.wasCommitted).toBe(false);
  });

  it('reverts what this release applied, and then forgets it', async () => {
    const appliedMigrationsFile = makeAppliedMigrationsFile(['AddA1']);
    database.newestExecuted = [{ name: 'AddA1' }];

    await runMigrationCommand('revert-applied', { appliedMigrationsFile });

    expect(database.revertedNames).toEqual(['AddA1']);
    expect(database.wasCommitted).toBe(true);
    expect(readNames(appliedMigrationsFile)).toEqual([]);
  });

  it('refuses when something newer was applied since', async () => {
    const appliedMigrationsFile = makeAppliedMigrationsFile(['AddA1']);
    database.newestExecuted = [{ name: 'AddLater9' }];

    await expect(
      runMigrationCommand('revert-applied', { appliedMigrationsFile }),
    ).rejects.toThrow(/revert by hand/);
    expect(database.wasCommitted).toBe(false);
    expect(readNames(appliedMigrationsFile)).toEqual(['AddA1']);
  });
});

it('refuses a command it does not know, before connecting', async () => {
  expect(await runMigrationCommand('drop-everything')).toBe(2);
});
