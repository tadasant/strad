import type { Request, RequestHandler, Response } from "express";
import type { StradConfig } from "../config/schema.ts";
import { asyncRoute, jsonFailure } from "./async-route.ts";
import { internalCaller } from "../auth/internal-token.ts";
import {
  PARAM_PROTOCOL,
  parseInstancePath,
  type InstanceDescriptor,
  type InstanceEnvResponse,
  type InstanceListResponse,
} from "../secrets/param-route.ts";
import {
  isUsableValue,
  layerNamespaces,
  serverNamespaces,
  type ParameterResolver,
} from "../secrets/parameters/index.ts";
import { event } from "../telemetry/index.ts";
import { errorSummary } from "../util/error-text.ts";

/**
 * `GET /_strad/instances?bundle=` and `GET /_strad/instances/{slug}` — the
 * bundle host learning which store-served instances to run, and what each one
 * holds.
 *
 * CORE ONLY, for the reason the parameter routes are: core holds the resolver,
 * the bundle holds no cloud credential. See src/secrets/param-route.ts for the
 * instance model, and src/http/params.ts for the wire these share.
 *
 * ## The config is live
 *
 * `opts.config` is the config the app was BUILT with, and core rebuilds the app
 * on every roster change (src/gateway/reload.ts). So a slug a runtime write
 * created is in the list on the next request after the write, with no deploy
 * and no restart — which is the whole of what the list route is for.
 *
 * ## What the env route discloses, and to whom
 *
 * One slug's own `/strad/{env}/mcp/{slug}/` namespace, both kinds layered, and
 * only for an ENABLED `supplementary-image` entry whose `path:` is its own
 * instance path. The slug and the namespace come out of the config, never out of
 * the URL: the request's slug is used for an equality test, and the namespace is
 * composed from the config's copy.
 *
 * The caller is the component that serves the slug, and nothing else can be.
 * Each component holds its own internal token, derived by core from the root
 * (src/auth/internal-token.ts), and both routes read the caller's component off
 * the token it presents: the list answers for that component only, and the env
 * route serves a slug only when its `bundle:` is the caller's. So an instance's
 * values reach exactly the container that runs it — `bundle-zimmer-secrets`, a
 * third-party image or any other component asking for another's slug gets the
 * same 403 as a slug that is not an instance. HACKS.md #63 is the mechanism,
 * HACKS.md #100 the rest of what an instance does not cover.
 *
 * ## One answer for every "no"
 *
 * Unknown slug, disabled entry, an entry that is not an instance: the same 403,
 * for the reason `target` in params.ts gives. Telling them apart would make the
 * route an oracle for which slugs a deployment holds credentials for.
 */

export interface InstancesHandlerOptions {
  config: StradConfig;
  env: NodeJS.ProcessEnv;
  /**
   * The resolver the runtime providers read through — the one reading of the
   * store this process holds. Absent under `gateway.secrets.provider: env`,
   * where the schema refuses an instance path anyway.
   */
  resolver?: Pick<ParameterResolver, "resolve"> | null;
}

