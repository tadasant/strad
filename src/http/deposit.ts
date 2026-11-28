import type { Request, RequestHandler, Response } from "express";

import { bearerToken, secretEquals } from "../auth/credential.ts";
import {
  depositKeyRef,
  isStradOwnedTarget,
  gatewayDepositRefusal,
  gatewayDepositSharedBy,
  type StradConfig,
} from "../config/schema.ts";
import { grantAuthority, isConnectorClientPath } from "../connectors/index.ts";
import type { RuntimeConfig } from "../config/runtime.ts";
import {
  DEPOSIT_GATEWAY_TARGET,
  DEPOSIT_PROTOCOL,
  depositToken,
  isDepositSlug,
  isDepositStoreName,
  isDepositStoreTarget,
  isDepositVariable,
  parseDepositReplace,
  parseDepositRequest,
  type DepositReceipt,
  type DepositRefusal,
} from "../secrets/deposit-wire.ts";
import { DEPOSIT_PROCESS_CONTROL } from "../secrets/deposit-names.ts";
import type { SecretBag } from "../secrets/index.ts";
import {
  gatewayParameterPath,
  ParameterStoreError,
  serverParameterPath,
  validateVariableName,
  type ParameterStore,
} from "../secrets/parameters/index.ts";
import type { ServerSecretProviders } from "../secrets/provider/index.ts";
import { refsIn } from "../secrets/provider/resolve.ts";
import {
  createSecretManagerDepositor,
  type SecretManagerDepositor,
  type SecretManagerDepositorConfig,
} from "../secrets/secret-manager-deposit.ts";
import { resolveConsoleKey, resolveServerView } from "../ui/resolve.ts";
import { forgetDeploymentDiagnosis } from "../ui/secret-status.ts";
import {
  storeFor,
  storeForPath,
  type StoreClientOptions,
} from "../ui/store-client.ts";
import { event } from "../telemetry/index.ts";
import { errorSummary } from "../util/error-text.ts";
import { asyncRoute, jsonFailure } from "./async-route.ts";

/**
 * `POST /_strad/deposit/{slug}/{VARIABLE}` — a WRITE-ONLY door into strad's
 * parameter store, for strad-hostd's custody server.
 *
 * The custody server captures a credential in the owner's browser into an
 * opaque handle, and its `deposit` tool posts the value here. The value goes
 * laptop → core over TLS; no model, transcript or Zimmer process ever holds
 * it. See docs/servers/hostd-custody.md for the whole flow and
 * src/secrets/deposit-wire.ts for the wire both ends share.
 *
 * ## What it can do — and the four things it cannot
 *
 * It CREATES one secret parameter at `/strad/{env}/mcp/{slug}/static/{VAR}`,
 * through `store.create()` with the console's own admin credential, so the
 * base64url envelope, the version and the per-parameter `secretAccessor`
 * grant are exactly the console's. Then it answers with the path and the
 * version. That is all:
 *
 *   - **No read.** There is no GET, and no answer ever carries a value.
 *   - **No overwrite.** A name that exists under `static/` OR `oauth/` is a
 *     409, checked before the write; `create()` itself 409s on the rest. A
 *     write-only door that could REPLACE a live credential could redirect an
 *     agent's traffic to an account of the attacker's choosing, which is the
 *     one harm "write-only" does not otherwise rule out.
 *   - **No other namespace.** The path is composed here from the `static`
 *     kind and the two URL segments after a shape check, so `oauth/` is not
 *     addressable by any spelling. The gateway namespace is reachable only
 *     through the reserved `_gateway` target, below, and only for one kind
 *     of name.
 *   - **No plain parameter.** `secret: true`, always.
 *
 * ## Who may call it
 *
 * Only an enabled `local-tunnel` entry that declares `deposit:` in the
 * CHECKED-IN config (`grantAuthority`, the same document the connector grant
 * trusts — a runtime roster write cannot add one). Its bearer is derived from
 * that entry's own key (`depositToken`), so the caller is identified by which
 * key matched, never by anything it claims, and `deposit.into:` narrows which
 * slugs it may name. A `params: true` slug takes one more grant: `into:`
 * naming it, or `deposit.paramsVariables:` naming the exact (slug, VARIABLE).
 *
 * ## The one gateway door
 *
 * `POST /_strad/deposit/_gateway/{VARIABLE}` creates
 * `/strad/{env}/gateway/static/{VARIABLE}` — where the renderer reads a
 * bundle's `tailnet.authKey`, which has no per-slug fallback. Only for a name
 * the caller lists in `deposit.gatewayVariables:` AND that
 * `gatewayDepositRefusal` and `gatewayDepositSharedBy` pass in the config that
 * runs: the `${NAME}` of some bundle's tailnet key, read by nothing else, not
 * a boot key. It is
 * create-only like the rest: a name already in that namespace, or one that
 * resolves from any layer (the store or core's environment), is a 409.
 */

