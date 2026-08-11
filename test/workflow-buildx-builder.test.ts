import { readdirSync, readFileSync } from "node:fs";
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
const COMPOSITE = ".github/actions/build-push/action.yml";

/** A step that builds an image, by either route this repo uses. */
const BUILD_ACTIONS = [
  "docker/build-push-action@",
  "./.github/actions/build-push",
];

/** How many builder-owning jobs and build steps we expect to find at all. */
const MIN_SETUP_STEPS = 10;
const MIN_BUILD_STEPS = 12;

interface Step {
  uses?: string;
  id?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  run?: string;
  name?: string;
}

function workflows(): { file: string; doc: unknown }[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => ({
      file: `${WORKFLOW_DIR}/${f}`,
      doc: parse(readFileSync(`${WORKFLOW_DIR}/${f}`, "utf8")),
    }));
}

/** Every `jobs.<id>` that runs steps, across every workflow. */
function* jobs(): Generator<{ file: string; job: string; steps: Step[] }> {
  for (const { file, doc } of workflows()) {
    const all = (doc as { jobs?: Record<string, { steps?: Step[] }> }).jobs;
    for (const [job, body] of Object.entries(all ?? {}))
      if (Array.isArray(body?.steps)) yield { file, job, steps: body.steps };
  }
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

    for (const { file, job, steps } of jobs()) {
      const setup = steps.find(isSetup);
      const builds = steps.filter(isBuild);
      if (builds.length === 0) continue;

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
      }
    }

    expect(found).toBeGreaterThanOrEqual(MIN_BUILD_STEPS);
  });

  it("never hand-rolls a `docker buildx build` without one either", () => {
    // The actions above are not the only way to reach buildkit: a `run:` block
    // is one `docker buildx build .` away from the same bug, and no action
    // input would be missing to notice it.
    for (const { file, job, steps } of jobs())
      for (const step of steps)
        for (const line of (step.run ?? "").split("\n"))
          if (/\bdocker\s+buildx\s+build\b/.test(line))
            expect(
              line,
              `${file} (${job}) shells out to \`docker buildx build\` without ` +
                `\`--builder\`, which resolves the shared pointer.`,
            ).toMatch(/--builder\b/);
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
    // It must FAIL on empty, not warn: a warning still builds on the shared
    // pointer, which is the whole failure mode.
    expect(steps[guard]!.run).toMatch(/exit 1/);
  });
});
