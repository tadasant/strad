import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { parseConfig } from "../src/config/load.ts";
import { renderAppSpec, type ImageRef } from "../src/deploy/appspec.ts";
import {
  BUNDLE_IMAGE_SOURCE,
  BUNDLE_REHEAL_WORKFLOW,
  BUNDLE_RELEASE_WORKFLOW,
  isOutsidePathFilter,
  matchesPathFilter,
  mutableImageComponents,
  parsePathsFilter,
  releaseRunLookup,
  resolveDeployTag,
  type Candidate,
  type ReleaseRun,
} from "../src/deploy/imageTag.ts";

/**
 * The outage this file exists to prevent, stated once.
 *
 * On 2026-07-31 `POST /mcp?servers=secrets` on staging AND prod returned
 * `200 {"tools":[]}` for a slug whose server serves four tools with no
 * credential at all. It had never returned anything else in any window the
 * telemetry could see: `strad_mcp_upstream_errors_total{mcp_upstream_op=
 * "connect"}` equalled the request count exactly, for the whole 7-day retention.
 *
 * The bundle container was healthy and 32 hours old. Its own boot line said what
 * nothing else did:
 *
 *   streamable-HTTP on :8080 — 14 servers: /slack … /onepassword /good-eggs …
 *
 * Fourteen, not fifteen, with `/remote-filesystem` under the slug PR #33 had
 * renamed it away from on 2026-07-24 — and no `/secrets` at all. Core POSTed
 * `initialize` to `/secrets`, Express answered 404, `client.connect()` threw,
 * and `router.ts` turned a dead upstream into an empty tool list.
 *
 * The image was stale because the TAG was mutable. `strad-bundle:latest` is
 * written into all 25 `supplementary-image` entries, so the bundle components'
 * image block was byte-identical on every deploy and App Platform kept serving
 * the digest it had resolved once — `sha256:6bb4e861…` on every `main` deploy
 * for days, while `release-bundle-image.yml` pushed three fresh `:latest`
 * images that same day.
 *
 * So the deploy names a `sha-<commit>` bundle tag, exactly as it already did for
 * the core, and refuses to render a spec that ships a mutable one. What follows
 * pins both halves.
 */

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

const DEPLOY_WORKFLOW = ".github/workflows/deploy-staging.yml";

// ---------------------------------------------------------------------------
// the `paths:` filter, read from the workflow that owns it
// ---------------------------------------------------------------------------

describe("parsePathsFilter", () => {
  it("reads every tree release-bundle-image.yml watches", () => {
    const paths = parsePathsFilter(
      readFileSync(BUNDLE_RELEASE_WORKFLOW, "utf8"),
      BUNDLE_RELEASE_WORKFLOW,
    );
    // Guard the guard: a parse that silently returned two entries would make
    // every assertion below pass while classifying real bundle commits as
    // "could not have published an image" — which walks the deploy backwards.
    expect(paths.length).toBeGreaterThanOrEqual(8);
    expect(paths).toContain("servers/secrets/**");
    expect(paths).toContain("servers/bundle/**");
    expect(paths).toContain("images/bundle-google/**");
  });

  it("skips the comment block above the entries", () => {
    // That workflow's `paths:` is preceded by eight lines of comment explaining
    // why `servers/secrets/**` is on the list. A parser that took them for
    // entries would match nothing.
    const paths = parsePathsFilter(
      readFileSync(BUNDLE_RELEASE_WORKFLOW, "utf8"),
      BUNDLE_RELEASE_WORKFLOW,
    );
    expect(paths.some((p) => p.startsWith("#"))).toBe(false);
    expect(paths.every((p) => p.trim() === p && p !== "")).toBe(true);
  });

  it("stops at the end of the block rather than swallowing the next key", () => {
    const paths = parsePathsFilter(
      [
        "on:",
        "  push:",
        "    paths:",
        '      - "a/**"',
        "  workflow_dispatch:",
      ].join("\n"),
      "test",
    );
    expect(paths).toEqual(["a/**"]);
  });

  it("throws rather than returning a short list", () => {
    expect(() => parsePathsFilter("on:\n  push:\n", "test")).toThrow(
      /no `paths:` filter/,
    );
    expect(() => parsePathsFilter("paths:\nother:\n", "test")).toThrow(
      /parsed to nothing/,
    );
  });

  it("keeps reading past an entry that carries a trailing comment", () => {
    // The silent-truncation bug this parser is written to not have. Treating a
    // commented entry as "the block ended" drops every entry below it, and a
    // short filter reads as "this commit could not have published an image" —
    // walking the deploy back onto an older bundle.
    expect(
      parsePathsFilter(
        [
          "    paths:",
          '      - "servers/bundle/**" # the host',
          '      - "servers/secrets/**"',
          "  workflow_dispatch:",
        ].join("\n"),
        "test",
      ),
    ).toEqual(["servers/bundle/**", "servers/secrets/**"]);
  });

  it("THROWS on a list item it cannot read, rather than stopping there", () => {
    expect(() =>
      parsePathsFilter(
        ["    paths:", '      - "a/**"', "      - { weird: true }"].join("\n"),
        "test",
      ),
    ).toThrow(/cannot read `paths:` entry/);
  });

  it("reads a single-quoted or bare entry", () => {
    expect(
      parsePathsFilter(
        ["    paths:", "      - 'a/**'", "      - b/**"].join("\n"),
        "test",
      ),
    ).toEqual(["a/**", "b/**"]);
  });

  it("every pattern in the real workflow is one this can evaluate", () => {
    // The load-bearing pairing. `matchesPathFilter` understands `dir/**` and
    // literal paths; GitHub's syntax is larger. A pattern it cannot evaluate
    // must fail the deploy, not read as "no match" — so assert that today's
    // workflow contains none, and that this test breaks the day one is added.
    const paths = parsePathsFilter(
      readFileSync(BUNDLE_RELEASE_WORKFLOW, "utf8"),
      BUNDLE_RELEASE_WORKFLOW,
    );
    for (const pattern of paths) {
      expect(() =>
        matchesPathFilter("servers/secrets/x.ts", pattern),
      ).not.toThrow();
    }
  });
});

