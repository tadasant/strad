import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { renderAppSpec } from "../src/deploy/appspec.ts";

/**
 * The staging config is the proof that the collapse actually collapsed.
 *
 * Two things are checked here, and they are the two things that would rot:
 *
 *   1. COMPONENT COUNT. 29 servers must render as exactly THREE components —
 *      core, the bundle, and `bundle-zimmer-secrets`. A stray `bundle:` name in
 *      the config is a $5-$25/month regression that nobody would otherwise
 *      notice, so the number is pinned rather than merely bounded. The third one
 *      is deliberate and is not a capability variant: it fronts a SECOND
 *      parameter store, which is `process.env` and therefore cannot share a
 *      container. test/staging-config.multi-store.test.ts is where that property
 *      is proven; this file only guards the count.
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
  it("renders exactly THREE components: core + bundle + the second store", () => {
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
          "X_OAUTH_CLIENT_ID",
          "X_OAUTH_CLIENT_SECRET",
          "X_OAUTH_REFRESH_TOKEN",
          "REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_CLIENT_EMAIL",
          "REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_PRIVATE_KEY",
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
          "SECRETS_PROJECT_ID",
          "SECRETS_VIEWER_KEY_JSON",
          "SECRETS_ADMIN_KEY_JSON",
          "ZIMMER_SECRETS_VIEWER_KEY_JSON",
          "ZIMMER_SECRETS_ADMIN_KEY_JSON",
        ].map((name) => [name, "x"]),
      ),
    });

    expect(spec.services.map((s) => s.name)).toEqual([
      "core",
      "bundle",
      "bundle-zimmer-secrets",
    ]);

    const bundle = spec.services[1]!;
    expect(bundle.instance_size_slug).toBe("apps-s-1vcpu-2gb");
    // Internal-only: internal_ports and NO http_port (both is an API rejection).
    expect(bundle.internal_ports).toEqual([8080]);
    expect(bundle.http_port).toBeUndefined();
    // The credentials of all sixteen upstream servers, unioned onto the one box
    // — and every one of them SECRET-typed, so App Platform encrypts it at rest.
    const credentials = bundle.envs.filter((e) => !e.key.startsWith("STRAD_"));
    expect(credentials.some((e) => e.key === "SLACK_BOT_TOKEN")).toBe(true);
    expect(credentials.some((e) => e.key === "OP_SERVICE_ACCOUNT_TOKEN")).toBe(
      true,
    );
    expect(credentials.every((e) => e.type === "SECRET")).toBe(true);

    // And it is INSTRUMENTED. The collapsed container is the one this telemetry
    // exists for — it is where Chromium, `op` and sixteen servers now share a
    // vCPU — so a bundle that renders without its identity vars is a bundle we
    // could not tell apart from the core in a dashboard.
    expect(bundle.envs.find((e) => e.key === "STRAD_COMPONENT")?.value).toBe(
      "bundle",
    );
    expect(bundle.envs.some((e) => e.key === "STRAD_ENV")).toBe(true);
    expect(bundle.envs.some((e) => e.key === "STRAD_VERSION")).toBe(true);

    // THE IAM SPLIT, as it actually ships. secrets' two service accounts must
    // land on DIFFERENT components, or the whole posture is decorative:
    //
    //   viewer (no secretmanager.versions.access) -> the bundle, which answers /mcp
    //   admin  (reads and writes both stores)     -> core, the SSO-gated console
    //
    // The failure this pins is not hypothetical: every other way of giving core a
    // credential (a broadcast SECRET env var) ALSO gives it to the bundle, because
    // appspec forwards SECRET-typed broadcast vars to every component.
    const core = spec.services[0]!;
    const ADMIN = "SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON";
    const VIEWER = "SECRETS_SERVICE_ACCOUNT_KEY_JSON";

    expect(core.envs.some((e) => e.key === ADMIN)).toBe(true);
    expect(bundle.envs.some((e) => e.key === ADMIN)).toBe(false);

    expect(bundle.envs.some((e) => e.key === VIEWER)).toBe(true);
    expect(core.envs.some((e) => e.key === VIEWER)).toBe(false);

    // And the admin key is SECRET-typed, so DigitalOcean encrypts it at rest.
    expect(core.envs.find((e) => e.key === ADMIN)?.type).toBe("SECRET");
  });

  it("gives the console the gcs key too, or /ui/gcs cannot resolve it", () => {
    // `env:` is scoped to the bundle. The browse view renders in CORE, so a
    // credential listed ONLY under `env:` produces the confusing pair of
    // symptoms this test exists to prevent: the MCP tools work, and the human
    // console reports the credentials as unavailable.
    const gcs = CONFIG.servers.find((s) => s.slug === "gcs");
    if (gcs?.kind !== "supplementary-image") throw new Error("gcs not found");
    const KEY = "GCS_SERVICE_ACCOUNT_KEY_JSON";
    expect(gcs.env[KEY]).toBeDefined();
    // The SAME ref in both scopes — not a second, stronger credential.
    expect(gcs.consoleEnv[KEY]).toBe(gcs.env[KEY]);

    const spec = renderAppSpec({
      config: CONFIG,
      appName: "strad-staging",
      region: "nyc",
      image: { registry_type: "GHCR", repository: "strad", tag: "test" },
      env: [],
      secrets: Object.fromEntries(
        CONFIG.servers.flatMap((s) =>
          s.kind === "supplementary-image" && s.enabled
            ? [...Object.values(s.env), ...Object.values(s.consoleEnv)].flatMap(
                (v) =>
                  [...v.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(
                    (m) => [m[1]!, "resolved-value"] as const,
                  ),
              )
            : [],
        ),
      ),
    });
    const core = spec.services.find((s) => s.name === "core")!;
    expect(core.envs.find((e) => e.key === KEY)?.value).toBe("resolved-value");
    expect(core.envs.find((e) => e.key === KEY)?.type).toBe("SECRET");
  });

  it("every containerised server runs the ONE image, and only the second store leaves the ONE bundle", () => {
    const supplementary = CONFIG.servers.filter(
      (s) => s.kind === "supplementary-image",
    );
    expect(supplementary.length).toBe(27);
    for (const server of supplementary) {
      expect(server.image).toBe(IMAGE);
      // ONE image, and one bundle for everything whose difference is
      // CAPABILITY. `zimmer-secrets` is the sole exception, and its difference
      // is a STORE — `process.env`, which a container has exactly one of. A
      // second slug appearing here is a second billed component: justify it in
      // this test or put it back in the bundle.
      expect(server.bundle).toBe(
        server.slug === "zimmer-secrets" ? "bundle-zimmer-secrets" : "bundle",
      );
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
    "x-twitter-readonly": 7,
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
    // monarch 23, x-twitter 9) are asserted against the running image by the
    // bundle's smoke test.
    "slack",
    "tailscale-readwrite",
    "monarch-money-readwrite",
    "gmail-rw-external",
    "google-docs-rw-external",
    "google-calendar-rw",
    "onepassword-rw",
    "x-twitter-readwrite",
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
      ["x-twitter-readonly", "x-twitter-readwrite"],
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

  /**
   * The `zimmer` role is the one entitlement in this file whose breadth is a
   * security decision rather than a convenience, so it gets a test rather than a
   * comment.
   *
   * Twenty-one of staging's slugs carry a real third-party credential, backed by
   * the SAME accounts prod uses — one Slack workspace, one Gmail tenant, one
   * 1Password service account. The token that holds this role lives in a platform
   * app and is handed to agent sessions, so every slug added here is a capability
   * handed to an agent. Three are defensible: `zimmer-secrets` and `secrets` are
   * two SEPARATE GCP projects, each fenced again by its own namespace list, and
   * `echo` is a builtin with no credential at all. Neither store is empty — both
   * hold per-server credentials — so the claim is separation plus fence, not
   * harmlessness (issue #59).
   *
   * A widening shows up here as a failing assertion naming the slug, which is
   * the review conversation worth having.
   */
  describe("the zimmer role", () => {
    const ALLOWED = ["echo", "secrets", "zimmer-secrets"];

    it("names only servers whose reach is bounded to a fenced parameter store", () => {
      expect(CONFIG.roles.zimmer?.servers.slice().sort()).toEqual(ALLOWED);
    });

    it("is entitled by exactly those servers and no others", () => {
      // Entitlement is an INTERSECTION (see gateway/entitlements.ts): the role
      // must name the server AND the server must name the role. Asserting only
      // the role would miss a slug that quietly added `zimmer` to its own
      // `entitlements:` — harmless today because the role does not name it, and
      // a live grant the moment someone widens the role.
      const declaring = CONFIG.servers
        .filter((s) => s.entitlements.includes("zimmer"))
        .map((s) => s.slug)
        .sort();
      expect(declaring).toEqual(ALLOWED);
    });

    it("cannot reach the store's own namespace through the server it is given", () => {
      // `secrets` is entitled, so the fence that matters is SECRETS_NAMESPACES:
      // the MCP half must stay scoped to the servers' namespace. The gateway
      // namespace holds every ${NAME} this deployment references — and staging's
      // MCP credential can read a secret VALUE — so listing it here would hand
      // this token the 21 supplementary credentials the narrow role withholds.
      const secrets = CONFIG.servers.find((s) => s.slug === "secrets");
      if (secrets?.kind !== "supplementary-image")
        throw new Error("expected a supplementary image");
      expect(secrets.env.SECRETS_NAMESPACES).toBe("/strad/staging/mcp/");
      expect(secrets.env.SECRETS_NAMESPACES).not.toContain("gateway");
    });

    it("can watch a rotation, because echo resolves its options at call time", () => {
      // `params: true` is what makes /strad/staging/mcp/echo/static/* re-resolve
      // per tool call. Without it `whoami` reports a value fixed at boot and the
      // rotation property is unobservable from outside the process.
      const echo = CONFIG.servers.find((s) => s.slug === "echo");
      if (echo?.kind !== "builtin") throw new Error("expected a builtin");
      expect(echo.params).toBe(true);
    });
  });
});
