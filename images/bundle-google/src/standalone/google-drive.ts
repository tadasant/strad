#!/usr/bin/env node
/**
 * The Google Drive MCP server on its own, without strad. How to run it is
 * `vendor/google-drive-shared/README.md`; the transport and the flags are
 * `./serve.ts`.
 */
import {
  createMCPServer,
  GOOGLE_DRIVE_ENV_NAMES,
  GOOGLE_DRIVE_TOOLGROUPS_ENV,
  parseToolGroups,
} from "google-drive-workspace-mcp-server-shared";
import { serveStandalone } from "./serve.js";

const VERSION = process.env.BUNDLE_GOOGLE_VERSION ?? "0.1.0";

serveStandalone({
  name: "google-drive",
  // The server reads its credential and its tool-group toggle from
  // `process.env` itself, lazily, as it would in a bundle.
  build: () => createMCPServer({ version: VERSION }),
  // `createMCPServer` throws on an unknown group, which would surface per
  // request; refuse it once, at startup, instead.
  validateEnv: (env) => {
    try {
      parseToolGroups(env[GOOGLE_DRIVE_TOOLGROUPS_ENV]);
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  },
  credentialEnv: [...GOOGLE_DRIVE_ENV_NAMES],
}).catch((err: unknown) => {
  console.error("[google-drive] failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
