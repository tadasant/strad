import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { renderAppSpec } from "../src/deploy/appspec.ts";

/**
 * A `params: true` supplementary server gets its managed parameters resolved at
 * DEPLOY time (by render-spec, which holds the resolver credential) and passed to
 * renderAppSpec as `resolvedParams`. Here we assert the last mile: those resolved
 * values land as SECRET env vars on that server's BUNDLE — never on core, and
 * never broadcast — so the running container reads them from process.env and
 * holds no cloud credential of its own.
 */

const CONFIG = parseConfig(`
version: 1
gateway: { name: strad, env: staging }
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle
servers:
  - slug: remote-fs-screenshots
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /remote-fs-screenshots
    entitlements: [admin]
    params: true
    env:
      REMOTE_FS_SCREENSHOTS_GCS_BUCKET: "a-bucket"
`);

const IMAGE = {
  registry_type: "GHCR" as const,
  registry: "tadasant",
  repository: "strad",
  tag: "latest",
};

describe("deploy-time parameter injection", () => {
  it("lands a params:true server's resolved parameters on its bundle as SECRET", () => {
    const spec = renderAppSpec({
      config: CONFIG,
      appName: "strad-staging",
      region: "nyc",
      image: IMAGE,
      env: [],
      resolvedParams: {
        "remote-fs-screenshots": {
          REMOTE_FS_SCREENSHOTS_GCS_CLIENT_EMAIL:
            "svc@demo.iam.gserviceaccount.com",
          REMOTE_FS_SCREENSHOTS_GCS_PRIVATE_KEY:
            "-----BEGIN KEY-----secret-----END-----",
          // A resolved value that literally contains `${...}` must survive
          // verbatim — it is NOT an unresolved ref (resolveMap must not touch it).
          REMOTE_FS_SCREENSHOTS_GCS_PASSPHRASE: "pass${GCS_BUCKET}phrase",
        },
      },
    });

    const core = spec.services.find((s) => s.name === "core")!;
    const bundle = spec.services.find((s) => s.name === "bundle")!;

    const email = bundle.envs.find(
      (e) => e.key === "REMOTE_FS_SCREENSHOTS_GCS_CLIENT_EMAIL",
    );
    const key = bundle.envs.find(
      (e) => e.key === "REMOTE_FS_SCREENSHOTS_GCS_PRIVATE_KEY",
    );

    expect(email?.value).toBe("svc@demo.iam.gserviceaccount.com");
    expect(email?.type).toBe("SECRET");
    expect(key?.type).toBe("SECRET");
    // The `${...}`-containing value is passed through untouched (not ref-resolved).
    expect(
      bundle.envs.find((e) => e.key === "REMOTE_FS_SCREENSHOTS_GCS_PASSPHRASE")
        ?.value,
    ).toBe("pass${GCS_BUCKET}phrase");
    // The literal bucket from env: is still there, alongside the resolved params.
    expect(
      bundle.envs.some((e) => e.key === "REMOTE_FS_SCREENSHOTS_GCS_BUCKET"),
    ).toBe(true);

    // Scoped to the bundle: the resolved secret value never lands on core.
    expect(
      core.envs.some((e) => e.key === "REMOTE_FS_SCREENSHOTS_GCS_PRIVATE_KEY"),
    ).toBe(false);
  });

  it("is a no-op when no resolved parameters are supplied", () => {
    const spec = renderAppSpec({
      config: CONFIG,
      appName: "strad-staging",
      region: "nyc",
      image: IMAGE,
      env: [],
    });
    const bundle = spec.services.find((s) => s.name === "bundle")!;
    // Only the literal bucket — the creds are resolved at deploy, deferred here.
    expect(
      bundle.envs.some(
        (e) => e.key === "REMOTE_FS_SCREENSHOTS_GCS_CLIENT_EMAIL",
      ),
    ).toBe(false);
  });
});
