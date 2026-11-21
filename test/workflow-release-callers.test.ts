import { existsSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { describe, expect, it } from "vitest";

import { BUNDLE_RELEASE_WORKFLOW } from "../src/deploy/imageTag.ts";
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
 * failure mode rather than removing it: five near-identical short files made
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
 *
 * The last describe in this file is the bundle caller on its own. It is the one
 * of the five that is not near-identical to the others — repo-root context, a
 * named Dockerfile, its own cache scope, the off-main guard switched on — and
 * the one whose substitutions are unrecoverable rather than merely wrong.
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

/**
 * The tree a caller's image IS — the directory that identifies it.
 *
 * `context:` is that directory for a one-tree image, and is not for the bundle:
 * its context is the REPO ROOT, because its Dockerfile `COPY`s from twenty-eight
 * trees, so `${context}/**` would be `.//**` and name nothing. The Dockerfile's
 * own directory is the answer in both shapes, and a caller that names no `file:`
 * is building the context's own.
 *
 * Watching that one tree is the floor, not the whole rule, for a caller that
 * builds from the root: the bundle's twenty-eight are compared against the
 * Dockerfile's `COPY` stages by `test/bundle-release-paths.test.ts`, which is
 * the guard that would notice a twenty-ninth tree added and not watched.
 */
function builtTree(c: Caller): string {
  const file = c.with.file as string | undefined;
  return file ? dirname(file) : (c.with.context as string);
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
    expect(found.length).toBeGreaterThanOrEqual(5);
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

    const tree = builtTree(c);
    expect(
      c.paths,
      `${c.file} builds \`${tree}\` and does not watch it, so a change ` +
        `there merges and cuts no image — green, and still running the old ` +
        `code.`,
    ).toContain(`${tree}/**`);
  });

  it.each(found)("$file names a Dockerfile that is there", (c) => {
    // Only a caller that names one: for the rest the context's own `Dockerfile`
    // is the default, and a context with none fails loudly at the build.
    const file = c.with.file as string | undefined;
    if (file === undefined) return;
    expect(
      existsSync(file),
      `${c.file} passes \`file: ${file}\`, which is not a file in this repo.`,
    ).toBe(true);
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
        `\`${builtTree(c)}\`. That is exactly the "release path has no ` +
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
    const tree = builtTree(c);
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
        `feature branch touching \`${builtTree(c)}\` publishes over the ` +
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
    // Both branches have a caller, and neither is asserted by having run. The
    // four one-tree images leave `cache-scope` empty and take `--cache-from
    // type=gha --cache-to type=gha,mode=max`; release-bundle-image.yml passes
    // `bundle` and takes `,scope=bundle`, because one build of twenty-eight trees
    // and a Chromium evicts the other four out of a shared scope. The release
    // path has no pre-merge execution (#134), so the expression is pinned here
    // rather than read for the first time by a real release.
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

/**
 * The bundle caller, which is the one whose mistakes are not recoverable.
 *
 * Every assertion above holds over all five callers. These four hold over one,
 * and they are here because the bundle is the image whose absence cannot heal
 * itself: its release is `paths:`-filtered, so the commit that owes an image
 * stays the newest commit owing one forever, and every staging deploy from then
 * on hard-stops. The four supplementary images have no such property — the next
 * push to their tree republishes.
 *
 * Three of the shared body's five inputs exist for this caller alone, and all
 * three fail SILENTLY if they are dropped from it:
 *
 *   - `refuse-off-main:` defaults to FALSE. Dropped, a `workflow_dispatch` on a
 *     branch publishes that branch's bundle to `:latest` — the tag live staging
 *     tracks — and nothing errors. The guard is in the body; whether it applies
 *     is written here.
 *   - `cache-scope:` defaults to the SHARED gha scope. Dropped, this build —
 *     twenty-eight trees and a Chromium — evicts every one-tree image out of it, and
 *     the symptom is four unrelated releases that got slower.
 *   - `file:` defaults to the context's own `Dockerfile`. Dropped, with a
 *     repo-root context, the build reads `./Dockerfile` — the CORE image's — and
 *     publishes it as `strad-bundle`. App Platform pulls it, every mount 404s,
 *     and `tools/list` comes back empty.
 *
 * The release path has no pre-merge execution (#134), so its first run is a real
 * release. That is what these are instead.
 */
describe("the bundle caller", () => {
  const bundle = callers().find((c) => c.file === BUNDLE_RELEASE_WORKFLOW);

  it("is a caller of the shared body at all", () => {
    // Named from `src/deploy/imageTag.ts` rather than spelled here: that
    // constant is what the deploy's tag walk reads the `paths:` filter out of,
    // so the two cannot drift apart into a test that asserts over `undefined`.
    expect(
      bundle,
      `${BUNDLE_RELEASE_WORKFLOW} does not call ${SHARED}, so every ` +
        `assertion below is vacuous.`,
    ).toBeDefined();
  });

  it("refuses to release from anything but main", () => {
    expect(
      bundle!.with["refuse-off-main"],
      `${BUNDLE_RELEASE_WORKFLOW} does not ask for the off-main guard, which ` +
        `is off by default — so a dispatch on a branch moves the \`:latest\` ` +
        `tag live staging tracks.`,
    ).toBe(true);
  });

  it("keeps a buildx cache scope of its own", () => {
    expect(
      bundle!.with["cache-scope"],
      `${BUNDLE_RELEASE_WORKFLOW} shares the default gha cache scope with ` +
        `every one-tree image, which this build is large enough to evict.`,
    ).toBe("bundle");
  });

  it("builds the bundle's Dockerfile from the repo root", () => {
    // Both halves, because each is wrong on its own: the root context without
    // this Dockerfile is the core image published under the bundle's name, and
    // this Dockerfile without the root context cannot COPY the thirteen trees
    // that live outside `servers/bundle`.
    expect(bundle!.with.context).toBe(".");
    expect(bundle!.with.file).toBe("servers/bundle/Dockerfile");
    expect(bundle!.with.image).toBe("ghcr.io/tadasant/strad-bundle");
  });
});
