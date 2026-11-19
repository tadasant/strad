import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Every job in this repository runs on a GitHub-hosted runner, with a timeout.
 *
 * strad is a PUBLIC repository. A self-hosted runner on a public repo runs code
 * from whoever opens a pull request, and only a fork guard stands between a
 * stranger's workflow edit and the box — the box that ran this repo's jobs
 * also ran PulseMCP's production CI. GitHub-hosted runners are a fresh VM per
 * job, free on a public repo, and nobody else's outage. So the label is a
 * literal from a short list: no `self-hosted`, and no `${{ vars.* }}` switch
 * that a repository variable could flip back without a diff anyone reviews.
 *
 * A job with no `timeout-minutes` inherits GitHub's six-hour default, so one
 * hung step holds a runner, and a slot in the account's concurrent-job cap,
 * for six hours. Every job names its own.
 *
 * A job that `uses:` a reusable workflow takes neither key — the called
 * workflow's own job is checked in its own file.
 */

const DIR = ".github/workflows";

/** The labels a job may run on. Hosted, and spelled out. */
const HOSTED = new Set(["ubuntu-latest", "ubuntu-24.04", "macos-15"]);

type Job = {
  "runs-on"?: unknown;
  "timeout-minutes"?: unknown;
  uses?: string;
};

function jobs(): Array<{ where: string; job: Job }> {
  const out: Array<{ where: string; job: Job }> = [];
  for (const file of readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f))) {
    const doc = parse(readFileSync(join(DIR, file), "utf8")) as {
      jobs?: Record<string, Job>;
    };
    for (const [id, job] of Object.entries(doc.jobs ?? {}))
      out.push({ where: `${file} → ${id}`, job });
  }
  return out;
}

describe("workflow runners", () => {
  const all = jobs();

  it("finds the jobs it is checking", () => {
    // Guard the guard: an empty list would pass every assertion below.
    expect(all.length).toBeGreaterThanOrEqual(20);
  });

  it("runs every job on a GitHub-hosted label, written as a literal", () => {
    for (const { where, job } of all) {
      if (job.uses) continue;
      expect(
        HOSTED.has(job["runs-on"] as string),
        `${where} runs on ${JSON.stringify(job["runs-on"])}. This is a public ` +
          `repository: every job runs on a GitHub-hosted label, written out ` +
          `literally (one of ${[...HOSTED].join(", ")}).`,
      ).toBe(true);
    }
  });

  it("gives every job its own timeout", () => {
    for (const { where, job } of all) {
      if (job.uses) continue;
      const t = job["timeout-minutes"];
      expect(
        typeof t === "number" && t > 0 && t <= 90,
        `${where} has timeout-minutes ${JSON.stringify(t)}; give it a number ` +
          `of minutes (at most 90) rather than GitHub's six-hour default.`,
      ).toBe(true);
    }
  });
});
