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
import { kindsOf, readableTarget, writableTarget } from "../src/http/params.ts";
import { createFakeGcp } from "../src/secrets/parameters/fake.ts";
import {
  layerNamespaces,
  oauthParameterPath,
  parameterPath,
  serverNamespaces,
} from "../src/secrets/parameters/namespace.ts";
import { ParameterStoreError } from "../src/secrets/parameters/index.ts";

/**
 * A credential the console CONSENTED to, that also ROTATES ON USE (#352).
 *
 * The console's callback mints a connector's refresh token under `oauth/`, and
 * `oauth/` outranks `static/` in every layered read. For a variable a server
 * names on its `oauth:` connector, the write-back route therefore considers both
 * kinds, `oauth/` first, and reads or rotates the highest one the store holds;
 * every other variable is addressed under `static/` alone.
 *
 * Over a real socket, through the client the bundle host runs, against the
 * in-memory Parameter Manager + Secret Manager double, so `rotate()`, the
 * base64url envelope and the `:render` path are the real ones. Each `describe`
 * uses its own slug, so no test depends on another's writes.
 */

const connector = (prefix: string) => `    oauth:
      provider: generic
      label: ${prefix}
      authorizeUrl: https://x.com/i/oauth2/authorize
      tokenUrl: https://api.x.com/2/oauth2/token
      scopes: [tweet.read, offline.access]
      clientIdVariable: ${prefix}_OAUTH_CLIENT_ID
      clientSecretVariable: ${prefix}_OAUTH_CLIENT_SECRET
      refreshTokenVariable: ${prefix}_OAUTH_REFRESH_TOKEN
`;

const server = (slug: string, lists: string, oauth = "") => `  - slug: ${slug}
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /${slug}
    entitlements: [admin]
    params: true
${lists}${oauth}`;

