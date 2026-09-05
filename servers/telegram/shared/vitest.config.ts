import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The root's value, and every other tree's. The `servers` matrix in
    // `.github/workflows/ci.yml` runs thirteen legs at once on the one
    // self-hosted box with no `max-parallel`, so Vitest's 5s default is a
    // tighter bound than a contended box can be held to.
    testTimeout: 20_000,
  },
});
