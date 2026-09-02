import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import {
  APP_INSTANCE_SIZES,
  LEGACY_APP_INSTANCE_SIZES,
  isLegacyInstanceSize,
} from "../src/config/schema.ts";
import { parseImage, renderAppSpec } from "../src/deploy/appspec.ts";

const BASE = `
version: 1
gateway: { name: strad, env: prod }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
`;

function withBundleSize(slug: string): string {
  return `${BASE}
bundles:
  - { name: bundle-api, instanceSizeSlug: ${slug} }
servers:
  - { slug: bundled, kind: builtin, module: "./servers/echo.js", bundle: bundle-api, entitlements: [admin] }
`;
}

describe("instanceSizeSlug is a closed set", () => {
  it("rejects apps-s-1vcpu-512mb — the nonexistent plan that took prod down", () => {
    // It reads like a real name and is not one: the 512 MiB plan is
    // `apps-s-1vcpu-0.5gb`. Before this check, the value passed parseConfig,
    // passed check-config, rendered a spec, and failed at `doctl apps update`
    // with `unknown instance size "apps-s-1vcpu-512mb"` — after the merge.
    expect(() => parseConfig(withBundleSize("apps-s-1vcpu-512mb"))).toThrow(
      /unknown App Platform instance size "apps-s-1vcpu-512mb"/,
    );
  });

  it("names the valid options in the error, so the fix is in the message", () => {
    let message = "";
    try {
      parseConfig(withBundleSize("apps-s-1vcpu-512mb"));
    } catch (err) {
      message = (err as Error).message;
    }
    // The real name for the size the operator wanted, plus enough of the set
    // to pick from, plus where the set came from.
    expect(message).toContain("apps-s-1vcpu-0.5gb");
    expect(message).toContain("apps-d-8vcpu-32gb");
    expect(message).toContain("basic-xxs");
    expect(message).toContain(
      "https://docs.digitalocean.com/products/app-platform/details/pricing/",
    );
  });

  it("rejects an empty string and a non-string", () => {
    expect(() => parseConfig(withBundleSize('""'))).toThrow();
    expect(() => parseConfig(withBundleSize("512"))).toThrow();
  });

  it.each(APP_INSTANCE_SIZES)("accepts the current plan %s", (slug) => {
    const cfg = parseConfig(withBundleSize(slug));
    expect(cfg.bundles?.[0]?.instanceSizeSlug).toBe(slug);
  });

  it.each(LEGACY_APP_INSTANCE_SIZES)("accepts the legacy plan %s", (slug) => {
    // A legacy name is a name DigitalOcean has, on an app old enough to use it.
    // Rejecting one at parse time would make a valid config for such an app
    // unparseable; renderAppSpec warns about it instead.
    const cfg = parseConfig(withBundleSize(slug));
    expect(cfg.bundles?.[0]?.instanceSizeSlug).toBe(slug);
  });

  it("accepts apps-s-1vcpu-0.5gb — the live strad-prod bundle-internal size", () => {
    const cfg = parseConfig(withBundleSize("apps-s-1vcpu-0.5gb"));
    expect(cfg.bundles?.[0]?.instanceSizeSlug).toBe("apps-s-1vcpu-0.5gb");
  });

  it("defaults to apps-s-1vcpu-1gb when a bundle names no size", () => {
    const cfg = parseConfig(`${BASE}
bundles:
  - { name: bundle-api }
servers:
  - { slug: bundled, kind: builtin, module: "./servers/echo.js", bundle: bundle-api, entitlements: [admin] }
`);
    expect(cfg.bundles?.[0]?.instanceSizeSlug).toBe("apps-s-1vcpu-1gb");
  });

  it("has no slug in both the current and the legacy list", () => {
    const overlap = APP_INSTANCE_SIZES.filter((s) =>
      (LEGACY_APP_INSTANCE_SIZES as readonly string[]).includes(s),
    );
    expect(overlap).toEqual([]);
  });

  it("isLegacyInstanceSize splits the two lists and nothing else", () => {
    for (const slug of LEGACY_APP_INSTANCE_SIZES) {
      expect(isLegacyInstanceSize(slug)).toBe(true);
    }
    for (const slug of APP_INSTANCE_SIZES) {
      expect(isLegacyInstanceSize(slug)).toBe(false);
    }
    expect(isLegacyInstanceSize("apps-s-1vcpu-512mb")).toBe(false);
  });
});

describe("renderAppSpec warns about a legacy plan", () => {
  function render(cfg: ReturnType<typeof parseConfig>) {
    const warnings: string[] = [];
    const spec = renderAppSpec({
      config: cfg,
      appName: "strad-prod",
      region: "nyc",
      image: parseImage("ghcr.io/tadasant/strad:sha-abc"),
      env: [],
      onWarning: (m) => warnings.push(m),
    });
    return { spec, warnings };
  }

  it("names the component and the slug — both apps postdate 7 May 2024", () => {
    const { spec, warnings } = render(
      parseConfig(withBundleSize("professional-xs")),
    );
    expect(
      spec.services.find((s) => s.name === "bundle-api")?.instance_size_slug,
    ).toBe("professional-xs");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("bundle-api (professional-xs)");
    expect(warnings[0]).toContain("before 7 May 2024");
  });

  it("stays silent on a current plan", () => {
    const { spec, warnings } = render(
      parseConfig(withBundleSize("apps-s-1vcpu-0.5gb")),
    );
    expect(
      spec.services.find((s) => s.name === "bundle-api")?.instance_size_slug,
    ).toBe("apps-s-1vcpu-0.5gb");
    expect(warnings).toEqual([]);
  });
});
