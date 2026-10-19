#!/usr/bin/env node
/**
 * The Google Docs MCP server on its own, without strad. How to run it is
 * `vendor/google-docs-shared/README.md`; the transport and the flags are
 * `./serve.ts`.
 */
import { parseEnabledToolGroups } from "google-docs-workspace-mcp-server-shared";
import { createMCPServer, missingCredentials } from "../docs.js";
import { serveStandalone } from "./serve.js";

const VERSION = process.env.BUNDLE_GOOGLE_VERSION ?? "0.1.0";

serveStandalone({
  name: "google-docs",
  // The same factory as the `/google-docs` mount in `src/index.ts`. It reads
  // its credential and GOOGLE_DOCS_ENABLED_TOOLGROUPS from `process.env`,
  // lazily, as it would in a bundle.
  build: () => createMCPServer({ version: VERSION }),
  // The vendored parser throws on an unknown group rather than widening to
  // every group, but it throws per request; refuse it once, at startup.
  validateEnv: (env) => {
    try {
      parseEnabledToolGroups(env.GOOGLE_DOCS_ENABLED_TOOLGROUPS);
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  },
  // What this environment is short of, in the auth mode it has started: the
  // OAuth trio once any of them is set, else the service account's three.
  credentialEnv: missingCredentials,
}).catch((err: unknown) => {
  console.error("[google-docs] failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
