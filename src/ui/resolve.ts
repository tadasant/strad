import { secretRefRe } from "../config/env-name.ts";
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
      /**
       * The parameter stores this ONE console page can switch between.
       *
       * A page is not a project. `?project=<id>` selects an entry, and every
       * list, create, rotate, note, reveal and delete on the page is scoped to
       * the selected one — its project, its namespaces, its credential, its
       * bounds. Empty only when the server declares neither `consoleStores:` nor
       * a `SECRETS_PROJECT_ID`; the page then renders a "not configured" notice
       * rather than guessing.
       */
      stores: SecretsStore[];
      /**
       * Test seams, when the deployment points at stub Parameter/Secret
       * Managers. Shared across the stores on a page: the project is a path
       * segment in every Google URL these replace, so one stub answers for all
       * of them, and a per-store override would be a knob with no caller.
       */
      pmApiBase?: string;
      smApiBase?: string;
      crmApiBase?: string;
      tokenUrl?: string;
    };

/**
 * ONE parameter store, as the console sees it.
 *
 * Everything that was flat on the secrets view lives here instead, and that
 * relocation is the substance of multi-store: `namespaces`, `namespacesStrict`
 * and `revealEnabled` are properties OF A STORE, not of the page showing it. A
 * page-level `namespacesStrict` checked against a union list is a bound that
 * does not bind — it would wave through a namespace belonging to a sibling
 * project while a different one is selected.
 */
