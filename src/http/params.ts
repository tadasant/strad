import type { Request, RequestHandler, Response } from "express";
import type { StradConfig } from "../config/schema.ts";
import { asyncRoute, jsonFailure } from "./async-route.ts";
import type { SecretBag } from "../secrets/index.ts";
import type { ServerSecretProviders } from "../secrets/provider/index.ts";
import { secretEquals } from "../auth/credential.ts";
import { authorizePresence } from "../secrets/presence.ts";
import {
  parseParamWriteRequest,
  PARAM_PROTOCOL,
  STORE_REFRESH_FLOOR_MS,
  type StoreRefreshResponse,
} from "../secrets/param-route.ts";
import {
  gatewayParameterPath,
  parameterPath,
  serverParameterPath,
  ParameterStoreError,
  type ServerParamKind,
} from "../secrets/parameters/index.ts";
import { connectorVariables } from "../deploy/server-namespaces.ts";
import { storeForPath, type StoreClientOptions } from "../ui/store-client.ts";
import { forgetDeploymentDiagnosis } from "../ui/secret-status.ts";
import { event } from "../telemetry/index.ts";
import { errorSummary } from "../util/error-text.ts";

/**
 * `GET`/`POST /_strad/params/{slug}/{VARIABLE}` — a hosted server reading and
 * rewriting ONE of its own managed parameters.
 *
 * CORE ONLY, and that is the whole point: core is the component that holds the
 * store-admin credential. The caller is a bundle, which holds none. See
 * src/secrets/param-route.ts for why the write travels this way rather than as a
 * fourth credential on the container.
 *
 * ## The name never comes from the caller
 *
 * The URL proposes a slug and a variable; the CONFIG disposes. `writableTarget`
 * (POST) and `readableTarget` (GET) look the pair up in that server's own
 * allowlists and return the config's OWN strings, and the store path is composed
 * from those. The request's bytes are used for exactly one thing: an equality
 * test. There is no spelling of a URL that addresses a path no config names —
 * not a traversal, not an encoding trick, not a case fold — because no part of
 * the request is ever concatenated into a path.
 *
 * ## Nor does the KIND
 *
 * A path has a third component the caller does not name at all: the kind,
 * `oauth/` or `static/`. It is derived from the config by `kindOf` — `oauth/`
 * for a variable the server declares on its `oauth:` connector, `static/` for
 * everything else — and the route never reads it off a request. The URL has no
 * segment for it, the body has no field for it, and a caller that sends either
 * is sending bytes nothing looks at.
 *
 * That is what lets one variable be BOTH consented in the console and rotated by
 * the container that holds it. The console's callback mints the credential under
 * `oauth/`, which outranks `static/` in every layered read; this route rotates
 * the same path, so the write wins the read that follows it. Routing a
 * connector's rotation to `static/` instead — which is what this route did
 * before, and why the schema refused the combination outright — wrote to a path
 * the `oauth/` copy permanently shadowed, and the credential died at the next
 * restart with nothing failing.
 *
 * ## Two verbs, two allowlists
 *
 * `paramsWritable:` fences the POST. `paramsRefresh:` widens the GET, and only
 * the GET — see `readableTarget` for why a read of a name is not the same risk
 * as a write of it. Both require `params: true`, which is what makes the read
 * side disclose nothing: the value is already baked onto the calling component.
 *
 * ## What it refuses, and with which words
 *
 * ONE refusal for every "you may not do that to that name": unknown slug,
 * disabled server, variable not on the verb's list. They are the same answer to
 * the caller and telling them apart would turn the route into a
 * config-enumeration oracle for a credential that is otherwise only good for the
 * thing it is scoped to.
 *
 * ## WHAT THE ALLOWLIST DOES NOT BOUND: which caller
 *
 * `STRAD_INTERNAL_TOKEN` is ONE token, broadcast to every supplementary
 * component (`BUNDLE_BOOT_ENV_KEYS` in appspec.ts). Nothing here binds a caller
 * to the slug it addresses, and nothing can: the token is the only thing the
 * caller presents, and every container holds the same one. So the union of every
 * server's `paramsWritable:` is reachable by any container that holds it, not
 * just by the server that owns the name.
 *
 * That is a real widening and it is stated in the docs rather than papered over
 * — see HACKS.md #63. What bounds it is that the union is an OPT-IN list of
 * names a human wrote in the config, empty by default, and that every one of
 * them is a rotating credential rather than a durable one. A component-identity
 * header would narrow the accident and not the attack, because the caller would
 * be choosing its own identity; per-component tokens are the fix, and they are a
 * change to the presence route as much as to this one.
 */

