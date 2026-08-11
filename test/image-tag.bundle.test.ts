import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { renderAppSpec, type ImageRef } from "../src/deploy/appspec.ts";
import {
  BUNDLE_IMAGE_SOURCE,
  BUNDLE_RELEASE_WORKFLOW,
  isOutsidePathFilter,
  matchesPathFilter,
  mutableImageComponents,
  parsePathsFilter,
  resolveDeployTag,
  type Candidate,
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
    // The remedy this replaced said "re-run it", and on 2026-08-11 that was the
    // one move that could not work. `450ad5cb` broke the build-push action
    // manifest, so every release workflow died at load; `6d2dd228` fixed the
    // manifest but touched no baked tree, so nothing rebuilt, and `450ad5cb`
    // stayed the newest commit that owed a bundle image — with every prod
    // deploy hard-stopping here. A re-run replays `450ad5cb` and its broken
    // manifest forever. A dispatch on `main` publishes HEAD, which is where the
    // walk starts.
    const published = vi.fn().mockResolvedValue(false);
    const err = await resolveDeployTag([baked(A)], published, {
      source: BUNDLE_IMAGE_SOURCE,
    }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toMatch(/dispatch release-bundle-image\.yml on `main`/);
    expect(message).not.toMatch(/re-run it/);
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

const render = (supplementaryImage?: string) =>
  renderAppSpec({
    config: parseConfig(CONFIG),
    appName: "strad-staging",
    region: "nyc",
    image: CORE,
    env: [],
    supplementaryImage,
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
