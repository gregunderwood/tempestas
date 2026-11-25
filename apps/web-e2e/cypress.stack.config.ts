import { defineConfig } from 'cypress';

// tools/e2e-stack.sh starts the server and web app, and passes the baseUrl they answer on.
export default defineConfig({
  e2e: {
    specPattern: 'src/stack/**/*.cy.ts',
    supportFile: false,
    fixturesFolder: false,
    screenshotsFolder: '../../dist/cypress/apps/web-e2e/stack/screenshots',
    videosFolder: '../../dist/cypress/apps/web-e2e/stack/videos',
    viewportWidth: 1280,
    viewportHeight: 860,
  },
});
