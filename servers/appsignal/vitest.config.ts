import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The value every other server tree uses: the `servers` matrix in
    // `.github/workflows/ci.yml` runs every leg at once with no `max-parallel`,
    // each on a small hosted runner, so Vitest's 5s default is a tighter
    // bound than a CI runner can be held to.
    testTimeout: 20_000,
  },
});