export interface DepositHandlerOptions {
  config: StradConfig;
  env: NodeJS.ProcessEnv;
  secrets: SecretBag;
  /** The checked-in document, when a roster overlay is in force. */
  runtimeConfig?: () => RuntimeConfig | null;
  /** Resolves each caller's `${NAME}` slug key; also invalidated after a write. */
  secretProvider?: ServerSecretProviders;
  /** Test seam: the admin store, as the console and the write-back route take it. */
  parametersStore?: StoreClientOptions["parametersStore"];
  diagnosticStore?: Parameters<typeof forgetDeploymentDiagnosis>[0]["store"];
  /** Test seam: the Secret Manager client a `format: secret-manager` store writes with. */
  secretManagerDepositor?: (
    cfg: SecretManagerDepositorConfig,
  ) => SecretManagerDepositor;
}

type Caller = Extract<StradConfig["servers"][number], { kind: "local-tunnel" }>;

function refuse(
  res: Response,
  status: number,
  error: DepositRefusal,
  message?: string,
): void {
  res
    .status(status)
    .set("cache-control", "no-store")
    .json({
      protocol: DEPOSIT_PROTOCOL,
      error,
      ...(message ? { message } : {}),
    });
}

/**
 * The deposit caller a presented bearer belongs to, or null.
 *
 * Every candidate is checked — no early exit on a match — so the time taken
 * does not say which of several callers a near-miss was closest to. The set is
 * one or two entries in practice.
 */
async function callerFor(
  presented: string | undefined,
  opts: DepositHandlerOptions,
): Promise<Caller | null> {
  if (!presented || !opts.secretProvider) return null;
  const authority = grantAuthority(opts) ?? opts.config;
  let found: Caller | null = null;
  for (const server of authority.servers) {
    if (server.kind !== "local-tunnel" || !server.enabled || !server.deposit)
      continue;
    const ref = depositKeyRef(server.headers);
    if (!ref) continue;
    const key = await opts.secretProvider
      .forServer(server.slug)
      .get(ref)
      .catch(() => null);
    if (!key) continue;
    if (secretEquals(presented, depositToken(key)) && !found) found = server;
  }
  return found;
}

/**
 * Why `variable` may not be deposited for `slug`, from the config that RUNS
 * (overlay included — it is what will read the value), or undefined.
 */
export function refusalForTarget(
  config: StradConfig,
  caller: Caller,
  slug: string,
  variable: string,
): string | undefined {
  if (DEPOSIT_PROCESS_CONTROL.test(variable))
    return `${variable} is a name a process reads as configuration, not a credential; it cannot be deposited`;
  const target = config.servers.find((s) => s.slug === slug);
  if (!target) return undefined;
  // A machine's own keys — this caller's, or another custody host's — are
  // placed by a human. A deposit that could seed one could mint a caller.
  if (target.kind === "local-tunnel")
    return `${slug} is a local-tunnel machine; its keys are placed by a human, not deposited`;
  // A value in a URL decides WHERE a slug's traffic and headers go.
  if (
    "url" in target &&
    typeof target.url === "string" &&
    refsIn(target.url).includes(variable)
  )
    return `${variable} is part of ${slug}'s url, which decides where its traffic goes; it cannot be deposited`;
  // A `params: true` server takes its whole namespace into its environment,
  // so a deposit there is a new environment variable on a container. Only a
  // caller that names the slug in `into:`, or this exact pair in
  // `paramsVariables:`, may do that.
  if (
    "params" in target &&
    target.params === true &&
    !caller.deposit?.into?.includes(slug) &&
    !pairGranted(config, caller, slug, variable)
  )
    return `${slug} loads its whole namespace into its environment; only a caller that lists it in deposit.into, or lists ${slug}: [${variable}] in deposit.paramsVariables, may deposit there`;
  return undefined;
}

