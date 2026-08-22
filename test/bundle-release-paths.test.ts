import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { bakedTrees, DOCKERFILE } from "./helpers/bundle-trees.js";

/**
 * Every tree baked into the bundle image must be a path that CUTS one.
 *
 * `release-bundle-image.yml` rebuilds `ghcr.io/tadasant/strad-bundle` on a push
 * to `main` that touches one of its `paths:`. The two lists were not the same
 * list: `servers/secrets/**` was baked and not watched, so a change to the
 * secrets MCP client landed on `main`, cut no image, and the bundle carried on
 * serving the old code.
 *
 * That failure is silent and it is the expensive kind — the change is merged,
 * CI is green, the PR is closed, and the behaviour in staging is the old
 * behaviour. It is the same shape as the bug this file arrived with: something
 * that looks correct everywhere except where it runs.
 *
 * So the lists are compared rather than maintained in parallel. This reads both
 * files as TEXT on purpose — a workflow is YAML nobody imports, and the point is
 * to notice when a human adds a tree to one file and not the other.
 */

const WORKFLOW = ".github/workflows/release-bundle-image.yml";

/** The `<dir>/<tree>/**` globs the release workflow triggers on. */
function watchedTrees(): Set<string> {
  const wf = readFileSync(WORKFLOW, "utf8");
  const trees = new Set<string>();
  for (const m of wf.matchAll(
    /^\s+-\s+"((?:servers|images)\/[a-z0-9-]+)\/\*\*"/gm,
  )) {
    trees.add(m[1]!);
  }
  return trees;
}

describe("the bundle image releases when its sources change", () => {
  it("bakes and watches the same set of trees", () => {
    const baked = bakedTrees();
    const watched = watchedTrees();

    // Guard the guard: a regex that silently matched nothing would make this
    // test pass by comparing two empty sets.
    expect(baked.size).toBeGreaterThan(3);
    expect(watched.size).toBeGreaterThan(3);

    const unwatched = [...baked].filter((t) => !watched.has(t)).sort();
    expect(
      unwatched,
      `baked into ${DOCKERFILE} but not watched by ${WORKFLOW} — a change to ` +
        `these cuts no image, so it merges without shipping`,
    ).toEqual([]);
  });

  it("watches servers/secrets, which the MCP write client lives in", () => {
    // Named explicitly, not just covered by the set comparison above: this tree
    // holds the credential-writing half of the parameter store, and a change to
    // it that does not reach the bundle is a fix that is merged and not running.
    expect(bakedTrees().has("servers/secrets")).toBe(true);
    expect(watchedTrees().has("servers/secrets")).toBe(true);
  });
});
