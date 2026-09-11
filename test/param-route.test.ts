import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";
import {
  createParamClient,
  paramRoutePath,
  PARAM_PROTOCOL,
} from "../src/secrets/param-route.ts";
import { writableTarget } from "../src/http/params.ts";
import { storeForPath } from "../src/ui/store-client.ts";
import { createFakeGcp } from "../src/secrets/parameters/fake.ts";
import { readStoreDiagnosticsCached } from "../src/secrets/store-diagnostics.ts";
import { parameterPath } from "../src/secrets/parameters/namespace.ts";

/**
 * The parameter write-back path, over a real socket, against a real store.
 *
 * Core serves `GET`/`POST /_strad/params/{slug}/{VARIABLE}`; a hosted server
 * calls it to read the credential that is current NOW and to persist the one it
 * just rotated to. Both ends of that wire are exercised here — the client is
 * `createParamClient` from `src/secrets/param-route.ts`, which is byte-identical
 * to the copy the bundle host runs (test/vendored.sync.test.ts) — and the
 * store behind it is the in-memory Parameter Manager + Secret Manager double, so
 * the base64url envelope and the per-parameter `secretAccessor` grant are the
 * real ones.
 *
 * The four things this has to hold, all of them one bug away from a silent dead
 * credential in production:
 *
 *   1. An allowlisted write reaches the store, encoded the way every other write
 *      to that store is encoded.
 *   2. A name the config did not allowlist is refused — the route cannot become
 *      a write-anything oracle by spelling a URL.
 *   3. An unauthenticated caller is refused.
 *   4. A boot prefers the stored value over the baked one, and falls back to the
 *      baked one when the store cannot answer.
 */

