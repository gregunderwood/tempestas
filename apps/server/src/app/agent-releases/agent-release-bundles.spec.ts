import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentApp } from '@tempestas/domain';
import {
  BUNDLE_FILES_DIRECTORY,
  MANIFEST_FILE,
  readVerifiedBundles,
} from './agent-release-bundles';
import {
  makeAgentReleasesRoot,
  sha256Of,
  writeBundle,
} from './agent-release-test-bundles';

async function readBundles(root: string) {
  const rejections: string[] = [];
  const bundles = await readVerifiedBundles(root, (_directory, reason) =>
    rejections.push(reason),
  );
  return { bundles, rejections };
}

describe('readVerifiedBundles', () => {
  it('offers a bundle whose files match its manifest, pinned by the manifest bytes', async () => {
    const root = makeAgentReleasesRoot();
    const bundleDirectory = writeBundle(root, AgentApp.Linux, '1.1.4', {
      'src/tempestas_agent/agent.py': 'agent\n',
    });

    const { bundles, rejections } = await readBundles(root);

    expect(rejections).toEqual([]);
    expect(bundles.map((bundle) => bundle.release)).toEqual([
      {
        app: AgentApp.Linux,
        version: '1.1.4',
        contractMajor: 1,
        contractMinor: 1,
        manifestPath: '/api/agent-releases/agent-linux/1.1.4/manifest.json',
        manifestSha256: sha256Of(
          readFileSync(join(bundleDirectory, MANIFEST_FILE), 'utf8'),
        ),
      },
    ]);
    expect([...bundles[0].filesByPath.keys()]).toEqual([
      'src/tempestas_agent/agent.py',
    ]);
  });

  it('leaves out a bundle whose file was changed after the manifest', async () => {
    const root = makeAgentReleasesRoot();
    const bundleDirectory = writeBundle(root, AgentApp.Linux, '1.1.4');
    writeFileSync(
      join(bundleDirectory, BUNDLE_FILES_DIRECTORY, 'main.py'),
      'tampered\n',
    );

    const { bundles, rejections } = await readBundles(root);

    expect(bundles).toEqual([]);
    expect(rejections).toEqual([
      'main.py does not have the sha256 the manifest gives',
    ]);
  });

  it('leaves out a bundle missing a listed file', async () => {
    const root = makeAgentReleasesRoot();
    const bundleDirectory = writeBundle(root, AgentApp.Linux, '1.1.4');
    renameSync(
      join(bundleDirectory, BUNDLE_FILES_DIRECTORY, 'main.py'),
      join(bundleDirectory, 'elsewhere.py'),
    );

    expect((await readBundles(root)).rejections).toEqual([
      'main.py is listed but missing',
    ]);
  });

  it.each([
    [
      'a path out of the bundle',
      { files: [{ path: '../etc/passwd', sha256: 'a'.repeat(64) }] },
    ],
    [
      'an absolute path',
      { files: [{ path: '/etc/passwd', sha256: 'a'.repeat(64) }] },
    ],
    ['another app', { app: AgentApp.MicroPython }],
    ['another version', { version: '1.1.5' }],
    ['a -dev version', { version: '1.1.4-dev+ecdbbe7' }],
    ['a contract that disagrees with the version', { contractMinor: 0 }],
    ['no files', { files: [] }],
  ])('leaves out a manifest with %s', async (_case, manifestChanges) => {
    const root = makeAgentReleasesRoot();
    writeBundle(root, AgentApp.Linux, '1.1.4', undefined, manifestChanges);

    const { bundles, rejections } = await readBundles(root);

    expect(bundles).toEqual([]);
    expect(rejections).toHaveLength(1);
  });

  it('skips a bundle still being shipped, under its dot-name', async () => {
    const root = makeAgentReleasesRoot();
    writeBundle(root, AgentApp.Linux, '.1.1.4');

    expect(await readBundles(root)).toEqual({ bundles: [], rejections: [] });
  });

  it('offers nothing, quietly, when there is no directory yet', async () => {
    expect(await readBundles(join(makeAgentReleasesRoot(), 'missing'))).toEqual(
      {
        bundles: [],
        rejections: [],
      },
    );
  });
});
