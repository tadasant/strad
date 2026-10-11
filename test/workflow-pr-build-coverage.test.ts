import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  BUILD_PUSH,
  calledWorkflow,
  workflow,
  workflowFiles,
  WORKFLOW_DIR,
  type Permissions,
  type Step,
  type Workflow,
} from "./helpers/workflow-graph.js";

/**
 * The release path must EXECUTE before it is merged, and must not be able to
 * publish while it does.
 *
 * `.github/actions/build-push` is the one action every image build in this repo
 * goes through, and for most of its life every call site sat in a workflow no
 * pull request could reach — the eight release workflows, on
 * `push: branches: [main]`, plus `deploy-staging.yml` on `workflow_call`. So the
 * first execution of a change to that action was also its first production run.
 * On 2026-08-11 a `${{ … }}` written as an EXAMPLE in an input `description:`
 * merged green and took all eight release workflows down within twenty seconds
 * of the merge, before a single build ran; it took three more commits on `main`
 * to settle. `actionlint` was green on all of it, because it validates an
 * action's INTERFACE and reads neither its prose nor its shell. HACKS.md #73.
 *
 * The remedy has two halves and this file holds both still:
 *
 *   1. `ci.yml` builds its two images THROUGH the action, so every pull request
 *      loads and runs it. A manifest that does not parse, an input that is not
 *      declared, buildx wiring that does not hold together — all of it fails the
 *      PR. That coverage is one `uses:` away from being gone again, and its
 *      absence looks like nothing at all: the builds still pass.
 *
 *   2. A pull request may build; it may NOT publish. That is deliberately not a
 *      condition repeated across call sites — the action folds `github.event_name`
 *      in itself, once — and nothing a pull request can reach holds a registry
 *      credential in the first place. Both are asserted below, because the whole
 *      reason the first half is affordable is that the second holds.
 */

const ACTION_DIR = ".github/actions";
const COMPOSITE = `${ACTION_DIR}/build-push/action.yml`;
const WRAPPER = BUILD_PUSH;

/** Every step of every job in a workflow, jobs that only `uses:` another aside. */
function steps(doc: Workflow): Step[] {
  return Object.values(doc.jobs ?? {}).flatMap((j) => j.steps ?? []);
}

const usesWrapper = (s: Step) => s.uses === WRAPPER;

/** A local composite action's step list, in either spelling of the manifest. */
function actionSteps(dir: string): Step[] | undefined {
  for (const name of ["action.yml", "action.yaml"]) {
    const path = `${dir}/${name}`;
    if (!existsSync(path)) continue;
    const doc = parse(readFileSync(path, "utf8")) as {
      runs?: { steps?: Step[] };
    };
    if (Array.isArray(doc?.runs?.steps)) return doc.runs.steps;
  }
  return undefined;
}

/**
 * Both spellings of the trigger. `pull_request_target` is the sharper one: it
 * runs against the BASE ref with the full write token rather than the fork's
 * read-only one, so a release workflow that grew one would be the single event
 * where an unreviewed branch could reach ghcr with a real credential. Nothing
 * here uses it, which is the state to hold.
 */
const PR_EVENTS = ["pull_request", "pull_request_target"] as const;

/**
 * The workflows a pull request can reach: the ones triggered on either PR event,
 * plus anything they call as a reusable workflow. A called workflow runs with
 * the caller's event, so `github.event_name` there is still the PR one — and
 * `secrets: inherit` would hand it the caller's secrets. Following that edge is
 * what keeps the credential assertions below honest.
 *
 * `workflow_run` is deliberately NOT an edge. `alert-ci-failure.yml` fires when
 * a PR's CI run completes, but a `workflow_run` job executes the BASE branch's
 * definition with a token no PR author can influence — that is the whole point
 * of the trigger — so it is not a path an unmerged branch reaches. Leaving it
 * out is a decision, not an oversight.
 */
