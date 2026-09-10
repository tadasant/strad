import type { ServiceAccount } from "./parameter-manager.js";

/**
 * The server's configuration, read from the environment.
 *
 * Everything here is injected by strad onto the bundle component (the config
 * `env:` map, plus the `SECRETS_STORES` descriptor `renderAppSpec` derives from
 * `mcpStores:`). The image itself is credential-free, like every other server in
 * this repo.
 *
 * ONE CONTAINER, N STORES. This server holds a LIST of stores, each with its own
 * GCP project, its own namespaces and its own viewer service account. Nothing is
 * shared between two stores — not a client, not a credential, and not a
 * capability. See `capabilities.ts` for why the last of those is the load-bearing
 * one.
 */

/** ONE parameter store: a GCP project, its namespaces, and the key that reads it. */
export interface SecretsStore {
  /**
   * The GCP project id, and the store's ADDRESS — it is what an error message
   * names and what `list_managed_namespaces` reports capabilities under, so it
   * must be unique within one server's list.
   */
  project: string;
  /** What a human calls it. Defaults to the project id. */
  label?: string;
  /**
   * The canonical-path prefixes THIS store manages, e.g.
   * ["/strad/staging/mcp/"].
   *
   * A parameter is addressed by a canonical path
   * `/strad/{env}/mcp/{server-slug}/{kind}/{VARIABLE_NAME}`, and a "namespace" is
   * a prefix of that path. The prefix is stored inside each parameter's envelope,
   * so listing filters on the envelope's own path — not on a decoded id.
   *
   * Be precise about what it is worth: this is a CODE-LEVEL guard, not the IAM
   * boundary. The IAM boundary is the PROJECT — point each store at a project
   * that holds only its own parameters. See the README.
   *
   * What the prefix DOES buy, beyond bounding one store's answers: it is what
   * BINDS a path to a store. Every tool resolves the path it was
   * given to exactly one store and then uses that store's credential and that
   * store's capability. A namespace list is therefore never consulted as a
   * union — `storeForPath` refuses a path no store claims, and the load below
   * refuses a configuration in which two stores could claim one path.
   */
  namespaces: string[];
  /** The viewer service account for THIS project. Null when it is not usable. */
  account: ServiceAccount | null;
  /**
   * Why `account` is null, when the variable held something this could not read.
   *
   * SHAPE, NEVER CONTENT — the content is a private key (see `parseAccount`).
   * Absent when the variable is simply unset, which is the ordinary "nobody has
   * seeded this yet" state and needs no explaining.
   */
  credentialError?: string;
  /**
   * The environment variable this store's credential was read from.
   *
   * A NAME, never the value — it is reported in a "not configured" message so an
   * operator learns which variable to seed. It mirrors `adminKeyVar` on the
   * console's `consoleStores:`: the descriptor NAMES a key and the credential
   * travels by the ordinary `env:` route, so there is exactly one way a
   * credential reaches this container.
   */
  viewerKeyVar: string;
}

export interface SecretsConfig {
  /** At least one. Ordered as configured; the first is nobody's default. */
  stores: SecretsStore[];
  /** Where the human console lives, for `open_secrets_manager`'s link. */
  consoleUrl?: string;
  /** Test seams. Unset in production. */
  apiBase?: string;
  tokenUrl?: string;
}

export const ENV = {
  /** The multi-store descriptor. Non-secret: project ids, paths and key NAMES. */
  stores: "SECRETS_STORES",
  projectId: "SECRETS_PROJECT_ID",
  namespaces: "SECRETS_NAMESPACES",
  keyJson: "SECRETS_SERVICE_ACCOUNT_KEY_JSON",
  consoleUrl: "SECRETS_CONSOLE_URL",
  apiBase: "SECRETS_PM_API_BASE",
  tokenUrl: "SECRETS_TOKEN_URL",
} as const;

