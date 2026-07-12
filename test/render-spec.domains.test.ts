import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A DigitalOcean App Platform spec update is a full REPLACE: an omitted field is
 * a DELETION, not a no-op. A rendered spec with no `domains` therefore DETACHES
 * the app's custom domain and stops its certificate being served — the app stays
 * healthy on its *.ondigitalocean.app ingress while the real hostname starts
 * failing the TLS handshake. That happened once, in staging, and it is silent.
 *
 * So: the domain must survive EVERY render, including one that forgets --domain.
 */
const CONFIG = `
version: 1
gateway:
  name: strad
  env: staging
  publicUrl: https://staging.strad.tadasant.com
auth:
  staticTokens: { enabled: true, store: env }
roles:
  admin: { servers: ["*"] }
servers:
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    bundle: core
    entitlements: [admin]
`;

function render(args: string[]): { domains?: { domain: string; type?: string }[] } {
  const dir = mkdtempSync(join(tmpdir(), "strad-domains-"));
  const cfg = join(dir, "cfg.yaml");
  writeFileSync(cfg, CONFIG);
  const out = execFileSync(
    process.execPath,
    [
      "--experimental-transform-types",
      "scripts/render-spec.ts",
      "--config",
      cfg,
      "--image",
      "ghcr.io/tadasant/strad:latest",
      "--app",
      "strad-staging",
      ...args,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        STRAD_TOKENS: "[]",
        STRAD_INTERNAL_TOKEN: "internal",
      },
    },
  );
  return JSON.parse(out);
}

describe("render-spec domains", () => {
  it("defaults the custom domain from gateway.publicUrl when --domain is omitted", () => {
    // The regression: this used to emit no `domains`, which DELETED the domain.
    expect(render([]).domains).toEqual([
      { domain: "staging.strad.tadasant.com", type: "PRIMARY" },
    ]);
  });

  it("lets --domain override the config's publicUrl", () => {
    expect(render(["--domain", "other.tadasant.com"]).domains).toEqual([
      { domain: "other.tadasant.com", type: "PRIMARY" },
    ]);
  });

  it("emits a BARE spec, not a { spec } envelope (doctl rejects the envelope)", () => {
    const spec = render([]) as Record<string, unknown>;
    expect(spec).not.toHaveProperty("spec");
    expect(spec).toHaveProperty("services");
  });
});
