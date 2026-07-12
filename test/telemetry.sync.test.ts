import { describe, expect, it } from "vitest";
// @ts-expect-error — a plain .mjs script, deliberately not part of the TS program.
import { drifted, TARGETS } from "../scripts/sync-telemetry.mjs";

/**
 * Vendored copies rot. This is the thing that notices.
 *
 * The bundle telemetry bootstrap has to live INSIDE each supplementary image's
 * directory, because each image is its own Docker build context and cannot COPY
 * from the repo root. So there are six identical copies of it, and the only
 * thing standing between that and six slowly-diverging copies is this test.
 *
 * If it fails: edit `telemetry/bundle/instrument.mjs` (never a copy), run
 * `npm run telemetry:sync`, and commit.
 */
describe("the vendored bundle telemetry bootstrap", () => {
  it("is byte-identical in every supplementary image", () => {
    expect(drifted()).toEqual([]);
  });

  it("covers every image we expect to emit resource metrics", () => {
    // If someone adds a seventh image and forgets to instrument it, they get a
    // dashboard that is quietly missing a container. Naming them here means
    // adding one is a deliberate act.
    expect(TARGETS).toEqual([
      "servers/fetchpet/otel/instrument.mjs",
      "servers/pointsyeah/otel/instrument.mjs",
      "servers/good-eggs/otel/instrument.mjs",
      "servers/bundle-api/otel/instrument.mjs",
      "servers/onepassword/otel/instrument.mjs",
      "images/bundle-google/otel/instrument.mjs",
    ]);
  });
});
