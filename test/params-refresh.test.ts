import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { componentToken } from "../src/auth/internal-token.ts";
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
  parseParamRefreshPlan,
  refreshParamsOnce,
  PARAM_REFRESH_ENV,
} from "../src/secrets/param-route.ts";
import { prefixedEnvName } from "../src/secrets/env-prefix.ts";
import { readableTarget, writableTarget } from "../src/http/params.ts";
import { createFakeGcp } from "../src/secrets/parameters/fake.ts";
import { parameterPath } from "../src/secrets/parameters/namespace.ts";

/**
 * `paramsRefresh:` end to end — a credential rotated in the store reaching a
 * RUNNING server, with no redeploy.
 *
 * This is the claim the whole feature rests on, so it is asserted against the
 * real pieces rather than a mock of them: core's actual `/_strad/params` route
 * over a real socket, the in-memory Parameter Manager + Secret Manager double
 * behind it (so the base64url envelope and the per-parameter `secretAccessor`
 * grant are the real ones), and the client + refresh loop from
 * `src/secrets/param-route.ts`, which is byte-identical to the copy the bundle
 * host runs (test/vendored.sync.test.ts).
 *
 * The thing standing in for the container is `container.env` — a plain object
 * playing `process.env` — and the thing standing in for a mount is `fetchCall`,
 * which reads its key out of that object WHEN IT IS CALLED. That is not a
 * convenience: it is exactly what `servers/strad-fetch` does (its client factory
 * reads `process.env.BRIGHTDATA_API_KEY`, and `registerHandlers` runs per
 * request), and it is the property that makes an env refresh reach a live
 * server at all.
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
  - slug: strad-fetch
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /strad-fetch
    entitlements: [admin]
    params: true
    paramsRefresh: [BRIGHTDATA_API_KEY, LATE_SEEDED_KEY]
  - slug: slack
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /slack
    entitlements: [admin]
    params: true
  - slug: x-twitter
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /x-twitter
    entitlements: [admin]
    params: true
    paramsWritable: [X_OAUTH_REFRESH_TOKEN]
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
/** The ROOT core holds, and the `bundle` component's own token derived from it. */
const ROOT = "InternalTokenValueNeverShown";
const TOKEN = componentToken(ROOT, "bundle");
const KEY = "BRIGHTDATA_API_KEY";
const KEY_PATH = parameterPath("test", "strad-fetch", KEY);
const LATE = "LATE_SEEDED_KEY";
const LATE_PATH = parameterPath("test", "strad-fetch", LATE);

/** What the last render baked onto the container — the token Tadas rotated away from. */
const BAKED = "brightdata-token-from-the-last-render";
/** What a human just put in the store, with no deploy behind it. */
const ROTATED = "brightdata-token-rotated-without-a-deploy";

const fake = createFakeGcp();

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  // SECRET parameters, which is the interesting kind: the value lives in Secret
  // Manager behind a `__REF__` pointer and comes back through `:render`.
  await fake.store.create({ path: KEY_PATH, secret: true, value: BAKED });

  const env: NodeJS.ProcessEnv = {
    STRAD_MODE: "core",
    STRAD_INTERNAL_TOKEN: ROOT,
    STRAD_BUNDLE_URL_BUNDLE: "http://bundle:8080",
    STRAD_BUNDLE_URL_BUNDLE_SECRETS: "http://bundle-secrets:8080",
  };
  const app = createApp({
    config: CONFIG,
    registry: await Registry.build({
      config: CONFIG,
      secrets: sharedSecretProviders(new EnvSecretProvider({})),
      mode: "core",
      env,
    }),
    tokenStore: tokenStoreFromConfig(CONFIG, env),
    mode: "core",
    env,
    parametersStore: () => fake.store,
  });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

/**
 * A stand-in for a supplementary container: the environment the deploy baked,
 * and the refresh loop the bundle host runs over it.
 *
 * `names` mirrors `startParamRefresh` exactly — the bare name the renderer wrote
 * a parameter under, plus this slug's `<SLUG>__<NAME>` alias, which is what a
 * tree reading through `slugEnvView` would look for.
 */
function container(baked: Record<string, string | undefined>) {
  const env: Record<string, string | undefined> = { ...baked };
  const plan = parseParamRefreshPlan({
    [PARAM_REFRESH_ENV]: JSON.stringify({
      "strad-fetch": [KEY, LATE],
    }),
  });
  return {
    env,
    /** What a `strad-fetch` tool call would use, resolved AT CALL TIME. */
    fetchCall: () => env[KEY],
    refresh: () =>
      refreshParamsOnce({
        plan,
        clientFor: (slug) => createParamClient({ slug, baseUrl, token: TOKEN }),
        env,
        names: (slug, variable) => {
          const alias = prefixedEnvName(slug, variable);
          return alias === null ? [variable] : [variable, alias];
        },
      }),
  };
}

