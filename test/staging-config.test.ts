import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { renderAppSpec } from "../src/deploy/appspec.ts";
import { bakedSecretNames } from "../src/deploy/preflight.ts";
import { waivedNames } from "../src/deploy/unseeded.ts";

/**
 * The staging config is the proof that the collapse actually collapsed.
 *
 * Three things are checked here, and they are the three that would rot:
 *
 *   1. COMPONENT COUNT. 40 servers must render as exactly THREE components —
 *      core, the bundle, and `bundle-zimmer-secrets`. A stray `bundle:` name in
 *      the config is a $5-$25/month regression that nobody would otherwise
 *      notice, so the number is pinned rather than merely bounded. The third one
 *      is deliberate and is not a capability variant: it fronts a SECOND
 *      parameter store, which is `process.env` and therefore cannot share a
 *      container. test/staging-config.multi-store.test.ts is where that property
 *      is proven; this file only guards the count. `whatsapp-zimmer` declares a
 *      fourth, `bundle-whatsapp`, which renders only once that slug is enabled.
 *
 *   2. THE TOOL COUNTS. The capability tiers are now allow-lists in this file,
 *      derived from each upstream's tool-group definitions. If someone trims one
 *      by accident, the slug silently loses a tool. The numbers below are the
 *      ones the old per-container `*_ENABLED_TOOLGROUPS` produced — that is the
 *      whole point: the counts did not change, only who enforces them.
 *
 *   3. THE STATICS THE DEPLOY DEMANDS. Every `${NAME}` an ENABLED entry
 *      references is a name `render-spec` must resolve or the deploy dies —
 *      see PROVISIONED_STATICS below.
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

/**
 * THE PROVISIONING LEDGER: every `${NAME}` an ENABLED entry references, and
 * therefore every name a staging deploy must be able to resolve.
 *
 * This is not decoration. `render-spec` resolves an `env:`/`consoleEnv:` ref at
 * RENDER time and exits 1 on one it cannot find, so a single unseeded name does
 * not degrade one slug — it fails the spec and takes all forty-eight down. That is
 * the fail-loud property the store-backed deploy is built around, and it is
 * worth keeping; what it costs is that "declare the server" and "seed the
 * secret" are one atomic step, and a PR can only do the first half.
 *
 * So the second half is written down here. A name belongs on this list once it
 * is actually set in `/strad/staging/gateway/static/` (or the referencing
 * server's own `/strad/staging/mcp/<slug>/static/`). The assertion below is what
 * makes the two halves disagree loudly, in CI, instead of quietly, in the deploy
 * that runs after the merge.
 *
 * A name a server declared `mayBeUnseeded:` for is NOT on the ledger and is
 * subtracted before the comparison. That is the whole point of the waiver: the
 * deploy proceeds without it and the slug comes up `unconfigured`, so demanding
 * it here would reinstate the atomic step one layer up. `test/unseeded.test.ts`
 * is what holds the waiver itself honest — an entry naming a `${NAME}` its server
 * does not reference is a hard error, and an unwaived absent name still exits 1.
 *
 * The other way to ship a server ahead of its credential is `enabled: false` —
 * the telegram and pulse-subregistry entries are exactly that. It is the right
 * choice when the slug should not be listed or entitled at all yet; `mayBeUnseeded:`
 * is the right one when it should be visible and waiting.
 */
const PROVISIONED_STATICS = [
  "BILL_SPEND_API_TOKEN",
  "FETCHPET_PASSWORD",
  "FETCHPET_USERNAME",
  "GCAL_IMPERSONATE_EMAIL",
  "GCS_PULSEMCP_SERVICE_ACCOUNT_KEY_JSON",
  "GMAIL_IMPERSONATE_EMAIL",
  "GMAIL_TADAS_SERVICE_ACCOUNT_CLIENT_EMAIL",
  "GMAIL_TADAS_SERVICE_ACCOUNT_PRIVATE_KEY",
  "GOODEGGS_EMAIL",
  "GOODEGGS_PASSWORD",
  "GOOGLE_CALENDAR_TADAS_SERVICE_ACCOUNT_CLIENT_EMAIL",
  "GOOGLE_CALENDAR_TADAS_SERVICE_ACCOUNT_PRIVATE_KEY",
  "GOOGLE_DOCS_IMPERSONATE_EMAIL",
  "GOOGLE_DOCS_TADAS_SERVICE_ACCOUNT_CLIENT_EMAIL",
  "GOOGLE_DOCS_TADAS_SERVICE_ACCOUNT_PRIVATE_KEY",
  "MONARCH_SESSION_TOKEN",
  "OP_SERVICE_ACCOUNT_TOKEN_TADAS_RW",
  "POINTSYEAH_REFRESH_TOKEN",
  "SECRETS_ADMIN_KEY_JSON",
  "SECRETS_VIEWER_KEY_JSON",
  "SERPAPI_API_KEY",
  "SLACK_BOT_TOKEN",
  "TAILSCALE_API_KEY",
  "ZIMMER_SECRETS_ADMIN_KEY_JSON",
  "ZIMMER_SECRETS_VIEWER_KEY_JSON",
];