/**
 * Whether the caller's `deposit.paramsVariables:` grants exactly this
 * (slug, VARIABLE) pair: listed there, case-sensitively like the variable a
 * process reads, AND a `params: true` slug in the config that runs. A pair
 * whose slug is not `params: true` grants nothing, so it can never carry a
 * deposit past `into:` to an ordinary slug.
 */
function pairGranted(
  config: StradConfig,
  caller: Caller,
  slug: string,
  variable: string,
): boolean {
  const names = caller.deposit?.paramsVariables;
  if (!names || !Object.hasOwn(names, slug)) return false;
  if (!(names[slug] ?? []).includes(variable)) return false;
  const target = config.servers.find((s) => s.slug === slug);
  return !!target && "params" in target && target.params === true;
}

/** Whether `path` exists in the store, read NOW rather than from a held listing. */
async function exists(store: ParameterStore, path: string): Promise<boolean> {
  if (store.isSecret) return (await store.isSecret(path)) !== undefined;
  const prefix = path.slice(0, path.lastIndexOf("/") + 1);
  return (await store.list(prefix)).some((p) => p.path === path);
}

/** Create `path` with `value`, and answer 201 with where it went. */
async function create(
  res: Response,
  caller: Caller,
  store: ParameterStore,
  path: string,
  value: string,
  opts: DepositHandlerOptions,
): Promise<void> {
  const created = await store.create({
    path,
    secret: true,
    value,
    note: `deposited by ${caller.slug}`,
    // The console's rule, from the checked-in config: an `oauth:`
    // connector's own client is the one secret the console must read back.
    consoleReadable: isConnectorClientPath(grantAuthority(opts), path),
  });
  opts.secretProvider?.invalidate();
  forgetDeploymentDiagnosis({
    env: opts.env,
    store: opts.diagnosticStore,
  });
  // `caller` is a config string. The target is the caller's bytes and goes
  // to stderr only — see the `strad.param_refused` note in events.ts.
  event({ evt: "strad.deposit_written", caller: caller.slug });
  console.log(`[strad] ${caller.slug} deposited ${path}`);
  const receipt: DepositReceipt = {
    protocol: DEPOSIT_PROTOCOL,
    path,
    version: created.latestVersion ?? "v1",
  };
  res.status(201).set("cache-control", "no-store").json(receipt);
}

/** Answer a store failure on the create: a 409 is `exists`, the rest `write_failed`. */
function failed(
  res: Response,
  caller: Caller,
  path: string,
  err: unknown,
): void {
  const status = err instanceof ParameterStoreError ? err.status : 502;
  if (status === 409) {
    refuse(res, 409, "exists", `${path} already exists`);
    return;
  }
  console.error(
    `[strad] deposit by ${caller.slug} into ${path} failed: ${errorSummary(err)}`,
  );
  event({
    evt: "strad.deposit_failed",
    caller: caller.slug,
    ...(err instanceof ParameterStoreError ? { status } : {}),
  });
  refuse(
    res,
    status >= 400 && status < 600 ? status : 502,
    "write_failed",
    errorSummary(err),
  );
}

/**
 * `POST /_strad/deposit/_gateway/{VARIABLE}`: create one name in the GATEWAY
 * namespace, for a caller that lists it in `deposit.gatewayVariables:`, when
 * the config that runs still makes it a bundle's tailnet key and nothing else.
 */
