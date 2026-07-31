import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import {
  assertImmutableCoreImage,
  fetchPullToken,
  isDocsOnly,
  isMutableTag,
  registryProbe,
  resolveDeployTag,
  shaTag,
  type Candidate,
} from "../src/deploy/imageTag.ts";
import { parseImage } from "../src/deploy/appspec.ts";
import type {
  ServerConfig,
  SupplementaryImageServer,
} from "../src/config/schema.ts";

const isSupplementary = (s: ServerConfig): s is SupplementaryImageServer =>
  s.kind === "supplementary-image";

/**
 * The outage this file exists to prevent.
 *
 * A `Deploy staging` dispatch on main shipped `ghcr.io/tadasant/strad:latest`
 * and the container booted code from before PR #26 — old enough to still carry
 * the "each must serve a distinct path" rule that PR deleted. It rejected the
 * current `infra/strad.staging.yaml` at boot and took staging down, while the
 * same commit deployed on `:0.1.38` (and later `:0.1.33`) came up fine.
 *
 * Two halves, and both are pinned here:
 *
 *   1. THE CONFIG IS VALID. The capability pairs share a path on purpose. If
 *      anyone reintroduces a distinct-path rule, this fails here rather than in
 *      a container at 3am.
 *
 *   2. THE DEPLOY SHIPS AN IMMUTABLE TAG. A mutable tag is an image the spec
 *      does not determine, which is how new config met old code.
 */

const STAGING = new URL("../infra/strad.staging.yaml", import.meta.url);

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

describe("the staging config the outage rejected", () => {
  it("parses, and keeps the capability pairs on ONE shared path", () => {
    const config = parseConfig(
      readFileSync(STAGING, "utf8"),
      "infra/strad.staging.yaml",
    );

    // The exact shape the stale image refused: two slugs, one bundle, one path,
    // told apart by their tool policy rather than by their route.
    const onSlack = config.servers
      .filter(isSupplementary)
      .filter((s) => s.path === "/slack");
    expect(onSlack.map((s) => s.slug).sort()).toEqual([
      "slack",
      "slack-readonly",
    ]);
    expect(new Set(onSlack.map((s) => s.bundle)).size).toBe(1);
  });

  it("shares a path for every capability pair, not just slack", () => {
    const config = parseConfig(
      readFileSync(STAGING, "utf8"),
      "infra/strad.staging.yaml",
    );
    const byPath = new Map<string, string[]>();
    for (const s of config.servers.filter(isSupplementary)) {
      byPath.set(s.path, [...(byPath.get(s.path) ?? []), s.slug]);
    }
    // If this drops to zero, either the pairs were split onto distinct paths or
    // a distinct-path rule came back. Both are the regression.
    const shared = [...byPath.values()].filter((slugs) => slugs.length > 1);
    expect(shared.length).toBeGreaterThan(0);
  });
});

describe("isMutableTag", () => {
  it("catches the tags that name a moving target", () => {
    for (const tag of ["latest", "main", "edge", "stable"]) {
      expect(isMutableTag(tag)).toBe(true);
    }
  });

  it("is case-insensitive, since a registry tag need not be lowercase", () => {
    expect(isMutableTag("Latest")).toBe(true);
    expect(isMutableTag("LATEST")).toBe(true);
  });

  it("passes a version, a commit tag and a branch tag", () => {
    expect(isMutableTag("0.1.38")).toBe(false);
    expect(isMutableTag(`sha-${A}`)).toBe(false);
    expect(isMutableTag("branch-fix-thing-96015c6638a7")).toBe(false);
  });
});

