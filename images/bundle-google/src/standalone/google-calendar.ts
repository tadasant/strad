#!/usr/bin/env node
/**
 * The Google Calendar MCP server on its own, without strad. How to run it is
 * `vendor/google-calendar-shared/README.md`; the transport and the flags are
 * `./serve.ts`.
 */
import { createMCPServer } from "google-calendar-workspace-mcp-server-shared";
import { serveStandalone } from "./serve.js";

const VERSION = process.env.BUNDLE_GOOGLE_VERSION ?? "0.1.0";

serveStandalone({
  name: "google-calendar",
  // The same factory, and the same namespaced tool-group toggle, as the
  // `/google-calendar` mount in `src/index.ts`.
  build: () =>
    createMCPServer({
      version: VERSION,
      enabledToolGroups: process.env.GOOGLE_CALENDAR_ENABLED_TOOLGROUPS,
    }),
  credentialEnv: [
    "GCAL_SERVICE_ACCOUNT_CLIENT_EMAIL",
    "GCAL_SERVICE_ACCOUNT_PRIVATE_KEY",
    "GCAL_IMPERSONATE_EMAIL",
  ],
}).catch((err: unknown) => {
  console.error("[google-calendar] failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
