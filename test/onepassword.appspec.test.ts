import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { parseImage, renderAppSpec } from "../src/deploy/appspec.ts";

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
    // The literal ref must NOT survive into the spec.
    expect(bundle.envs.some((e) => e.value.includes("${"))).toBe(false);

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
