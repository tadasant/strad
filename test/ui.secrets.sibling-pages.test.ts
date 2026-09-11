import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import type { StradConfig } from "../src/config/schema.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { createFakeGcp, type FakeGcp } from "../src/secrets/parameters/fake.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";
import { secretsPages, serverLooksSecrets } from "../src/ui/resolve.ts";

/**
 * A SECRETS PAGE NAMES ITS SIBLINGS (tadasant/strad#250).
 *
 * A gateway can carry several secrets pages, one per slug. A reader who lands on
 * one directly saw only that page's namespaces and nothing saying the others
 * exist — "why can't I see namespace X here?", asked twice on one deployment by
 * someone on the right console and the wrong page. Each page now lists the
 * others under its breadcrumb.
 *
 * What is proven here, through the REAL Express app over a REAL socket:
 *
 *   1. A page lists every OTHER secrets page — not itself, not a GCS or a
 *      remote-http server — each linking to `/ui/<slug>`, with its projects and
 *      namespaces.
 *   2. A gateway with ONE secrets page renders no strip at all.
 *   3. A console-only slug (`entitlements: []`) is listed. The strip is
 *      navigation: the `/ui` gate never reads entitlements, so that slug has a
 *      page, and a list that dropped it would be a list of the wrong thing.
 *   4. The strip and the `/ui` index agree on which secrets pages exist, from
 *      every page — they ask the same `serverLooksSecrets`.
 *   5. It carries declared config and nothing else: no credential, no
 *      parameter.
 */

const BOOTSTRAP = "bootstrap-secret-xyz";

const STRAD_PROJECT = "strad-secrets-test";
const STRAD_NS = "/strad/test/mcp/";
const GATEWAY_NS = "/strad/test/gateway/static/";
const ZIMMER_PROJECT = "zimmer-secrets-test";
const ZIMMER_NS = "/zimmer/test/mcp/";
const ZIMMER_OPS_PROJECT = "zimmer-ops-secrets-test";
const ZIMMER_OPS_NS = "/zimmer/test/ops/";
const VAULT_PROJECT = "vault-secrets-test";
const VAULT_NS = "/vault/test/";

function key(email: string): string {
  return JSON.stringify({
    client_email: email,
    private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
  });
}

const STRAD_ADMIN_KEY = key("strad-admin@strad.iam.gserviceaccount.com");
const ZIMMER_ADMIN_KEY = key("zimmer-admin@zimmer.iam.gserviceaccount.com");
const ZIMMER_OPS_ADMIN_KEY = key(
  "zimmer-ops-admin@zimmer.iam.gserviceaccount.com",
);
const VAULT_ADMIN_KEY = key("vault-admin@vault.iam.gserviceaccount.com");
const SECRETS = {
  STRAD_ADMIN_KEY,
  ZIMMER_ADMIN_KEY,
  ZIMMER_OPS_ADMIN_KEY,
  VAULT_ADMIN_KEY,
};

const HEADER = `
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin] }
roles:
  admin: { servers: ["*"] }
`;

/** The single-store `SECRETS_*` shape, and the first page. */
const SECRETS_SERVER = `
  - slug: secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /secrets
    entitlements: [admin]
    env:
      SECRETS_PROJECT_ID: "${STRAD_PROJECT}"
      SECRETS_NAMESPACES: "${STRAD_NS},${GATEWAY_NS}"
    consoleEnv:
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${STRAD_ADMIN_KEY}"
`;

/** A GCS server: it has a console page, and it is NOT a secrets page. */
const GCS_SERVER = `
  - slug: object-store
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /object-store
    entitlements: [admin]
    env:
      GCS_BUCKET: "test-bucket"
`;

