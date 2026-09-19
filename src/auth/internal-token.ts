import { createHmac } from "node:crypto";
import type { StradConfig } from "../config/schema.ts";
import { bearerToken, secretEquals } from "./credential.ts";

/**
 * Per-component internal tokens: the caller's component is a property of the
 * credential it presents, not a claim it makes.
 *
 * ## The model
 *
 * `STRAD_INTERNAL_TOKEN` is a ROOT, and it stays on core. Every other component
 * is handed its own token, derived from the root and the component's name:
 *
 *     token(component) = base64url(HMAC-SHA256(root, "strad-internal-token/v1:" + component))
 *
 * and holds it under the SAME variable name, `STRAD_INTERNAL_TOKEN`. That is
 * what keeps every component-side reader unchanged — the bundle host's gate, its
 * presence route, the parameter write-back client, the `secrets` tree, the
 * bundle smoke. Each of them compares with, or presents, "the token in my
 * environment", and the renderer decides which token that is
 * (`componentTokenEnv` in src/deploy/appspec.ts).
 *
 * Core holds the root and derives in both directions:
 *
 *   - core → component: it presents `token(server.bundle)` when it proxies
 *     (`internalHeaders` in src/gateway/registry.ts) and when it asks a
 *     component's presence route. A component can only verify its own token,
 *     so a token for component A is refused at component B.
 *   - component → core: the `/_strad/` routes core serves resolve the caller
 *     from the bearer (`internalCaller` below) and refuse a slug that is not on
 *     the caller's own component. HACKS.md #63 is what this closes.
 *
 * ## Why derived rather than seeded
 *
 * A derived token is one more HMAC, not one more secret: nothing new to seed in
 * any environment, no new human step in prod, and a component added to the
 * config is issued its token by the next render. The costs are stated rather
 * than hidden: whoever holds the root holds every component's token (core does,
 * and so does any strad-image bundle, because it holds the store resolver that
 * reads the root — see `hydrate.ts`), and rotating the root rotates every
 * component at once, on a redeploy. Independent random tokens would isolate a
 * leaked root better, at the price of a secret per component per environment
 * that only a human can create in prod.
 *
 * The version tag is inside the derivation so a change to what a token means
 * gets a new tag, rather than letting an old token be reinterpreted.
 */

const DOMAIN = "strad-internal-token/v1:";

/** The token component `component` holds, derived from the root. */
export function componentToken(root: string, component: string): string {
  return createHmac("sha256", root)
    .update(`${DOMAIN}${component}`)
    .digest("base64url");
}

/**
 * The components core may be called by, and may call: every `bundle:` the
 * config names except core itself, plus every declared `bundles:` entry.
 *
 * Read from the config in hand, so a roster change that names a new component
 * is answered for on the next request — there is still no container for it
 * until a deploy renders one.
 */
export function internalComponents(config: StradConfig): string[] {
  const names = new Set<string>();
  for (const server of config.servers) {
    if (server.kind !== "supplementary-image" && server.kind !== "builtin") {
      continue;
    }
    if (server.bundle !== "core") names.add(server.bundle);
  }
  for (const bundle of config.bundles) {
    if (bundle.name !== "core") names.add(bundle.name);
  }
  return [...names].sort();
}

export type InternalCaller =
  | { ok: true; component: string }
  | { ok: false; status: number; error: string };

/**
 * Which component presented `header`, or the refusal.
 *
 * The same two failure answers as `authorizePresence`, so a caller cannot tell
 * this door from the one it replaced: 503 when core holds no root (fail closed —
 * "on the private network" is a reachability property, not an authorization
 * one), 401 for a missing, malformed or unknown credential. The ROOT itself is
 * not a component's credential and is refused like any other unknown string:
 * no component holds it, so a caller presenting it is not one of ours.
 *
 * Every candidate is compared, constant-time, rather than stopping at the first
 * match, so the time taken does not say which component a near-miss was near.
 */
export function internalCaller(
  header: string | undefined,
  config: StradConfig,
  env: NodeJS.ProcessEnv,
): InternalCaller {
  const root = env.STRAD_INTERNAL_TOKEN;
  if (!root) {
    return { ok: false, status: 503, error: "internal token not configured" };
  }
  const presented = bearerToken(header);
  let matched: string | null = null;
  if (presented) {
    for (const component of internalComponents(config)) {
      if (secretEquals(presented, componentToken(root, component))) {
        matched = component;
      }
    }
  }
  if (matched === null) {
    return { ok: false, status: 401, error: "invalid internal token" };
  }
  return { ok: true, component: matched };
}
