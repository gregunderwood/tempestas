import { nxE2EPreset } from '@nx/cypress/plugins/cypress-preset';
import { defineConfig } from 'cypress';

export default defineConfig({
  e2e: {
    ...nxE2EPreset(__filename, {
      cypressDir: 'src',
      webServerCommands: {
        default: 'npx nx run web:serve',
        production: 'npx nx run web:serve-static',
      },
      ciWebServerCommand: 'npx nx run web:serve-static',
      ciBaseUrl: 'http://localhost:4200',
    }),
    // The specs in src/stack need the server that tools/e2e-stack.sh starts.
    specPattern: 'src/e2e/**/*.cy.ts',
    baseUrl: 'http://localhost:4200',
    supportFile: false,
  },
});
