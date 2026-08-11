import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Every buildx build must name the builder it runs on.
 *
 * `~/.docker/buildx/current` is a shared name, in exactly the sense
 * `test/ci-workflow.isolation.test.ts` and `test/bundle-google-workflow.isolation.test.ts`
 * mean it — and the least visible one, because nothing in a workflow file says
 * it exists. `runs-on: self-hosted` means every job runs as the same user on one
 * box, `docker/setup-buildx-action` defaults to `use: true`, and `docker buildx
 * create --use` writes that ONE file. A `docker buildx build` with no
 * `--builder` reads it. So a build resolves whichever job on the box created a
 * builder most recently, runs inside a CONCURRENT job's buildkit, and is killed
 * with `graceful_stop` the moment that job's post-cleanup removes it.
 *
 * That is not a hypothetical. On 2026-08-11 it took `main` red: `bundle_image`
 * started its build at 10:36:23, twelve seconds after `Release image` had
 * created `builder-7cb9f269…` and claimed the pointer; that builder was removed
 * at 10:36:44 and the bundle build died at 10:36:54, 24s into a 791MB layer.
 * Nothing asserted, no step of ours at fault. HACKS.md #53.
 *
 * The fix is two-sided and both sides are one keystroke from being gone again:
 * `use: false` so no job WRITES the shared pointer, and an explicit `builder:`
 * on every build so no job READS it. Neither is visible in a diff as anything
 * more than a missing line, so assert both here.
 */

const WORKFLOW_DIR = ".github/workflows";
const ACTION_DIR = ".github/actions";
const COMPOSITE = `${ACTION_DIR}/build-push/action.yml`;

/** A step that builds an image, by either route this repo uses. */
const BUILD_ACTIONS = [
  "docker/build-push-action@",
  "./.github/actions/build-push",
];

/** How many builder-owning jobs and build steps we expect to find at all. */
const MIN_SETUP_STEPS = 10;
const MIN_BUILD_STEPS = 15;

interface Step {
  "continue-on-error"?: boolean;
  uses?: string;
  id?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  run?: string;
  name?: string;
}

/** Every local composite action's `action.yml`, globbed rather than listed. */
function actionFiles(): string[] {
  if (!existsSync(ACTION_DIR)) return [];
  return readdirSync(ACTION_DIR)
    .map((d) => `${ACTION_DIR}/${d}/action.yml`)
    .filter((f) => existsSync(f));
}

/**
 * Every step-running unit in `.github/`: each workflow job, and each local
 * composite action's step list. The actions belong here too — a second one that
 * builds an image would otherwise be invisible to every assertion below.
 */
function* jobs(): Generator<{
  file: string;
  job: string;
  steps: Step[];
  action: boolean;
}> {
  for (const f of readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f))) {
    const file = `${WORKFLOW_DIR}/${f}`;
    const doc = parse(readFileSync(file, "utf8")) as {
      jobs?: Record<string, { steps?: Step[] }>;
    };
    for (const [job, body] of Object.entries(doc?.jobs ?? {}))
      if (Array.isArray(body?.steps))
        yield { file, job, steps: body.steps, action: false };
  }

  for (const file of actionFiles()) {
    const doc = parse(readFileSync(file, "utf8")) as {
      runs?: { steps?: Step[] };
    };
    if (Array.isArray(doc?.runs?.steps))
      yield { file, job: "runs", steps: doc.runs.steps, action: true };
  }
}

/**
 * A step's shell script with line continuations folded away. Scanning raw lines
 * would call a correctly-written
 *
 *     docker buildx build \
 *       --builder "$BUILDER" .
 *
 * a violation, because the flag is not on the line the command is on.
 */
function script(step: Step): string[] {
  return (step.run ?? "").replace(/\\\r?\n/g, " ").split("\n");
}

const isSetup = (s: Step) => s.uses?.startsWith("docker/setup-buildx-action@");
const isBuild = (s: Step) =>
  BUILD_ACTIONS.some((a) => s.uses?.startsWith(a) ?? false);

