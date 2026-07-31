import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { renderAppSpec, parseImage } from "../src/deploy/appspec.ts";

/**
 * Two servers, one env key, two different values.
 *
 * A component's environment is ONE flat namespace, and both merges that build it
 * are last-wins. Nothing detected the conflict, so the second declaration
 * silently replaced the first and a container read a value belonging to another
 * slug. Both shapes below parsed and rendered with zero validation errors.
 *
 * ## The asymmetry, which is the whole rule
 *
 * A bundle is a component is a container is one `process.env`, and `bundles:` is
 * a list. So the two maps have DIFFERENT collision scopes:
 *
 *   `env:`        collides only WITHIN a bundle — two bundles are two containers,
 *                 each reading its own. Bare `SECRETS_*` names are fine there.
 *   `consoleEnv:` collides GLOBALLY — every enabled server's map merges into the
 *                 single `core` component, so a name there must be
 *                 slug-namespaced whatever bundle the server is on.
 *
 * Getting that backwards in either direction is the failure. Declaring a second
 * parameter store's `consoleEnv:` with bare names renders `/ui/secrets` showing
 * strad's project while holding the OTHER store's admin service account — a
 * working-looking page pointed at the wrong identity. Putting two secrets slugs
 * in one bundle hands that container the wrong store under strad's own slug.
 *
 * The rule is "same key, DIFFERENT value", not "same key". Declaring one key
 * identically on several slugs is the capability-variant pattern working as
 * designed: `gmail-ro` and `gmail-rw` repeat their whole `env:` on purpose,
 * because putting the credential on only one of them means disabling THAT one
 * strips it from its sibling.
 */

const HEAD = `
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles:
  - name: bundle
  - name: bundle-two
servers:
`;

