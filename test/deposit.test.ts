import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { assertNoAccessControlChange } from "../src/config/overlay.ts";
import { ENV_NAME_SOURCE } from "../src/config/env-name.ts";
import { SLUG } from "../src/config/schema.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import {
  DEPOSIT_PROTOCOL,
  depositRoutePath,
  depositToken,
  isDepositSlug,
  isDepositVariable,
  MAX_DEPOSIT_VALUE_LENGTH,
  parseDepositReceipt,
} from "../src/secrets/deposit-wire.ts";
import { createFakeGcp } from "../src/secrets/parameters/fake.ts";
import { serverParameterPath } from "../src/secrets/parameters/namespace.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";

/**
 * `POST /_strad/deposit/{slug}/{VARIABLE}`, over a real socket, against the
 * in-memory Parameter Manager + Secret Manager double — so the envelope, the
 * version and the per-parameter grant are the store's own.
 *
 * What it has to hold, every one of them a property the custody design leans
 * on (docs/servers/hostd-custody.md):
 *
 *   1. The DERIVED bearer of a `deposit:` caller creates a SECRET parameter
 *      under `static/`, and the answer names the path and version, never the
 *      value.
 *   2. Nothing else authenticates: not the slug key itself, not the derived
 *      bearer of a `local-tunnel` without `deposit:`.
 *   3. It never overwrites — not a `static/` copy, not an `oauth/` one.
 *   4. It never reads: any verb but POST is a 405.
 *   5. `into:` fences the slugs, and an impossible slug or variable is refused
 *      before anything is composed from it.
 */

const CUSTODY_KEY = "custody-slug-key-0123456789abcdef0123456789";
const NARROW_KEY = "narrow-slug-key-0123456789abcdef0123456789ab";
const SHELL_KEY = "shell-slug-key-0123456789abcdef0123456789abc";

const YAML = `
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles:
  - name: bundle-secrets
servers:
  - slug: custody-test-mbp
    kind: local-tunnel
    url: https://hostd.example.com/custody/mcp
    entitlements: [admin]
    headers:
      Authorization: "Bearer \${HOSTD_CUSTODY_KEY}"
    deposit: {}
  - slug: custody-narrow-mbp
    kind: local-tunnel
    url: https://hostd.example.com/custody/mcp
    entitlements: [admin]
    headers:
      Authorization: "Bearer \${HOSTD_NARROW_KEY}"
    deposit:
      into: [granola]
  - slug: shell-test-mbp
    kind: local-tunnel
    url: https://hostd.example.com/shell/mcp
    entitlements: [admin]
    headers:
      Authorization: "Bearer \${HOSTD_SHELL_KEY}"
  - slug: secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle-secrets
    path: /secrets
    entitlements: [admin]
    env:
      SECRETS_PROJECT_ID: "strad-secrets-test"
      SECRETS_NAMESPACES: "/strad/test/mcp/"
    consoleEnv:
      SECRETS_PROJECT_ID: "strad-secrets-test"
      SECRETS_NAMESPACES: "/strad/test/mcp/"
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${SECRETS_ADMIN_KEY_JSON}"
`;

const CONFIG = parseConfig(YAML);
const fake = createFakeGcp();
const VALUE = "lin_api_FAKEVALUEnotARealToken0123456789abcdef";

let server: Server;
let baseUrl: string;
let invalidations = 0;

