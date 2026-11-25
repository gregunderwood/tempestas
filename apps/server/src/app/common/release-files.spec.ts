import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PRODUCT_VERSION_FILE,
  RELEASE_ID_FILE,
  readReleaseFile,
} from './release-files';

const makeReleaseDirectory = () => mkdtempSync(join(tmpdir(), 'release-'));

describe('readReleaseFile', () => {
  it('reads the release id the deploy wrote', () => {
    const releaseDirectory = makeReleaseDirectory();
    writeFileSync(
      join(releaseDirectory, RELEASE_ID_FILE),
      '20261121-2245-99bb69e\n',
    );
    expect(readReleaseFile(RELEASE_ID_FILE, releaseDirectory)).toBe(
      '20261121-2245-99bb69e',
    );
  });

  it('reads the product version the deploy wrote', () => {
    const releaseDirectory = makeReleaseDirectory();
    writeFileSync(join(releaseDirectory, PRODUCT_VERSION_FILE), '1.3.0\n');
    expect(readReleaseFile(PRODUCT_VERSION_FILE, releaseDirectory)).toBe(
      '1.3.0',
    );
  });

  it('is null outside a release, so a checkout never claims to be one', () => {
    expect(
      readReleaseFile(PRODUCT_VERSION_FILE, makeReleaseDirectory()),
    ).toBeNull();
  });
});
