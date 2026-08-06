import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `bundle-google-ci.yml`'s docker job must not name a resource the whole runner
 * box shares.
 *
 * It is `runs-on: self-hosted` against the same ONE docker daemon every other
 * job uses, and its concurrency group is per-REF — so two PRs run it at the same
 * time. A fixed container name collides loudly there. A fixed image TAG does
 * not: a concurrent job can rebuild it between our build and our `docker run`,
 * and the three-mount smoke test then passes against an image this PR never
 * built. Nothing errors, and the run is green. The shared name is also what lets
 * the `if: always()` teardown reap a container another job is still testing.
 *
 * So the identifiers carry `github.run_id`. That is a property of TEXT nobody
 * imports, and it is one `--name bundle-google-ci` away from being gone again,
 * so it is asserted here rather than left to review. Same shape as
 * `test/bundle-release-paths.test.ts`: a workflow read as a string, because the
 * point is to notice a human editing it back.
 */

const WORKFLOW = ".github/workflows/bundle-google-ci.yml";

function workflow(): string {
  return readFileSync(WORKFLOW, "utf8");
}

/**
 * The workflow with comment-only lines dropped. The comments here NAME the
 * things this file forbids — "a leaked `bundle-google-ci` was reaped by the next
 * run" — so scanning them would fail on the prose that explains the fix.
 */
function code(): string {
  return workflow()
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/** A run-scoped identifier: interpolates the run id, so no two runs share it. */
const PER_RUN = /\$\{\{\s*github\.run_id\s*\}\}/;

describe("bundle-google-ci.yml cannot collide with a concurrent job on the shared daemon", () => {
  it("gives every `docker run --name` a per-run name", () => {
    const names = [...code().matchAll(/--name\s+(\S+)/g)].map((m) => m[1]!);

    // Guard the guard: a regex that matched nothing would pass by asserting
    // over an empty list.
    expect(names.length).toBeGreaterThanOrEqual(1);

    for (const name of names) {
      expect(
        name,
        `${WORKFLOW} runs a container as ${name}, a name every concurrent job ` +
          `on this daemon can also claim. Suffix it with the run id.`,
      ).toMatch(/^"\$[A-Z_]+"$/);
    }
  });

  it("gives every locally-built image tag a per-run tag", () => {
    // `tags:` on the one `docker/build-push-action` step. It is `push: false` /
    // `load: true`, so this name lives only on the runner.
    const tags = [...code().matchAll(/^\s+tags:\s+(.+)$/gm)].map((m) => m[1]!);

    expect(tags.length).toBeGreaterThanOrEqual(1);

    for (const tag of tags) {
      expect(
        tag,
        `${WORKFLOW} builds ${tag}, a tag a concurrent job can rebuild between ` +
          `this job's build and its run — a wrong-artifact green.`,
      ).toMatch(/^\$\{\{\s*env\.[A-Z_]+\s*\}\}$/);
    }

    // …and the env each one points at is where the run id actually is.
    const values = [
      ...code().matchAll(/^\s+[A-Z_]+_(?:IMAGE|CONTAINER):\s+(.+)$/gm),
    ].map((m) => m[1]!);

    expect(values.length).toBeGreaterThanOrEqual(2);

    for (const value of values) expect(value).toMatch(PER_RUN);
  });

  it("talks to the container it started, by that same per-run name", () => {
    // The health probe and the smoke test both `docker exec`. A literal name
    // there would reach whichever job's container currently holds it — which is
    // the wrong-artifact failure again, one step later.
    const targets = [...code().matchAll(/docker exec\s+(\S+)/g)].map(
      (m) => m[1]!,
    );

    expect(targets.length).toBeGreaterThanOrEqual(2);

    for (const target of targets) {
      expect(
        target,
        `${WORKFLOW} runs \`docker exec ${target}\`, a name a concurrent job ` +
          `can also hold.`,
      ).toMatch(/^"\$[A-Z_]+"$/);
    }
  });

  it("binds no host port at all", () => {
    // Unlike `ci.yml`'s two docker jobs, this one asserts everything from INSIDE
    // the container — node's fetch for `/healthz`, the baked-in smoke client for
    // the three mounts. So it needs no publish flag, and adding a fixed one
    // would hand it the third failure mode it does not currently have.
    expect(
      code(),
      `${WORKFLOW} publishes a host port, a box-wide resource every concurrent ` +
        `job competes for. This job asserts from inside the container instead.`,
    ).not.toMatch(/\s-(?:p\s|P(?:\s|$))/);
  });

  it("labels what it creates, and sweeps what earlier runs leaked", () => {
    // Per-run names cost the fixed names' one accidental virtue: a leaked
    // `bundle-google-ci` was reaped by the next run that wanted that name, and
    // nothing will ever want `bundle-google-ci-<run>`. The label is how the
    // sweep finds a leak; without it, a failed teardown is permanent.
    const wf = code();

    expect(wf).toMatch(/labels:\s+strad-ci=1/);
    expect(wf).toMatch(/--label strad-ci=1/);
    expect(wf).toContain(
      "docker container prune -f --filter label=strad-ci --filter until=24h",
    );
    expect(wf).toContain(
      "docker image prune -af --filter label=strad-ci --filter until=24h",
    );
  });

  it("tears down by the per-run name, so it cannot reap a concurrent job's", () => {
    const removed = [...wf_rm(code())];

    // The container AND the image: per-run tags pile up one per run otherwise,
    // on a runner box that never goes away.
    expect(removed.length).toBeGreaterThanOrEqual(2);

    for (const target of removed) {
      expect(
        target,
        `${WORKFLOW} tears down ${target} under \`if: always()\`, which would ` +
          `delete a concurrent job's container mid-test.`,
      ).toMatch(/^"\$[A-Z_]+"$/);
    }
  });
});

/** Every `docker rm -f <x>` / `docker rmi -f <x>` target in the workflow. */
function* wf_rm(wf: string): Generator<string> {
  for (const m of wf.matchAll(/docker rmi?\s+-f\s+(\S+)/g)) yield m[1]!;
}
