import { defineConfig } from "vitest/config";

// The suite lives in `test/`, outside the tsconfig's `include: ["src/**/*.ts"]`,
// so `npm run build` produces exactly the `dist/` it produced before — the image
// copies that directory and nothing else from this tree.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The root's value, and every other tree's. The `servers` matrix in
    // `.github/workflows/ci.yml` runs every leg at once with no `max-parallel`,
    // each on a small hosted runner, so Vitest's 5s default is a tighter
    // bound than a CI runner can be held to.
    testTimeout: 20_000,
  },
});
