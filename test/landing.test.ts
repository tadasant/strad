import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";

/**
 * The public front door at `/`.
 *
 * It exists to make the gateway navigable, so the tests that matter are about
 * what it must NOT do. It is unauthenticated, which is defensible only while it
 * stays a directory: it may publish slugs (so does /healthz), and it may not
 * publish upstream URLs, headers, env, or entitlements. The leak assertions
 * below are the enforcement — if someone renders a richer card later, they trip
 * here rather than in production.
 */

const CONFIG = parseConfig(`
version: 1
gateway:
  name: strad
  env: test
  publicUrl: https://staging.strad.example.com
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin] }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle-gcs
servers:
  - slug: gcs
    kind: supplementary-image
    title: Object store
    description: Screenshots and uploads.
    image: ghcr.io/tadasant/strad-bundle-api:latest
    bundle: bundle-gcs
    path: /gcs
    entitlements: [admin]
    env:
      GCS_BUCKET: "demo-bucket"
      GCS_ROOT_PATH: "screenshots"
      GCS_CLIENT_EMAIL: "\${GCS_CLIENT_EMAIL}"
      GCS_PRIVATE_KEY: "\${GCS_PRIVATE_KEY}"
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
  - slug: deepwiki
    kind: remote-http
    url: https://mcp.deepwiki.example.com/sse
    headers:
      Authorization: "Bearer \${DEEPWIKI_TOKEN}"
    entitlements: [admin]
  - slug: retired
    kind: builtin
    module: "./servers/echo.js"
    enabled: false
    entitlements: [admin]
`);

const SECRETS = {
  GCS_CLIENT_EMAIL: "svc@demo.iam.gserviceaccount.com",
  GCS_PRIVATE_KEY:
    "-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----",
  DEEPWIKI_TOKEN: "dw-super-secret",
};

const env: NodeJS.ProcessEnv = {
  ALLOW_DEV_AUTH: "true",
  ADMIN_BOOTSTRAP_TOKEN: "bootstrap-secret-xyz",
  STRAD_BUNDLE_URL_BUNDLE_GCS: "http://127.0.0.1:1",
  STRAD_TOKENS: "[]",
};

let server: Server;
let baseUrl: string;
let html: string;

beforeAll(async () => {
  const registry = await Registry.build({
    config: CONFIG,
    secrets: SECRETS,
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
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  html = await (await fetch(`${baseUrl}/`)).text();
});

afterAll(() => server?.close());

describe("GET /", () => {
  it("serves HTML with no credential at all", async () => {
    const res = await fetch(`${baseUrl}/`, { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("names the gateway and its environment", () => {
    expect(html).toContain("strad");
    expect(html).toContain("test");
  });

  it("lists every ENABLED server slug", () => {
    for (const slug of ["gcs", "echo", "deepwiki"]) {
      expect(html).toContain(slug);
    }
  });

  it("shows a title and description when the config gives one", () => {
    expect(html).toContain("Object store");
    expect(html).toContain("Screenshots and uploads.");
  });

  it("gives a copyable per-server connect URL built from publicUrl", () => {
    expect(html).toContain(
      "https://staging.strad.example.com/mcp?servers=echo",
    );
    expect(html).toContain("https://staging.strad.example.com/mcp");
  });

  it("links the browser view only for a server that has one", () => {
    // gcs resolves to a GCS view; echo has no viewer and must not pretend to.
    expect(html).toContain('href="/ui/gcs"');
    expect(html).not.toContain('href="/ui/echo"');
  });

  it("links the consoles, so the page does its actual job", () => {
    expect(html).toContain('href="/ui"');
    expect(html).toContain('href="/console"');
    expect(html).toContain('href="/healthz"');
  });

  it("separates disabled servers instead of advertising them as usable", () => {
    // Assert on the RENDERED collapse, not the bare word "disabled" — the
    // stylesheet contains `.chip-off` / `.disabled-wrap` rules, so a loose
    // toContain("disabled") passes even when nothing rendered.
    expect(html).toContain("<summary>1 disabled server</summary>");
    expect(html).toContain('<span class="chip chip-off">disabled</span>');
    // And it is inside the <details>, not loose in the enabled grid.
    const details = html.slice(html.indexOf("<details"));
    expect(details).toContain("retired");
    expect(html.slice(0, html.indexOf("<details"))).not.toContain("retired");
  });

  // --- the part that keeps it publishable ---------------------------------

  it("leaks NO secret value", () => {
    for (const value of Object.values(SECRETS)) {
      expect(html).not.toContain(value);
    }
    expect(html).not.toContain("dw-super-secret");
    expect(html).not.toContain(env.ADMIN_BOOTSTRAP_TOKEN!);
  });

  it("leaks NO upstream url, header, or env map", () => {
    // A remote-http server's url is how you'd bypass the gateway entirely.
    expect(html).not.toContain("mcp.deepwiki.example.com");
    expect(html).not.toContain("Authorization");
    expect(html).not.toContain("demo-bucket");
    expect(html).not.toContain("GCS_PRIVATE_KEY");
    expect(html).not.toContain("ghcr.io");
  });

  it("leaks NO entitlement or role information", () => {
    expect(html).not.toContain("entitlements");
    expect(html).not.toContain("admin");
  });
});

describe("GET / in bundle mode", () => {
  it("is not served — a bundle component is internal and has no front door", async () => {
    const registry = await Registry.build({
      config: CONFIG,
      secrets: SECRETS,
      mode: "bundle",
      env: { ...env, STRAD_BUNDLE: "bundle-gcs" },
    });
    const app = createApp({
      config: CONFIG,
      registry,
      tokenStore: tokenStoreFromConfig(CONFIG, env),
      mode: "bundle",
      env: { ...env, STRAD_BUNDLE: "bundle-gcs" },
      secrets: SECRETS,
    });
    const s = app.listen(0);
    await new Promise<void>((r) => s.on("listening", () => r()));
    const addr = s.address();
    if (typeof addr === "string" || !addr) throw new Error("no port");
    const res = await fetch(`http://127.0.0.1:${addr.port}/`, {
      redirect: "manual",
    });
    expect(res.status).toBe(404);
    s.close();
  });
});
