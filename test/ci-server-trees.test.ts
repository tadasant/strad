import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Every tree the bundle image bakes must have a CI leg that builds or tests it.
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
 * both files as TEXT on purpose: a workflow is YAML nobody imports, and the point
 * is to notice when a human adds a tree to one file and not the other.
 */

const DOCKERFILE = "servers/bundle/Dockerfile";
const WORKFLOW = ".github/workflows/ci.yml";

/**
 * Baked, and deliberately not a matrix leg.
 *
 * `servers/bundle` is the HOST — the process that mounts the other trees. It has
 * no test suite, and `bundle_image` builds it inside the image, which is the only
 * place its build order against the other trees means anything. Named here so the
 * gap is a decision someone wrote down rather than another tree nobody noticed.
 */
const NOT_A_MATRIX_LEG = new Set(["bundle"]);

/** The `servers/<tree>` sources the bundle image is assembled from. */
function bakedTrees(): Set<string> {
  const df = readFileSync(DOCKERFILE, "utf8");
  const trees = new Set<string>();
  for (const m of df.matchAll(/^COPY\s+servers\/([a-z0-9-]+)\//gm)) {
    trees.add(m[1]!);
  }
  return trees;
}

/** The `tree:` values of the `servers` matrix in `ci.yml`. */
function matrixTrees(): Set<string> {
  const wf = readFileSync(WORKFLOW, "utf8");
  const trees = new Set<string>();
  for (const m of wf.matchAll(/^\s+-\s+tree:\s*([a-z0-9-]+)\s*$/gm)) {
    trees.add(m[1]!);
  }
  return trees;
}

describe("every baked server tree has a CI leg", () => {
  it("bakes and tests the same set of server trees", () => {
    const baked = bakedTrees();
    const matrix = matrixTrees();

    // Guard the guard: a regex that silently matched nothing would make this
    // test pass by comparing two empty sets.
    expect(baked.size).toBeGreaterThan(3);
    expect(matrix.size).toBeGreaterThan(3);

    const uncovered = [...baked]
      .filter((t) => !matrix.has(t) && !NOT_A_MATRIX_LEG.has(t))
      .sort();
    expect(
      uncovered,
      `baked into ${DOCKERFILE} but named in no leg of ${WORKFLOW}'s \`servers\` ` +
        `matrix — nothing builds or tests these before they ship`,
    ).toEqual([]);

    const orphaned = [...matrix].filter((t) => !baked.has(t)).sort();
    expect(
      orphaned,
      `a leg of ${WORKFLOW}'s \`servers\` matrix names a tree ${DOCKERFILE} does ` +
        `not bake — it spends a runner on something the image no longer carries`,
    ).toEqual([]);
  });

  it("runs x-twitter's suite, which nothing ran for its first months", () => {
    // Named explicitly, not just covered by the set comparison above: this is the
    // omission the comparison exists to make impossible, and a leg that quietly
    // stopped running the suite would still satisfy the set equality.
    expect(bakedTrees().has("x-twitter")).toBe(true);
    expect(matrixTrees().has("x-twitter")).toBe(true);

    const leg = readFileSync(WORKFLOW, "utf8").match(
      /^\s+- tree: x-twitter\n(?:\s+\w[\w-]*: .*\n)+/m,
    );
    expect(leg?.[0]).toMatch(/test: true/);
  });

  it("does not cancel sibling legs when one tree fails", () => {
    // Without `fail-fast: false` the first failing tree cancels the rest, and
    // "good-eggs is broken" reports as "nine trees have no result".
    const servers = readFileSync(WORKFLOW, "utf8").match(
      /^ {2}servers:\n(?: {4}.*\n|\n)+/m,
    );
    expect(servers?.[0]).toMatch(/^ {6}fail-fast: false$/m);
  });
});
