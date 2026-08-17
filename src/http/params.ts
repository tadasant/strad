import { timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import type { StradConfig } from "../config/schema.ts";
import type { SecretBag } from "../secrets/index.ts";
import { authorizePresence } from "../secrets/presence.ts";
import {
  parseParamWriteRequest,
  PARAM_PROTOCOL,
} from "../secrets/param-route.ts";
import {
  parameterPath,
  ParameterStoreError,
  type ParameterStore,
} from "../secrets/parameters/index.ts";
import { normaliseNamespace } from "../secrets/parameters/namespace.ts";
import { resolveServerView, serverLooksSecrets } from "../ui/resolve.ts";
import { storeFor } from "../ui/index.ts";
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
 * below looks the pair up in that server's `paramsWritable:` allowlist and
 * returns the config's OWN strings, and the store path is composed from those.
 * The request's bytes are used for exactly one thing: an equality test. There is
 * no spelling of a URL that addresses a path no config names — not a traversal,
 * not an encoding trick, not a case fold — because no part of the request is
 * ever concatenated into a path.
 *
 * ## What it refuses, and with which words
 *
 * ONE refusal for every "you may not write that": unknown slug, disabled server,
 * variable not on the list. They are the same answer to the caller and telling
 * them apart would turn the route into a config-enumeration oracle for a
 * credential that is otherwise only good for the thing it is scoped to.
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
  for (const server of config.servers) {
    if (!server.enabled) continue;
    if (server.kind !== "supplementary-image") continue;
    if (server.slug !== slug) continue;
    const allowed = server.paramsWritable.find((v) => v === variable);
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

/** Shared by both verbs: authorize, then resolve the target from the config. */
function target(
  req: Request,
  res: Response,
  opts: ParamsHandlerOptions,
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

  const found = writableTarget(
    opts.config,
    req.params.slug ?? "",
    req.params.variable ?? "",
  );
  if (!found) {
    // ONE answer for every shape of "no". See the header.
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
      const found = target(req, res, opts);
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
      const found = target(req, res, opts);
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
