#!/usr/bin/env node
/**
 * The Gmail MCP server on its own, without strad. How to run it is
 * `vendor/gmail-shared/README.md`; the transport and the flags are
 * `./serve.ts`.
 *
 * ## It does not send mail
 *
 * In strad, `send_email` asks a human first: core reads the caller's
 * `X-Elicitation-Url`, holds it to an allowlist, and hands it to this server as
 * `_meta["dev.strad/elicitation"]` on the `tools/call` (`../confirm.ts`). That
 * key is trusted because core never forwards a client's own `_meta`. Standalone,
 * there is no core: the `_meta` on a call is whatever the client wrote, so a
 * client could claim core's `skip` waiver and send with nobody asked, or name
 * any URL as the approval endpoint. And without the key, every send is refused.
 *
 * So the `readwrite_external` group, the one that holds `send_email`, is
 * refused at startup rather than served. A draft is the standalone way to
 * write mail: `upsert_draft_email` saves it, and a person sends it from Gmail.
 * The mailbox the tools are handed refuses to send as well, so a tool that
 * reaches a send from another group is refused there too.
 */
import type { IGmailClient } from "gmail-workspace-mcp-server-shared";
import {
  createDefaultClient,
  createMCPServer,
  GMAIL_OAUTH_ENV_NAMES,
  GMAIL_SERVICE_ACCOUNT_ENV_NAMES,
  missingCredentials,
} from "../gmail.js";
import { serveStandalone } from "./serve.js";

const VERSION = process.env.BUNDLE_GOOGLE_VERSION ?? "0.1.0";

/** The groups a standalone server may serve. */
const STANDALONE_GROUPS = ["readonly", "readwrite"] as const;
/** What an unset `GMAIL_ENABLED_TOOLGROUPS` means here: read, label and draft. */
const DEFAULT_GROUPS = "readonly,readwrite";

/** The mailbox's two methods that send. */
const SENDS = new Set(["sendMessage", "sendDraft"]);

/** The mailbox, with both sends refused before they mint a token. */
function withoutSends(client: IGmailClient): IGmailClient {
  return new Proxy(client, {
    get(t, prop, receiver) {
      const value: unknown = Reflect.get(t, prop, receiver);
      if (typeof value !== "function") return value;
      if (typeof prop === "string" && SENDS.has(prop)) {
        return () => Promise.reject(new Error("the standalone gmail server does not send mail; nothing was sent"));
      }
      return (value as (...args: unknown[]) => unknown).bind(t);
    },
  });
}

/**
 * `GMAIL_ENABLED_TOOLGROUPS` as this entrypoint serves it, or the reason it
 * will not. Never empty: the vendored parser reads an empty value, and a value
 * naming no known group, as EVERY group, `send_email` included.
 */
function enabledGroups(raw: string | undefined): { groups: string } | { invalid: string } {
  if (raw === undefined || raw.trim() === "") return { groups: DEFAULT_GROUPS };
  const requested = raw
    .split(",")
    .map((g) => g.trim().toLowerCase())
    .filter((g) => g !== "");
  if (requested.length === 0) {
    return { invalid: `GMAIL_ENABLED_TOOLGROUPS="${raw}" names no group. Valid groups: ${STANDALONE_GROUPS.join(", ")}.` };
  }
  if (requested.includes("readwrite_external")) {
    return {
      invalid:
        "GMAIL_ENABLED_TOOLGROUPS includes readwrite_external, which holds send_email. " +
        "The standalone server does not send mail: in strad a human confirms every send " +
        "through the gateway, and on its own there is nobody to ask. Use readonly or " +
        "readwrite, save mail with upsert_draft_email and send it from Gmail.",
    };
  }
  const unknown = requested.filter((g) => !(STANDALONE_GROUPS as readonly string[]).includes(g));
  if (unknown.length > 0) {
    return {
      invalid:
        `Invalid tool group(s) in GMAIL_ENABLED_TOOLGROUPS: ${unknown.map((g) => `"${g}"`).join(", ")}. ` +
        `Valid groups: ${STANDALONE_GROUPS.join(", ")}.`,
    };
  }
  return { groups: [...new Set(requested)].join(",") };
}

serveStandalone({
  name: "gmail",
  // The same factory as the `/gmail` mount in `src/index.ts`, handed an env
  // whose tool groups have been checked above, and the same lazy client, minus
  // its sends. It reads its credential from that env at the first tool call,
  // as it would in a bundle.
  build: () => {
    const resolved = enabledGroups(process.env.GMAIL_ENABLED_TOOLGROUPS);
    if (!("groups" in resolved)) throw new Error(resolved.invalid);
    const env = { ...process.env, GMAIL_ENABLED_TOOLGROUPS: resolved.groups };
    const { server, registerHandlers } = createMCPServer({ version: VERSION, env });
    return {
      server,
      registerHandlers: (target) => registerHandlers(target, () => withoutSends(createDefaultClient(env))),
    };
  },
  validateEnv: (env) => {
    const resolved = enabledGroups(env.GMAIL_ENABLED_TOOLGROUPS);
    if ("invalid" in resolved) return resolved.invalid;
    // A complete service account serves its Workspace user whenever the OAuth
    // trio is incomplete, with nothing printed: the person who set an OAuth
    // variable meant their own mailbox. Refuse it rather than serve another.
    const oauthMissing = GMAIL_OAUTH_ENV_NAMES.filter((name) => !env[name]);
    // Started means SET, even empty, as `missingCredentials` decides the mode.
    const oauthStarted = GMAIL_OAUTH_ENV_NAMES.some((name) => name in env);
    const serviceAccount = GMAIL_SERVICE_ACCOUNT_ENV_NAMES.every((name) => env[name]);
    if (oauthStarted && oauthMissing.length > 0 && serviceAccount) {
      return (
        `${oauthMissing.join(", ")} not set, so this would serve the service account's ` +
        `mailbox (GMAIL_IMPERSONATE_EMAIL), not the OAuth account's. Set all three ` +
        `GMAIL_OAUTH_* variables, or unset them to use the service account.`
      );
    }
    return undefined;
  },
  // What this environment is short of, in the auth mode it has started: the
  // OAuth trio once any of them is set, else the service account's three.
  credentialEnv: missingCredentials,
}).catch((err: unknown) => {
  console.error("[gmail] failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