function prReachable(): Set<string> {
  const reached = new Set<string>();
  const queue: string[] = [];

  for (const file of workflowFiles()) {
    const on = workflow(file).on;
    // `on: pull_request` with no body parses as a null value, not a missing key.
    if (
      on &&
      PR_EVENTS.some((e) => Object.prototype.hasOwnProperty.call(on, e))
    )
      queue.push(file);
  }

  while (queue.length) {
    const file = queue.pop()!;
    if (reached.has(file)) continue;
    reached.add(file);
    for (const job of Object.values(workflow(file).jobs ?? {})) {
      const path = calledWorkflow(job.uses);
      if (path && existsSync(path)) queue.push(path);
    }
  }

  return reached;
}

/** A `pull_request:` trigger that names no `paths:` filter runs on every PR. */
function runsOnEveryPr(file: string): boolean {
  const on = workflow(file).on;
  if (!on || !Object.prototype.hasOwnProperty.call(on, "pull_request"))
    return false;
  const trigger = on.pull_request as Record<string, unknown> | null;
  if (!trigger) return true;
  return !("paths" in trigger) && !("paths-ignore" in trigger);
}

describe("the release path's build action runs before it is merged", () => {
  it("is executed by a workflow that runs on EVERY pull request", () => {
    // Not merely "some workflow with a pull_request trigger": `bundle-google-ci`
    // has one and is scoped by `paths:` to its own image, so a PR that breaks
    // the action while touching nothing under `images/bundle-google/` would
    // never load it. The coverage has to be unconditional to be coverage.
    const covering = workflowFiles().filter(
      (f) => runsOnEveryPr(f) && steps(workflow(f)).some(usesWrapper),
    );

    expect(
      covering,
      `no workflow with an unfiltered \`pull_request\` trigger runs ` +
        `\`${WRAPPER}\`, so a change to it merges without ever being executed ` +
        `— which is how eight release workflows went red at once on ` +
        `2026-08-11. See HACKS.md #73.`,
    ).not.toEqual([]);
  });

  it("is the only way anything in this repo builds an image", () => {
    // A call site that reaches `docker/build-push-action` directly is a build
    // that does not exercise the wrapper — and if it is one of `ci.yml`'s, it is
    // the PR-time coverage above, silently removed with every build still green.
    for (const file of workflowFiles())
      for (const step of steps(workflow(file)))
        expect(
          step.uses ?? "",
          `${file}: \`${step.name ?? step.uses}\` calls ` +
            `\`docker/build-push-action\` directly. Every image build in this ` +
            `repo goes through \`${WRAPPER}\` — pushing or not — because that ` +
            `is what gets the release path's shared action executed on a PR.`,
        ).not.toMatch(/^docker\/build-push-action@/);
  });
});

