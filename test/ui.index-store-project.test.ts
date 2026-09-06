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
  collectRequirements,
  fixTargets,
  storeProject,
  storeProjectForPath,
  unobservableTarget,
} from "../src/ui/secret-status.ts";
import type { SecretRequirement } from "../src/ui/secret-status.ts";

/**
 * THE ROSTER NAMES THE PROJECT THAT OWNS THE PATH, not the page's first store.
 *
 * `consoleStores:` puts N parameter stores on one `/ui/<slug>` page, each with
 * its own project and its own namespaces. The console INDEX prints
 * copy-pasteable `gcloud` commands for every secret it reports missing, and it
 * used to answer "which project" once per DEPLOYMENT — the first store on the
 * first slug that declared one. On a page whose stores are partitioned by
 * namespace that is a wrong answer handed to a human who came to the index
 * specifically to be told the right one (tadasant/strad#261).
 *
 * The fixture is the shape that makes it visible and that nothing else in the
 * suite has: two stores, DIFFERENT projects, and a partition INSIDE
 * `/strad/{env}/` so that a strad `${NAME}` really can be owned by the second
 * one. `shop`'s own namespace lives in the second store; the shared gateway
 * namespace lives in the first. One missing name, two routes, two projects — a
 * single id cannot be right about both.
 *
 * The question is asked per PATH, the same question `storeForPath` in
 * `src/http/params.ts` asks of the write-back route, so the index cannot
 * describe a store differently from the page that shows it. Nothing here
 * resolves a secret: the answer reaches a printed `--project` and nothing else.
 */

const BOOTSTRAP = "bootstrap-secret-xyz";

/** The store that owns the SHARED gateway namespace. Declared FIRST. */
const GATEWAY_PROJECT = "strad-gateway-secrets-test";
const GATEWAY_NS = "/strad/test/gateway/";

/** The store that owns every server's OWN namespace. Declared SECOND. */
const SERVER_PROJECT = "strad-server-secrets-test";
const SERVER_NS = "/strad/test/mcp/";

function key(email: string): string {
  return JSON.stringify({
    client_email: email,
    private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
  });
}

const GATEWAY_ADMIN_KEY = key("gateway-admin@strad.iam.gserviceaccount.com");
const SERVER_ADMIN_KEY = key("server-admin@strad.iam.gserviceaccount.com");

/** Every credential except `${SHOP_PASSWORD}`, which is the missing one. */
const SECRETS = { GATEWAY_ADMIN_KEY, SERVER_ADMIN_KEY };

const MULTI_YAML = `
version: 1
gateway:
  name: strad
  env: test
  secrets: { provider: gcp-parameter-store }
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin] }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle
servers:
  - slug: shop
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /shop
    entitlements: [admin]
    env:
      SHOP_PASSWORD: "\${SHOP_PASSWORD}"
  - slug: secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /secrets
    entitlements: [admin]
    consoleEnv:
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${GATEWAY_ADMIN_KEY}"
      SERVER_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${SERVER_ADMIN_KEY}"
    consoleStores:
      - project: "${GATEWAY_PROJECT}"
        label: gateway keys
        namespaces: ["${GATEWAY_NS}"]
        adminKeyVar: SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON
      - project: "${SERVER_PROJECT}"
        label: server keys
        namespaces: ["${SERVER_NS}"]
        adminKeyVar: SERVER_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON
`;

const MULTI = parseConfig(MULTI_YAML);

/**
 * The same deployment with ONE store, which is every config written before
 * `consoleStores:`. Its answer must not move.
 */
const SINGLE = parseConfig(`
version: 1
gateway:
  name: strad
  env: test
  secrets: { provider: gcp-parameter-store }
auth: { staticTokens: { enabled: true } }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle
servers:
  - slug: shop
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /shop
    entitlements: [admin]
    env:
      SHOP_PASSWORD: "\${SHOP_PASSWORD}"
  - slug: secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /secrets
    entitlements: [admin]
    env:
      SECRETS_PROJECT_ID: strad-secrets-test
      SECRETS_NAMESPACES: "/strad/test/"
`);

/**
 * TWO secrets slugs whose namespaces overlap, on two bundles.
 *
 * The one shape in which two stores in different projects can both claim one
 * path: the schema refuses the overlap inside a single `consoleStores:` list,
 * and a bundle carries at most one secrets slug.
 */
