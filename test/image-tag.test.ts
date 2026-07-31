import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import {
  assertImmutableCoreImage,
  isMutableTag,
  resolveDeployTag,
  shaTag,
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

  it("passes a version and a commit tag", () => {
    expect(isMutableTag("0.1.38")).toBe(false);
    expect(isMutableTag(`sha-${A}`)).toBe(false);
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

describe("resolveDeployTag", () => {
  it("takes HEAD when HEAD published an image", async () => {
    const published = vi.fn().mockResolvedValue(true);
    await expect(resolveDeployTag([A, B, C], published)).resolves.toEqual({
      tag: `sha-${A}`,
      sha: A,
      distance: 0,
    });
    expect(published).toHaveBeenCalledTimes(1);
  });

  it("walks back past commits that published nothing", async () => {
    // The docs-only case: this repo lands docs with the code, and
    // release-image.yml ignores `**/*.md` and `docs/**`.
    const published = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    await expect(resolveDeployTag([A, B, C], published)).resolves.toEqual({
      tag: `sha-${C}`,
      sha: C,
      distance: 2,
    });
  });

  it("throws when nothing in range published, naming the range", async () => {
    const published = vi.fn().mockResolvedValue(false);
    await expect(resolveDeployTag([A, B], published)).rejects.toThrow(
      /no published image for any of the last 2 commits/,
    );
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
    await expect(resolveDeployTag([A, B], published)).rejects.toThrow(
      /HTTP 503/,
    );
    expect(published).toHaveBeenCalledTimes(1);
  });
});
