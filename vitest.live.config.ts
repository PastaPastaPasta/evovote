import { defineConfig } from 'vitest/config';

/**
 * Opt-in, read-only checks against testnet (`npm run test:live`). They need
 * network access and never broadcast anything.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.live.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // One SDK connection, shared by the tests in order.
    fileParallelism: false,
  },
});