const MULTI_YAML = `${HEADER}
bundles:
  - name: bundle
  - name: bundle-zimmer
  - name: bundle-vault
  - name: bundle-old
servers:
${SECRETS_SERVER}
${GCS_SERVER}
  - slug: beta
    kind: remote-http
    url: https://beta.example.com/mcp
    entitlements: [admin]
  # Two stores on one page: the \`consoleStores:\` shape.
  - slug: zimmer-secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle-zimmer
    path: /secrets
    entitlements: [admin]
    env:
      SECRETS_PROJECT_ID: "${ZIMMER_PROJECT}"
      SECRETS_NAMESPACES: "${ZIMMER_NS}"
    consoleEnv:
      ZIMMER_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${ZIMMER_ADMIN_KEY}"
      ZIMMER_OPS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${ZIMMER_OPS_ADMIN_KEY}"
    consoleStores:
      - project: "${ZIMMER_PROJECT}"
        namespaces: ["${ZIMMER_NS}"]
        adminKeyVar: ZIMMER_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON
      - project: "${ZIMMER_OPS_PROJECT}"
        namespaces: ["${ZIMMER_OPS_NS}"]
        adminKeyVar: ZIMMER_OPS_ADMIN_SERVICE_ACCOUNT_KEY_JSON
  # CONSOLE-ONLY: no role reaches it over /mcp, and everything it declares is
  # under consoleEnv: by its slug-namespaced name — the shape only
  # declaredEnv's fallback detects. It still has a page.
  - slug: vault
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle-vault
    path: /secrets
    entitlements: []
    consoleEnv:
      VAULT_SECRETS_PROJECT_ID: "${VAULT_PROJECT}"
      VAULT_SECRETS_NAMESPACES: "${VAULT_NS}"
      VAULT_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${VAULT_ADMIN_KEY}"
  # DISABLED, and DEGRADED: mounted for nobody, and with no namespace its page
  # is the "not configured" message. Still a page the index offers.
  - slug: old-secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle-old
    path: /secrets
    enabled: false
    entitlements: [admin]
    env:
      SECRETS_PROJECT_ID: "old-secrets-test"
`;

const SINGLE_YAML = `${HEADER}
bundles:
  - name: bundle
servers:
${SECRETS_SERVER}
${GCS_SERVER}
`;

const MULTI = parseConfig(MULTI_YAML);
const SINGLE = parseConfig(SINGLE_YAML);

const ADMIN_CAPABILITIES = {
  readSecretValues: true,
  writeParameters: true,
  writeSecretValues: true,
  deleteParameters: true,
  probed: true,
};

/** The strip's markup, or undefined when the page carries none. */
function strip(html: string): string | undefined {
  return /<nav class="siblings"[\s\S]*?<\/nav>/.exec(html)?.[0];
}

/** The slugs a strip links to, in order. */
function stripSlugs(html: string): string[] {
  return [
    ...(strip(html) ?? "").matchAll(
      /class="sibling-slug" href="\/ui\/([^"?]+)"/g,
    ),
  ].map((m) => decodeURIComponent(m[1]!));
}

/** The slugs the `/ui` index offers a `Manage →` link for. */
function indexManageSlugs(html: string): string[] {
  return [
    ...html.matchAll(/class="card-cta" href="\/ui\/([^"]+)">Manage →/g),
  ].map((m) => decodeURIComponent(m[1]!));
}

// --- unit: the derivation ----------------------------------------------------

describe("secretsPages", () => {
  it("lists every secrets page in config order, and nothing that is not one", () => {
    expect(secretsPages(MULTI, SECRETS).map((p) => p.slug)).toEqual([
      "secrets",
      "zimmer-secrets",
      "vault",
      "old-secrets",
    ]);
  });

  it("is exactly the servers serverLooksSecrets says yes to", () => {
    for (const config of [MULTI, SINGLE]) {
      expect(secretsPages(config, SECRETS).map((p) => p.slug)).toEqual(
        config.servers.filter(serverLooksSecrets).map((s) => s.slug),
      );
    }
  });

  it("describes each store by project and namespaces, as its own page resolves them", () => {
    const pages = secretsPages(MULTI, SECRETS);
    expect(pages.find((p) => p.slug === "secrets")!.stores).toEqual([
      { projectId: STRAD_PROJECT, namespaces: [STRAD_NS, GATEWAY_NS] },
    ]);
    expect(pages.find((p) => p.slug === "zimmer-secrets")!.stores).toEqual([
      { projectId: ZIMMER_PROJECT, namespaces: [ZIMMER_NS] },
      { projectId: ZIMMER_OPS_PROJECT, namespaces: [ZIMMER_OPS_NS] },
    ]);
  });

  it("carries declared config and no credential, even where one resolves", () => {
    // The `secrets` page's admin key IS in the bag. The projection drops it, so
    // no renderer downstream of this is ever handed one.
    for (const page of secretsPages(MULTI, SECRETS)) {
      expect(Object.keys(page).sort()).toEqual(["enabled", "slug", "stores"]);
      for (const store of page.stores) {
        expect(Object.keys(store).sort()).toEqual(["namespaces", "projectId"]);
      }
    }
    expect(JSON.stringify(secretsPages(MULTI, SECRETS))).not.toContain(
      "iam.gserviceaccount.com",
    );
  });

  it("lists a console-only (entitlements: []) slug, and a disabled one", () => {
    const vault = MULTI.servers.find((s) => s.slug === "vault")!;
    expect(vault.entitlements).toEqual([]);
    const pages = secretsPages(MULTI, SECRETS);
    expect(pages.find((p) => p.slug === "vault")?.enabled).toBe(true);
    expect(pages.find((p) => p.slug === "old-secrets")?.enabled).toBe(false);
  });
});

