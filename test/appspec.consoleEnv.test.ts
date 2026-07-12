import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { collectSecretRefs, renderAppSpec } from "../src/deploy/appspec.ts";

/**
 * `consoleEnv:` — the one env scope that reaches the core gateway and STOPS.
 *
 * This file exists because the obvious way to give the console a credential is
 * wrong in a way that looks right. A SECRET-typed entry in the broadcast `env`
 * list is forwarded to EVERY component (appspec.ts: the supplementary branch
 * takes `opts.env.filter(e => e.type === "SECRET")`), so the "console's"
 * credential would also be sitting in the environment of the container that
 * answers /mcp. For gcp-secrets that would put a service account which CAN read
 * secret values inside the process an agent talks to — and the IAM split, which
 * is the entire security story, would be worth nothing.
 *
 * So: consoleEnv lands on core, and on nothing else. These tests are the proof.
 */

const CONFIG = `
version: 1
gateway:
  name: strad
  env: test
auth:
  staticTokens: { enabled: true, store: env }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle
servers:
  - slug: gcp-secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /gcp-secrets
    entitlements: [admin]
    env:
      GCP_SECRETS_PROJECT_ID: "proj"
      GCP_SECRETS_NAMESPACES: "mcp-"
      GCP_SECRETS_SERVICE_ACCOUNT_KEY_JSON: "\${VIEWER_KEY}"
    consoleEnv:
      GCP_SECRETS_PROJECT_ID: "proj"
      GCP_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${ADMIN_KEY}"
`;

const SECRETS = { VIEWER_KEY: "viewer-json", ADMIN_KEY: "admin-json" };

function render() {
  return renderAppSpec({
    config: parseConfig(CONFIG),
    appName: "t",
    region: "nyc",
    image: {
      registry_type: "GHCR",
      registry: "tadasant",
      repository: "strad",
      tag: "latest",
    },
    env: [],
    secrets: SECRETS,
  });
}

describe("consoleEnv", () => {
  it("puts the console's credential on core and on NO other component", () => {
    const spec = render();
    const core = spec.services.find((s) => s.name === "core")!;
    const bundle = spec.services.find((s) => s.name === "bundle")!;

    const adminOn = (svc: typeof core) =>
      svc.envs.find(
        (e) => e.key === "GCP_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON",
      );

    expect(adminOn(core)?.value).toBe("admin-json");
    expect(adminOn(core)?.type).toBe("SECRET");
    expect(adminOn(bundle)).toBeUndefined();

    // No component other than core, ever — asserted over the whole spec, so a
    // future third component cannot inherit it by accident.
    for (const svc of spec.services) {
      if (svc.name === "core") continue;
      expect(svc.envs.some((e) => e.value === "admin-json")).toBe(false);
    }
  });

  it("keeps the MCP container's credential OFF core", () => {
    const spec = render();
    const core = spec.services.find((s) => s.name === "core")!;
    const bundle = spec.services.find((s) => s.name === "bundle")!;

    expect(
      bundle.envs.find((e) => e.key === "GCP_SECRETS_SERVICE_ACCOUNT_KEY_JSON")
        ?.value,
    ).toBe("viewer-json");
    expect(
      core.envs.some((e) => e.key === "GCP_SECRETS_SERVICE_ACCOUNT_KEY_JSON"),
    ).toBe(false);
  });

  it("does not broadcast consoleEnv refs (that is what would leak them)", () => {
    // collectSecretRefs drives the BROADCAST SECRET list in render-spec. A
    // consoleEnv ref appearing here would be injected into every component —
    // exactly the bug this scope exists to prevent.
    expect(collectSecretRefs(parseConfig(CONFIG))).toEqual([]);
  });

  it("fails closed on an unresolved consoleEnv ref", () => {
    expect(() =>
      renderAppSpec({
        config: parseConfig(CONFIG),
        appName: "t",
        region: "nyc",
        image: {
          registry_type: "GHCR",
          registry: "tadasant",
          repository: "strad",
          tag: "latest",
        },
        env: [],
        secrets: { VIEWER_KEY: "viewer-json" }, // ADMIN_KEY missing
      }),
    ).toThrow(/ADMIN_KEY/);
  });

  it("a server with no consoleEnv adds nothing to core", () => {
    const plain = parseConfig(CONFIG.replace(/ {4}consoleEnv:[\s\S]*$/, ""));
    const spec = renderAppSpec({
      config: plain,
      appName: "t",
      region: "nyc",
      image: {
        registry_type: "GHCR",
        registry: "tadasant",
        repository: "strad",
        tag: "latest",
      },
      env: [],
      secrets: SECRETS,
    });
    const core = spec.services.find((s) => s.name === "core")!;
    expect(core.envs.some((e) => e.key.startsWith("GCP_SECRETS_"))).toBe(false);
  });
});
