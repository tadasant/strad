import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  bakedTrees,
  DOCKERFILE,
  installableTrees,
} from "./helpers/bundle-trees.js";

/**
 * Every tree baked into the bundle image is built or tested by SOME job.
 *
 * `ci.yml`'s `servers` job is a matrix over the server trees. Before it was a
 * matrix it was nine hand-written jobs, and adding a tree meant remembering to
 * hand-write a tenth — which is exactly what did not happen for `x-twitter`. It
 * was baked into the image, watched by the release workflow, and named in no CI
 * job at all, so its four functional suites ran nowhere. The tree compiled (the
 * `bundle_image` job builds it), so a type error still failed a PR; a behavioural
 * regression in its tool wiring, auth handling or response formatting merged
 * green. That had happened once already, for `onepassword` and `pointsyeah`
 * (issue #99), and was closed by hand-writing two more jobs.
 *
 * So the lists are compared rather than maintained in parallel — the same
 * technique, and the same reason, as `bundle-release-paths.test.ts`. This reads
 * the workflow as TEXT on purpose: it is YAML nobody imports, and the point is to
 * notice when a human adds a tree to one file and not the other.
 *
 * A tree is not always a direct child of `servers/`. `servers/bundle/host` is one
 * level deeper, and for its first weeks it was exempted here — named in
 * `COVERED_ELSEWHERE` with the reason that a leg could not be spelled for it —
 * while its 53 tests ran nowhere. So the comparison resolves each baked path to
 * the lockfile-owning trees inside it, and a leg's `tree:` may carry a slash. A
 * nested tree that lands uncovered fails this the same way a top-level one does.
 */

const WORKFLOW = ".github/workflows/ci.yml";

/**
 * Baked, and deliberately not a leg of the `servers` matrix — each with the job
 * that does cover it. Named here so the gap is a decision someone wrote down
 * rather than another tree nobody noticed.
 */
const COVERED_ELSEWHERE = new Map([
  [
    "images/bundle-google",
    "a supplementary image in its own right: `bundle-google-ci.yml` installs " +
      "it, runs its suite, builds the image and smoke-tests all four mounts of " +
      "the booted container",
  ],
]);

/**
 * The units a leg can actually address: every baked tree, resolved to the
 * lockfile-owning trees at or inside it.
 *
 * `servers/bundle` is the reason this exists. The Dockerfile bakes it, but the
 * directory itself is not an npm tree — the tree is `servers/bundle/host`, one
 * level deeper, and it has a suite of its own. Comparing the matrix against the
 * `COPY` paths alone can only ever call that leg orphaned, which is why the host
 * spent its first weeks named in an exemption instead of a job.
 *
 * A baked path with no lockfile under it at all stands for itself, so a tree of
 * plain files still has to be covered or exempted rather than silently dropping
 * out of the comparison.
 */
function bakedUnits(): Set<string> {
  const installable = [...installableTrees()];
  const units = new Set<string>();
  for (const baked of bakedTrees()) {
    const inside = installable.filter(
      (t) => t === baked || t.startsWith(`${baked}/`),
    );
    if (inside.length === 0) units.add(baked);
    else for (const t of inside) units.add(t);
  }
  return units;
}

/** The `servers:` job block of `ci.yml`, as text. */
function serversJob(): string {
  const block = readFileSync(WORKFLOW, "utf8").match(
    /^ {2}servers:\n(?: {4}.*\n|\n)+/m,
  );
  expect(block, `${WORKFLOW} has no \`servers\` job`).not.toBeNull();
  return block![0];
}

/**
 * The trees the `servers` matrix names, as `servers/<tree>` paths.
 *
 * A leg's `tree:` IS its path — the job uses it verbatim as
 * `working-directory: servers/${tree}` — so a nested tree is spelled with a
 * slash (`bundle/host`) and needs no second key to say where it lives. One
 * string is the identity, the working directory and the check name at once,
 * which is what keeps this comparison honest.
 *
 * Scoped to that job rather than the whole file: another job growing a `tree:`
 * matrix key must not read as coverage this one does not provide.
 */
