import type { Request, RequestHandler, Response } from "express";
import type { StradConfig } from "../config/schema.ts";
import { asyncRoute, jsonFailure } from "./async-route.ts";
import type { SecretBag } from "../secrets/index.ts";
import type { ServerSecretProviders } from "../secrets/provider/index.ts";
import { internalCaller } from "../auth/internal-token.ts";
import {
  parseParamWriteRequest,
  PARAM_PROTOCOL,
  STORE_REFRESH_FLOOR_MS,
  type StoreRefreshResponse,
} from "../secrets/param-route.ts";
import {
  gatewayParameterPath,
  oauthParameterPath,
  parameterPath,
  isUsableValue,
  serverParameterPath,
  ParameterStoreError,
  SERVER_PARAM_KINDS,
  type ServerParamKind,
} from "../secrets/parameters/index.ts";
import { connectorVariables } from "../deploy/server-namespaces.ts";
import {
  forgetConsoleStores,
  storeForPath,
  type StoreClientOptions,
} from "../ui/store-client.ts";
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
 * `oauth/` or `static/`. Which kinds a name MAY live under comes from the
 * config (`kindsOf`): both, `oauth/` first, for a variable the server declares
 * on its `oauth:` connector; `static/` alone for every other name. Which of
 * those candidates a read or a write actually addresses is the highest one the
 * store HOLDS — the same precedence every layered read applies, so the copy
 * this route rotates is the copy the next boot and the next render read. The
 * URL has no segment for a kind, the body has no field for one, and nothing
 * here reads a header for one.
 *
 * That is what lets one variable be consented in the console AND rotated by the
 * container that holds it. The consent writes `oauth/`, which outranks
 * `static/`; a rotation addressed to `static/` while an `oauth/` copy exists
 * would land under a copy that shadows it, and the credential would die at the
 * next restart with nothing failing. Falling back to `static/` only when
 * `oauth/` holds nothing is what keeps a connector added over a token already
 * seeded under `static/` rotating that token, rather than 404ing against a
 * consent nobody has given.
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
 * ## Which caller: the credential says
 *
 * Each component holds its OWN internal token, derived by core from the root
 * (src/auth/internal-token.ts). The caller's component is read off the token it
 * presents, never off anything it claims, and a slug is only addressable by
 * the component that serves it: `server.bundle` must be the caller's. So the
 * reach of a container is its own servers' `paramsWritable:` /
 * `paramsRefresh:`, not the union of every server's. A slug on another
 * component gets the same 403 as a name on no list — the same one answer, for
 * the same reason. HACKS.md #63 is what this closed.
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
   * reach a `${NAME}` on core, or a `params: true` builtin, up to a day later.
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
  /** The kinds this name may live under, HIGHEST PRECEDENCE FIRST. Never empty. */
  kinds: readonly ServerParamKind[];
}

/**
 * The config's own slug, variable and candidate KINDS for a requested pair, or
 * null.
 *
 * Returning the CONFIG's strings rather than a boolean is the load-bearing part.
 * A caller that spells the slug or the variable differently gets null; a caller
 * that spells them identically gets back strings that came out of the parsed
 * config, so what reaches `serverParameterPath` never passed through a URL. The
 * candidate kinds are the same property one step further on: they are DERIVED
 * from the config (see `kindsOf`), so there is no request — no body field, no
 * query parameter, no header — that can move a write from one kind to another.
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
 * WHICH KINDS one server's variable may live under, HIGHEST PRECEDENCE FIRST,
 * from the config alone.
 *
 * `static/` alone for a name the server's `oauth:` connector does not own — which
 * is every name on a server with no connector, so such a name is addressed
 * exactly where it always was. Both kinds, `oauth/` first, for a name the
 * connector does own: the consent writes `oauth/`, and a human may have seeded
 * the same name under `static/` (the client id and secret always are, and a
 * refresh token set up by hand is too). The route then takes the first
 * candidate the store holds — see `rotateFirstHeld` and `revealFirstHeld`.
 *
 * The match folds case because the schema's duplicate checks do. It decides
 * which kinds are CANDIDATES and nothing else: the path is still built from the
 * `paramsWritable:` / `paramsRefresh:` spelling, and a parameter stored under a
 * differently-cased spelling is a 404 (`assertSamePath` in
 * src/secrets/parameters/gcp.ts), loudly.
 */
