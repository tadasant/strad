/**
 * The console's per-server page, in ONE place.
 *
 * Two things need it and they live on opposite sides of the app: `src/ui/index.ts`
 * REGISTERS the route, and `src/gateway/entitlements.ts` HANDS IT OUT, as the
 * `authorize_url` in every 424 body. That field's whole job is "here is where a
 * human goes to fix it", so a path the app does not serve makes it worse than
 * absent — the client follows the link into a stock Express 404 instead of the
 * console. One definition, imported by both, is what keeps a rename honest.
 *
 * Deliberately not a route registry: a module with no imports, so the gateway can
 * name a console path without pulling the console's dependency tree into it.
 */

/** The console's URL prefix. Everything the human console serves is under it. */
export const UI_PREFIX = "/ui";

/** The Express pattern `src/ui/index.ts` registers the per-server page on. */
export const SERVER_ROUTE = `${UI_PREFIX}/:server`;

/**
 * The console page for one slug, as a path.
 *
 * ENCODED: callers include the 424 builder, where `slug` may be a string the
 * caller invented (a `not_configured` entry is whatever they put in `?servers=`),
 * and an unencoded `../` makes the URL claim a path that is not ours.
 */
export function serverConsolePath(slug: string): string {
  return `${UI_PREFIX}/${encodeURIComponent(slug)}`;
}
