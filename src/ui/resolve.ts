import type { ServerConfig, StradConfig } from "../config/schema.ts";
import type { SecretBag } from "../secrets/index.ts";
import type { ServiceAccount } from "./gcs-client.ts";

/**
 * Resolve "what does the human UI show for THIS server?".
 *
 * The per-server browser is scoped to the mcp id: everything it shows comes from
 * the server's OWN config entry, never from ambient globals. For a GCS-backed
 * server that means the bucket, the prefix it is pinned to, and the credentials
 * it authenticates with — all read off the server's `env:` map and resolved the
 * same way the gateway resolves any `${SECRET}` ref (against the injected secret
 * bag, which at runtime is the process environment).
 *
 * This is deliberately a small dispatch table, not a hardcode: a server "has a
 * GCS view" because its config declares a GCS bucket, not because its slug is
 * "gcs". A second GCS-backed server (remote-filesystem is one) lights up the same
 * view with zero new code. Non-GCS servers resolve to `no_viewer` today — the
 * seam where other server kinds grow their own views later.
 */

export type ServerView =
  | { kind: "not_found" }
  | { kind: "no_viewer"; server: ServerConfig }
  | {
      kind: "gcs";
      server: ServerConfig;
      bucket: string;
      /** Normalised to "" or a value ending in "/". */
      prefix: string;
      /** null when creds are declared but not yet injected (Phase 2). */
      account: ServiceAccount | null;
      /** Why creds are missing, for a graceful empty state. */
      accountReason?: string;
    };

/** The env keys the two GCS-backed servers use (gcs and remote-filesystem). */
const GCS_ENV = {
  bucket: "GCS_BUCKET",
  prefix: "GCS_ROOT_PATH",
  keyJson: "GCS_SERVICE_ACCOUNT_KEY_JSON",
  clientEmail: "GCS_CLIENT_EMAIL",
  privateKey: "GCS_PRIVATE_KEY",
} as const;

/**
 * A server's env, with any SLUG-NAMESPACED variable also visible under its bare
 * name (`REMOTE_FILESYSTEM_GCS_BUCKET` -> `GCS_BUCKET`).
 *
 * Namespacing exists because siblings now share a container: `gcs` and
 * `remote-filesystem` both read `GCS_BUCKET`, and they point at DIFFERENT
 * buckets, so one of them had to move off the bare name (see the bundle host).
 * The bare name still wins if both are set — the namespaced form is a fallback,
 * not an override — which keeps a server that never had a sibling unchanged.
 */
function withNamespacedFallback(
  slug: string,
  env: Record<string, string>,
): Record<string, string> {
  const prefix = `${slug.toUpperCase().replace(/-/g, "_")}_`;
  const out: Record<string, string> = { ...env };
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(prefix)) continue;
    const bare = key.slice(prefix.length);
    out[bare] ??= value;
  }
  return out;
}

export function resolveServerView(
  config: StradConfig,
  slug: string,
  secrets: SecretBag,
): ServerView {
  const server = config.servers.find((s) => s.slug === slug);
  if (!server) return { kind: "not_found" };

  const env = withNamespacedFallback(server.slug, serverEnv(server));

  // GCS view: the server declares a bucket. That's the whole detector.
  if (env[GCS_ENV.bucket] || env[GCS_ENV.keyJson] || env[GCS_ENV.clientEmail]) {
    return resolveGcsView(server, env, secrets);
  }

  return { kind: "no_viewer", server };
}

function resolveGcsView(
  server: ServerConfig,
  env: Record<string, string>,
  secrets: SecretBag,
): ServerView {
  const bucketRaw = env[GCS_ENV.bucket];
  const bucket = bucketRaw ? tryResolve(bucketRaw, secrets) : undefined;

  // No bucket resolvable — most likely a `${GCS_BUCKET}` ref not yet injected.
  if (!bucket) {
    return {
      kind: "gcs",
      server,
      bucket: bucketRaw ?? "",
      prefix: "",
      account: null,
      accountReason: bucketRaw
        ? `bucket reference "${bucketRaw}" is not yet configured`
        : "no GCS_BUCKET configured for this server",
    };
  }

  const prefixRaw = env[GCS_ENV.prefix] ?? "";
  const prefix = normalisePrefix(tryResolve(prefixRaw, secrets) ?? "");

  const { account, reason } = resolveAccount(env, secrets);

  return {
    kind: "gcs",
    server,
    bucket,
    prefix,
    account,
    accountReason: account ? undefined : reason,
  };
}

/**
 * Two credential conventions, both used by the bundle-api fleet:
 *   - gcs:               GCS_SERVICE_ACCOUNT_KEY_JSON  (a full key file, inline)
 *   - remote-filesystem: GCS_CLIENT_EMAIL + GCS_PRIVATE_KEY (the two fields only)
 * Support both so the same view scopes to either server.
 */
function resolveAccount(
  env: Record<string, string>,
  secrets: SecretBag,
): { account: ServiceAccount | null; reason?: string } {
  const keyJsonRaw = env[GCS_ENV.keyJson];
  const keyJson = keyJsonRaw ? tryResolve(keyJsonRaw, secrets) : undefined;
  if (keyJson) {
    try {
      const parsed = JSON.parse(keyJson) as Partial<ServiceAccount>;
      if (parsed.client_email && parsed.private_key) {
        return {
          account: {
            client_email: parsed.client_email,
            private_key: parsed.private_key,
          },
        };
      }
      return {
        account: null,
        reason: `${GCS_ENV.keyJson} is missing client_email/private_key`,
      };
    } catch {
      return { account: null, reason: `${GCS_ENV.keyJson} is not valid JSON` };
    }
  }

  const clientEmailRaw = env[GCS_ENV.clientEmail];
  const clientEmail = clientEmailRaw
    ? tryResolve(clientEmailRaw, secrets)
    : undefined;
  const privateKeyRaw = env[GCS_ENV.privateKey];
  const privateKey = privateKeyRaw
    ? tryResolve(privateKeyRaw, secrets)
    : undefined;
  if (clientEmail && privateKey) {
    return { account: { client_email: clientEmail, private_key: privateKey } };
  }

  // Creds declared as ${refs} but not injected — the expected Phase 2 state.
  return {
    account: null,
    reason:
      "GCS credentials are declared but not yet injected " +
      "(real per-server GCS creds are seeded in a later phase)",
  };
}

/** A server's static env/options map, or {} for kinds that have none. */
function serverEnv(server: ServerConfig): Record<string, string> {
  if (server.kind === "supplementary-image") return server.env;
  if (server.kind === "builtin") {
    // A builtin's options are `unknown`; keep only the string-valued ones, which
    // is all a GCS config would be.
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(server.options)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }
  return {};
}

/**
 * Resolve `${NAME}` refs against the secret bag, returning undefined (not
 * throwing) when a ref is missing. The UI wants to degrade to a "not configured
 * yet" state, not crash, when a credential has not been injected.
 */
function tryResolve(value: string, secrets: SecretBag): string | undefined {
  const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  let missing = false;
  const out = value.replace(REF, (_m, name: string) => {
    const found = secrets[name];
    if (found === undefined) {
      missing = true;
      return "";
    }
    return found;
  });
  return missing ? undefined : out;
}

/** "" stays "". "screenshots" -> "screenshots/". Trailing/leading slashes tidy. */
export function normalisePrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed === "" ? "" : `${trimmed}/`;
}
