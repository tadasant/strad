import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The date-grid fan-out throttles for real: getDateGrid sleeps 1.5s between
    // requests, so the four tests that drive it take 1.5-4.5s each. Vitest's
    // default per-test timeout is 5s, which those would sit under only just.
    testTimeout: 30_000,
  },
});
