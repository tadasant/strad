/**
 * google-docs, ONE ACCOUNT PER MOUNT — strad's own layer over the vendored tree.
 *
 * ## Why this file exists rather than an edit to `vendor/google-docs-shared/`
 *
 * That tree is vendored verbatim from
 * `pulsemcp/mcp-servers/experimental/google-docs/shared`, and a local edit to a
 * verbatim copy is reverted by the next re-vendor without anyone noticing. The
 * tree already speaks both auth modes — an OAuth refresh token or a service
 * account impersonating a Workspace user — but it reads them out of
 * `process.env`, which is right for the one-server-per-process deployment
 * upstream wrote it for and impossible in strad's collapsed bundle, where
 * several google-docs mounts share one process: one per slug, one per Google
 * account. That is a strad-shaped requirement, not upstream's bug, so the tree
 * stays verbatim and the multi-account behaviour lives here, compiled to
 * `dist/docs.js` and imported by the bundle host beside the tree.
 *
 * Everything below mirrors `./gmail.ts` deliberately — the same names, the same
 * marker-set discipline, the same client cache, the same reconnect hint —
 * because the two servers have the same two auth modes and two shapes for one
 * idea is how one of them drifts.
 *
 * ## The trap, which is gmail's
 *
 * The conventional `/google-docs` mount authenticates as a service account with
 * domain-wide delegation (a Workspace user's Drive), while a per-slug mount
 * authenticates as a PERSON through an OAuth refresh token. Both read bare names
 * off one container. A per-slug mount that inherited the bare
 * `GOOGLE_DOCS_SERVICE_ACCOUNT_*` + `GOOGLE_DOCS_IMPERSONATE_EMAIL` would not be
 * unconfigured — it would serve the Workspace user's documents under a slug
 * named for a personal account, with every call succeeding. That is why
 * {@link GOOGLE_DOCS_ENV_NAMES} names the SERVICE-ACCOUNT variables too: the
 * bundle host subtracts {@link GOOGLE_DOCS_OAUTH_APP_ENV_NAMES} from it and
 * refuses to inherit the remainder (`dropInheritedNames` in
 * `servers/bundle/host/src/mounts.ts`).
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  createMCPServer as createVendoredMCPServer,
  createRegisterTools,
  parseEnabledToolGroups,
  OAuth2GoogleDocsClient,
  ServiceAccountGoogleDocsClient,
  type ClientFactory,
  type IGoogleDocsClient,
  type ServiceAccountCredentials,
} from "google-docs-workspace-mcp-server-shared";

export type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * The OAuth2 mode: a refresh token belonging to ONE Google account, minted by a
 * human consenting in strad's console. The only mode a per-slug mount has.
 */
export const GOOGLE_DOCS_OAUTH_ENV_NAMES = [
  "GOOGLE_DOCS_OAUTH_CLIENT_ID",
  "GOOGLE_DOCS_OAUTH_CLIENT_SECRET",
  "GOOGLE_DOCS_OAUTH_REFRESH_TOKEN",
] as const;

/**
 * The OAuth APP half — everything except the account's own token.
 *
 * What a human seeds BEFORE anything is connected, and so what says "a
 * deployment asked for a mount here": the bundle host keys its per-slug
 * discovery on this list, which is what lets an unconnected slug mount, list its
 * tools, and report itself degraded until the token lands. A marker set, not a
 * credential — {@link missingCredentials} still gates on all three.
 */
export const GOOGLE_DOCS_OAUTH_APP_ENV_NAMES = [
  "GOOGLE_DOCS_OAUTH_CLIENT_ID",
  "GOOGLE_DOCS_OAUTH_CLIENT_SECRET",
] as const;

/**
 * The service-account mode: domain-wide delegation, impersonating one Workspace
 * user. What the conventional `/google-docs` mount runs on, and what a per-slug
 * mount must never fall back to — see the header.
 */
