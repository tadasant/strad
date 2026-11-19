import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The root's value, matching `servers/secrets/shared`. `node --test` had no
    // per-test timeout at all, and the `servers` matrix runs every leg at
    // once, each on a small hosted runner, so Vitest's 5s default would be the only
    // new way for these to fail.
    testTimeout: 20_000,
  },
});
