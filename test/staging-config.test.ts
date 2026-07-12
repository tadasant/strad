import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { renderAppSpec } from "../src/deploy/appspec.ts";

/**
 * The staging config is the proof that the collapse actually collapsed.
 *
 * Two things are checked here, and they are the two things that would rot:
 *
 *   1. COMPONENT COUNT. 25 servers must render as exactly TWO components —
 *      core + one bundle. A stray `bundle:` name in the config is a $5-$25/month
 *      regression that nobody would otherwise notice.
 *
 *   2. THE TOOL COUNTS. The capability tiers are now allow-lists in this file,
 *      derived from each upstream's tool-group definitions. If someone trims one
 *      by accident, the slug silently loses a tool. The numbers below are the
 *      ones the old per-container `*_ENABLED_TOOLGROUPS` produced — that is the
 *      whole point: the counts did not change, only who enforces them.
 *
 * The FULL (un-policied) counts are asserted where they can only honestly be
 * asserted — against the real running image, by servers/bundle/scripts/smoke.mjs,
 * which CI runs on the built container.
 */

const CONFIG = parseConfig(
  readFileSync(new URL("../infra/strad.staging.yaml", import.meta.url), "utf8"),
  "infra/strad.staging.yaml",
);

const IMAGE = "ghcr.io/tadasant/strad-bundle:latest";