export const GOOGLE_DOCS_SERVICE_ACCOUNT_ENV_NAMES = [
  "GOOGLE_DOCS_SERVICE_ACCOUNT_CLIENT_EMAIL",
  "GOOGLE_DOCS_SERVICE_ACCOUNT_PRIVATE_KEY",
  "GOOGLE_DOCS_IMPERSONATE_EMAIL",
] as const;

/**
 * EVERY variable that decides WHOSE DRIVE this server reads, both modes.
 *
 * No mount needs all six. It is the set the bundle host subtracts the marker
 * pair from to get the names a discovered slug may not inherit, and for that the
 * answer has to span both modes.
 */
export const GOOGLE_DOCS_ENV_NAMES = [
  ...GOOGLE_DOCS_OAUTH_ENV_NAMES,
  ...GOOGLE_DOCS_SERVICE_ACCOUNT_ENV_NAMES,
] as const;

const complete = (env: EnvLike, names: readonly string[]): boolean =>
  names.every((name) => env[name]);

/**
 * What this environment is short of, in the auth mode it is actually in.
 *
 * The precedence is the vendored `createDefaultClient`'s: a complete OAuth set
 * wins, a complete service-account set is the fallback. When neither is
 * complete the mode is whichever one the environment has started, decided on
 * PRESENCE rather than truthiness — per-slug discovery keys on a name existing,
 * so a slug seeded an empty client id is still an OAuth mount and is told about
 * its OAuth names, never about a service account it is forbidden to use. See
 * the same function in `./gmail.ts`.
 */
export function missingCredentials(env: EnvLike): string[] {
  if (complete(env, GOOGLE_DOCS_OAUTH_ENV_NAMES)) return [];
  if (complete(env, GOOGLE_DOCS_SERVICE_ACCOUNT_ENV_NAMES)) return [];
  const names = GOOGLE_DOCS_OAUTH_ENV_NAMES.some((name) => name in env)
    ? GOOGLE_DOCS_OAUTH_ENV_NAMES
    : GOOGLE_DOCS_SERVICE_ACCOUNT_ENV_NAMES;
  return names.filter((name) => !env[name]);
}

/**
 * The OAuth client, plus where a human goes when the token dies: `invalid_grant`
 * is the normal end of a refresh token's life, and the recovery is one button
 * on this slug's own console page.
 */
class ReconnectableOAuth2GoogleDocsClient extends OAuth2GoogleDocsClient {
  private readonly reconnectUrl: string | undefined;

  constructor(
    clientId: string,
    clientSecret: string,
    refreshToken: string,
    reconnectUrl?: string,
  ) {
    super(clientId, clientSecret, refreshToken);
    this.reconnectUrl = reconnectUrl;
  }

  protected async refreshTokenImpl(): Promise<{
    token: string;
    expiryDate: number;
  }> {
    try {
      return await super.refreshTokenImpl();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("invalid_grant")) throw error;
      throw new Error(
        `${message}\n\nHint: this refresh token is no longer valid — revoked, expired, or ` +
          'invalidated by a password change. A token issued by an OAuth app still in ' +
          '"testing" mode expires after 7 days. ' +
          (this.reconnectUrl
            ? `Open ${this.reconnectUrl} in strad's console and click Reconnect Google; ` +
              "strad re-runs the consent and rotates the stored credential."
            : "Re-run the consent flow for this account from this slug's page in strad's " +
              "console (Reconnect Google), which rotates the stored credential."),
      );
    }
  }
}

/**
 * One client per credential, for the life of the process. Both hosts build a
 * FRESH `Server` per request, so an uncached client would pay a full token
 * exchange against Google on every tool call. The reconnect URL is in the key
 * for gmail's reason: two slugs seeded the same token must each name their own
 * Reconnect page.
 */
const clients = new Map<string, IGoogleDocsClient>();

/**
 * Builds the client from an environment, LAZILY: the image is credential-free,
 * so a missing token is one mount's failed tool call, never a boot failure.
 */
