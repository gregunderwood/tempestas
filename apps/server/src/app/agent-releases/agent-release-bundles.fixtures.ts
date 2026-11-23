import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentReleaseManifest } from '@tempestas/domain';
import { BUNDLE_FILES_DIRECTORY, MANIFEST_FILE } from './agent-release-bundles';

export function sha256Of(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function makeAgentReleasesRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agent-releases-'));
}

/** Writes a bundle as tools/deploy.sh lays it out; `manifestChanges` breaks it on purpose. */
export function writeBundle(
  root: string,
  app: string,
  version: string,
  files: Record<string, string> = { 'main.py': 'print("hello")\n' },
  manifestChanges: Partial<AgentReleaseManifest> = {},
): string {
  const bundleDirectory = join(root, app, version);
  for (const [path, contents] of Object.entries(files)) {
    const onDisk = join(bundleDirectory, BUNDLE_FILES_DIRECTORY, path);
    mkdirSync(dirname(onDisk), { recursive: true });
    writeFileSync(onDisk, contents);
  }
  const [contractMajor, contractMinor] = version.split('.').map(Number);
  const manifest = {
    app,
    version,
    contractMajor,
    contractMinor,
    files: Object.entries(files).map(([path, contents]) => ({
      path,
      sha256: sha256Of(contents),
    })),
    ...manifestChanges,
  };
  writeFileSync(
    join(bundleDirectory, MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return bundleDirectory;
}
