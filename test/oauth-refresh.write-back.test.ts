import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { createParameterWriteBack } from "../src/http/params.ts";
import {
  gatewayParameterPath,
  oauthParameterPath,
  parameterPath,
  ParameterStoreError,
  type ParameterStore,
} from "../src/secrets/parameters/index.ts";
import { createFakeGcp } from "../src/secrets/parameters/fake.ts";
import { sharedSecretProviders } from "../src/secrets/provider/index.ts";

/**
 * Core persisting a refresh token that rotated inside its own process.
 *
 * Against the in-memory Parameter Manager + Secret Manager double, so the
 * envelope and the secret-parameter write path are the real ones. What it has to
 * hold: the write lands where the READER reads (the server's own namespace
 * first, the gateway's second), a path that could not be checked stops the walk,
 * and every "cannot persist" is said without the value and without throwing.
 */

const VARIABLE = "GRANOLA_REFRESH_TOKEN";
const SERVER_PATH = parameterPath("test", "granola", VARIABLE);
const GATEWAY_PATH = gatewayParameterPath("test", VARIABLE);

function configWith(provider: "env" | "gcp-parameter-store") {
  return parseConfig(`
version: 1
gateway:
  name: strad
  env: test
  secrets: { provider: ${provider} }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles:
  - name: bundle-secrets
servers:
  - slug: granola
    kind: remote-http
    url: https://mcp.granola.ai/mcp
    entitlements: [admin]
    oauthRefresh:
      tokenUrl: https://mcp-auth.granola.ai/oauth2/token
      clientId: granola-client
      refreshToken: "\${${VARIABLE}}"
  - slug: secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle-secrets
    path: /secrets
    entitlements: [admin]
    env:
      SECRETS_PROJECT_ID: "strad-secrets-test"
      SECRETS_NAMESPACES: "/strad/test/"
    consoleEnv:
      SECRETS_PROJECT_ID: "strad-secrets-test"
      SECRETS_NAMESPACES: "/strad/test/"
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${SECRETS_ADMIN_KEY_JSON}"
`);
}

