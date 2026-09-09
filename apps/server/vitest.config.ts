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
      // The parts that control a heater in a greenhouse in winter.
      include: ['src/app/devices/**', 'src/app/rules/**'],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
