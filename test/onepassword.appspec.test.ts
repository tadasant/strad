import { CORE_URL_ENV } from "../src/secrets/param-route.ts";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { parseImage, renderAppSpec } from "../src/deploy/appspec.ts";
import { applyEnvCopies } from "../src/secrets/env-prefix.ts";

/**
 * onepassword is a `supplementary-image` server, like good-eggs: its own
 * internal App Platform component, built from its own ghcr image, with its
 * credential landing on THAT component only. It also carries a non-secret
 * config knob in the same `env:` map — ENABLED_TOOLGROUPS, the read-only vs
 * read-write lever — which must ride onto the bundle the same way. These tests
 * pin the deploy contract downstream (tadasant-internal) relies on.
 */

const YAML = `
version: 1
gateway: { name: strad, env: staging }
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle-onepassword
    instanceSizeSlug: apps-s-1vcpu-0.5gb
servers:
  - slug: onepassword
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-server-onepassword:latest
    bundle: bundle-onepassword
    entitlements: [admin]
    timeoutMs: 120000
    env:
      OP_SERVICE_ACCOUNT_TOKEN: "\${OP_SERVICE_ACCOUNT_TOKEN}"
      ENABLED_TOOLGROUPS: "readonly"
`;

const CONFIG = parseConfig(YAML);

function render(secrets?: Record<string, string>) {
  return renderAppSpec({
    config: CONFIG,
    appName: "strad-staging",
    region: "nyc",
    image: parseImage("registry.digitalocean.com/strad/strad:0.1.0"),
    env: [
      { key: "STRAD_TOKENS", value: "tok", scope: "RUN_TIME", type: "SECRET" },
    ],
    secrets: secrets ?? {
      OP_SERVICE_ACCOUNT_TOKEN: "ops_example_token",
    },
  });
}

describe("renderAppSpec: supplementary-image (onepassword)", () => {
  it("emits an internal-only bundle component from the ghcr image", () => {
    const spec = render();
    const bundle = spec.services.find((s) => s.name === "bundle-onepassword");
    expect(bundle).toBeDefined();
    // Internal-only: internal_ports and NO http_port (both is an API error).
    expect(bundle!.internal_ports).toEqual([8080]);
    expect(bundle!.http_port).toBeUndefined();
    expect(bundle!.health_check).toBeUndefined();
    expect(bundle!.instance_size_slug).toBe("apps-s-1vcpu-0.5gb");
    expect(bundle!.image).toEqual({
      registry_type: "GHCR",
      registry: "tadasant",
      repository: "strad-server-onepassword",
      tag: "latest",
    });
  });

  it("resolves the token onto the bundle only, and passes the RO/RW knob through", () => {
    const spec = render();
    const bundle = spec.services.find((s) => s.name === "bundle-onepassword")!;
    const byKey = Object.fromEntries(bundle.envs.map((e) => [e.key, e]));

    expect(byKey.OP_SERVICE_ACCOUNT_TOKEN).toMatchObject({
      value: "ops_example_token",
      type: "SECRET",
    });
    // The read-only lever is a literal in the same env map; it must survive
    // verbatim so downstream can ship one image as onepassword-ro / -rw.
    expect(byKey.ENABLED_TOOLGROUPS).toMatchObject({ value: "readonly" });
    // The literal ref must NOT survive into the spec. ${core.PRIVATE_URL} is
    // excluded: it is an App Platform component binding, not a strad secret ref,
    // and App Platform substitutes it at deploy time (see appspec.ts).
    expect(
      bundle.envs
        .filter((e) => e.key !== CORE_URL_ENV)
        .some((e) => e.value.includes("${")),
    ).toBe(false);

    // And the credential must not have leaked onto the public core component.
    const core = spec.services.find((s) => s.name === "core")!;
    expect(core.envs.some((e) => e.key === "OP_SERVICE_ACCOUNT_TOKEN")).toBe(
      false,
    );
  });

  it("binds the bundle's private URL into the core", () => {
    const spec = render();
    const core = spec.services.find((s) => s.name === "core")!;
    const urlEnv = core.envs.find(
      (e) => e.key === "STRAD_BUNDLE_URL_BUNDLE_ONEPASSWORD",
    );
    expect(urlEnv?.value).toBe("${bundle-onepassword.PRIVATE_URL}");
  });

  it("fails closed when a referenced secret is absent", () => {
    expect(() => render({})).toThrow(/unresolved secret reference/);
  });
});

/**
 * SEVERAL 1PASSWORD ACCOUNTS ON ONE BUNDLE — the shape that replaces Zimmer's
 * six npx entries. One process holds one bare OP_SERVICE_ACCOUNT_TOKEN, so the
 * slugs sharing `/onepassword` read that, and every slug with a token of its own
 * sits on `path: /<its own slug>`, where the bundle host mounts an instance
 * holding exactly the token baked under `<SLUG>__OP_SERVICE_ACCOUNT_TOKEN`.
 */
