import { EXIT_MIGRATIONS_PENDING, runMigrationCommand } from './migrate';

const migrationSource = vi.hoisted(() => ({
  hasPendingMigrations: false,
}));

vi.mock('typeorm', async (importOriginal) => {
  const typeorm = await importOriginal<typeof import('typeorm')>();
  class FakeDataSource {
    async initialize() {
      return this;
    }
    async destroy() {
      return undefined;
    }
    async showMigrations() {
      return migrationSource.hasPendingMigrations;
    }
  }
  return { ...typeorm, DataSource: FakeDataSource };
});

// tools/deploy.sh decides whether to restart the server from these statuses alone.
describe('migrate:show', () => {
  it('exits 0 when nothing is pending', async () => {
    migrationSource.hasPendingMigrations = false;
    expect(await runMigrationCommand('show')).toBe(0);
  });

  it('exits with the pending status when a migration is pending', async () => {
    migrationSource.hasPendingMigrations = true;
    expect(await runMigrationCommand('show')).toBe(EXIT_MIGRATIONS_PENDING);
  });
});