describe("a credential rotated in the store, with no redeploy", () => {
  it("reaches a running server on the next call", async () => {
    // The container is up, holding what the last render baked. This is the state
    // production was in: prod had not been redeployed since the rotation, so the
    // containers were still serving the old token.
    const c = container({ [KEY]: BAKED });
    expect(c.fetchCall()).toBe(BAKED);

    // A human rotates the credential in the store. No deploy, no restart.
    await fake.store.rotate(KEY_PATH, ROTATED);

    // Nothing has told the container yet, so it is still serving the old one —
    // this is the old behaviour, and it is what the poll below is for.
    expect(c.fetchCall()).toBe(BAKED);

    const changed = await c.refresh();

    expect(changed).toEqual([{ slug: "strad-fetch", variable: KEY }]);
    // THE CLAIM: the same process, never restarted, now uses the new token.
    expect(c.fetchCall()).toBe(ROTATED);
  });

  it("writes the per-slug alias as well as the bare name", async () => {
    // A tree reading through `slugEnvView` sees `STRAD_FETCH__BRIGHTDATA_API_KEY`
    // in preference to the bare one. Refreshing only the bare name would land the
    // value on a name that tree does not read — green, quiet, and useless.
    const c = container({ [KEY]: BAKED });
    await c.refresh();
    expect(c.env[KEY]).toBe(ROTATED);
    expect(c.env[`STRAD_FETCH__${KEY}`]).toBe(ROTATED);
  });

  it("reports nothing when the value has not moved", async () => {
    // The change log has to be a record of rotations, not a heartbeat.
    const c = container({ [KEY]: ROTATED });
    expect(await c.refresh()).toEqual([]);
  });

  it("picks up a credential seeded AFTER the deploy", async () => {
    // The other half of the ask: a name a config listed but nobody had seeded
    // bakes no env var, so the container comes up without it. Seeding it later
    // used to need a redeploy too.
    const c = container({ [KEY]: ROTATED });
    expect(c.env[LATE]).toBeUndefined();

    await fake.store.create({
      path: LATE_PATH,
      secret: true,
      value: "seeded-after-the-deploy",
    });

    expect(await c.refresh()).toEqual([
      { slug: "strad-fetch", variable: LATE },
    ]);
    expect(c.env[LATE]).toBe("seeded-after-the-deploy");
  });

  it("keeps the baked value when core cannot answer", async () => {
    // A degraded dependency must not become an outage: the value the deploy
    // baked is a credential that at least used to work. Same posture as the boot
    // read, which is the whole reason `get()` promises not to throw.
    const env: Record<string, string | undefined> = { [KEY]: BAKED };
    const changed = await refreshParamsOnce({
      plan: [{ slug: "strad-fetch", variables: [KEY] }],
      clientFor: (slug) =>
        createParamClient({
          slug,
          baseUrl: "http://127.0.0.1:1",
          token: TOKEN,
          timeoutMs: 250,
        }),
      env,
      names: (_slug, variable) => [variable],
    });
    expect(changed).toEqual([]);
    expect(env[KEY]).toBe(BAKED);
  });

  it("lets one server's failure not stop the next server's refresh", async () => {
    // A background loop over several slugs must be independent per slug: `get()`
    // promises not to throw, but it is an interface.
    const env: Record<string, string | undefined> = { [KEY]: BAKED };
    const changed = await refreshParamsOnce({
      plan: [
        { slug: "broken", variables: ["ANY"] },
        { slug: "strad-fetch", variables: [KEY] },
      ],
      clientFor: (slug) =>
        slug === "broken"
          ? {
              get: () => Promise.reject(new Error("boom")),
              put: () => Promise.reject(new Error("boom")),
            }
          : createParamClient({ slug, baseUrl, token: TOKEN }),
      env,
      names: (_slug, variable) => [variable],
    });
    expect(changed).toEqual([{ slug: "strad-fetch", variable: KEY }]);
    expect(env[KEY]).toBe(ROTATED);
  });
});

