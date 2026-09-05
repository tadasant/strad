import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parse } from "yaml";

/**
 * The publish graph of `.github/workflows`: which workflows end in an image on
 * ghcr, and which job's steps actually do it.
 *
 * Every supplementary image release used to be one workflow holding its own
 * copy of the build — so "does this file log in", "does this file name its
 * builder" and "does this file build at all" were all answerable by reading one
 * file, and `test/workflow-docker-config.test.ts` and
 * `test/workflow-buildx-builder.test.ts` did exactly that.
 * `release-supplementary-image.yml` moved that body behind a `workflow_call`,
 * which is the point — but it also means a per-file scan now walks past four
 * releases without asserting anything about them, because a job that only
 * `uses:` another workflow has no steps of its own.
 *
 * So the invariants those files assert are asserted where the steps really are.
 * This module is the edge-following half: it resolves a delegating job to the
 * job that runs the build, and it keeps the ENTRY — the triggerable workflow the
 * path started at — so a failure names the release that is broken rather than
 * the shared file it goes through.
 */

export const WORKFLOW_DIR = ".github/workflows";

/** The wrapper every image build in this repo goes through. */
export const BUILD_PUSH = "./.github/actions/build-push";

export interface Step {
  "continue-on-error"?: boolean;
  uses?: string;
  id?: string;
  if?: unknown;
  name?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

export type Permissions = Record<string, string> | string;

export interface Job {
  steps?: Step[];
  uses?: string;
  secrets?: unknown;
  permissions?: Permissions;
}

export interface Workflow {
  on?: Record<string, unknown>;
  permissions?: Permissions;
  jobs?: Record<string, Job>;
}

export function workflowFiles(): string[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => `${WORKFLOW_DIR}/${f}`);
}

export function workflow(file: string): Workflow {
  return (parse(readFileSync(file, "utf8")) as Workflow) ?? {};
}

/**
 * The file a job's `uses:` names, for a reusable workflow in THIS repo. Both
 * spellings: the `./` path form these callers use, and the
 * `owner/repo/.github/workflows/x.yml@ref` form, which is legal for a same-repo
 * call and would otherwise be an edge every walk here silently does not follow.
 */
export function calledWorkflow(uses: string | undefined): string | undefined {
  if (typeof uses !== "string") return undefined;
  if (uses.startsWith("./")) return uses.slice(2);
  const m = /^[^/]+\/[^/]+\/(\.github\/workflows\/[^@]+)@/.exec(uses);
  return m?.[1];
}

/** A step that builds an image, by either route this repo uses. */
export function isBuild(step: Step): boolean {
  return (
    step.uses === BUILD_PUSH ||
    (step.uses?.startsWith("docker/build-push-action@") ?? false)
  );
}

/**
 * …and one that INTENDS to publish what it built.
 *
 * `push:` is an intent rather than the last word — `.github/actions/build-push`
 * folds the event name in, so a pull-request run publishes nothing whatever a
 * call site asks for. That is deliberately not read here: this module answers
 * "would this reach ghcr on the event it was written for", which is the question
 * the login and builder invariants hang off.
 */
export function isPublish(step: Step): boolean {
  return isBuild(step) && String(step.with?.push ?? "true") !== "false";
}

/**
 * A workflow something outside this repo's workflow directory can start.
 *
 * `release-supplementary-image.yml` and `deploy-staging.yml`'s `workflow_call`
 * surface are libraries: they run only when a caller runs them, so counting them
 * as releases in their own right would double-count the same build.
 */
export function isTriggerable(file: string): boolean {
  const on = workflow(file).on;
  if (!on) return false;
  return Object.keys(on).some((e) => e !== "workflow_call");
}

/**
 * One unit of "something builds an image here": the job whose steps run the
 * build, and the triggerable workflow that reaches it.
 */
export interface BuildUnit {
  /** The triggerable workflow this path started at. */
  entry: string;
  /** The workflow the job is declared in — the same file unless it delegated. */
  file: string;
  job: string;
  steps: Step[];
  /** Whether any of those steps intends to push what it builds. */
  publishes: boolean;
}

/** Every build reachable from `file`, following `uses:` into local workflows. */
function unitsFrom(
  entry: string,
  file: string,
  seen: Set<string>,
): BuildUnit[] {
  if (seen.has(file) || !existsSync(file)) return [];
  seen.add(file);

  const out: BuildUnit[] = [];
  for (const [job, body] of Object.entries(workflow(file).jobs ?? {})) {
    const target = calledWorkflow(body.uses);
    if (target) {
      out.push(...unitsFrom(entry, target, seen));
      continue;
    }
    const steps = body.steps ?? [];
    if (steps.some(isBuild))
      out.push({
        entry,
        file,
        job,
        steps,
        publishes: steps.some(isPublish),
      });
  }
  return out;
}

/**
 * Every image build in this repo, once per triggerable workflow that reaches
 * it. A shared body called by four releases yields four units — which is right:
 * each of those releases is separately broken if the body is.
 */
export function buildUnits(): BuildUnit[] {
  return workflowFiles()
    .filter(isTriggerable)
    .flatMap((entry) => unitsFrom(entry, entry, new Set()));
}

/** The triggerable workflows that put an image on ghcr. */
export function publishingWorkflows(): string[] {
  return [
    ...new Set(
      buildUnits()
        .filter((u) => u.publishes)
        .map((u) => u.entry),
    ),
  ].sort();
}

/** Whether a `permissions:` block grants `packages: write`. */
export function grantsPackageWrite(perms: Permissions | undefined): boolean {
  if (perms === undefined) return false;
  if (typeof perms === "string") return perms === "write-all";
  return perms.packages === "write";
}
