import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import {
  bootEnvGaps,
  parseImage,
  renderAppSpec,
  type EnvVar,
} from "../src/deploy/appspec.ts";
import { BUNDLE_BOOT_ENV_KEYS } from "../src/secrets/provider/hydrate.ts";
import { RESOLVER_ENV } from "../src/secrets/parameters/resolver.ts";

/**
 * The boot env of a container that cannot read the store.
 *
 * Hydration (secrets/provider/hydrate.ts) is what lets a store-backed render
 * stop baking the gateway's boot env — and it runs in strad's own process. A
 * `supplementary-image` component is a third-party container: it does not run
 * strad and it holds no store credential, so under the store provider it was
 * left with NEITHER source.
 *
 * Both names fail silently. `OTEL_EXPORTER_OTLP_HEADERS` missing means the
 * exporter starts, sends, and is rejected — the component answering every
 * supplementary slug goes blind a minute after a green deploy.
 * `STRAD_INTERNAL_TOKEN` missing means its presence route fails closed and the
 * console can no longer say what that container holds.
 *
 * The property these tests hold: WHICH KEYS A COMPONENT HOLDS DOES NOT DEPEND ON
 * THE SECRET PROVIDER. Only where the value was read from does.
 */

const CONFIG = parseConfig(`
version: 1
gateway:
  name: strad
  env: staging
  publicUrl: https://staging.strad.tadasant.com
  secrets:
    provider: gcp-parameter-store
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle-echo
  - name: bundle
servers:
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    bundle: core
    entitlements: [admin]
  - slug: bundled
    kind: builtin
    module: "./servers/echo.js"
    bundle: bundle-echo
    entitlements: [admin]
  - slug: slack
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:0.1.0
    bundle: bundle
    entitlements: [admin]
    env:
      SLACK_BOT_TOKEN: "\${SLACK_BOT_TOKEN}"
`);

const HEADERS = "Authorization=Bearer otlp-ingest-token";
const INTERNAL = "shared-internal-token";

/** What render-spec puts in `env` under the STORE provider: one credential. */
const STORE_ENV: EnvVar[] = [
  {
    key: "STRAD_CONFIG_YAML",
    value: "version: 1",
    scope: "RUN_TIME",
    type: "GENERAL",
  },
  {
    key: RESOLVER_ENV.keyJson,
    value: '{"type":"service_account"}',
    scope: "RUN_TIME",
    type: "SECRET",
  },
  {
    key: "OTEL_EXPORTER_OTLP_ENDPOINT",
    value: "https://otlp.example.com",
    scope: "RUN_TIME",
    type: "GENERAL",
  },
];

/** What it puts there under the `env` provider: the boot keys, broadcast. */
const BAKED_ENV: EnvVar[] = [
  {
    key: "STRAD_CONFIG_YAML",
    value: "version: 1",
    scope: "RUN_TIME",
    type: "GENERAL",
  },
  {
    key: "STRAD_INTERNAL_TOKEN",
    value: INTERNAL,
    scope: "RUN_TIME",
    type: "SECRET",
  },
  {
    key: "OTEL_EXPORTER_OTLP_HEADERS",
    value: HEADERS,
    scope: "RUN_TIME",
    type: "SECRET",
  },
  {
    key: "OTEL_EXPORTER_OTLP_ENDPOINT",
    value: "https://otlp.example.com",
    scope: "RUN_TIME",
    type: "GENERAL",
  },
];

function render(opts: { env: EnvVar[]; bootSecrets?: Record<string, string> }) {
  return renderAppSpec({
    config: CONFIG,
    appName: "strad-staging",
    region: "nyc",
    image: parseImage("ghcr.io/tadasant/strad:0.1.7"),
    env: opts.env,
    secrets: { SLACK_BOT_TOKEN: "xoxb-1" },
    bootSecrets: opts.bootSecrets,
  });
}

const storeBacked = () =>
  render({
    env: STORE_ENV,
    bootSecrets: {
      STRAD_INTERNAL_TOKEN: INTERNAL,
      OTEL_EXPORTER_OTLP_HEADERS: HEADERS,
    },
  });

const envBacked = () => render({ env: BAKED_ENV });

const envsOf = (spec: ReturnType<typeof render>, name: string) =>
  spec.services.find((s) => s.name === name)!.envs;

const find = (envs: EnvVar[], key: string) => envs.find((e) => e.key === key);