/** One entry of the `SECRETS_STORES` descriptor, before its key is resolved. */
interface StoreDescriptor {
  project?: unknown;
  label?: unknown;
  namespaces?: unknown;
  viewerKeyVar?: unknown;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SecretsConfig {
  const stores = env[ENV.stores]
    ? storesFromDescriptor(env[ENV.stores] as string, env)
    : [legacyStore(env)];

  assertAddressable(stores);

  return {
    stores,
    consoleUrl: env[ENV.consoleUrl],
    apiBase: env[ENV.apiBase],
    tokenUrl: env[ENV.tokenUrl],
  };
}

/**
 * `SECRETS_STORES` — the list, as `renderAppSpec` derives it from `mcpStores:`.
 *
 * It carries no credential. Each entry NAMES the variable holding its viewer
 * key, and the key itself arrives by the ordinary `env:` route, so the descriptor
 * is safe to read in a rendered app spec and a deploy diff shows which store
 * gained or lost a namespace.
 */
function storesFromDescriptor(
  raw: string,
  env: NodeJS.ProcessEnv,
): SecretsStore[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${ENV.stores} is not valid JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${ENV.stores} must be a non-empty JSON array of stores`);
  }
  return parsed.map((entry, i) => {
    const d = (entry ?? {}) as StoreDescriptor;
    const project = typeof d.project === "string" ? d.project.trim() : "";
    if (!project) {
      throw new Error(`${ENV.stores}[${i}] is missing "project"`);
    }
    const viewerKeyVar =
      typeof d.viewerKeyVar === "string" ? d.viewerKeyVar.trim() : "";
    if (!viewerKeyVar) {
      throw new Error(
        `${ENV.stores}[${i}] ("${project}") is missing "viewerKeyVar" — the NAME ` +
          `of the environment variable holding this store's viewer key.`,
      );
    }
    const namespaces = Array.isArray(d.namespaces)
      ? d.namespaces.map((n) => String(n).trim()).filter(Boolean)
      : [];
    if (namespaces.length === 0) {
      // Fail closed, for the reason the legacy reading does below.
      throw new Error(
        `${ENV.stores}[${i}] ("${project}") names no namespace. An unset ` +
          `namespace would scope this store to EVERY parameter in the project.`,
      );
    }
    // A KEY THIS CANNOT READ DEGRADES ITS OWN STORE, NOT THE MOUNT.
    //
    // `parseAccount` throws on malformed JSON, and letting that out of here
    // would fail `loadConfig`, which the bundle host answers by not mounting the
    // server at all — so one typo'd key would take every OTHER store down with
    // it, production included. That is the opposite of the posture the rest of
    // this file keeps: a store with no credential is a store that answers
    // nothing, while its siblings go on answering. The reason is carried so the
    // host can name it, and it is shape-only.
    let account: ServiceAccount | null = null;
    let credentialError: string | undefined;
    try {
      account = parseAccount(env[viewerKeyVar], viewerKeyVar);
    } catch (err) {
      credentialError = err instanceof Error ? err.message : String(err);
    }

    return {
      project,
      label: typeof d.label === "string" && d.label ? d.label : undefined,
      namespaces,
      account,
      ...(credentialError ? { credentialError } : {}),
      viewerKeyVar,
    };
  });
}