const YAML = `
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles:
  - name: bundle
  - name: bundle-secrets
servers:
  - slug: x-twitter
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /x-twitter
    entitlements: [admin]
    params: true
    paramsWritable: [X_OAUTH_REFRESH_TOKEN, X_OAUTH_UNSEEDED]
  - slug: slack
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /slack
    entitlements: [admin]
    params: true
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
const TOKEN = "InternalTokenValueNeverShown";
const VARIABLE = "X_OAUTH_REFRESH_TOKEN";
const PATH = parameterPath("test", "x-twitter", VARIABLE);

/** What the deploy baked onto the container, and what a rotation replaces. */
const BAKED = "refresh-token-from-the-last-render";
const SEEDED = "refresh-token-the-store-holds-now";
const ROTATED = "refresh-token-just-minted-by-x";

const fake = createFakeGcp();

let server: Server;
/**
 * The store the diagnosis reads, counting its index passes — one per pass that
 * actually ran, none for one served from the held result.
 */
const diagnostic = {
  lists: 0,
  store: {
    list: async (namespace: string) => {
      diagnostic.lists += 1;
      return fake.store.list(namespace);
    },
    resolveDetailed: (namespace: string) =>
      fake.store.resolveDetailed!(namespace),
  },
};
/** The runtime providers, counting how often a write tells them to re-read. */
let invalidations = 0;
const runtimeEnv = new EnvSecretProvider({});
const runtimeProviders = sharedSecretProviders({
  name: runtimeEnv.name,
  get: (name: string) => runtimeEnv.get(name),
  invalidate: () => {
    invalidations += 1;
  },
});
let baseUrl: string;

beforeAll(async () => {
  // A SECRET parameter, which is the interesting kind: its value lives in Secret
  // Manager behind a `__REF__` pointer, `rotate()` writes only there, and the
  // per-parameter grant `create()` made has to survive the write.
  await fake.store.create({ path: PATH, secret: true, value: SEEDED });

  const env: NodeJS.ProcessEnv = {
    STRAD_MODE: "core",
    STRAD_INTERNAL_TOKEN: TOKEN,
    // Core proxies /mcp to both bundles, so the registry demands their private
    // URLs at build time. Nothing in this file calls /mcp; they only have to
    // exist.
    STRAD_BUNDLE_URL_BUNDLE: "http://bundle:8080",
    STRAD_BUNDLE_URL_BUNDLE_SECRETS: "http://bundle-secrets:8080",
  };
  const app = createApp({
    config: CONFIG,
    registry: await Registry.build({
      config: CONFIG,
      secrets: runtimeProviders,
      mode: "core",
      env,
    }),
    tokenStore: tokenStoreFromConfig(CONFIG, env),
    mode: "core",
    env,
    // The console's admin store, substituted for the fake. Same seam the
    // console's own tests use, and the route deliberately shares it rather than
    // constructing a second writer.
    parametersStore: () => fake.store,
    secretProvider: runtimeProviders,
    diagnosticStore: diagnostic.store,
  });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

/** The client the bundle host runs, pointed at this core. */
function client(opts: { slug?: string; token?: string; base?: string } = {}) {
  return createParamClient({
    slug: opts.slug ?? "x-twitter",
    baseUrl: opts.base ?? baseUrl,
    token: "token" in opts ? opts.token : TOKEN,
  });
}

describe("an allowlisted write", () => {
  it("reaches the store, and the store hands the new value back", async () => {
    const before = invalidations;
    // Prime the diagnosis pass `/ui` and readiness reuse, so the write has
    // something to drop.
    await readStoreDiagnosticsCached({
      store: diagnostic.store,
      namespace: "/strad/test/gateway/static/",
      ttlMs: 60_000,
    });
    const passes = diagnostic.lists;

    await client().put(VARIABLE, ROTATED);

    // Through `reveal()`, i.e. the store's own read of Secret Manager — so this
    // asserts the value LANDED, not merely that the route answered 200.
    expect(await fake.store.reveal(PATH)).toBe(ROTATED);
    // And core's own reading of the store was dropped, so a `${NAME}` or a
    // `params: true` builtin on core sees the rotated value now, not within
    // `ttlSeconds`. The write went through the admin client; the gateway reads
    // through the resolver client, and nothing else tells it.
    expect(invalidations).toBe(before + 1);
    // The held diagnosis pass went with it: the next reading runs a fresh
    // pass instead of serving the pre-rotation verdict for the rest of the
    // minute to whoever polls readiness.
    await readStoreDiagnosticsCached({
      store: diagnostic.store,
      namespace: "/strad/test/gateway/static/",
      ttlMs: 60_000,
    });
    expect(diagnostic.lists).toBe(passes + 1);
  });

  it("stores it base64url-encoded, and never in Parameter Manager", async () => {
    // The two properties the whole envelope design exists for. If the write had
    // gone through some second path that skipped `rotate()`, a value with a
    // quote or a newline would break `:render` in production and nothing here
    // would have noticed.
    const awkward = 'a"value\nwith {braces} and a \\backslash';
    await client().put(VARIABLE, awkward);

    expect(await fake.store.reveal(PATH)).toBe(awkward);
    expect(fake.pmPayloads().join("\n")).not.toContain(awkward);
    // And it still renders — which is what proves the encoding was applied and
    // the parameter's `secretAccessor` grant survived the rotation.
    const resolved = await fake.store.resolve(
      "/strad/test/mcp/x-twitter/static/",
    );
    expect(resolved[VARIABLE]).toBe(awkward);

    await client().put(VARIABLE, ROTATED); // leave the store as the others expect
  });
});

describe("a write the config did not allow", () => {
  it("is refused for a variable outside the allowlist", async () => {
    const res = await fetch(
      `${baseUrl}${paramRoutePath("x-twitter", "X_OAUTH_CLIENT_SECRET")}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ value: "nope" }),
      },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "parameter_not_writable",
    );
  });

  it("is refused for a server with no paramsWritable at all", async () => {
    await expect(
      client({ slug: "slack" }).put("SLACK_BOT_TOKEN", "nope"),
    ).rejects.toThrow(/HTTP 403/);
  });

  it("is refused for a server that is disabled", async () => {
    // A server strad does not mount writes nothing. The allowlist on a disabled
    // entry is inert — which is also what the render check assumes when it lets
    // such a bundle scale out.
    const disabled = parseConfig(
      YAML.replace(
        "    entitlements: [admin]\n    params: true\n    paramsWritable:",
        "    entitlements: [admin]\n    enabled: false\n    params: true\n    paramsWritable:",
      ),
    );
    expect(disabled.servers[0]?.enabled).toBe(false);
    expect(writableTarget(disabled, "x-twitter", VARIABLE)).toBeNull();
    // And the enabled config this app runs still resolves it, so the assertion
    // above is about `enabled` and not about a typo in the replacement.
    expect(writableTarget(CONFIG, "x-twitter", VARIABLE)).toEqual({
      slug: "x-twitter",
      variable: VARIABLE,
    });
  });

  it("is refused for a slug no config names", async () => {
    // The same 403, deliberately: telling "unknown slug" apart from "not
    // allowlisted" would make this an enumeration oracle for the config.
    await expect(
      client({ slug: "invented" }).put(VARIABLE, "nope"),
    ).rejects.toThrow(/HTTP 403/);
  });

  it("cannot escape the namespace by spelling the URL differently", async () => {
    // The name that reaches the store is the CONFIG's string, never the URL's,
    // so there is nothing to traverse WITH. Each of these is just a slug or a
    // variable that matches no allowlist entry.
    for (const path of [
      "/_strad/params/x-twitter/..%2f..%2fgateway%2fstatic%2fSTRAD_TOKENS",
      "/_strad/params/..%2f..%2fgateway/STRAD_TOKENS",
      "/_strad/params/x-twitter/x_oauth_refresh_token",
      "/_strad/params/X-TWITTER/X_OAUTH_REFRESH_TOKEN",
    ]) {
      const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ value: "nope" }),
      });
      expect([403, 404]).toContain(res.status);
    }
    // Nothing moved.
    expect(await fake.store.reveal(PATH)).toBe(ROTATED);
  });

  it("refuses an empty value, which would erase a working credential", async () => {
    const res = await fetch(
      `${baseUrl}${paramRoutePath("x-twitter", VARIABLE)}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ value: "" }),
      },
    );
    expect(res.status).toBe(400);
    expect(await fake.store.reveal(PATH)).toBe(ROTATED);
  });
});

describe("an unauthenticated caller", () => {
  it("is refused with no token", async () => {
    const res = await fetch(
      `${baseUrl}${paramRoutePath("x-twitter", VARIABLE)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "nope" }),
      },
    );
    expect(res.status).toBe(401);
    expect(await fake.store.reveal(PATH)).toBe(ROTATED);
  });

  it("is refused with the wrong token, on both verbs", async () => {
    for (const method of ["GET", "POST"]) {
      const res = await fetch(
        `${baseUrl}${paramRoutePath("x-twitter", VARIABLE)}`,
        {
          method,
          headers: {
            authorization: "Bearer not-the-internal-token",
            "content-type": "application/json",
          },
          ...(method === "POST"
            ? { body: JSON.stringify({ value: "nope" }) }
            : {}),
        },
      );
      expect(res.status).toBe(401);
    }
    expect(await fake.store.reveal(PATH)).toBe(ROTATED);
  });

  it("refuses BEFORE it decides whether the name is writable", async () => {
    // Order matters: an unauthenticated caller that got 403 for one name and 401
    // for another would learn the allowlist without holding the token.
    const res = await fetch(
      `${baseUrl}${paramRoutePath("x-twitter", "SOMETHING_ELSE")}`,
      { method: "GET" },
    );
    expect(res.status).toBe(401);
  });
});

