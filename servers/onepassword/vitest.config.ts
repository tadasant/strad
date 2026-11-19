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
    // `.github/workflows/ci.yml` runs every leg at once with no `max-parallel`,
    // each on a small hosted runner, so Vitest's 5s default is a tighter
    // bound than a CI runner can be held to.
    testTimeout: 20_000,
  },
});
