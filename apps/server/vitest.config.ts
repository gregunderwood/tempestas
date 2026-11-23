import { defineConfig } from 'vite';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';

// Not vite.config.ts, so @nx/vite does not infer a build target; webpack builds the server.
export default defineConfig({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/apps/server',
  plugins: [nxViteTsPaths()],
  test: {
    name: 'server',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/apps/server',
      provider: 'v8',
      // By directory, so a new decision module is measured the day it lands.
      include: [
        'src/app/devices/**',
        'src/app/rules/**',
        'src/app/agent-releases/**',
      ],
      // Wiring, not decisions; see docs/Testing.md.
      exclude: [
        '**/*.module.ts',
        '**/*.controller.ts',
        '**/dto/**',
        '**/models.ts',
      ],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
