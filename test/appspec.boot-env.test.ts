import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import {
  bootEnvGaps,
  parseImage,
  renderAppSpec,
  type EnvVar,
} from "../src/deploy/appspec.ts";
import {
  BUNDLE_BOOT_ENV_KEYS,
  CORE_BOOT_ENV_KEYS,
  CORE_ONLY_BOOT_ENV_KEYS,
} from "../src/secrets/provider/hydrate.ts";
import { RESOLVER_ENV } from "../src/secrets/parameters/resolver.ts";
import { componentToken } from "../src/auth/internal-token.ts";

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
 * The internal token is the one name whose VALUE differs per component: the
 * root stays on core, and each other component holds its own token derived
 * from it (src/auth/internal-token.ts). So "which keys" is asserted by name and
 * "which value" separately, below.
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
/** The ROOT. Core holds this and no other component does. */
const INTERNAL = "shared-internal-token";
const BUNDLE_TOKEN = componentToken(INTERNAL, "bundle");
const ECHO_TOKEN = componentToken(INTERNAL, "bundle-echo");

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

/**
 * What it puts there under the `env` provider: EVERY boot key, as a SECRET —
 * the core's own included, since core reads them from its environment. Built
 * from `CORE_BOOT_ENV_KEYS` itself, so a name added there is in this fixture
 * the moment it exists.
 */
const bakedValue = (key: string) =>
  key === "STRAD_INTERNAL_TOKEN"
    ? INTERNAL
    : key === "OTEL_EXPORTER_OTLP_HEADERS"
      ? HEADERS
      : `baked-${key}`;

const BAKED_ENV: EnvVar[] = [
  {
    key: "STRAD_CONFIG_YAML",
    value: "version: 1",
    scope: "RUN_TIME",
    type: "GENERAL",
  },
  ...CORE_BOOT_ENV_KEYS.map((key): EnvVar => ({
    key,
    value: bakedValue(key),
    scope: "RUN_TIME",
    type: "SECRET",
  })),
  {
    key: "OTEL_EXPORTER_OTLP_ENDPOINT",
    value: "https://otlp.example.com",
    scope: "RUN_TIME",
    type: "GENERAL",
  },
];

function render(opts: {
  env: EnvVar[];
  bootSecrets?: Record<string, string>;
  internalTokenRoot?: string;
}) {
  return renderAppSpec({
    config: CONFIG,
    appName: "strad-staging",
    region: "nyc",
    image: parseImage("ghcr.io/tadasant/strad:0.1.7"),
    env: opts.env,
    secrets: { SLACK_BOT_TOKEN: "xoxb-1" },
    bootSecrets: opts.bootSecrets,
    internalTokenRoot: opts.internalTokenRoot,
  });
}

