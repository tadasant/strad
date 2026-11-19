import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `ci.yml`'s docker jobs must not name a resource the whole runner box shares.
 *
 * On a shared runner, every job runs against ONE docker daemon, and two of
 * them build an image and boot it. A fixed container name or host port collides
 * loudly there. A fixed image TAG does not: a concurrent job can rebuild it
 * between our build and our `docker run`, and the `/mcp`-returns-401 assertion —
 * the load-bearing one in this repo — then passes against an image this PR never
 * built. Nothing errors, and the run is green.
 *
 * So the identifiers carry `github.run_id`. That is a property of TEXT nobody
 * imports, and it is one `--name strad-ci` away from being gone again, so it is
 * asserted here rather than left to review. Same shape as
 * `test/bundle-release-paths.test.ts`: a workflow read as a string, because the
 * point is to notice a human editing it back.
 */

const WORKFLOW = ".github/workflows/ci.yml";

function workflow(): string {
  return readFileSync(WORKFLOW, "utf8");
}

/**
 * The workflow with comment-only lines dropped. The comments here NAME the
 * things this file forbids — "`127.0.0.1::8080`, not `-p 8080:8080`" — so
 * scanning them would fail on the prose that explains the fix.
 */
function code(): string {
  return workflow()
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/** A run-scoped identifier: interpolates the run id, so no two runs share it. */
const PER_RUN = /\$\{\{\s*github\.run_id\s*\}\}/;

describe("ci.yml cannot collide with a concurrent job on the shared daemon", () => {
  it("gives every `docker run --name` a per-run name", () => {
    const names = [...code().matchAll(/--name\s+(\S+)/g)].map((m) => m[1]!);

    // Guard the guard: a regex that matched nothing would pass by asserting
    // over an empty list.
    expect(names.length).toBeGreaterThanOrEqual(2);

    for (const name of names) {
      expect(
        name,
        `${WORKFLOW} runs a container as ${name}, a name every concurrent job ` +
          `on this daemon can also claim. Suffix it with the run id.`,
      ).toMatch(/^"\$[A-Z_]+"$/);
    }
  });

  it("gives every locally-built image tag a per-run tag", () => {
    // `tags:` on the two `docker/build-push-action` steps. Both are
    // `push: false` / `load: true`, so these names live only on the runner.
    const tags = [...code().matchAll(/^\s+tags:\s+(.+)$/gm)].map((m) => m[1]!);

    expect(tags.length).toBeGreaterThanOrEqual(2);

    for (const tag of tags) {
      expect(
        tag,
        `${WORKFLOW} builds ${tag}, a tag a concurrent job can rebuild between ` +
          `this job's build and its run — a wrong-artifact green.`,
      ).toMatch(/^\$\{\{\s*env\.[A-Z_]+\s*\}\}$/);
    }

    // …and the env each one points at is where the run id actually is.
    for (const value of [
      ...code().matchAll(/^\s+[A-Z_]+_(?:IMAGE|CONTAINER):\s+(.+)$/gm),
    ])
      expect(value[1]!).toMatch(PER_RUN);
  });

  it("binds no fixed host port", () => {
    // `-p 8080:8080` is a host-wide resource: the second concurrent job fails to
    // start. An empty host field asks the daemon for a free one instead.
    const publishes = [...code().matchAll(/-p\s+(\S+)/g)].map((m) => m[1]!);

    expect(publishes.length).toBeGreaterThanOrEqual(1);

    for (const spec of publishes) {
      expect(
        spec,
        `${WORKFLOW} publishes ${spec}, which binds a fixed host port every ` +
          `concurrent job competes for. Leave the host port empty.`,
      ).toMatch(/^(?:[\d.]+)?::\d+$/);
    }
  });

  it("reads the assigned port back, and refuses a non-numeric answer", () => {
    const wf = workflow();

    // The readback exists…
    expect(wf).toContain('docker port "$STRAD_CONTAINER" 8080/tcp');

    // …and it is validated. An empty or unparsed answer would otherwise build a
    // malformed URL, and curl would report that as a refused connection — which
    // reads as a broken gateway rather than as the misconfiguration it is.
    expect(wf).toMatch(/case "\$port" in\s*\n\s*"" \| \*\[!0-9\]\*\)/);
  });

  it("tears down by the per-run name, so it cannot reap a concurrent job's", () => {
    const removed = [...wf_rm(code())];

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
