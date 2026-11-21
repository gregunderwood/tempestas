import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as migrations from '..';
import { readMigrationTimestamp } from '../migration-timestamp';

const MIGRATION_FILE = /^(\d+)-\w+\.ts$/;
const byNumber = (first: number, second: number) => first - second;

// The shipped bundle runs only what the barrel lists, while the dev CLI globs the directory.
describe('the migrations barrel', () => {
  it('lists every migration file in the directory', () => {
    const timestampsOnDisk = readdirSync(join(__dirname, '..'))
      .map((fileName) => MIGRATION_FILE.exec(fileName)?.[1])
      .filter((timestamp) => timestamp !== undefined)
      .map(Number)
      .sort(byNumber);
    const timestampsListed = Object.values(migrations)
      .map((migrationClass) => readMigrationTimestamp(migrationClass.name))
      .sort(byNumber);

    expect(timestampsListed).toEqual(timestampsOnDisk);
  });

  // TypeORM records the name field, while the barrel and the round trip go by the class name.
  it('names each migration the same as its class', () => {
    for (const migrationClass of Object.values(migrations)) {
      expect(new migrationClass().name).toBe(migrationClass.name);
    }
  });
});