export function kindsOf(
  server: StradConfig["servers"][number],
  variable: string,
): readonly ServerParamKind[] {
  const fold = variable.toLowerCase();
  return connectorVariables(server).some((v) => v.toLowerCase() === fold)
    ? SERVER_PARAM_KINDS
    : ["static"];
}

/** A store miss: the parameter does not exist, or holds no version to read. */
function isMissing(err: unknown): boolean {
  return err instanceof ParameterStoreError && err.status === 404;
}

/**
 * Rotate the FIRST candidate path that exists, and return it.
 *
 * `rotate()` checks for the parameter before it writes anything, so a 404 here
 * has written nothing and trying the next kind is safe. A miss on the LAST
 * candidate is thrown, which is what keeps this from ever creating a parameter:
 * a rotation nobody seeded or consented to fails loudly, as it always has. Any
 * other failure is thrown at once — falling through to a lower kind after a 403
 * or a 5xx would write a copy the higher one still shadows.
 */
async function rotateFirstHeld(
  store: { rotate(path: string, value: string): Promise<void> },
  paths: readonly string[],
  value: string,
): Promise<string> {
  for (const [i, path] of paths.entries()) {
    try {
      await store.rotate(path, value);
      return path;
    } catch (err) {
      if (i < paths.length - 1 && isMissing(err)) continue;
      throw err;
    }
  }
  throw new Error("no candidate parameter path");
}

/**
 * Reveal the FIRST candidate path holding a usable value.
 *
 * The same rule `layerNamespaces` applies to a render: a higher kind that is
 * absent, or present with nothing usable in it, does not shadow a lower kind
 * that holds a real credential. So the boot read agrees with the value the
 * deploy baked about WHICH copy is current, and only differs in how fresh it is.
 */
