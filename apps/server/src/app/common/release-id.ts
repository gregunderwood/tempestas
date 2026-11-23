import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Written into each release by tools/deploy.sh, beside server/; absent when run from a checkout.
const RELEASE_ID_FILE = join(__dirname, '..', 'release-id');

export function readReleaseId(releaseIdFile = RELEASE_ID_FILE): string | null {
  if (!existsSync(releaseIdFile)) {
    return null;
  }
  return readFileSync(releaseIdFile, 'utf8').trim() || null;
}