const OVERLAPPING = parseConfig(`
version: 1
gateway:
  name: strad
  env: test
  secrets: { provider: gcp-parameter-store }
auth: { staticTokens: { enabled: true } }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: one
  - name: two
servers:
  - slug: secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: one
    path: /secrets
    entitlements: [admin]
    consoleEnv:
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${GATEWAY_ADMIN_KEY}"
    consoleStores:
      - project: "${GATEWAY_PROJECT}"
        namespaces: ["/strad/test/"]
        adminKeyVar: SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON
  - slug: other-secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: two
    path: /secrets
    entitlements: [admin]
    consoleEnv:
      OTHER_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${SERVER_ADMIN_KEY}"
    consoleStores:
      - project: "${SERVER_PROJECT}"
        namespaces: ["${SERVER_NS}"]
        adminKeyVar: OTHER_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON
`);

/**
 * A resolver project that NO store declares.
 *
 * Every "it falls back" assertion below is made against this rather than against
 * `storeProject(config, {})`, because on these fixtures the deployment default
 * IS the first declared store — so the obvious assertion is satisfied equally by
 * a correct fallback and by the first-covering-store pick this function exists
 * to refuse.
 */
const RESOLVER_PROJECT = "resolver-only-project";
const RESOLVER: NodeJS.ProcessEnv = {
  STRAD_PARAMS_PROJECT_ID: RESOLVER_PROJECT,
};

/**
 * The same partition declared on the `/mcp` half instead of the console's.
 *
 * `mcpStores:` reaches no console view — `resolveServerView` does not read it,
 * and the schema refuses a server that declares it alongside a
 * `SECRETS_PROJECT_ID` under `env:` — so it is the shape that would silently
 * keep the first-store answer if the roster asked the console view alone.
 */
const MCP_ONLY = parseConfig(`
version: 1
gateway:
  name: strad
  env: test
  secrets: { provider: gcp-parameter-store }
auth: { staticTokens: { enabled: true } }
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
      GATEWAY_SECRETS_SERVICE_ACCOUNT_KEY_JSON: "\${GATEWAY_ADMIN_KEY}"
      SERVER_SECRETS_SERVICE_ACCOUNT_KEY_JSON: "\${SERVER_ADMIN_KEY}"
    mcpStores:
      - project: "${GATEWAY_PROJECT}"
        namespaces: ["${GATEWAY_NS}"]
        viewerKeyVar: GATEWAY_SECRETS_SERVICE_ACCOUNT_KEY_JSON
      - project: "${SERVER_PROJECT}"
        namespaces: ["${SERVER_NS}"]
        viewerKeyVar: SERVER_SECRETS_SERVICE_ACCOUNT_KEY_JSON
`);

/** The `${SHOP_PASSWORD}` requirement, read off the config rather than built. */
function shopPassword(config = MULTI): SecretRequirement {
  const req = collectRequirements(config).find(
    (r) => r.name === "SHOP_PASSWORD",
  );
  if (!req) throw new Error("fixture no longer references SHOP_PASSWORD");
  return req;
}

// ---------------------------------------------------------------------------
// The defect, at the function that prints the project
// ---------------------------------------------------------------------------

