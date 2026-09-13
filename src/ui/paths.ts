/**
 * The console's paths, built in ONE place.
 *
 * The two ends of it live on opposite sides of the app: `src/ui/index.ts`
 * REGISTERS the route, and `src/gateway/entitlements.ts` HANDS IT OUT, as the
 * `authorize_url` in every 424 body. That field's whole job is "here is where a
 * human goes to fix it", so a path the app does not serve makes it worse than
 * absent — the client follows the link into a stock Express 404 instead of the
 * console. Every link the console draws to a server's own page comes from here
 * too, so there is one definition to move and nothing to keep in step with it.
 *
 * Deliberately not a route registry, and deliberately import-free: the gateway
 * can name a console path without pulling the console's dependency tree into it.
 * The shared nav bar (src/ui/nav.ts) is the other reason it stays that way — it
 * names `/connectors` and is imported BY src/ui/render.ts, so taking the constant
 * from the module that renders that page would close a cycle.
 */

/** The console's URL prefix. Everything the human console serves is under it. */
export const UI_PREFIX = "/ui";

/** The Express pattern `src/ui/index.ts` registers the per-server page on. */
export const SERVER_ROUTE = `${UI_PREFIX}/:server`;

/**
 * The console page for one slug, as a path.
 *
 * ENCODED, because one caller is the 424 builder and `slug` there may be a
 * string the caller invented — a `not_configured` entry is whatever they put in
 * `?servers=`. Encoding keeps a `/` or a `%` in that text from adding path
 * segments this URL does not mean. It does not make the path exist: a slug that
 * names nothing lands on the console's own not-found, which is the point.
 */
export function serverConsolePath(slug: string): string {
  return `${UI_PREFIX}/${encodeURIComponent(slug)}`;
}

/**
 * The consolidated servers view: the roster, each entry's secret status, and —
 * where the deployment keeps its roster in a store — the editor.
 *
 * Top-level rather than under `/ui/:server`, because that route is a wildcard:
 * `/ui/connectors` would be one config entry away from being shadowed by a
 * server that happens to be called `connectors`. See src/ui/servers.ts.
 */
export const CONNECTORS_PREFIX = "/connectors";

/** `/connectors`, `/connectors/new`, `/connectors/<slug>/toggle`, … */
export function connectorsPath(...rest: string[]): string {
  return [CONNECTORS_PREFIX, ...rest.map(encodeURIComponent)].join("/");
}
