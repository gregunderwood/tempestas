import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readReleaseId } from './release-id';

const inTemporaryDirectory = (fileName: string) =>
  join(mkdtempSync(join(tmpdir(), 'release-')), fileName);

describe('readReleaseId', () => {
  it('reads the id the deploy wrote', () => {
    const releaseIdFile = inTemporaryDirectory('release-id');
    writeFileSync(releaseIdFile, '20261121-2245-99bb69e\n');
    expect(readReleaseId(releaseIdFile)).toBe('20261121-2245-99bb69e');
  });

  it('is null outside a release, so a checkout never claims to be one', () => {
    expect(readReleaseId(inTemporaryDirectory('release-id'))).toBeNull();
  });
});