beforeAll(async () => {
  const keys = new EnvSecretProvider({
    HOSTD_CUSTODY_KEY: CUSTODY_KEY,
    HOSTD_NARROW_KEY: NARROW_KEY,
    HOSTD_SHELL_KEY: SHELL_KEY,
  });
  const providers = sharedSecretProviders({
    name: keys.name,
    get: (name: string) => keys.get(name),
    invalidate: () => {
      invalidations += 1;
    },
  });
  const env: NodeJS.ProcessEnv = {
    STRAD_MODE: "core",
    STRAD_INTERNAL_TOKEN: "InternalTokenValueNeverShown",
    STRAD_BUNDLE_URL_BUNDLE_SECRETS: "http://bundle-secrets:8080",
  };
  const app = createApp({
    config: CONFIG,
    registry: await Registry.build({
      config: CONFIG,
      secrets: providers,
      mode: "core",
      env,
    }),
    tokenStore: tokenStoreFromConfig(CONFIG, env),
    mode: "core",
    env,
    parametersStore: () => fake.store,
    secretProvider: providers,
  });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

function deposit(
  slug: string,
  variable: string,
  opts: { bearer?: string; body?: unknown; method?: string } = {},
) {
  return fetch(`${baseUrl}${depositRoutePath(slug, variable)}`, {
    method: opts.method ?? "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.bearer === undefined
        ? {}
        : { authorization: `Bearer ${opts.bearer}` }),
    },
    ...((opts.method ?? "POST") === "POST"
      ? { body: JSON.stringify(opts.body ?? { value: VALUE }) }
      : {}),
  });
}

const CUSTODY = depositToken(CUSTODY_KEY);

describe("a deposit by a declared caller", () => {
  it("creates a SECRET parameter under static/ and answers with where, not what", async () => {
    const before = invalidations;
    const res = await deposit("linear", "LINEAR_API_KEY", { bearer: CUSTODY });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const raw = await res.text();
    expect(raw).not.toContain(VALUE);
    const receipt = parseDepositReceipt(JSON.parse(raw));
    const path = serverParameterPath(
      "test",
      "linear",
      "static",
      "LINEAR_API_KEY",
    );
    expect(receipt).toEqual({
      protocol: DEPOSIT_PROTOCOL,
      path,
      version: "v1",
    });
    // Landed, as a secret, through the store's own read of Secret Manager.
    expect(await fake.store.isSecret!(path)).toBe(true);
    expect(await fake.store.reveal(path)).toBe(VALUE);
    const [meta] = (await fake.store.list(path)).filter((p) => p.path === path);
    expect(meta?.note).toBe("deposited by custody-test-mbp");
    // And core dropped its reading, so a `${NAME}` sees it now.
    expect(invalidations).toBeGreaterThan(before);
  });

  it("keeps a multi-line JSON credential byte for byte", async () => {
    const blob = JSON.stringify(
      {
        type: "service_account",
        private_key:
          "-----BEGIN PRIVATE KEY-----\nFAKEFAKEFAKE\n-----END PRIVATE KEY-----\n",
      },
      null,
      2,
    );
    const res = await deposit("gcs", "GCS_KEY_JSON", {
      bearer: CUSTODY,
      body: { value: blob },
    });
    expect(res.status).toBe(201);
    expect(
      await fake.store.reveal(
        serverParameterPath("test", "gcs", "static", "GCS_KEY_JSON"),
      ),
    ).toBe(blob);
  });
});

