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

/**
 * Every local composite action's manifest, globbed rather than listed — at any
 * depth, and in both spellings. GitHub accepts `action.yaml` as readily as
 * `action.yml`, so matching only one spelling would leave a whole action
 * invisible to every assertion in this file rather than failing anything.
 */
function actionFiles(dir: string = ACTION_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory()) return actionFiles(path);
    return /^action\.ya?ml$/.test(e.name) ? [path] : [];
  });
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
    // expression, and a malformed one fails the whole action to load. That matters
    // most in a local action: actionlint does NOT read a composite's `run:`
    // blocks even when it follows the `uses:` to them, so `ci.yml`'s workflow
    // lint cannot see this. `ci.yml` also RUNS `build-push` on every PR (#73),
    // which would catch a manifest that does not load — but a `run:` block only
    // executes on the branch a step is reached from, and the ones below the first
    // attempt are reached only when a build has already failed.
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

/**
 * The same mistake one field over, which the escape test above does not cover
 * and which cost a whole release path.
 *
 * The runner template-parses an action manifest when it LOADS it — every string
 * in the file, not just the ones under `runs:`. A `description:` is prose to a
 * human and an expression context to the parser, and the only contexts it has
 * there are the ones available before any step runs. So an example expression
 * written into a description is EVALUATED, and `steps` is not a name it knows:
 *
 *     ./.github/actions/build-push/action.yml (Line: 46, Col: 18):
 *     Unrecognized named-value: 'steps'.
 *
 * That is not the step failing. The manifest fails validation, so the action
 * fails to load, so the step that calls it fails instantly — which on
 * 2026-08-11 was all eight release workflows on `main`, on one commit, seconds
 * and before a single build ran. It shipped green because no PR job loaded this
 * action then — every call site was a release workflow — and `actionlint`
 * validates an action's interface without evaluating its prose. `ci.yml` loads
 * it on every PR (#73), which is the other half of the same guard: a load proves
 * the file parses, and this assertion is what keeps the next example out of a
 * description. HACKS.md #53.
 */
describe("an action manifest's prose is never parsed as code", () => {
  /**
   * Paths whose value is DOCUMENTATION — matched whole, never by leaf key.
   *
   * A `with:` value is an expression context whatever the input happens to be
   * called, and plenty of actions take one called `name`:
   * `docker/setup-buildx-action` does, `actions/upload-artifact` does. A step's
   * `name:` is an expression context too. Keying on the leaf would fail this
   * test on `with: {name: ${{ … }}}` — legal, common, and nothing to do with
   * the bug — while claiming the action no longer loads.
   */
  const DOC_PATHS = [
    /^(?:name|author|description)$/,
    /^inputs\.[^.]+\.(?:description|deprecationMessage)$/,
    /^outputs\.[^.]+\.description$/,
  ];

  /**
   * An input DEFAULT is a genuine expression context, so it is not documentation
   * — but only for names that resolve before any step has run.
   * `default: ${{ github.token }}` is the standard idiom and must pass; a
   * `steps.`, `needs.` or `job.` reference there fails the manifest load exactly
   * as a description does.
   */
  const DEFAULT_PATH = /^inputs\.[^.]+\.default$/;
  const TOO_LATE = /\$\{\{[^}]*\b(?:steps|needs|job)\./;

  /** Every offending string in one manifest, as `path: value`. */
  function violations(doc: unknown, path = ""): string[] {
    if (typeof doc === "string") {
      const bad =
        (DOC_PATHS.some((r) => r.test(path)) && doc.includes("${{")) ||
        (DEFAULT_PATH.test(path) && TOO_LATE.test(doc));
      return bad ? [`${path}: ${doc.replace(/\s+/g, " ").slice(0, 120)}`] : [];
    }
    if (Array.isArray(doc))
      return doc.flatMap((v, i) => violations(v, `${path}[${i}]`));
    if (doc && typeof doc === "object")
      return Object.entries(doc).flatMap(([k, v]) =>
        violations(v, path ? `${path}.${k}` : k),
      );
    return [];
  }

  const files = actionFiles();

  // Guard the guard: this whole describe passes vacuously over an empty list.
  it("finds the local actions to check at all", () => {
    expect(files).toContain(COMPOSITE);
  });

  it.each(files)("%s documents expressions without writing them", (file) => {
    expect(
      violations(parse(readFileSync(file, "utf8"))),
      `${file} writes \`\${{\` where the runner cannot resolve it. It is ` +
        `evaluated when the manifest LOADS, against a scope with no \`steps\` ` +
        `— so the action fails to load and every step that calls it, in every ` +
        `workflow, fails instantly. Name the expression in prose instead.`,
    ).toEqual([]);
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