describe("no build runs on a builder its own job does not own", () => {
  it("gives every `setup-buildx-action` an id, and stops it claiming the shared pointer", () => {
    let found = 0;

    for (const { file, job, steps } of jobs())
      for (const step of steps.filter(isSetup)) {
        found++;
        expect(
          step.id,
          `${file} (${job}) sets up buildx with no \`id:\`, so no build in ` +
            `that job can name the builder it just created.`,
        ).toBeTruthy();
        expect(
          step.with?.use,
          `${file} (${job}) leaves \`use:\` at its default of true, so it ` +
            `rewrites the box-wide \`~/.docker/buildx/current\` — which every ` +
            `concurrent job's builder-less build then resolves to.`,
        ).toBe(false);
      }

    // Guard the guard: an outer loop that found nothing would pass by
    // asserting over an empty list.
    expect(found).toBeGreaterThanOrEqual(MIN_SETUP_STEPS);
  });

  it("points every build step at its own job's builder", () => {
    let found = 0;

    for (const { file, job, steps, action } of jobs()) {
      const setup = steps.find(isSetup);
      const builds = steps.filter(isBuild);
      if (builds.length === 0) continue;

      // A composite action has no job of its own to create a builder in — it
      // runs inside its caller's. So it takes one as an input, and the caller
      // is what the workflow half of this test checks.
      if (action) {
        for (const step of builds) {
          found++;
          expect(
            step.with?.builder,
            `${file}: \`${step.name ?? step.uses}\` does not pass the ` +
              `action's \`builder\` input through, so it runs on the shared ` +
              `pointer no matter what the caller passed.`,
          ).toBe("${{ inputs.builder }}");
        }
        continue;
      }

      expect(
        setup,
        `${file} (${job}) builds an image without setting up a builder of ` +
          `its own, so it can only be using another job's.`,
      ).toBeDefined();

      for (const step of builds) {
        found++;
        expect(
          step.with?.builder,
          `${file} (${job}) runs \`${step.name ?? step.uses}\` with no ` +
            `\`builder:\`, so buildx resolves the shared pointer and the build ` +
            `dies when whichever job owns it tears down.`,
        ).toBe(`\${{ steps.${setup!.id}.outputs.name }}`);

        // …and the builder must already EXIST when that expression is read. A
        // setup step ordered after the build interpolates to the empty string,
        // which is the same silent fallback as writing no `builder:` at all.
        expect(
          steps.indexOf(setup!),
          `${file} (${job}) sets up its builder AFTER \`${step.name ?? step.uses}\`, ` +
            `so that step's \`builder:\` resolves to the empty string.`,
        ).toBeLessThan(steps.indexOf(step));
      }
    }

    expect(found).toBeGreaterThanOrEqual(MIN_BUILD_STEPS);
  });

  it("never hand-rolls a build command without one either", () => {
    // The actions above are not the only way to reach buildkit, and `docker
    // buildx build` is not the only spelling of it: since Docker 23 a plain
    // `docker build` IS buildx, and `bake` and `compose build` read the same
    // pointer. A `run:` block is one of those away from the same bug, and no
    // action input would be missing to notice it.
    const BUILDS =
      /\bdocker\s+(?:buildx\s+(?:build|bake)|compose\s+build|build)\b/;

    for (const { file, job, steps } of jobs())
      for (const step of steps)
        for (const line of script(step))
          if (BUILDS.test(line))
            expect(
              line,
              `${file} (${job}) shells out to a build command without ` +
                `\`--builder\`, which resolves the shared pointer.`,
            ).toMatch(/--builder\b/);
  });

  it("never writes the expression delimiter as an escape", () => {
    // `\${{` is not an escape — the runner has none — so it parses as an
    // expression and takes the whole file to a startup_failure. That matters
    // most in a local action: actionlint does NOT read a composite's `run:`
    // blocks even when it follows the `uses:` to them, so `ci.yml`'s workflow
    // lint cannot see this, and the steps that load `build-push` only run on
    // `main` (#51). Nothing else in a PR build would say a word.
    for (const { file, job, steps } of jobs())
      for (const step of steps)
        expect(
          step.run ?? "",
          `${file} (${job}) writes \`\\\${{\` in a shell step. There is no ` +
            `backslash escape for the delimiter; name the expression in prose ` +
            `instead.`,
        ).not.toMatch(/\\\$\{\{/);
  });
});

describe("the shared build-push action cannot be called without a builder", () => {
  const composite = parse(readFileSync(COMPOSITE, "utf8")) as {
    inputs?: Record<string, { required?: boolean }>;
    runs?: { steps?: Step[] };
  };

  it("declares `builder` as an input and hands it to every attempt", () => {
    expect(composite.inputs?.builder?.required).toBe(true);

    // All three retry attempts, or the one that finally pushes is the one that
    // silently falls back.
    const attempts = (composite.runs?.steps ?? []).filter(isBuild);
    expect(attempts.length).toBe(3);

    for (const step of attempts)
      expect(
        step.with?.builder,
        `${COMPOSITE}: \`${step.name}\` does not pass \`inputs.builder\` ` +
          `through, so that attempt runs on the shared pointer.`,
      ).toBe("${{ inputs.builder }}");
  });

  it("refuses to build when a caller omits it", () => {
    // `required: true` on a composite action's input is documentation: the
    // runner does not enforce it, and the omitted value interpolates to "",
    // which `docker/build-push-action` reads as "no `--builder`". So the only
    // thing standing between a forgetful call site and the original bug is a
    // guard that runs before the first attempt.
    const steps = composite.runs?.steps ?? [];
    const guard = steps.findIndex(
      (s) =>
        typeof s.run === "string" &&
        Object.values(s.env ?? {}).includes("${{ inputs.builder }}"),
    );

    expect(
      guard,
      `${COMPOSITE} has no shell step that reads \`inputs.builder\`, so ` +
        `nothing checks it is non-empty.`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      guard,
      `${COMPOSITE} checks \`inputs.builder\` only after a build has already run.`,
    ).toBeLessThan(steps.findIndex(isBuild));

    // A `continue-on-error: true` here would leave the guard reporting the
    // problem and building anyway — which is the unguarded behaviour, with a
    // red X nobody reads. Composite steps do support it; two attempts below use
    // it deliberately.
    expect(
      steps[guard]!["continue-on-error"],
      `${COMPOSITE}: the guard runs with \`continue-on-error\`, so failing it ` +
        `does not stop the build.`,
    ).toBeUndefined();

    // Then RUN it, rather than grepping it for `exit 1`. A guard whose test is
    // inverted (`-n` for `-z`) still contains the string, still reads fine, and
    // fails exactly when the builder IS set.
    const run = (builder: string): number => {
      try {
        execFileSync("bash", ["-c", steps[guard]!.run!], {
          env: { ...process.env, BUILDER: builder },
          stdio: "pipe",
        });
        return 0;
      } catch (e) {
        return (e as { status?: number }).status ?? -1;
      }
    };

    expect(
      run(""),
      `${COMPOSITE}: an empty builder does not fail the guard, so a call site ` +
        `that omits \`builder:\` builds on the shared pointer anyway.`,
    ).toBe(1);
    expect(
      run("builder-0000"),
      `${COMPOSITE}: the guard rejects a builder that IS set — it is inverted, ` +
        `and every correct call site would fail.`,
    ).toBe(0);
  });
});