export function createDefaultClient(
  env: EnvLike = process.env,
): IGoogleDocsClient {
  const missing = missingCredentials(env);
  if (missing.length > 0) {
    throw new Error(
      `This google-docs mount has no credential: ${missing.join(", ")} ` +
        `${missing.length === 1 ? "is" : "are"} not set. A mount serves exactly ` +
        "one account's documents — either an OAuth refresh token for one Google " +
        "account, or a service account impersonating one Workspace user.",
    );
  }

  if (complete(env, GOOGLE_DOCS_OAUTH_ENV_NAMES)) {
    const clientId = env.GOOGLE_DOCS_OAUTH_CLIENT_ID!;
    const clientSecret = env.GOOGLE_DOCS_OAUTH_CLIENT_SECRET!;
    const refreshToken = env.GOOGLE_DOCS_OAUTH_REFRESH_TOKEN!;
    // Not a credential: the bundle host composes it from the gateway's public
    // URL and this mount's slug, and its absence costs a link in an error.
    const reconnectUrl = env.GOOGLE_DOCS_RECONNECT_URL || undefined;
    const key = `oauth\u0000${clientId}\u0000${clientSecret}\u0000${refreshToken}\u0000${reconnectUrl ?? ""}`;
    const existing = clients.get(key);
    if (existing) return existing;
    const client = new ReconnectableOAuth2GoogleDocsClient(
      clientId,
      clientSecret,
      refreshToken,
      reconnectUrl,
    );
    clients.set(key, client);
    return client;
  }

  const clientEmail = env.GOOGLE_DOCS_SERVICE_ACCOUNT_CLIENT_EMAIL!;
  // JSON-encoded env vars typically arrive with literal \n; un-escape so the JWT
  // lib sees real newlines inside the PEM.
  const privateKey = env.GOOGLE_DOCS_SERVICE_ACCOUNT_PRIVATE_KEY!.replace(
    /\\n/g,
    "\n",
  );
  const impersonateEmail = env.GOOGLE_DOCS_IMPERSONATE_EMAIL!;

  const key = `sa\u0000${clientEmail}\u0000${privateKey}\u0000${impersonateEmail}`;
  const existing = clients.get(key);
  if (existing) return existing;

  const credentials: ServiceAccountCredentials = {
    type: "service_account",
    project_id: "",
    private_key_id: "",
    private_key: privateKey,
    client_email: clientEmail,
    client_id: "",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_x509_cert_url: "",
  };
  const client = new ServiceAccountGoogleDocsClient(
    credentials,
    impersonateEmail,
  );
  clients.set(key, client);
  return client;
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
 * ONE server, every tool group, unless this instance's env narrows it.
 *
 * The `-ro` / `-rw` / `-rw-external` split is made by strad's gateway
 * (`src/gateway/toolPolicy.ts`), not here — `share_document` is withheld from
 * every slug but the external tier by that slug's `tools:` allow-list.
 * `GOOGLE_DOCS_ENABLED_TOOLGROUPS` is read out of the injected env rather than
 * `process.env` so that one mount's toggle is never another's.
 */
export function createMCPServer(options: CreateMCPServerOptions): {
  server: Server;
  registerHandlers: (
    server: Server,
    clientFactory?: ClientFactory,
  ) => Promise<void>;
} {
  const env = options.env ?? process.env;

  // The vendored factory owns the server's NAME and capabilities; only the
  // handler registration is replaced, so `serverInfo` stays upstream's.
  const { server } = createVendoredMCPServer({ version: options.version });

  const registerHandlers = async (
    target: Server,
    clientFactory?: ClientFactory,
  ): Promise<void> => {
    const factory =
      clientFactory ?? ((): IGoogleDocsClient => createDefaultClient(env));
    createRegisterTools(
      factory,
      parseEnabledToolGroups(env.GOOGLE_DOCS_ENABLED_TOOLGROUPS),
    )(target);
  };

  return { server, registerHandlers };
}