describe("a multi-store slug's fix targets", () => {
  const targets = fixTargets(MULTI, shopPassword(), {});
  const byResource = new Map(targets.map((t) => [t.resource, t]));

  it("names the SECOND store for a path the second store owns", () => {
    // THE DEFECT. `/strad/test/mcp/` belongs to the second consoleStores: entry,
    // and this is the route the page recommends FIRST on a store-backed
    // deployment — so the first thing a reader is told to paste was the one most
    // likely to be wrong.
    const own = byResource.get("/strad/test/mcp/shop/static/SHOP_PASSWORD");
    expect(own).toBeDefined();
    expect(own!.project).toBe(SERVER_PROJECT);
    expect(own!.detail).not.toContain("inferred from the naming convention");
  });

  it("names the FIRST store for the shared gateway namespace, on the same row", () => {
    // One missing name, two parameter routes, two projects. This is the pair a
    // single deployment-wide id cannot be right about at once.
    const shared = byResource.get("/strad/test/gateway/static/SHOP_PASSWORD");
    expect(shared).toBeDefined();
    expect(shared!.project).toBe(GATEWAY_PROJECT);
    expect(
      byResource.get("/strad/test/mcp/shop/static/SHOP_PASSWORD")!.project,
    ).not.toBe(shared!.project);
  });

  it("leaves the Secret Manager route on the deployment's own project", () => {
    // `strad-test-*` is not a parameter path — the deploy workflow reads those
    // secrets out of the deployment's project, whatever the parameter stores are
    // partitioned into — so it keeps the default rather than being routed by a
    // namespace it does not live under.
    const baked = byResource.get("strad-test-SHOP_PASSWORD");
    expect(baked).toBeDefined();
    expect(baked!.project).toBe(storeProject(MULTI, {}).project);
    expect(baked!.commands.join("\n")).toContain(
      `--project ${storeProject(MULTI, {}).project}`,
    );
  });

  it("routes a MANAGED parameter by its own static namespace", () => {
    // A managed parameter takes an early return with ONE target, so it does not
    // go through the routes above at all — and it is the case where the path is
    // most obviously a server's own: `params: true` resolves everything under
    // that namespace and nothing else.
    const managed = fixTargets(
      MULTI,
      { ...shopPassword(), managed: true, paramsSlugs: ["shop"] },
      {},
    );
    expect(managed).toHaveLength(1);
    expect(managed[0]!.resource).toBe(
      "/strad/test/mcp/shop/static/SHOP_PASSWORD",
    );
    expect(managed[0]!.project).toBe(SERVER_PROJECT);
  });

  it("routes the params: true note by its namespace on an env deployment", () => {
    // Under `provider: env` the per-server route is dropped and this note takes
    // its place, LAST and labelled as not a fix. It still names a parameter
    // path, so it still has an owning store.
    const envProvider = parseConfig(
      MULTI_YAML.replace("  secrets: { provider: gcp-parameter-store }\n", ""),
    );
    const targets = fixTargets(
      envProvider,
      { ...shopPassword(envProvider), paramsSlugs: ["shop"] },
      {},
    );
    const note = targets[targets.length - 1]!;
    expect(note.resource).toBe("/strad/test/mcp/shop/static/SHOP_PASSWORD");
    expect(note.detail).toContain("NOT a fix for this row");
    expect(note.project).toBe(SERVER_PROJECT);
    // …and the Secret Manager route beside it keeps the deployment default.
    expect(
      targets.find((t) => t.resource === "strad-test-SHOP_PASSWORD")!.project,
    ).toBe(storeProject(envProvider, {}).project);
  });

  it("points the namespace popout at the store that owns THAT namespace", () => {
    const own = unobservableTarget(
      MULTI,
      {
        component: "strad-bundle",
        namespace: "/strad/test/mcp/shop/static/",
        reason: "unwired",
        detail: "no private URL bound",
      },
      {},
    );
    expect(own.project).toBe(SERVER_PROJECT);

    const shared = unobservableTarget(
      MULTI,
      {
        component: "strad-core",
        namespace: GATEWAY_NS,
        reason: "unwired",
        detail: "no private URL bound",
      },
      {},
    );
    expect(shared.project).toBe(GATEWAY_PROJECT);
  });
});

// ---------------------------------------------------------------------------
// storeProjectForPath — including everything it refuses to decide
// ---------------------------------------------------------------------------

