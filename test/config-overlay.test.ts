import { describe, expect, it } from "vitest";
import { configDocument, parseYamlDocument } from "../src/config/load.ts";
import {
  EMPTY_OVERLAY,
  SlugCollision,
  assertNoCollision,
  withRestore,
  ImmutableFieldChanged,
  MAX_OVERLAY_BYTES,
  NotRuntimeCreatable,
  assertCreatable,
  assertEditable,
  fileSlugs,
  mergeOverlay,
  overlayPath,
  parseOverlay,
  rawEntry,
  serialiseOverlay,
  sourcesFor,
  validateMerged,
  withRemoval,
  withUpsert,
  type ServerOverlay,
} from "../src/config/overlay.ts";
import { SLUG_PATTERN, StradConfig } from "../src/config/schema.ts";

/**
 * The overlay is the only thing in strad that can change the server roster
 * without a deploy, so what it REFUSES matters as much as what it merges.
 */

const BASE_YAML = `
version: 1
gateway:
  name: strad
  env: test
  secrets: { provider: gcp-parameter-store }
  configStore: { enabled: true }
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle
servers:
  - slug: alpha
    kind: remote-http
    url: https://alpha.example.com/mcp
    entitlements: [admin]
  - slug: beta
    kind: remote-http
    url: https://beta.example.com/mcp
    entitlements: [admin]
  - slug: gamma
    kind: supplementary-image
    image: ghcr.io/example/bundle:latest
    bundle: bundle
    path: /gamma
    entitlements: [admin]
    env:
      GAMMA_TOKEN: "\${GAMMA_TOKEN}"
`;

const BASE_DOC = parseYamlDocument(BASE_YAML);
const BASE_CONFIG = StradConfig.parse(BASE_DOC);

function overlay(partial: Partial<ServerOverlay["servers"]>): ServerOverlay {
  return {
    version: 1,
    revision: 1,
    servers: { upserts: [], removals: [], ...partial },
  };
}

function slugsOf(doc: unknown): string[] {
  const servers = (doc as { servers: { slug: string }[] }).servers;
  return servers.map((s) => s.slug);
}

describe("mergeOverlay", () => {
  it("leaves the document untouched when the overlay is empty", () => {
    expect(mergeOverlay(BASE_DOC, EMPTY_OVERLAY)).toEqual(BASE_DOC);
  });

  it("appends a slug the file does not declare", () => {
    const merged = mergeOverlay(
      BASE_DOC,
      overlay({
        upserts: [
          {
            slug: "delta",
            kind: "remote-http",
            url: "https://delta.example.com/mcp",
            entitlements: ["admin"],
          },
        ],
      }),
    );
    expect(slugsOf(merged)).toEqual(["alpha", "beta", "gamma", "delta"]);
  });

  it("replaces a file entry IN PLACE, so config order does not reshuffle", () => {
    const merged = mergeOverlay(
      BASE_DOC,
      overlay({
        upserts: [
          {
            slug: "alpha",
            kind: "remote-http",
            url: "https://alpha-2.example.com/mcp",
            entitlements: ["admin"],
          },
        ],
      }),
    );
    expect(slugsOf(merged)).toEqual(["alpha", "beta", "gamma"]);
    expect(rawEntry(merged, "alpha")).toMatchObject({
      url: "https://alpha-2.example.com/mcp",
    });
  });

  it("drops a removed slug", () => {
    const merged = mergeOverlay(BASE_DOC, overlay({ removals: ["beta"] }));
    expect(slugsOf(merged)).toEqual(["alpha", "gamma"]);
  });

  it("never mutates the base document", () => {
    const before = JSON.stringify(BASE_DOC);
    mergeOverlay(
      BASE_DOC,
      overlay({
        removals: ["alpha"],
        upserts: [{ slug: "zed", kind: "remote-http", url: "https://z/mcp" }],
      }),
    );
    expect(JSON.stringify(BASE_DOC)).toBe(before);
  });
});

describe("sourcesFor", () => {
  it("says where each slug came from", () => {
    const sources = sourcesFor(
      BASE_DOC,
      overlay({
        upserts: [{ slug: "delta", kind: "remote-http", url: "https://d/mcp" }],
        removals: ["beta"],
      }),
    );
    expect(sources.get("alpha")).toBe("file");
    expect(sources.get("delta")).toBe("store");
    expect(sources.has("beta")).toBe(false);
  });

  it("marks an overridden file entry as coming from the store", () => {
    const sources = sourcesFor(
      BASE_DOC,
      overlay({
        upserts: [{ slug: "alpha", kind: "remote-http", url: "https://a/mcp" }],
      }),
    );
    expect(sources.get("alpha")).toBe("store");
  });
});

