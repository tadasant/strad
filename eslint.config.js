import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // servers/** are vendored, self-contained supplementary MCP servers with
  // their own toolchains (see servers/*). They are built and linted in
  // their own image build, not by the core's TS program.
  { ignores: ["dist/**", "node_modules/**", "servers/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Everything here runs on Node: process, console, Buffer, etc.
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Plain-JS helper scripts (*.mjs, eslint config) aren't in the TS program.
    files: ["**/*.mjs", "**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // The config surface is intentionally `unknown`-typed at the edges.
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
);