async function depositIntoGateway(
  req: Request,
  res: Response,
  caller: Caller,
  variable: string,
  opts: DepositHandlerOptions,
): Promise<void> {
  if (!isDepositVariable(variable) || validateVariableName(variable) !== null) {
    refuse(
      res,
      400,
      "bad_target",
      "the variable must be an environment-variable name",
    );
    return;
  }
  // Exact and case-sensitive, like the name the renderer resolves.
  if (!caller.deposit?.gatewayVariables?.includes(variable)) {
    refuse(
      res,
      403,
      "not_permitted",
      `${caller.slug} may deposit into the gateway namespace only a name it lists in deposit.gatewayVariables` +
        (caller.deposit?.gatewayVariables
          ? ` (${caller.deposit.gatewayVariables.join(", ")})`
          : ", and it lists none"),
    );
    return;
  }
  // The schema already refused a list entry that fails this, but the config
  // that RUNS is the one that decides: re-ask it here.
  const why =
    gatewayDepositRefusal(opts.config, variable) ??
    (gatewayDepositSharedBy(
      opts.config as unknown as Record<string, unknown>,
      variable,
    )
      ? "something outside bundles: also reads it, so a deposit would seed more than a tailnet key"
      : undefined);
  if (why) {
    refuse(res, 403, "not_permitted", `${variable}: ${why}`);
    return;
  }

  const parsed = parseDepositRequest(req.body);
  if (!parsed.ok) {
    refuse(res, parsed.status, parsed.error, parsed.message);
    return;
  }

  const path = gatewayParameterPath(opts.config.gateway.env, variable);
  const resolved = storeForPath(opts.config, opts.secrets, path, opts);
  if (!resolved.store) {
    refuse(res, 503, "store_unavailable", resolved.reason);
    return;
  }
  const store = resolved.store;

  try {
    // Create-only from EVERY layer: core's environment, the shared provider
    // (the gateway namespace, then that environment), and the store itself,
    // read now rather than through a cache up to `ttlSeconds` old.
    const current =
      opts.env[variable] ||
      (await opts.secretProvider?.shared.get(variable).catch(() => null));
    if (current || (await exists(store, path))) {
      refuse(
        res,
        409,
        "exists",
        `${variable} already resolves for the gateway; a deposit never replaces a value. Rotate it in the console.`,
      );
      return;
    }
    await create(res, caller, store, path, parsed.value, opts);
  } catch (err) {
    failed(res, caller, path, err);
  }
}

type SupplementaryServer = Extract<
  StradConfig["servers"][number],
  { kind: "supplementary-image" }
>;
type DepositStoreEntry = SupplementaryServer["depositStores"][number];

/** The enabled secrets server that declares the deposit store `name`, and its entry. */
export function findDepositStore(
  config: StradConfig,
  name: string,
): { server: SupplementaryServer; store: DepositStoreEntry } | null {
  for (const server of config.servers) {
    if (server.kind !== "supplementary-image" || !server.enabled) continue;
    const store = server.depositStores.find((d) => d.name === name);
    if (store) return { server, store };
  }
  return null;
}

/** A Secret Manager secret id: the id alphabet, at most 255 long. */
const SECRET_ID = /^[A-Za-z0-9_-]{1,255}$/;

/**
 * Why `target` may not be written in `store`, or undefined. A target is ONE
 * of the store's prefixes plus ONE final segment — an environment-variable
 * name for a parameter store, the rest of a secret id for Secret Manager —
 * so a prefix grants a directory and never the tree under it.
 */
export function refusalForStoreTarget(
  store: DepositStoreEntry,
  target: string,
): string | undefined {
  if (isStradOwnedTarget(target))
    return "that spells one of strad's own parameters or secrets; strad's namespaces are deposited through the slug route, never as a deposit store";
  if (store.format === "parameter") {
    // Any prefix that leaves exactly one variable name — so overlapping
    // prefixes (`/a/`, `/a/b/`) each grant their own directory.
    const variable = store.prefixes
      .filter((p) => p.endsWith("/") && target.startsWith(p))
      .map((p) => target.slice(p.length))
      .find((v) => isDepositVariable(v) && validateVariableName(v) === null);
    if (variable === undefined)
      return `${target} is not one of ${store.name}'s prefixes (${store.prefixes.join(", ")}) followed by one environment-variable name`;
    if (DEPOSIT_PROCESS_CONTROL.test(variable))
      return `${variable} is a name a process reads as configuration, not a credential; it cannot be deposited`;
    return undefined;
  }
  if (
    !SECRET_ID.test(target) ||
    !store.prefixes.some(
      (p) => target.startsWith(p) && target.length > p.length,
    )
  )
    return `${target} is not a secret id that starts with one of ${store.name}'s prefixes (${store.prefixes.join(", ")})`;
  return undefined;
}

