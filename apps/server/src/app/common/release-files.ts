import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Written into each release beside server/ by tools/deploy.sh; absent when run from a checkout.
const RELEASE_DIRECTORY = join(__dirname, '..');
export const RELEASE_ID_FILE = 'release-id';
export const PRODUCT_VERSION_FILE = 'product-version';

export function readReleaseFile(
  fileName: string,
  releaseDirectory = RELEASE_DIRECTORY,
): string | null {
  const releaseFile = join(releaseDirectory, fileName);
  if (!existsSync(releaseFile)) {
    return null;
  }
  return readFileSync(releaseFile, 'utf8').trim() || null;
}