describe("staging config", () => {
  it("renders exactly TWO components: core + one bundle", () => {
    const spec = renderAppSpec({
      config: CONFIG,
      appName: "strad-staging",
      region: "nyc",
      image: {
        registry_type: "GHCR",
        registry: "tadasant",
        repository: "strad",
        tag: "latest",
      },
      env: [],
      // Every ${REF} in a supplementary env map, resolved — appspec fails closed
      // on an unresolved one, and this test is not the place to prove that.
      secrets: Object.fromEntries(
        [
          "SLACK_BOT_TOKEN",
          "TAILSCALE_API_KEY",
          "MONARCH_SESSION_TOKEN",
          "SERPAPI_API_KEY",
          "REMOTE_FS_SCREENSHOTS_GCS_CLIENT_EMAIL",
          "REMOTE_FS_SCREENSHOTS_GCS_PRIVATE_KEY",
          "GCS_PULSEMCP_SERVICE_ACCOUNT_KEY_JSON",
          "GMAIL_TADAS_SERVICE_ACCOUNT_CLIENT_EMAIL",
          "GMAIL_TADAS_SERVICE_ACCOUNT_PRIVATE_KEY",
          "GMAIL_IMPERSONATE_EMAIL",
          "GOOGLE_DOCS_TADAS_SERVICE_ACCOUNT_CLIENT_EMAIL",
          "GOOGLE_DOCS_TADAS_SERVICE_ACCOUNT_PRIVATE_KEY",
          "GOOGLE_DOCS_IMPERSONATE_EMAIL",
          "GOOGLE_CALENDAR_TADAS_SERVICE_ACCOUNT_CLIENT_EMAIL",
          "GOOGLE_CALENDAR_TADAS_SERVICE_ACCOUNT_PRIVATE_KEY",
          "GCAL_IMPERSONATE_EMAIL",
          "OP_SERVICE_ACCOUNT_TOKEN_TADAS_RW",
          "GOODEGGS_EMAIL",
          "GOODEGGS_PASSWORD",
          "FETCHPET_USERNAME",
          "FETCHPET_PASSWORD",
          "POINTSYEAH_REFRESH_TOKEN",
        ].map((name) => [name, "x"]),
      ),
    });

    expect(spec.services.map((s) => s.name)).toEqual(["core", "bundle"]);

    const bundle = spec.services[1]!;
    expect(bundle.instance_size_slug).toBe("apps-s-1vcpu-2gb");
    // Internal-only: internal_ports and NO http_port (both is an API rejection).
    expect(bundle.internal_ports).toEqual([8080]);
    expect(bundle.http_port).toBeUndefined();
    // The credentials of all fourteen upstream servers, unioned onto the one box.
    expect(bundle.envs.some((e) => e.key === "SLACK_BOT_TOKEN")).toBe(true);
    expect(bundle.envs.some((e) => e.key === "OP_SERVICE_ACCOUNT_TOKEN")).toBe(
      true,
    );
    expect(bundle.envs.every((e) => e.type === "SECRET")).toBe(true);
  });

  it("every containerised server runs the ONE image, in the ONE bundle", () => {
    const supplementary = CONFIG.servers.filter(
      (s) => s.kind === "supplementary-image",
    );
    expect(supplementary.length).toBe(23);
    for (const server of supplementary) {
      expect(server.image).toBe(IMAGE);
      expect(server.bundle).toBe("bundle");
    }
  });

  it("no server carries a container-side capability toggle any more", () => {
    // The env var that used to BE the capability. If one comes back, a slug's
    // toolset would depend on the container again — and the read-write variants
    // sharing that container would silently lose their write tools.
    for (const server of CONFIG.servers) {
      if (server.kind !== "supplementary-image") continue;
      for (const key of Object.keys(server.env)) {
        expect(key).not.toMatch(
          /(^|_)(ENABLED_TOOLGROUPS|ENABLED_TOOL_GROUPS|TOOL_GROUPS)$/,
        );
      }
    }
  });

  /** Tool counts, per capability tier — the numbers the containers used to make. */
  const ALLOW_COUNTS: Record<string, number> = {
    "slack-readonly": 4,
    "tailscale-readonly": 7,
    "monarch-money-readonly": 10,
    "gmail-ro": 5,
    "gmail-rw": 7,
    "google-docs-ro": 4,
    "google-docs-rw": 10,
    "google-calendar-ro": 4,
    "onepassword-ro": 5,
  };

  it.each(Object.entries(ALLOW_COUNTS))(
    "%s allows exactly %i tools",
    (slug, count) => {
      const server = CONFIG.servers.find((s) => s.slug === slug);
      expect(server?.tools?.allow).toHaveLength(count);
    },
  );

  it.each([
    // These tiers ARE the full tool set, so they carry no policy at all. Their
    // counts (gmail 8, docs 11, calendar 7, 1Password 9, slack 9, tailscale 15,
    // monarch 23) are asserted against the running image by the bundle's smoke test.
    "slack",
    "tailscale-readwrite",
    "monarch-money-readwrite",
    "gmail-rw-external",
    "google-docs-rw-external",
    "google-calendar-rw",
    "onepassword-rw",
  ])("%s is the full-capability tier (no policy)", (slug) => {
    const server = CONFIG.servers.find((s) => s.slug === slug);
    expect(server).toBeDefined();
    expect(server?.tools).toBeUndefined();
  });

  it("each tier is a superset of the one below it", () => {
    const allow = (slug: string): string[] =>
      CONFIG.servers.find((s) => s.slug === slug)?.tools?.allow ?? [];

    for (const [lower, upper] of [
      ["gmail-ro", "gmail-rw"],
      ["google-docs-ro", "google-docs-rw"],
    ] as const) {
      const upperSet = new Set(allow(upper));
      for (const tool of allow(lower)) expect(upperSet.has(tool)).toBe(true);
    }
  });

  it("a read-only variant shares its upstream with its read-write twin", () => {
    // The whole trick: same bundle, same path, same container. Only the policy
    // differs. If these ever diverge, we are paying for two components again.
    for (const [ro, rw] of [
      ["slack-readonly", "slack"],
      ["gmail-ro", "gmail-rw-external"],
      ["onepassword-ro", "onepassword-rw"],
    ] as const) {
      const a = CONFIG.servers.find((s) => s.slug === ro);
      const b = CONFIG.servers.find((s) => s.slug === rw);
      if (
        a?.kind !== "supplementary-image" ||
        b?.kind !== "supplementary-image"
      )
        throw new Error("expected supplementary images");
      expect(a.bundle).toBe(b.bundle);
      expect(a.path).toBe(b.path);
      expect(a.image).toBe(b.image);
    }
  });
});
