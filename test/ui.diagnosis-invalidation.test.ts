import { sharedSecretProviders } from "../src/secrets/provider/index.ts";
import type { Server } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { createFakeGcp } from "../src/secrets/parameters/fake.ts";
import { EnvSecretProvider } from "../src/secrets/provider/index.ts";

/**
 * A write through the console drops the cached store diagnosis.
 *
 * The diagnosis — what the store's index holds, and which of those parameters
 * refuse to render — is held for `gateway.secrets.ttlSeconds` so that a reloaded
 * console and a polled readiness endpoint do not each cost a full render pass.
 * That TTL is fine for a store somebody else changed. It is NOT fine for a store
 * THIS console just changed, because of the precedence in `gatewayHalf`: the
 * store-derived `unrenderable` state is checked before the live `${NAME}` read,
 * so a cached refusal outranks a value that now resolves.
 *
 * The failure that would produce, in full: a row says "the parameter EXISTS and
 * its value cannot be produced — rotate it through the console". The human does
 * exactly that. The console flashes "Rotated ALPHA_TOKEN: a new value is now
 * current." They click back to the index, and it tells them to rotate it again,
 * for the rest of the minute. A page contradicting its own confirmation is worse
 * than the amplification the cache exists to prevent.
 */

const BOOTSTRAP = "bootstrap-secret-xyz";
const NS = "/strad/test/mcp/secrets/static/";

const KEY = JSON.stringify({
  client_email: "strad-secrets-admin@demo.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
});

const SECRETS: Record<string, string> = {
  ADMIN_KEY: KEY,
  STRAD_TOKENS: "[]",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
};

const ENV: NodeJS.ProcessEnv = {
  ALLOW_DEV_AUTH: "true",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
  STRAD_TOKENS: "[]",
  // Unreachable on purpose: the presence probe fails fast and the rows fall back
  // to the states they carry without it. Nothing here is about presence.
  STRAD_BUNDLE_URL_BUNDLE: "http://127.0.0.1:1",
};

const AUTH = { authorization: `Bearer ${BOOTSTRAP}` };

const CONFIG = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin] }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle
servers:
  - slug: secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /secrets
    entitlements: [admin]
    env:
      SECRETS_PROJECT_ID: "demo-project"
      SECRETS_NAMESPACES: "${NS}"
    consoleEnv:
      SECRETS_PROJECT_ID: "demo-project"
      SECRETS_NAMESPACES: "${NS}"
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${ADMIN_KEY}"
`);

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

/** The console, wired to a fake store for writes and a counting one for reads. */
async function boot(): Promise<{ url: string; passes: () => number }> {
  const fake = createFakeGcp();
  await fake.store.create({
    path: `${NS}ALPHA_TOKEN`,
    secret: true,
    value: "seeded-value",
  });

  let passes = 0;
  const counting = {
    list: async (namespace: string) => {
      passes += 1;
      return [
        {
          path: `${namespace}ALPHA_TOKEN`,
          variable: "ALPHA_TOKEN",
          secret: true,
          hasValue: true,
          latestVersion: "v1",
        },
      ];
    },
    resolveDetailed: async () => ({
      values: { ALPHA_TOKEN: "value" },
      unrenderable: [],
    }),
  };

  const app = createApp({
    config: CONFIG,
    registry: await Registry.build({
      config: CONFIG,
      secrets: sharedSecretProviders(new EnvSecretProvider(SECRETS)),
      mode: "core",
      env: ENV,
    }),
    tokenStore: tokenStoreFromConfig(CONFIG, ENV),
    mode: "core",
    env: ENV,
    secrets: SECRETS,
    parametersStore: () => fake.store,
    diagnosticStore: counting,
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  return { url: `http://127.0.0.1:${addr.port}`, passes: () => passes };
}

const index = async (url: string): Promise<void> => {
  await (await fetch(`${url}/ui`, { headers: AUTH })).text();
};

const post = async (
  url: string,
  action: string,
  body: Record<string, string>,
): Promise<Response> =>
  fetch(`${url}/ui/secrets/${action}`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    redirect: "manual",
  });

describe("a console write drops the cached store diagnosis", () => {
  it("re-reads after a rotate, with no clock movement at all", async () => {
    const { url, passes } = await boot();

    await index(url);
    await index(url);
    expect(passes()).toBe(1); // the TTL is doing its job

    const res = await post(url, "rotate", {
      path: `${NS}ALPHA_TOKEN`,
      value: "a-new-value",
    });
    expect(res.status).toBe(200);

    await index(url);
    expect(passes()).toBe(2); // ...and the write, not the TTL, ended it
  });

  it("re-reads after a create and after a delete", async () => {
    const { url, passes } = await boot();

    await index(url);
    expect(passes()).toBe(1);

    expect(
      (
        await post(url, "create", {
          variable: "BETA_TOKEN",
          value: "another-value",
          secret: "on",
        })
      ).status,
    ).toBe(200);
    await index(url);
    expect(passes()).toBe(2);

    expect(
      (await post(url, "delete", { path: `${NS}ALPHA_TOKEN` })).status,
    ).toBe(200);
    await index(url);
    expect(passes()).toBe(3);
  });

  it("does NOT re-read after a note, which changes nothing the diagnosis reads", async () => {
    // Metadata only. Dropping the cache here would be free-ish and still wrong:
    // it would say the note write is a store change, and the next reader would
    // pay a full render pass to learn nothing new.
    const { url, passes } = await boot();

    await index(url);
    expect(passes()).toBe(1);

    expect(
      (
        await post(url, "note", {
          path: `${NS}ALPHA_TOKEN`,
          note: "rotate me quarterly",
        })
      ).status,
    ).toBe(200);

    await index(url);
    expect(passes()).toBe(1);
  });
});