describe("what it never does", () => {
  it("never overwrites a static/ parameter", async () => {
    const path = serverParameterPath("test", "notion", "static", "NOTION_KEY");
    await fake.store.create({ path, secret: true, value: "the-live-one" });
    const res = await deposit("notion", "NOTION_KEY", { bearer: CUSTODY });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("exists");
    expect(await fake.store.reveal(path)).toBe("the-live-one");
  });

  it("never writes beside an oauth/ copy that would shadow it", async () => {
    const oauth = serverParameterPath("test", "gmail", "oauth", "REFRESH");
    await fake.store.create({ path: oauth, secret: true, value: "consented" });
    const res = await deposit("gmail", "REFRESH", { bearer: CUSTODY });
    expect(res.status).toBe(409);
    expect(
      await fake.store.isSecret!(oauth.replace("/oauth/", "/static/")),
    ).toBe(undefined);
  });

  it("never reads: every other verb is a 405 and carries nothing", async () => {
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await deposit("linear", "LINEAR_API_KEY", {
        bearer: CUSTODY,
        method,
      });
      expect(res.status, method).toBe(405);
      expect(await res.text()).not.toContain(VALUE);
    }
  });

  it("refuses an impossible slug or variable before composing a path", async () => {
    for (const [slug, variable] of [
      ["Gateway", "X"],
      ["a--b", "X"],
      ["linear", "1BAD"],
      ["linear", "BAD-NAME"],
    ] as const) {
      const res = await deposit(slug, variable, { bearer: CUSTODY });
      expect(res.status, `${slug}/${variable}`).toBe(400);
    }
  });

  it("refuses an empty value and an over-long one", async () => {
    expect(
      (
        await deposit("linear", "EMPTY", {
          bearer: CUSTODY,
          body: { value: "" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await deposit("linear", "HUGE", {
          bearer: CUSTODY,
          body: { value: "x".repeat(MAX_DEPOSIT_VALUE_LENGTH + 1) },
        })
      ).status,
    ).toBe(413);
  });
});

describe("who may deposit", () => {
  it("refuses no bearer, the slug key itself, and a local-tunnel without deposit:", async () => {
    for (const bearer of [
      undefined,
      CUSTODY_KEY,
      depositToken(SHELL_KEY),
      "nonsense",
    ]) {
      const res = await deposit("linear", "WHO_TEST", { bearer });
      expect(res.status, String(bearer)).toBe(401);
    }
    expect(
      await fake.store.isSecret!(
        serverParameterPath("test", "linear", "static", "WHO_TEST"),
      ),
    ).toBe(undefined);
  });

  it("holds a caller to its into: list", async () => {
    const narrow = depositToken(NARROW_KEY);
    expect(
      (await deposit("linear", "NARROW_TEST", { bearer: narrow })).status,
    ).toBe(403);
    expect(
      (await deposit("granola", "NARROW_TEST", { bearer: narrow })).status,
    ).toBe(201);
  });
});

describe("the config", () => {
  it("refuses deposit: on an entry whose key strad cannot name", () => {
    for (const headers of [
      "{}",
      '{ Authorization: "Bearer literal-key-in-the-file" }',
      '{ Authorization: "Bearer ${A}${B}" }',
    ]) {
      expect(() =>
        parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
servers:
  - slug: custody-x
    kind: local-tunnel
    url: https://hostd.example.com/custody/mcp
    headers: ${headers}
    deposit: {}
`),
      ).toThrow(/deposit/);
    }
  });

  it("refuses a runtime write that adds or changes deposit:", () => {
    const base = {
      servers: [
        {
          slug: "custody-test-mbp",
          kind: "local-tunnel",
          url: "https://h/custody/mcp",
          deposit: {},
        },
      ],
    };
    // Adding one to a slug the file does not declare.
    expect(() =>
      assertNoAccessControlChange(base, {
        slug: "new-one",
        kind: "local-tunnel",
        url: "https://h/x",
        deposit: {},
      }),
    ).toThrow(/deposit/);
    // Widening the one the file declares.
    expect(() =>
      assertNoAccessControlChange(base, {
        slug: "custody-test-mbp",
        kind: "local-tunnel",
        url: "https://h/custody/mcp",
        deposit: { into: ["linear"] },
      }),
    ).toThrow(/deposit/);
    // Echoing it unchanged is fine.
    expect(() =>
      assertNoAccessControlChange(base, {
        slug: "custody-test-mbp",
        kind: "local-tunnel",
        url: "https://h/custody/mcp",
        deposit: {},
      }),
    ).not.toThrow();
  });
});

describe("the wire's own shape checks", () => {
  it("agree with the schema's slug and env-name rules", () => {
    const envName = new RegExp(`^${ENV_NAME_SOURCE}$`);
    for (const s of [
      "linear",
      "a-b-c",
      "a--b",
      "-a",
      "a-",
      "A",
      "x".repeat(63),
      "x".repeat(64),
      "a_b",
      "a/b",
    ]) {
      expect(isDepositSlug(s), s).toBe(SLUG.safeParse(s).success);
    }
    for (const v of ["X", "_X", "x_1", "1X", "X-Y", "X Y", "X/Y"]) {
      expect(isDepositVariable(v), v).toBe(envName.test(v));
    }
  });

  it("derives a bearer that is not the key and is stable", () => {
    expect(depositToken(CUSTODY_KEY)).toBe(depositToken(CUSTODY_KEY));
    expect(depositToken(CUSTODY_KEY)).not.toBe(CUSTODY_KEY);
    expect(depositToken(CUSTODY_KEY)).not.toBe(depositToken(NARROW_KEY));
  });
});
