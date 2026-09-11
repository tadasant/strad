import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { buildUnits, publishingWorkflows } from "./helpers/workflow-graph.js";

/**
 * Every job that logs in to ghcr must log in somewhere only it can reach.
 *
 * `~/.docker/config.json` is the credential file, and `runs-on: self-hosted`
 * means one of them for the whole box. Every job in this repo that reaches ghcr
 * runs `docker/login-action`, each writing `auths["ghcr.io"]` with its OWN job's
 * `GITHUB_TOKEN`, and each running `docker logout ghcr.io` in a post step —
 * `logout: true` is that action's default. So the last job to log in owns the
 * credential every concurrent build pushes with, and the first job to finish
 * deletes it.
 *
 * That is `test/workflow-buildx-builder.test.ts` one file over, and worse: the
 * loser of the builder race dies with a buildkit transport error, while the
 * loser of THIS race re-authenticates as nobody and gets a 403 that reads
 * exactly like ghcr having an outage.
 *
 * On 2026-08-12 it took `main` red on `Release bundle image` (run 31561342124).
 * The bundle logged in at 03:50:53.46; the bundle-API job logged in over it at
 * 03:50:53.99; the bundle's buildx loaded the config at 03:50:59 — reading the
 * bundle-API job's token, since a buildx CLI loads that file once at startup —
 * and pushed with it at 03:53:07, 78 seconds after the bundle-API job ended and
 * GitHub revoked it (`failed to fetch oauth token: denied: denied`). The two
 * retries then found a file `Release image`'s post-step logout had emptied at
 * 03:53:22, asked for an ANONYMOUS token, and took two 403s. Three attempts,
 * three refusals, and nobody had touched the package's permissions.
 *
 * The fix is `.github/actions/docker-config`: `DOCKER_CONFIG` under
 * `$RUNNER_TEMP`, which is per runner installation and emptied between jobs.
 * It is one deleted line per workflow away from being gone again, and the
 * symptom of its absence is an intermittent 403 on the slowest build in the
 * push — so assert it here rather than leave it to review. HACKS.md #57.
 */

const WORKFLOW_DIR = ".github/workflows";
const ACTION_DIR = ".github/actions";
const ISOLATE = "./.github/actions/docker-config";
const MANIFEST = `${ACTION_DIR}/docker-config/action.yml`;

/**
 * How many COPIES of the login step exist.
 *
 * A count of copies is a weak floor and this is the only job it does: stop the
 * loop below passing by asserting over an empty list. It moves whenever
 * releases share a body — FIVE of them share `release-supplementary-image.yml`
 * and hold one login between them — and it cannot tell that apart from three
 * releases losing their credential. Re-anchor it to what the tree holds when a
 * release stops keeping its own copy; never lower it to pass.
 * `MIN_PUBLISHING_WORKFLOWS` is the floor that means something, and it did not
 * move when the bundle joined the shared body.
 */
const MIN_LOGIN_JOBS = 5;

/**
 * How many workflows put an image on ghcr.
 *
 * A release that delegates its build still publishes, and is still separately
 * broken if the body it delegates to stops logging in — so this counts
 * releases rather than copies, and sharing a body does not move it. It is what
 * the coverage assertion below guards.
 */
const MIN_PUBLISHING_WORKFLOWS = 9;

interface Step {
  uses?: string;
  id?: string;
  if?: unknown;
  name?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

/** Every local composite action's manifest, in both spellings, at any depth. */
function actionFiles(dir: string = ACTION_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory()) return actionFiles(path);
    return /^action\.ya?ml$/.test(e.name) ? [path] : [];
  });
}

/** Every step-running unit in `.github/`: each workflow job, each local action. */
function* jobs(): Generator<{ file: string; job: string; steps: Step[] }> {
  for (const f of readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f))) {
    const file = `${WORKFLOW_DIR}/${f}`;
    const doc = parse(readFileSync(file, "utf8")) as {
      jobs?: Record<string, { steps?: Step[] }>;
    };
    for (const [job, body] of Object.entries(doc?.jobs ?? {}))
      if (Array.isArray(body?.steps)) yield { file, job, steps: body.steps };
  }

  for (const file of actionFiles()) {
    const doc = parse(readFileSync(file, "utf8")) as {
      runs?: { steps?: Step[] };
    };
    if (Array.isArray(doc?.runs?.steps))
      yield { file, job: "runs", steps: doc.runs.steps };
  }
}