describe("the boot read", () => {
  it("is preferred over the value the deploy baked", async () => {
    // THE RACE THIS CLOSES: a sibling process can rotate the credential after
    // the render read it, so the baked value may already be dead by the time a
    // replacement container boots.
    const stored = await client().get(VARIABLE);
    expect(stored).toBe(ROTATED);

    // What the mount then does with it — the same rule the x-twitter provider
    // applies (servers/x-twitter/.../x-client/index.ts).
    expect(stored || BAKED).toBe(ROTATED);
  });

  it("answers with the protocol, so an old caller can refuse a new shape", async () => {
    const res = await fetch(
      `${baseUrl}${paramRoutePath("x-twitter", VARIABLE)}`,
      {
        headers: { authorization: `Bearer ${TOKEN}` },
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      protocol: PARAM_PROTOCOL,
      value: ROTATED,
    });
  });

  it("falls back to the baked value when core is unreachable", async () => {
    // A closed port, not a mock: the failure has to be the real one a container
    // meets when core is mid-deploy.
    const unreachable = createParamClient({
      slug: "x-twitter",
      baseUrl: "http://127.0.0.1:1",
      token: TOKEN,
      timeoutMs: 500,
    });
    const stored = await unreachable.get(VARIABLE);
    expect(stored).toBeUndefined();
    expect(stored || BAKED).toBe(BAKED);
  });

  it("falls back when the parameter has never been seeded", async () => {
    // Every deployment before its first rotation: the name IS allowlisted, and
    // nothing has ever written it. `X_OAUTH_UNSEEDED` is on the allowlist above
    // and deliberately never created in the store, so this 404 comes from the
    // store through the route, not from a routing miss.
    const res = await fetch(
      `${baseUrl}${paramRoutePath("x-twitter", "X_OAUTH_UNSEEDED")}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(404);

    // And what the container does with that: keeps what it was deployed with.
    const stored = await client().get("X_OAUTH_UNSEEDED");
    expect(stored).toBeUndefined();
    expect(stored || BAKED).toBe(BAKED);
  });

  it("falls back when core answers a shape it does not understand", async () => {
    // A drifted protocol, or something in the middle rewriting the body. Taking
    // a garbled answer over the baked one would trade a stale credential for a
    // nonsense one.
    const bad = createParamClient({
      slug: "x-twitter",
      baseUrl: "http://core.invalid",
      token: TOKEN,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ protocol: 99, value: "from-the-future" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    });
    expect(await bad.get(VARIABLE)).toBeUndefined();
  });

  it("falls back when nothing told the container where core is", async () => {
    const unwired = createParamClient({
      slug: "x-twitter",
      baseUrl: undefined,
      token: TOKEN,
    });
    expect(await unwired.get(VARIABLE)).toBeUndefined();
    // ...and the WRITE refuses loudly rather than pretending it landed.
    await expect(unwired.put(VARIABLE, ROTATED)).rejects.toThrow(
      /STRAD_CORE_URL is not set/,
    );
  });

  it("a 404 from core is a fallback, not a fault", async () => {
    const missing = createParamClient({
      slug: "x-twitter",
      baseUrl: "http://core.invalid",
      token: TOKEN,
      fetchImpl: async () => new Response("{}", { status: 404 }),
    });
    expect(await missing.get(VARIABLE)).toBeUndefined();
  });
});

describe("choosing which store owns a path", () => {
  // A deployment can front more than one parameter store — strad's own and, in
  // the Tadasant deployment, a second one over a different GCP project. Writing
  // a credential into the wrong one succeeds and lands where the reader does not
  // read, so the selection is asserted directly rather than inferred.
  const withSecond = (namespace: string) =>
    parseConfig(
      YAML.replace("bundles:\n", "bundles:\n  - name: bundle-secrets-two\n") +
        `  - slug: zimmer-secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle-secrets-two
    path: /zimmer-secrets
    entitlements: [admin]
    env:
      SECRETS_PROJECT_ID: "zimmer-secrets-test"
      SECRETS_NAMESPACES: "${namespace}"
    consoleEnv:
      ZIMMER_SECRETS_SECRETS_PROJECT_ID: "zimmer-secrets-test"
      ZIMMER_SECRETS_SECRETS_NAMESPACES: "${namespace}"
      ZIMMER_SECRETS_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${SECRETS_ADMIN_KEY_JSON}"
`,
    );

  const BAG = { SECRETS_ADMIN_KEY_JSON: fake.endpoints.keyJson };
  const seam = { parametersStore: () => fake.store };

  it("picks the store whose namespace covers the path", () => {
    const cfg = withSecond("/zimmer/test/mcp/");
    const chosen = storeForPath(cfg, BAG, PATH, seam);
    expect(chosen.store).not.toBeNull();
  });

  it("refuses when two stores both claim the path", () => {
    // First-wins here would write the credential into whichever store happened
    // to be declared first, and the write would report success.
    const cfg = withSecond("/strad/test/mcp/");
    const chosen = storeForPath(cfg, BAG, PATH, seam);
    expect(chosen.store).toBeNull();
    expect((chosen as { reason: string }).reason).toMatch(/ambiguous/);
  });

  it("refuses when a deployment declares no secrets server at all", () => {
    const bare = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
`);
    const chosen = storeForPath(bare, {}, PATH, {});
    expect(chosen.store).toBeNull();
    expect((chosen as { reason: string }).reason).toMatch(/no secrets/);
  });
});

describe("the route's placement", () => {
  it("is not mounted on a bundle", async () => {
    // Core is the component that holds the store-admin credential. A bundle
    // serving this would be answering about a store it cannot reach, and the
    // shape of that mistake is a second writer nobody expected.
    const env: NodeJS.ProcessEnv = {
      STRAD_MODE: "bundle",
      STRAD_BUNDLE: "bundle",
      STRAD_INTERNAL_TOKEN: TOKEN,
    };
    const app = createApp({
      config: CONFIG,
      registry: await Registry.build({
        config: CONFIG,
        secrets: sharedSecretProviders(new EnvSecretProvider({})),
        mode: "bundle",
        bundleName: "bundle",
        env,
      }),
      tokenStore: tokenStoreFromConfig(CONFIG, env),
      mode: "bundle",
      env,
      parametersStore: () => fake.store,
    });
    const bundle = app.listen(0);
    await new Promise((r) => bundle.once("listening", r));
    const port = (bundle.address() as { port: number }).port;
    const res = await fetch(
      `http://127.0.0.1:${port}${paramRoutePath("x-twitter", VARIABLE)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(404);
    await new Promise((r) => bundle.close(r));
  });
});
