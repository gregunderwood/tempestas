// Writes agent release bundles in the layout tools/deploy.sh leaves, for a stack with the fake driver.
// Usage: node tools/lib/write-fake-agent-releases.mjs <agent-releases folder> <app> <version>...

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BUNDLE_FILES_DIRECTORY = 'files';
const MANIFEST_FILE = 'manifest.json';
const FAKE_AGENT_FILE = 'main.py';

function hashSha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function writeFakeRelease(releasesDirectory, app, version) {
  const bundleDirectory = join(releasesDirectory, app, version);
  const contents = `print("fake ${app} ${version}")\n`;
  mkdirSync(join(bundleDirectory, BUNDLE_FILES_DIRECTORY), { recursive: true });
  writeFileSync(
    join(bundleDirectory, BUNDLE_FILES_DIRECTORY, FAKE_AGENT_FILE),
    contents,
  );
  const [contractMajor, contractMinor] = version.split('.').map(Number);
  const manifest = {
    app,
    version,
    contractMajor,
    contractMinor,
    files: [{ path: FAKE_AGENT_FILE, sha256: hashSha256(contents) }],
  };
  writeFileSync(
    join(bundleDirectory, MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

const [releasesDirectory, app, ...versions] = process.argv.slice(2);
if (!releasesDirectory || !app || versions.length === 0) {
  console.error(
    'Usage: node tools/lib/write-fake-agent-releases.mjs <agent-releases folder> <app> <version>...',
  );
  process.exit(2);
}
for (const version of versions)
  writeFakeRelease(releasesDirectory, app, version);
