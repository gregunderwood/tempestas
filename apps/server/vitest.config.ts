import { defineConfig } from 'vite';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';

// Named vitest.config.ts rather than vite.config.ts so the @nx/vite plugin does
// not also infer a `build` target here - the server is built by webpack.
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
      // The parts that control a heater in a greenhouse in winter. Broad by
      // directory on purpose, so a new decision module is measured the day it
      // lands rather than the day somebody remembers to list it.
      include: ['src/app/devices/**', 'src/app/rules/**'],
      // Wiring, not decisions. A controller here is one line of delegation, a
      // DTO is a declaration and an entity is a schema - counting them makes
      // the number describe how much boilerplate exists rather than whether the
      // interlocks are tested, which is the only thing this threshold is for.
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