/** One supplementary server, with whatever maps the case needs. */
function server(opts: {
  slug: string;
  bundle?: string;
  path?: string;
  enabled?: boolean;
  env?: Record<string, string>;
  consoleEnv?: Record<string, string>;
}): string {
  const map = (name: string, values?: Record<string, string>): string =>
    values && Object.keys(values).length
      ? `    ${name}:\n` +
        Object.entries(values)
          .map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`)
          .join("\n") +
        "\n"
      : "";
  return (
    `  - slug: ${opts.slug}\n` +
    `    kind: supplementary-image\n` +
    `    image: ghcr.io/tadasant/strad-bundle:1.0.0\n` +
    `    bundle: ${opts.bundle ?? "bundle"}\n` +
    `    path: ${opts.path ?? `/${opts.slug}`}\n` +
    `    entitlements: [admin]\n` +
    (opts.enabled === false ? `    enabled: false\n` : "") +
    map("env", opts.env) +
    map("consoleEnv", opts.consoleEnv)
  );
}

const parse = (...servers: string[]) => parseConfig(HEAD + servers.join(""));

describe("env: collides within a bundle, and only within a bundle", () => {
  it("rejects two servers claiming one key with different values", () => {
    expect(() =>
      parse(
        server({ slug: "gcs", env: { GCS_BUCKET: "public" } }),
        server({ slug: "gcs-private", env: { GCS_BUCKET: "private" } }),
      ),
    ).toThrow(/both declare GCS_BUCKET under env:/);
  });

  it("names both servers, the key, why it matters, and the fix", () => {
    // The message has to be actionable without reading appspec.ts.
    let message = "";
    try {
      parse(
        server({ slug: "secrets", env: { SECRETS_PROJECT_ID: "strad-store" } }),
        server({
          slug: "zimmer-secrets",
          env: { SECRETS_PROJECT_ID: "zimmer-store" },
        }),
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('"secrets"');
    expect(message).toContain('"zimmer-secrets"');
    expect(message).toContain("SECRETS_PROJECT_ID");
    expect(message).toContain('share the "bundle" bundle');
    expect(message).toContain("one bundle is one container");
    expect(message).toContain("ZIMMER_SECRETS_SECRETS_PROJECT_ID");
  });

  it("allows BARE names on separate bundles — two containers, two environments", () => {
    // THE case the rule must not over-reach on. A second parameter store gets its
    // own `bundle:`, and its container then reads its own bare SECRETS_* names.
    // Rejecting this would forbid the correct configuration.
    const cfg = parse(
      server({
        slug: "secrets",
        path: "/secrets",
        env: { SECRETS_PROJECT_ID: "strad-store" },
      }),
      server({
        slug: "zimmer-secrets",
        bundle: "bundle-two",
        path: "/secrets",
        env: { SECRETS_PROJECT_ID: "zimmer-store" },
      }),
    );
    expect(cfg.servers).toHaveLength(2);
  });

  it("allows the SAME value in one bundle — the capability-variant pattern", () => {
    const cfg = parse(
      server({ slug: "gmail-ro", env: { GMAIL_TOKEN: "${T}" } }),
      server({ slug: "gmail-rw", env: { GMAIL_TOKEN: "${T}" } }),
    );
    expect(cfg.servers).toHaveLength(2);
  });

  it("ignores a DISABLED server — strad mounts nothing for it", () => {
    const cfg = parse(
      server({ slug: "gcs", env: { GCS_BUCKET: "public" } }),
      server({
        slug: "gcs-old",
        enabled: false,
        env: { GCS_BUCKET: "retired" },
      }),
    );
    expect(cfg.servers).toHaveLength(2);
  });
});

describe("consoleEnv: collides globally — core is one environment", () => {
  it("rejects two servers claiming one key with different values", () => {
    expect(() =>
      parse(
        server({ slug: "secrets", consoleEnv: { SECRETS_PROJECT_ID: "a" } }),
        server({
          slug: "secrets-two",
          consoleEnv: { SECRETS_PROJECT_ID: "b" },
        }),
      ),
    ).toThrow(/both declare SECRETS_PROJECT_ID under consoleEnv:/);
  });

  it("a different bundle is NO escape — this is the asymmetry", () => {
    // The same pair that is legal under `env:` on two bundles (above) is illegal
    // under `consoleEnv:`, because consoleEnvVars() merges every enabled server's
    // map into the ONE core component regardless of bundle. Encoding both halves
    // is the point: bare names are right for `env:` and wrong for `consoleEnv:`.
    expect(() =>
      parse(
        server({
          slug: "secrets",
          consoleEnv: { SECRETS_PROJECT_ID: "strad-store" },
        }),
        server({
          slug: "zimmer-secrets",
          bundle: "bundle-two",
          consoleEnv: { SECRETS_PROJECT_ID: "zimmer-store" },
        }),
      ),
    ).toThrow(/merged into the core component's one environment/);
  });

  it("accepts the slug-namespaced spelling, which is the remedy", () => {
    // src/ui/resolve.ts's withNamespacedFallback() maps this back down to the
    // bare name for THAT slug alone, so the console still resolves it.
    const cfg = parse(
      server({
        slug: "secrets",
        consoleEnv: { SECRETS_PROJECT_ID: "strad-store" },
      }),
      server({
        slug: "zimmer-secrets",
        bundle: "bundle-two",
        consoleEnv: { ZIMMER_SECRETS_SECRETS_PROJECT_ID: "zimmer-store" },
      }),
    );
    expect(cfg.servers).toHaveLength(2);
  });

  it("allows the same value", () => {
    const cfg = parse(
      server({ slug: "secrets", consoleEnv: { SECRETS_LOCATION: "global" } }),
      server({
        slug: "secrets-two",
        consoleEnv: { SECRETS_LOCATION: "global" },
      }),
    );
    expect(cfg.servers).toHaveLength(2);
  });
});

/**
 * The fact the validation is scoped against, asserted directly rather than
 * assumed — because it was asserted the other way once, and a rule built on a
 * wrong premise either forbids the correct config or permits the broken one.
 */
describe("a bundle is a container: the premise the scoping rests on", () => {
  const cfg = parse(
    server({
      slug: "secrets",
      path: "/secrets",
      env: { SECRETS_PROJECT_ID: "strad-store" },
    }),
    server({
      slug: "zimmer-secrets",
      bundle: "bundle-two",
      path: "/secrets",
      env: { SECRETS_PROJECT_ID: "zimmer-store" },
    }),
  );

  const spec = renderAppSpec({
    config: cfg,
    appName: "strad-test",
    region: "nyc",
    image: parseImage("ghcr.io/tadasant/strad:0.1.0"),
    env: [],
  });

  const envOf = (name: string): Record<string, string> =>
    Object.fromEntries(
      spec.services
        .find((s) => s.name === name)!
        .envs.map((e) => [e.key, e.value]),
    );

  it("renders one component per bundle", () => {
    expect(spec.services.map((s) => s.name).sort()).toEqual([
      "bundle",
      "bundle-two",
      "core",
    ]);
  });

  it("gives each component its OWN value for the same bare key", () => {
    // `imageBundles` is keyed by `server.bundle`, so the two env maps never meet.
    // This is why the `env:` rule is per-bundle rather than global.
    expect(envOf("bundle").SECRETS_PROJECT_ID).toBe("strad-store");
    expect(envOf("bundle-two").SECRETS_PROJECT_ID).toBe("zimmer-store");
  });

  it("binds a distinct private URL per bundle, so one `path:` reaches two containers", () => {
    // registry.ts resolves `base = privateUrlFor(server.bundle, env)` and only
    // THEN appends `server.path`. Two slugs sharing `path: /secrets` on two
    // bundles therefore address two different containers — which is what makes
    // bare `env:` names correct across bundles.
    const core = envOf("core");
    expect(core.STRAD_BUNDLE_URL_BUNDLE).toBe("${bundle.PRIVATE_URL}");
    expect(core.STRAD_BUNDLE_URL_BUNDLE_TWO).toBe("${bundle-two.PRIVATE_URL}");
  });
});
