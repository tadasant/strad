import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The root's value, and the other converted trees'. It is load-bearing here
    // rather than precautionary: the date-grid fan-out throttles for real —
    // getDateGrid sleeps 1.5s between requests — so four tests take 1.5-4.5s,
    // two of them 4.5s, and Vitest's 5s default would leave them no room.
    testTimeout: 20_000,
  },
});
