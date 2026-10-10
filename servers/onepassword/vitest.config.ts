import { defineConfig } from "vitest/config";

// Tests live at the TREE root, not inside `shared/`. `shared/` is a verbatim
// vendor copy of pulsemcp/mcp-servers (HACKS.md #15) and re-vendoring overwrites
// it, so a test file added there would be a merge conflict on every re-vendor.
// From here the suite imports the vendored TypeScript sources directly.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The root's value, and every other tree's. The `servers` matrix in
    // `.github/workflows/ci.yml` runs twenty legs at once on the one
    // self-hosted box with no `max-parallel`, so Vitest's 5s default is a
    // tighter bound than a contended box can be held to.
    testTimeout: 20_000,
  },
});
