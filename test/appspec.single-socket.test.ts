import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { renderAppSpec, SINGLE_SOCKET_PATHS } from "../src/deploy/appspec.ts";

/**
 * A WhatsApp linked device is ONE socket: two replicas of the component that
 * holds it kick each other off and both write its Signal state. The renderer
 * refuses that topology, so it is a failed render rather than an account that
 * flaps between two containers.
 */

const IMAGE = {
  registry_type: "GHCR" as const,
  registry: "tadasant",
  repository: "strad",
  tag: "latest",
};

const config = (bundle: string, extra = "") => `
version: 1
gateway: { name: strad, env: staging }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles:
${bundle}servers:
  - slug: whatsapp-zimmer
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle-whatsapp
    path: /whatsapp
    entitlements: [admin]
${extra}`;

const render = (yaml: string) =>
  renderAppSpec({
    config: parseConfig(yaml),
    appName: "strad-staging",
    region: "nyc",
    image: IMAGE,
    env: [],
  });

describe("single-socket mounts", () => {
  it("names /whatsapp", () => {
    expect(SINGLE_SOCKET_PATHS).toContain("/whatsapp");
  });

  it("renders the bridge's own component at one instance", () => {
    const spec = render(config("  - name: bundle-whatsapp\n"));
    expect(
      spec.services.find((s) => s.name === "bundle-whatsapp")?.instance_count,
    ).toBe(1);
  });

  it("refuses two instances of the component holding the socket", () => {
    expect(() =>
      render(config("  - name: bundle-whatsapp\n    instanceCount: 2\n")),
    ).toThrow(/instance_count 2.*whatsapp-zimmer \(\/whatsapp\)/s);
  });

  it("ignores a disabled server", () => {
    expect(() =>
      render(
        config(
          "  - name: bundle-whatsapp\n    instanceCount: 2\n",
          "    enabled: false\n",
        ) +
          `  - slug: other
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle-whatsapp
    path: /slack
    entitlements: [admin]
`,
      ),
    ).not.toThrow();
  });
});
