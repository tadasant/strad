import { defineConfig } from "vitest/config";

// No `esbuild` block: Vitest 4 transforms with oxc, which reads none of the
// esbuild options and warns on every run when they are set. A target belongs to
// `npm run build`'s tsconfig, which is what actually emits this tree.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/functional/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/build/**", "**/integration/**"],
    // The root's value, and every other tree's. The `servers` matrix in
    // `.github/workflows/ci.yml` runs seventeen legs at once on the one
    // self-hosted box with no `max-parallel`, so Vitest's 5s default is a
    // tighter bound than a contended box can be held to.
    testTimeout: 20_000,
  },
});
