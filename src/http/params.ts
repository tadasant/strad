import { timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import type { StradConfig } from "../config/schema.ts";
import type { SecretBag } from "../secrets/index.ts";
import type { ServerSecretProviders } from "../secrets/provider/index.ts";
import { authorizePresence } from "../secrets/presence.ts";
import {
  parseParamWriteRequest,
  PARAM_PROTOCOL,
  STORE_REFRESH_FLOOR_MS,
  type StoreRefreshResponse,
} from "../secrets/param-route.ts";
import {
  parameterPath,
  ParameterStoreError,
  type ParameterStore,
} from "../secrets/parameters/index.ts";
import { normaliseNamespace } from "../secrets/parameters/namespace.ts";
import { resolveServerView, serverLooksSecrets } from "../ui/resolve.ts";
import { storeFor } from "../ui/index.ts";
import { forgetDeploymentDiagnosis } from "../ui/secret-status.ts";
import { event } from "../telemetry/index.ts";

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
  parametersStore?: Parameters<typeof storeFor>[1]["parametersStore"];
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

/** Node's constant-time compare, wrapped so a length mismatch cannot throw. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * The config's own slug and variable for a requested pair, or null.
 *
 * Returning the CONFIG's strings rather than a boolean is the load-bearing part.
 * A caller that spells the slug or the variable differently gets null; a caller
 * that spells them identically gets back strings that came out of the parsed
 * config, so what reaches `parameterPath` never passed through a URL.
 */
export function writableTarget(
  config: StradConfig,
  slug: string,
  variable: string,
): { slug: string; variable: string } | null {
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
): { slug: string; variable: string } | null {
  return targetIn(config, slug, variable, (s) => [
    ...s.paramsWritable,
    ...s.paramsRefresh,
  ]);
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
): { slug: string; variable: string } | null {
  for (const server of config.servers) {
    if (!server.enabled) continue;
    if (server.kind !== "supplementary-image") continue;
    if (server.slug !== slug) continue;
    const allowed = allowlist(server).find((v) => v === variable);
    if (allowed === undefined) return null;
    return { slug: server.slug, variable: allowed };
  }
  return null;
}

/**
 * The store that owns a given parameter path, and the admin credential for it.
 *
 * A deployment can front more than one parameter store — strad's own `secrets`
 * slug and, in the Tadasant deployment, a second `zimmer-secrets` slug over a
 * different GCP project. They are told apart by `SECRETS_NAMESPACES`, which is
 * already the fence bounding each one, so the path decides which console
 * credential writes it. Picking "the first secrets server" instead would write
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
  opts: Pick<ParamsHandlerOptions, "parametersStore">,
): { store: ParameterStore } | { store: null; reason: string } {
  const candidates = config.servers
    .filter((s) => s.enabled && serverLooksSecrets(s))
    .map((s) => resolveServerView(config, s.slug, secrets))
    .filter((v) => v.kind === "secrets")
    .map((v) => v as Extract<typeof v, { kind: "secrets" }>);

  if (candidates.length === 0) {
    return {
      store: null,
      reason:
        "this deployment declares no secrets/parameters server, so there is no " +
        "store to write to",
    };
  }

  const covering = candidates.filter((view) =>
    view.namespaces.some((ns) => path.startsWith(normaliseNamespace(ns))),
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
        `${covering.length} secrets servers (${covering
          .map((v) => v.server.slug)
          .sort()
          .join(", ")}) declare a SECRETS_NAMESPACES that covers ${path}, so ` +
        `which store owns it is ambiguous. Narrow one of them.`,
    };
  }

  const chosen =
    covering[0] ?? (candidates.length === 1 ? candidates[0] : undefined);

  if (!chosen) {
    return {
      store: null,
      reason:
        `no secrets server's SECRETS_NAMESPACES covers ${path}, and this ` +
        `deployment has ${candidates.length} of them, so which store owns it ` +
        `is ambiguous`,
    };
  }

  const store = storeFor(chosen, opts);
  if (!store) {
    return {
      store: null,
      reason:
        chosen.accountReason ??
        `the "${chosen.server.slug}" server has no admin service account, so ` +
          `nothing on core can write a parameter`,
    };
  }
  return { store };
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
): { slug: string; variable: string; path: string } | null {
  const auth = authorizePresence(
    req.get("authorization"),
    opts.env.STRAD_INTERNAL_TOKEN,
    constantTimeEquals,
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
    path: parameterPath(opts.config.gateway.env, found.slug, found.variable),
  };
}

/** `POST` — rotate the parameter to the value in the body. */
export function createParamWriteHandler(
  opts: ParamsHandlerOptions,
): RequestHandler {
  return (req: Request, res: Response) => {
    void (async () => {
      const found = target(req, res, opts, writableTarget);
      if (!found) return;

      const parsed = parseParamWriteRequest(req.body);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.error });
        return;
      }

      const resolved = storeForPath(
        opts.config,
        opts.secrets,
        found.path,
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
        const message = err instanceof Error ? err.message : String(err);
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
    })();
  };
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
  return (req: Request, res: Response) => {
    void (async () => {
      const found = target(req, res, opts, readableTarget);
      if (!found) return;

      const resolved = storeForPath(
        opts.config,
        opts.secrets,
        found.path,
        opts,
      );
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
        const message = err instanceof Error ? err.message : String(err);
        if (status !== 404) {
          console.error(
            `[strad] parameter read failed for ${found.path}: ${message}`,
          );
        }
        res
          .status(status >= 400 && status < 600 ? status : 502)
          .json({ error: "read_failed", message });
      }
    })();
  };
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
      constantTimeEquals,
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
