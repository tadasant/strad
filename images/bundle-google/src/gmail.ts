/**
 * gmail, ONE ACCOUNT PER MOUNT — strad's own layer over the vendored tree.
 *
 * ## Why this file exists rather than an edit to `vendor/gmail-shared/`
 *
 * That tree is forked from `pulsemcp/mcp-servers/experimental/gmail/shared`
 * at `0ed34de` (`vendor/gmail-shared/FORK.md`), and its deltas change what the
 * server sends. This layer is a different kind of thing: it changes nothing in
 * the tree, it decides which mailbox the tree is handed. And the problem it
 * solves is not upstream's bug: upstream runs ONE gmail server per process, for which
 * `process.env` is the right place to read a credential from. It is strad's
 * collapsed bundle that runs SEVERAL in one process — one per slug, one per
 * Google account — and that is a strad-shaped requirement. So the tree reads
 * whatever env it is given and the multi-account behaviour lives here, in strad's own
 * source, where `npm run build` compiles it to `dist/gmail.js` and the bundle
 * host imports it beside the tree.
 *
 * `vendor/google-sheets-shared/` reached the same shape by the other road: it is
 * strad's own server, so the injected `env` is simply in it. Everything below
 * mirrors that module deliberately — the same names, the same marker-set
 * discipline, the same lazy client — because two shapes for one idea is how one
 * of them drifts.
 *
 * ## The trap sheets cannot express, and this one can
 *
 * Gmail has TWO auth modes and the bundle carries both at once: the conventional
 * `/gmail` mount authenticates as a service account with domain-wide delegation
 * (Tadas's Workspace mailbox), while a per-slug mount authenticates as a PERSON
 * through an OAuth refresh token. Both read bare names off one container.
 *
 * So a per-slug mount that inherited the bare names would not merely be
 * unconfigured — it would be configured as SOMEBODY ELSE. An unconnected
 * `gmail-personal-ro` falling back to `GMAIL_SERVICE_ACCOUNT_*` +
 * `GMAIL_IMPERSONATE_EMAIL` serves a work mailbox under a slug named for a
 * personal account, and every symptom says the mount is healthy. That is why
 * {@link GMAIL_ENV_NAMES} names the SERVICE-ACCOUNT variables too: the bundle
 * host subtracts {@link GMAIL_OAUTH_APP_ENV_NAMES} from it and refuses to
 * inherit the remainder (`dropInheritedNames` in
 * `servers/bundle/host/src/mounts.ts`). A list that named only the OAuth three
 * would drop the token and leave the cross-account fallback in place.
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  createMCPServer as createVendoredMCPServer,
  createRegisterTools,
  GMAIL_SENDER_DISPLAY_NAME_ENV,
  parseEnabledToolGroups,
  OAuth2GmailClient,
  ServiceAccountGmailClient,
  type ClientFactory,
  type IGmailClient,
  type ServiceAccountCredentials,
} from "gmail-workspace-mcp-server-shared";
import { guardSends, withConfirmation } from "./confirm.js";

export type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * The OAuth2 mode: a refresh token belonging to ONE Google account, minted by a
 * human consenting in strad's console. The only mode a per-slug mount has.
 */
export const GMAIL_OAUTH_ENV_NAMES = [
  "GMAIL_OAUTH_CLIENT_ID",
  "GMAIL_OAUTH_CLIENT_SECRET",
  "GMAIL_OAUTH_REFRESH_TOKEN",
] as const;

/**
 * The OAuth APP half — everything except the account's own token.
 *
 * These two are what a human seeds BEFORE anything is connected; the third is
 * minted by a consent flow that cannot run until the slug is deployed and
 * serving its own console page. So they, and not {@link GMAIL_OAUTH_ENV_NAMES},
 * are what says "a deployment asked for a mount here": the bundle host keys its
 * per-slug discovery on this list, which is what lets an unconnected slug mount,
 * list its tools, and report itself degraded until the token lands.
 *
 * A marker set, not a credential. {@link missingCredentials} still gates on all
 * three, so a mount discovered by these two fails every call until the third
 * arrives.
 */
export const GMAIL_OAUTH_APP_ENV_NAMES = [
  "GMAIL_OAUTH_CLIENT_ID",
  "GMAIL_OAUTH_CLIENT_SECRET",
] as const;

/**
 * The service-account mode: domain-wide delegation, impersonating one Workspace
 * user. What the conventional `/gmail` mount runs on, and what a per-slug mount
 * must never fall back to — see the header.
 */
export const GMAIL_SERVICE_ACCOUNT_ENV_NAMES = [
  "GMAIL_SERVICE_ACCOUNT_CLIENT_EMAIL",
  "GMAIL_SERVICE_ACCOUNT_PRIVATE_KEY",
  "GMAIL_IMPERSONATE_EMAIL",
] as const;

