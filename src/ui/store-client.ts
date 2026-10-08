import type { StradConfig } from "../config/schema.ts";
import type { SecretBag } from "../secrets/index.ts";
import {
  createGcpParameterStore,
  type ParameterStore,
} from "../secrets/parameters/index.ts";
import { normaliseNamespace } from "../secrets/parameters/namespace.ts";
import {
  resolveServerView,
  serverLooksSecrets,
  type SecretsStore,
  type ServerView,
} from "./resolve.ts";

/**
 * Which admin parameter-store client answers for a given page, or a given path.
 *
 * Two callers that had to agree and were in two files: the console's own
 * secrets pages (`src/ui/index.ts`) and the parameter write-back path
 * (`src/http/params.ts`), which writes a rotated credential with the SAME
 * credential through the SAME client. They live here so neither has to import
 * the other — the console's token pages (`src/ui/tokens.ts`) are a third caller,
 * and routing them through the HTTP module would have closed a cycle.
 *
 * Nothing here decides WHETHER a write is allowed. It answers "which store owns
 * this, and what credential reaches it"; the allowlists, the gates and the
 * path-shape checks stay at each call site.
 */

/** The one seam a test substitutes: a store client, in place of a real one. */
export interface StoreClientOptions {
  /** Override the parameter store. Defaults to the real Parameter/Secret Manager client. */
  parametersStore?: (
    view: Extract<ServerView, { kind: "secrets" }>,
    store: SecretsStore,
  ) => ParameterStore;
}

/**
 * The parameter store, MEMOISED per (server, project, service account).
 *
 * It must not be rebuilt per request. The client caches its OAuth access token
 * for an hour (minting one costs an RSA signature and a round trip to Google),
 * and a fresh instance per call throws that cache away. It is keyed because the
 * credential differs per STORE — one page fronts several, each addressing its
 * own GCP project as its own identity — and the key is what stops one store's
 * client answering for another's.
 *
 * What the key does NOT see is a rotated PRIVATE KEY under an unchanged
 * `client_email`, which is the normal shape of a service-account key rotation:
 * this process keeps signing with the old one until core restarts. That is
 * pre-existing and bounded by a redeploy; it is written down here rather than
 * implied away, because the number of keys under it grows with the number of
 * stores on a page.
 */
const storeCache = new Map<string, ParameterStore>();

/**
 * How long the console's admin client holds one reading of its store.
 *
 * Without one, every `/ui/<slug>` load and every action on it enumerated the
 * whole project — a `ListParameterVersions` and a `GetParameterVersion` per
 * parameter, two hundred-odd requests per page on production — which is what
 * made the console slow and what tripped Parameter Manager's per-minute quota
 * into a `429`. With one, a page load reads nothing; a write through this
 * client re-reads only the parameter it wrote (see `snapshot()` in
 * `src/secrets/parameters/gcp.ts`).
 *
 * Minutes rather than `gateway.secrets.ttlSeconds` (a day by default), because
 * this is the human's view of the store and a value written with `gcloud`
 * should show up on its own before anyone wonders where it went. Everything
 * that writes through strad says so sooner: the console's own writes patch the
 * reading, and the `secrets` server's `refresh_gateway` and the console's
 * "Re-read the store" both reach `forgetConsoleStores`.
 */
export const CONSOLE_SNAPSHOT_TTL_MS = 5 * 60_000;

/**
 * Drop every admin client's held reading, so the next console load reads the
 * store. The console's "Re-read the store" and `POST /_strad/store/refresh`
 * call it.
 */
export function forgetConsoleStores(): void {
  for (const store of storeCache.values()) store.forget?.();
}

export function storeFor(
  view: Extract<ServerView, { kind: "secrets" }>,
  selected: SecretsStore,
  opts: StoreClientOptions,
): ParameterStore | null {
  if (opts.parametersStore) return opts.parametersStore(view, selected);
  if (!selected.account) return null;

  const key = `${view.server.slug} ${selected.projectId} ${selected.account.client_email}`;
  const cached = storeCache.get(key);
  if (cached) return cached;

  const store = createGcpParameterStore({
    projectId: selected.projectId,
    location: selected.location,
    account: selected.account,
    pmApiBase: view.pmApiBase,
    smApiBase: view.smApiBase,
    tokenUrl: view.tokenUrl,
    snapshotTtlMs: CONSOLE_SNAPSHOT_TTL_MS,
  });
  storeCache.set(key, store);
  return store;
}

/**
 * The store that owns a given parameter path, and the admin credential for it.
 *
 * A deployment can front more than one parameter store, and since
 * `consoleStores:` it can do so two ways at once: several secrets SLUGS, and
 * several stores on ONE slug's console page. Both are the same question here —
 * a store is a (project, namespaces, credential) triple however it was declared
 * — so the candidate list is flattened across both dimensions and the NAMESPACE
 * decides, exactly as before. Picking "the first one" instead would write
 * strad's parameter with somebody else's admin key and 404 in a way nobody would
 * diagnose.
 *
 * The single-candidate fallback covers a deployment that declares no namespaces
 * at all: with exactly one store there is nothing to disambiguate, and refusing
 * would break a correct config to enforce a rule that only exists for the
 * ambiguous case.
 */
export function storeForPath(
  config: StradConfig,
  secrets: SecretBag,
  path: string,
  opts: StoreClientOptions,
): { store: ParameterStore } | { store: null; reason: string } {
  const candidates = config.servers
    .filter((s) => s.enabled && serverLooksSecrets(s))
    .map((s) => resolveServerView(config, s.slug, secrets))
    .filter((v) => v.kind === "secrets")
    .flatMap((v) => {
      const view = v as Extract<typeof v, { kind: "secrets" }>;
      return view.stores.map((store) => ({ view, store }));
    });

  if (candidates.length === 0) {
    return {
      store: null,
      reason:
        "this deployment declares no secrets/parameters server, so there is no " +
        "store to write to",
    };
  }

  const covering = candidates.filter((c) =>
    c.store.namespaces.some((ns) => path.startsWith(normaliseNamespace(ns))),
  );

  // TWO COVERING STORES IS A REFUSAL, not a first-wins pick. Overlapping
  // namespaces mean two projects both claim this path, and writing a credential
  // into whichever one happened to be declared first is the shape of mistake
  // nobody would ever diagnose — the write succeeds, and the value lands in a
  // store the reader does not read.
  if (covering.length > 1) {
    return {
      store: null,
      reason:
        `${covering.length} parameter stores (${covering
          .map((c) => `${c.view.server.slug}/${c.store.projectId}`)
          .sort()
          .join(", ")}) declare a namespace that covers ${path}, so ` +
        `which store owns it is ambiguous. Narrow one of them.`,
    };
  }

  const chosen =
    covering[0] ?? (candidates.length === 1 ? candidates[0] : undefined);

  if (!chosen) {
    return {
      store: null,
      reason:
        `no secrets store's namespaces cover ${path}, and this ` +
        `deployment has ${candidates.length} of them, so which store owns it ` +
        `is ambiguous`,
    };
  }

  const store = storeFor(chosen.view, chosen.store, opts);
  if (!store) {
    return {
      store: null,
      reason:
        chosen.store.accountReason ??
        `the "${chosen.view.server.slug}" server has no admin service account ` +
          `for ${chosen.store.projectId}, so nothing on core can write a parameter`,
    };
  }
  return { store };
}
