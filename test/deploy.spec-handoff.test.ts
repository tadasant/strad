import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The rendered spec must not live at a path another job can name.
 *
 * `runs-on: self-hosted` means several runner PROCESSES share one machine, and
 * they share `/tmp` with each other. This repo's staging deploy and
 * tadasant-internal's prod deploy both wrote `/tmp/spec.json`, and on 2026-08-06
 * they overlapped on `ci-runner-2`: prod's render truncated staging's finished
 * spec, staging's `doctl apps update` read zero bytes, and DigitalOcean answered
 * `400 … ".name in body is required"` about a render that was byte-identical to
 * the previous green deploy. A second later on the clock and staging would have
 * been handed prod's complete spec — its images, its secrets — and gone green.
 *
 * This reads the workflow as TEXT, like `bundle-release-paths.test.ts`: a
 * workflow is YAML nobody imports, and the point is to notice when a human
 * reintroduces a shared path or drops the check in front of doctl. Neither
 * failure is visible in a normal CI run — the collision needs a concurrent job,
 * and the guard only speaks when something is already wrong.
 */

const WORKFLOW = ".github/workflows/deploy-staging.yml";

/** The workflow with its comment lines removed — only what actually runs. */
function executable(): string {
  return readFileSync(WORKFLOW, "utf8")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

describe("deploy-staging spec handoff", () => {
  it("renders into a job-private path, never a shared one", () => {
    const wf = executable();
    expect(wf).toMatch(/"\$RUNNER_TEMP\/spec\.json"/);
    // Not `/tmp/anything.json` — the collision is the shared DIRECTORY, so a
    // rename inside /tmp would fix nothing.
    expect(wf).not.toMatch(/\/tmp\/[A-Za-z0-9_.-]*spec/);
  });

  // `${{ runner.* }}` is NOT available in `jobs.<id>.env` — GitHub's context
  // availability table allows only github/needs/strategy/matrix/vars/secrets/
  // inputs there, and an unavailable context expands to the EMPTY STRING rather
  // than erroring. `SPEC_FILE: ${{ runner.temp }}/spec.json` hoisted to the job
  // would therefore have become `/spec.json`, putting the file straight back in
  // a directory every job on the box shares — the bug this file exists for,
  // reintroduced by the fix for it. So the path comes from the RUNNER_TEMP
  // environment variable, in a step's shell, where the runner does set it.
  it("never reads the runner context from a workflow- or job-level env, where it is empty", () => {
    // Every workflow, not just this one: the trap is a property of the context
    // table, so the next workflow to reach for `${{ runner.temp }}` outside a
    // step will hit it too.
    for (const file of readdirSync(".github/workflows").filter((f) =>
      /\.ya?ml$/.test(f),
    )) {
      const doc = parse(
        readFileSync(join(".github/workflows", file), "utf8"),
      ) as
        | {
            env?: Record<string, unknown>;
            jobs?: Record<string, { env?: Record<string, unknown> }>;
          }
        | undefined;
      const scopes: Array<[string, Record<string, unknown> | undefined]> = [
        ["<workflow>", doc?.env],
        ...Object.entries(doc?.jobs ?? {}).map(
          ([job, def]) =>
            [job, def?.env] as [string, Record<string, unknown> | undefined],
        ),
      ];
      for (const [scope, env] of scopes) {
        // JSON.stringify rather than String(): a nested map would render as
        // "[object Object]" and hide an expression one level down.
        for (const [key, value] of Object.entries(env ?? {})) {
          expect(
            `${file} ${scope}.env.${key} = ${JSON.stringify(value)}`,
            "workflow- and job-level env cannot see the runner context",
          ).not.toMatch(/\$\{\{\s*runner\./);
        }
      }
    }
  });

  it("routes every reader and writer of the spec through that path", () => {
    const wf = executable();
    // The render's redirect, the credential attach, both doctl calls and both
    // component-list reads.
    for (const use of [
      />\s*"\$RUNNER_TEMP\/spec\.json"/,
      /attach-registry-creds\.mjs "\$RUNNER_TEMP\/spec\.json"/,
      /doctl apps create --spec "\$RUNNER_TEMP\/spec\.json"/,
      /doctl apps update "\$APP_ID" --spec "\$RUNNER_TEMP\/spec\.json"/,
      /jq -r '\.services\[\]\.name' "\$RUNNER_TEMP\/spec\.json"/,
    ]) {
      expect(wf).toMatch(use);
    }
  });

  it("asserts the spec is deployable before every doctl call that reads it", () => {
    const wf = executable();
    const assertAt = [...wf.matchAll(/scripts\/assert-spec\.ts/g)].map(
      (m) => m.index ?? -1,
    );
    // One after the render (attribution: the renderer produced this), one in
    // the deploy step (the bytes doctl is about to read are still that spec).
    expect(assertAt.length).toBeGreaterThanOrEqual(2);

    const firstDoctlSpec = wf.search(/doctl apps (create|update)[^\n]*--spec/);
    expect(firstDoctlSpec).toBeGreaterThan(-1);
    // The guard in the deploy step runs BEFORE the PUT, not after it.
    expect(assertAt.some((at) => at < firstDoctlSpec)).toBe(true);
    expect(assertAt.filter((at) => at < firstDoctlSpec).length).toBe(2);
  });

  it("tells the guard which app this deploy is entitled to replace", () => {
    // Without --expect-name the check degrades to "is this a spec", and the
    // expensive near-miss — deploying prod's valid spec onto staging — passes.
    const uses = [
      ...executable().matchAll(
        /scripts\/assert-spec\.ts\s*\\?\s*\n?\s*"\$RUNNER_TEMP\/spec\.json"\s+--expect-name\s+(\S+)/g,
      ),
    ];
    expect(uses.length).toBeGreaterThanOrEqual(2);
    for (const use of uses) expect(use[1]).toBe("strad-staging");
  });
});