export interface ParamsHandlerOptions {
  config: StradConfig;
  env: NodeJS.ProcessEnv;
  /** The boot-time bag, for resolving the `secrets` server's `consoleEnv:` refs. */
  secrets: SecretBag;
  /**
   * Test seam: substitute the parameter store this route writes through.
   *
   * Defaults to the console's admin store — the same credential, the same
   * client, the same `rotate()`. Deliberately not a second construction path:
   * two ways to build the writer is how one of them ends up holding a different
   * credential from the one the security note describes.
   */
  parametersStore?: StoreClientOptions["parametersStore"];
  /**
   * The runtime providers, so a write here is visible to THIS process at once.
   *
   * The write goes through the admin client; the gateway reads through the
   * resolver client, which holds its own reading of the store for
   * `gateway.secrets.ttlSeconds`. Without this the rotated credential would
   * reach a `${NAME}` on core, or a `params: true` builtin, an hour later.
   */
  secretProvider?: ServerSecretProviders;
  /**
   * The store the console's and the readiness route's diagnosis reads, so the
   * pass held over it is dropped with the reading. Same seam `mountConsoleUi`
   * takes; defaults to the resolver built from the environment.
   */
  diagnosticStore?: Parameters<typeof forgetDeploymentDiagnosis>[0]["store"];
  /** Injected in tests so the re-read floor is not measured on the wall clock. */
  now?: () => number;
}

/**
 * One resolved target: which server, which variable, and under WHICH KIND.
 *
 * All three come out of the parsed config. None of them is a request string.
 */
export interface ParamTarget {
  slug: string;
  variable: string;
  kind: ServerParamKind;
}

/**
 * The config's own slug, variable and KIND for a requested pair, or null.
 *
 * Returning the CONFIG's strings rather than a boolean is the load-bearing part.
 * A caller that spells the slug or the variable differently gets null; a caller
 * that spells them identically gets back strings that came out of the parsed
 * config, so what reaches `serverParameterPath` never passed through a URL. The
 * kind is the same property one step further on: it is DERIVED from the config
 * (see `kindOf`), so there is no request — no body field, no query parameter, no
 * header — that can move a write from one kind to the other.
 */
export function writableTarget(
  config: StradConfig,
  slug: string,
  variable: string,
): ParamTarget | null {
  return targetIn(config, slug, variable, (s) => s.paramsWritable);
}

/**
 * The same lookup for the GET, over a WIDER list: `paramsWritable` ∪
 * `paramsRefresh`.
 *
 * Two lists rather than one because the two verbs are not the same risk.
 * `paramsWritable` fences a WRITE — a name on it can have a working credential
 * replaced — so it stays exactly as narrow as it was. `paramsRefresh` fences a
 * READ of a value this component is already holding: `params: true` (which the
 * schema requires for either list) bakes the server's whole namespace onto this
 * same component at render time, so a name on it discloses nothing the caller
 * does not already have in its own environment. What the read adds is FRESHNESS,
 * which is the entire point.
 *
 * Writable is included here because a writer must be able to read what it is
 * about to rotate — that is the boot read `loadXTwitter` does — and splitting
 * them would mean a config that could write a name but not read it back.
 */
