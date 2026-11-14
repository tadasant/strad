import type { Request, RequestHandler, Response } from "express";

import { bearerToken, secretEquals } from "../auth/credential.ts";
import { depositKeyRef, type StradConfig } from "../config/schema.ts";
import { grantAuthority, isConnectorClientPath } from "../connectors/index.ts";
import type { RuntimeConfig } from "../config/runtime.ts";
import {
  DEPOSIT_PROTOCOL,
  depositToken,
  isDepositSlug,
  isDepositVariable,
  parseDepositRequest,
  type DepositReceipt,
  type DepositRefusal,
} from "../secrets/deposit-wire.ts";
import type { SecretBag } from "../secrets/index.ts";
import {
  ParameterStoreError,
  serverParameterPath,
  validateVariableName,
  type ParameterStore,
} from "../secrets/parameters/index.ts";
import type { ServerSecretProviders } from "../secrets/provider/index.ts";
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
 *     kind and the two URL segments after a shape check, so neither the
 *     gateway's namespace nor `oauth/` is addressable by any spelling.
 *   - **No plain parameter.** `secret: true`, always.
 *
 * ## Who may call it
 *
 * Only an enabled `local-tunnel` entry that declares `deposit:` in the
 * CHECKED-IN config (`grantAuthority`, the same document the connector grant
 * trusts — a runtime roster write cannot add one). Its bearer is derived from
 * that entry's own key (`depositToken`), so the caller is identified by which
 * key matched, never by anything it claims, and `deposit.into:` narrows which
 * slugs it may name.
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

/** Whether `path` exists in the store, read NOW rather than from a held listing. */
async function exists(store: ParameterStore, path: string): Promise<boolean> {
  if (store.isSecret) return (await store.isSecret(path)) !== undefined;
  const prefix = path.slice(0, path.lastIndexOf("/") + 1);
  return (await store.list(prefix)).some((p) => p.path === path);
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
    if (caller.deposit?.into && !caller.deposit.into.includes(slug)) {
      refuse(
        res,
        403,
        "not_permitted",
        `${caller.slug} may deposit only into: ${caller.deposit.into.join(", ")}`,
      );
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
      // `oauth/` outranks `static/` on every read, so a deposit beside an
      // existing `oauth/` copy would land under a value that shadows it.
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
      const created = await store.create({
        path,
        secret: true,
        value: parsed.value,
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
    } catch (err) {
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
