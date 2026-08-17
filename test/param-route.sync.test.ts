import { describe, expect, it } from "vitest";
// @ts-expect-error — a plain .mjs script, deliberately not part of the TS program.
import { drifted, TARGETS } from "../scripts/sync-param-route.mjs";

/**
 * Vendored copies rot. This is the thing that notices.
 *
 * `servers/bundle/host` is its own npm project with its own lockfile and its own
 * compiler settings, so it cannot import `src/secrets/param-route.ts`. The route
 * shape has to exist in both trees, and the only thing standing between that and
 * two slowly-diverging opinions about a URL is this test.
 *
 * The failure it prevents: core serves the route and the host is the only caller.
 * A drift means a container persisting a rotated credential to a path core does
 * not serve. On the WRITE that is loud — the mount degrades and logs. On the BOOT
 * READ it is silent: an unrecognised answer falls back to the baked environment,
 * which is exactly what a deployment nobody has rotated yet looks like, so the
 * credential quietly goes stale instead of failing.
 *
 * If it fails: edit `src/secrets/param-route.ts` (never the copy), run
 * `npm run paramroute:sync`, and commit both.
 */
describe("the vendored parameter write-back wire", () => {
  it("is byte-identical in every tree that speaks it", () => {
    expect(drifted()).toEqual([]);
  });

  it("covers every image that calls the parameter route", () => {
    // Naming them here means adding a component that writes back a rotated
    // credential is a deliberate act, not something that silently ships with a
    // hand-copied URL.
    expect(TARGETS).toEqual(["servers/bundle/host/src/param-route.ts"]);
  });
});
