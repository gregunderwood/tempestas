import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentApp, type AgentRelease } from '@tempestas/domain';
import { API_PREFIX } from '../common/api-prefix';
import { BUNDLE_FILES_DIRECTORY, MANIFEST_FILE } from './agent-release-bundles';
import { AgentReleasesController } from './agent-releases.controller';
import {
  AGENT_RELEASES_DIRECTORY,
  AgentReleasesService,
} from './agent-releases.service';
import {
  makeAgentReleasesRoot,
  sha256Of,
  writeBundle,
} from './agent-release-bundles.fixtures';

const AGENT_SOURCE = 'class Agent:\n    pass\n';

// Over real HTTP, as the wildcard file route's parameter is shaped by the router, not by Nest.
describe('AgentReleasesController', () => {
  let app: INestApplication;
  let serverOrigin: string;
  let baseUrl: string;
  let bundleDirectory: string;

  beforeAll(async () => {
    const root = makeAgentReleasesRoot();
    bundleDirectory = writeBundle(root, AgentApp.Linux, '1.1.4', {
      'src/tempestas_agent/agent.py': AGENT_SOURCE,
      'src/tempestas_agent/pruned.py': AGENT_SOURCE,
    });
    const testingModule = await Test.createTestingModule({
      controllers: [AgentReleasesController],
      providers: [
        AgentReleasesService,
        { provide: AGENT_RELEASES_DIRECTORY, useValue: root },
      ],
    }).compile();
    app = testingModule.createNestApplication({ logger: false });
    app.setGlobalPrefix(API_PREFIX);
    await app.listen(0, '127.0.0.1');
    serverOrigin = await app.getUrl();
    baseUrl = `${serverOrigin}/${API_PREFIX}/agent-releases`;
  });

  afterAll(() => app.close());

  it('lists the bundles it offers', async () => {
    const releases: AgentRelease[] = await (await fetch(baseUrl)).json();

    expect(releases.map((release) => release.version)).toEqual(['1.1.4']);
  });

  it('serves the manifest byte for byte, so its sha256 is the one listed', async () => {
    const [release]: AgentRelease[] = await (await fetch(baseUrl)).json();
    const manifestUrl = `${serverOrigin}${release.manifestPath}`;

    const served = await (await fetch(manifestUrl)).text();

    expect(served).toBe(
      readFileSync(join(bundleDirectory, MANIFEST_FILE), 'utf8'),
    );
    expect(sha256Of(served)).toBe(release.manifestSha256);
  });

  it('serves a file the manifest lists, at its nested path', async () => {
    const response = await fetch(
      `${baseUrl}/agent-linux/1.1.4/files/src/tempestas_agent/agent.py`,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(AGENT_SOURCE);
  });

  it.each([
    [
      'a file the manifest does not list',
      'agent-linux/1.1.4/files/src/other.py',
    ],
    ['a bundle it does not offer', 'agent-linux/1.1.5/manifest.json'],
    [
      'a path out of the bundle',
      'agent-linux/1.1.4/files/..%2F..%2Fmanifest.json',
    ],
  ])('refuses %s', async (_case, path) => {
    expect((await fetch(`${baseUrl}/${path}`)).status).toBe(404);
  });

  it('answers 404, not its path on disk, for a file removed since it started', async () => {
    rmSync(
      join(
        bundleDirectory,
        BUNDLE_FILES_DIRECTORY,
        'src/tempestas_agent/pruned.py',
      ),
    );

    const response = await fetch(
      `${baseUrl}/agent-linux/1.1.4/files/src/tempestas_agent/pruned.py`,
    );

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(bundleDirectory);
  });
});
