import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The release path must EXECUTE before it is merged, and must not be able to
 * publish while it does.
 *
 * `.github/actions/build-push` is the one action every image build in this repo
 * goes through, and for most of its life every call site was a release workflow
 * — `push: branches: [main]`, all eight of them. So the first execution of a
 * change to that action was also its first production run. On 2026-08-11 a `${{
 * … }}` written as an EXAMPLE in an input `description:` merged green and took
 * all eight release workflows down within twenty seconds of the merge, before a
 * single build ran; it took three more commits on `main` to settle. `actionlint`
 * was green on all of it, because it validates an action's INTERFACE and reads
 * neither its prose nor its shell. HACKS.md #73.
 *
 * The remedy has two halves and this file holds both still:
 *
 *   1. `ci.yml` builds its two images THROUGH the action, so every pull request
 *      loads and runs it. A manifest that does not parse, an input that is not
 *      declared, buildx wiring that does not hold together — all of it fails the
 *      PR now. That coverage is one `uses:` away from being gone again, and its
 *      absence looks like nothing at all: the builds still pass.
 *
 *   2. A pull request may build; it may NOT publish. That is deliberately not a
 *      condition repeated across call sites — the action folds `github.event_name`
 *      in itself, once — and no `pull_request`-triggered workflow holds a
 *      registry credential in the first place. Both are asserted below, because
 *      the whole reason the first half is affordable is that the second holds.
 */

const WORKFLOW_DIR = ".github/workflows";
const COMPOSITE = ".github/actions/build-push/action.yml";
const WRAPPER = "./.github/actions/build-push";

interface Step {
  "continue-on-error"?: boolean;
  uses?: string;
  id?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  run?: string;
  name?: string;
}

interface Job {
  steps?: Step[];
  uses?: string;
  permissions?: Record<string, string> | string;
}

interface Workflow {
  on?: Record<string, unknown>;
  jobs?: Record<string, Job>;
}

function workflowFiles(): string[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => `${WORKFLOW_DIR}/${f}`);
}

function workflow(file: string): Workflow {
  return (parse(readFileSync(file, "utf8")) as Workflow) ?? {};
}

/** Every step of every job in a workflow, jobs that only `uses:` another aside. */
function steps(doc: Workflow): Step[] {
  return Object.values(doc.jobs ?? {}).flatMap((j) => j.steps ?? []);
}

const usesWrapper = (s: Step) => s.uses === WRAPPER;

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
 * `secrets: inherit` would hand it the caller's secrets. Following the edge is
 * what keeps the credential assertion below honest.
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
      const called = job.uses;
      if (typeof called !== "string" || !called.startsWith("./")) continue;
      const path = called.replace(/^\.\//, "");
      if (existsSync(path)) queue.push(path);
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
  const attempts = compositeSteps.filter((s) =>
    s.uses?.startsWith("docker/build-push-action@"),
  );

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
    ).toBeLessThan(compositeSteps.findIndex((s) => attempts.includes(s)));

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

    for (const step of attempts)
      expect(
        step.with?.push,
        `${COMPOSITE}: \`${step.name}\` does not take its \`push:\` from the ` +
          `mode step, so that attempt publishes on its own terms.`,
      ).toBe(`\${{ steps.${id}.outputs.push }}`);
  });

  it("defaults to pushing, so a release call site says nothing", () => {
    // The default matters in the other direction too: the eight release
    // workflows pass no `push:` at all, and a default of `false` would turn
    // every one of them into a green run that published nothing.
    expect(composite.inputs?.push?.default).toBe("true");
  });

  it("refuses to retry a build that pushed nothing", () => {
    // The retry exists for a blob ghcr refused. A build-only run has no blob to
    // refuse, so a failure is the Dockerfile and rebuilding it twice more only
    // spends a PR's wall clock — thirteen dependency trees, for the bundle.
    const guard = compositeSteps.find(
      (s) =>
        typeof s.if === "string" &&
        /steps\.\w[\w-]*\.outputs\.push\s*!=\s*'true'/.test(s.if),
    );

    expect(
      guard,
      `${COMPOSITE} has no step that ends a failed build-only run, so a ` +
        `broken Dockerfile is rebuilt three times before the PR goes red.`,
    ).toBeDefined();
    expect(guard!.if).toMatch(/attempt-1\.outcome\s*==\s*'failure'/);

    // And it must be fatal. The first attempt is `continue-on-error`, so a guard
    // that only warned would leave a failed build-only run falling through to a
    // green action.
    expect(
      guard!["continue-on-error"],
      `${COMPOSITE}: the build-only guard runs with \`continue-on-error\`.`,
    ).toBeUndefined();
    expect(guard!.run ?? "").toMatch(/exit 1/);
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
  // that a `pull_request` run never holds a credential to push WITH: the eight
  // release workflows log in to ghcr with `packages: write`, and giving one of
  // them a `pull_request` trigger would put that login on the PR path whatever
  // any later condition did with it. Adding a trigger is one line, and nothing
  // else in a diff would say what it reached.
  const reachable = [...prReachable()];

  it("finds the pull-request-reachable workflows at all", () => {
    // Guard the guard: an empty list passes every assertion below.
    expect(reachable.length).toBeGreaterThanOrEqual(2);
    expect(reachable).toContain(`${WORKFLOW_DIR}/ci.yml`);
  });

  it.each(reachable)("%s logs in to no registry", (file) => {
    for (const step of steps(workflow(file)))
      expect(
        step.uses ?? "",
        `${file} runs \`docker/login-action\` and is reachable from a ` +
          `\`pull_request\` event, which puts a registry credential in reach ` +
          `of an unmerged branch. A PR-time build pushes nothing and needs no ` +
          `login.`,
      ).not.toMatch(/^docker\/login-action@/);
  });

  it.each(reachable)("%s asks for no write on packages", (file) => {
    const doc = workflow(file);
    for (const [name, job] of Object.entries(doc.jobs ?? {})) {
      const perms = job.permissions;
      if (!perms || typeof perms === "string") continue;
      expect(
        perms.packages ?? "none",
        `${file} (${name}) grants \`packages: ${perms.packages}\` and is ` +
          `reachable from a \`pull_request\` event.`,
      ).not.toBe("write");
    }
  });
});