/**
 * Secret Manager clients, memoised per (project, identity) for the reason the
 * console's admin clients are: each holds an hour's access token.
 */
const depositorCache = new Map<string, SecretManagerDepositor>();

/** Answer a named-store deposit with where it went. */
function stored(
  res: Response,
  caller: Caller,
  store: DepositStoreEntry,
  path: string,
  version: string,
  replaced: boolean,
  valueVersion?: string,
): void {
  // `caller` and the store's name are config strings; the target is the
  // caller's bytes and goes to the process log only.
  event({
    evt: "strad.deposit_written",
    caller: caller.slug,
    store: store.name,
  });
  console.log(
    `[strad] ${caller.slug} ${replaced ? "replaced" : "deposited"} ${path} in deposit store ${store.name}`,
  );
  const receipt: DepositReceipt = {
    protocol: DEPOSIT_PROTOCOL,
    path,
    version,
    ...(replaced ? { replaced: true } : {}),
    ...(valueVersion ? { valueVersion } : {}),
  };
  res.status(201).set("cache-control", "no-store").json(receipt);
}

/**
 * `POST /_strad/deposit/_store/{store}/{target}`: write one value into a
 * store the checked-in config names in `depositStores:` and the caller names
 * in `deposit.stores:`. See `DepositStore` in src/config/schema.ts.
 *
 * Create-only unless the body says `replace: true` AND the store's entry says
 * `replace: true`; then a target that exists gets a NEW version (the old ones
 * stay, so the write is undoable by whoever holds the store's admin role).
 * Existence is read from metadata — a parameter's listing, a secret's
 * resource — and never from a value.
 */
