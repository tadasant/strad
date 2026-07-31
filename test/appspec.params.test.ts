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
  - slug: remote-filesystem-tmp-public
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /remote-filesystem-tmp-public
    entitlements: [admin]
    params: true
    env:
      REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_BUCKET: "a-bucket"
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
        "remote-filesystem-tmp-public": {
          REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_CLIENT_EMAIL:
            "svc@demo.iam.gserviceaccount.com",
          REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_PRIVATE_KEY:
            "-----BEGIN KEY-----secret-----END-----",
          // A resolved value that literally contains `${...}` must survive
          // verbatim — it is NOT an unresolved ref (resolveMap must not touch it).
          REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_PASSPHRASE:
            "pass${GCS_BUCKET}phrase",
        },
      },
    });

    const core = spec.services.find((s) => s.name === "core")!;
    const bundle = spec.services.find((s) => s.name === "bundle")!;

    const email = bundle.envs.find(
      (e) => e.key === "REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_CLIENT_EMAIL",
    );
    const key = bundle.envs.find(
      (e) => e.key === "REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_PRIVATE_KEY",
    );

    expect(email?.value).toBe("svc@demo.iam.gserviceaccount.com");
    expect(email?.type).toBe("SECRET");
    expect(key?.type).toBe("SECRET");
    // The `${...}`-containing value is passed through untouched (not ref-resolved).
    expect(
      bundle.envs.find(
        (e) => e.key === "REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_PASSPHRASE",
      )?.value,
    ).toBe("pass${GCS_BUCKET}phrase");
    // The literal bucket from env: is still there, alongside the resolved params.
    expect(
      bundle.envs.some(
        (e) => e.key === "REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_BUCKET",
      ),
    ).toBe(true);

    // Scoped to the bundle: the resolved secret value never lands on core.
    expect(
      core.envs.some(
        (e) => e.key === "REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_PRIVATE_KEY",
      ),
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
        (e) => e.key === "REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_CLIENT_EMAIL",
      ),
    ).toBe(false);
  });

  it("names the resolved VARIABLES on the component, so the console can ask about them", () => {
    // A managed parameter is not a `${NAME}` reference: the config does not name
    // it, so core cannot enumerate it and the console can only say, unaided,
    // "this page does not read that namespace". `STRAD_PARAM_KEYS` is the list of
    // names — NAMES, not values, and GENERAL rather than SECRET — that lets the
    // component answer for each one on the presence route.
    const spec = renderAppSpec({
      config: CONFIG,
      appName: "strad-staging",
      region: "nyc",
      image: IMAGE,
      env: [],
      resolvedParams: {
        "remote-filesystem-tmp-public": {
          REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_CLIENT_EMAIL: "svc@demo.example",
          REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_PRIVATE_KEY: "-----BEGIN KEY-----",
        },
      },
    });
    const bundle = spec.services.find((s) => s.name === "bundle")!;
    const manifest = bundle.envs.find((e) => e.key === "STRAD_PARAM_KEYS")!;
    expect(manifest.type).toBe("GENERAL");
    expect(JSON.parse(manifest.value!)).toEqual({
      "remote-filesystem-tmp-public": [
        "REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_CLIENT_EMAIL",
        "REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_PRIVATE_KEY",
      ],
    });
    // Names only. A value must not reach a GENERAL env var.
    expect(manifest.value).not.toContain("BEGIN KEY");
    expect(manifest.value).not.toContain("svc@demo.example");
    // Not on core, which runs no params: true server.
    const core = spec.services.find((s) => s.name === "core")!;
    expect(core.envs.some((e) => e.key === "STRAD_PARAM_KEYS")).toBe(false);
  });

  it("omits the manifest entirely when no server on the component uses params", () => {
    // A spec diff should only move when the thing it describes does.
    const plain = parseConfig(`
version: 1
gateway: { name: strad, env: staging }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles:
  - name: bundle
servers:
  - slug: slack
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /slack
    entitlements: [admin]
`);
    const spec = renderAppSpec({
      config: plain,
      appName: "strad-staging",
      region: "nyc",
      image: IMAGE,
      env: [],
    });
    const bundle = spec.services.find((s) => s.name === "bundle")!;
    expect(bundle.envs.some((e) => e.key === "STRAD_PARAM_KEYS")).toBe(false);
  });
});