/** The single-store reading, for every deployment that declares no `mcpStores:`. */
function legacyStore(env: NodeJS.ProcessEnv): SecretsStore {
  const project = env[ENV.projectId];
  if (!project) {
    throw new Error(`${ENV.projectId} must be configured`);
  }

  const namespaces = (env[ENV.namespaces] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (namespaces.length === 0) {
    // Fail closed. An empty namespace list would mean "" — every parameter in
    // the project, including strad's own — and that is precisely the blast
    // radius this server exists to bound.
    throw new Error(
      `${ENV.namespaces} must name at least one path prefix (e.g. "/strad/staging/mcp/"). ` +
        `An unset namespace would scope this server to EVERY parameter in the project.`,
    );
  }

  return {
    project,
    namespaces,
    account: parseAccount(env[ENV.keyJson], ENV.keyJson),
    viewerKeyVar: ENV.keyJson,
  };
}

/**
 * Every path this server accepts must address exactly ONE store.
 *
 * THIS IS THE FENCE THE WHOLE MULTI-STORE DESIGN RESTS ON. A path is resolved to
 * a store, and that store's credential and that store's probed capability decide
 * what happens next — so a path two stores could both claim is a path whose
 * capability depends on declaration order. Refused at load, which on the bundle
 * host means the mount is skipped and says why, rather than mounted ambiguous.
 *
 * Two stores sharing a viewer key is refused for the reason `consoleStores:`
 * refuses two stores sharing an `adminKeyVar`: one identity granted on two
 * projects is a strictly larger blast radius than the two it replaces, and here
 * it would additionally make the two stores' capabilities identical by
 * construction — which is exactly the collapse this server must not permit.
 */
function assertAddressable(stores: SecretsStore[]): void {
  const byProject = new Set<string>();
  const byKeyVar = new Map<string, string>();
  for (const store of stores) {
    if (byProject.has(store.project)) {
      throw new Error(
        `${ENV.stores} declares the project "${store.project}" twice. A store is ` +
          `addressed by its project id, so the ids must be unique.`,
      );
    }
    byProject.add(store.project);

    const twin = byKeyVar.get(store.viewerKeyVar);
    if (twin) {
      throw new Error(
        `${ENV.stores}: "${twin}" and "${store.project}" both read their credential ` +
          `from ${store.viewerKeyVar}, so one service account would reach both ` +
          `projects — and both stores would have the same capability by ` +
          `construction. Give each store its own viewer key.`,
      );
    }
    byKeyVar.set(store.viewerKeyVar, store.project);
  }

  // AND THE SAME RULE BY IDENTITY, which is what the name is a proxy for.
  //
  // strad's config gate refuses two stores whose `viewerKeyVar`s name one key
  // OR carry one `${REF}`. This is the half that holds for a descriptor written
  // some other way: two DIFFERENT variables may still hold the same service
  // account, and then the two stores' probes ask Google about one identity and
  // cannot come back with different answers. Every other fence in this file
  // would pass; the capability would be collapsed anyway.
  const byIdentity = new Map<string, string>();
  for (const store of stores) {
    if (!store.account) continue;
    const twin = byIdentity.get(store.account.client_email);
    if (twin) {
      throw new Error(
        `${ENV.stores}: "${twin}" and "${store.project}" hold the SAME service ` +
          `account, under different variables. One identity on two projects is ` +
          `two stores that probe one capability — which is the collapse this ` +
          `server's per-project probe exists to prevent. Give each store its own ` +
          `viewer credential.`,
      );
    }
    byIdentity.set(store.account.client_email, store.project);
  }

  for (const a of stores) {
    for (const b of stores) {
      if (a === b) continue;
      for (const na of a.namespaces) {
        for (const nb of b.namespaces) {
          if (!na.startsWith(nb) && !nb.startsWith(na)) continue;
          throw new Error(
            `${ENV.stores}: namespace "${na}" ("${a.project}") and "${nb}" ` +
              `("${b.project}") overlap, so a parameter path could address either ` +
              `store. The path is what binds a call to a project, a credential and ` +
              `a capability; it must bind to exactly one.`,
          );
        }
      }
    }
  }
}

/**
 * The service-account key, as JSON.
 *
 * A malformed key must not leak into the error: `JSON.parse` failures here are
 * reported by shape, never by content, because the content IS a private key.
 */
export function parseAccount(
  raw: string | undefined,
  varName: string = ENV.keyJson,
): ServiceAccount | null {
  if (!raw) return null;
  let parsed: Partial<ServiceAccount>;
  try {
    parsed = JSON.parse(raw) as Partial<ServiceAccount>;
  } catch {
    throw new Error(`${varName} is not valid JSON`);
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error(`${varName} is missing client_email / private_key`);
  }
  return { client_email: parsed.client_email, private_key: parsed.private_key };
}

/** Is this canonical path inside one of the namespaces given? */
export function inManagedNamespace(name: string, namespaces: string[]): boolean {
  return namespaces.some((ns) => name.startsWith(ns));
}

/** Every store whose namespaces claim `path`. Zero or one, after `loadConfig`. */
export function storesCovering(
  path: string,
  stores: readonly SecretsStore[],
): SecretsStore[] {
  return stores.filter((s) => inManagedNamespace(path, s.namespaces));
}

/**
 * Which store owns this path — the one question every path-taking tool asks
 * first.
 *
 * NEVER FIRST-WINS. `loadConfig` refuses overlapping namespaces, so a second
 * match is unreachable through configuration; if one ever appears it is refused
 * here rather than resolved by declaration order, because picking would mean
 * picking a credential and a capability.
 */
export function storeForPath(
  path: string,
  stores: readonly SecretsStore[],
):
  | { store: SecretsStore; error?: undefined }
  | { store?: undefined; error: string } {
  const covering = storesCovering(path, stores);
  if (covering.length === 1) return { store: covering[0]! };
  if (covering.length === 0) {
    return {
      error:
        `"${path}" is outside every managed namespace ` +
        `(${describeNamespaces(stores)}). This server will not read or write a ` +
        `parameter outside them.`,
    };
  }
  return {
    error:
      `"${path}" is claimed by more than one store ` +
      `(${covering.map((s) => s.project).join(", ")}), so which project, ` +
      `credential and capability it addresses is ambiguous. Refused.`,
  };
}

/** The store whose namespace list contains `namespace` exactly. */
export function storeForNamespace(
  namespace: string,
  stores: readonly SecretsStore[],
): SecretsStore | undefined {
  return stores.find((s) => s.namespaces.includes(namespace));
}

/** `"/a/" ("proj-a"), "/b/" ("proj-b")` — for an error a human has to act on. */
export function describeNamespaces(stores: readonly SecretsStore[]): string {
  return stores
    .flatMap((s) => s.namespaces.map((n) => `"${n}" (${s.project})`))
    .join(", ");
}