// --- e2e: the real app -------------------------------------------------------

async function boot(
  config: StradConfig,
  fakes: Record<string, FakeGcp>,
): Promise<{ baseUrl: string; close: () => void }> {
  const env: NodeJS.ProcessEnv = {
    ALLOW_DEV_AUTH: "true",
    STRAD_TOKENS: "[]",
    ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
    STRAD_BUNDLE_URL_BUNDLE: "http://127.0.0.1:1",
    STRAD_BUNDLE_URL_BUNDLE_ZIMMER: "http://127.0.0.1:1",
    STRAD_BUNDLE_URL_BUNDLE_VAULT: "http://127.0.0.1:1",
    STRAD_BUNDLE_URL_BUNDLE_OLD: "http://127.0.0.1:1",
    ...SECRETS,
  };
  const runtime = new EnvSecretProvider(SECRETS);
  const providers = sharedSecretProviders({
    name: runtime.name,
    get: (name: string) => runtime.get(name),
    invalidate: () => {},
  });
  const registry = await Registry.build({
    config,
    secrets: providers,
    mode: "core",
    env,
  });
  const fallback = createFakeGcp();
  const app = createApp({
    config,
    registry,
    tokenStore: tokenStoreFromConfig(config, env),
    mode: "core",
    env,
    secrets: SECRETS,
    secretProvider: providers,
    parametersStore: (_view, store) =>
      (fakes[store.projectId] ?? fallback).store,
    capabilities: () => Promise.resolve(ADMIN_CAPABILITIES),
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => server.close(),
  };
}

const auth = { authorization: `Bearer ${BOOTSTRAP}` };

describe("a secrets page on a gateway with several", () => {
  let baseUrl = "";
  let close = () => {};
  const zimmerFake = createFakeGcp();

  beforeAll(async () => {
    // A parameter in a SIBLING's store. The strip names the page it lives on,
    // never the parameter.
    await zimmerFake.store.create({
      path: `${ZIMMER_NS}ZIMMER_ONLY_VAR`,
      secret: false,
      value: "zimmer-value",
    });
    ({ baseUrl, close } = await boot(MULTI, { [ZIMMER_PROJECT]: zimmerFake }));
  });

  afterAll(() => close());

  async function page(path: string): Promise<string> {
    const res = await fetch(`${baseUrl}${path}`, { headers: auth });
    expect(res.status).toBe(200);
    return res.text();
  }

  it("lists the siblings, not itself, each linking to /ui/<slug>", async () => {
    const html = await page("/ui/secrets");
    expect(stripSlugs(html)).toEqual([
      "zimmer-secrets",
      "vault",
      "old-secrets",
    ]);
    const s = strip(html)!;
    expect(s).toContain("One of 4 secrets pages on this gateway.");
    expect(s).toContain('href="/ui/zimmer-secrets"');
    expect(s).toContain('href="/ui/vault"');
    // Not a secrets page, so not a sibling.
    expect(s).not.toContain("object-store");
    expect(s).not.toContain("beta");
  });

  it("names each sibling's projects and namespaces", async () => {
    const s = strip(await page("/ui/secrets"))!;
    expect(s).toContain(`<code>${VAULT_PROJECT}</code>`);
    expect(s).toContain(`<span class="sibling-ns">${VAULT_NS}</span>`);
    expect(s).toContain(`<code>${ZIMMER_PROJECT}</code>`);
    expect(s).toContain(`<span class="sibling-ns">${ZIMMER_NS}</span>`);
    expect(s).toContain(`<code>${ZIMMER_OPS_PROJECT}</code>`);
    expect(s).toContain(`<span class="sibling-ns">${ZIMMER_OPS_NS}</span>`);
    // Its own store is in the page's scope, not in its list of elsewheres.
    expect(s).not.toContain(STRAD_PROJECT);
  });

  it("deep-links each store of a multi-store sibling, and not a single-store one", async () => {
    const s = strip(await page("/ui/secrets"))!;
    expect(s).toContain(
      `href="/ui/zimmer-secrets?project=${ZIMMER_OPS_PROJECT}"`,
    );
    expect(s).toContain(`href="/ui/zimmer-secrets?project=${ZIMMER_PROJECT}"`);
    expect(s).not.toContain("/ui/vault?project=");
  });

  it("lists the console-only slug, whose entitlements reach no role", async () => {
    // The dev-bypass principal holds `admin`, which `vault` does not name — it
    // could not select `vault` over /mcp. The strip lists it anyway.
    expect(stripSlugs(await page("/ui/secrets"))).toContain("vault");
  });

  it("marks a disabled sibling the way the index does", async () => {
    const s = strip(await page("/ui/secrets"))!;
    expect(s).toMatch(
      /href="\/ui\/old-secrets">old-secrets<\/a><span class="chip chip-off">disabled<\/span>/,
    );
    expect(s).not.toMatch(/href="\/ui\/vault">vault<\/a><span class="chip/);
  });

  it("carries no parameter and no credential", async () => {
    const s = strip(await page("/ui/secrets"))!;
    expect(s).not.toContain("ZIMMER_ONLY_VAR");
    expect(s).not.toContain("zimmer-value");
    expect(s).not.toContain("iam.gserviceaccount.com");
  });

  it("is on a multi-store page too, which names its OWN stores in the picker", async () => {
    const html = await page("/ui/zimmer-secrets");
    expect(stripSlugs(html)).toEqual(["secrets", "vault", "old-secrets"]);
    expect(html).toContain('<select class="in in-select" id="store-input"');
  });

  it("is on a degraded page, which renders a message instead of the table", async () => {
    const html = await page("/ui/old-secrets");
    expect(html).toContain("No managed namespace is configured");
    expect(stripSlugs(html)).toEqual(["secrets", "zimmer-secrets", "vault"]);
  });

  it("names a sibling with no namespace by its project alone", async () => {
    const s = strip(await page("/ui/secrets"))!;
    expect(s).toContain(
      '<span class="sibling-store"><code>old-secrets-test</code></span>',
    );
  });

  it("agrees with the /ui index about which secrets pages exist, from every page", async () => {
    const offered = indexManageSlugs(await page("/ui")).sort();
    expect(offered).toEqual(
      ["old-secrets", "secrets", "vault", "zimmer-secrets"].sort(),
    );
    for (const slug of offered) {
      const listed = stripSlugs(await page(`/ui/${slug}`));
      expect([slug, ...listed].sort()).toEqual(offered);
    }
  });

  it("is not on a GCS page", async () => {
    const res = await fetch(`${baseUrl}/ui/object-store`, { headers: auth });
    expect(strip(await res.text())).toBeUndefined();
  });
});

describe("a secrets page on a gateway with one", () => {
  let baseUrl = "";
  let close = () => {};

  beforeAll(async () => {
    ({ baseUrl, close } = await boot(SINGLE, {}));
  });

  afterAll(() => close());

  it("renders no strip at all", async () => {
    const res = await fetch(`${baseUrl}/ui/secrets`, { headers: auth });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(strip(html)).toBeUndefined();
    expect(html).not.toContain("secrets pages on this gateway");
    // The page itself is intact: its own scope and the way back to the index.
    expect(html).toContain(`<code>${STRAD_PROJECT}</code>`);
    expect(html).toContain('<a href="/ui" class="crumb">servers</a>');
  });

  it("still agrees with the index, which offers exactly this one", async () => {
    const res = await fetch(`${baseUrl}/ui`, { headers: auth });
    expect(indexManageSlugs(await res.text())).toEqual(["secrets"]);
  });
});