const storeBacked = () =>
  render({
    env: STORE_ENV,
    bootSecrets: { OTEL_EXPORTER_OTLP_HEADERS: HEADERS },
    internalTokenRoot: INTERNAL,
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

  it("carries its OWN internal token, so its presence route can answer core", () => {
    const token = find(envsOf(storeBacked(), "bundle"), "STRAD_INTERNAL_TOKEN");
    expect(token?.value).toBe(BUNDLE_TOKEN);
    expect(token?.type).toBe("SECRET");
  });

  it("holds the SAME boot keys as it would under the env provider", () => {
    // The invariant, stated directly: the provider decides where a value is
    // READ FROM, never which keys a container ends up holding. Asked over EVERY
    // boot key, not just the bundle's two: a question narrowed to those two
    // cannot see a core-only key arriving by the env path's broadcast.
    const keys = (spec: ReturnType<typeof render>) =>
      envsOf(spec, "bundle")
        .map((e) => e.key)
        .filter((k) => (CORE_BOOT_ENV_KEYS as readonly string[]).includes(k))
        .sort();
    expect(keys(storeBacked())).toEqual(keys(envBacked()));
    expect(keys(storeBacked())).toEqual([
      "OTEL_EXPORTER_OTLP_HEADERS",
      "STRAD_INTERNAL_TOKEN",
    ]);
    // ...and the same token, whichever provider read the root.
    for (const spec of [storeBacked(), envBacked()]) {
      expect(find(envsOf(spec, "bundle"), "STRAD_INTERNAL_TOKEN")?.value).toBe(
        BUNDLE_TOKEN,
      );
    }
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
    const spec = render({ env: STORE_ENV, internalTokenRoot: INTERNAL });
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
      OTEL_EXPORTER_OTLP_HEADERS: "\${SLACK_BOT_TOKEN}"
      STRAD_INTERNAL_TOKEN: "\${SLACK_BOT_TOKEN}"
`);
    const spec = renderAppSpec({
      config,
      appName: "strad-staging",
      region: "nyc",
      image: parseImage("ghcr.io/tadasant/strad:0.1.7"),
      env: STORE_ENV,
      secrets: { SLACK_BOT_TOKEN: "xoxb-1" },
      bootSecrets: { OTEL_EXPORTER_OTLP_HEADERS: HEADERS },
      internalTokenRoot: INTERNAL,
    });
    const hits = (key: string) =>
      envsOf(spec, "bundle").filter((e) => e.key === key);
    expect(hits("OTEL_EXPORTER_OTLP_HEADERS")).toHaveLength(1);
    expect(hits("OTEL_EXPORTER_OTLP_HEADERS")[0]?.value).toBe("xoxb-1");
    // EXCEPT the internal token, which is not the component's to claim: it is
    // the one credential core can verify it by, and a server's `env:` shadowing
    // it would make the component refuse every call core proxies to it.
    expect(hits("STRAD_INTERNAL_TOKEN")).toHaveLength(1);
    expect(hits("STRAD_INTERNAL_TOKEN")[0]?.value).toBe(BUNDLE_TOKEN);
  });
});

describe("an env-backed supplementary component gets the bundle's boot keys and no more", () => {
  it("carries no core-only boot key", () => {
    // #214. Under the `env` provider every boot key is a SECRET in the
    // broadcast, so this is the line that keeps the console's cookie key (or
    // the OAuth client secret it is derived from when unset) out of every
    // third-party image — either one mints a console session, and the console
    // reveals and writes secrets. The bypass token and the token store's ids
    // and roles are here for the same reason: a third-party image has no use
    // for them.
    const envs = envsOf(envBacked(), "bundle");
    const keys = envs.map((e) => e.key);
    for (const key of CORE_ONLY_BOOT_ENV_KEYS) {
      // The one core-only key a component holds a variable BY: its own token,
      // never the root's value. Checked by value, which is what matters.
      if (key === "STRAD_INTERNAL_TOKEN") {
        expect(find(envs, key)?.value).toBe(BUNDLE_TOKEN);
        expect(envs.some((e) => e.value === INTERNAL)).toBe(false);
        continue;
      }
      expect(keys, key).not.toContain(key);
    }
  });

  it("lets a boot key through exactly when BUNDLE_BOOT_ENV_KEYS names it", () => {
    // The guarantee, over every boot key there is: a name added to
    // CORE_BOOT_ENV_KEYS lands in this fixture automatically and is kept off a
    // third-party container unless the bundle array says otherwise. Nothing
    // else — no second list — decides it.
    const bundle = new Set(envsOf(envBacked(), "bundle").map((e) => e.key));
    const core = new Set(envsOf(envBacked(), "core").map((e) => e.key));
    for (const key of CORE_BOOT_ENV_KEYS) {
      expect(bundle.has(key), key).toBe(
        (BUNDLE_BOOT_ENV_KEYS as readonly string[]).includes(key) ||
          // By name only: what it holds is its own derived token (above).
          key === "STRAD_INTERNAL_TOKEN",
      );
      // ...and the core, which reads every one of them, still gets them all.
      expect(core.has(key), key).toBe(true);
    }
  });

  it("names every core-only credential, and no bundle key outside the core set", () => {
    // The one property the derivation does not give for free: a bundle key the
    // core does not also read would be handed to third-party images while
    // appearing on no core-side list at all.
    for (const key of BUNDLE_BOOT_ENV_KEYS) {
      expect(CORE_BOOT_ENV_KEYS as readonly string[], key).toContain(key);
    }
    // The six #214 was about, named, so a reviewer sees them here — and the
    // internal-token ROOT, which HACKS.md #63 took off every component.
    expect(CORE_ONLY_BOOT_ENV_KEYS).toEqual(
      expect.arrayContaining([
        "STRAD_INTERNAL_TOKEN",
        "STRAD_TOKENS",
        "ADMIN_BOOTSTRAP_TOKEN",
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "CONSOLE_SESSION_SECRET",
        "SENTRY_DSN",
      ]),
    );
  });

  it("still delivers one of those names to a server that declares it in env:", () => {
    // The broadcast is an IMPLICIT channel, and these names are kept out of it.
    // A server that genuinely needs a value under one of them says so in its
    // own `env:`, which lands on its component alone, exactly once — so the
    // exclusion costs no server anything it asked for.
    const config = parseConfig(`
version: 1
gateway:
  name: strad
  env: staging
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
      GOOGLE_CLIENT_ID: "\${SLACK_BOT_TOKEN}"
`);
    const spec = renderAppSpec({
      config,
      appName: "strad-staging",
      region: "nyc",
      image: parseImage("ghcr.io/tadasant/strad:0.1.7"),
      env: BAKED_ENV,
      secrets: { SLACK_BOT_TOKEN: "declared-value" },
    });
    const hits = envsOf(spec, "bundle").filter(
      (e) => e.key === "GOOGLE_CLIENT_ID",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.value).toBe("declared-value");
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

describe("every component holds its own internal token, and none holds the root", () => {
  for (const [provider, spec] of [
    ["store", storeBacked],
    ["env", envBacked],
  ] as const) {
    it(`under the ${provider} provider`, () => {
      const rendered = spec();
      const core = envsOf(rendered, "core");
      // Core: the root under the env provider, hydrated under the store one.
      expect(find(core, "STRAD_INTERNAL_TOKEN")?.value).toBe(
        provider === "env" ? INTERNAL : undefined,
      );
      // A supplementary image AND a strad-image bundle, each its own. The
      // strad-image bundle is the one the `env` broadcast would hand the root,
      // and the one that could hydrate it under the store.
      expect(
        find(envsOf(rendered, "bundle"), "STRAD_INTERNAL_TOKEN")?.value,
      ).toBe(BUNDLE_TOKEN);
      expect(
        find(envsOf(rendered, "bundle-echo"), "STRAD_INTERNAL_TOKEN")?.value,
      ).toBe(ECHO_TOKEN);
      expect(BUNDLE_TOKEN).not.toBe(ECHO_TOKEN);
      for (const service of rendered.services) {
        if (service.name === "core") continue;
        const tokens = service.envs.filter(
          (e) => e.key === "STRAD_INTERNAL_TOKEN",
        );
        expect(tokens, service.name).toHaveLength(1);
        expect(
          service.envs.some((e) => e.value === INTERNAL),
          service.name,
        ).toBe(false);
      }
    });
  }
});

describe("bootEnvGaps — the rendered-spec check", () => {
  const held = [...BUNDLE_BOOT_ENV_KEYS, "STRAD_INTERNAL_TOKEN"];

  it("passes a correctly rendered store-backed spec", () => {
    expect(bootEnvGaps(storeBacked(), held)).toEqual([]);
  });

  it("passes an env-backed spec, where the bundle's boot keys are broadcast", () => {
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
    // ...and it does not accuse the components that can fetch for themselves,
    // of anything they can fetch. The strad-image bundle is accused of the
    // internal token alone: that is derived per component at render, so no
    // component can hydrate it.
    expect(gaps.some((g) => g.includes('"core"'))).toBe(false);
    const echo = gaps.filter((g) => g.includes('"bundle-echo"'));
    expect(echo).toHaveLength(1);
    expect(echo[0]).toContain("STRAD_INTERNAL_TOKEN");
  });

  it("is the STORE CREDENTIAL that exempts a component, not any scoped secret", () => {
    // The check asks "can this component fetch the value for itself", and the
    // answer is "does it hold the resolver key". `SENTRY_DSN` is scoped to the
    // strad image by the same mechanism (STRAD_IMAGE_ONLY_SECRET_KEYS) and says
    // nothing whatever about reaching the store — a component holding one and
    // not the other still has a gap, and a predicate that asked "does it hold
    // ANY image-only key" would wave it through.
    const spec = render({ env: STORE_ENV });
    const bundle = spec.services.find((s) => s.name === "bundle")!;
    bundle.envs.push({
      key: "SENTRY_DSN",
      value: "https://k@glitchtip.invalid/1",
      scope: "RUN_TIME",
      type: "SECRET",
    });

    const gaps = bootEnvGaps(spec, [...BUNDLE_BOOT_ENV_KEYS]);
    expect(gaps.join("\n")).toContain("OTEL_EXPORTER_OTLP_HEADERS");
    expect(gaps.every((g) => g.includes('component "bundle"'))).toBe(true);
  });

  it("says nothing about a key the deployment never configured", () => {
    // A gateway with no OTLP ingestor is not a broken gateway.
    const gaps = bootEnvGaps(render({ env: STORE_ENV }), [
      "STRAD_INTERNAL_TOKEN",
    ]);
    // One per non-core component, both for the token and nothing else.
    expect(gaps).toHaveLength(2);
    expect(gaps.every((g) => g.includes("STRAD_INTERNAL_TOKEN"))).toBe(true);
    expect(bootEnvGaps(render({ env: STORE_ENV }), [])).toEqual([]);
  });
});

describe("the root reaches no component under another name", () => {
  it("fails the render when a server's env: spells ${STRAD_INTERNAL_TOKEN}", () => {
    const config = parseConfig(`
version: 1
gateway:
  name: strad
  env: staging
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
      SOMETHING_ELSE: "\${STRAD_INTERNAL_TOKEN}"
`);
    const renderIt = () =>
      renderAppSpec({
        config,
        appName: "strad-staging",
        region: "nyc",
        image: parseImage("ghcr.io/tadasant/strad:0.1.7"),
        env: BAKED_ENV,
        secrets: { STRAD_INTERNAL_TOKEN: INTERNAL },
      });
    expect(renderIt).toThrow(/root under SOMETHING_ELSE/);
    // The message names the variable and the component, never the value.
    expect(renderIt).not.toThrow(new RegExp(INTERNAL));
  });
});
