import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { parseImage, renderAppSpec } from "../src/deploy/appspec.ts";
import {
  bakedSecretNames,
  supplementaryEnvNames,
  tailnetSecretNames,
} from "../src/deploy/preflight.ts";

/**
 * A bundle's `tailnet:` block: where the key lands, and where it does not.
 *
 * The key joins a node to Tadas's tailnet. It belongs on the ONE component
 * whose host starts `tailscaled` — never on core, never on a sibling bundle,
 * never in the broadcast — and the block is the only way to put it there.
 */

const KEY = "tskey-client-kTEST-SECRETVALUE";

function config(tailnet: string, extra = "") {
  return parseConfig(`
version: 1
gateway:
  name: strad
  env: prod
auth:
  staticTokens: { enabled: true, store: env }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle
${tailnet}
  - name: bundle-other
${extra}
servers:
  - slug: good-eggs
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /good-eggs
    entitlements: [admin]
  - slug: shop
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-server-shop:latest
    bundle: bundle-other
    entitlements: [admin]
`);
}

const BLOCK = `    tailnet:
      authKey: "\${STRAD_TAILNET_OAUTH_CLIENT_SECRET}"
      tags: [tag:strad]`;

function render(
  cfg: ReturnType<typeof config>,
  secrets: Record<string, string> = { STRAD_TAILNET_OAUTH_CLIENT_SECRET: KEY },
) {
  return renderAppSpec({
    config: cfg,
    appName: "strad-prod",
    region: "nyc",
    image: parseImage("ghcr.io/tadasant/strad:0.1.0"),
    env: [],
    secrets,
  });
}

function envOf(spec: ReturnType<typeof render>, component: string) {
  return Object.fromEntries(
    spec.services
      .find((s) => s.name === component)!
      .envs.map((e) => [e.key, e]),
  );
}

describe("tailnet: on a bundle", () => {
  it("puts the resolved key, the tags and a hostname on that component only, the key as a SECRET", () => {
    const spec = render(config(BLOCK));
    const env = envOf(spec, "bundle");
    expect(env.STRAD_TAILNET_AUTHKEY).toMatchObject({
      value: KEY,
      type: "SECRET",
    });
    expect(env.STRAD_TAILNET_TAGS).toMatchObject({
      value: "tag:strad",
      type: "GENERAL",
    });
    expect(env.STRAD_TAILNET_HOSTNAME).toMatchObject({
      value: "strad-prod-bundle",
    });
    // The listener address is the HOST's to set, at boot.
    expect(env).not.toHaveProperty("STRAD_TAILNET_SOCKS5");

    const holders = spec.services
      .filter((s) => JSON.stringify(s.envs).includes(KEY))
      .map((s) => s.name);
    expect(holders).toEqual(["bundle"]);
  });

  it("is off when absent and when enabled: false — nothing rendered, nothing demanded", () => {
    for (const cfg of [config(""), config(`${BLOCK}\n      enabled: false`)]) {
      const spec = render(cfg, {});
      expect(JSON.stringify(spec)).not.toContain("STRAD_TAILNET");
      expect(tailnetSecretNames(cfg)).toEqual([]);
    }
  });

  it("is a credential the deploy must find: the store check and render-spec both ask for its name", () => {
    const cfg = config(BLOCK);
    expect(tailnetSecretNames(cfg)).toEqual([
      "STRAD_TAILNET_OAUTH_CLIENT_SECRET",
    ]);
    expect(bakedSecretNames(cfg)).toContain(
      "STRAD_TAILNET_OAUTH_CLIENT_SECRET",
    );
    expect(supplementaryEnvNames(cfg)).toContain(
      "STRAD_TAILNET_OAUTH_CLIENT_SECRET",
    );
    expect(() => render(cfg, {})).toThrow(/STRAD_TAILNET_OAUTH_CLIENT_SECRET/);
  });

  it("takes an explicit hostname", () => {
    const spec = render(config(`${BLOCK}\n      hostname: strad-prod-ssh`));
    expect(envOf(spec, "bundle").STRAD_TAILNET_HOSTNAME!.value).toBe(
      "strad-prod-ssh",
    );
  });

  it("is refused on a component that is not the strad-bundle image", () => {
    const cfg = config("", BLOCK);
    expect(() => render(cfg)).toThrow(/does not run the strad-bundle image/);
  });

  it("refuses a literal key, an untagged node and a malformed tag at parse", () => {
    expect(() =>
      config(`    tailnet:\n      authKey: "${KEY}"\n      tags: [tag:strad]`),
    ).toThrow(/\$\{NAME\} reference/);
    expect(() =>
      config(`    tailnet:\n      authKey: "\${K}"\n      tags: []`),
    ).toThrow();
    expect(() =>
      config(`    tailnet:\n      authKey: "\${K}"\n      tags: [strad]`),
    ).toThrow(/tag:/);
  });

  it("reserves the tailnet variables: a server's env: cannot spell one", () => {
    const cfg = parseConfig(`
version: 1
gateway: { name: strad, env: prod }
auth: { staticTokens: { enabled: true, store: env } }
roles: { admin: { servers: ["*"] } }
bundles:
  - name: bundle
servers:
  - slug: good-eggs
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    entitlements: [admin]
    env:
      STRAD_TAILNET_SOCKS5: "203.0.113.9:1080"
`);
    expect(() => render(cfg, {})).toThrow(
      /STRAD_TAILNET_SOCKS5 is set by a server's env:/,
    );
  });
});