export function readableTarget(
  config: StradConfig,
  slug: string,
  variable: string,
): ParamTarget | null {
  return targetIn(config, slug, variable, (s) => [
    ...s.paramsWritable,
    ...s.paramsRefresh,
  ]);
}

/**
 * WHICH KIND one server's variable is addressed through, from the config alone.
 *
 * `oauth/` for a name that server declares on its `oauth:` connector, `static/`
 * for every other name — which is every name on a server with no connector, so
 * this changes nothing for the servers that had `paramsWritable:` before
 * connectors existed.
 *
 * The rule is not "the refresh token"; it is "a variable this connector owns",
 * and the wider rule is the safe one. `oauth/` OUTRANKS `static/` in every
 * layered read strad performs (see `SERVER_PARAM_KINDS`), so the only write that
 * is guaranteed to win the read that follows it is a write to `oauth/`. Routing
 * a connector's client id to `static/` instead would work right up until an
 * `oauth/` copy of that name existed, and then fail the way this whole change
 * exists to stop: silently, at the next restart.
 *
 * FOLDED CASE, because `parameterId` folds case before it hashes — so
 * `X_OAUTH_REFRESH_TOKEN` and `X_oauth_refresh_token` are one stored parameter,
 * and a config that spelled the two lists differently would otherwise route two
 * names that are one value through two kinds. The schema refuses that spelling
 * WITHIN a connector; it has never had to refuse it across the two mechanisms,
 * and folding here means it does not have to.
 */
export function kindOf(
  server: StradConfig["servers"][number],
  variable: string,
): ServerParamKind {
  const fold = variable.toLowerCase();
  return connectorVariables(server).some((v) => v.toLowerCase() === fold)
    ? "oauth"
    : "static";
}

/** Shared by both: find the server, then match the request against ITS strings. */
function targetIn(
  config: StradConfig,
  slug: string,
  variable: string,
  allowlist: (
    server: Extract<
      StradConfig["servers"][number],
      { kind: "supplementary-image" }
    >,
  ) => readonly string[],
): ParamTarget | null {
  for (const server of config.servers) {
    if (!server.enabled) continue;
    if (server.kind !== "supplementary-image") continue;
    if (server.slug !== slug) continue;
    const allowed = allowlist(server).find((v) => v === variable);
    if (allowed === undefined) return null;
    return {
      slug: server.slug,
      variable: allowed,
      // From the config's own name, never the request's. They are equal strings
      // here, and using the config's is what keeps that a property of the code
      // rather than of this line happening to run after the equality test.
      kind: kindOf(server, allowed),
    };
  }
  return null;
}

/**
 * Shared by both verbs: authorize, then resolve the target from the config.
 *
 * `lookup` is the verb's own allowlist — `writableTarget` for the POST,
 * `readableTarget` for the GET. It is a parameter rather than a branch inside
 * because the ONE property this route rests on is that the returned strings came
 * out of the parsed config; passing the lookup in keeps that true of both verbs
 * by construction.
 */
function target(
  req: Request,
  res: Response,
  opts: ParamsHandlerOptions,
  lookup: typeof writableTarget,
): (ParamTarget & { path: string }) | null {
  const auth = authorizePresence(
    req.get("authorization"),
    opts.env.STRAD_INTERNAL_TOKEN,
    secretEquals,
  );
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return null;
  }

  const found = lookup(
    opts.config,
    req.params.slug ?? "",
    req.params.variable ?? "",
  );
  if (!found) {
    // ONE answer for every shape of "no". See the header.
    //
    // Evented WITH NO FIELDS, and that is the most this can safely say. The
    // likeliest cause is a typo'd or missing `paramsWritable:` / `paramsRefresh:`
    // entry, and the symptom of that is otherwise invisible from core: the caller
    // degrades its own mount on the BUNDLE's /healthz, which nothing scrapes, and
    // logs to a stdout stream that is never shipped. Naming the slug or the
    // variable here would put a caller-chosen string in the ingestor, which
    // telemetry/events.ts refuses on principle — so the event carries the fact
    // and the operator reads core's stderr for the rest.
    event({ evt: "strad.param_refused" });
    console.warn(
      `[strad] refused ${req.method} /_strad/params for ` +
        `${req.params.slug}/${req.params.variable}: no enabled ` +
        `supplementary-image server names it under ` +
        `${req.method === "GET" ? "paramsWritable: or paramsRefresh:" : "paramsWritable:"}`,
    );
    res.status(403).json({ error: "parameter_not_writable" });
    return null;
  }

  return {
    ...found,
    path: serverParameterPath(
      opts.config.gateway.env,
      found.slug,
      found.kind,
      found.variable,
    ),
  };
}

