import { CORE_URL_ENV } from "../src/secrets/param-route.ts";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { parseImage, renderAppSpec } from "../src/deploy/appspec.ts";

/**
 * fetchpet and pointsyeah join good-eggs as `supplementary-image` browser
 * bundles. strad's schema enforces ONE image per bundle, so each owns its own
 * component — they are a FAMILY of 1GB Chromium bundles, not a shared one. These
 * tests pin that contract: two coexisting internal-only components, credentials
 * scoped to each, and the `enabled: false` staging default emitting no component.
 */

const YAML = `
version: 1
gateway: { name: strad, env: staging }
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle-fetchpet
    instanceSizeSlug: apps-s-1vcpu-1gb
  - name: bundle-pointsyeah
    instanceSizeSlug: apps-s-1vcpu-1gb
servers:
  - slug: fetchpet
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-server-fetchpet:latest
    bundle: bundle-fetchpet
    entitlements: [admin]
    timeoutMs: 180000
    env:
      FETCHPET_USERNAME: "\${FETCHPET_USERNAME}"
      FETCHPET_PASSWORD: "\${FETCHPET_PASSWORD}"
  - slug: pointsyeah
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-server-pointsyeah:latest
    bundle: bundle-pointsyeah
    entitlements: [admin]
    timeoutMs: 180000
    env:
      POINTSYEAH_REFRESH_TOKEN: "\${POINTSYEAH_REFRESH_TOKEN}"
`;

const SECRETS = {
  FETCHPET_USERNAME: "pets@example.com",
  FETCHPET_PASSWORD: "s3cr3t",
  POINTSYEAH_REFRESH_TOKEN: "cognito-refresh-token",
};

function render(yaml = YAML, secrets: Record<string, string> = SECRETS) {
  return renderAppSpec({
    config: parseConfig(yaml),
    appName: "strad-staging",
    region: "nyc",
    image: parseImage("registry.digitalocean.com/strad/strad:0.1.0"),
    env: [
      { key: "STRAD_TOKENS", value: "tok", scope: "RUN_TIME", type: "SECRET" },
    ],
    secrets,
  });
}

describe("renderAppSpec: browser supplementary images (fetchpet + pointsyeah)", () => {
  it("emits both as coexisting internal-only 1GB components", () => {
    const spec = render();
    for (const [name, repo] of [
      ["bundle-fetchpet", "strad-server-fetchpet"],
      ["bundle-pointsyeah", "strad-server-pointsyeah"],
    ] as const) {
      const bundle = spec.services.find((s) => s.name === name);
      expect(bundle, name).toBeDefined();
      // Internal-only: internal_ports and NO http_port (both is an API error).
      expect(bundle!.internal_ports).toEqual([8080]);
      expect(bundle!.http_port).toBeUndefined();
      expect(bundle!.instance_size_slug).toBe("apps-s-1vcpu-1gb");
      expect(bundle!.image).toMatchObject({
        registry_type: "GHCR",
        registry: "tadasant",
        repository: repo,
        tag: "latest",
      });
    }
  });

  it("scopes each server's credentials onto its own bundle as SECRETs", () => {
    const spec = render();

    const fetchpet = spec.services.find((s) => s.name === "bundle-fetchpet")!;
    const fetchpetEnv = Object.fromEntries(
      fetchpet.envs.map((e) => [e.key, e]),
    );
    expect(fetchpetEnv.FETCHPET_USERNAME).toMatchObject({
      value: "pets@example.com",
      type: "SECRET",
    });
    expect(fetchpetEnv.FETCHPET_PASSWORD).toMatchObject({ type: "SECRET" });

    const pointsyeah = spec.services.find(
      (s) => s.name === "bundle-pointsyeah",
    )!;
    const pointsyeahEnv = Object.fromEntries(
      pointsyeah.envs.map((e) => [e.key, e]),
    );
    expect(pointsyeahEnv.POINTSYEAH_REFRESH_TOKEN).toMatchObject({
      value: "cognito-refresh-token",
      type: "SECRET",
    });

    // No literal secret ref survives into a bundle's env.
    //
    // APP PLATFORM COMPONENT BINDINGS ARE NOT SECRET REFS and both directions
    // of them are legitimate: core carries ${bundle-*.PRIVATE_URL} to proxy
    // /mcp, and every non-core component carries ${core.PRIVATE_URL} for the
    // parameter write-back route. App Platform substitutes both at deploy time.
    // What must never survive is a strad `${SECRET}` the RENDERER was supposed
    // to resolve, so the check excludes the one key that is a binding by
    // construction.
    for (const bundle of [fetchpet, pointsyeah]) {
      expect(
        bundle.envs
          .filter((e) => e.key !== CORE_URL_ENV)
          .some((e) => e.value.includes("${")),
      ).toBe(false);
    }
    expect(
      fetchpet.envs.some((e) => e.key === "POINTSYEAH_REFRESH_TOKEN"),
    ).toBe(false);
    const core = spec.services.find((s) => s.name === "core")!;
    expect(core.envs.some((e) => e.key === "FETCHPET_PASSWORD")).toBe(false);
    expect(core.envs.some((e) => e.key === "POINTSYEAH_REFRESH_TOKEN")).toBe(
      false,
    );
  });

  it("binds each bundle's private URL into the core", () => {
    const spec = render();
    const core = spec.services.find((s) => s.name === "core")!;
    expect(
      core.envs.find((e) => e.key === "STRAD_BUNDLE_URL_BUNDLE_FETCHPET")
        ?.value,
    ).toBe("${bundle-fetchpet.PRIVATE_URL}");
    expect(
      core.envs.find((e) => e.key === "STRAD_BUNDLE_URL_BUNDLE_POINTSYEAH")
        ?.value,
    ).toBe("${bundle-pointsyeah.PRIVATE_URL}");
  });

  it("omits a disabled server's component and demands none of its secrets", () => {
    // The staging default: registered but enabled:false until creds are seeded
    // downstream. A disabled supplementary image must emit no component — and,
    // crucially, render with NO secrets at all (nothing to resolve).
    const disabled = YAML.replace(
      "bundle: bundle-fetchpet\n    entitlements: [admin]",
      "bundle: bundle-fetchpet\n    enabled: false\n    entitlements: [admin]",
    );
    // fetchpet is disabled (its secrets are never demanded); pointsyeah stays
    // enabled, so only its secret is supplied.
    const spec = render(disabled, {
      POINTSYEAH_REFRESH_TOKEN: SECRETS.POINTSYEAH_REFRESH_TOKEN,
    });
    expect(
      spec.services.find((s) => s.name === "bundle-fetchpet"),
    ).toBeUndefined();
    // pointsyeah is still enabled, so it still needs its secret.
    expect(
      spec.services.find((s) => s.name === "bundle-pointsyeah"),
    ).toBeDefined();
  });
});