function matrixTrees(): Set<string> {
  const trees = new Set<string>();
  for (const m of serversJob().matchAll(
    /^\s+- tree:\s*([a-z0-9-]+(?:\/[a-z0-9-]+)*)\s*$/gm,
  )) {
    trees.add(`servers/${m[1]!}`);
  }
  return trees;
}

describe("every baked tree is built or tested by some job", () => {
  it("bakes and tests the same set of trees", () => {
    const baked = bakedUnits();
    const matrix = matrixTrees();

    // Guard the guard: a regex — or a filesystem walk — that silently matched
    // nothing would make this test pass by comparing two empty sets.
    expect(baked.size).toBeGreaterThan(3);
    expect(matrix.size).toBeGreaterThan(3);
    expect(installableTrees().size).toBeGreaterThan(3);

    const uncovered = [...baked]
      .filter((t) => !matrix.has(t) && !COVERED_ELSEWHERE.has(t))
      .sort();
    expect(
      uncovered,
      `baked into ${DOCKERFILE} but named in no leg of ${WORKFLOW}'s \`servers\` ` +
        `matrix — nothing builds or tests these before they ship. Add a leg, or ` +
        `add the tree to COVERED_ELSEWHERE with the job that does cover it`,
    ).toEqual([]);

    const orphaned = [...matrix].filter((t) => !baked.has(t)).sort();
    expect(
      orphaned,
      `a leg of ${WORKFLOW}'s \`servers\` matrix names a tree ${DOCKERFILE} does ` +
        `not bake — it spends a runner on something the image no longer carries`,
    ).toEqual([]);
  });

  it("reads every directory under servers/ out of the Dockerfile", () => {
    // The comparison above is only as good as the `COPY` scan feeding it: a tree
    // the regex misses is absent from BOTH sides and reads as covered. The
    // directory listing is the one source of truth no COPY syntax can drift from.
    const dirs = readdirSync("servers", { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `servers/${e.name}`);
    const baked = bakedTrees();

    const missed = dirs.filter((d) => !baked.has(d)).sort();
    expect(
      missed,
      `a directory under servers/ that ${DOCKERFILE} does not appear to bake. ` +
        `Either the image really dropped it — in which case delete the tree — or ` +
        `its COPY is spelled in a way bakedTrees() cannot read, which silently ` +
        `removes it from every comparison in this file`,
    ).toEqual([]);
  });

  it("runs x-twitter's suite, which nothing ran for its first months", () => {
    // Named explicitly, not just covered by the set comparison above: this is the
    // omission the comparison exists to make impossible, and a leg that quietly
    // stopped running the suite would still satisfy the set equality.
    expect(bakedTrees().has("servers/x-twitter")).toBe(true);
    expect(matrixTrees().has("servers/x-twitter")).toBe(true);

    const leg = serversJob().match(
      /^\s+- tree: x-twitter\n(?:\s+[\w-]+: .*\n)+/m,
    );
    expect(leg?.[0]).toMatch(/^\s+test: true$/m);
  });

  it("runs the bundle host's suite, which is a tree one level deeper", () => {
    // Named explicitly, like x-twitter above and for the same reason. This one
    // is also the case the set comparison was blind to: `servers/bundle` is what
    // the Dockerfile's COPY says, the tree is `servers/bundle/host`, and the
    // comparison saw only the former until it learned to resolve a baked path to
    // the trees inside it.
    expect(installableTrees().has("servers/bundle/host")).toBe(true);
    expect(matrixTrees().has("servers/bundle/host")).toBe(true);

    // The parent is baked and is NOT a tree — it owns no lockfile, so no leg can
    // `npm ci` in it. It must not read as a unit needing coverage of its own.
    expect(installableTrees().has("servers/bundle")).toBe(false);
    expect(bakedUnits().has("servers/bundle")).toBe(false);

    const leg = serversJob().match(
      /^\s+- tree: bundle\/host\n(?:\s+[\w-]+: .*\n)+/m,
    );
    expect(leg?.[0]).toMatch(/^\s+test: true$/m);
  });

  it("does not cancel sibling legs when one tree fails", () => {
    // Without `fail-fast: false` the first failing tree cancels the rest, and
    // "good-eggs is broken" reports as "nine other trees have no result".
    expect(serversJob()).toMatch(/^ {6}fail-fast: false$/m);
  });
});
