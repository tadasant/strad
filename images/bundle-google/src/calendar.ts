/**
 * google-calendar, ONE ACCOUNT PER MOUNT — strad's own layer over the vendored
 * tree.
 *
 * ## Why this file exists rather than an edit to `vendor/google-calendar-shared/`
 *
 * That tree is a patched vendor, and its OAuth mode
 * (`GOOGLE_CALENDAR_AUTH_MODE=oauth`) already signs in as one Google account.
 * What it cannot do is serve two of them in one process: `createMCPServer`
 * builds its default client from `process.env`, which is right for one server
 * per process and wrong in strad's collapsed bundle, where one calendar mount
 * per slug shares a process with its siblings. The vendored factory takes a
 * client factory, so nothing inside the tree has to change: this module hands
 * it one that reads an INJECTED env, and owns the name lists the bundle host's
 * per-slug discovery keys on. Compiled to `dist/calendar.js`.
 *
 * It mirrors `./docs.ts` deliberately: the same names, the same marker-set
 * discipline. One difference is load-bearing. Calendar's mode is NAMED rather
 * than inferred, so a per-slug view needs the mode set as well as the
 * credential, and {@link perSlugEnv} is where that happens.
 *
 * ## The trap, which is gmail's
 *
 * The conventional `/google-calendar` mount is a service account with
 * domain-wide delegation, reading bare `GCAL_SERVICE_ACCOUNT_*` and
 * `GCAL_IMPERSONATE_EMAIL`. A per-slug mount that inherited them would serve
 * the Workspace user's calendar under a slug named for a different account,
 * with every call succeeding. {@link GOOGLE_CALENDAR_ENV_NAMES} spans both
 * modes so the bundle host can subtract the marker pair from it and refuse to
 * inherit the rest (`dropInheritedNames` in
 * `servers/bundle/host/src/mounts.ts`). Forcing `oauth` mode closes the same
 * trap from the other side: a per-slug mount never reads the service-account
 * names at all, whatever a bare `GOOGLE_CALENDAR_AUTH_MODE` says.
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  createDefaultClient,
  createMCPServer as createVendoredMCPServer,
  missingCredentials as vendoredMissingCredentials,
  GOOGLE_CALENDAR_AUTH_MODE_ENV,
  GOOGLE_CALENDAR_OAUTH_ENV_NAMES,
  GOOGLE_CALENDAR_SERVICE_ACCOUNT_ENV_NAMES,
  type EnvLike,
  type ICalendarClient,
} from "google-calendar-workspace-mcp-server-shared";

export type { EnvLike };

export {
  GOOGLE_CALENDAR_AUTH_MODE_ENV,
  GOOGLE_CALENDAR_OAUTH_ENV_NAMES,
  GOOGLE_CALENDAR_SERVICE_ACCOUNT_ENV_NAMES,
};

/**
 * The OAuth APP half: everything except the account's own refresh token.
 *
 * What a human seeds BEFORE anything is connected, and so what says "a
 * deployment asked for a mount here". The bundle host keys per-slug discovery
 * on this list, which lets an unconnected slug mount, list its tools and report
 * itself degraded until the token lands. A marker set, not a credential:
 * {@link missingCredentials} still gates on all three.
 */
export const GOOGLE_CALENDAR_OAUTH_APP_ENV_NAMES = [
  "GOOGLE_CALENDAR_OAUTH_CLIENT_ID",
  "GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET",
] as const;

/**
 * EVERY variable that decides WHOSE CALENDAR a mount reads, both modes, plus
 * the mode selector itself.
 *
 * No mount needs all of them. It is the set the bundle host subtracts the
 * marker pair from to get what a discovered slug may not inherit.
 */
export const GOOGLE_CALENDAR_ENV_NAMES = [
  ...GOOGLE_CALENDAR_OAUTH_ENV_NAMES,
  ...GOOGLE_CALENDAR_SERVICE_ACCOUNT_ENV_NAMES,
  GOOGLE_CALENDAR_AUTH_MODE_ENV,
] as const;