describe("validateMerged", () => {
  it("accepts a legal roster", () => {
    const result = validateMerged(BASE_DOC);
    expect(result.ok).toBe(true);
  });

  it("refuses a cross-entry rule break — a duplicate slug", () => {
    const merged = {
      ...(BASE_DOC as object),
      servers: [
        ...(BASE_DOC as { servers: unknown[] }).servers,
        { slug: "alpha", kind: "remote-http", url: "https://x/mcp" },
      ],
    };
    const result = validateMerged(merged);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join("\n")).toContain(
      "duplicate server slug: alpha",
    );
  });

  it("refuses an entry granting a role nothing declares", () => {
    const merged = mergeOverlay(
      BASE_DOC,
      overlay({
        upserts: [
          {
            slug: "delta",
            kind: "remote-http",
            url: "https://d/mcp",
            entitlements: ["nobody"],
          },
        ],
      }),
    );
    const result = validateMerged(merged);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join("\n")).toContain('unknown role "nobody"');
  });

  it("refuses an unknown key when strict, and accepts it when not", () => {
    const merged = mergeOverlay(
      BASE_DOC,
      overlay({
        upserts: [
          {
            slug: "delta",
            kind: "remote-http",
            url: "https://d/mcp",
            entitlments: ["admin"],
          },
        ],
      }),
    );

    const strict = validateMerged(merged, { strict: true });
    expect(strict.ok).toBe(false);
    if (!strict.ok) {
      expect(strict.problems.join("\n")).toContain("entitlments");
      // The "did you mean" is what makes this useful rather than merely correct.
      expect(strict.problems.join("\n")).toContain("entitlements");
    }

    // Lenient is the BOOT rule: an older image must not refuse to start over a
    // key a newer one wrote. See src/config/strict.ts.
    expect(validateMerged(merged, { strict: false }).ok).toBe(true);
  });

  it("refuses two servers minting from one refresh token", () => {
    const entry = (slug: string) => ({
      slug,
      kind: "remote-http",
      url: `https://${slug}.example.com/mcp`,
      entitlements: ["admin"],
      oauthRefresh: {
        tokenUrl: "https://oauth.example.com/token",
        clientId: "id",
        clientSecret: "${SHARED_SECRET}",
        refreshToken: "${SHARED_REFRESH}",
      },
    });
    const merged = mergeOverlay(
      BASE_DOC,
      overlay({ upserts: [entry("one"), entry("two")] }),
    );
    const result = validateMerged(merged);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join("\n")).toMatch(/SHARED_REFRESH/);
  });
});