/** `POST` — rotate the parameter to the value in the body. */
export function createParamWriteHandler(
  opts: ParamsHandlerOptions,
): RequestHandler {
  // The inner `try` below is kept: it turns a store failure into a SPECIFIC
  // status, which a catch-all cannot. What `asyncRoute` covers is everything
  // ahead of it — the target lookup, the body parse, the store resolution — none
  // of which was guarded at all.
  return asyncRoute(async (req: Request, res: Response) => {
    const found = target(req, res, opts, writableTarget);
    if (!found) return;

    const parsed = parseParamWriteRequest(req.body);
    if (!parsed.ok) {
      res.status(parsed.status).json({ error: parsed.error });
      return;
    }

    const resolved = storeForPath(opts.config, opts.secrets, found.path, opts);
    if (!resolved.store) {
      res
        .status(503)
        .json({ error: "store_unavailable", message: resolved.reason });
      return;
    }

    try {
      // `rotate()` and nothing else. It already applies the base64url envelope
      // and, for a secret parameter, writes only to Secret Manager so the
      // per-parameter `secretAccessor` grant survives. A second write path
      // here would be a second chance to get both of those wrong.
      await resolved.store.rotate(found.path, parsed.value);
      // Both halves of what this process holds about the store, exactly as
      // a console write drops them: the runtime providers' reading, and the
      // diagnosis pass `/ui` and `/api/secrets/readiness` reuse for up to a
      // minute. Without the second, a connector that has just healed itself
      // through this route keeps reading as broken to whoever polls readiness.
      opts.secretProvider?.invalidate();
      forgetDeploymentDiagnosis({
        env: opts.env,
        store: opts.diagnosticStore,
      });
      event({
        evt: "strad.param_written",
        slug: found.slug,
        variable: found.variable,
      });
      res.status(200).json({ protocol: PARAM_PROTOCOL, ok: true });
    } catch (err) {
      // LOUD. A failed write means the caller's next restart comes back with a
      // dead credential, and the caller is the only thing that can say so in
      // its own health — so it must learn that this failed rather than reading
      // a 200 and moving on.
      const status = err instanceof ParameterStoreError ? err.status : 502;
      const message = errorSummary(err);
      console.error(
        `[strad] parameter write-back failed for ${found.path}: ${message}`,
      );
      event({
        evt: "strad.param_write_failed",
        slug: found.slug,
        variable: found.variable,
      });
      res
        .status(status >= 400 && status < 600 ? status : 502)
        .json({ error: "write_failed", message });
    }
  }, jsonFailure("params_write"));
}

/**
 * `GET` — the parameter's current value.
 *
 * This is the half that closes the race. A container that boots and trusts its
 * baked environment is trusting a value the LAST RENDER read; if a sibling
 * process rotated the credential after that render, the baked one is already
 * dead and the container 401s on its first call, forever. Reading here instead
 * makes the store the source of truth at boot as well as at deploy.
 *
 * It discloses nothing the caller does not already hold: `paramsWritable`
 * requires `params: true`, which bakes the entire namespace onto that same
 * component. What it adds is freshness.
 */