export interface SecretsStore {
  /**
   * The GCP project id, and the store's address: the console selects with
   * `?project=<projectId>`.
   */
  projectId: string;
  /** What the picker calls it. Defaults to the project id. */
  label: string;
  /** Parameter Manager location. `global` unless the deployment overrides it. */
  location?: string;
  /** The managed namespace path prefixes. The first is the default for new params. */
  namespaces: string[];
  /**
   * The ADMIN service account — the console's own credential for THIS store, and
   * the only one in strad that can WRITE a parameter or read a SECRET value.
   *
   * It is resolved from `consoleEnv:`, which appspec.ts injects onto the CORE
   * component alone. The MCP container gets a different key (a viewer, from
   * `env:`) and never sees this one. If this is null the console degrades to
   * read-only-of-nothing rather than pretending: the whole point is that the two
   * credentials are distinct, so falling back to the MCP server's key would be
   * exactly the wrong thing to do.
   *
   * ONE KEY PER STORE, never one key granted on several projects. Two stores
   * sharing an identity is a strictly larger blast radius than the two
   * identities it replaces, and it is the simplification this design exists to
   * refuse — see `ConsoleStore` in src/config/schema.ts.
   */
  account: ServiceAccount | null;
  /** Why this store's credential is missing, for a graceful empty state. */
  accountReason?: string;
  /**
   * Whether this deployment OFFERS reveal for this store. Independent of whether
   * the credential could perform it — see capabilities.ts for that half.
   */
  revealEnabled: boolean;
  /** When true, `namespaces` bounds this store, not just its suggestions. */
  namespacesStrict: boolean;
}

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
export const SECRETS_ENV = {
  projectId: "SECRETS_PROJECT_ID",
  location: "SECRETS_LOCATION",
  namespaces: "SECRETS_NAMESPACES",
  adminKeyJson: "SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON",
  /**
   * The reveal FEATURE FLAG. Absent means OFF.
   *
   * Displaying a stored secret value is the one console action with no undo and
   * no audit trail a human would notice, and it is not something every
   * deployment should offer. Staging wants it, because `strad-secrets-staging`
   * is a separate project from the one holding strad's own `strad-<env>-*`
   * secrets and round-tripping a value is how the store gets tested. What a
   * reveal there returns is a real per-server credential; the bound is the
   * project, not the contents. Prod does not.
   *
   * Default-off is the whole point of spelling it as an opt-in: a deployment
   * that forgets to think about this gets the safe answer, and a new environment
   * cannot inherit reveal by accident.
   *
   * It is NOT the boundary. The boundary is whether the console's service
   * account holds `secretmanager.versions.access` — see capabilities.ts. This
   * flag decides what the UI OFFERS; IAM decides what is POSSIBLE.
   */
  revealEnabled: "SECRETS_REVEAL_ENABLED",
  /**
   * Restore `SECRETS_NAMESPACES` as a hard limit on the CONSOLE, not merely a
   * list of suggestions. Absent means off — the namespace field is free text.
   *
   * Free text is right for the credential: the console's admin key already
   * reaches every parameter in the project, so a list checked in code adds no
   * security against an operator. It is NOT right against a HIJACKED SESSION —
   * an attacker with a cookie and no ability to redeploy. Against that actor a
   * deploy-time namespace limit is real defence in depth, and it is the
   * mitigation `docs/operate/secrets.md` tells you to reach for before putting
   * the gateway namespace (the token store, the OAuth client secret) in front of
   * a production console. This flag is how you keep it.
   */
  namespacesStrict: "SECRETS_NAMESPACES_STRICT",
  pmApiBase: "SECRETS_PM_API_BASE",
  smApiBase: "SECRETS_SM_API_BASE",
  crmApiBase: "SECRETS_CRM_API_BASE",
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

/**
 * The env a view is DETECTED and resolved against: the server's own config
 * (`env:` plus `consoleEnv:` for a supplementary image), with slug-namespaced
 * variables also visible under their bare names.
 *
 * One function, because the index and the page have to agree. `/ui` decides
 * whether to offer a `Manage →` link and `/ui/<slug>` decides what to render,
 * and a link narrower than the page it points at is an unreachable feature — the
 * page renders and nothing offers it. `remote-filesystem-tmp-public` is the shape
 * that catches it: its bucket is `REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_BUCKET` (see
 * the bundle host's collision note) and its credentials can be `consoleEnv:`-only,
 * neither of which a bare-name, `env:`-only reading of the config finds.
 */
function declaredEnv(server: ServerConfig): Record<string, string> {
  return withNamespacedFallback(server.slug, serverEnv(server));
}

/**
 * The `secrets` detector: the server declares a secrets/parameters project.
 *
 * Exported because the console INDEX asks the same question — and asks it
 * through this function, so it cannot answer differently from the resolver.
 */
export function serverLooksSecrets(server: ServerConfig): boolean {
  return declaresSecrets(server, declaredEnv(server));
}

/**
 * One secrets page, as ANOTHER page names it: where it is and which stores it
 * fronts. Declared config and nothing else — no credential, no parameter, no
 * status — because it is rendered on a page that is not this one.
 */
export interface SecretsPageSummary {
  slug: string;
  /** A disabled server still has a page; the index marks it, so this does too. */
  enabled: boolean;
  stores: { projectId: string; namespaces: string[] }[];
}

/**
 * Every secrets page on this gateway, in config order.
 *
 * Three things have to agree: the roster's `Manage →` link, the page it points
 * at, and this list. `declaredEnv` keeps the link from being narrower than the
 * page; this keeps a page's list of its SIBLINGS from disagreeing with either.
 * (The console's one declaration that outranks detection — a connector's
 * `oauth:` — is applied where the page is, in `src/ui/index.ts`, because the
 * connector module sits downstream of this one.) Both halves are reused rather than
 * restated: WHICH servers comes from `serverLooksSecrets`, the predicate the
 * index asks per card, and WHAT each one fronts comes from `resolveServerView`,
 * the resolution the sibling page itself renders. A second detection path here
 * would be a strip naming a page the index does not offer, or skipping one it
 * does.
 *
 * Navigation, not authorization. The `/ui` gate is a Workspace-principal check
 * that never reads `entitlements:`, so a console-only slug with
 * `entitlements: []` has a page and is listed like any other. Nothing here is
 * anything a signed-in reader cannot already see by opening the page it names.
 */
export function secretsPages(
  config: StradConfig,
  secrets: SecretBag,
): SecretsPageSummary[] {
  const pages: SecretsPageSummary[] = [];
  for (const server of config.servers.filter(serverLooksSecrets)) {
    const view = resolveServerView(config, server.slug, secrets);
    if (view.kind !== "secrets") continue;
    pages.push({
      slug: server.slug,
      enabled: server.enabled,
      stores: view.stores.map((s) => ({
        projectId: s.projectId,
        namespaces: s.namespaces,
      })),
    });
  }
  return pages;
}

/** The GCS detector: the server declares a bucket or GCS credentials. */
export function serverLooksGcs(server: ServerConfig): boolean {
  return declaresGcs(declaredEnv(server));
}

function declaresSecrets(
  server: ServerConfig,
  declared: Record<string, string>,
): boolean {
  if (
    server.kind === "supplementary-image" &&
    server.consoleStores.length > 0
  ) {
    return true;
  }
  return Boolean(declared[SECRETS_ENV.projectId]);
}

function declaresGcs(declared: Record<string, string>): boolean {
  return Boolean(
    declared[GCS_ENV.bucket] ||
    declared[GCS_ENV.keyJson] ||
    declared[GCS_ENV.clientEmail],
  );
}

export function resolveServerView(
  config: StradConfig,
  slug: string,
  secrets: SecretBag,
): ServerView {
  const server = config.servers.find((s) => s.slug === slug);
  if (!server) return { kind: "not_found" };

  const declared = declaredEnv(server);
  /**
   * The env resolved under its EXACT declared names — no slug-namespaced
   * aliasing. `consoleStores:` looks a credential up here rather than in `value`
   * below, because `withNamespacedFallback` is last-wins in the wrong direction
   * for this purpose (`out[bare] ??= value`, so a bare name already present
   * beats its namespaced twin). A store's admin key must be the value filed
   * under the exact `adminKeyVar` this server declared, or nothing.
   */
  const exact = resolveEnv(serverEnv(server), consoleEnvKeys(server), secrets);
  const value = withNamespacedFallback(server.slug, exact);

  // Secrets view: the server declares a secrets project. Checked FIRST — a
  // `secrets` server declares no bucket, so the two detectors cannot collide,
  // but the ordering says which concept owns the slug if one ever did.
  if (declaresSecrets(server, declared)) {
    return resolveSecretsView(server, declared, value, exact);
  }

  // GCS view: the server declares a bucket. That's the whole detector.
  if (declaresGcs(declared)) {
    return resolveGcsView(server, declared, value);
  }

  return { kind: "no_viewer", server };
}

/**
 * The secrets view: N stores, one page.
 *
 * TWO SHAPES, and the newer one wins outright when present.
 *
 *   `consoleStores:` — the multi-store declaration. Each entry brings its OWN
 *   project, namespaces, bounds and credential, and the credential arrives by
 *   `consoleEnv:` under the name the entry gives (schema.ts enforces both that
 *   the name is a `consoleEnv:` key and that it is not any server's `env:` key).
 *
 *   the `SECRETS_*` env vars — the single-store shape every config written
 *   before `consoleStores:` uses. It resolves to exactly ONE store, with the
 *   same project, namespaces, flags and credential it always did, so the page a
 *   deployment gets today is byte-for-byte the page it gets after this change.
 *   That back-compat is deliberate: prod migrates its four slugs to one in its
 *   own PR, after this ships as a published version.
 *
 * They are not merged. A config that declares `consoleStores:` has said what its
 * stores are, and quietly appending an env-derived one would give it a store it
 * never asked for — under whichever `SECRETS_PROJECT_ID` its MCP half happens to
 * read, which is exactly the half that is meant to stay separate.
 */
function resolveSecretsView(
  server: ServerConfig,
  declared: Record<string, string>,
  value: Record<string, string>,
  exact: Record<string, string>,
): ServerView {
  const seams = {
    pmApiBase: value[SECRETS_ENV.pmApiBase] || undefined,
    smApiBase: value[SECRETS_ENV.smApiBase] || undefined,
    crmApiBase: value[SECRETS_ENV.crmApiBase] || undefined,
    tokenUrl: value[SECRETS_ENV.tokenUrl] || undefined,
  };

  if (
    server.kind === "supplementary-image" &&
    server.consoleStores.length > 0
  ) {
    const stores = server.consoleStores.map((declaredStore): SecretsStore => {
      const { account, accountReason } = resolveAdminKey(
        server,
        declaredStore.adminKeyVar,
        exact,
      );
      return {
        projectId: declaredStore.project,
        label: declaredStore.label ?? declaredStore.project,
        location: declaredStore.location,
        namespaces: declaredStore.namespaces,
        account,
        accountReason,
        revealEnabled: declaredStore.reveal,
        namespacesStrict: declaredStore.namespacesStrict,
      };
    });
    return { kind: "secrets", server, stores, ...seams };
  }

  const projectId = value[SECRETS_ENV.projectId] ?? "";
  const namespaces = splitList(value[SECRETS_ENV.namespaces]);

  const adminRaw = declared[SECRETS_ENV.adminKeyJson];
  const adminJson = adminRaw ? value[SECRETS_ENV.adminKeyJson] : undefined;

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

  const store: SecretsStore = {
    projectId,
    label: projectId,
    location: value[SECRETS_ENV.location] || undefined,
    namespaces,
    account,
    accountReason,
    revealEnabled: isTrue(value[SECRETS_ENV.revealEnabled]),
    namespacesStrict: isTrue(value[SECRETS_ENV.namespacesStrict]),
  };

  return { kind: "secrets", server, stores: [store], ...seams };
}

/**
 * One store's admin credential, out of `consoleEnv:` and nowhere else.
 *
 * The three ways this comes back null are told apart on purpose, because they
 * need different fixes: the name is not declared at all (a config error the
 * schema also catches), it is declared but the deployment never injected it (a
 * seeding problem), or it is injected and malformed (a bad key file). A
 * malformed key is reported by SHAPE, never content — it is a private key.
 */
function resolveAdminKey(
  server: ServerConfig,
  adminKeyVar: string,
  exact: Record<string, string>,
): { account: ServiceAccount | null; accountReason?: string } {
  const declaredHere =
    server.kind === "supplementary-image" && adminKeyVar in server.consoleEnv;
  if (!declaredHere) {
    return {
      account: null,
      accountReason: `${adminKeyVar} is not declared under this server's consoleEnv:`,
    };
  }
  const json = exact[adminKeyVar];
  if (!json) {
    return {
      account: null,
      accountReason: `${adminKeyVar} is declared under consoleEnv: but is not injected on this deployment`,
    };
  }
  const parsed = parseServiceAccount(json);
  return parsed.account
    ? { account: parsed.account }
    : { account: null, accountReason: `${adminKeyVar} ${parsed.reason}` };
}

/**
 * One `consoleEnv:` key of one server, parsed as a service-account key, out
 * of that server's console-only scope and nowhere else — the same lookup a
 * console store's `adminKeyVar` gets. A `format: secret-manager` deposit
 * store's `keyVar` is read through this (src/http/deposit.ts).
 */
export function resolveConsoleKey(
  config: StradConfig,
  slug: string,
  keyVar: string,
  secrets: SecretBag,
): { account: ServiceAccount | null; accountReason?: string } {
  const server = config.servers.find((s) => s.slug === slug);
  if (!server) return { account: null, accountReason: `no server ${slug}` };
  const exact = resolveEnv(serverEnv(server), consoleEnvKeys(server), secrets);
  return resolveAdminKey(server, keyVar, exact);
}

/** A comma-separated env list, trimmed and de-blanked. */
function splitList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveGcsView(
  server: ServerConfig,
  declared: Record<string, string>,
  value: Record<string, string>,
): ServerView {
  const bucketRaw = declared[GCS_ENV.bucket];
  const bucket = bucketRaw ? value[GCS_ENV.bucket] : undefined;

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

  const prefix = normalisePrefix(value[GCS_ENV.prefix] ?? "");

  const { account, reason } = resolveAccount(value);

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
 * Two credential conventions, both used by the GCS-backed servers:
 *   - gcs:               GCS_SERVICE_ACCOUNT_KEY_JSON  (a full key file, inline)
 *   - remote-filesystem-tmp-public: GCS_CLIENT_EMAIL + GCS_PRIVATE_KEY (two fields only)
 * Support both so the same view scopes to either server.
 */
function resolveAccount(value: Record<string, string>): {
  account: ServiceAccount | null;
  reason?: string;
} {
  const keyJson = value[GCS_ENV.keyJson];
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

  const clientEmail = value[GCS_ENV.clientEmail];
  const privateKey = value[GCS_ENV.privateKey];
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

/** The keys THIS server declares under `consoleEnv:`, and no others. */
function consoleEnvKeys(server: ServerConfig): Set<string> {
  return new Set(
    server.kind === "supplementary-image" ? Object.keys(server.consoleEnv) : [],
  );
}

/**
 * What the console can actually SEE for each declared env key.
 *
 * Two lookups, and the second one is the whole point of this function.
 *
 *   1. The declared value with its `${NAME}` refs resolved from the bag. This is
 *      the local/dev shape, and the shape of every non-ref literal.
 *   2. Failing that — and only for a key this server declares under
 *      `consoleEnv:` — the value the DEPLOYMENT baked under the KEY itself.
 *
 * Step 2 exists because a rendered spec does not carry `${NAME}` — it carries the
 * resolved value, filed under the key the container reads. appspec.ts resolves a
 * server's `consoleEnv:` at RENDER time and lands
 * `SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON=<the key file>` on core; the ref NAME
 * (`SECRETS_ADMIN_KEY_JSON`) is deliberately never injected anywhere, because it
 * names the console's store-ADMIN credential and broadcasting it is exactly what
 * `consoleEnv:` exists to avoid. Resolving by ref alone therefore asked core's
 * environment for a name that is guaranteed not to be in it, and every
 * ref-valued `consoleEnv:` entry read as "declared but not injected" on a
 * deployment where it was injected perfectly. `/ui/secrets` reported a missing
 * admin credential in production with the value sitting in core's environment
 * under the key one line below.
 *
 * Step 2 is fenced to `consoleEnv:` because core's environment is ONE namespace
 * shared by every server: `consoleEnvVars()` merges every enabled supplementary
 * server's map into it. Falling back for a key declared only under `env:` would
 * hand this server's view whatever ANOTHER server filed under the same name —
 * two GCS-backed servers already collide on the bare `GCS_*` names (see
 * `withNamespacedFallback`), so `/ui/<b>` would browse b's bucket as a's service
 * account, silently. A key declared only under `env:` is bundle-scoped, and a
 * hit for it in core's environment is by definition not this server's value.
 *
 * The ref lookup is tried FIRST so the config stays the source of truth: a
 * declared literal always wins over an ambient variable of the same name.
 *
 * A key that resolves neither way is ABSENT from the returned map, which is what
 * lets the callers tell "declared but unreachable from core" (the `env:`-scoped
 * case, which wants the "add it under consoleEnv:" nudge) from "not declared".
 */
function resolveEnv(
  env: Record<string, string>,
  consoleKeys: ReadonlySet<string>,
  secrets: SecretBag,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, declared] of Object.entries(env)) {
    const viaRef = tryResolve(declared, secrets);
    if (viaRef !== undefined) {
      out[key] = viaRef;
      continue;
    }
    if (!consoleKeys.has(key)) continue;
    const injected = secrets[key];
    if (injected !== undefined) out[key] = injected;
  }
  return out;
}

/**
 * Resolve `${NAME}` refs against the secret bag, returning undefined (not
 * throwing) when a ref is missing. The UI wants to degrade to a "not configured
 * yet" state, not crash, when a credential has not been injected.
 */
function tryResolve(value: string, secrets: SecretBag): string | undefined {
  let missing = false;
  const out = value.replace(secretRefRe(), (_m, name: string) => {
    const found = secrets[name];
    if (found === undefined) {
      missing = true;
      return "";
    }
    return found;
  });
  return missing ? undefined : out;
}

/**
 * A flag is ON only for an explicit truthy spelling. Anything else — absent,
 * empty, "false", a typo — is OFF, because this gates displaying a credential
 * and "I could not parse your intent" must not resolve to yes.
 */
function isTrue(raw: string | undefined): boolean {
  return raw === "true" || raw === "1" || raw === "yes";
}

/** "" stays "". "screenshots" -> "screenshots/". Trailing/leading slashes tidy. */
export function normalisePrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed === "" ? "" : `${trimmed}/`;
}
