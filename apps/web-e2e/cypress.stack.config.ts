import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'cypress';

export interface TestStart {
  title: string;
  seconds: number;
}

const VIDEO_WIDTH = 1920;
const VIDEO_HEIGHT = 1080;
const MILLISECONDS_PER_SECOND = 1000;

// Where each test starts in the spec's video, so tools/pr-video.sh can list them as steps.
function recordTestStarts(
  on: Cypress.PluginEvents,
  videosFolder: string,
): void {
  let specStartedAt = Date.now();
  let testStarts: TestStart[] = [];
  on('before:spec', () => {
    specStartedAt = Date.now();
    testStarts = [];
  });
  on('task', {
    recordTestStart(title: string) {
      const seconds = (Date.now() - specStartedAt) / MILLISECONDS_PER_SECOND;
      testStarts.push({ title, seconds });
      return null;
    },
  });
  on('after:spec', (spec) => {
    mkdirSync(videosFolder, { recursive: true });
    writeFileSync(
      join(videosFolder, `${spec.name}.test-starts.json`),
      `${JSON.stringify(testStarts, null, 2)}\n`,
    );
  });
}

// A bigger window shows the app at full size beside Cypress's command log.
function recordAtFullHd(on: Cypress.PluginEvents): void {
  on('before:browser:launch', (browser, launchOptions) => {
    if (browser.name === 'electron') {
      launchOptions.preferences['width'] = VIDEO_WIDTH;
      launchOptions.preferences['height'] = VIDEO_HEIGHT;
    }
    return launchOptions;
  });
}

// tools/e2e-stack.sh starts the server and web app, and passes the baseUrl they answer on.
export default defineConfig({
  e2e: {
    specPattern: 'src/stack/**/*.cy.ts',
    supportFile: 'src/support/stack.ts',
    fixturesFolder: false,
    screenshotsFolder: '../../dist/cypress/apps/web-e2e/stack/screenshots',
    videosFolder: '../../dist/cypress/apps/web-e2e/stack/videos',
    viewportWidth: 1280,
    viewportHeight: 860,
    // Keeps what a step acts on in the middle of the video, not at its top edge.
    scrollBehavior: 'center',
    setupNodeEvents(on, config) {
      recordTestStarts(on, config.videosFolder);
      recordAtFullHd(on);
    },
  },
});
