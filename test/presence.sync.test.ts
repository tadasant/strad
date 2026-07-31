import { describe, expect, it } from "vitest";
// @ts-expect-error — a plain .mjs script, deliberately not part of the TS program.
import { drifted, TARGETS } from "../scripts/sync-presence.mjs";

/**
 * Vendored copies rot. This is the thing that notices.
 *
 * `servers/bundle/host` is its own npm project with its own lockfile and its own
 * compiler settings, so it cannot import `src/secrets/presence.ts`. The five
 * words have to exist in both trees, and the only thing standing between that
 * and two slowly-diverging placeholder tables is this test.
 *
 * The failure it prevents is specific and would be very hard to see: core and a
 * bundle each classify values the other cannot, and the console renders both in
 * ONE list under ONE word. Drift means `change-me` reads as filler on one row and
 * as a credential on the next, and nothing on the page says why.
 *
 * If it fails: edit `src/secrets/presence.ts` (never the copy), run
 * `npm run presence:sync`, and commit both.
 */
describe("the vendored presence vocabulary", () => {
  it("is byte-identical in every tree that speaks it", () => {
    expect(drifted()).toEqual([]);
  });

  it("covers every image that answers the presence route", () => {
    // Naming them here means adding a component that must answer for its own
    // environment is a deliberate act, not something that silently ships without
    // the module it needs.
    expect(TARGETS).toEqual(["servers/bundle/host/src/presence.ts"]);
  });
});