describe("a store-backed supplementary component gets its boot env baked", () => {
  it("carries the OTLP auth header, as a SECRET", () => {
    // THE BUG. Without this the exporter runs and every batch is rejected: no
    // error at boot, no failed health check, just a component that stopped
    // reporting about a minute in.
    const header = find(
      envsOf(storeBacked(), "bundle"),
      "OTEL_EXPORTER_OTLP_HEADERS",
    );
    expect(header?.value).toBe(HEADERS);
    expect(header?.type).toBe("SECRET");
  });

  it("carries the internal token, so its presence route can answer core", () => {
    const token = find(envsOf(storeBacked(), "bundle"), "STRAD_INTERNAL_TOKEN");
    expect(token?.value).toBe(INTERNAL);
    expect(token?.type).toBe("SECRET");
  });

  it("holds the SAME boot keys as it would under the env provider", () => {
    // The invariant, stated directly: the provider decides where a value is
    // READ FROM, never which keys a container ends up holding.
    const keys = (spec: ReturnType<typeof render>) =>
      envsOf(spec, "bundle")
        .map((e) => e.key)
        .filter((k) => (BUNDLE_BOOT_ENV_KEYS as readonly string[]).includes(k))
        .sort();
    expect(keys(storeBacked())).toEqual(keys(envBacked()));
    expect(keys(storeBacked())).toEqual([
      "OTEL_EXPORTER_OTLP_HEADERS",
      "STRAD_INTERNAL_TOKEN",
    ]);
  });

  it("still does not get the store credential", () => {
    // The reason this is baked rather than hydrated. Handing every third-party
    // image a key that reads the whole gateway namespace is the trade this
    // change exists to avoid — and it would not even work, since nothing in
    // that image knows how to ask.
    expect(find(envsOf(storeBacked(), "bundle"), RESOLVER_ENV.keyJson)).toBe(
      undefined,
    );
  });

  it("bakes nothing when the deployment configured nothing", () => {
    // Telemetry is optional everywhere, and "not configured" has to stay a
    // first-class state: an ingestor that needs no auth header has none to bake.
    const spec = render({
      env: STORE_ENV,
      bootSecrets: { STRAD_INTERNAL_TOKEN: INTERNAL },
    });
    expect(
      find(envsOf(spec, "bundle"), "OTEL_EXPORTER_OTLP_HEADERS"),
    ).toBeUndefined();
  });

  it("lets the component's own env: keep a name it claims", () => {
    // One container, one environment. A server that sets one of these names for
    // its own upstream must not be silently overwritten — and the key must land
    // exactly once, since a duplicate is a coin toss about which value wins.
    const config = parseConfig(`
version: 1
gateway:
  name: strad
  env: staging
  secrets:
    provider: gcp-parameter-store
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle
servers:
  - slug: slack
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:0.1.0
    bundle: bundle
    entitlements: [admin]
    env:
      STRAD_INTERNAL_TOKEN: "\${SLACK_BOT_TOKEN}"
`);
    const spec = renderAppSpec({
      config,
      appName: "strad-staging",
      region: "nyc",
      image: parseImage("ghcr.io/tadasant/strad:0.1.7"),
      env: STORE_ENV,
      secrets: { SLACK_BOT_TOKEN: "xoxb-1" },
      bootSecrets: { STRAD_INTERNAL_TOKEN: INTERNAL },
    });
    const hits = envsOf(spec, "bundle").filter(
      (e) => e.key === "STRAD_INTERNAL_TOKEN",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.value).toBe("xoxb-1");
  });
});

describe("a component that CAN hydrate is not given a baked twin", () => {
  it("leaves the core holding exactly one credential", () => {
    // The whole point of the store provider: the spec carries the key that
    // reaches the store and nothing else. Core hydrates the rest at boot, so a
    // baked copy here would be a second way to manage a secret — and a stale
    // one would outrank a rotation.
    const secrets = envsOf(storeBacked(), "core")
      .filter((e) => e.type === "SECRET")
      .map((e) => e.key);
    expect(secrets).toEqual([RESOLVER_ENV.keyJson]);
  });

  it("leaves a strad-image bundle hydrating, exactly as documented", () => {
    // A `builtin` on its own bundle runs the strad image in bundle mode: it
    // receives the broadcast env, including the resolver key, and calls
    // hydrateBootEnv itself.
    const envs = envsOf(storeBacked(), "bundle-echo");
    expect(find(envs, RESOLVER_ENV.keyJson)?.type).toBe("SECRET");
    expect(find(envs, "OTEL_EXPORTER_OTLP_HEADERS")).toBeUndefined();
  });
});

describe("bootEnvGaps — the rendered-spec check", () => {
  const held = [...BUNDLE_BOOT_ENV_KEYS];

  it("passes a correctly rendered store-backed spec", () => {
    expect(bootEnvGaps(storeBacked(), held)).toEqual([]);
  });

  it("passes an env-backed spec, where everything is broadcast", () => {
    expect(bootEnvGaps(envBacked(), held)).toEqual([]);
  });

  it("catches the regression: the supplementary component, no header, no key", () => {
    // This is the shape of the spec that shipped. `core` holds the resolver key
    // so it hydrates; `bundle` holds neither, and nothing else in the deploy
    // says so.
    const spec = render({ env: STORE_ENV });
    const gaps = bootEnvGaps(spec, held);
    expect(gaps.join("\n")).toContain("OTEL_EXPORTER_OTLP_HEADERS");
    expect(gaps.join("\n")).toContain("STRAD_INTERNAL_TOKEN");
    expect(gaps.every((g) => g.includes('component "bundle"'))).toBe(true);
    // ...and it does not accuse the components that can fetch for themselves.
    expect(gaps.some((g) => g.includes('"core"'))).toBe(false);
    expect(gaps.some((g) => g.includes('"bundle-echo"'))).toBe(false);
  });

  it("says nothing about a key the deployment never configured", () => {
    // A gateway with no OTLP ingestor is not a broken gateway.
    const gaps = bootEnvGaps(render({ env: STORE_ENV }), [
      "STRAD_INTERNAL_TOKEN",
    ]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain("STRAD_INTERNAL_TOKEN");
    expect(bootEnvGaps(render({ env: STORE_ENV }), [])).toEqual([]);
  });
});