/**
 * EVERY variable that decides WHICH MAILBOX this server reads, both modes.
 *
 * Not "the variables one mount needs" — no mount needs all six. It is the set
 * the bundle host subtracts the marker pair from to get the names a discovered
 * slug may not inherit, and for that the answer has to span both modes. Adding a
 * seventh identity variable to either mode and leaving it out of here is how the
 * cross-account fallback comes back.
 */
export const GMAIL_ENV_NAMES = [
  ...GMAIL_OAUTH_ENV_NAMES,
  ...GMAIL_SERVICE_ACCOUNT_ENV_NAMES,
] as const;

/**
 * The name this mount's mail goes out under, in `From: "Name" <address>`.
 *
 * Optional, and not part of the credential: unset, the name is read from the
 * account's Gmail send-as settings, which is right for a person's mailbox and
 * empty for an account nobody signs in to. It belongs to ONE mailbox, which is
 * why the bundle host reads it only under the mount's own slug and never from
 * the bare name — a sibling's name on this mailbox's mail would be a wrong name
 * on every message, and nothing would fail (`ownNameOnly` in
 * `servers/bundle/host/src/mounts.ts`).
 */
export const GMAIL_SENDER_NAME_ENV_NAME = GMAIL_SENDER_DISPLAY_NAME_ENV;

const held = (env: EnvLike, names: readonly string[]): number =>
  names.filter((name) => env[name]).length;

const complete = (env: EnvLike, names: readonly string[]): boolean =>
  held(env, names) === names.length;

/**
 * What this environment is short of, in the auth mode it is actually in.
 *
 * The PRECEDENCE is the vendored `createDefaultClient`'s, kept deliberately: a
 * complete OAuth set wins, a complete service-account set is the fallback, and
 * either one on its own is a working mount. Only when NEITHER is complete does
 * the mode have to be decided, and the rule is "whichever one this deployment
 * has started" — a per-slug mount always holds the OAuth app pair, so it is
 * always told about its missing token rather than about a service account it is
 * forbidden to use. An environment holding no gmail variable at all is reported
 * as service-account, which is the conventional mount's mode.
 *
 * "HOLDS" MEANS THE NAME IS SET, NOT THAT IT IS NON-EMPTY, and that is the one
 * subtlety here. Per-slug discovery keys on a variable EXISTING
 * (`slugsWithPrefixedNames` walks `Object.keys`), so a slug seeded
 * `..__GMAIL_OAUTH_CLIENT_ID=""` is a mount — and a mode decided on truthiness
 * would then call it service-account and report the three variables this mount
 * is forbidden to use, which is the opposite of useful. The mode is decided on
 * presence; whether a value is USABLE is the `complete()` checks above, which
 * gate on truthiness and correctly still report an empty pair as missing.
 */
export function missingCredentials(env: EnvLike): string[] {
  if (complete(env, GMAIL_OAUTH_ENV_NAMES)) return [];
  if (complete(env, GMAIL_SERVICE_ACCOUNT_ENV_NAMES)) return [];
  const names = GMAIL_OAUTH_ENV_NAMES.some((name) => name in env)
    ? GMAIL_OAUTH_ENV_NAMES
    : GMAIL_SERVICE_ACCOUNT_ENV_NAMES;
  return names.filter((name) => !env[name]);
}

/**
 * The OAuth client, plus the one thing the vendored class has no way to say:
 * where a human goes when the token dies.
 *
 * `invalid_grant` is the normal end of a refresh token's life — seven days for
 * an app still in "testing", or any password change — and the recovery is one
 * button on this slug's own console page. An error that does not name the page
 * sends whoever reads it back to an OAuth Playground procedure strad deleted.
 * Overriding rather than editing the tree keeps the mailbox choice out of it.
 */
class ReconnectableOAuth2GmailClient extends OAuth2GmailClient {
  private readonly reconnectUrl: string | undefined;