describe("renderAppSpec: one bundle, several 1Password tokens", () => {
  /**
   * An own-path slug writes its keys ALREADY per-slug. The schema refuses two
   * slugs on one bundle declaring one bare name with different values, whether
   * or not each is its own instance, so the alias is written by hand: exactly
   * the name the bundle host discovers the mount on, and no bare name at all.
   */
  const prefix = (slug: string) => slug.toUpperCase().replace(/-/g, "_") + "__";
  const entry = (
    slug: string,
    path: string,
    token: string,
    extra: Record<string, string> = {},
  ) => {
    const own = path === `/${slug}` ? prefix(slug) : "";
    const vars = { OP_SERVICE_ACCOUNT_TOKEN: `"\${${token}}"`, ...extra };
    return `
  - slug: ${slug}
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: ${path}
    entitlements: [admin]
    confirmations: true
    timeoutMs: 240000
    env:${Object.entries(vars)
      .map(([k, v]) => `\n      ${own}${k}: ${v}`)
      .join("")}`;
  };

  const MULTI = parseConfig(`
version: 1
gateway:
  name: strad
  env: staging
  elicitation:
    allowedUrlPrefixes: [https://zimmer.example/api/v1/elicitations/session/]
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle
servers:${[
    entry(
      "onepassword-ro",
      "/onepassword",
      "OP_SERVICE_ACCOUNT_TOKEN_TADAS_RW",
    ),
    entry(
      "onepassword-rw",
      "/onepassword",
      "OP_SERVICE_ACCOUNT_TOKEN_TADAS_RW",
    ),
    entry(
      "onepassword-tadas-all",
      "/onepassword-tadas-all",
      "OP_SERVICE_ACCOUNT_TOKEN_TADAS_ALL",
    ),
    entry(
      "onepassword-pulsemcp-ro",
      "/onepassword-pulsemcp-ro",
      "OP_SERVICE_ACCOUNT_TOKEN_PULSEMCP",
    ),
    entry(
      "onepassword-pulsemcp-rw",
      "/onepassword-pulsemcp-rw",
      "OP_SERVICE_ACCOUNT_TOKEN_PULSEMCP",
    ),
    entry(
      "onepassword-pulsemcp-provisioning",
      "/onepassword-pulsemcp-provisioning",
      "OP_SERVICE_ACCOUNT_TOKEN_PULSEMCP",
      { OP_ELICITATION_WRITE: '"false"' },
    ),
  ].join("")}
`);

  const spec = renderAppSpec({
    config: MULTI,
    appName: "strad-staging",
    region: "nyc",
    image: parseImage("registry.digitalocean.com/strad/strad:0.1.0"),
    env: [
      { key: "STRAD_TOKENS", value: "tok", scope: "RUN_TIME", type: "SECRET" },
    ],
    secrets: {
      OP_SERVICE_ACCOUNT_TOKEN_TADAS_RW: "ops_tadas_rw",
      OP_SERVICE_ACCOUNT_TOKEN_TADAS_ALL: "ops_tadas_all",
      OP_SERVICE_ACCOUNT_TOKEN_PULSEMCP: "ops_pulsemcp",
    },
  });
  const bundles = spec.services.filter((s) => s.name.startsWith("bundle"));
  // The environment the host sees: the spec, with STRAD_ENV_COPIES restored.
  const env: Record<string, string | undefined> = Object.fromEntries(
    bundles[0]!.envs.map((e) => [e.key, e.value]),
  );
  applyEnvCopies(env);

  it("is still ONE component", () => {
    expect(bundles.map((b) => b.name)).toEqual(["bundle"]);
  });

  it("gives the bare token to the slugs sharing /onepassword", () => {
    expect(env.OP_SERVICE_ACCOUNT_TOKEN).toBe("ops_tadas_rw");
  });

  it("bakes each own-path slug's token under its own name", () => {
    expect(env.ONEPASSWORD_TADAS_ALL__OP_SERVICE_ACCOUNT_TOKEN).toBe(
      "ops_tadas_all",
    );
    expect(env.ONEPASSWORD_PULSEMCP_RO__OP_SERVICE_ACCOUNT_TOKEN).toBe(
      "ops_pulsemcp",
    );
    expect(env.ONEPASSWORD_PULSEMCP_RW__OP_SERVICE_ACCOUNT_TOKEN).toBe(
      "ops_pulsemcp",
    );
    expect(
      env.ONEPASSWORD_PULSEMCP_PROVISIONING__OP_SERVICE_ACCOUNT_TOKEN,
    ).toBe("ops_pulsemcp");
  });

  it("names the provisioning posture under that slug, where the host reads it, and nowhere else", () => {
    expect(env.ONEPASSWORD_PULSEMCP_PROVISIONING__OP_ELICITATION_WRITE).toBe(
      "false",
    );
    expect(env.ONEPASSWORD_PULSEMCP_RW__OP_ELICITATION_WRITE).toBeUndefined();
    expect(env.OP_ELICITATION_WRITE).toBeUndefined();
  });

  it("the renderer's own alias of a hand-written one is a name the host cannot mistake for a slug", () => {
    // ONEPASSWORD_TADAS_ALL__ONEPASSWORD_TADAS_ALL__OP_SERVICE_ACCOUNT_TOKEN: its
    // head would unmangle to a slug containing `--`, which has no prefix, so the
    // host's discovery skips it. Pinned so a change to that rule is noticed here.
    const doubled = Object.keys(env).filter((k) =>
      /__.*__OP_SERVICE_ACCOUNT_TOKEN$/.test(k),
    );
    expect(doubled.length).toBeGreaterThan(0);
    for (const key of doubled) expect(key.split("__").length).toBe(3);
  });

  it("refuses a second token on the SHARED path, which one mount cannot hold", () => {
    expect(() =>
      parseConfig(`
version: 1
gateway: { name: strad, env: staging }
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle
servers:${entry("onepassword-rw", "/onepassword", "A")}${entry("onepassword-tadas-all", "/onepassword", "B")}
`),
    ).toThrow(/OP_SERVICE_ACCOUNT_TOKEN under env: with different values/);
  });
});
