import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `bundle-google-ci.yml`'s docker job must not name a resource the whole runner
 * box shares.
 *
 * On a shared runner it runs against the same ONE docker daemon every other
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

/**
 * …and the attempt. A re-run of a run whose first attempt leaked its container
 * reuses the run id, so the id alone would put the retry back in the collision
 * it is retrying out of.
 */
const PER_ATTEMPT = /\$\{\{\s*github\.run_attempt\s*\}\}/;

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

    for (const value of values) {
      expect(value).toMatch(PER_RUN);
      expect(value).toMatch(PER_ATTEMPT);
    }
  });

  it("talks to the container it started, by that same per-run name", () => {
    // The health probe and the smoke test both `docker exec`. A literal name
    // there would reach whichever job's container currently holds it — which is
    // the wrong-artifact failure again, one step later.
    //
    // Matched by line rather than by position, so a legitimate `docker exec -i`
    // doesn't read as a container called `-i`. What each line must contain is
    // one of the `--name` variables — which ties the exec to the container this
    // job actually started, not merely to something shaped like a variable.
    const names = new Set(
      [...code().matchAll(/--name\s+"\$([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1]!),
    );
    const execs = code()
      .split("\n")
      .filter((line) => /docker exec\b/.test(line));

    expect(
      names.size,
      `${WORKFLOW} starts no container under a \`"$VAR"\` name, so there is ` +
        `nothing for its \`docker exec\`s to be checked against.`,
    ).toBeGreaterThanOrEqual(1);
    expect(execs.length).toBeGreaterThanOrEqual(2);

    for (const line of execs) {
      const referenced = [...line.matchAll(/"\$([A-Z][A-Z0-9_]*)"/g)].map(
        (m) => m[1]!,
      );
      expect(
        referenced.some((ref) => names.has(ref)),
        `${WORKFLOW} runs \`${line.trim()}\`, which does not name the ` +
          `container this job started (${[...names].join(", ")}). A literal ` +
          `name there reaches whichever job's container currently holds it.`,
      ).toBe(true);
    }
  });

  it("binds no fixed host port", () => {
    // Unlike `ci.yml`'s two docker jobs, this one asserts everything from INSIDE
    // the container — node's fetch for `/healthz`, the baked-in smoke client for
    // the three mounts — so it publishes nothing, and this list is legitimately
    // EMPTY. No guard-the-guard minimum here for that reason: the point is that
    // ADDING a fixed `-p 8080:8080` would hand this job the one failure mode it
    // does not have, a box-wide resource the second concurrent job cannot bind.
    // An empty host field (`127.0.0.1::8080`) asks the daemon for a free one and
    // stays fine, which is what `ci.yml`'s `build_image` does.
    const publishes = [
      ...code().matchAll(
        /(?:^|\s)(?:-[a-zA-Z]*p|--publish)[=\s]?\s*([\d.:[\]]+)/g,
      ),
    ].map((m) => m[1]!);

    for (const spec of publishes) {
      expect(
        spec,
        `${WORKFLOW} publishes ${spec}, which binds a fixed host port every ` +
          `concurrent job competes for. Leave the host port empty.`,
      ).toMatch(/^(?:[\d.]+)?::\d+$/);
    }

    // Bare `-P` picks free ports too, so it survives the check above by taking
    // no argument at all — but it binds them on EVERY interface, which puts a
    // booted server on the runner box's public address for the life of the job.
    expect(
      code(),
      `${WORKFLOW} publishes with \`-P\`, which picks free ports but binds them ` +
        `on every interface. Name the loopback address instead.`,
    ).not.toMatch(/(?:^|\s)-[a-zA-Z]*P(?:\s|$)/);
  });

  it("labels what it creates, and sweeps what earlier runs leaked", () => {
    // Per-run names cost the fixed names' one accidental virtue: a leaked
    // `bundle-google-ci` was reaped by the next run that wanted that name, and
    // nothing will ever want `bundle-google-ci-<run>`. The label is how the
    // sweep finds a leak; without it, a failed teardown is permanent.
    const wf = code();
    const sweep = step("Sweep what earlier runs leaked");
    const why =
      `without it a leaked container or image is never reclaimed, because ` +
      `nothing will ever want this run's names again`;

    expect(
      wf,
      `the built image carries no \`strad-ci\` label — ${why}`,
    ).toMatch(/labels:\s+strad-ci=1/);
    expect(wf, `the container carries no \`strad-ci\` label — ${why}`).toMatch(
      /--label strad-ci=1/,
    );

    // Stopped containers, then the images they were holding a reference to.
    expect(sweep, `no container sweep — ${why}`).toContain(
      "docker container prune -f --filter label=strad-ci --filter until=24h",
    );
    expect(sweep, `no image sweep — ${why}`).toContain(
      "docker image prune -af --filter label=strad-ci --filter until=24h",
    );

    // …and the RUNNING ones, which `docker container prune` does not touch and
    // which are exactly what a killed runner leaves behind. `docker ps` has no
    // `until` filter, so the workflow checks the age itself.
    expect(
      sweep,
      `nothing sweeps a leaked RUNNING container. \`docker container prune\` ` +
        `reaps stopped ones only, and a teardown that never ran leaves its ` +
        `container up — pinning its image against the image prune too.`,
    ).toMatch(/docker ps -q --filter label=strad-ci/);
    expect(
      sweep,
      `the running-container sweep has no age check, so it could remove a ` +
        `container a concurrent job is still using.`,
    ).toMatch(/86400/);
  });

  it("tears down by the per-run name, so it cannot reap a concurrent job's", () => {
    // Scoped to the teardown step. The sweep step also removes containers, but
    // by id and only once they are a day old — reading the two together would
    // mean asserting one rule over two steps that deliberately differ.
    const removed = [...wf_rm(step("Tear down"))];

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

/** Every `docker rm -f <x>` / `docker rmi -f <x>` target in the given text. */
function* wf_rm(wf: string): Generator<string> {
  for (const m of wf.matchAll(/docker rmi?\s+-f\s+(\S+)/g)) yield m[1]!;
}

/** One step of the job, by its `name:`, as text — its own `run:` body only. */
function step(name: string): string {
  const wf = code();
  const start = wf.indexOf(`- name: ${name}`);
  expect(start, `${WORKFLOW} has no step named "${name}"`).toBeGreaterThan(-1);

  const body = wf.slice(start);
  const next = body.slice(1).search(/^ {6}- (?:name|uses):/m);
  return next === -1 ? body : body.slice(0, next + 1);
}
