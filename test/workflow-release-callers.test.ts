import { existsSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
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
 * `release-supplementary-image.yml` holds the build. A caller is a `paths:`
 * filter, a concurrency group and a `uses:` — which tree cuts an image and which
 * package it lands in. Sharing the body is the right trade and it moves the
 * failure mode rather than removing it: four near-identical short files made
 * from each other by substitution have one failure mode left, and it is a
 * substitution that was not made.
 *
 * So every assertion here is a value that would be WRONG rather than absent,
 * because nothing fails at the point of that kind of mistake:
 *
 *   - a `context:` and an `image:` that name different servers — the sharpest
 *     one, and doubly silent: the server whose tree changed never publishes
 *     again, and some OTHER component's `:latest` is overwritten with an image
 *     it is not. App Platform pulls it and nothing errors.
 *   - the wrong `paths:` tree — a server whose changes cut no image, which is
 *     the silent failure `test/bundle-release-paths.test.ts` exists for one
 *     workflow over: merged, green, and not running.
 *   - a missing `branches: [main]` — `.github/actions/build-push` suppresses a
 *     pull request and nothing else, so a branch push would move `:latest`.
 *   - a shared `concurrency:` group — two unrelated images queued behind each
 *     other, which looks like a slow runner.
 *   - an `image:` carrying a tag — `…:latest:latest`, which fails at the push.
 *
 * And one that belongs to the delegation itself: the shared body is in no
 * caller's `paths:` unless a caller names it, so its first execution would be on
 * whatever unrelated commit next touched one of these trees. That is the gap
 * #134 was filed about, and a shared body is exactly where it would reopen.
 */

const SHARED = ".github/workflows/release-supplementary-image.yml";

interface Caller {
  file: string;
  job: string;
  body: Job;
  paths: string[];
  branches: string[] | undefined;
  group: string | undefined;
  with: Record<string, unknown>;
}

function callers(): Caller[] {
  const out: Caller[] = [];
  for (const file of workflowFiles()) {
    const doc = workflow(file);
    for (const [job, body] of Object.entries(doc.jobs ?? {})) {
      if (calledWorkflow(body.uses) !== SHARED) continue;
      const push = doc.on?.push as
        { paths?: string[]; branches?: string[] } | undefined;
      const concurrency = (
        doc as unknown as { concurrency?: { group?: string } }
      ).concurrency;
      out.push({
        file,
        job,
        body,
        paths: push?.paths ?? [],
        branches: push?.branches,
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
    // so `packages: write` withheld here is a 403 on the push, and no
    // permission on the other side can put it back.
    //
    // A job-level block REPLACES the workflow-level one rather than merging
    // with it, so the job's is the whole answer wherever it exists. Reading the
    // workflow level first and stopping there would pass a caller whose job
    // block had been trimmed to `contents: read` by a least-privilege sweep —
    // which is the shape this is most likely to arrive in, since the callee
    // declares permissions of its own and looks like it is covered.
    const doc = workflow(c.file);
    const jobPerms =
      typeof c.body.permissions === "object" ? c.body.permissions : undefined;
    const granted = jobPerms
      ? jobPerms.packages
      : typeof doc.permissions === "object"
        ? doc.permissions?.packages
        : undefined;
    expect(
      granted,
      `${c.file} (${c.job}) does not grant \`packages: write\` on the block ` +
        `that decides this job's token, so the shared body cannot push ` +
        `whatever it declares for itself.`,
    ).toBe("write");
  });

  it.each(found)("$file publishes the tree it builds", (c) => {
    // The substitution that is wrong rather than missing, and the worst of
    // them. A caller pointed at one tree and another tree's package updates
    // NEITHER correctly: the server whose code changed never publishes again,
    // and the other server's `:latest` is replaced by an image that is not it —
    // which App Platform then pulls, and nothing errors anywhere.
    //
    // The tree is the Dockerfile's directory when a caller names one, because
    // that is the caller whose `context:` is the repo root.
    const file = c.with.file as string | undefined;
    const tree = file ? dirname(file) : (c.with.context as string);
    const pkg = (c.with.image as string).split("/").pop()!;

    expect(
      pkg,
      `${c.file} builds \`${tree}\` and publishes \`${pkg}\`, which is some ` +
        `other server's package. That overwrites ITS \`:latest\` with this ` +
        `image and stops publishing this one — both silently.`,
    ).toMatch(new RegExp(`(?:^|-)${basename(tree)}$`));
  });

  it.each(found)("$file releases from main and nowhere else", (c) => {
    // `.github/actions/build-push` folds the event name in and suppresses a
    // pull request. It does not suppress a push to a branch, and nothing else
    // does either — so a caller without this filter moves `:latest` from any
    // branch whose commit touches its tree.
    expect(
      c.branches,
      `${c.file} does not restrict its \`push:\` trigger to main, so a ` +
        `feature branch touching \`${c.with.context}\` publishes over the ` +
        `tag a deployment pulls.`,
    ).toEqual(["main"]);
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

  it("scopes the buildx cache only when a caller asks it to", () => {
    // Every caller here leaves `cache-scope` empty, and that branch is the one
    // a real release has executed — `--cache-from type=gha --cache-to
    // type=gha,mode=max`, which is what these images built with before the body
    // was shared. The NON-empty branch has no caller yet and is what
    // release-bundle-image.yml needs, so the expression is asserted rather than
    // left for its first execution to be a release.
    //
    // `format()` can never return the empty string, so the falsy-middle trap in
    // GitHub's `a && b || c` does not apply: the middle term is `,scope=<x>`.
    const build = (doc.jobs?.["build-and-push"]?.steps ?? []).find(
      (s) => s.uses === "./.github/actions/build-push",
    );
    const scope =
      "${{ inputs.cache-scope != '' && format(',scope={0}', inputs.cache-scope) || '' }}";

    expect(build?.with?.["cache-from"]).toBe(`type=gha${scope}`);
    expect(build?.with?.["cache-to"]).toBe(`type=gha,mode=max${scope}`);
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
