import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  calledWorkflow,
  workflow,
  workflowFiles,
  type Job,
} from "./helpers/workflow-graph.js";

/**
 * The supplementary image releases share one body, and what is left in each
 * caller is the part a copy-paste gets wrong.
 *
 * `release-supplementary-image.yml` holds the build. A caller is fifteen lines:
 * which tree cuts an image, which package it lands in, and a concurrency group.
 * That is a good trade and it moves the failure mode rather than removing it —
 * the six near-identical files this replaced were reviewable only by diffing
 * them against each other, and four fifteen-line files made from each other by
 * substitution have exactly one failure mode left: a substitution that was not
 * made.
 *
 * Every assertion here is a value that is WRONG rather than absent, so nothing
 * fails at the point of the mistake:
 *
 *   - the wrong `paths:` tree — a server whose changes cut no image, which is
 *     the silent failure `test/bundle-release-paths.test.ts` exists for one
 *     workflow over: merged, green, and not running.
 *   - a shared `concurrency:` group — two unrelated images queued behind each
 *     other, which looks like a slow runner.
 *   - an `image:` carrying a tag — `…:latest:latest`, which fails at the push.
 *
 * And one that is genuinely new with the collapse: a change to the shared body
 * is in no caller's `paths:` unless a caller names it, so the body's first
 * execution would be on whatever unrelated commit next touched one of these
 * trees. That is the gap #134 was filed about, reopened by the refactor that
 * was supposed to make the body easier to get right.
 */

const SHARED = ".github/workflows/release-supplementary-image.yml";

interface Caller {
  file: string;
  job: string;
  body: Job;
  paths: string[];
  group: string | undefined;
  with: Record<string, unknown>;
}

function callers(): Caller[] {
  const out: Caller[] = [];
  for (const file of workflowFiles()) {
    const doc = workflow(file);
    for (const [job, body] of Object.entries(doc.jobs ?? {})) {
      if (calledWorkflow(body.uses) !== SHARED) continue;
      const push = doc.on?.push as { paths?: string[] } | undefined;
      const concurrency = (
        doc as unknown as { concurrency?: { group?: string } }
      ).concurrency;
      out.push({
        file,
        job,
        body,
        paths: push?.paths ?? [],
        group: concurrency?.group,
        with: (body as { with?: Record<string, unknown> }).with ?? {},
      });
    }
  }
  return out;
}

