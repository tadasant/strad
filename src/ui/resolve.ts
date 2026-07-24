import type { ServerConfig, StradConfig } from "../config/schema.ts";
import type { SecretBag } from "../secrets/index.ts";
import {
  parseServiceAccount,
  type ServiceAccount,
} from "../secrets/parameters/service-account.ts";

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
 * "gcs". A second GCS-backed server (remote-filesystem-tmp-public is one) lights up the same
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
    }
  | {
      kind: "secrets";
      server: ServerConfig;
      projectId: string;
      /** Parameter Manager location. `global` unless the deployment overrides it. */
      location?: string;
      /** The managed namespace path prefixes. The first is the default for new params. */
      namespaces: string[];
      /**
       * The ADMIN service account — the console's own credential, and the only
       * one in strad that can WRITE a parameter or read a SECRET value.
       *
       * It is resolved from `consoleEnv:`, which appspec.ts injects onto the
       * CORE component alone. The MCP container gets a different key (a viewer,
       * from `env:`) and never sees this one. If this is null the console
       * degrades to read-only-of-nothing rather than pretending: the whole point
       * is that the two credentials are distinct, so falling back to the MCP
       * server's key would be exactly the wrong thing to do.
       */
      account: ServiceAccount | null;
      accountReason?: string;
      /** Test seams, when the deployment points at stub Parameter/Secret Managers. */
      pmApiBase?: string;
      smApiBase?: string;
      tokenUrl?: string;
    };

/** The env keys the two GCS-backed servers use (gcs and remote-filesystem-tmp-public). */
const GCS_ENV = {
  bucket: "GCS_BUCKET",
  prefix: "GCS_ROOT_PATH",
  keyJson: "GCS_SERVICE_ACCOUNT_KEY_JSON",
  clientEmail: "GCS_CLIENT_EMAIL",
  privateKey: "GCS_PRIVATE_KEY",
} as const;

/**
 * The env keys the `secrets` server uses.
 *
 * Note which side each lives on. `projectId` / `location` / `namespaces` are
 * plain config and appear in BOTH the container's `env:` and the console's
 * `consoleEnv:` — they are not secret and both halves need them. The two KEYS are
 * the split:
 *
 *   SECRETS_SERVICE_ACCOUNT_KEY_JSON        env:        viewer  (MCP)
 *   SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON  consoleEnv: admin   (console)
 *
 * The console reads ONLY the admin key. It will not fall back to the viewer key,
 * because a console that silently ran as the viewer would render an empty page
 * and a confusing 403 — and because the fallback, once written, is the thing
 * someone later "fixes" by handing the viewer more permissions.
 */
const SECRETS_ENV = {
  projectId: "SECRETS_PROJECT_ID",
  location: "SECRETS_LOCATION",
  namespaces: "SECRETS_NAMESPACES",
  adminKeyJson: "SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON",
  pmApiBase: "SECRETS_PM_API_BASE",
  smApiBase: "SECRETS_SM_API_BASE",
  tokenUrl: "SECRETS_TOKEN_URL",
} as const;

/**
 * A server's env, with any SLUG-NAMESPACED variable also visible under its bare
 * name (`REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_BUCKET` -> `GCS_BUCKET`).
 *
 * Namespacing exists because siblings now share a container: `gcs` and
 * `remote-filesystem-tmp-public` both read `GCS_BUCKET`, and they point at DIFFERENT
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

  // Secrets view: the server declares a secrets project. Checked FIRST — a
  // `secrets` server declares no bucket, so the two detectors cannot collide,
  // but the ordering says which concept owns the slug if one ever did.
  if (env[SECRETS_ENV.projectId]) {
    return resolveSecretsView(server, env, secrets);
  }

  // GCS view: the server declares a bucket. That's the whole detector.
  if (env[GCS_ENV.bucket] || env[GCS_ENV.keyJson] || env[GCS_ENV.clientEmail]) {
    return resolveGcsView(server, env, secrets);
  }

  return { kind: "no_viewer", server };
}

function resolveSecretsView(
  server: ServerConfig,
  env: Record<string, string>,
  secrets: SecretBag,
): ServerView {
  const projectId = tryResolve(env[SECRETS_ENV.projectId] ?? "", secrets) ?? "";
  const location =
    tryResolve(env[SECRETS_ENV.location] ?? "", secrets) || undefined;
  const namespaces = (
    tryResolve(env[SECRETS_ENV.namespaces] ?? "", secrets) ?? ""
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const adminRaw = env[SECRETS_ENV.adminKeyJson];
  const adminJson = adminRaw ? tryResolve(adminRaw, secrets) : undefined;

  let account: ServiceAccount | null = null;
  let accountReason: string | undefined;

  if (!adminJson) {
    accountReason = adminRaw
      ? `${SECRETS_ENV.adminKeyJson} is declared under consoleEnv: but is not injected on this deployment`
      : `${SECRETS_ENV.adminKeyJson} is not declared under this server's consoleEnv:`;
  } else {
    // parseServiceAccount reports a malformed key by SHAPE, never content — it is
    // a private key.
    const parsed = parseServiceAccount(adminJson);
    account = parsed.account;
    if (!account)
      accountReason = `${SECRETS_ENV.adminKeyJson} ${parsed.reason}`;
  }

  return {
    kind: "secrets",
    server,
    projectId,
    location,
    namespaces,
    account,
    accountReason,
    pmApiBase:
      tryResolve(env[SECRETS_ENV.pmApiBase] ?? "", secrets) || undefined,
    smApiBase:
      tryResolve(env[SECRETS_ENV.smApiBase] ?? "", secrets) || undefined,
    tokenUrl: tryResolve(env[SECRETS_ENV.tokenUrl] ?? "", secrets) || undefined,
  };
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
 *   - remote-filesystem-tmp-public: GCS_CLIENT_EMAIL + GCS_PRIVATE_KEY (two fields only)
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

  // Declared as ${refs} but not resolvable HERE. The overwhelmingly likely cause
  // is scope, not a missing secret: a supplementary server's `env:` lands on the
  // BUNDLE, while this view renders in CORE, so a credential the MCP tools use
  // happily is invisible to the console unless the config also lists it under
  // `consoleEnv:`. Say that, because the older wording ("seeded in a later
  // phase") sent people looking for a secret that was already seeded.
  return {
    account: null,
    reason:
      "GCS credentials are declared but not resolvable in the console. " +
      "A supplementary server's `env:` is scoped to its bundle; add the same " +
      "key under `consoleEnv:` so the core component can resolve it too.",
  };
}

/**
 * A server's static env/options map, or {} for kinds that have none.
 *
 * `consoleEnv:` is merged in for a supplementary image, and this is the ONLY
 * place that happens: the console is the half of that server which runs in this
 * process, so its keys are the ones this file may resolve. The container's
 * `env:` is here too — but only its non-secret parts ever resolve, because a
 * `${REF}` scoped to the bundle is not in core's secret bag (appspec.ts never
 * broadcasts it), so tryResolve returns undefined and the view degrades.
 * That is the design working, not a gap.
 */
function serverEnv(server: ServerConfig): Record<string, string> {
  if (server.kind === "supplementary-image") {
    return { ...server.env, ...server.consoleEnv };
  }
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
