import { defineConfig } from "vitest/config";

// One shape, shared with every tree under `servers/` that runs Vitest: node
// environment, and a 20s per-test timeout. The two x-twitter configs that drive
// live network calls set a larger bound of their own. Those trees cite this
// file's value as the house standard, so it is written here as what they cite.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