describe("matchesPathFilter", () => {
  it("matches a directory glob by prefix", () => {
    expect(
      matchesPathFilter(
        "servers/secrets/shared/src/tools.ts",
        "servers/secrets/**",
      ),
    ).toBe(true);
    expect(
      matchesPathFilter("servers/secrets-other/x.ts", "servers/secrets/**"),
    ).toBe(false);
  });

  it("matches a literal path exactly", () => {
    const p = ".github/workflows/release-bundle-image.yml";
    expect(matchesPathFilter(p, p)).toBe(true);
    expect(matchesPathFilter(".github/workflows/ci.yml", p)).toBe(false);
  });

  it("THROWS on a pattern it cannot evaluate, rather than saying no", () => {
    // Reading an unknown pattern as "no match" would classify a commit that DID
    // publish an image as one that could not have, and walk the deploy back onto
    // an older bundle — the failure in reverse.
    expect(() => matchesPathFilter("README.md", "**/*.md")).toThrow(
      /unsupported/,
    );
  });

  it("THROWS on a negation, which ends in /** and would look supported", () => {
    // `!servers/bundle/docs/**` takes the prefix branch and matches nothing, so
    // every commit reads as outside the filter. Checked before the shape tests
    // for exactly that reason.
    expect(() =>
      matchesPathFilter("servers/bundle/x.ts", "!servers/bundle/docs/**"),
    ).toThrow(/unsupported/);
  });
});