/**
 * A discovered slug's environment, in the mode it is always in.
 *
 * A per-slug mount is a PERSON, consented in strad's console, so it is
 * `oauth`. The mode is set here rather than declared by the slug because the
 * slug's variables come from its `oauth:` connector, which names three
 * variables and no fourth. Also the point: a slug never reads the mode from a
 * bare name some sibling put on the box.
 */
export function perSlugEnv(env: EnvLike): Record<string, string | undefined> {
  return { ...env, [GOOGLE_CALENDAR_AUTH_MODE_ENV]: "oauth" };
}

/**
 * What this environment is short of, in the mode it selects. The vendored
 * function throws on an unknown mode; here that is reported as the mode
 * variable being wrong, so the bundle host can degrade the mount with a reason
 * rather than crash the boot.
 */
export function missingCredentials(env: EnvLike): string[] {
  try {
    return vendoredMissingCredentials(env);
  } catch {
    return [GOOGLE_CALENDAR_AUTH_MODE_ENV];
  }
}

/**
 * Not a credential: the bundle host composes it from the gateway's public URL
 * and the mount's slug. Its absence costs a link in an error.
 */
export const GOOGLE_CALENDAR_RECONNECT_URL_ENV = "GOOGLE_CALENDAR_RECONNECT_URL";

/**
 * Where a human goes when the token dies. `invalid_grant` is the normal end of
 * a refresh token's life, and the vendored hint says to replace a variable by
 * hand. Under strad the recovery is one button on the slug's own console page,
 * so a call that fails that way is re-worded to name the page. Every other
 * error passes through untouched.
 */
export function withReconnectHint(
  client: ICalendarClient,
  reconnectUrl: string | undefined,
): ICalendarClient {
  if (!reconnectUrl) return client;
  const reword = (error: unknown): never => {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("invalid_grant")) throw error;
    throw new Error(
      `${message.split("\n\nHint:")[0]}\n\nHint: this refresh token is no longer valid — ` +
        "revoked, expired, or invalidated by a password change. A token issued by an " +
        'OAuth app still in "testing" mode expires after 7 days. ' +
        `Open ${reconnectUrl} in strad's console and click Reconnect Google; strad ` +
        "re-runs the consent and rotates the stored credential.",
    );
  };
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        try {
          const result = value.apply(target, args);
          return result instanceof Promise ? result.catch(reword) : result;
        } catch (error) {
          return reword(error);
        }
      };
    },
  });
}

export interface CreateMCPServerOptions {
  version: string;
  /**
   * The environment THIS instance reads. Defaults to `process.env` for a
   * single-instance deployment; the collapsed bundle passes a per-slug view.
   */
  env?: EnvLike;
}

/**
 * ONE server, all seven tools.
 *
 * The `-ro` / `-rw` split is made by strad's gateway (`src/gateway/toolPolicy.ts`)
 * through the slug's `tools:` allow-list, and by Google through the scopes the
 * slug's token was consented for. Both tool groups are passed explicitly so the
 * vendored factory never falls back to reading a bare `ENABLED_TOOLGROUPS` off
 * `process.env`.
 */
export function createMCPServer(options: CreateMCPServerOptions): {
  server: Server;
  registerHandlers: (server: Server) => Promise<void>;
} {
  const env = options.env ?? process.env;
  const vendored = createVendoredMCPServer({
    version: options.version,
    enabledToolGroups: ["readonly", "readwrite"],
  });
  return {
    server: vendored.server,
    // The vendored client cache is keyed by a hash of the credential, so two
    // mounts holding the same account share one client and two accounts never do.
    registerHandlers: (target: Server) =>
      vendored.registerHandlers(
        target,
        (): ICalendarClient =>
          withReconnectHint(
            createDefaultClient(env),
            env[GOOGLE_CALENDAR_RECONNECT_URL_ENV] || undefined,
          ),
      ),
  };
}