describe("storeProjectForPath", () => {
  it("resolves each namespace to the store that covers it", () => {
    expect(
      storeProjectForPath(MULTI, "/strad/test/mcp/shop/static/X", {}),
    ).toEqual({ project: SERVER_PROJECT, guessed: false });
    expect(
      storeProjectForPath(MULTI, "/strad/test/gateway/static/X", {}),
    ).toEqual({ project: GATEWAY_PROJECT, guessed: false });
  });

  it("beats the resolver's own project id, which is one store of several", () => {
    // `STRAD_PARAMS_PROJECT_ID` is the project the RESOLVER reads from, and on a
    // partitioned deployment it is one store among several. For a path another
    // store owns it is simply the wrong project, so a covering namespace wins.
    expect(
      storeProjectForPath(MULTI, "/strad/test/mcp/shop/static/X", {
        STRAD_PARAMS_PROJECT_ID: GATEWAY_PROJECT,
      }),
    ).toEqual({ project: SERVER_PROJECT, guessed: false });
  });

  it("falls back to the deployment default for a path no store covers", () => {
    // Asserted against a project NO STORE DECLARES, so "fell back" and "picked a
    // store anyway" cannot both satisfy it. The obvious spelling — comparing to
    // `storeProject()` under an empty env — passes either way, because the
    // default IS the first store there.
    expect(storeProjectForPath(MULTI, "/somewhere/else/X", RESOLVER)).toEqual({
      project: RESOLVER_PROJECT,
      guessed: false,
    });
  });

  it("falls back rather than picking one of two stores that both claim a path", () => {
    // The ambiguity `storeForPath` refuses outright for a WRITE. Printing one of
    // two projects with the confidence of a certain answer is the same mistake
    // in a cheaper place.
    //
    // Reachable ACROSS TWO SLUGS and only there: within one server the schema
    // rejects overlapping `consoleStores:` namespaces outright, and across two
    // it is a warning (`crossServerNamespaceOverlap`) because a config that
    // works today can carry one. So the fixture is two secrets slugs on two
    // bundles, which is the shape a deployment can actually be in.
    //
    // Against RESOLVER for the same reason as above: both overlapping stores
    // cover this path, so an implementation that took the first covering one
    // would return a project this assertion rejects.
    expect(
      storeProjectForPath(
        OVERLAPPING,
        "/strad/test/mcp/shop/static/X",
        RESOLVER,
      ),
    ).toEqual({ project: RESOLVER_PROJECT, guessed: false });
  });

  it("ignores a DISABLED server's stores, like storeProject() does", () => {
    const off = parseConfig(
      MULTI_YAML.replace(
        "    path: /secrets",
        "    path: /secrets\n    enabled: false",
      ),
    );
    expect(
      storeProjectForPath(off, "/strad/test/mcp/shop/static/X", RESOLVER),
    ).toEqual({ project: RESOLVER_PROJECT, guessed: false });
    // …and that really is the disabled server doing it: enabled, it answers.
    expect(
      storeProjectForPath(MULTI, "/strad/test/mcp/shop/static/X", RESOLVER),
    ).toEqual({ project: SERVER_PROJECT, guessed: false });
  });

  it("refuses a project id that is still an unresolved ${REF}", () => {
    // `storeProject()` walks past one for the same reason: it would print a
    // command that cannot run. A store whose project is a ref is not a store
    // this can name, so the path falls back rather than printing "${…}".
    const unresolved = parseConfig(
      MULTI_YAML.replace(
        `project: "${SERVER_PROJECT}"`,
        'project: "${SOME_PROJECT_REF}"',
      ),
    );
    expect(
      storeProjectForPath(
        unresolved,
        "/strad/test/mcp/shop/static/X",
        RESOLVER,
      ),
    ).toEqual({ project: RESOLVER_PROJECT, guessed: false });
  });

  it("reads an mcpStores: server too, which no console view can see", () => {
    // The /mcp half's list. A server declaring it may not also carry
    // SECRETS_PROJECT_ID under env: (the schema refuses that), so it reaches no
    // console view — and leaving it out would answer its paths from
    // storeProject(), whose mcpStores[0] fallback is the same first-store guess
    // this replaces.
    expect(
      storeProjectForPath(MCP_ONLY, "/strad/test/mcp/shop/static/X", RESOLVER),
    ).toEqual({ project: SERVER_PROJECT, guessed: false });
    expect(
      storeProjectForPath(MCP_ONLY, "/strad/test/gateway/static/X", RESOLVER),
    ).toEqual({ project: GATEWAY_PROJECT, guessed: false });
  });
});

// ---------------------------------------------------------------------------
// The single-store path, which must not have moved
// ---------------------------------------------------------------------------