async function revealFirstHeld(
  store: { reveal(path: string): Promise<string> },
  paths: readonly string[],
): Promise<string> {
  for (const [i, path] of paths.entries()) {
    const last = i === paths.length - 1;
    try {
      const value = await store.reveal(path);
      if (!last && !isUsableValue(value)) continue;
      return value;
    } catch (err) {
      if (!last && isMissing(err)) continue;
      throw err;
    }
  }
  throw new Error("no candidate parameter path");
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
      kinds: kindsOf(server, allowed),
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
): (ParamTarget & { paths: string[] }) | null {
  const caller = internalCaller(
    req.get("authorization"),
    opts.config,
    opts.env,
  );
  if (!caller.ok) {
    res.status(caller.status).json({ error: caller.error });
    return null;
  }

  const listed = lookup(
    opts.config,
    req.params.slug ?? "",
    req.params.variable ?? "",
  );
  // The caller's own component, or nothing. `lookup` already matched the one
  // enabled supplementary server by this slug; its `bundle:` is the component
  // that serves it, and only that component's token may address it.
  const found =
    listed &&
    opts.config.servers.some(
      (s) =>
        s.enabled &&
        s.kind === "supplementary-image" &&
        s.slug === listed.slug &&
        s.bundle === caller.component,
    )
      ? listed
      : null;
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
        `${req.params.slug}/${req.params.variable} from component ` +
        `"${caller.component}": no enabled supplementary-image server on that ` +
        `component names it under ` +
        `${req.method === "GET" ? "paramsWritable: or paramsRefresh:" : "paramsWritable:"}`,
    );
    res.status(403).json({ error: "parameter_not_writable" });
    return null;
  }

  return {
    ...found,
    paths: found.kinds.map((kind) =>
      serverParameterPath(
        opts.config.gateway.env,
        found.slug,
        kind,
        found.variable,
      ),
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

    // Every candidate sits under one slug's `/mcp/{slug}/`, so one store answers
    // for all of them.
    const resolved = storeForPath(
      opts.config,
      opts.secrets,
      found.paths[0]!,
      opts,
    );
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
      await rotateFirstHeld(resolved.store, found.paths, parsed.value);
      // Both halves of what this process holds about the store, exactly as
      // a console write drops them: the runtime providers' reading, and the
      // diagnosis pass `/connectors` and `/api/secrets/readiness` reuse for up to a
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
        `[strad] parameter write-back failed for ${found.paths.join(" or ")}: ${message}`,
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

    // Every candidate sits under one slug's `/mcp/{slug}/`, so one store answers
    // for all of them.
    const resolved = storeForPath(
      opts.config,
      opts.secrets,
      found.paths[0]!,
      opts,
    );
    if (!resolved.store) {
      res
        .status(503)
        .json({ error: "store_unavailable", message: resolved.reason });
      return;
    }

    try {
      const value = await revealFirstHeld(resolved.store, found.paths);
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
          `[strad] parameter read failed for ${found.paths.join(" or ")}: ${message}`,
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
 * ## A held-off call is OWED, not dropped
 *
 * The floor is trailing-edge. A call it holds off schedules ONE re-read for
 * the moment the floor passes, and every further call inside the same window
 * joins that one rather than adding another. Without this, an agent writing
 * `CLIENT_ID` and then `CLIENT_SECRET` ten seconds apart would see the first
 * refresh land and the second held off — and with the fallback TTL at a day,
 * the second value would be a day late with nothing failing. The bound is
 * unchanged: at most one refresh per floor, however many callers ask.
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
  /** Injected in tests, so the owed re-read fires on the test's clock. */
  schedule: (run: () => void, ms: number) => () => void = (run, ms) => {
    const timer = setTimeout(run, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
): RequestHandler {
  const now = opts.now ?? Date.now;
  let lastRefreshAt = -Infinity;
  let cancelOwed: (() => void) | undefined;

  const refresh = (): void => {
    cancelOwed?.();
    cancelOwed = undefined;
    lastRefreshAt = now();
    opts.secretProvider?.invalidate();
    forgetDeploymentDiagnosis({ env: opts.env, store: opts.diagnosticStore });
    forgetConsoleStores();
    event({ evt: "strad.store_refreshed", refreshed: true });
  };

  return (req: Request, res: Response) => {
    // ANY component's own token, and deliberately not narrowed further: the
    // route names no slug and writes nothing, and the floor below is what
    // bounds a caller. The root is not a component's credential and is refused.
    const caller = internalCaller(
      req.get("authorization"),
      opts.config,
      opts.env,
    );
    if (!caller.ok) {
      res.status(caller.status).json({ error: caller.error });
      return;
    }

    const at = now();
    const sinceMs = at - lastRefreshAt;
    if (sinceMs < STORE_REFRESH_FLOOR_MS) {
      cancelOwed ??= schedule(refresh, STORE_REFRESH_FLOOR_MS - sinceMs);
      event({ evt: "strad.store_refreshed", refreshed: false });
      res.status(200).json({
        protocol: PARAM_PROTOCOL,
        ok: true,
        refreshed: false,
        ageSeconds: Math.round(sinceMs / 1000),
      } satisfies StoreRefreshResponse);
      return;
    }

    refresh();
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
 * A server's `${NAME}` resolves from its own `/strad/{env}/mcp/{slug}/oauth/`
 * first, its `static/` second and the gateway namespace third
 * (src/secrets/provider). The write follows the same order and stops at the
 * first path that exists — moving on only after a definite 404. `oauth/` is
 * where the console's Connect stores a token it minted
 * (src/ui/upstream-connector.ts), so it is the one a rotation of that token
 * must land in; a token seeded by hand under `static/` is rotated there. A path
 * that could not be checked stops the walk, because writing a lower layer while
 * a higher one may hold the value would persist a token nothing reads. None of
 * the three existing means the value came from the environment (`envFallback`), which strad cannot
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
      oauthParameterPath(env, slug, variable),
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