function harness(
  provider: "env" | "gcp-parameter-store" = "gcp-parameter-store",
  wrap: (store: ParameterStore) => ParameterStore = (s) => s,
) {
  const fake = createFakeGcp();
  const store = wrap(fake.store);
  let invalidations = 0;
  const writeBack = createParameterWriteBack({
    config: configWith(provider),
    env: {},
    secrets: {},
    parametersStore: () => store,
    secretProvider: sharedSecretProviders({
      name: "memory",
      get: async () => null,
      invalidate: () => {
        invalidations += 1;
      },
    }),
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  return {
    fake,
    writeBack,
    invalidations: () => invalidations,
    warnings: () => warn.mock.calls.map((c) => String(c[0])),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createParameterWriteBack", () => {
  it("writes the server's own parameter when it holds the token, and drops the process's reading", async () => {
    const h = harness();
    await h.fake.store.create({
      path: SERVER_PATH,
      secret: true,
      value: "rt-0",
    });
    await h.fake.store.create({
      path: GATEWAY_PATH,
      secret: true,
      value: "rt-g",
    });

    await h.writeBack("granola", VARIABLE, "rt-1", () => true);

    expect(await h.fake.store.reveal(SERVER_PATH)).toBe("rt-1");
    // The layer that would be shadowed anyway is left alone.
    expect(await h.fake.store.reveal(GATEWAY_PATH)).toBe("rt-g");
    expect(h.invalidations()).toBe(1);
    expect(h.warnings()).toEqual([]);
  });

  it("falls through to the gateway parameter only on a definite 404 for the server's", async () => {
    const h = harness();
    await h.fake.store.create({
      path: GATEWAY_PATH,
      secret: true,
      value: "rt-0",
    });

    await h.writeBack("granola", VARIABLE, "rt-1", () => true);

    expect(await h.fake.store.reveal(GATEWAY_PATH)).toBe("rt-1");
    expect(h.invalidations()).toBe(1);
  });

  it("does NOT fall through when the server's parameter could not be written for another reason", async () => {
    const h = harness("gcp-parameter-store", (store) => ({
      ...store,
      rotate: async (path, value) => {
        if (path === SERVER_PATH) {
          throw new ParameterStoreError("permission denied", 403);
        }
        return store.rotate(path, value);
      },
    }));
    await h.fake.store.create({
      path: SERVER_PATH,
      secret: true,
      value: "rt-0",
    });
    await h.fake.store.create({
      path: GATEWAY_PATH,
      secret: true,
      value: "rt-g",
    });

    await h.writeBack("granola", VARIABLE, "rt-1-never-shown", () => true);

    // A value nothing reads, in a name another layer shadows, would be worse
    // than no write at all.
    expect(await h.fake.store.reveal(GATEWAY_PATH)).toBe("rt-g");
    expect(h.invalidations()).toBe(0);
    expect(h.warnings()).toHaveLength(1);
    expect(h.warnings()[0]).toContain("could not persist the rotated");
    expect(h.warnings()[0]).not.toContain("rt-1-never-shown");
  });

  it("leaves a value this process did not mint alone: a human re-seeded between the exchange and the write", async () => {
    const h = harness();
    await h.fake.store.create({
      path: SERVER_PATH,
      secret: true,
      value: "rt-carol-seeded-by-a-human",
    });
    const asked: string[] = [];
    await h.writeBack("granola", VARIABLE, "rt-alice-rotation", (current) => {
      asked.push(current);
      return false;
    });
    expect(asked).toEqual(["rt-carol-seeded-by-a-human"]);
    expect(await h.fake.store.reveal(SERVER_PATH)).toBe(
      "rt-carol-seeded-by-a-human",
    );
    expect(h.invalidations()).toBe(0);
    expect(h.warnings()).toEqual([expect.stringContaining("re-seeded")]);
    expect(h.warnings()[0]).not.toContain("rt-alice-rotation");
    expect(h.warnings()[0]).not.toContain("rt-carol");
  });

  it("says so, and writes nothing, when neither namespace holds the token", async () => {
    const h = harness();
    await h.writeBack("granola", VARIABLE, "rt-1-never-shown", () => true);
    expect(h.invalidations()).toBe(0);
    expect(h.warnings()).toEqual([
      expect.stringContaining("resolves from the environment"),
    ]);
    expect(h.warnings()[0]).not.toContain("rt-1-never-shown");
    await expect(h.fake.store.reveal(SERVER_PATH)).rejects.toThrow();
  });

  it("says so under the env provider, where there is no store at all", async () => {
    const h = harness("env");
    await h.writeBack("granola", VARIABLE, "rt-1-never-shown", () => true);
    expect(h.warnings()).toEqual([
      expect.stringContaining("gateway.secrets.provider is env"),
    ]);
    expect(h.warnings()[0]).not.toContain("rt-1-never-shown");
  });
});

describe("createParameterWriteBack: the oauth/ kind the console's Connect writes", () => {
  it("rotates the server's oauth/ copy first — the one the resolver reads — and leaves static/ alone", async () => {
    const h = harness();
    const OAUTH_PATH = oauthParameterPath("test", "granola", VARIABLE);
    await h.fake.store.create({
      path: OAUTH_PATH,
      secret: true,
      value: "rt-0",
    });
    await h.fake.store.create({
      path: SERVER_PATH,
      secret: true,
      value: "rt-hand-seeded",
    });

    await h.writeBack("granola", VARIABLE, "rt-1", () => true);

    expect(await h.fake.store.reveal(OAUTH_PATH)).toBe("rt-1");
    expect(await h.fake.store.reveal(SERVER_PATH)).toBe("rt-hand-seeded");
    expect(h.invalidations()).toBe(1);
  });
});
