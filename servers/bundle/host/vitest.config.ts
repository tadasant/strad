import { defineConfig } from "vitest/config";

// The suite lives in `test/`, outside the tsconfig's `include: ["src/**/*.ts"]`,
// so `npm run build` produces exactly the `dist/` it produced before — the image
// copies that directory and nothing else from this tree.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