const YAML = `
version: 1
gateway: { name: strad, env: test, publicUrl: "https://strad.example" }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles:
  - name: bundle
  - name: bundle-secrets
servers:
${server("consented", "    paramsWritable: [C_OAUTH_REFRESH_TOKEN, C_PLAIN_TOKEN]\n", connector("C"))}
${server("migrated", "    paramsWritable: [M_OAUTH_REFRESH_TOKEN]\n", connector("M"))}
${server("unseeded", "    paramsWritable: [U_OAUTH_REFRESH_TOKEN]\n", connector("U"))}
${server("refreshing", "    paramsRefresh: [R_OAUTH_CLIENT_SECRET, R_OAUTH_REFRESH_TOKEN, R_PLAIN]\n", connector("R"))}
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
const CONSENT_NOTE = "consented via console; scopes: tweet.read offline.access";

const oauth = (slug: string, v: string) => oauthParameterPath("test", slug, v);
const stat = (slug: string, v: string) => parameterPath("test", slug, v);

const fake = createFakeGcp();
const runtimeEnv = new EnvSecretProvider({});
const runtimeProviders = sharedSecretProviders({
  name: runtimeEnv.name,
  get: (name: string) => runtimeEnv.get(name),
  invalidate: () => {},
});

let httpServer: Server;
let baseUrl: string;

beforeAll(async () => {
  // consented: the console consented (oauth/, secret, with its note) AND a stale
  // hand-typed copy of the same name still sits in static/. Plus an ordinary
  // writable name no connector owns.
  await fake.store.create({
    path: oauth("consented", "C_OAUTH_REFRESH_TOKEN"),
    secret: true,
    value: "consented-token",
    note: CONSENT_NOTE,
  });
  await fake.store.create({
    path: stat("consented", "C_OAUTH_REFRESH_TOKEN"),
    secret: true,
    value: "hand-typed-months-ago",
  });
  await fake.store.create({
    path: stat("consented", "C_PLAIN_TOKEN"),
    secret: true,
    value: "plain-seeded",
  });
  // migrated: a token seeded by hand under static/ before the connector was
  // added. Nobody has connected, so oauth/ holds nothing.
  await fake.store.create({
    path: stat("migrated", "M_OAUTH_REFRESH_TOKEN"),
    secret: true,
    value: "seeded-by-oauth-setup",
  });
  // refreshing: the client secret lives where the console tells a human to seed
  // it (static/ only); the refresh token has both copies; a plain name.
  await fake.store.create({
    path: stat("refreshing", "R_OAUTH_CLIENT_SECRET"),
    secret: true,
    value: "client-secret-in-static",
  });
  await fake.store.create({
    path: oauth("refreshing", "R_OAUTH_REFRESH_TOKEN"),
    secret: true,
    value: "refresh-in-oauth",
  });
  await fake.store.create({
    path: stat("refreshing", "R_OAUTH_REFRESH_TOKEN"),
    secret: true,
    value: "refresh-in-static",
  });
  await fake.store.create({
    path: stat("refreshing", "R_PLAIN"),
    secret: false,
    value: "plain-ref",
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
  httpServer = app.listen(0);
  await new Promise((r) => httpServer.once("listening", r));
  baseUrl = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise((r) => httpServer.close(r));
});

/** The client the bundle host runs. */
function client(slug: string) {
  return createParamClient({ slug, baseUrl, token: TOKEN });
}

/**
 * What a `params: true` render and the runtime provider read for a slug: both
 * kinds, layered, `oauth/` first.
 */
async function layered(slug: string): Promise<Record<string, string>> {
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

describe("a consented connector variable listed under paramsWritable:", () => {
  const SLUG = "consented";
  const VAR = "C_OAUTH_REFRESH_TOKEN";

  it("boot-reads the oauth/ copy when both kinds hold the name", async () => {
    // Precedence still prefers oauth/ — in the layered read that bakes the
    // container AND in the route's boot read, so the two agree.
    expect((await layered(SLUG))[VAR]).toBe("consented-token");
    expect(await client(SLUG).get(VAR)).toBe("consented-token");
  });

  it("round-trips: a rotation lands under oauth/, and the next boot reads it back", async () => {
    await client(SLUG).put(VAR, "rotated-once");

    expect(await fake.store.reveal(oauth(SLUG, VAR))).toBe("rotated-once");
    expect(await fake.store.reveal(stat(SLUG, VAR))).toBe(
      "hand-typed-months-ago",
    );
    // The next container's boot read, and the layered read a redeploy bakes.
    expect(await client(SLUG).get(VAR)).toBe("rotated-once");
    expect((await layered(SLUG))[VAR]).toBe("rotated-once");

    // Single-use tokens chain: a second rotation off the first.
    await client(SLUG).put(VAR, "rotated-twice");
    expect(await client(SLUG).get(VAR)).toBe("rotated-twice");
    expect((await layered(SLUG))[VAR]).toBe("rotated-twice");
  });

  it("keeps the parameter secret, its note and its render grant across a rotation", async () => {
    await client(SLUG).put(VAR, 'rotated "with" {awkward}\nbytes');
    const meta = (await fake.store.list(`/strad/test/mcp/${SLUG}/oauth/`)).find(
      (m) => m.path === oauth(SLUG, VAR),
    );
    expect(meta?.secret).toBe(true);
    expect(meta?.note).toBe(CONSENT_NOTE);
    // `:render` succeeding on a value that needs the base64url envelope is what
    // proves the per-parameter secretAccessor grant survived the write.
    const rendered = await fake.store.resolve(`/strad/test/mcp/${SLUG}/oauth/`);
    expect(rendered[VAR]).toBe('rotated "with" {awkward}\nbytes');
  });
});

describe("a connector added over a token seeded under static/", () => {
  const SLUG = "migrated";
  const VAR = "M_OAUTH_REFRESH_TOKEN";

  it("keeps reading and rotating the static/ copy until someone connects", async () => {
    expect(await client(SLUG).get(VAR)).toBe("seeded-by-oauth-setup");
    await client(SLUG).put(VAR, "rotated-in-static");
    expect(await fake.store.reveal(stat(SLUG, VAR))).toBe("rotated-in-static");
    // No oauth/ copy was conjured, and the restart reads the rotation back.
    expect(await revealOr404(oauth(SLUG, VAR))).toBe(404);
    expect(await client(SLUG).get(VAR)).toBe("rotated-in-static");
    expect((await layered(SLUG))[VAR]).toBe("rotated-in-static");
  });

  it("moves to oauth/ from the first connect on", async () => {
    // What the console's callback does on Connect.
    await fake.store.create({
      path: oauth(SLUG, VAR),
      secret: true,
      value: "freshly-consented",
      note: CONSENT_NOTE,
    });
    expect(await client(SLUG).get(VAR)).toBe("freshly-consented");
    await client(SLUG).put(VAR, "rotated-after-connect");
    expect(await fake.store.reveal(oauth(SLUG, VAR))).toBe(
      "rotated-after-connect",
    );
    expect(await fake.store.reveal(stat(SLUG, VAR))).toBe("rotated-in-static");
    expect((await layered(SLUG))[VAR]).toBe("rotated-after-connect");
  });
});

describe("a rotation nothing was seeded or consented for", () => {
  it("fails loudly and creates nothing under either kind", async () => {
    const VAR = "U_OAUTH_REFRESH_TOKEN";
    await expect(client("unseeded").put(VAR, "from-nowhere")).rejects.toThrow(
      /HTTP 404/,
    );
    expect(await revealOr404(oauth("unseeded", VAR))).toBe(404);
    expect(await revealOr404(stat("unseeded", VAR))).toBe(404);
  });
});

describe("a non-connector variable listed under paramsWritable:", () => {
  it("addresses static/ and nothing else", async () => {
    const SLUG = "consented";
    const VAR = "C_PLAIN_TOKEN";
    expect(writableTarget(CONFIG, SLUG, VAR)).toEqual({
      slug: SLUG,
      variable: VAR,
      kinds: ["static"],
    });
    await client(SLUG).put(VAR, "plain-rotated");
    expect(await fake.store.reveal(stat(SLUG, VAR))).toBe("plain-rotated");
    expect(await client(SLUG).get(VAR)).toBe("plain-rotated");
    expect(await revealOr404(oauth(SLUG, VAR))).toBe(404);
  });
});

describe("paramsRefresh: behaves the same way", () => {
  const SLUG = "refreshing";

  it("re-reads a connector variable through the same precedence", async () => {
    expect(
      readableTarget(CONFIG, SLUG, "R_OAUTH_REFRESH_TOKEN")?.kinds,
    ).toEqual(["oauth", "static"]);
    // Both copies held: oauth/ wins, as it does in the layered read.
    expect(await client(SLUG).get("R_OAUTH_REFRESH_TOKEN")).toBe(
      "refresh-in-oauth",
    );
    expect((await layered(SLUG))["R_OAUTH_REFRESH_TOKEN"]).toBe(
      "refresh-in-oauth",
    );
    // The client secret lives only where the console says to seed it, and a
    // refresh still finds it.
    expect(await client(SLUG).get("R_OAUTH_CLIENT_SECRET")).toBe(
      "client-secret-in-static",
    );
    expect(await client(SLUG).get("R_PLAIN")).toBe("plain-ref");
    expect(readableTarget(CONFIG, SLUG, "R_PLAIN")?.kinds).toEqual(["static"]);
    // A refresh-only name is still not writable, whatever its kinds.
    expect(writableTarget(CONFIG, SLUG, "R_OAUTH_REFRESH_TOKEN")).toBeNull();
  });
});

describe("the request cannot select the kind", () => {
  const post = (url: string, body: unknown) =>
    fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

  it("ignores a kind in the body and the query string", async () => {
    const SLUG = "consented";
    const VAR = "C_OAUTH_REFRESH_TOKEN";
    const staticBefore = await fake.store.reveal(stat(SLUG, VAR));
    const res = await post(
      `${baseUrl}${paramRoutePath(SLUG, VAR)}?kind=static`,
      { value: "asked-for-static", kind: "static" },
    );
    expect(res.status).toBe(200);
    // It went where the store's precedence says, not where the request asked.
    expect(await fake.store.reveal(oauth(SLUG, VAR))).toBe("asked-for-static");
    expect(await fake.store.reveal(stat(SLUG, VAR))).toBe(staticBefore);

    const res2 = await post(
      `${baseUrl}${paramRoutePath(SLUG, "C_PLAIN_TOKEN")}?kind=oauth`,
      { value: "asked-for-oauth", kind: "oauth" },
    );
    expect(res2.status).toBe(200);
    expect(await revealOr404(oauth(SLUG, "C_PLAIN_TOKEN"))).toBe(404);
    expect(await fake.store.reveal(stat(SLUG, "C_PLAIN_TOKEN"))).toBe(
      "asked-for-oauth",
    );
  });

  it("derives the candidate kinds from the config's connector, folding case", () => {
    const c = CONFIG.servers.find((s) => s.slug === "consented")!;
    expect(kindsOf(c, "C_OAUTH_REFRESH_TOKEN")).toEqual(["oauth", "static"]);
    expect(kindsOf(c, "c_oauth_refresh_token")).toEqual(["oauth", "static"]);
    expect(kindsOf(c, "C_OAUTH_CLIENT_ID")).toEqual(["oauth", "static"]);
    expect(kindsOf(c, "C_PLAIN_TOKEN")).toEqual(["static"]);
    // A server with no connector never considers oauth/.
    const secrets = CONFIG.servers.find((s) => s.slug === "secrets")!;
    expect(kindsOf(secrets, "C_OAUTH_REFRESH_TOKEN")).toEqual(["static"]);
  });
});