describe("isOutsidePathFilter", () => {
  const paths = [
    "servers/secrets/**",
    ".github/workflows/release-bundle-image.yml",
  ];

  it("says a commit that touched a baked tree is INSIDE", () => {
    expect(
      isOutsidePathFilter(["servers/secrets/shared/src/tools.ts"], paths),
    ).toBe(false);
  });

  it("says a commit that touched only the gateway is OUTSIDE", () => {
    // The normal case, and why the bundle walk-back is not an exception: most
    // commits on `main` cut no bundle image at all.
    expect(
      isOutsidePathFilter(["src/gateway/router.ts", "docs/x.md"], paths),
    ).toBe(true);
  });

  it("counts a commit that touched BOTH as inside", () => {
    expect(
      isOutsidePathFilter(
        ["src/gateway/router.ts", "servers/secrets/x.ts"],
        paths,
      ),
    ).toBe(false);
  });

  it("refuses to classify an EMPTY change list", () => {
    // Same guard `isDocsOnly` carries. `some` on an empty array is false, so a
    // naive implementation would report "outside" — licensing a walk past a
    // commit nothing could be determined about.
    expect(isOutsidePathFilter([], paths)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// the walk, with the bundle's rule
// ---------------------------------------------------------------------------

const outside = (sha: string): Candidate => ({
  sha,
  mayLackImage: vi.fn(() => true),
});
const baked = (sha: string): Candidate => ({
  sha,
  mayLackImage: vi.fn(() => false),
});

describe("resolveDeployTag, for the bundle", () => {
  it("walks back to the newest commit that touched a baked tree", async () => {
    // Exactly the shape of `main` on the day of the outage: HEAD (#72, gateway)
    // and its parent (#70, seed-store) cut no bundle image; #65 touched
    // servers/secrets and did.
    const published = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    await expect(
      resolveDeployTag([outside(A), outside(B), baked(C)], published, {
        source: BUNDLE_IMAGE_SOURCE,
      }),
    ).resolves.toEqual({ tag: `sha-${C}`, sha: C, distance: 2 });
  });

  it("HARD STOPS when a commit changed a baked tree and published nothing", async () => {
    // Merge a PR that touches servers/secrets, then deploy while
    // release-bundle-image.yml is still building. Walking back here would ship
    // the previous bundle against this commit's config — the same skew, and the
    // reason the walk is not simply "find any published ancestor".
    const published = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    await expect(
      resolveDeployTag([baked(A), baked(B)], published, {
        source: BUNDLE_IMAGE_SOURCE,
      }),
    ).rejects.toThrow(
      /changed a tree the bundle image bakes but published no image/,
    );
    expect(published).toHaveBeenCalledTimes(1);
  });

  it("sends the reader to the BUNDLE's workflow, not the core's", async () => {
    // A red deploy at 3am is worth exactly what its error message says. Naming
    // release-image.yml here would send someone to a workflow that was never
    // going to build this image.
    const published = vi.fn().mockResolvedValue(false);
    await expect(
      resolveDeployTag([baked(A)], published, { source: BUNDLE_IMAGE_SOURCE }),
    ).rejects.toThrow(/release-bundle-image\.yml[\s\S]*bundle_version/);
  });

  it("sends the reader to a DISPATCH, not to re-running the failed build", async () => {
    // On 2026-08-11 re-running was the one move that could not work. `450ad5cb`
    // broke the build-push action manifest, so all eight release workflows
    // failed; `6d2dd228` fixed the manifest but touched no baked tree, so no
    // bundle build fired, and `450ad5cb` stayed the newest commit owing a bundle
    // image — with every prod deploy hard-stopping here. A re-run replays
    // `450ad5cb` and its broken manifest forever. A dispatch on `main` publishes
    // HEAD, which is where the walk starts.
    //
    // The workflow name is asserted as the reader SEES it, so the interpolation
    // in BUNDLE_IMAGE_SOURCE.remedy has to render a real filename, not a path or
    // an `undefined`.
    const published = vi.fn().mockResolvedValue(false);
    const err = await resolveDeployTag([baked(A)], published, {
      source: BUNDLE_IMAGE_SOURCE,
    }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(
      /dispatch release-bundle-image\.yml on `main` if it FAILED/,
    );
  });

  it("says which workflow when the whole window published nothing", async () => {
    const published = vi.fn().mockResolvedValue(false);
    await expect(
      resolveDeployTag([outside(A), outside(B)], published, {
        source: BUNDLE_IMAGE_SOURCE,
      }),
    ).rejects.toThrow(/release-bundle-image\.yml/);
  });

  it("WAITS for a build that is still running, instead of failing the merge", async () => {
    // The regression this guards is one this change would otherwise introduce.
    // release-image.yml pushes the core and THEN calls the deploy, in one
    // workflow; release-bundle-image.yml is a separate trigger on the same push
    // and is still baking Chromium when that deploy starts. So on a merge that
    // touches a baked tree, sha-<HEAD> reliably does not exist yet — nine such
    // merges in the three weeks before this was written, every one of which a
    // bare hard stop would have turned red.
    const published = vi
      .fn()
      .mockResolvedValueOnce(false) // the deploy beats the bundle build
      .mockResolvedValueOnce(false) // still building
      .mockResolvedValueOnce(true); // pushed
    const sleep = vi.fn(async () => {});
    let clock = 0;
    await expect(
      resolveDeployTag([baked(A)], published, {
        source: BUNDLE_IMAGE_SOURCE,
        waitMs: 900_000,
        sleep,
        now: () => (clock += 20_000),
      }),
    ).resolves.toEqual({ tag: `sha-${A}`, sha: A, distance: 0 });
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("gives up when the wait runs out, and says it waited", async () => {
    const published = vi.fn().mockResolvedValue(false);
    let clock = 0;
    await expect(
      resolveDeployTag([baked(A)], published, {
        source: BUNDLE_IMAGE_SOURCE,
        waitMs: 60_000,
        sleep: async () => {},
        now: () => (clock += 20_000),
      }),
    ).rejects.toThrow(/none appeared in 60s of waiting/);
  });

  it("does not wait for a commit that legitimately has no image", async () => {
    // The wait exists for the race, not as a general retry. A commit outside the
    // filter is not owed an image, so the walk steps past it immediately —
    // spending 15 minutes per docs commit would make every deploy unusable.
    const published = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const sleep = vi.fn(async () => {});
    await expect(
      resolveDeployTag([outside(A), baked(B)], published, {
        source: BUNDLE_IMAGE_SOURCE,
        waitMs: 900_000,
        sleep,
      }),
    ).resolves.toEqual({ tag: `sha-${B}`, sha: B, distance: 1 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not wait at all by default, which is the core's posture", async () => {
    const published = vi.fn().mockResolvedValue(false);
    const sleep = vi.fn(async () => {});
    await expect(
      resolveDeployTag([baked(A)], published, { sleep }),
    ).rejects.toThrow(/probably still building it/);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("lets an unreadable registry through instead of spending the wait on it", async () => {
    // A rejecting probe is not an absent tag. Swallowing it here would turn one
    // bad GHCR minute into fifteen minutes of polling and then a misleading
    // "the build is slower than that".
    const published = vi.fn().mockRejectedValue(new Error("HTTP 503"));
    await expect(
      resolveDeployTag([baked(A)], published, {
        source: BUNDLE_IMAGE_SOURCE,
        waitMs: 900_000,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/HTTP 503/);
  });

  it("still defaults to the CORE's rule when no source is passed", async () => {
    const published = vi.fn().mockResolvedValue(false);
    await expect(resolveDeployTag([baked(A)], published)).rejects.toThrow(
      /changed code but published no image[\s\S]*release-image\.yml/,
    );
  });
});

// ---------------------------------------------------------------------------
// waiting for a build that is already dead
// ---------------------------------------------------------------------------

/**
 * The 16m51s failure of 2026-08-11, and what it cost.
 *
 * #127 put a `${{ … }}` expression inside the `description:` of an input in
 * `.github/actions/build-push/action.yml`. GitHub evaluates expressions in an
 * action manifest, so every workflow using that action died loading it —
 * including the bundle release for that same commit, which touched
 * release-bundle-image.yml and was therefore REQUIRED to publish an image.
 *
 * #129 fixed the manifest. It touched no tree the bundle bakes, so it published
 * no bundle image either — and from then on every deploy walked HEAD, stepped
 * past it, reached #127's commit, and waited 900 seconds for an image whose
 * build had failed fourteen minutes before the deploy even started. The error
 * it finally printed offered "wait for that build to finish, re-run it" — and a
 * re-run checks out the commit whose tree is the bug, so it fails identically,
 * forever.
 *
 * None of that is unknowable at the time. The run's state is one API call away.
 */
describe("resolveDeployTag, when the run that owes the image has concluded", () => {
  const RUN_URL = "https://github.com/tadasant/strad/actions/runs/31499320064";
  const run = (over: Partial<ReleaseRun> = {}): ReleaseRun => ({
    status: "completed",
    conclusion: "failure",
    url: RUN_URL,
    ...over,
  });

  it("fails at once rather than spending the wait on a dead build", async () => {
    const published = vi.fn().mockResolvedValue(false);
    const sleep = vi.fn(async () => {});
    await expect(
      resolveDeployTag([baked(A)], published, {
        source: BUNDLE_IMAGE_SOURCE,
        waitMs: 900_000,
        sleep,
        releaseRun: async () => run(),
      }),
    ).rejects.toThrow(/already CONCLUDED for it \(failure\)/);
    expect(sleep).not.toHaveBeenCalled();
    expect(published).toHaveBeenCalledTimes(1);
  });

  it("names the run, so the reader lands on the failure and not on this step", async () => {
    await expect(
      resolveDeployTag([baked(A)], vi.fn().mockResolvedValue(false), {
        source: BUNDLE_IMAGE_SOURCE,
        waitMs: 900_000,
        sleep: async () => {},
        releaseRun: async () => run(),
      }),
    ).rejects.toThrow(RUN_URL);
  });

  it("offers a remedy that works when the failure is IN that commit", async () => {
    // "Re-run it" is the wrong answer for the case that produced this: the
    // re-run rebuilds the same broken tree. Dispatching the release on `main`
    // publishes `sha-<HEAD>` and ends the walk before it reaches the commit.
    await expect(
      resolveDeployTag([baked(A)], vi.fn().mockResolvedValue(false), {
        source: BUNDLE_IMAGE_SOURCE,
        releaseRun: async () => run(),
      }),
    ).rejects.toThrow(/dispatch release-bundle-image\.yml on `main`/);
  });

  it("counts a SECOND cancelled attempt as dead too", async () => {
    // A first cancellation of a push build is held open for the self-heal (its
    // own describe below). A second one means that heal has spent its attempt,
    // so the run is as over as any failure.
    await expect(
      resolveDeployTag([baked(A)], vi.fn().mockResolvedValue(false), {
        source: BUNDLE_IMAGE_SOURCE,
        releaseRun: async () =>
          run({ conclusion: "cancelled", runAttempt: 2, event: "push" }),
      }),
    ).rejects.toThrow(/CONCLUDED for it \(cancelled\)/);
  });

  it("does NOT count a completed run whose conclusion has not settled", async () => {
    // `completed` can arrive before the conclusion does, and `null !==
    // "success"` would read that instant as failure — an unrecoverable stop
    // announced as "has already CONCLUDED (no conclusion)".
    const published = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    let clock = 0;
    await expect(
      resolveDeployTag([baked(A)], published, {
        source: BUNDLE_IMAGE_SOURCE,
        waitMs: 900_000,
        sleep: async () => {},
        now: () => (clock += 20_000),
        releaseRun: async () => run({ conclusion: null }),
      }),
    ).resolves.toEqual({ tag: `sha-${A}`, sha: A, distance: 0 });
  });

  it("tells someone with no run to publish one, not to wait for it", async () => {
    // `remedy` is "wait for that build to finish, re-run it" — advice about a
    // build that does not exist. The commit owes an image and the push that
    // would have started one is minutes old by the time this runs.
    await expect(
      resolveDeployTag([baked(A)], vi.fn().mockResolvedValue(false), {
        source: BUNDLE_IMAGE_SOURCE,
        releaseRun: async () => null,
      }),
    ).rejects.toThrow(/dispatch release-bundle-image\.yml on `main`/);
  });

  it("still waits while the build is actually running", async () => {
    // The whole reason the wait exists. A run in flight must not be confused
    // with a run that failed, or every merge touching a baked tree goes red.
    const published = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const sleep = vi.fn(async () => {});
    let clock = 0;
    await expect(
      resolveDeployTag([baked(A)], published, {
        source: BUNDLE_IMAGE_SOURCE,
        waitMs: 900_000,
        sleep,
        now: () => (clock += 20_000),
        releaseRun: async () =>
          run({ status: "in_progress", conclusion: null }),
      }),
    ).resolves.toEqual({ tag: `sha-${A}`, sha: A, distance: 0 });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("ends the wait the moment the running build dies", async () => {
    const releaseRun = vi
      .fn()
      .mockResolvedValueOnce(run({ status: "in_progress", conclusion: null }))
      .mockResolvedValue(run());
    let clock = 0;
    await expect(
      resolveDeployTag([baked(A)], vi.fn().mockResolvedValue(false), {
        source: BUNDLE_IMAGE_SOURCE,
        waitMs: 900_000,
        sleep: async () => {},
        now: () => (clock += 20_000),
        releaseRun,
      }),
    ).rejects.toThrow(/already CONCLUDED/);
    expect(releaseRun).toHaveBeenCalledTimes(2);
  });

  it("reports a run that succeeded and published nothing anyway", async () => {
    // Not a hard stop of its own — a tag can lag its push — but the run's state
    // belongs in the error either way. "It succeeded and the tag is absent" is
    // a different bug from "it never ran", and the message must not blur them.
    let clock = 0;
    await expect(
      resolveDeployTag([baked(A)], vi.fn().mockResolvedValue(false), {
        source: BUNDLE_IMAGE_SOURCE,
        waitMs: 60_000,
        sleep: async () => {},
        now: () => (clock += 20_000),
        releaseRun: async () => run({ conclusion: "success" }),
      }),
    ).rejects.toThrow(/Its run is completed \(success\): /);
  });

  it("says so when the workflow has no run for that commit at all", async () => {
    await expect(
      resolveDeployTag([baked(A)], vi.fn().mockResolvedValue(false), {
        source: BUNDLE_IMAGE_SOURCE,
        releaseRun: async () => null,
      }),
    ).rejects.toThrow(/has no run for that commit at all/);
  });

  it("asks nothing on a healthy walk", async () => {
    // One API call per deploy would be one more thing between a green merge and
    // a deployed image. This is diagnosis, and only a failing walk needs it.
    const releaseRun = vi.fn();
    const published = vi
      .fn()
      .mockResolvedValueOnce(false) // HEAD cut no bundle image, as usual
      .mockResolvedValueOnce(true); // its parent did
    await expect(
      resolveDeployTag([outside(A), baked(B)], published, {
        source: BUNDLE_IMAGE_SOURCE,
        releaseRun,
      }),
    ).resolves.toEqual({ tag: `sha-${B}`, sha: B, distance: 1 });
    expect(releaseRun).not.toHaveBeenCalled();
  });

  it("does not let an unreadable Actions API become the failure", async () => {
    // The diagnosis is not allowed to be the thing that breaks. A 403 on the
    // runs API must leave the walk exactly as it was — the same error, plus a
    // note about what could not be read.
    const releaseRun = vi.fn().mockRejectedValue(new Error("HTTP 403"));
    let clock = 0;
    await expect(
      resolveDeployTag([baked(A)], vi.fn().mockResolvedValue(false), {
        source: BUNDLE_IMAGE_SOURCE,
        waitMs: 60_000,
        sleep: async () => {},
        now: () => (clock += 20_000),
        releaseRun,
      }),
    ).rejects.toThrow(
      /none appeared in 60s[\s\S]*could not read[\s\S]*HTTP 403/,
    );
    // And it is asked ONCE, not on every poll for fifteen minutes.
    expect(releaseRun).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// waiting for a build that was interrupted
// ---------------------------------------------------------------------------

/**
 * 2026-09-04, and the difference between a verdict and an interruption.
 *
 * The self-hosted runner host restarted mid-build. `a278b5ed`'s bundle build
 * was cancelled 100 seconds in — three unrelated jobs on two other runners died
 * in the same second — and nothing was wrong with the commit at all. But the
 * walk read `cancelled` the way it reads `failure`, hard-stopped the staging
 * deploy nine minutes later, and left `main` undeployable until a human re-ran
 * the build by hand.
 *
 * `reheal-bundle-image.yml` now re-runs that first cancellation on its own. The
 * walk has to meet it halfway: a deploy already inside its fifteen-minute wait
 * polls every twenty seconds, so it would otherwise reach the cancellation and
 * stop in the minute before the re-run it is waiting for even starts.
 */
describe("resolveDeployTag, when the run that owes the image was interrupted", () => {
  const RUN_URL = "https://github.com/tadasant/strad/actions/runs/33845688614";
  const cancelled = (over: Partial<ReleaseRun> = {}): ReleaseRun => ({
    status: "completed",
    conclusion: "cancelled",
    runAttempt: 1,
    event: "push",
    url: RUN_URL,
    ...over,
  });
  const live = (): ReleaseRun => ({
    status: "in_progress",
    conclusion: null,
    runAttempt: 2,
    event: "push",
    url: RUN_URL,
  });

  it("keeps waiting through a FIRST cancellation, and takes the re-run's image", async () => {
    const published = vi
      .fn()
      .mockResolvedValueOnce(false) // cancelled mid-build
      .mockResolvedValueOnce(false) // the self-heal has re-run it
      .mockResolvedValueOnce(true); // and it landed
    const releaseRun = vi
      .fn()
      .mockResolvedValueOnce(cancelled())
      .mockResolvedValue(live());
    let clock = 0;
    await expect(
      resolveDeployTag([baked(A)], published, {
        source: BUNDLE_IMAGE_SOURCE,
        waitMs: 900_000,
        sleep: async () => {},
        now: () => (clock += 20_000),
        releaseRun,
      }),
    ).resolves.toEqual({ tag: `sha-${A}`, sha: A, distance: 0 });
  });

  it("stops at once on a cancellation the self-heal has already spent", async () => {
    // Attempt 2 cancelled again is a CI host that is not healthy, and burning
    // the budget on it buys the same error fifteen minutes later.
    const sleep = vi.fn(async () => {});
    await expect(
      resolveDeployTag([baked(A)], vi.fn().mockResolvedValue(false), {
        source: BUNDLE_IMAGE_SOURCE,
        waitMs: 900_000,
        sleep,
        releaseRun: async () => cancelled({ runAttempt: 2 }),
      }),
    ).rejects.toThrow(/CANCELLED, not failed[\s\S]*re-run it/);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops at once on a DISPATCHED build, which the listener declines to heal", async () => {
    // reheal-bundle-image.yml will not re-run a workflow_dispatch build — a
    // human may have stopped that one on purpose. A walk that could not see the
    // difference would spend 900 seconds on a build nothing is bringing back,
    // which is worse than the hard stop it replaced.
    const sleep = vi.fn(async () => {});
    await expect(
      resolveDeployTag([baked(A)], vi.fn().mockResolvedValue(false), {
        source: BUNDLE_IMAGE_SOURCE,
        waitMs: 900_000,
        sleep,
        releaseRun: async () => cancelled({ event: "workflow_dispatch" }),
      }),
    ).rejects.toThrow(/CONCLUDED for it \(cancelled\)/);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("wants POSITIVE evidence: an attempt or an event it could not read is no heal", async () => {
    // `releaseRunLookup` passes both fields through rather than defaulting
    // them, so an API that stopped reporting one must not manufacture a wait
    // for a listener whose own `if:` would read the same absence as "decline".
    const sleep = vi.fn(async () => {});
    for (const over of [{ runAttempt: undefined }, { event: undefined }]) {
      await expect(
        resolveDeployTag([baked(A)], vi.fn().mockResolvedValue(false), {
          source: BUNDLE_IMAGE_SOURCE,
          waitMs: 900_000,
          sleep,
          releaseRun: async () => cancelled(over),
        }),
      ).rejects.toThrow(/CONCLUDED for it \(cancelled\)/);
    }
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not promise the CORE a self-heal that does not watch it", async () => {
    // reheal-bundle-image.yml listens to `Release bundle image` and nothing
    // else, so a cancelled `release-image.yml` run gets the re-run advice
    // WITHOUT a listener's name, and no wait at all.
    const sleep = vi.fn(async () => {});
    const err: unknown = await resolveDeployTag(
      [{ sha: A, mayLackImage: () => false }],
      vi.fn().mockResolvedValue(false),
      { waitMs: 900_000, sleep, releaseRun: async () => cancelled() },
    ).then(
      () => new Error("resolved, but the walk should have stopped"),
      (e: unknown) => e,
    );
    expect((err as Error).message).toMatch(/CANCELLED, not failed/);
    expect((err as Error).message).not.toMatch(/reheal-bundle-image\.yml/);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("says re-run, not dispatch, when the run was cancelled", async () => {
    // `republish` exists for a build the COMMIT broke, where a re-run is the
    // loop. Printing it here sends a reader past the one move that works.
    const err: unknown = await resolveDeployTag(
      [baked(A)],
      vi.fn().mockResolvedValue(false),
      {
        source: BUNDLE_IMAGE_SOURCE,
        releaseRun: async () => cancelled({ runAttempt: 2 }),
      },
    ).then(
      () => new Error("resolved, but the walk should have stopped"),
      (e: unknown) => e,
    );
    expect((err as Error).message).toMatch(/CANCELLED, not failed/);
    expect((err as Error).message).not.toMatch(
      /dispatch release-bundle-image\.yml on `main`/,
    );
  });

  it("names the interruption when the budget runs out on a first cancellation", async () => {
    // The heal did not fire. "is slower than that, or it failed" would be two
    // wrong guesses about a run whose state the step has just read.
    let clock = 0;
    await expect(
      resolveDeployTag([baked(A)], vi.fn().mockResolvedValue(false), {
        source: BUNDLE_IMAGE_SOURCE,
        waitMs: 60_000,
        sleep: async () => {},
        now: () => (clock += 20_000),
        releaseRun: async () => cancelled(),
      }),
    ).rejects.toThrow(
      /none appeared in 60s of waiting\. \S*release-bundle-image\.yml was interrupted before it could publish it[\s\S]*CANCELLED, not failed[\s\S]*re-run it/,
    );
  });
});

// ---------------------------------------------------------------------------
// the two halves of the self-heal, pinned to each other
// ---------------------------------------------------------------------------

/**
 * `reheal-bundle-image.yml` selects its trigger by workflow NAME, not filename,
 * and `deadRun` holds a deploy's wait open on the promise that it fires. So a
 * rename of `release-bundle-image.yml`'s `name:` would disable the heal
 * silently — and the only symptom would be the wedge this PR removed, now
 * arriving 900 seconds later than it used to.
 *
 * The guards are pinned for the same reason from the other side: `healIsComing`
 * restates all three, and a guard relaxed here without the walk being told
 * would have the walk wait on a run the listener declines.
 */
describe("reheal-bundle-image.yml, against the release it heals", () => {
  const reheal = parse(readFileSync(BUNDLE_REHEAL_WORKFLOW, "utf8")) as {
    on: { workflow_run: { workflows: string[]; types: string[] } };
    permissions: Record<string, string>;
    jobs: Record<string, { "runs-on": string; if: string }>;
  };
  const release = parse(readFileSync(BUNDLE_RELEASE_WORKFLOW, "utf8")) as {
    name: string;
  };

  it("listens for the release workflow's own `name:`", () => {
    expect(reheal.on.workflow_run.workflows).toEqual([release.name]);
    expect(reheal.on.workflow_run.types).toEqual(["completed"]);
  });

  it("carries the three guards `healIsComing` assumes", () => {
    const condition = reheal.jobs.rerun?.if ?? "";
    expect(condition).toContain(
      "github.event.workflow_run.conclusion == 'cancelled'",
    );
    expect(condition).toContain("github.event.workflow_run.run_attempt == 1");
    expect(condition).toContain("github.event.workflow_run.event == 'push'");
  });

  it("holds `actions: write` and nothing else, and runs off the self-hosted box", () => {
    // `actions: write` is what POST /actions/runs/:id/rerun needs. ubuntu-latest
    // is the point: the self-hosted runners going down is the event it heals.
    expect(reheal.permissions).toEqual({ actions: "write" });
    expect(reheal.jobs.rerun?.["runs-on"]).toBe("ubuntu-latest");
  });
});

describe("releaseRunLookup", () => {
  const okJson = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it("asks the SOURCE repo's workflow about that commit", async () => {
    // The image lives in tadasant/strad-bundle and the runs live in
    // tadasant/strad. Asking the package's name for workflow runs 404s.
    const fetchImpl = vi.fn(async (_url: string) =>
      okJson({ workflow_runs: [] }),
    );
    await releaseRunLookup({
      repository: "tadasant/strad",
      workflow: BUNDLE_RELEASE_WORKFLOW,
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })(A);
    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url).toContain(
      "/repos/tadasant/strad/actions/workflows/release-bundle-image.yml/runs",
    );
    expect(url).toContain(`head_sha=${A}`);
  });

  it("prefers a LIVE run over a concluded one, whatever the timestamps say", async () => {
    // Re-running a workflow adds an attempt to the existing run rather than
    // creating a second one, so `created_at` stays at the original push — while
    // a `workflow_dispatch` for the same sha IS a separate run. Newest-wins
    // would therefore report the failed dispatch over the restarted push and
    // hard-stop a deploy whose image is actively building.
    const fetchImpl = vi.fn(async () =>
      okJson({
        workflow_runs: [
          {
            status: "completed",
            conclusion: "failure",
            html_url: "the-dispatch-that-died",
            created_at: "2026-08-11T15:30:00Z", // NEWER
          },
          {
            status: "in_progress",
            conclusion: null,
            run_attempt: 2,
            event: "push",
            html_url: "the-push-that-is-building",
            created_at: "2026-08-11T14:01:45Z", // older
          },
        ],
      }),
    );
    await expect(
      releaseRunLookup({
        repository: "tadasant/strad",
        workflow: BUNDLE_RELEASE_WORKFLOW,
        token: "t",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })(A),
    ).resolves.toEqual({
      status: "in_progress",
      conclusion: null,
      runAttempt: 2,
      event: "push",
      url: "the-push-that-is-building",
    });
  });

  it("takes the newest of several concluded runs when none is live", async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        workflow_runs: [
          {
            status: "completed",
            conclusion: "failure",
            html_url: "old",
            created_at: "2026-08-11T14:01:45Z",
          },
          {
            status: "completed",
            conclusion: "success",
            run_attempt: 1,
            event: "push",
            html_url: "new",
            created_at: "2026-08-11T15:30:00Z",
          },
        ],
      }),
    );
    await expect(
      releaseRunLookup({
        repository: "tadasant/strad",
        workflow: BUNDLE_RELEASE_WORKFLOW,
        token: "t",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })(A),
    ).resolves.toEqual({
      status: "completed",
      conclusion: "success",
      runAttempt: 1,
      event: "push",
      url: "new",
    });
  });

  it("returns null when the workflow never ran for that commit", async () => {
    const fetchImpl = vi.fn(async () => okJson({ workflow_runs: [] }));
    await expect(
      releaseRunLookup({
        repository: "tadasant/strad",
        workflow: BUNDLE_RELEASE_WORKFLOW,
        token: "t",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })(A),
    ).resolves.toBeNull();
  });

  it("throws rather than inventing a state it could not read", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 403 }));
    await expect(
      releaseRunLookup({
        repository: "tadasant/strad",
        workflow: BUNDLE_RELEASE_WORKFLOW,
        token: "t",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })(A),
    ).rejects.toThrow(/HTTP 403/);
  });
});

// ---------------------------------------------------------------------------
// the spec-level gate
// ---------------------------------------------------------------------------

describe("mutableImageComponents", () => {
  it("names every component shipping a tag that moves", () => {
    expect(
      mutableImageComponents([
        {
          name: "core",
          image: { registry: "tadasant", repository: "strad", tag: "0.1.47" },
        },
        {
          name: "bundle",
          image: {
            registry: "tadasant",
            repository: "strad-bundle",
            tag: "latest",
          },
        },
        {
          name: "bundle-zimmer-secrets",
          image: {
            registry: "tadasant",
            repository: "strad-bundle",
            tag: "LATEST",
          },
        },
      ]),
    ).toEqual([
      {
        component: "bundle",
        ref: "tadasant/strad-bundle:latest",
        tag: "latest",
      },
      {
        component: "bundle-zimmer-secrets",
        ref: "tadasant/strad-bundle:LATEST",
        tag: "LATEST",
      },
    ]);
  });

  it("reads a MISSING tag as latest, because every registry does", () => {
    expect(
      mutableImageComponents([
        { name: "bundle", image: { repository: "strad-bundle" } },
      ]),
    ).toEqual([
      { component: "bundle", ref: "strad-bundle:latest", tag: "latest" },
    ]);
  });

  it("passes a spec whose every component names one build", () => {
    expect(
      mutableImageComponents([
        { name: "core", image: { repository: "strad", tag: "sha-abc" } },
        {
          name: "bundle",
          image: { repository: "strad-bundle", tag: `sha-${A}` },
        },
      ]),
    ).toEqual([]);
  });

  it("ignores a component with no image block at all", () => {
    expect(mutableImageComponents([{ name: "core" }])).toEqual([]);
  });
});

const CORE: ImageRef = {
  registry_type: "GHCR",
  registry: "tadasant",
  repository: "strad",
  tag: "sha-abc",
};

/** Two bundles on the one image, as staging has since zimmer-secrets landed. */
const CONFIG = `
version: 1
gateway:
  name: strad
  env: staging
  publicUrl: https://staging.strad.tadasant.com
auth:
  staticTokens: { enabled: true, store: env }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle
  - name: bundle-zimmer-secrets
servers:
  - slug: secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /secrets
    entitlements: [admin]
  - slug: zimmer-secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle-zimmer-secrets
    path: /secrets
    entitlements: [admin]
`;

const render = (...supplementaryImages: string[]) =>
  renderAppSpec({
    config: parseConfig(CONFIG),
    appName: "strad-staging",
    region: "nyc",
    image: CORE,
    env: [],
    supplementaryImages,
  });

describe("the rendered staging spec", () => {
  it("ships mutable tags on BOTH bundles when the deploy names no image", () => {
    // The state staging was actually in. Both components, both stuck on a digest
    // App Platform resolved once — which is why `zimmer-secrets`, on its own
    // container, was dead in exactly the same way.
    expect(
      mutableImageComponents(render().services).map((m) => m.component),
    ).toEqual(["bundle", "bundle-zimmer-secrets"]);
  });

  it("ships none once --bundle-image names a commit", () => {
    expect(
      mutableImageComponents(
        render(`ghcr.io/tadasant/strad-bundle:sha-${A}`).services,
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the deploy actually asks for it
// ---------------------------------------------------------------------------

/**
 * Read as TEXT, like `test/bundle-release-paths.test.ts` reads the release
 * workflow. Every unit above can pass while the deploy still hands App Platform
 * `:latest` — the fix is not the resolver, it is the deploy CALLING it. That is
 * the line worth pinning.
 */
/**
 * The top-level `permissions:` block of a workflow, as a list of its entries.
 *
 * Read as a block rather than grepped: `actions: read` appearing anywhere in a
 * 900-line file — in a job's own block, in a comment — says nothing about what
 * the workflow grants, and a test that accepts it is a test that passes after
 * the grant is deleted.
 */
function workflowPermissions(workflow: string): string[] {
  const lines = workflow.split("\n");
  const start = lines.indexOf("permissions:");
  expect(start).toBeGreaterThan(-1);
  const entries: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!/^ {2}\S/.test(line)) break;
    entries.push(line.trim());
  }
  return entries;
}

describe("deploy-staging.yml", () => {
  const workflow = readFileSync(DEPLOY_WORKFLOW, "utf8");

  it("resolves a bundle tag with the bundle's rule", () => {
    expect(workflow).toMatch(/resolve-image-tag\.ts[\s\S]{0,200}--kind bundle/);
  });

  it("passes the resolved bundle image to render-spec on every deploy", () => {
    expect(workflow).toContain('--bundle-image "$BUNDLE_IMAGE"');
    expect(workflow).toContain("steps.bundletag.outputs.image");
  });

  it("demands immutable images rather than warning about them", () => {
    expect(workflow).toContain("--require-immutable-images");
  });

  it("waits for a bundle build the core's release outran, on main only", () => {
    expect(workflow).toMatch(
      /--kind bundle[\s\S]{0,80}--wait-for-image "\$WAIT"/,
    );
    // Both release workflows refuse to run off `main`, so a branch commit inside
    // the filter has no build coming and waiting for one is dead runner time.
    expect(workflow).toMatch(
      /WAIT: \$\{\{ github\.ref == 'refs\/heads\/main' && '\d+' \|\| '0' \}\}/,
    );
  });

  it("gives the tag steps a token that can read Actions", () => {
    // GHCR_PULL_TOKEN is package-scoped: it reads the registry and nothing
    // else. Without the job's own token the resolver silently drops back to
    // "wait the full budget and guess", which is the behaviour that cost 16m51s
    // on a build that had already failed.
    for (const id of ["id: coretag", "id: bundletag"]) {
      const step = workflow.slice(
        workflow.indexOf(id),
        workflow.indexOf("run: |", workflow.indexOf(id)),
      );
      expect(step).toContain("GITHUB_TOKEN: ${{ github.token }}");
    }
    expect(workflowPermissions(workflow)).toContain("actions: read");
  });

  // The other half of that grant — that whatever CALLS this workflow passes
  // `actions: read` down — lives in test/staging-on-demand.test.ts, over every
  // caller there is rather than over release-image.yml by name. Staging is on
  // demand now, so today there is no caller at all: the release path stopped
  // deploying it, and a test naming that one file would have had to be deleted
  // rather than kept honest.

  it("installs doctl after the secrets read and before anything that can fail", () => {
    // "Dump the failing container's logs" runs on `failure()` from the secrets
    // read onward. Installing doctl after the tag and render steps left every
    // failure before the deploy with nothing to dump WITH — and the dump said
    // "no strad-staging app" rather than admitting it had not looked.
    //
    // The lower bound matters as much as the upper one: the install's `if:`
    // reads `steps.secrets.outputs.ready`, which is the empty string for a step
    // that has not run yet, so ordering it FIRST would silently skip it.
    const doctl = workflow.indexOf("uses: digitalocean/action-doctl@v2");
    expect(workflow.indexOf("id: secrets")).toBeLessThan(doctl);
    expect(doctl).toBeLessThan(workflow.indexOf("id: coretag"));
  });

  it("makes the log dump admit when it cannot ask", () => {
    const dump = workflow.slice(workflow.indexOf("Dump the failing container"));
    expect(dump).toContain("command -v doctl");
    expect(dump).toMatch(/doctl apps list failed/);
  });

  it("resolves the bundle even when `version` pins the core", () => {
    // `version` pins the CORE. Skipping the bundle resolve on it would hand the
    // bundle back to the config's `:latest` for every rollback — the exact
    // failure, reintroduced on the one path taken under pressure.
    const step = workflow.slice(
      workflow.indexOf("id: bundletag") - 2000,
      workflow.indexOf("id: bundletag"),
    );
    const condition = step.slice(step.lastIndexOf("if: "));
    expect(condition).toContain("!inputs.bundle_version");
    expect(condition).not.toContain("!inputs.version");
  });

  it("has no `latest` fallback left for the bundle", () => {
    // The whole bug in one line: `BUNDLE_IMAGE: … || ''` let the config's
    // `image: …strad-bundle:latest` stand, and App Platform served whatever it
    // had cached for that tag.
    expect(workflow).not.toMatch(/BUNDLE_IMAGE:.*\|\|\s*''/);
  });
});