async function depositIntoStore(
  req: Request,
  res: Response,
  caller: Caller,
  name: string,
  target: string,
  opts: DepositHandlerOptions,
): Promise<void> {
  if (!isDepositStoreName(name) || !isDepositStoreTarget(target)) {
    refuse(
      res,
      400,
      "bad_target",
      "the store must be a deposit store's name and the target a parameter path or a secret id",
    );
    return;
  }
  if (!caller.deposit?.stores?.includes(name)) {
    refuse(
      res,
      403,
      "not_permitted",
      `${caller.slug} may deposit only into the stores its deposit.stores lists` +
        (caller.deposit?.stores
          ? ` (${caller.deposit.stores.join(", ")})`
          : ", and it lists none"),
    );
    return;
  }
  // From the config that RUNS: a store whose entry was removed or whose
  // server was disabled is gone, whatever the caller's grant still says.
  const found = findDepositStore(opts.config, name);
  if (!found) {
    refuse(
      res,
      403,
      "not_permitted",
      `no enabled secrets server declares a deposit store named ${name}`,
    );
    return;
  }
  const { server, store } = found;
  const why = refusalForStoreTarget(store, target);
  if (why) {
    refuse(res, 403, "not_permitted", why);
    return;
  }
  const parsed = parseDepositRequest(req.body);
  if (!parsed.ok) {
    refuse(res, parsed.status, parsed.error, parsed.message);
    return;
  }
  const replace = parseDepositReplace(req.body);
  if (!replace.ok) {
    refuse(res, replace.status, replace.error, replace.message);
    return;
  }
  if (replace.value && !store.replace) {
    refuse(
      res,
      403,
      "not_permitted",
      `deposit store ${name} is create-only: its entry does not say replace: true`,
    );
    return;
  }

  if (store.format === "parameter") {
    const view = resolveServerView(opts.config, server.slug, opts.secrets);
    const selected =
      view.kind === "secrets"
        ? view.stores.find((st) => st.projectId === store.project)
        : undefined;
    const client =
      view.kind === "secrets" && selected
        ? storeFor(view, selected, opts)
        : null;
    if (!client) {
      refuse(
        res,
        503,
        "store_unavailable",
        selected?.accountReason ??
          `${server.slug} has no console store for ${store.project}`,
      );
      return;
    }
    try {
      // Whether a target exists AS A SECRET decides a replace, and a listing
      // alone cannot say: a client that cannot answer is not guessed for.
      if (!client.isSecret) {
        refuse(
          res,
          503,
          "store_unavailable",
          `${server.slug}'s client for ${store.project} cannot say whether a parameter is a secret`,
        );
        return;
      }
      const secret = await client.isSecret(target);
      if (secret === undefined) {
        const created = await client.create({
          path: target,
          secret: true,
          value: parsed.value,
          note: `deposited by ${caller.slug}`,
        });
        stored(
          res,
          caller,
          store,
          target,
          created.latestVersion ?? "v1",
          false,
        );
        return;
      }
      if (!replace.value) {
        refuse(
          res,
          409,
          "exists",
          `${target} already exists in ${name}; a deposit replaces it only when it asks to (replace: true) and the store allows it`,
        );
        return;
      }
      if (secret === false) {
        refuse(
          res,
          409,
          "exists",
          `${target} exists as a PLAIN parameter; a deposit only ever writes a secret, so it will not replace it`,
        );
        return;
      }
      // The parameter keeps its version — its `__REF__` names the secret's
      // `latest` — and the bytes land as a new Secret Manager version, which
      // is what the receipt reports.
      const rotated = await client.rotate(target, parsed.value);
      const prefix = target.slice(0, target.lastIndexOf("/") + 1);
      const meta = (await client.list(prefix)).find((p) => p.path === target);
      stored(
        res,
        caller,
        store,
        target,
        meta?.latestVersion ?? "unknown",
        true,
        rotated?.valueVersion,
      );
    } catch (err) {
      failed(res, caller, target, err);
    }
    return;
  }

  // format: secret-manager — its OWN deposit-only key, never a console admin key.
  const { account, accountReason } = resolveConsoleKey(
    opts.config,
    server.slug,
    store.keyVar ?? "",
    opts.secrets,
  );
  if (!account) {
    refuse(
      res,
      503,
      "store_unavailable",
      accountReason ?? `deposit store ${name} has no credential`,
    );
    return;
  }
  const view = resolveServerView(opts.config, server.slug, opts.secrets);
  const cfg: SecretManagerDepositorConfig = {
    projectId: store.project,
    account,
    ...(view.kind === "secrets"
      ? { smApiBase: view.smApiBase, tokenUrl: view.tokenUrl }
      : {}),
  };
  const key = `${store.project} ${account.client_email}`;
  const depositor =
    opts.secretManagerDepositor?.(cfg) ??
    depositorCache.get(key) ??
    depositorCache.set(key, createSecretManagerDepositor(cfg)).get(key)!;
  const path = `projects/${store.project}/secrets/${target}`;
  try {
    // A secret with no enabled version is what a deposit whose first
    // version failed leaves behind. It holds nothing a reader can read, and
    // this key cannot delete it, so it is filled rather than refused.
    const there =
      (await depositor.exists(target)) && (await depositor.hasVersion(target));
    const shell = !there && (await depositor.exists(target));
    if (there && !replace.value) {
      refuse(
        res,
        409,
        "exists",
        `${path} already exists; a deposit adds a version to it only when it asks to (replace: true) and the store allows it`,
      );
      return;
    }
    let replaced = there;
    if (!there && !shell) {
      try {
        await depositor.create(target, store.labels);
      } catch (err) {
        // Created between the read and the write: create-only means refuse,
        // and a replace goes on to add its version to the one that won.
        if (!(err instanceof ParameterStoreError && err.status === 409))
          throw err;
        if (!replace.value) {
          refuse(res, 409, "exists", `${path} already exists`);
          return;
        }
        replaced = true;
      }
    }
    const { version } = await depositor.addVersion(target, parsed.value);
    stored(res, caller, store, path, version, replaced);
  } catch (err) {
    failed(res, caller, path, err);
  }
}