/** The enabled instances core routes to `bundle`, from the config alone. */
export function instancesFor(
  config: StradConfig,
  bundle: string,
): InstanceDescriptor[] {
  const out: InstanceDescriptor[] = [];
  for (const server of config.servers) {
    const found = instanceOf(server);
    if (!found || server.kind !== "supplementary-image") continue;
    if (server.bundle !== bundle) continue;
    out.push(found);
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * The instance an entry IS, or null.
 *
 * Enabled, supplementary, on an instance path, and that path naming the entry's
 * own slug. The schema already refuses the last one failing; checking it again
 * here keeps a namespace from ever being composed out of a path a boot leniently
 * accepted.
 */
function instanceOf(
  server: StradConfig["servers"][number],
): InstanceDescriptor | null {
  if (!server.enabled || server.kind !== "supplementary-image") return null;
  const parsed = parseInstancePath(server.path);
  if (!parsed || parsed.slug !== server.slug) return null;
  return { slug: server.slug, tree: parsed.tree };
}

/** The calling component, read off its own token — or null, having answered. */
function caller(
  req: Request,
  res: Response,
  opts: InstancesHandlerOptions,
): string | null {
  // Every answer from both routes, refusals included: none of them describes
  // anything a cache may hold, and the 200 of one of them is credentials.
  res.set("cache-control", "no-store");
  const found = internalCaller(req.get("authorization"), opts.config, opts.env);
  if (!found.ok) {
    res.status(found.status).json({ error: found.error });
    return null;
  }
  return found.component;
}

/** `GET /_strad/instances?bundle=` — which instances this component should run. */
export function createInstanceListHandler(
  opts: InstancesHandlerOptions,
): RequestHandler {
  return (req: Request, res: Response) => {
    const component = caller(req, res, opts);
    if (component === null) return;
    const bundle = typeof req.query.bundle === "string" ? req.query.bundle : "";
    if (!bundle) {
      res.status(400).json({ error: "bundle_required" });
      return;
    }
    // The query names the bundle; the token says which one is asking. A
    // component may list its own instances and nobody else's.
    if (bundle !== component) {
      event({ evt: "strad.instance_refused" });
      res.status(403).json({ error: "instance_not_served" });
      return;
    }
    // No event: every component calls this every sync interval, and a record
    // of "nothing changed" on each is noise. The env read below is the record.
    res.set("cache-control", "no-store").json({
      protocol: PARAM_PROTOCOL,
      instances: instancesFor(opts.config, bundle),
    } satisfies InstanceListResponse);
  };
}

/** `GET /_strad/instances/{slug}` — one instance's own namespace. */
export function createInstanceEnvHandler(
  opts: InstancesHandlerOptions,
): RequestHandler {
  return asyncRoute(async (req: Request, res: Response) => {
    const component = caller(req, res, opts);
    if (component === null) return;

    const requested = req.params.slug ?? "";
    // Served only to the component the slug is on — the one that runs it.
    const found = instancesFor(opts.config, component).find(
      (i) => i.slug === requested,
    );
    if (!found) {
      event({ evt: "strad.instance_refused" });
      res.status(403).json({ error: "instance_not_served" });
      return;
    }

    if (!opts.resolver) {
      res.status(503).json({
        error: "store_unavailable",
        message: "this gateway has no parameter store to read an instance from",
      });
      return;
    }

    let layered: Record<string, string>;
    try {
      // The config's slug, not the request's. Both kinds, `oauth/` first — the
      // same precedence every other layered read applies, so a consent in the
      // console outranks a hand-seeded copy here exactly as it does at render.
      layered = layerNamespaces(
        await Promise.all(
          serverNamespaces(opts.config.gateway.env, found.slug).map((ns) =>
            opts.resolver!.resolve(ns),
          ),
        ),
      );
    } catch (err) {
      console.error(
        `[strad] could not read the namespace for instance "${found.slug}": ${errorSummary(err)}`,
      );
      event({ evt: "strad.instance_read_failed", slug: found.slug });
      res.status(502).json({ error: "read_failed" });
      return;
    }

    // Usable values only. A `__REF__` pointer that did not dereference, or an
    // empty payload, is not a credential — handing one to a tree would make
    // `missingCredentials()` call it present and the first call fail upstream.
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(layered)) {
      if (isUsableValue(value)) env[name] = value;
    }

    event({
      evt: "strad.instance_read",
      slug: found.slug,
      tree: found.tree,
      variables: Object.keys(env).length,
    });
    res.set("cache-control", "no-store").json({
      protocol: PARAM_PROTOCOL,
      slug: found.slug,
      tree: found.tree,
      env,
    } satisfies InstanceEnvResponse);
  }, jsonFailure("instance_env"));
}
