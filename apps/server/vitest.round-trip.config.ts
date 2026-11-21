import { defineConfig } from 'vite';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';

// Its own target, not `test`: it needs Docker, and each migration builds on the one before.
export default defineConfig({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/apps/server-round-trip',
  plugins: [nxViteTsPaths()],
  test: {
    name: 'server-migration-round-trip',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/migrations/round-trip/**/*.round-trip.ts'],
    globalSetup: ['src/migrations/round-trip/throwaway-postgres.ts'],
    testTimeout: 60_000,
    hookTimeout: 90_000,
    reporters: ['default'],
  },
});