describe("assertImmutableCoreImage", () => {
  it("refuses the exact ref that took staging down", () => {
    const ref = "ghcr.io/tadasant/strad:latest";
    expect(() => assertImmutableCoreImage(ref, parseImage(ref).tag)).toThrow(
      /mutable tag "latest"/,
    );
  });

  it("refuses a tag-less ref, which parseImage turns into :latest", () => {
    const ref = "ghcr.io/tadasant/strad";
    expect(parseImage(ref).tag).toBe("latest");
    expect(() => assertImmutableCoreImage(ref, parseImage(ref).tag)).toThrow(
      /mutable tag "latest"/,
    );
  });

  it("names the shapes that are allowed instead", () => {
    expect(() =>
      assertImmutableCoreImage("ghcr.io/tadasant/strad:latest", "latest"),
    ).toThrow(/:sha-<commit>/);
  });

  it("allows a version tag and a commit tag", () => {
    const version = "ghcr.io/tadasant/strad:0.1.38";
    expect(() =>
      assertImmutableCoreImage(version, parseImage(version).tag),
    ).not.toThrow();
    const commit = `ghcr.io/tadasant/strad:sha-${A}`;
    expect(() =>
      assertImmutableCoreImage(commit, parseImage(commit).tag),
    ).not.toThrow();
  });
});

describe("shaTag", () => {
  it("builds the tag release-image.yml publishes", () => {
    expect(shaTag(A)).toBe(`sha-${A}`);
  });

  it("refuses anything that is not a full commit sha", () => {
    // An abbreviated sha would build a tag that never resolves, and the deploy
    // would blame a missing image rather than the truncation.
    expect(() => shaTag(A.slice(0, 12))).toThrow(/not a full commit sha/);
    expect(() => shaTag("")).toThrow(/not a full commit sha/);
  });
});

describe("isDocsOnly", () => {
  it("accepts the paths release-image.yml ignores", () => {
    expect(isDocsOnly(["README.md"])).toBe(true);
    expect(isDocsOnly(["docs/src/content/docs/intro.md"])).toBe(true);
    expect(isDocsOnly(["HACKS.md", "docs/astro.config.mjs"])).toBe(true);
  });

  it("rejects a commit that touched any code", () => {
    expect(isDocsOnly(["README.md", "src/index.ts"])).toBe(false);
    expect(isDocsOnly(["infra/strad.staging.yaml"])).toBe(false);
  });

  it("treats an EMPTY list as not docs-only", () => {
    // `every` on an empty array is true, which would license a walk-back past a
    // commit we know nothing about — the one thing this predicate prevents.
    expect(isDocsOnly([])).toBe(false);
  });
});

/** Newest-first candidates, all docs-only unless stated. */
const docs = (sha: string): Candidate => ({ sha, docsOnly: true });
const code = (sha: string): Candidate => ({ sha, docsOnly: false });

describe("resolveDeployTag", () => {
  it("takes HEAD when HEAD published an image", async () => {
    const published = vi.fn().mockResolvedValue(true);
    await expect(
      resolveDeployTag([code(A), code(B), code(C)], published),
    ).resolves.toEqual({ tag: `sha-${A}`, sha: A, distance: 0 });
    expect(published).toHaveBeenCalledTimes(1);
  });

  it("walks back past DOCS-ONLY commits, which cut no image by design", async () => {
    const published = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    await expect(
      resolveDeployTag([docs(A), docs(B), code(C)], published),
    ).resolves.toEqual({ tag: `sha-${C}`, sha: C, distance: 2 });
  });

  it("HARD STOPS on a code commit with no image, rather than walking back", async () => {
    // The regression that would reintroduce the outage: merge a code PR, then
    // deploy while release-image.yml is still building. Walking back would ship
    // the PREVIOUS commit's image against THIS commit's config — new config
    // meeting old code, exactly what this module exists to prevent.
    const published = vi
      .fn()
      .mockResolvedValueOnce(false) // HEAD: code, not built yet
      .mockResolvedValueOnce(true); // its parent: would have been used
    await expect(
      resolveDeployTag([code(A), code(B)], published),
    ).rejects.toThrow(/changed code but published no image/);
    // It must not have even asked about the parent.
    expect(published).toHaveBeenCalledTimes(1);
  });

  it("says what to do about the hard stop", async () => {
    const published = vi.fn().mockResolvedValue(false);
    await expect(resolveDeployTag([code(A)], published)).rejects.toThrow(
      /still building it, or it failed[\s\S]*explicit `version`/,
    );
  });

  it("throws when every commit in range is docs-only and none published", async () => {
    const published = vi.fn().mockResolvedValue(false);
    await expect(
      resolveDeployTag([docs(A), docs(B)], published),
    ).rejects.toThrow(/no published image in the last 2 commits/);
  });

  it("throws on an empty history rather than inventing a tag", async () => {
    const published = vi.fn().mockResolvedValue(true);
    await expect(resolveDeployTag([], published)).rejects.toThrow(
      /no commits to resolve an image tag from/,
    );
    expect(published).not.toHaveBeenCalled();
  });

  it("propagates a registry error instead of walking back past it", async () => {
    // An unreadable registry must not look like a missing tag: that would
    // silently ship an older image every time GHCR had a bad minute.
    const published = vi.fn().mockRejectedValue(new Error("HTTP 503"));
    await expect(
      resolveDeployTag([docs(A), docs(B)], published),
    ).rejects.toThrow(/HTTP 503/);
    expect(published).toHaveBeenCalledTimes(1);
  });
});