// The `@` is not required: an UNPINNED `uses: docker/login-action` logs in just
// the same, and matching only the pinned spelling would make such a step
// invisible to every assertion here while `found` stayed where it was.
const isLogin = (s: Step) =>
  s.uses === "docker/login-action" ||
  (s.uses?.startsWith("docker/login-action@") ?? false);
const isSetup = (s: Step) =>
  s.uses?.startsWith("docker/setup-buildx-action@") ?? false;
const isIsolate = (s: Step) => s.uses === ISOLATE;

describe("no job logs in to ghcr in a file another job can rewrite", () => {
  it("isolates DOCKER_CONFIG before every login, and before buildx", () => {
    let found = 0;

    for (const { file, job, steps } of jobs()) {
      // EVERY login, not just the first: a second one later in the same job
      // writes the same entry and would be ordered against nothing.
      const logins = steps.flatMap((s, i) => (isLogin(s) ? [i] : []));
      if (logins.length === 0) continue;
      found++;

      const isolate = steps.findIndex(isIsolate);
      expect(
        isolate,
        `${file} (${job}) logs in to a registry without calling ${ISOLATE} ` +
          `first, so it writes the box-wide \`~/.docker/config.json\` — which ` +
          `every concurrent job overwrites, and whichever finishes first logs ` +
          `out of.`,
      ).toBeGreaterThanOrEqual(0);

      // A conditional isolate step satisfies every index check above and then
      // does not run, which is the unisolated job with a green test.
      expect(
        steps[isolate]!.if,
        `${file} (${job}) makes ${ISOLATE} conditional. It has to run on every ` +
          `path that logs in, or the login it guards writes the shared file.`,
      ).toBeUndefined();

      for (const login of logins)
        expect(
          isolate,
          `${file} (${job}) isolates its docker config AFTER logging in, so ` +
            `the credential lands in the shared file and the isolated one is ` +
            `empty.`,
        ).toBeLessThan(login);

      // buildx keeps its builder metadata under `$DOCKER_CONFIG/buildx`. A
      // builder created before this step is recorded in one directory and torn
      // down by a post step reading another, which leaks a buildkit container
      // per run rather than failing anything.
      const setup = steps.findIndex(isSetup);
      if (setup >= 0)
        expect(
          isolate,
          `${file} (${job}) sets up buildx before isolating DOCKER_CONFIG, so ` +
            `the builder is created in one config directory and removed from ` +
            `another.`,
        ).toBeLessThan(setup);
    }

    // Guard the guard: a loop that found no logins would pass by asserting
    // over nothing.
    expect(found).toBeGreaterThanOrEqual(MIN_LOGIN_JOBS);
  });

  /**
   * …and the other direction, which the loop above cannot see at all.
   *
   * Everything above starts from a login and checks what is ordered around it.
   * A release that stops logging in ENTIRELY is invisible to it — no login, no
   * iteration, nothing asserted — and the symptom is a 403 on the push, from a
   * workflow whose diff removed one `uses:` line.
   *
   * A release does not have to hold its own login: five of them reach theirs
   * through `release-supplementary-image.yml`, one file away, where a reviewer
   * of the caller cannot see it at all. So the coverage is asserted from the
   * release, through the `uses:` edge, to the job whose steps actually build.
   */
  it("gets every publishing workflow to an isolated login, through whatever workflow owns the build", () => {
    const publishing = publishingWorkflows();

    // Guard the guard: an empty graph passes every assertion below. Nine before
    // the supplementary releases shared a body, nine after, and nine again once
    // the bundle joined them — which is the point of counting releases rather
    // than copies.
    expect(
      publishing.length,
      `found ${publishing.length} workflows that publish an image; the walk ` +
        `is not reaching them.`,
    ).toBeGreaterThanOrEqual(MIN_PUBLISHING_WORKFLOWS);

    for (const unit of buildUnits()) {
      if (!unit.publishes) continue;
      const where =
        unit.file === unit.entry
          ? `${unit.entry} (${unit.job})`
          : `${unit.entry} -> ${unit.file} (${unit.job})`;

      expect(
        unit.steps.findIndex(isLogin),
        `${where} pushes an image and never runs \`docker/login-action\`, so ` +
          `the push authenticates as whoever last wrote the box-wide ` +
          `credential file — or as nobody.`,
      ).toBeGreaterThanOrEqual(0);

      expect(
        unit.steps.findIndex(isIsolate),
        `${where} pushes an image without calling ${ISOLATE}, so its ` +
          `credential lands in the file every concurrent job on this ` +
          `self-hosted box shares.`,
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it("never hand-rolls a docker login or logout in a shell step", () => {
    // The action is not the only way to write that file. A `run:` block reaching
    // for either verb bypasses every assertion above, and `docker logout` in
    // particular is destructive to whatever else is mid-push on the box.
    for (const { file, job, steps } of jobs())
      for (const step of steps)
        expect(
          step.run ?? "",
          `${file} (${job}) shells out to \`docker login\`/\`docker logout\`, ` +
            `which writes the shared credential file directly.`,
        ).not.toMatch(/\bdocker\s+log(?:in|out)\b/);
  });

  it("leaves `logout` at its default, so the isolated file is the only one emptied", () => {
    // `logout: false` would be a second, worse fix for the same bug: it stops a
    // job deleting the shared credential but leaves it OVERWRITING it, and
    // leaves a live ghcr token in a box-wide file after the job ends. Isolation
    // makes the post-step logout harmless, so it should still run.
    for (const { file, job, steps } of jobs())
      for (const step of steps.filter(isLogin))
        expect(
          step.with?.logout ?? true,
          `${file} (${job}) turns off \`logout\`. With DOCKER_CONFIG isolated ` +
            `the post-step logout only empties this job's own file, and ` +
            `skipping it leaves a live token behind on the runner.`,
        ).toBe(true);
  });
});

describe("the isolation action puts the credential somewhere private", () => {
  const manifest = parse(readFileSync(MANIFEST, "utf8")) as {
    runs?: { steps?: Step[] };
  };
  const step = (manifest.runs?.steps ?? []).find(
    (s) => typeof s.run === "string",
  );

  it("has a shell step to check at all", () => {
    expect(step, `${MANIFEST} has no \`run:\` step`).toBeDefined();
  });

  /**
   * RUN it rather than grep it. "Mentions RUNNER_TEMP" is satisfied by a step
   * that mentions it in a comment and then writes `/tmp/docker`, which is the
   * shared path this whole file exists to forbid — and by an inverted guard,
   * which still reads fine.
   *
   * `-e -o pipefail` are the flags GitHub's default `shell: bash` supplies, and
   * the step relies on them rather than setting its own. A plain `bash -c` here
   * would run it under LOOSER rules than production: an unwritable RUNNER_TEMP
   * aborts the step on the runner and would sail through this test, exporting a
   * DOCKER_CONFIG that names a directory `mkdir` never created.
   */
  const run = (runnerTemp: string): { status: number; env: string } => {
    const home = mkdtempSync(join(tmpdir(), "docker-config-"));
    const githubEnv = join(home, "github.env");
    writeFileSync(githubEnv, "");
    try {
      execFileSync("bash", ["-e", "-o", "pipefail", "-c", step!.run!], {
        env: {
          ...process.env,
          RUNNER_TEMP: runnerTemp,
          GITHUB_ENV: githubEnv,
        },
        stdio: "pipe",
      });
      return { status: 0, env: readFileSync(githubEnv, "utf8") };
    } catch (e) {
      return {
        status: (e as { status?: number }).status ?? -1,
        env: readFileSync(githubEnv, "utf8"),
      };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  };

  it("exports a DOCKER_CONFIG under the runner's own temp directory", () => {
    const temp = mkdtempSync(join(tmpdir(), "runner-temp-"));
    try {
      const { status, env } = run(temp);

      expect(status, `${MANIFEST} failed with a RUNNER_TEMP set`).toBe(0);
      expect(
        env.trim(),
        `${MANIFEST} does not export a DOCKER_CONFIG under \`$RUNNER_TEMP\`, ` +
          `so the credential stays in a directory the whole box shares.`,
      ).toBe(`DOCKER_CONFIG=${temp}/docker`);

      // …and it must EXIST. `docker login` creates a missing config directory,
      // but `docker buildx` reading a builder record out of one does not.
      expect(
        existsSync(`${temp}/docker`),
        `${MANIFEST} exports a DOCKER_CONFIG it never created.`,
      ).toBe(true);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("refuses rather than falling back to a shared path", () => {
    // An empty RUNNER_TEMP interpolates to `/docker` — absolute, shared, and
    // silently the original bug with an extra directory in the name.
    const { status, env } = run("");

    expect(
      status,
      `${MANIFEST} accepts an empty RUNNER_TEMP, which names a directory ` +
        `every job on the box shares.`,
    ).toBe(1);
    expect(
      env,
      `${MANIFEST} exported a DOCKER_CONFIG anyway on the failure path.`,
    ).toBe("");
  });
});