describe("a single-store deployment", () => {
  it("answers with its one project for every path", () => {
    const targets = fixTargets(SINGLE, shopPassword(SINGLE), {});
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target.project).toBe("strad-secrets-test");
    }
    expect(
      storeProjectForPath(SINGLE, "/strad/test/mcp/shop/static/X", {}),
    ).toEqual({ project: "strad-secrets-test", guessed: false });
  });

  it("still prefers the resolver's project where nothing covers the path", () => {
    // Unchanged: `storeProject()`'s order is what answers when the namespaces
    // decide nothing, and a deployment that declares none is every deployment
    // that never set SECRETS_NAMESPACES.
    expect(
      storeProjectForPath(SINGLE, "/elsewhere/X", {
        STRAD_PARAMS_PROJECT_ID: "from-resolver",
      }),
    ).toEqual({ project: "from-resolver", guessed: false });
  });
});

// ---------------------------------------------------------------------------
// …and the same thing through the real app, on the page a human reads
// ---------------------------------------------------------------------------

describe("GET /ui on a partitioned multi-store deployment", () => {
  let server: Server | undefined;
  let baseUrl = "";

  const env: NodeJS.ProcessEnv = {
    ALLOW_DEV_AUTH: "true",
    STRAD_TOKENS: "[]",
    ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
    // Never dialled — the index renders from config and the presence seam — but
    // Registry.build refuses to mount a supplementary server without one.
    STRAD_BUNDLE_URL_BUNDLE: "http://127.0.0.1:1",
    ...SECRETS,
  };
  const auth = { authorization: `Bearer ${BOOTSTRAP}` };

  beforeAll(async () => {
    const runtime = new EnvSecretProvider(SECRETS);
    const providers = sharedSecretProviders({
      name: runtime.name,
      get: (name: string) => runtime.get(name),
      invalidate: () => {},
    });
    const app = createApp({
      config: MULTI,
      registry: await Registry.build({
        config: MULTI,
        secrets: providers,
        mode: "core",
        env,
      }),
      tokenStore: tokenStoreFromConfig(MULTI, env),
      mode: "core",
      env,
      secrets: SECRETS,
      secretProvider: providers,
      diagnosticStore: null,
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server?.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(() => {
    server?.close();
  });

  it("prints the owning store's project beside each path it offers", async () => {
    const res = await fetch(`${baseUrl}/ui`, { headers: auth });
    const html = await res.text();
    expect(res.status).toBe(200);

    // The `shop` card reports ${SHOP_PASSWORD} unresolved and opens the routes.
    expect(html).toContain("/strad/test/mcp/shop/static/SHOP_PASSWORD");
    expect(html).toContain("/strad/test/gateway/static/SHOP_PASSWORD");

    // Both projects are on the page, which is the whole claim: one page, two
    // stores, and each route named with the project that actually holds it.
    expect(html).toContain(SERVER_PROJECT);
    expect(html).toContain(GATEWAY_PROJECT);

    // …and the per-server route carries the SECOND store's project, in the
    // <dd> that follows its own <dt>project</dt>. Asserted on the rendered
    // pairing rather than on the two strings being present somewhere.
    const own = projectPrintedFor(
      html,
      "/strad/test/mcp/shop/static/SHOP_PASSWORD",
    );
    expect(own).toBe(SERVER_PROJECT);
    const shared = projectPrintedFor(
      html,
      "/strad/test/gateway/static/SHOP_PASSWORD",
    );
    expect(shared).toBe(GATEWAY_PROJECT);
  });
});

/**
 * The project the page prints for one resource, read out of the rendered HTML.
 *
 * The fix block lays out `<dt>resource</dt><dd>…</dd>` then
 * `<dt>project</dt><dd>…</dd>`, so the project belonging to a path is the next
 * `project` cell after that path's RESOURCE cell — which is exactly the pairing
 * a reader's eye makes, and the one the defect got wrong. Anchored on the
 * resource cell rather than on the bare string: a path is also quoted inside a
 * neighbouring route's prose, and matching that would read the wrong block's
 * project and pass for the wrong reason.
 */
function projectPrintedFor(html: string, resource: string): string {
  const cell = `<dt>resource</dt><dd><code>${resource}</code></dd>`;
  const at = html.indexOf(cell);
  if (at < 0) throw new Error(`no such resource on the page: ${resource}`);
  const match = /<dt>project<\/dt><dd><code>([^<]+)<\/code>/.exec(
    html.slice(at),
  );
  if (!match?.[1]) throw new Error(`no project printed after ${resource}`);
  return match[1];
}