export function createParamReadHandler(
  opts: ParamsHandlerOptions,
): RequestHandler {
  return asyncRoute(async (req: Request, res: Response) => {
    const found = target(req, res, opts, readableTarget);
    if (!found) return;

    const resolved = storeForPath(opts.config, opts.secrets, found.path, opts);
    if (!resolved.store) {
      res
        .status(503)
        .json({ error: "store_unavailable", message: resolved.reason });
      return;
    }

    try {
      const value = await resolved.store.reveal(found.path);
      // The record a runtime refresh would otherwise not leave. Config strings
      // only, never the value — see telemetry/events.ts.
      event({
        evt: "strad.param_read",
        slug: found.slug,
        variable: found.variable,
      });
      // Never cached, for the same reason the presence route is not: the
      // answer changes the moment the caller itself writes a new one, and a
      // stale hit is a dead credential handed to a fresh container.
      res
        .set("cache-control", "no-store")
        .json({ protocol: PARAM_PROTOCOL, value });
    } catch (err) {
      // A parameter nobody has seeded is a 404, and the caller's correct
      // response to it is to keep the value the deploy baked. That is not an
      // incident: it is every deployment that has not rotated yet.
      const status = err instanceof ParameterStoreError ? err.status : 502;
      const message = errorSummary(err);
      if (status !== 404) {
        console.error(
          `[strad] parameter read failed for ${found.path}: ${message}`,
        );
      }
      res
        .status(status >= 400 && status < 600 ? status : 502)
        .json({ error: "read_failed", message });
    }
  }, jsonFailure("params_read"));
}

/**
 * `POST /_strad/store/refresh` — drop this process's reading of the store.
 *
 * The agent's copy of the console's "Re-read the store" button, over the same
 * wire and the same token as the parameter write-back (see param-route.ts for
 * why it is here). It drops exactly what a console write drops — the runtime
 * providers' reading and the diagnosis pass held over it — and writes nothing.
 *
 * The FLOOR is the whole of what makes this safe to expose to an agent: a
 * reading younger than `STORE_REFRESH_FLOOR_MS` is left alone and the answer
 * says so, so a caller in a loop cannot make core enumerate the project more
 * than once per floor. The floor is measured from the last refresh THIS route
 * performed, not from the reading's own age — the route cannot see that, and
 * a console write between two calls is not something it should be charged for.
 *
 * It is a PER-PROCESS floor, and it is global only because core runs as one
 * instance (`instance_count: 1` for the core service in
 * src/deploy/appspec.ts). A core that scaled out would hold one floor per
 * replica, and a caller's bound would multiply by the replica count; the
 * bundle path guards its own single-writer assumption in the renderer, and
 * this one is worth the same guard on the day core grows a second instance.
 */
export function createStoreRefreshHandler(
  opts: ParamsHandlerOptions,
): RequestHandler {
  const now = opts.now ?? Date.now;
  let lastRefreshAt = -Infinity;
  return (req: Request, res: Response) => {
    const auth = authorizePresence(
      req.get("authorization"),
      opts.env.STRAD_INTERNAL_TOKEN,
      secretEquals,
    );
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }

    const at = now();
    const sinceMs = at - lastRefreshAt;
    if (sinceMs < STORE_REFRESH_FLOOR_MS) {
      event({ evt: "strad.store_refreshed", refreshed: false });
      res.status(200).json({
        protocol: PARAM_PROTOCOL,
        ok: true,
        refreshed: false,
        ageSeconds: Math.round(sinceMs / 1000),
      } satisfies StoreRefreshResponse);
      return;
    }

    lastRefreshAt = at;
    opts.secretProvider?.invalidate();
    forgetDeploymentDiagnosis({ env: opts.env, store: opts.diagnosticStore });
    event({ evt: "strad.store_refreshed", refreshed: true });
    res.status(200).json({
      protocol: PARAM_PROTOCOL,
      ok: true,
      refreshed: true,
    } satisfies StoreRefreshResponse);
  };
}

