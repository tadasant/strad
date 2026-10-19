#!/usr/bin/env node
/**
 * The Google Docs MCP server on its own, without strad. How to run it is
 * `vendor/google-docs-shared/README.md`; the transport and the flags are
 * `./serve.ts`.
 */
import { parseEnabledToolGroups } from "google-docs-workspace-mcp-server-shared";
import {
  createMCPServer,
  GOOGLE_DOCS_OAUTH_ENV_NAMES,
  GOOGLE_DOCS_SERVICE_ACCOUNT_ENV_NAMES,
  missingCredentials,
} from "../docs.js";
import { serveStandalone } from "./serve.js";

const VERSION = process.env.BUNDLE_GOOGLE_VERSION ?? "0.1.0";

serveStandalone({
  name: "google-docs",
  // The same factory as the `/google-docs` mount in `src/index.ts`. It reads
  // its credential and GOOGLE_DOCS_ENABLED_TOOLGROUPS from `process.env`,
  // lazily, as it would in a bundle.
  build: () => createMCPServer({ version: VERSION }),
  validateEnv: (env) => {
    // The vendored parser throws on an unknown group rather than widening to
    // every group, but it throws per request; refuse it once, at startup.
    try {
      parseEnabledToolGroups(env.GOOGLE_DOCS_ENABLED_TOOLGROUPS);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    // A half-set OAuth trio beside a complete service account is a working
    // mount, as the Workspace user, with nothing printed: the person who set
    // an OAuth variable meant their own account. Refuse it here rather than
    // serve the wrong account's documents.
    const oauthMissing = GOOGLE_DOCS_OAUTH_ENV_NAMES.filter((name) => !env[name]);
    const oauthStarted = GOOGLE_DOCS_OAUTH_ENV_NAMES.some((name) => env[name]);
    const serviceAccount = GOOGLE_DOCS_SERVICE_ACCOUNT_ENV_NAMES.every((name) => env[name]);
    if (oauthStarted && oauthMissing.length > 0 && serviceAccount) {
      return (
        `${oauthMissing.join(", ")} not set, so this would serve the service account's ` +
        `user (GOOGLE_DOCS_IMPERSONATE_EMAIL), not the OAuth account. Set all three ` +
        `GOOGLE_DOCS_OAUTH_* variables, or unset them to use the service account.`
      );
    }
    return undefined;
  },
  // What this environment is short of, in the auth mode it has started: the
  // OAuth trio once any of them is set, else the service account's three.
  credentialEnv: missingCredentials,
}).catch((err: unknown) => {
  console.error("[google-docs] failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
