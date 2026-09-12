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
} from "../src/secrets/param-route.ts";
import { kindOf, readableTarget, writableTarget } from "../src/http/params.ts";
import { createFakeGcp } from "../src/secrets/parameters/fake.ts";
import {
  layerNamespaces,
  oauthParameterPath,
  parameterPath,
  serverNamespaces,
} from "../src/secrets/parameters/namespace.ts";
import { ParameterStoreError } from "../src/secrets/parameters/index.ts";

/**
 * #352: a credential the console CONSENTED to, that also ROTATES ON USE.
 *
 * The console's callback mints a connector's refresh token under `oauth/`, and
 * `oauth/` outranks `static/` in every layered read. The write-back route used to
 * address `static/` unconditionally, so a rotation landed where the `oauth/`
 * copy shadowed it and the credential died at the next restart. The route now
 * resolves the kind from the config — `oauth/` for a variable the server names
 * on its `oauth:` connector, `static/` for everything else.
 *
 * Over a real socket, through the client the bundle host runs, against the
 * in-memory Parameter Manager + Secret Manager double, so `rotate()`, the
 * base64url envelope and the `:render` path are the real ones.
 */

const YAML = `
version: 1
gateway: { name: strad, env: test, publicUrl: "https://strad.example" }
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
    paramsWritable: [X_OAUTH_REFRESH_TOKEN, X_PLAIN_TOKEN]
    paramsRefresh: [X_OAUTH_CLIENT_SECRET, X_PLAIN_REFRESHED]
    oauth:
      provider: generic
      label: X
      authorizeUrl: https://x.com/i/oauth2/authorize
      tokenUrl: https://api.x.com/2/oauth2/token
      scopes: [tweet.read, offline.access]
      clientIdVariable: X_OAUTH_CLIENT_ID
      clientSecretVariable: X_OAUTH_CLIENT_SECRET
      refreshTokenVariable: X_OAUTH_REFRESH_TOKEN
  - slug: unconsented
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /unconsented
    entitlements: [admin]
    params: true
    paramsWritable: [U_OAUTH_REFRESH_TOKEN]
    oauth:
      provider: generic
      label: U
      authorizeUrl: https://u.example/authorize
      tokenUrl: https://u.example/token
      scopes: [read]
      clientIdVariable: U_OAUTH_CLIENT_ID
      clientSecretVariable: U_OAUTH_CLIENT_SECRET
      refreshTokenVariable: U_OAUTH_REFRESH_TOKEN
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
const SLUG = "x-twitter";
const REFRESH = "X_OAUTH_REFRESH_TOKEN";
const PLAIN = "X_PLAIN_TOKEN";

const OAUTH_REFRESH = oauthParameterPath("test", SLUG, REFRESH);
const STATIC_REFRESH = parameterPath("test", SLUG, REFRESH);
const OAUTH_PLAIN = oauthParameterPath("test", SLUG, PLAIN);
const STATIC_PLAIN = parameterPath("test", SLUG, PLAIN);

/** What a console consent wrote, and what a human once typed by hand. */
const CONSENTED = "refresh-token-the-console-consent-minted";
const HAND_TYPED = "refresh-token-a-human-typed-months-ago";
const CONSENT_NOTE = "consented via console; scopes: tweet.read offline.access";

const fake = createFakeGcp();
const runtimeEnv = new EnvSecretProvider({});
const runtimeProviders = sharedSecretProviders({
  name: runtimeEnv.name,
  get: (name: string) => runtimeEnv.get(name),
  invalidate: () => {},
});

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  // The state #352 is about: the console consented (oauth/, secret, with its
  // note), AND a stale hand-typed copy of the same name still sits in static/.
  await fake.store.create({
    path: OAUTH_REFRESH,
    secret: true,
    value: CONSENTED,
    note: CONSENT_NOTE,
  });
  await fake.store.create({
    path: STATIC_REFRESH,
    secret: true,
    value: HAND_TYPED,
  });
  // An ordinary writable name, on the same server, that no connector owns.
  await fake.store.create({
    path: STATIC_PLAIN,
    secret: true,
    value: "plain-seeded",
  });

  const env: NodeJS.ProcessEnv = {
    STRAD_MODE: "core",
    STRAD_INTERNAL_TOKEN: TOKEN,
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
    parametersStore: () => fake.store,
    secretProvider: runtimeProviders,
    diagnosticStore: {
      list: (namespace: string) => fake.store.list(namespace),
      resolveDetailed: (namespace: string) =>
        fake.store.resolveDetailed!(namespace),
    },
  });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

/** The client the bundle host runs. */
function client(slug = SLUG) {
  return createParamClient({ slug, baseUrl, token: TOKEN });
}

/**
 * What a `params: true` render and the runtime provider read for this slug:
 * both kinds, layered, `oauth/` first.
 */
async function layered(slug = SLUG): Promise<Record<string, string>> {
  return layerNamespaces(
    await Promise.all(
      serverNamespaces("test", slug).map((ns) => fake.store.resolve(ns)),
    ),
  );
}

async function revealOr404(path: string): Promise<string | 404> {
  try {
    return await fake.store.reveal(path);
  } catch (err) {
    if (err instanceof ParameterStoreError && err.status === 404) return 404;
    throw err;
  }
}

describe("a connector variable listed under paramsWritable:", () => {
  it("boot-reads the consented oauth/ copy, not the shadowed static/ one", async () => {
    // Precedence still prefers oauth/ when both kinds hold the name — in the
    // layered read that bakes the container AND in the route's boot read, so
    // the two agree.
    expect((await layered())[REFRESH]).toBe(CONSENTED);
    expect(await client().get(REFRESH)).toBe(CONSENTED);
  });

  it("round-trips: a rotation lands under oauth/, and the next boot reads it back", async () => {
    const rotated = "refresh-token-x-just-minted";
    await client().put(REFRESH, rotated);

    // Landed in oauth/ …
    expect(await fake.store.reveal(OAUTH_REFRESH)).toBe(rotated);
    // … and static/ was not touched.
    expect(await fake.store.reveal(STATIC_REFRESH)).toBe(HAND_TYPED);
    // The next container's boot read finds it …
    expect(await client().get(REFRESH)).toBe(rotated);
    // … and so does the layered read a redeploy would bake. This is the
    // restart that used to come back holding a dead credential.
    expect((await layered())[REFRESH]).toBe(rotated);

    // A second rotation, off the first: single-use tokens chain.
    const again = "refresh-token-x-minted-after-that";
    await client().put(REFRESH, again);
    expect(await client().get(REFRESH)).toBe(again);
    expect((await layered())[REFRESH]).toBe(again);
  });

  it("keeps the parameter secret and the consent note intact across a rotation", async () => {
    await client().put(REFRESH, "refresh-token-rotated-again");
    const meta = (await fake.store.list(`/strad/test/mcp/${SLUG}/oauth/`)).find(
      (m) => m.path === OAUTH_REFRESH,
    );
    expect(meta?.secret).toBe(true);
    // The console's record of who consented to what survives a machine write.
    expect(meta?.note).toBe(CONSENT_NOTE);
  });

  it("cannot conjure a credential the console never minted", async () => {
    // `rotate()` refuses a path that does not exist, so a rotation before the
    // first consent fails LOUDLY and creates nothing under either kind.
    await expect(
      client("unconsented").put("U_OAUTH_REFRESH_TOKEN", "from-nowhere"),
    ).rejects.toThrow(/HTTP 404/);
    expect(
      await revealOr404(
        oauthParameterPath("test", "unconsented", "U_OAUTH_REFRESH_TOKEN"),
      ),
    ).toBe(404);
    expect(
      await revealOr404(
        parameterPath("test", "unconsented", "U_OAUTH_REFRESH_TOKEN"),
      ),
    ).toBe(404);
  });
});

describe("a non-connector variable listed under paramsWritable:", () => {
  it("still addresses static/, exactly as before", async () => {
    expect(writableTarget(CONFIG, SLUG, PLAIN)).toEqual({
      slug: SLUG,
      variable: PLAIN,
      kind: "static",
    });
    await client().put(PLAIN, "plain-rotated");
    expect(await fake.store.reveal(STATIC_PLAIN)).toBe("plain-rotated");
    expect(await client().get(PLAIN)).toBe("plain-rotated");
    // Nothing was created under oauth/ for it.
    expect(await revealOr404(OAUTH_PLAIN)).toBe(404);
  });
});

describe("paramsRefresh: behaves the same way", () => {
  it("re-reads a connector variable from oauth/ and a plain one from static/", async () => {
    const secretOauth = oauthParameterPath(
      "test",
      SLUG,
      "X_OAUTH_CLIENT_SECRET",
    );
    const secretStatic = parameterPath("test", SLUG, "X_OAUTH_CLIENT_SECRET");
    await fake.store.create({
      path: secretOauth,
      secret: true,
      value: "cs-oauth",
    });
    await fake.store.create({
      path: secretStatic,
      secret: true,
      value: "cs-static",
    });
    const plain = parameterPath("test", SLUG, "X_PLAIN_REFRESHED");
    await fake.store.create({ path: plain, secret: false, value: "plain-ref" });

    expect(readableTarget(CONFIG, SLUG, "X_OAUTH_CLIENT_SECRET")?.kind).toBe(
      "oauth",
    );
    expect(readableTarget(CONFIG, SLUG, "X_PLAIN_REFRESHED")?.kind).toBe(
      "static",
    );
    // The re-read agrees with the layered read that baked the container.
    expect(await client().get("X_OAUTH_CLIENT_SECRET")).toBe("cs-oauth");
    expect((await layered())["X_OAUTH_CLIENT_SECRET"]).toBe("cs-oauth");
    expect(await client().get("X_PLAIN_REFRESHED")).toBe("plain-ref");
    // And a refresh-only name is still not writable, whatever its kind.
    expect(writableTarget(CONFIG, SLUG, "X_OAUTH_CLIENT_SECRET")).toBeNull();
  });
});

describe("the request cannot select the kind", () => {
  const post = (url: string, body: unknown) =>
    fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "x-strad-kind": "static",
      },
      body: JSON.stringify(body),
    });

  it("ignores a kind in the body, the query string and a header", async () => {
    const before = await fake.store.reveal(STATIC_REFRESH);
    const res = await post(
      `${baseUrl}${paramRoutePath(SLUG, REFRESH)}?kind=static`,
      { value: "trying-to-land-in-static", kind: "static" },
    );
    expect(res.status).toBe(200);
    // It went where the CONFIG says, not where the request asked.
    expect(await fake.store.reveal(OAUTH_REFRESH)).toBe(
      "trying-to-land-in-static",
    );
    expect(await fake.store.reveal(STATIC_REFRESH)).toBe(before);

    const plainBefore = await fake.store.reveal(STATIC_PLAIN);
    const res2 = await post(
      `${baseUrl}${paramRoutePath(SLUG, PLAIN)}?kind=oauth`,
      { value: "trying-to-land-in-oauth", kind: "oauth" },
    );
    expect(res2.status).toBe(200);
    expect(await revealOr404(OAUTH_PLAIN)).toBe(404);
    expect(await fake.store.reveal(STATIC_PLAIN)).toBe(
      "trying-to-land-in-oauth",
    );
    expect(plainBefore).not.toBe("trying-to-land-in-oauth");
  });

  it("refuses a kind spelled into the variable segment", async () => {
    for (const variable of [
      `static/${REFRESH}`,
      `oauth/${PLAIN}`,
      `../static/${REFRESH}`,
    ]) {
      const res = await fetch(
        `${baseUrl}/_strad/params/${SLUG}/${encodeURIComponent(variable)}`,
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
    }
  });

  it("derives the kind from the config's connector, folding case like parameterId", () => {
    const x = CONFIG.servers.find((s) => s.slug === SLUG)!;
    expect(kindOf(x, REFRESH)).toBe("oauth");
    expect(kindOf(x, "x_oauth_refresh_token")).toBe("oauth");
    expect(kindOf(x, "X_OAUTH_CLIENT_ID")).toBe("oauth");
    expect(kindOf(x, PLAIN)).toBe("static");
    const secrets = CONFIG.servers.find((s) => s.slug === "secrets")!;
    expect(kindOf(secrets, REFRESH)).toBe("static");
  });
});
