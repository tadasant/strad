import { defineConfig } from "vitest/config";

// The suite lives in `test/`, outside the tsconfig's `include: ["src/**/*.ts"]`,
// so `npm run build` produces exactly the `dist/` it produced before — the image
// copies that directory and nothing else from this tree.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The root's value, and every other tree's. The `servers` matrix in
    // `.github/workflows/ci.yml` runs twenty-one legs at once on the one
    // self-hosted box with no `max-parallel`, so Vitest's 5s default is a
    // tighter bound than a contended box can be held to.
    testTimeout: 20_000,
  },
});
