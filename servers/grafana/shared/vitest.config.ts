import { defineConfig } from "vitest/config";

// The suite lives in `test/`, outside the tsconfig's `include: ["src/**/*"]`, so
// `npm run build` emits exactly the `build/` it emitted before — the bundle
// image copies that directory and the pruned `node_modules`, and nothing here
// changes either.
//
// `test/fake-mcp-grafana.mjs` stays `.mjs` and is NOT matched by `include`: the
// upstream supervisor spawns it as a real child process over stdio, so it has to
// be a file node can execute on its own rather than one vitest transforms.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The root's value, and every other tree's. The `servers` matrix in
    // `.github/workflows/ci.yml` runs seventeen legs at once on the one
    // self-hosted box with no `max-parallel`, so Vitest's 5s default is a
    // tighter bound than a contended box can be held to.
    testTimeout: 20_000,
  },
});
