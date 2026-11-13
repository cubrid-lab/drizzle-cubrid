import { defineConfig } from 'vitest/config';

// Live CUBRID tests only (`npm run integration`). The default config excludes
// this file so `npm test` never needs a database.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration.test.ts'],
    // Each file shares one server; run the statements of one file in order.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