describe("every caller of the shared supplementary release", () => {
  const found = callers();

  it("is found at all", () => {
    // Guard the guard: `it.each` over an empty list reports nothing and passes.
    expect(existsSync(SHARED), `${SHARED} is missing`).toBe(true);
    expect(
      found.map((c) => c.file),
      `nothing calls ${SHARED}, so every assertion below runs over an empty ` +
        `list. Either the callers were reverted or the path changed.`,
    ).not.toEqual([]);
    expect(found.length).toBeGreaterThanOrEqual(4);
  });

  it.each(found)("$file watches the tree it builds", (c) => {
    const context = c.with.context;
    expect(typeof context, `${c.file} (${c.job}) passes no \`context:\`.`).toBe(
      "string",
    );
    expect(
      existsSync(context as string),
      `${c.file} builds \`${context}\`, which is not a directory in this repo.`,
    ).toBe(true);
    expect(
      c.paths,
      `${c.file} builds \`${context}\` and does not watch it, so a change ` +
        `there merges and cuts no image — green, and still running the old ` +
        `code.`,
    ).toContain(`${context}/**`);
  });

  it.each(found)("$file watches itself and the body it delegates to", (c) => {
    expect(
      c.paths,
      `${c.file} does not watch itself, so editing it releases nothing.`,
    ).toContain(c.file);
    expect(
      c.paths,
      `${c.file} does not watch ${SHARED}. The build it runs lives there now, ` +
        `so a change to the shared body cuts no image from this caller and its ` +
        `first execution is whatever unrelated commit next touches ` +
        `\`${c.with.context}\`. That is exactly the "release path has no ` +
        `pre-merge execution" problem, reintroduced by sharing the body.`,
    ).toContain(SHARED);
  });

  it.each(found)("$file names a package rather than a tag", (c) => {
    const image = c.with.image;
    expect(typeof image, `${c.file} passes no \`image:\`.`).toBe("string");
    // The shared body appends `:latest` and `:sha-<commit>`. A tag here makes
    // both of them a second colon, and buildx refuses the reference.
    expect(
      (image as string).split("/").pop(),
      `${c.file} passes an \`image:\` with a tag on it. The shared body adds ` +
        `the tags; this input is the repository.`,
    ).not.toMatch(/:/);
    expect(image, `${c.file} publishes outside ghcr.io/tadasant.`).toMatch(
      /^ghcr\.io\/tadasant\/[a-z0-9-]+$/,
    );
  });

  it.each(found)("$file hands the shared body no secrets", (c) => {
    // The body needs only GITHUB_TOKEN, which a called workflow is handed
    // automatically. `secrets: inherit` would pass the whole set — every GCP,
    // DigitalOcean and ghcr-pull credential this repo holds — to a job that
    // wants none of them.
    expect(
      c.body.secrets,
      `${c.file} (${c.job}) inherits secrets into ${SHARED}, which uses none.`,
    ).toBeUndefined();
  });

  it.each(found)("$file grants the credential the push needs", (c) => {
    // A called workflow may narrow what its caller grants and never widen it,
    // so `packages: write` withheld here is a 403 on the push no permission on
    // the other side can fix.
    const doc = workflow(c.file);
    const granted =
      (typeof doc.permissions === "object" && doc.permissions?.packages) ||
      (typeof c.body.permissions === "object" && c.body.permissions?.packages);
    expect(
      granted,
      `${c.file} (${c.job}) does not grant \`packages: write\`, so the shared ` +
        `body cannot push whatever it declares for itself.`,
    ).toBe("write");
  });

  it("gives each caller a concurrency group of its own", () => {
    // Shared, these serialise two unrelated images behind each other —
    // `cancel-in-progress: false`, so nothing is cancelled and nothing errors;
    // the second release just waits, and the only symptom is a release that
    // took twice as long as it should have.
    const groups = found.map((c) => c.group);
    expect(
      groups.filter((g) => g === undefined),
      `a caller declares no \`concurrency:\` group, so two pushes to its tree ` +
        `build the same tag at once.`,
    ).toEqual([]);
    expect(
      new Set(groups).size,
      `two callers share a concurrency group: ${groups.join(", ")}`,
    ).toBe(found.length);
  });
});

describe("the shared supplementary release body", () => {
  const doc = workflow(SHARED);
  const text = readFileSync(SHARED, "utf8");

  it("is a library — nothing triggers it but a caller", () => {
    // A `push:` trigger here would build every caller's image on every commit,
    // with an empty `inputs.image`.
    expect(
      Object.keys(doc.on ?? {}),
      `${SHARED} has a trigger of its own.`,
    ).toEqual(["workflow_call"]);
  });

  it("publishes the two tags a release is, and no run-scoped one", () => {
    // The mirror of `test/release-onepassword-workflow.isolation.test.ts`: the
    // published tags are what App Platform pulls, so a run-scoped one here
    // would publish an image nothing can find. `github.sha` is the CALLER's
    // commit under `workflow_call`, which is what makes `sha-` the right tag.
    const build = (doc.jobs?.["build-and-push"]?.steps ?? []).find(
      (s) => s.uses === "./.github/actions/build-push",
    );
    const tags = String(build?.with?.tags ?? "")
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean);

    expect(tags, `${SHARED} does not publish two tags`).toEqual([
      "${{ inputs.image }}:latest",
      "${{ inputs.image }}:sha-${{ github.sha }}",
    ]);
    expect(
      text,
      `${SHARED} run-scopes something. The tags here are the release.`,
    ).not.toMatch(/github\.run_(?:id|attempt)/);
  });

  it("refuses an off-main release only when a caller asks it to", () => {
    // Both terms, in that order. Dropping the input term makes every caller
    // main-only — no release from a dispatch on a branch, which is how this
    // change was verified before it merged. Dropping the ref term makes the
    // guard fire on main and release nothing at all.
    const guard = (doc.jobs?.["build-and-push"]?.steps ?? []).find((s) =>
      String(s.run ?? "").includes("only releases from main"),
    );
    expect(guard, `${SHARED} has no off-main guard`).toBeDefined();
    expect(String(guard!.if)).toBe(
      "inputs.refuse-off-main && github.ref != 'refs/heads/main'",
    );
    expect(
      doc.on?.workflow_call as {
        inputs?: Record<string, { default?: unknown }>;
      },
    ).toMatchObject({
      inputs: { "refuse-off-main": { default: false } },
    });
  });
});