export function createDepositHandler(
  opts: DepositHandlerOptions,
): RequestHandler {
  return asyncRoute(async (req: Request, res: Response) => {
    const caller = await callerFor(
      bearerToken(req.get("authorization")) ?? undefined,
      opts,
    );
    if (!caller) {
      // No fields: nothing in the request is trusted until a key matched.
      event({ evt: "strad.deposit_refused" });
      refuse(res, 401, "unauthorized");
      return;
    }

    if (req.params.store !== undefined) {
      await depositIntoStore(
        req,
        res,
        caller,
        req.params.store,
        req.params.target ?? "",
        opts,
      );
      return;
    }
    const slug = req.params.slug ?? "";
    const variable = req.params.variable ?? "";
    // `replace` exists for named stores alone. Anywhere else it is refused
    // rather than ignored, so nobody believes it overwrote strad's store.
    if (
      req.body &&
      typeof req.body === "object" &&
      (req.body as Record<string, unknown>).replace !== undefined
    ) {
      refuse(
        res,
        400,
        "bad_body",
        "replace is honoured only by a deposit into a named store (_store); strad's own namespaces are create-only",
      );
      return;
    }
    if (slug === DEPOSIT_GATEWAY_TARGET) {
      await depositIntoGateway(req, res, caller, variable, opts);
      return;
    }
    if (
      !isDepositSlug(slug) ||
      !isDepositVariable(variable) ||
      validateVariableName(variable) !== null
    ) {
      refuse(
        res,
        400,
        "bad_target",
        "the slug must be a strad slug and the variable an environment-variable name",
      );
      return;
    }
    // `into:` narrows the slugs; an exact `paramsVariables:` pair on a
    // `params: true` slug is a grant of its own and is not narrowed by it. The
    // pair still meets every other refusal in refusalForTarget.
    if (
      caller.deposit?.into &&
      !caller.deposit.into.includes(slug) &&
      !pairGranted(opts.config, caller, slug, variable)
    ) {
      refuse(
        res,
        403,
        "not_permitted",
        `${caller.slug} may deposit only into: ${caller.deposit.into.join(", ")}, plus any exact pair in its deposit.paramsVariables`,
      );
      return;
    }
    const targetRefusal = refusalForTarget(opts.config, caller, slug, variable);
    if (targetRefusal) {
      refuse(res, 403, "not_permitted", targetRefusal);
      return;
    }

    const parsed = parseDepositRequest(req.body);
    if (!parsed.ok) {
      refuse(res, parsed.status, parsed.error, parsed.message);
      return;
    }

    const env = opts.config.gateway.env;
    // Composed from the literal `static` kind: the URL has no segment that
    // could name another, and the shapes above rule out a `/` in either part.
    const path = serverParameterPath(env, slug, "static", variable);
    const shadow = serverParameterPath(env, slug, "oauth", variable);

    const resolved = storeForPath(opts.config, opts.secrets, path, opts);
    if (!resolved.store) {
      refuse(res, 503, "store_unavailable", resolved.reason);
      return;
    }
    const store = resolved.store;

    try {
      // A name that ALREADY RESOLVES for this slug — from its `oauth/`, the
      // gateway namespace, or core's environment — would be shadowed by a new
      // `static/` copy, which outranks the last two. That is an overwrite in
      // everything but name, so it is refused like one.
      const current = await opts.secretProvider
        ?.forServer(slug)
        .get(variable)
        .catch(() => null);
      if (current) {
        refuse(
          res,
          409,
          "exists",
          `${variable} already resolves for ${slug}; a deposit never replaces a value a server reads. Rotate it in the console.`,
        );
        return;
      }
      // `oauth/` outranks `static/` on every read, so a deposit beside an
      // existing `oauth/` copy would land under a value that shadows it. Read
      // from the store itself as well as through the provider above, which
      // can hold a reading up to `ttlSeconds` old.
      for (const candidate of [path, shadow]) {
        if (await exists(store, candidate)) {
          refuse(
            res,
            409,
            "exists",
            `${candidate} already exists; a deposit never overwrites. Rotate it in the console.`,
          );
          return;
        }
      }
      await create(res, caller, store, path, parsed.value, opts);
    } catch (err) {
      failed(res, caller, path, err);
    }
  }, jsonFailure("deposit"));
}

/** Any other verb on the route: the door is write-only, and says so. */
export const depositMethodNotAllowed: RequestHandler = (_req, res) => {
  res.status(405).set("allow", "POST").json({
    protocol: DEPOSIT_PROTOCOL,
    error: "method_not_allowed",
    message: "this route is write-only: POST a value, nothing reads one back",
  });
};