describe("withUpsert / withRemoval", () => {
  const files = fileSlugs(BASE_DOC);

  it("advances the revision on every write", () => {
    const one = withUpsert(
      EMPTY_OVERLAY,
      { slug: "d", kind: "remote-http" },
      {
        fileSlugs: files,
      },
    );
    expect(one.revision).toBe(1);
    expect(
      withUpsert(one, { slug: "e", kind: "remote-http" }, { fileSlugs: files })
        .revision,
    ).toBe(2);
  });

  it("records the author", () => {
    const next = withUpsert(
      EMPTY_OVERLAY,
      { slug: "d", kind: "remote-http" },
      {
        fileSlugs: files,
        by: "tadas@example.com",
      },
    );
    expect(next.updatedBy).toBe("tadas@example.com");
    expect(next.updatedAt).toBeTypeOf("string");
  });

  it("removing a FILE slug records a removal, so the file entry stops being served", () => {
    const next = withRemoval(EMPTY_OVERLAY, "alpha", { fileSlugs: files });
    expect(next.servers.removals).toEqual(["alpha"]);
    expect(slugsOf(mergeOverlay(BASE_DOC, next))).toEqual(["beta", "gamma"]);
  });

  it("removing a STORE slug just drops its upsert — no removal is recorded", () => {
    const added = withUpsert(
      EMPTY_OVERLAY,
      { slug: "delta", kind: "remote-http", url: "https://d/mcp" },
      { fileSlugs: files },
    );
    const next = withRemoval(added, "delta", { fileSlugs: files });
    expect(next.servers.upserts).toEqual([]);
    expect(next.servers.removals).toEqual([]);
    expect(slugsOf(mergeOverlay(BASE_DOC, next))).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("re-adding a removed slug un-removes it, so the two lists never disagree", () => {
    const removed = withRemoval(EMPTY_OVERLAY, "alpha", { fileSlugs: files });
    const back = withUpsert(
      removed,
      { slug: "alpha", kind: "remote-http", url: "https://a2/mcp" },
      { fileSlugs: files },
    );
    expect(back.servers.removals).toEqual([]);
    expect(slugsOf(mergeOverlay(BASE_DOC, back))).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("a rename removes the old slug rather than leaving it behind", () => {
    const renamed = withUpsert(
      EMPTY_OVERLAY,
      { slug: "alpha-new", kind: "remote-http", url: "https://a/mcp" },
      { previousSlug: "alpha", fileSlugs: files },
    );
    expect(slugsOf(mergeOverlay(BASE_DOC, renamed))).toEqual([
      "beta",
      "gamma",
      "alpha-new",
    ]);
  });
});

describe("assertCreatable", () => {
  const ctx = {
    config: BASE_CONFIG,
    env: { STRAD_BUNDLE_URL_BUNDLE: "http://bundle:8080" },
    bundleUrl: (b: string) =>
      b === "bundle" ? "http://bundle:8080" : undefined,
  };

  it("allows remote-http and local-tunnel", () => {
    expect(() =>
      assertCreatable(
        { slug: "d", kind: "remote-http", url: "https://d/mcp" },
        ctx,
      ),
    ).not.toThrow();
    expect(() =>
      assertCreatable(
        { slug: "d", kind: "local-tunnel", url: "https://d/" },
        ctx,
      ),
    ).not.toThrow();
  });

  it("refuses a builtin, because its module has to be in the image", () => {
    expect(() =>
      assertCreatable({ slug: "d", kind: "builtin", module: "./x.js" }, ctx),
    ).toThrow(NotRuntimeCreatable);
  });

  it("allows a supplementary entry pointed at a mount that is already deployed", () => {
    expect(() =>
      assertCreatable(
        {
          slug: "gamma-ro",
          kind: "supplementary-image",
          image: "ghcr.io/example/bundle:latest",
          bundle: "bundle",
          path: "/gamma",
        },
        ctx,
      ),
    ).not.toThrow();
  });

  it("refuses a supplementary entry that declares env:, which only a deploy can deliver", () => {
    expect(() =>
      assertCreatable(
        {
          slug: "gamma-2",
          kind: "supplementary-image",
          image: "ghcr.io/example/bundle:latest",
          bundle: "bundle",
          path: "/gamma-2",
          env: { GAMMA_TOKEN: "${OTHER}" },
        },
        ctx,
      ),
    ).toThrow(/env/);
  });

  it("refuses a supplementary entry on a bundle nothing declares", () => {
    expect(() =>
      assertCreatable(
        {
          slug: "x",
          kind: "supplementary-image",
          image: "i",
          bundle: "nope",
          path: "/x",
        },
        ctx,
      ),
    ).toThrow(/bundles:/);
  });

  it("refuses a supplementary entry whose component this process cannot reach", () => {
    expect(() =>
      assertCreatable(
        {
          slug: "x",
          kind: "supplementary-image",
          image: "i",
          bundle: "bundle",
          path: "/x",
        },
        { ...ctx, bundleUrl: () => undefined },
      ),
    ).toThrow(/not reachable/);
  });
});

describe("assertEditable", () => {
  it("allows a remote-http url to move — the adapter re-resolves it per call", () => {
    expect(() =>
      assertEditable(
        { slug: "a", kind: "remote-http", url: "https://one/mcp" },
        { slug: "a", kind: "remote-http", url: "https://two/mcp" },
      ),
    ).not.toThrow();
  });

  it("refuses a kind change on any entry", () => {
    expect(() =>
      assertEditable(
        { slug: "a", kind: "remote-http", url: "https://one/mcp" },
        { slug: "a", kind: "local-tunnel", url: "https://one/" },
      ),
    ).toThrow(ImmutableFieldChanged);
  });

  it("refuses moving a supplementary entry's image or env", () => {
    const before = {
      slug: "g",
      kind: "supplementary-image",
      image: "i:1",
      bundle: "bundle",
      path: "/g",
      env: { T: "${T}" },
    };
    expect(() => assertEditable(before, { ...before, image: "i:2" })).toThrow(
      /image/,
    );
    expect(() =>
      assertEditable(before, { ...before, env: { T: "${U}" } }),
    ).toThrow(/env/);
  });

  it("does not itself bound tools policy or entitlements — that is a separate rule", () => {
    // `assertEditable` is about fields only a DEPLOY can deliver. Who reaches a
    // server and which of its tools they get is a different question with a
    // different answer: `assertNoAccessControlChange`, keyed on the checked-in
    // document rather than on edit-vs-create, and tested in
    // test/connectors.isolation.test.ts. Both run from
    // `RuntimeConfig.assertAcceptable`, so a write passes only if it clears
    // both — this test is about the first one in isolation.

    const before = {
      slug: "g",
      kind: "supplementary-image",
      image: "i:1",
      bundle: "bundle",
      path: "/g",
    };
    expect(() =>
      assertEditable(before, {
        ...before,
        tools: { allow: ["read"] },
        entitlements: ["admin"],
      }),
    ).not.toThrow();
  });
});

describe("the stored document", () => {
  it("round-trips", () => {
    const written = withUpsert(
      EMPTY_OVERLAY,
      { slug: "d", kind: "remote-http", url: "https://d/mcp" },
      { fileSlugs: new Set() },
    );
    expect(parseOverlay(serialiseOverlay(written))).toEqual(written);
  });

  it("refuses a payload that is not JSON", () => {
    expect(() => parseOverlay("not json")).toThrow(/not JSON/);
  });

  it("refuses a payload that is JSON but not an overlay", () => {
    expect(() => parseOverlay('{"version":9}')).toThrow(/malformed/);
  });

  it("is addressed outside the namespace `${NAME}` resolution reads", () => {
    // /strad/{env}/gateway/static/ is where a secret ${NAME} lives. The overlay
    // must not be in it, or it would resolve as one.
    expect(overlayPath("prod")).toBe("/strad/prod/gateway/config/SERVERS");
    expect(overlayPath("prod")).not.toContain("/gateway/static/");
  });

  it("has a stated ceiling rather than an implied one", () => {
    expect(MAX_OVERLAY_BYTES).toBe(64 * 1024);
  });
});

describe("SLUG_PATTERN", () => {
  /**
   * The console form puts this in an HTML `pattern=` attribute, which browsers
   * compile with the `v` flag. Under `v` an unescaped `-` inside a character
   * class is a SyntaxError, and the browser's answer to that is to drop the
   * attribute — so the form silently stops validating and the first sign of
   * trouble is a refusal on Save. A hand-written pattern had exactly that bug.
   */
  it("compiles under the `v` flag the browser applies to pattern=", () => {
    expect(() => new RegExp(SLUG_PATTERN, "v")).not.toThrow();
  });

  it("accepts exactly what the schema accepts", () => {
    const anchored = new RegExp(`^${SLUG_PATTERN}$`, "v");
    for (const good of ["gmail", "gmail-personal", "a1", "a-b-c"]) {
      expect(anchored.test(good), good).toBe(true);
      expect(
        StradConfig.safeParse({
          version: 1,
          gateway: { env: "test" },
          auth: {},
          roles: {},
          servers: [{ slug: good, kind: "remote-http", url: "https://x/mcp" }],
        }).success,
        good,
      ).toBe(true);
    }
    for (const bad of [
      "-lead",
      "trail-",
      "double--dash",
      "Upper",
      "under_score",
    ]) {
      expect(anchored.test(bad), bad).toBe(false);
      expect(
        StradConfig.safeParse({
          version: 1,
          gateway: { env: "test" },
          auth: {},
          roles: {},
          servers: [{ slug: bad, kind: "remote-http", url: "https://x/mcp" }],
        }).success,
        bad,
      ).toBe(false);
    }
  });
});

describe("assertNoCollision", () => {
  /**
   * The merge replaces by slug and dedupes BEFORE the schema runs, so the
   * duplicate-slug rule never sees two of them — a typo in a slug field is a
   * silent overwrite of a production entry rather than a validation error.
   */
  it("refuses a CREATE onto a slug that already exists", () => {
    expect(() => assertNoCollision(BASE_CONFIG, "alpha", undefined)).toThrow(
      SlugCollision,
    );
  });

  it("allows a write that deliberately targets its own slug", () => {
    expect(() =>
      assertNoCollision(BASE_CONFIG, "alpha", "alpha"),
    ).not.toThrow();
  });

  it("refuses a RENAME that lands on a third entry", () => {
    expect(() => assertNoCollision(BASE_CONFIG, "beta", "alpha")).toThrow(
      /already exists/,
    );
  });

  it("allows a rename to a slug nothing holds", () => {
    expect(() =>
      assertNoCollision(BASE_CONFIG, "brand-new", "alpha"),
    ).not.toThrow();
  });

  it("would otherwise silently replace — the behaviour this guards", () => {
    // Without the guard this merge is accepted and `alpha` is gone, replaced by
    // an entry pointing somewhere else entirely, with no duplicate reported.
    const merged = mergeOverlay(
      BASE_DOC,
      overlay({
        upserts: [
          { slug: "alpha", kind: "remote-http", url: "https://attacker/mcp" },
        ],
      }),
    );
    expect(validateMerged(merged).ok).toBe(true);
    expect(slugsOf(merged)).toEqual(["alpha", "beta", "gamma"]);
    expect(rawEntry(merged, "alpha")).toMatchObject({
      url: "https://attacker/mcp",
    });
  });
});

describe("withRestore", () => {
  const files = fileSlugs(BASE_DOC);

  it("lifts a removal so the checked-in entry serves again", () => {
    const removed = withRemoval(EMPTY_OVERLAY, "alpha", { fileSlugs: files });
    expect(slugsOf(mergeOverlay(BASE_DOC, removed))).toEqual(["beta", "gamma"]);

    const back = withRestore(removed, "alpha");
    expect(back.servers.removals).toEqual([]);
    expect(slugsOf(mergeOverlay(BASE_DOC, back))).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(back.revision).toBe(removed.revision + 1);
  });

  it("is idempotent on a slug that was not removed", () => {
    const next = withRestore(EMPTY_OVERLAY, "nothing");
    expect(next.servers.removals).toEqual([]);
  });

  it("leaves upserts alone", () => {
    const added = withUpsert(
      EMPTY_OVERLAY,
      { slug: "delta", kind: "remote-http", url: "https://d/mcp" },
      { fileSlugs: files },
    );
    expect(withRestore(added, "alpha").servers.upserts).toHaveLength(1);
  });
});

describe("a hand-written overlay naming a slug in BOTH lists", () => {
  /**
   * `withUpsert` and `withRemoval` keep the lists disjoint, so this is only
   * reachable by editing the stored parameter by hand. It should still produce
   * a defined roster rather than depending on which list the merge reads last.
   */
  it("upserts win, and the entry is appended rather than replaced in place", () => {
    const merged = mergeOverlay(BASE_DOC, {
      version: 1,
      revision: 1,
      servers: {
        upserts: [
          { slug: "alpha", kind: "remote-http", url: "https://a2/mcp" },
        ],
        removals: ["alpha"],
      },
    });
    expect(slugsOf(merged)).toEqual(["beta", "gamma", "alpha"]);
    expect(rawEntry(merged, "alpha")).toMatchObject({ url: "https://a2/mcp" });
    expect(validateMerged(merged).ok).toBe(true);
  });
});

describe("composing with the `mcp.json` input dialect", () => {
  /**
   * Two features that both transform the DOCUMENT, and the order between them
   * is load-bearing. `loadConfigDocument` hands the overlay the DESUGARED
   * document, so an entry written as `mcpServers:` is an ordinary `servers:`
   * entry by the time the merge looks at it. Merging into the raw document
   * instead would leave the overlay unable to see those entries at all — a
   * collision nothing detects, and a roster with two sources of truth.
   */
  const DIALECT_YAML = `
version: 1
gateway:
  name: strad
  env: test
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
servers:
  - slug: plain
    kind: remote-http
    url: https://plain.example.com/mcp
    entitlements: [admin]
mcpServers:
  analytics:
    title: Analytics
    type: streamable-http
    url: https://analytics.example.com/mcp
    strad:
      entitlements: [admin]
`;

  const desugared = configDocument(DIALECT_YAML).doc;

  it("sees a dialect entry as an ordinary server", () => {
    expect(slugsOf(desugared)).toEqual(["plain", "analytics"]);
    expect(fileSlugs(desugared).has("analytics")).toBe(true);
  });

  it("lets the overlay OVERRIDE an entry the dialect contributed", () => {
    const merged = mergeOverlay(
      desugared,
      overlay({
        upserts: [
          {
            slug: "analytics",
            kind: "remote-http",
            url: "https://analytics-2.example.com/mcp",
            entitlements: ["admin"],
          },
        ],
      }),
    );
    // Replaced in place, not appended beside it — which is what proves the
    // merge can actually see the desugared entry.
    expect(slugsOf(merged)).toEqual(["plain", "analytics"]);
    expect(rawEntry(merged, "analytics")).toMatchObject({
      url: "https://analytics-2.example.com/mcp",
    });
    expect(validateMerged(merged).ok).toBe(true);
  });

  it("lets the overlay REMOVE an entry the dialect contributed", () => {
    const merged = mergeOverlay(
      desugared,
      overlay({ removals: ["analytics"] }),
    );
    expect(slugsOf(merged)).toEqual(["plain"]);
  });

  it("refuses a collision with a dialect entry, like any other", () => {
    const config = StradConfig.parse(desugared);
    expect(() => assertNoCollision(config, "analytics", undefined)).toThrow(
      SlugCollision,
    );
  });
});