describe("a pull request builds but never publishes", () => {
  const composite = parse(readFileSync(COMPOSITE, "utf8")) as {
    inputs?: Record<string, { default?: unknown }>;
    runs?: { steps?: Step[] };
  };
  const compositeSteps = composite.runs?.steps ?? [];

  /** The one step that folds the event name into the effective push. */
  const modeIndex = compositeSteps.findIndex((s) =>
    Object.values(s.env ?? {}).includes("${{ inputs.push }}"),
  );
  const isAttempt = (s: Step) =>
    s.uses?.startsWith("docker/build-push-action@") ?? false;
  const attempts = compositeSteps.filter(isAttempt);
  const firstAttempt = compositeSteps.findIndex(isAttempt);

  it("decides it in one place, before the first attempt", () => {
    expect(
      modeIndex,
      `${COMPOSITE} has no shell step reading \`inputs.push\`, so nothing ` +
        `folds the event name in and a \`pull_request\` run would publish ` +
        `whatever its call site asked for.`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      modeIndex,
      `${COMPOSITE} decides the push mode only after a build has already run.`,
    ).toBeLessThan(firstAttempt);

    // `continue-on-error` here would report the problem and build anyway.
    expect(
      compositeSteps[modeIndex]!["continue-on-error"],
      `${COMPOSITE}: the mode step runs with \`continue-on-error\`, so a ` +
        `rejected value does not stop the build.`,
    ).toBeUndefined();
  });

  it("hands that one decision to every attempt", () => {
    expect(attempts.length).toBe(3);

    const id = compositeSteps[modeIndex]!.id;
    expect(id, `${COMPOSITE}: the mode step has no \`id:\`.`).toBeTruthy();

    // Both halves of the decision. `load` matters as much as `push` on the
    // retries: an attempt that dropped it would rebuild without exporting, and
    // the `docker run` a call site does next would find no image — a green
    // build followed by an unrelated-looking failure.
    for (const step of attempts)
      for (const key of ["push", "load"] as const)
        expect(
          step.with?.[key],
          `${COMPOSITE}: \`${step.name}\` does not take its \`${key}:\` from ` +
            `the mode step, so that attempt runs on its own terms.`,
        ).toBe(`\${{ steps.${id}.outputs.${key} }}`);
  });

  it("defaults to pushing, so a release call site says nothing", () => {
    // The default matters in the other direction too: the release workflows
    // pass no `push:` at all, and a default of `false` would turn every one of
    // them into a green run that published nothing.
    expect(composite.inputs?.push?.default).toBe("true");
  });

  it("refuses to retry a build that pushed nothing", () => {
    // The retry exists for a blob ghcr refused. A build-only run has no blob to
    // refuse, so a failure is the Dockerfile and rebuilding it twice more only
    // spends a PR's wall clock — twenty-two dependency trees, for the bundle.
    const guardIndex = compositeSteps.findIndex(
      (s) =>
        typeof s.if === "string" &&
        /steps\.\w[\w-]*\.outputs\.push\s*!=\s*'true'/.test(s.if),
    );

    expect(
      guardIndex,
      `${COMPOSITE} has no step that ends a failed build-only run, so a ` +
        `broken Dockerfile is rebuilt three times before the PR goes red.`,
    ).toBeGreaterThanOrEqual(0);
    const guard = compositeSteps[guardIndex]!;
    expect(guard.if).toMatch(/attempt-1\.outcome\s*==\s*'failure'/);

    // POSITION is the whole mechanism. The retries are not gated on the push —
    // they are unreachable because a composite action stops at the first step
    // that exits non-zero. Move this guard below them and every other assertion
    // here still passes while the build is retried three times again.
    expect(
      guardIndex,
      `${COMPOSITE}: the build-only guard does not run immediately after the ` +
        `first attempt, so the retries below it are reachable again.`,
    ).toBe(firstAttempt + 1);

    // And it must be fatal. The first attempt is `continue-on-error`, so a guard
    // that only warned would leave a failed build-only run falling through to a
    // green action.
    expect(
      guard["continue-on-error"],
      `${COMPOSITE}: the build-only guard runs with \`continue-on-error\`.`,
    ).toBeUndefined();
    expect(guard.run ?? "").toMatch(/exit 1/);
  });

  it("resolves the mode the way it claims to, over every case", () => {
    // Run it rather than read it, for the reason the builder guard's test gives:
    // an inverted comparison still contains every string a grep would look for,
    // and this is the single check standing between a `pull_request` run and a
    // published image.
    const script = compositeSteps[modeIndex]!.run!;

    const run = (
      env: Record<string, string>,
    ): { status: number; push?: string; load?: string } => {
      const out = join(mkdtempSync(join(tmpdir(), "build-push-mode-")), "out");
      execFileSync("bash", ["-c", `: > "$GITHUB_OUTPUT"`], {
        env: { ...process.env, GITHUB_OUTPUT: out },
      });
      try {
        execFileSync("bash", ["-c", script], {
          env: { ...process.env, GITHUB_OUTPUT: out, ...env },
          stdio: "pipe",
        });
      } catch (e) {
        return { status: (e as { status?: number }).status ?? -1 };
      }
      const parsed = Object.fromEntries(
        readFileSync(out, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split("=") as [string, string]),
      );
      return { status: 0, ...parsed };
    };

    // The case this whole file exists for: a release call site's intent, reached
    // from a pull request, publishes nothing. Both spellings, because
    // `pull_request_target` is the one that would hold a real credential.
    for (const event of PR_EVENTS)
      expect(
        run({ WANT_PUSH: "true", LOAD: "false", EVENT: event }),
        `${COMPOSITE}: a ${event} run with \`push: true\` would PUBLISH. ` +
          `That is an image from an unmerged branch on ghcr.`,
      ).toMatchObject({ status: 0, push: "false" });

    // …and the release path still works.
    expect(
      run({ WANT_PUSH: "true", LOAD: "false", EVENT: "push" }),
      `${COMPOSITE}: a push to main does not publish, so every release is a ` +
        `green run that shipped nothing.`,
    ).toMatchObject({ status: 0, push: "true" });
    expect(
      run({ WANT_PUSH: "true", LOAD: "false", EVENT: "workflow_dispatch" }),
    ).toMatchObject({ status: 0, push: "true" });

    // An explicit `push: false` is honoured on any event.
    expect(
      run({ WANT_PUSH: "false", LOAD: "true", EVENT: "push" }),
    ).toMatchObject({ status: 0, push: "false", load: "true" });

    // A misspelt intent is an error, never a falsy value: `push: no` read as
    // "do not push" is a release that goes green having published nothing, and
    // the next deploy finds no image.
    for (const bad of ["no", "yes", "TRUE", "1", ""])
      expect(
        run({ WANT_PUSH: bad, LOAD: "false", EVENT: "push" }).status,
        `${COMPOSITE}: \`push: ${bad || "<empty>"}\` is accepted rather than ` +
          `rejected.`,
      ).toBe(1);
    for (const bad of ["no", "yes", "TRUE", "1", ""])
      expect(run({ WANT_PUSH: "true", LOAD: bad, EVENT: "push" }).status).toBe(
        1,
      );
  });
});

