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

function render(
  args: string[],
  image = "ghcr.io/tadasant/strad:0.1.38",
): {
  domains?: { domain: string; type?: string }[];
} {
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
      image,
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

/** Render, expecting failure, and return what the process said on stderr. */
function renderStderr(image: string): string {
  try {
    render([], image);
  } catch (err) {
    // execFileSync puts the child's stderr on the error, not in its message.
    return String((err as { stderr?: Buffer | string }).stderr ?? err);
  }
  throw new Error(`render-spec unexpectedly accepted --image ${image}`);
}

describe("render-spec image", () => {
  it("refuses a mutable core tag, which is what shipped old code to staging", () => {
    // The whole failure: `:latest` rendered fine, deployed fine, and booted a
    // pre-#26 image that rejected the config it was handed.
    const stderr = renderStderr("ghcr.io/tadasant/strad:latest");
    expect(stderr).toMatch(/mutable tag "latest"/);
    // It must also say what to pass instead, or the operator is stuck.
    expect(stderr).toMatch(/sha-<commit>/);
  });

  it("refuses a tag-less ref, which silently means :latest", () => {
    expect(renderStderr("ghcr.io/tadasant/strad")).toMatch(
      /mutable tag "latest"/,
    );
  });

  it("renders an immutable commit tag", () => {
    const sha = `sha-${"a".repeat(40)}`;
    expect(render([], `ghcr.io/tadasant/strad:${sha}`).domains).toEqual([
      { domain: "staging.strad.tadasant.com", type: "PRIMARY" },
    ]);
  });
});

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
