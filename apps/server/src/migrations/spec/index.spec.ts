import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as migrations from '..';

const MIGRATION_FILE = /^(\d+)-\w+\.ts$/;
const TRAILING_TIMESTAMP = /\d+$/;

// The shipped bundle runs only what the barrel lists, while the dev CLI globs the directory.
describe('the migrations barrel', () => {
  it('lists every migration file in the directory', () => {
    const timestampsOnDisk = readdirSync(join(__dirname, '..'))
      .map((fileName) => MIGRATION_FILE.exec(fileName)?.[1])
      .filter((timestamp) => timestamp !== undefined)
      .sort();
    const timestampsListed = Object.values(migrations)
      .map(
        (migrationClass) => TRAILING_TIMESTAMP.exec(migrationClass.name)?.[0],
      )
      .sort();

    expect(timestampsListed).toEqual(timestampsOnDisk);
  });
});
