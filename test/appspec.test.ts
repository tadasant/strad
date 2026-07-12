import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { parseImage, renderAppSpec } from "../src/deploy/appspec.ts";

/**
 * A `supplementary-image` server becomes its own internal App Platform
 * component, and its credentials must land on THAT component only. good-eggs is
 * the first real one; these tests pin the contract the deploy relies on.
 */

const YAML = `
version: 1
gateway: { name: strad, env: staging }
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle-goodeggs
    instanceSizeSlug: apps-s-1vcpu-1gb
servers:
  - slug: good-eggs
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-server-good-eggs:latest
    bundle: bundle-goodeggs
    entitlements: [admin]
    timeoutMs: 120000
    env:
      GOODEGGS_EMAIL: "\${GOODEGGS_EMAIL}"
      GOODEGGS_PASSWORD: "\${GOODEGGS_PASSWORD}"
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
      GOODEGGS_EMAIL: "tadas412@gmail.com",
      GOODEGGS_PASSWORD: "s3cr3t",
    },
  });
}

describe("renderAppSpec: supplementary-image (good-eggs)", () => {
  it("emits an internal-only bundle component from the ghcr image", () => {
    const spec = render();
    const bundle = spec.services.find((s) => s.name === "bundle-goodeggs");
    expect(bundle).toBeDefined();
    // Internal-only: internal_ports and NO http_port (both is an API error).
    expect(bundle!.internal_ports).toEqual([8080]);
    expect(bundle!.http_port).toBeUndefined();
    expect(bundle!.health_check).toBeUndefined();
    expect(bundle!.instance_size_slug).toBe("apps-s-1vcpu-1gb");
    expect(bundle!.image).toEqual({
      registry_type: "GHCR",
      registry: "tadasant",
      repository: "strad-server-good-eggs",
      tag: "latest",
    });
  });

  it("resolves credentials onto the bundle only, as SECRETs", () => {
    const spec = render();
    const bundle = spec.services.find((s) => s.name === "bundle-goodeggs")!;
    const byKey = Object.fromEntries(bundle.envs.map((e) => [e.key, e]));

    expect(byKey.GOODEGGS_EMAIL).toMatchObject({
      value: "tadas412@gmail.com",
      type: "SECRET",
    });
    expect(byKey.GOODEGGS_PASSWORD).toMatchObject({
      value: "s3cr3t",
      type: "SECRET",
    });
    // The literal ref must NOT survive into the spec.
    expect(bundle.envs.some((e) => e.value.includes("${"))).toBe(false);

    // And the credential must not have leaked onto the public core component.
    const core = spec.services.find((s) => s.name === "core")!;
    expect(core.envs.some((e) => e.key === "GOODEGGS_PASSWORD")).toBe(false);
  });

  it("binds the bundle's private URL into the core", () => {
    const spec = render();
    const core = spec.services.find((s) => s.name === "core")!;
    const urlEnv = core.envs.find(
      (e) => e.key === "STRAD_BUNDLE_URL_BUNDLE_GOODEGGS",
    );
    expect(urlEnv?.value).toBe("${bundle-goodeggs.PRIVATE_URL}");
  });

  it("fails closed when a referenced secret is absent", () => {
    expect(() => render({})).toThrow(/unresolved secret reference/);
  });
});