/** A probe wired to a scripted fetch, with sleeps stubbed out. */
function probe(responses: (Response | Error)[]) {
  const calls = { n: 0 };
  const fetchImpl = vi.fn(async () => {
    const next = responses[calls.n++] ?? responses[responses.length - 1];
    if (next instanceof Error) throw next;
    return next as Response;
  });
  return {
    calls,
    fetchImpl,
    published: registryProbe({
      registry: "ghcr.io",
      repository: "tadasant/strad",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    }),
  };
}

const res = (status: number): Response =>
  ({ status, ok: status >= 200 && status < 300 }) as Response;

describe("registryProbe", () => {
  it("reports a published tag", async () => {
    const p = probe([res(200)]);
    await expect(p.published("sha-x")).resolves.toBe(true);
    expect(p.calls.n).toBe(1);
  });

  it("reports 404 as absent — the ONLY negative", async () => {
    const p = probe([res(404)]);
    await expect(p.published("sha-x")).resolves.toBe(false);
    expect(p.calls.n).toBe(1);
  });

  it("does NOT treat 403 as absent, and does not retry it", async () => {
    // A revoked credential must fail the deploy, not silently walk it back to
    // an older image.
    const p = probe([res(403)]);
    await expect(p.published("sha-x")).rejects.toThrow(/HTTP 403/);
    expect(p.calls.n).toBe(1);
  });

  it("retries a 5xx and succeeds", async () => {
    const p = probe([res(503), res(200)]);
    await expect(p.published("sha-x")).resolves.toBe(true);
    expect(p.calls.n).toBe(2);
  });

  it("retries a 429 rather than failing — a long walk-back provokes it", async () => {
    const p = probe([res(429), res(429), res(404)]);
    await expect(p.published("sha-x")).resolves.toBe(false);
    expect(p.calls.n).toBe(3);
  });

  it("retries a network error, then gives up with the reason", async () => {
    const p = probe([new Error("fetch failed")]);
    await expect(p.published("sha-x")).rejects.toThrow(/fetch failed/);
    expect(p.calls.n).toBe(3);
  });
});

describe("fetchPullToken", () => {
  const base = {
    registry: "ghcr.io",
    repository: "tadasant/strad",
    actor: "a",
    password: "p",
    sleep: async () => {},
  };

  it("returns the token", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token: "tok" }),
    }));
    await expect(
      fetchPullToken({
        ...base,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBe("tok");
  });

  it("retries a transient failure — it is an EARLIER single point of failure", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      if (++n === 1) throw new Error("fetch failed");
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: "tok" }),
      };
    });
    await expect(
      fetchPullToken({
        ...base,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBe("tok");
    expect(n).toBe(2);
  });

  it("does not retry a bad credential", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n++;
      return { ok: false, status: 401, json: async () => ({}) };
    });
    await expect(
      fetchPullToken({
        ...base,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/HTTP 401/);
    expect(n).toBe(1);
  });
});
