import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { parseImage, renderAppSpec } from "../src/deploy/appspec.ts";

/**
 * Where the store credential is allowed to land.
 *
 * A SECRET-typed entry in `renderAppSpec`'s `env` is BROADCAST to every
 * component, supplementary images included. That is right for a credential the
 * servers themselves need and catastrophic for the one that reads the secret
 * store: it can read every value in the gateway namespace — the token store, the
 * OAuth client secret, every third-party bearer token — so broadcasting it would
 * put a key to all of them inside `good-eggs`, `fetchpet` and every other
 * third-party image, none of which have any use for it.
 *
 * This is the same invariant `appspec.consoleEnv.test.ts` defends for the console
 * admin key, one layer out.
 */

const CONFIG = parseConfig(`
version: 1
gateway:
  name: strad
  env: test
  secrets:
    provider: gcp-parameter-store
auth:
  staticTokens: { enabled: true, store: env }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle-builtins
  - name: bundle-shop
servers:
  - slug: local
    kind: builtin
    module: "./servers/echo.js"
    bundle: bundle-builtins
    entitlements: [admin]
  - slug: shop
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-server-shop:latest
    bundle: bundle-shop
    entitlements: [admin]
`);

const RESOLVER_KEY = "STRAD_PARAMS_RESOLVER_SERVICE_ACCOUNT_KEY_JSON";

function render() {
  return renderAppSpec({
    config: CONFIG,
    appName: "strad-test",
    region: "nyc",
    image: parseImage("ghcr.io/tadasant/strad:0.1.0"),
    env: [
      {
        key: RESOLVER_KEY,
        value: '{"client_email":"resolver@example","private_key":"x"}',
        scope: "RUN_TIME",
        type: "SECRET",
      },
      {
        key: "STRAD_PARAMS_PROJECT_ID",
        value: "strad-secrets-test",
        scope: "RUN_TIME",
        type: "GENERAL",
      },
    ],
  });
}

/** Components that carry an env var with this key. */
function componentsWith(key: string): string[] {
  return render()
    .services.filter((s) => s.envs.some((e) => e.key === key))
    .map((s) => s.name)
    .sort();
}

describe("the store credential's blast radius", () => {
  it("never reaches a supplementary image", () => {
    // The security assertion. A third-party image compromise, an env-dumping
    // tool, or a prompt injection reaching a shell inside `shop` must not yield
    // a key that reads every secret this deployment owns.
    expect(componentsWith(RESOLVER_KEY)).not.toContain("bundle-shop");
  });

  it("reaches core and the bundles running the strad image, and nothing else", () => {
    // Those DO need it: they run hydrateBootEnv and may host a `params:` builtin.
    expect(componentsWith(RESOLVER_KEY)).toEqual(["bundle-builtins", "core"]);
  });

  it("still broadcasts ordinary SECRETs, so this is a scoped exception", () => {
    // Guards against over-correcting: the mechanism that delivers every other
    // credential must keep working, or servers stop getting their own secrets.
    const spec = renderAppSpec({
      config: CONFIG,
      appName: "strad-test",
      region: "nyc",
      image: parseImage("ghcr.io/tadasant/strad:0.1.0"),
      env: [
        {
          key: "SOME_SHARED_TOKEN",
          value: "t",
          scope: "RUN_TIME",
          type: "SECRET",
        },
      ],
    });
    const carriers = spec.services
      .filter((s) => s.envs.some((e) => e.key === "SOME_SHARED_TOKEN"))
      .map((s) => s.name)
      .sort();
    expect(carriers).toEqual(["bundle-builtins", "bundle-shop", "core"]);
  });

  it("ships the store's address to every component — it is not a credential", () => {
    // A project id tells an operator which store a deployment is pointed at.
    // Withholding it buys nothing and makes debugging worse.
    expect(componentsWith("STRAD_PARAMS_PROJECT_ID")).toContain("core");
  });
});
