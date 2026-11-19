import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The root's value, and every other tree's: CI runs every job on a small
    // hosted runner, so Vitest's 5s default is a tighter bound than a CI
    // runner can be held to. The browser suite's `beforeAll` carries its
    // own longer bound, because it launches a Chromium.
    testTimeout: 20_000,
  },
});