/**
 * The same write-back, for a credential that rotated INSIDE core.
 *
 * A `remote-http` server with `oauthRefresh:` is proxied by core itself, so
 * when its token endpoint issues a new refresh token there is no bundle to
 * call the route above — the minter is already in the process holding the
 * admin credential. This is that route's write with the HTTP taken out: the
 * same `storeForPath`, the same `rotate()`, the same two invalidations, the
 * same two events. The store path is composed from the config's slug and the
 * config's own `${NAME}` (`soleRefName` in src/config/schema.ts), never from a
 * request.
 *
 * ## Where it writes: where the reader reads
 *
 * A server's `${NAME}` resolves from `/strad/{env}/mcp/{slug}/static/` first
 * and the gateway namespace second (src/secrets/provider). The write follows the
 * same order and stops at the first path that exists: the server's own path, or
 * — only on a definite 404 there — the gateway path. A path that could not be
 * checked stops the walk, because writing the second layer while the first may
 * hold the value would persist a token nothing reads. Neither path existing
 * means the value came from the environment (`envFallback`), which strad cannot
 * write; so does `gateway.secrets.provider: env`. Both are reported, never
 * thrown: a rotation that cannot be persisted still serves this process, and
 * the next restart is the one that fails — which is what the stderr line says.
 *
 * Writing the gateway path is safe because the schema refuses two
 * `oauthRefresh:` servers minting from one `${NAME}`: a shared name there is
 * one server's refresh token, not a credential another server also reads.
 *
 * ## The read before the write
 *
 * The parameter is REVEALED first, and the write goes ahead only if the value
 * held is one the minter's lineage produced (`ours`). Between the exchange
 * that rotated the token and this write, a human can re-seed the slug with
 * another account's token in `/ui/secrets`; a blind `rotate()` after that
 * would put the old account's rotation on top of the new seed, and the slug
 * would serve the old account again with nothing failing. The read shrinks
 * that window from a store round-trip to the gap between two calls; there is
 * no compare-and-set on the store to close it entirely, and `HACKS.md` #91
 * says so.
 */
export function createParameterWriteBack(
  opts: Omit<ParamsHandlerOptions, "now">,
): (
  slug: string,
  variable: string,
  value: string,
  ours: (current: string) => boolean,
) => Promise<void> {
  return async (slug, variable, value, ours) => {
    const refuse = (reason: string): void => {
      console.warn(
        `[strad] could not persist the rotated \${${variable}} for "${slug}": ` +
          `${reason}. It is held in memory; a restart reads the stored one, ` +
          `which the provider has invalidated.`,
      );
      event({ evt: "strad.param_write_failed", slug, variable });
    };

    if (opts.config.gateway.secrets.provider !== "gcp-parameter-store") {
      refuse(
        "gateway.secrets.provider is env, so the value lives in the " +
          "deployment's environment and there is no store to write to",
      );
      return;
    }

    const env = opts.config.gateway.env;
    for (const path of [
      parameterPath(env, slug, variable),
      gatewayParameterPath(env, variable),
    ]) {
      const resolved = storeForPath(opts.config, opts.secrets, path, opts);
      if (!resolved.store) {
        refuse(resolved.reason);
        return;
      }
      let current: string;
      try {
        current = await resolved.store.reveal(path);
      } catch (err) {
        if (err instanceof ParameterStoreError && err.status === 404) continue;
        refuse(errorSummary(err));
        return;
      }
      if (!ours(current)) {
        refuse(
          "the stored value is not one this process minted — it was re-seeded " +
            "since the exchange, so the rotation is left unwritten and the " +
            "seeded value stands",
        );
        return;
      }
      try {
        await resolved.store.rotate(path, value);
      } catch (err) {
        refuse(errorSummary(err));
        return;
      }
      opts.secretProvider?.invalidate();
      forgetDeploymentDiagnosis({ env: opts.env, store: opts.diagnosticStore });
      event({ evt: "strad.param_written", slug, variable });
      return;
    }
    refuse(
      "neither this server's namespace nor the gateway's holds it, so it " +
        "resolves from the environment",
    );
  };
}
