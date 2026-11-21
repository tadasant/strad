import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Starts a real Postgres in Docker (or uses POSTGRES_TEST_ADMIN_URL).
    globalSetup: ["test/global-setup.ts"],
    // The root's value, and every other tree's. The `servers` matrix in
    // `.github/workflows/ci.yml` runs every leg at once with no `max-parallel`,
    // each on a small hosted runner, so Vitest's 5s default is a tighter
    // bound than a CI runner can be held to.
    testTimeout: 20_000,
    hookTimeout: 90_000,
  },
});
