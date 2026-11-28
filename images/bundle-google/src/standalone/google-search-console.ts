#!/usr/bin/env node
/**
 * The Google Search Console MCP server on its own, without strad. How to run it
 * is `vendor/google-search-console-shared/README.md`; the transport and the
 * flags are `./serve.ts`.
 */
import {
  createMCPServer,
  GOOGLE_SEARCH_CONSOLE_ENV_NAMES,
} from "google-search-console-workspace-mcp-server-shared";
import { serveStandalone } from "./serve.js";

const VERSION = process.env.BUNDLE_GOOGLE_VERSION ?? "0.1.0";

serveStandalone({
  name: "google-search-console",
  // The server reads its credential from `process.env` itself, lazily, as it
  // would in a bundle. There is no tool-group toggle: every tool reads.
  build: () => createMCPServer({ version: VERSION }),
  credentialEnv: [...GOOGLE_SEARCH_CONSOLE_ENV_NAMES],
}).catch((err: unknown) => {
  console.error("[google-search-console] failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
