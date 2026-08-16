import { sharedSecretProviders } from "../src/secrets/provider/index.ts";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { EnvSecretProvider } from "../src/secrets/provider/index.ts";
import type { GcsLister } from "../src/ui/gcs-client.ts";
import {
  resolveServerView,
  serverLooksGcs,
  serverLooksSecrets,
} from "../src/ui/resolve.ts";

/**
 * The index and the page must answer the same question.
 *
 * `/ui` offers a `Manage →` link when a server "looks" GCS- or secrets-backed;
 * `/ui/<slug>` renders whatever `resolveServerView` resolves. A detector narrower
 * than its resolver is an unreachable feature: the page renders perfectly and
 * nothing links to it. `remote-filesystem-tmp-public` is the shape that finds it
 * — it declares `REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_BUCKET`, because `gcs` owns the
 * bare name on the container they share.
 *
 * What is asserted here is the INVARIANT, not the example: for EVERY server in
 * the fixture, `serverLooksGcs`/`serverLooksSecrets` equal the view the resolver
 * produces. A detector that drifts from its resolver fails this whether or not
 * anyone remembers to add a case for it.
 */

const CONFIG = parseConfig(`
version: 1
gateway:
  name: strad
  env: test
  publicUrl: https://console.example.com
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin] }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle
  - name: bundle-secrets
servers:
  # Bare names: on the container these two share, gcs is the one that holds them.
  - slug: gcs
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /gcs
    entitlements: [admin]
    env:
      GCS_BUCKET: "demo-bucket"
      GCS_SERVICE_ACCOUNT_KEY_JSON: "\${GCS_KEY_JSON}"
  # Slug-namespaced, because it shares gcs's container and points at a DIFFERENT
  # bucket. Its bare-name twin is the one the index links; so is this one.
  - slug: remote-filesystem-tmp-public
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /remote-filesystem
    entitlements: [admin]
    env:
      REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_BUCKET: "tmp-public-bucket"
      REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_ROOT_PATH: "screenshots"
      REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_CLIENT_EMAIL: "\${RF_CLIENT_EMAIL}"
      REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_PRIVATE_KEY: "\${RF_PRIVATE_KEY}"
  # Its GCS config reaches the console and nothing else: consoleEnv: only.
  - slug: archive
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /archive
    entitlements: [admin]
    env:
      ARCHIVE_UPSTREAM: "https://archive.example.com"
    consoleEnv:
      ARCHIVE_GCS_BUCKET: "archive-bucket"
      ARCHIVE_GCS_SERVICE_ACCOUNT_KEY_JSON: "\${ARCHIVE_KEY_JSON}"
  # A second store, shaped the way staging shapes one: bare under env:, which is
  # its own container, and slug-namespaced under consoleEnv:, which is shared.
  - slug: zimmer-secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle-secrets:latest
    bundle: bundle-secrets
    path: /secrets
    entitlements: [admin]
    env:
      SECRETS_PROJECT_ID: "zimmer-store"
      SECRETS_SERVICE_ACCOUNT_KEY_JSON: "\${ZIMMER_VIEWER_KEY_JSON}"
    consoleEnv:
      ZIMMER_SECRETS_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${ZIMMER_ADMIN_KEY_JSON}"
  # A builtin declares through options:, which is the third shape serverEnv reads.
  - slug: local-store
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
    options:
      GCS_BUCKET: "builtin-bucket"
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
  - slug: deepwiki
    kind: remote-http
    url: https://deepwiki.example.com/mcp
    entitlements: [admin]
`);

const KEY = JSON.stringify({
  client_email: "svc@demo.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----",
});

const SECRETS: Record<string, string> = {
  GCS_KEY_JSON: KEY,
  ARCHIVE_KEY_JSON: KEY,
  ZIMMER_ADMIN_KEY_JSON: KEY,
  ZIMMER_VIEWER_KEY_JSON: KEY,
  RF_CLIENT_EMAIL: "svc@demo.iam.gserviceaccount.com",
  RF_PRIVATE_KEY:
    "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
};

const BOOTSTRAP = "bootstrap-secret-xyz";

// --- the invariant ---------------------------------------------------------