describe("the old behaviour, which is still what a default config gets", () => {
  it("refreshes nothing at all when no server sets paramsRefresh:", async () => {
    // NO MANIFEST ON THE CONTAINER -> NO PLAN -> NOT ONE REQUEST TO CORE. This
    // is every strad deployment today, and it must keep behaving exactly as it
    // did: the value the deploy baked is the value that serves, however far the
    // store has moved on.
    const env: Record<string, string | undefined> = { [KEY]: BAKED };
    await fake.store.rotate(KEY_PATH, ROTATED);

    expect(parseParamRefreshPlan(env)).toEqual([]);

    let calls = 0;
    const changed = await refreshParamsOnce({
      plan: parseParamRefreshPlan(env),
      clientFor: (slug) => {
        calls += 1;
        return createParamClient({ slug, baseUrl, token: TOKEN });
      },
      env,
      names: (_slug, variable) => [variable],
    });

    expect(calls).toBe(0);
    expect(changed).toEqual([]);
    expect(env[KEY]).toBe(BAKED);
  });

  it("leaves a sibling slug on the same bundle untouched", async () => {
    // `slack` shares the bundle and lists nothing, so the manifest names it
    // nowhere. One server opting in must not drag its neighbours' credentials
    // into a runtime read path they did not ask for.
    const env: Record<string, string | undefined> = {
      [KEY]: BAKED,
      SLACK_BOT_TOKEN: "slack-token-from-the-last-render",
    };
    await fake.store.rotate(KEY_PATH, ROTATED);

    await refreshParamsOnce({
      plan: parseParamRefreshPlan({
        [PARAM_REFRESH_ENV]: JSON.stringify({ "strad-fetch": [KEY] }),
      }),
      clientFor: (slug) => createParamClient({ slug, baseUrl, token: TOKEN }),
      env,
      names: (_slug, variable) => [variable],
    });

    expect(env[KEY]).toBe(ROTATED);
    expect(env.SLACK_BOT_TOKEN).toBe("slack-token-from-the-last-render");
  });
});

describe("what the route will and will not hand back", () => {
  const get = (slug: string, variable: string) =>
    fetch(`${baseUrl}${paramRoutePath(slug, variable)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

  it("serves a name the config listed under paramsRefresh", async () => {
    const res = await get("strad-fetch", KEY);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { value: string }).value).toBe(ROTATED);
  });

  it("refuses a name in the same namespace that nothing listed", async () => {
    // The allowlist is the fence, not the namespace. `params: true` bakes the
    // whole namespace onto the component, but only a name a human wrote in the
    // config may be re-read — which is what keeps the rendered spec the record
    // of every variable this component can ever hold.
    await fake.store.create({
      path: parameterPath("test", "strad-fetch", "UNLISTED_KEY"),
      secret: true,
      value: "should never travel",
    });
    const res = await get("strad-fetch", "UNLISTED_KEY");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "parameter_not_writable",
    );
  });

  it("refuses every name for a server that listed none", async () => {
    // The default-off claim, at the route: `slack` sets `params: true` and
    // neither list, so nothing about it is readable here.
    expect((await get("slack", "SLACK_BOT_TOKEN")).status).toBe(403);
  });

  it("still serves a paramsWritable name, which is the boot read", async () => {
    // The pre-existing behaviour. A writer has to be able to read back what it
    // is about to rotate, and widening the GET must not have narrowed it.
    await fake.store.create({
      path: parameterPath("test", "x-twitter", "X_OAUTH_REFRESH_TOKEN"),
      secret: true,
      value: "x-token",
    });
    const res = await get("x-twitter", "X_OAUTH_REFRESH_TOKEN");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { value: string }).value).toBe("x-token");
  });

  it("refuses an unauthenticated read", async () => {
    const res = await fetch(`${baseUrl}${paramRoutePath("strad-fetch", KEY)}`);
    expect(res.status).toBe(401);
  });
});

describe("the two allowlists stay separate", () => {
  it("does NOT let a paramsRefresh name be written", async () => {
    // The verbs are not the same risk. A read of a name the component already
    // holds discloses nothing; a write can replace a working credential. Only
    // `paramsWritable:` opens the POST.
    const res = await fetch(`${baseUrl}${paramRoutePath("strad-fetch", KEY)}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ value: "written-by-a-refresh-only-name" }),
    });
    expect(res.status).toBe(403);
    // And the store is untouched.
    expect(await fake.store.reveal(KEY_PATH)).toBe(ROTATED);
  });

  it("is the same split in the lookups the route composes paths from", () => {
    expect(writableTarget(CONFIG, "strad-fetch", KEY)).toBeNull();
    expect(readableTarget(CONFIG, "strad-fetch", KEY)).toEqual({
      slug: "strad-fetch",
      variable: KEY,
      kinds: ["static"],
    });
    // A writable name is readable too — that is the boot read.
    expect(
      readableTarget(CONFIG, "x-twitter", "X_OAUTH_REFRESH_TOKEN"),
    ).toEqual({
      slug: "x-twitter",
      variable: "X_OAUTH_REFRESH_TOKEN",
      kinds: ["static"],
    });
    // And neither list is a namespace: a sibling's name is not reachable.
    expect(readableTarget(CONFIG, "strad-fetch", "SLACK_BOT_TOKEN")).toBeNull();
  });
});