describe("no registry credential is reachable from a pull request", () => {
  // The action's event check is the second lock, not the only one. The first is
  // that a run a pull request can reach never holds a credential to push WITH:
  // the release workflows log in to ghcr with `packages: write`, and giving one
  // of them a `pull_request` trigger would put that login on the PR path
  // whatever any later condition did with it. Adding a trigger is one line, and
  // nothing else in a diff would say what it reached.
  //
  // This is also what closes the one way the event override could go wrong
  // quietly. A pushing call site that became PR-reachable would build, publish
  // nothing and exit 0 — and only `release-image.yml` asserts a digest, so
  // `deploy-staging.yml` would deploy a tag nothing wrote. The workflow that
  // would have to move for that is one this describe refuses.
  const reachable = [...prReachable()];

  /** Every step a workflow runs, including inside the local actions it calls. */
  function reachableSteps(file: string): { source: string; step: Step }[] {
    const out: { source: string; step: Step }[] = [];
    const seen = new Set<string>();
    const walk = (source: string, list: Step[]) => {
      for (const step of list) {
        out.push({ source, step });
        // A local composite action is a step source too, and it is exactly the
        // shape the PR path just grew: `uses: ./.github/actions/build-push`.
        // Stopping at the workflow would let a `./.github/actions/ghcr-login`
        // pass every assertion below.
        const uses = step.uses;
        if (typeof uses !== "string" || !uses.startsWith("./")) continue;
        const dir = uses.slice(2);
        if (seen.has(dir)) continue;
        seen.add(dir);
        const nested = actionSteps(dir);
        if (nested) walk(`${dir}/action.yml`, nested);
      }
    };
    walk(file, steps(workflow(file)));
    return out;
  }

  it("finds the pull-request-reachable workflows at all", () => {
    // Guard the guard: an empty list passes every assertion below.
    expect(reachable.length).toBeGreaterThanOrEqual(2);
    expect(reachable).toContain(`${WORKFLOW_DIR}/ci.yml`);
    expect(reachable).toContain(`${WORKFLOW_DIR}/bundle-google-ci.yml`);
    // …and that the walk really descends into the local actions, or the login
    // assertion below is a workflow-only scan wearing a deeper name.
    expect(
      reachableSteps(`${WORKFLOW_DIR}/ci.yml`).map((s) => s.source),
    ).toContain(COMPOSITE);
  });

  it.each(reachable)("%s logs in to no registry", (file) => {
    for (const { source, step } of reachableSteps(file)) {
      expect(
        step.uses ?? "",
        `${source} runs \`docker/login-action\` and is reachable from a ` +
          `pull request, which puts a registry credential in reach of an ` +
          `unmerged branch. A PR-time build pushes nothing and needs no login.`,
      ).not.toMatch(/^docker\/login-action@/);

      // The action is not the only spelling. A `docker login` in a `run:` block
      // reaches the same credential and no `uses:` would name it.
      expect(
        step.run ?? "",
        `${source} shells out to \`docker login\` and is reachable from a ` +
          `pull request.`,
      ).not.toMatch(/\bdocker\s+login\b/);
    }
  });

  it.each(reachable)("%s grants no write on packages", (file) => {
    const doc = workflow(file);

    // Workflow level FIRST, because that is where this repo actually writes
    // them: ten of the twelve `permissions:` blocks in this directory are
    // workflow-level, and a job-level-only scan would pass with no assertion
    // executed against the exact diff it exists to catch.
    const blocks: [string, Permissions | undefined][] = [
      [file, doc.permissions],
      ...Object.entries(doc.jobs ?? {}).map(
        ([name, job]): [string, Permissions | undefined] => [
          `${file} (${name})`,
          job.permissions,
        ],
      ),
    ];

    for (const [where, perms] of blocks) {
      if (perms === undefined) continue;
      // `permissions: write-all` is a string, and grants packages: write
      // without the word `packages` appearing anywhere.
      expect(
        perms,
        `${where} grants \`write-all\`, which includes \`packages: write\`.`,
      ).not.toBe("write-all");
      if (typeof perms === "string") continue;
      expect(
        perms.packages ?? "none",
        `${where} grants \`packages: ${perms.packages}\` and is reachable ` +
          `from a pull request.`,
      ).not.toBe("write");
    }
  });

  it.each(reachable)("%s pins its token down explicitly", (file) => {
    // "Grants nothing" above is only as good as the repository SETTING that
    // decides the default, and that setting lives in GitHub rather than in this
    // repo — flipping it to read/write would hand `packages: write` to every PR
    // run without any file here changing. An explicit workflow-level block
    // makes the guarantee structural. `alert-ci-failure.yml` already does it.
    expect(
      workflow(file).permissions,
      `${file} is reachable from a pull request and declares no ` +
        `workflow-level \`permissions:\`, so its token is whatever the ` +
        `repository default happens to be.`,
    ).toBeDefined();
  });

  it.each(reachable)("%s hands no secrets to a workflow it calls", (file) => {
    // `secrets: inherit` on a reusable-workflow call passes the caller's whole
    // secret set down, so a PR-reachable caller would reach every credential
    // this repo has regardless of what its own steps do.
    for (const [name, job] of Object.entries(workflow(file).jobs ?? {})) {
      if (job.secrets === undefined) continue;
      expect(
        job.secrets,
        `${file} (${name}) passes secrets to the workflow it calls, from a ` +
          `pull-request-reachable run.`,
      ).toBeUndefined();
    }
  });
});
