import type { Request, RequestHandler, Response } from "express";

import { bearerToken, secretEquals } from "../auth/credential.ts";
import {
  depositKeyRef,
  gatewayDepositRefusal,
  type StradConfig,
} from "../config/schema.ts";
import { grantAuthority, isConnectorClientPath } from "../connectors/index.ts";
import type { RuntimeConfig } from "../config/runtime.ts";
import {
  DEPOSIT_GATEWAY_TARGET,
  DEPOSIT_PROTOCOL,
  depositToken,
  isDepositSlug,
  isDepositVariable,
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
import { forgetDeploymentDiagnosis } from "../ui/secret-status.ts";
import { storeForPath, type StoreClientOptions } from "../ui/store-client.ts";
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
 * `gatewayDepositRefusal` passes in the config that runs: the `${NAME}` of
 * some bundle's tailnet key, read by nothing else, not a boot key. It is
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
  const why = gatewayDepositRefusal(opts.config, variable);
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

    const slug = req.params.slug ?? "";
    const variable = req.params.variable ?? "";
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