describe("staging config", () => {
  it("references no static that staging has not been seeded with", () => {
    // `bakedSecretNames` is the SAME function scripts/render-spec.ts derives its
    // `wanted` list from, so this compares the ledger against the deploy's own
    // demand rather than against a re-implementation of it. Both sides are
    // sorted; a diff names the offending variable.
    //
    // Two ways to fail, and the fix differs:
    //   - a name in the config, not in the ledger — the case that reddened
    //     `main` on 2026-08-14 (pulse-subregistry, run 31798910011). Either seed
    //     it and add it here, declare it `mayBeUnseeded:` on every server that
    //     references it, or ship the entry `enabled: false`.
    //   - a name in the ledger, not in the config — a stale entry, or a server
    //     that was disabled. Delete the line.
    const waived = waivedNames(CONFIG);
    expect(bakedSecretNames(CONFIG).filter((n) => !waived.has(n))).toEqual(
      PROVISIONED_STATICS,
    );
  });

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
      // The ledger, resolved — which is exactly what a deploy has to hand this
      // function, and one more reason the assertion above is worth having: this
      // render is only a proof of the topology if the two lists cannot drift.
      // appspec fails closed on an unresolved ref, and this test is not the
      // place to prove that.
      secrets: Object.fromEntries(
        PROVISIONED_STATICS.map((name) => [name, "x"]),
      ),
      // And the waived names, unseeded — what render-spec hands it for a
      // `mayBeUnseeded:` name the store does not hold yet (nutrition-facts'
      // optional FatSecret and FDC keys): omitted, not a render failure.
      unseededRefs: new Set(
        [...waivedNames(CONFIG).keys()].filter(
          (name) => !PROVISIONED_STATICS.includes(name),
        ),
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
    // The credentials of every upstream server staging gives a slug, unioned onto
    // the one box — and every one of them SECRET-typed, so App Platform encrypts
    // it at rest.
    // NODE_OPTIONS is the one name here that is neither a credential nor
    // STRAD_*: the heap ceiling, half of the 2 GB plan (#458). The liveness check
    // is the other half of that fix.
    expect(bundle.envs.find((e) => e.key === "NODE_OPTIONS")).toMatchObject({
      value: "--max-old-space-size=1024",
      type: "GENERAL",
    });
    expect(bundle.liveness_health_check?.http_path).toBe("/healthz");
    const credentials = bundle.envs.filter(
      (e) => !e.key.startsWith("STRAD_") && e.key !== "NODE_OPTIONS",
    );
    expect(credentials.some((e) => e.key === "SLACK_BOT_TOKEN")).toBe(true);
    expect(credentials.some((e) => e.key === "OP_SERVICE_ACCOUNT_TOKEN")).toBe(
      true,
    );
    expect(credentials.every((e) => e.type === "SECRET")).toBe(true);

    // And it is INSTRUMENTED. The collapsed container is the one this telemetry
    // exists for — it is where Chromium, `op` and forty-one servers share a
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

  it("every containerised server runs the ONE image, and only the second store and the two single-socket mounts leave the ONE bundle", () => {
    const supplementary = CONFIG.servers.filter(
      (s) => s.kind === "supplementary-image",
    );
    expect(supplementary.length).toBe(45);
    for (const server of supplementary) {
      expect(server.image).toBe(IMAGE);
      // ONE image, and one bundle for everything whose difference is
      // CAPABILITY. `zimmer-secrets` is the sole exception, and its difference
      // is a STORE — `process.env`, which a container has exactly one of.
      // `whatsapp-zimmer` is the other, and its difference is a SOCKET: one
      // linked device that a replica of the shared bundle would fight over.
      // The two Messenger slugs are the third, for the same reason: one
      // Messenger device connection. A new slug appearing here is another
      // billed component: justify it in this test or put it back in the bundle.
      const own: Record<string, string> = {
        "zimmer-secrets": "bundle-zimmer-secrets",
        "whatsapp-zimmer": "bundle-whatsapp",
        "messenger-tadas": "bundle-messenger",
        "messenger-tadas-admin": "bundle-messenger",
      };
      expect(server.bundle).toBe(own[server.slug] ?? "bundle");
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
    "slack-readonly": 8,
    "tailscale-readonly": 7,
    "monarch-money-readonly": 10,
    "gmail-ro": 5,
    "gmail-rw": 10,
    "google-docs-ro": 4,
    "google-docs-rw": 13,
    "google-calendar-ro": 4,
    "onepassword-ro": 5,
    "telegram-ro": 5,
    "messenger-tadas": 4,
    "bill-spend-ro": 4,
    "digitalocean-tadasant-ro": 19,
    "hetzner-pulse-ro": 14,
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
    // counts (gmail 11, docs 11, calendar 7, 1Password 9, slack 14, tailscale 15,
    // monarch 24) are asserted against the running image by the bundle's smoke test.
    "slack",
    "tailscale-readwrite",
    "monarch-money-readwrite",
    "gmail-rw-external",
    "google-docs-rw-external",
    "google-calendar-rw",
    "onepassword-rw",
    "telegram-rw",
    "bill-spend-rw",
    "digitalocean-tadasant-rw",
    "hetzner-pulse-rw",
  ])("%s is the full-capability tier (no policy)", (slug) => {
    const server = CONFIG.servers.find((s) => s.slug === slug);
    expect(server).toBeDefined();
    expect(server?.tools).toBeUndefined();
  });

  it("hetzner-pulse-ro allows exactly the Hetzner server's read tools, by name", () => {
    // A count cannot see a read swapped for a write — `list_volumes` out,
    // `delete_server` in is still fourteen, and policy:check passes it because
    // the tool exists. The project this token reaches runs another company's
    // production CI, so the names are pinned. They are
    // `toolNames(["readonly"])` in servers/hetzner/shared/src/tools.ts, which
    // that tree's own suite asserts against its annotations.
    const server = CONFIG.servers.find((s) => s.slug === "hetzner-pulse-ro");
    expect([...(server?.tools?.allow ?? [])].sort()).toEqual(
      [
        "list_servers",
        "get_server",
        "get_server_metrics",
        "list_server_actions",
        "get_action",
        "list_images",
        "list_server_types",
        "list_locations",
        "list_datacenters",
        "list_ssh_keys",
        "list_firewalls",
        "list_networks",
        "list_primary_ips",
        "list_volumes",
      ].sort(),
    );
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
      ["digitalocean-tadasant-ro", "digitalocean-tadasant-rw"],
      ["hetzner-pulse-ro", "hetzner-pulse-rw"],
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

      // AND THE SAME QUESTION OF THE OTHER STORE, because the justification
      // above is "two separate projects, EACH fenced again by its own namespace
      // list" — a claim with only one of the two fences asserted stays literally
      // true while the unasserted one is widened to the whole project. This one
      // is a list, and it is deliberately the PARENT of each documented leaf so
      // a per-server sibling is addressable under strict; what it must never
      // become is Zimmer's project root.
      // test/staging-config.multi-store.test.ts pins both halves of it.
      const zimmerSecrets = CONFIG.servers.find(
        (s) => s.slug === "zimmer-secrets",
      );
      if (zimmerSecrets?.kind !== "supplementary-image")
        throw new Error("expected a supplementary image");
      const zimmerFence = zimmerSecrets.env.SECRETS_NAMESPACES ?? "";
      expect(zimmerFence).toBe("/zimmer/staging/secrets/,/zimmer/staging/mcp/");
      for (const ns of zimmerFence.split(",")) {
        expect(ns.startsWith("/zimmer/staging/")).toBe(true);
      }
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