  constructor(
    clientId: string,
    clientSecret: string,
    refreshToken: string,
    reconnectUrl?: string,
    senderDisplayName?: string,
  ) {
    super(clientId, clientSecret, refreshToken, { senderDisplayName });
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
 * One client per credential, for the life of the process.
 *
 * Both hosts build a FRESH `Server` per HTTP request, so a client constructed
 * inside the factory is constructed per tool call — and its access-token cache
 * then lives for exactly one call, making every call pay a full token exchange
 * against Google. Keying on the credential keeps the cache where it is useful
 * and keeps two accounts apart, which is the property the whole per-slug design
 * rests on.
 */
const clients = new Map<string, IGmailClient>();

/**
 * Builds the client from an environment, LAZILY.
 *
 * Lazily is load-bearing: the image is credential-free, and a missing token must
 * be one mount's failed tool call rather than a boot failure for the twenty-odd
 * servers sharing the process. So this throws when a tool is CALLED, never when
 * the server is built or its tools are listed.
 */
export function createDefaultClient(env: EnvLike = process.env): IGmailClient {
  const missing = missingCredentials(env);
  if (missing.length > 0) {
    throw new Error(
      `This gmail mount has no credential: ${missing.join(", ")} ` +
        `${missing.length === 1 ? "is" : "are"} not set. A mount serves exactly ` +
        "one mailbox — either an OAuth refresh token for one Google account, or " +
        "a service account impersonating one Workspace user.",
    );
  }

  // In every key below: two mounts of one credential that name their sender
  // differently are two clients, or the first one built would name both.
  const senderDisplayName = env[GMAIL_SENDER_NAME_ENV_NAME]?.trim() || undefined;

  if (complete(env, GMAIL_OAUTH_ENV_NAMES)) {
    const clientId = env.GMAIL_OAUTH_CLIENT_ID!;
    const clientSecret = env.GMAIL_OAUTH_CLIENT_SECRET!;
    const refreshToken = env.GMAIL_OAUTH_REFRESH_TOKEN!;
    // Not a credential and not one of GMAIL_ENV_NAMES: an absent one costs a
    // link in an error message and nothing else. The bundle host composes it
    // from the gateway's public URL and this mount's slug.
    const reconnectUrl = env.GMAIL_RECONNECT_URL || undefined;
    // The key is the credential itself, so two accounts can never share a
    // client. The reconnect URL is in it as well even though it is not a
    // credential: two slugs seeded the SAME token — a human copying one between
    // a `-ro` and `-rw` pair rather than consenting twice — would otherwise
    // share one client, and its `invalid_grant` would send whoever hit it to
    // the OTHER slug's Reconnect button, which rotates the other slug's
    // parameter and leaves this one dead. A client per mount rather than per
    // account is still a client per mount, which is all the cache is for.
    const key = `oauth\u0000${clientId}\u0000${clientSecret}\u0000${refreshToken}\u0000${reconnectUrl ?? ""}\u0000${senderDisplayName ?? ""}`;
    const existing = clients.get(key);
    if (existing) return existing;
    const client = new ReconnectableOAuth2GmailClient(
      clientId,
      clientSecret,
      refreshToken,
      reconnectUrl,
      senderDisplayName,
    );
    clients.set(key, client);
    return client;
  }

  const clientEmail = env.GMAIL_SERVICE_ACCOUNT_CLIENT_EMAIL!;
  // Handle both literal \n in JSON configs and actual newlines.
  const privateKey = env.GMAIL_SERVICE_ACCOUNT_PRIVATE_KEY!.replace(
    /\\n/g,
    "\n",
  );
  const impersonateEmail = env.GMAIL_IMPERSONATE_EMAIL!;

  const key = `sa\u0000${clientEmail}\u0000${privateKey}\u0000${impersonateEmail}\u0000${senderDisplayName ?? ""}`;
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
  const client = new ServiceAccountGmailClient(credentials, impersonateEmail, {
    senderDisplayName,
  });
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
 * The `-ro` / `-rw` / `-rw-external` split is NOT normally made here. strad's
 * gateway carries a `tools:` allow-list per slug and enforces it on
 * `tools/list` and on `tools/call` (`src/gateway/toolPolicy.ts`), so
 * `gmail-personal-ro` is this same server with the write tools withheld.
 * Deciding it in the container instead would mean a container per tier per
 * account, which is the architecture the bundle exists to have deleted — and it
 * is why the bundle host SCRUBS every `*_ENABLED_TOOLGROUPS` variable at boot
 * (`scrubCapabilityEnv`). `GMAIL_ENABLED_TOOLGROUPS` is read out of the injected
 * env here rather than out of `process.env` anyway, because a module that
 * reaches for the global gives every mount in the process the last one's answer
 * — and the standalone `bundle-google` image, which does no scrubbing, still
 * honours it.
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
    const factory = clientFactory ?? ((): IGmailClient => createDefaultClient(env));
    // `send_email` asks a human first, at the address the CALL carries rather
    // than one this container holds. See ./confirm.ts.
    // The mailbox the tools see refuses to send for a call that has been
    // dropped, whatever the tool does between the approval and the send.
    createRegisterTools(
      (): IGmailClient => guardSends(factory()),
      parseEnabledToolGroups(env.GMAIL_ENABLED_TOOLGROUPS),
    )(
      withConfirmation(target, {
        account: complete(env, GMAIL_OAUTH_ENV_NAMES)
          ? undefined
          : env.GMAIL_IMPERSONATE_EMAIL,
        client: factory,
      }),
    );
  };

  return { server, registerHandlers };
}