describe("index detectors and the page resolver cannot disagree", () => {
  // Holds by construction while the detector and the resolver share their
  // predicates, and that is the property worth guarding: the case it fails on is
  // the one where someone forks the two readings apart again. The four cases
  // below are what pin the readings themselves.
  it("every server's detector matches the view it actually resolves to", () => {
    for (const server of CONFIG.servers) {
      const view = resolveServerView(CONFIG, server.slug, SECRETS);
      expect({
        slug: server.slug,
        gcs: serverLooksGcs(server),
        secrets: serverLooksSecrets(server),
      }).toEqual({
        slug: server.slug,
        gcs: view.kind === "gcs",
        secrets: view.kind === "secrets",
      });
    }
  });

  it("sees a slug-namespaced GCS server, which has a real page", () => {
    const server = CONFIG.servers.find(
      (s) => s.slug === "remote-filesystem-tmp-public",
    );
    if (!server) throw new Error("fixture");
    expect(serverLooksGcs(server)).toBe(true);

    const view = resolveServerView(CONFIG, server.slug, SECRETS);
    if (view.kind !== "gcs") throw new Error("unreachable");
    expect(view.bucket).toBe("tmp-public-bucket");
  });

  it("sees GCS declared only under consoleEnv:, which is where the console reads", () => {
    const server = CONFIG.servers.find((s) => s.slug === "archive");
    if (!server) throw new Error("fixture");
    expect(serverLooksGcs(server)).toBe(true);

    const view = resolveServerView(CONFIG, server.slug, SECRETS);
    if (view.kind !== "gcs") throw new Error("unreachable");
    expect(view.bucket).toBe("archive-bucket");
  });

  it("sees a second secrets store, whose console key is slug-namespaced", () => {
    const server = CONFIG.servers.find((s) => s.slug === "zimmer-secrets");
    if (!server) throw new Error("fixture");
    expect(serverLooksSecrets(server)).toBe(true);
    expect(serverLooksGcs(server)).toBe(false);

    const view = resolveServerView(CONFIG, server.slug, SECRETS);
    if (view.kind !== "secrets") throw new Error("unreachable");
    expect(view.projectId).toBe("zimmer-store");
    // Through the namespaced fallback: the admin key is declared as
    // ZIMMER_SECRETS_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON.
    expect(view.account?.client_email).toBe("svc@demo.iam.gserviceaccount.com");
  });

  it("reads a builtin's options:, which is neither env: nor consoleEnv:", () => {
    const server = CONFIG.servers.find((s) => s.slug === "local-store");
    if (!server) throw new Error("fixture");
    expect(serverLooksGcs(server)).toBe(true);

    const view = resolveServerView(CONFIG, server.slug, SECRETS);
    if (view.kind !== "gcs") throw new Error("unreachable");
    expect(view.bucket).toBe("builtin-bucket");
  });

  it("claims no view for a server that declares neither", () => {
    for (const slug of ["echo", "deepwiki"]) {
      const server = CONFIG.servers.find((s) => s.slug === slug);
      if (!server) throw new Error("fixture");
      expect(serverLooksGcs(server)).toBe(false);
      expect(serverLooksSecrets(server)).toBe(false);
    }
  });
});

// --- through the real Express app ------------------------------------------

const env: NodeJS.ProcessEnv = {
  ALLOW_DEV_AUTH: "true",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
  STRAD_BUNDLE_URL_BUNDLE: "http://127.0.0.1:1",
  STRAD_BUNDLE_URL_BUNDLE_SECRETS: "http://127.0.0.1:1",
  STRAD_TOKENS: "[]",
};

const fakeList: GcsLister = async (_account, options) => ({
  objects: [
    {
      name: `${options.prefix}pinned.png`,
      size: 42,
      updated: new Date().toISOString(),
    },
  ],
  prefixes: [],
});

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const registry = await Registry.build({
    config: CONFIG,
    secrets: sharedSecretProviders(new EnvSecretProvider(SECRETS)),
    mode: "core",
    env,
  });
  const app = createApp({
    config: CONFIG,
    registry,
    tokenStore: tokenStoreFromConfig(CONFIG, env),
    mode: "core",
    env,
    secrets: SECRETS,
    gcsList: fakeList,
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => server?.close());

describe("/ui links every page it renders", () => {
  const auth = { authorization: `Bearer ${BOOTSTRAP}` };

  it("offers the index link for a slug-namespaced GCS server", async () => {
    const res = await fetch(`${baseUrl}/ui`, { headers: auth });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`href="/ui/remote-filesystem-tmp-public"`);
    expect(html).toContain(`href="/ui/archive"`);
    expect(html).toContain(`href="/ui/zimmer-secrets"`);
    // A server with no view is still listed — it just isn't linked.
    expect(html).toContain("deepwiki");
    expect(html).not.toContain(`href="/ui/deepwiki"`);
  });

  it("serves the page that link points at", async () => {
    const res = await fetch(`${baseUrl}/ui/remote-filesystem-tmp-public`, {
      headers: auth,
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("tmp-public-bucket");
    expect(html).toContain("pinned.png");
  });
});
