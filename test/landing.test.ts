import { sharedSecretProviders } from "../src/secrets/provider/index.ts";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { EnvSecretProvider } from "../src/secrets/provider/index.ts";

/**
 * The front door at `/`.
 *
 * The first thing to hold is the gate: strad requires identity before exposing
 * anything, and an index of what this gateway fronts is something. `/` is behind
 * the SAME `requireConsoleUi` as `/ui` and `/console` — never a softer door — and
 * the first test here is that an anonymous request gets a sign-in wall and no
 * content, not a 200.
 *
 * The leak assertions are defence in depth behind that gate, and they are what
 * would have to be revisited before this page could ever be opened up. Each is
 * written against what the renderer could actually emit, not against a bare word
 * that also appears in the inlined stylesheet — a loose toContain() on this page
 * passes for the wrong reason more often than it catches anything.
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
    tools:
      allow: [list_files]
      deny: [delete_file]
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
    title: "<script>alert(1)</script>"
    description: 'Hostile: & "quoted" </span>'
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

const BOOTSTRAP = "bootstrap-secret-xyz";

const env: NodeJS.ProcessEnv = {
  ALLOW_DEV_AUTH: "true",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
  STRAD_BUNDLE_URL_BUNDLE_GCS: "http://127.0.0.1:1",
  STRAD_TOKENS: "[]",
};

const AUTH = { authorization: `Bearer ${BOOTSTRAP}` };

let server: Server;
let baseUrl: string;
let html: string;

/** Boot a core-mode app on an ephemeral port. Returns its URL and a closer. */
async function boot(
  config: Parameters<typeof createApp>[0]["config"],
): Promise<{ url: string; close: () => void }> {
  const registry = await Registry.build({
    config,
    secrets: sharedSecretProviders(new EnvSecretProvider(SECRETS)),
    mode: "core",
    env,
  });
  const app = createApp({
    config,
    registry,
    tokenStore: tokenStoreFromConfig(config, env),
    mode: "core",
    env,
    secrets: SECRETS,
  });
  const s = app.listen(0);
  await new Promise<void>((r) => s.on("listening", () => r()));
  const addr = s.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  return { url: `http://127.0.0.1:${addr.port}`, close: () => s.close() };
}

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
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  html = await (await fetch(`${baseUrl}/`, { headers: AUTH })).text();
});

afterAll(() => server?.close());

describe("GET / SSO gate", () => {
  it("401s an anonymous request and leaks NO content", async () => {
    const res = await fetch(`${baseUrl}/`, { redirect: "manual" });
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain("Sign in required");
    // Not one slug, not the endpoint, not a server title.
    for (const s of ["deepwiki", "Object store", "servers=", "gcs"]) {
      expect(body).not.toContain(s);
    }
  });

  it("401s a WRONG token rather than falling open", async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { authorization: "Bearer not-the-token" },
      redirect: "manual",
    });
    expect(res.status).toBe(401);
  });

  it("is the SAME gate as /ui — neither is a softer door", async () => {
    const [root, ui] = await Promise.all([
      fetch(`${baseUrl}/`, { redirect: "manual" }),
      fetch(`${baseUrl}/ui`, { redirect: "manual" }),
    ]);
    expect(root.status).toBe(ui.status);
  });

  it("accepts the session cookie the /ui sign-in flow sets", async () => {
    // Regression guard: the cookie was scoped path=/ui, so it was NOT sent to
    // "/" and a signed-in human hit the sign-in wall on the front page.
    const signIn = await fetch(`${baseUrl}/ui?token=${BOOTSTRAP}`, {
      redirect: "manual",
    });
    const setCookie = signIn.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain("Path=/ui");

    const cookie = setCookie.split(";")[0]!;
    const res = await fetch(`${baseUrl}/`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("deepwiki");
  });
});

describe("GET /", () => {
  it("serves HTML to a signed-in human", async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: AUTH,
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("names the gateway and its environment", () => {
    // Assert the RENDERED elements, not the bare words: layout() prints "strad"
    // in the brand mark and footer on every page, so toContain("strad") passes
    // even when renderLanding returns nothing at all.
    expect(html).toContain('<span class="env-badge">test</span>');
    expect(html).toContain("<title>test gateway · strad</title>");
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
      'data-url="https://staging.strad.example.com/mcp?servers=echo"',
    );
    expect(html).toContain(
      'value="https://staging.strad.example.com/mcp" aria-label=',
    );
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

  it("omits DISABLED servers entirely, since /healthz never lists them", () => {
    // The page's whole claim to being publishable is that it discloses no set
    // that was private. Registry.build skips disabled servers, so they are
    // absent from /healthz — rendering them here would be net-new disclosure,
    // plus a connect URL the gateway would reject.
    expect(html).not.toContain("retired");
    expect(html).toContain('<span class="panel-note">3 enabled</span>');
  });

  // --- the part that keeps it publishable ---------------------------------

  it("leaks NO secret value", () => {
    for (const value of Object.values(SECRETS)) {
      expect(html).not.toContain(value);
    }
    expect(html).not.toContain(env.ADMIN_BOOTSTRAP_TOKEN!);
  });

  it("leaks NO upstream url, header, image, or env map", () => {
    // A remote-http server's url is how you'd bypass the gateway entirely.
    expect(html).not.toContain("mcp.deepwiki.example.com");
    expect(html).not.toContain("Authorization");
    // Every env key AND value of the gcs server.
    for (const s of [
      "demo-bucket",
      "screenshots",
      "GCS_BUCKET",
      "GCS_ROOT_PATH",
      "GCS_CLIENT_EMAIL",
      "GCS_PRIVATE_KEY",
    ]) {
      expect(html).not.toContain(s);
    }
    // Deployment internals: image ref, bundle name, upstream path, module path.
    expect(html).not.toContain("ghcr.io");
    expect(html).not.toContain("bundle-gcs");
    expect(html).not.toContain("./servers/echo.js");
  });

  it("leaks NO entitlement, role, or tool-policy information", () => {
    // Targeted at what the renderer could actually emit. A bare
    // not.toContain("admin") would fail spuriously the day someone adds a
    // server slugged `admin-tools`, while proving nothing extra.
    expect(html).not.toContain("entitlements");
    expect(html).not.toContain('"roles"');
    // The gcs server's tools policy is allow: [list_files]; deny: [delete_file].
    expect(html).not.toContain("list_files");
    expect(html).not.toContain("delete_file");
  });

  it("ESCAPES config-supplied strings, which are the whole input surface", () => {
    // Nothing here is attacker-controlled today, but every string on this page
    // comes from free-form YAML and the page is public. This is the guard
    // against a future refactor dropping an esc().
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain('" onmouseover="');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&amp; &quot;quoted&quot;");
  });
});

describe("GET / without gateway.publicUrl", () => {
  it("falls back to the request origin, not an unpastable relative /mcp", async () => {
    const cfg = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin] }
roles: { admin: { servers: ["*"] } }
servers:
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
`);
    const { url, close } = await boot(cfg);
    const body = await (await fetch(url, { headers: AUTH })).text();
    // The host header the request actually arrived on.
    const origin = url.replace(/\/$/, "");
    expect(body).toContain(`data-url="${origin}/mcp?servers=echo"`);
    expect(body).not.toContain('value="/mcp"');
    close();
  });
});

describe("GET / with no enabled servers", () => {
  it("renders an empty state rather than an empty grid", async () => {
    const cfg = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin] }
roles: { admin: { servers: ["*"] } }
servers:
  - slug: off-server
    kind: builtin
    module: "./servers/echo.js"
    enabled: false
    entitlements: [admin]
`);
    const { url, close } = await boot(cfg);
    const body = await (await fetch(url, { headers: AUTH })).text();
    expect(body).toContain("No servers are enabled on this gateway.");
    expect(body).toContain('<span class="panel-note">0 enabled</span>');
    expect(body).not.toContain("off-server");
    close();
  });
});

describe("GET / in bundle mode", () => {
  it("is not served — a bundle component is internal and has no front door", async () => {
    const registry = await Registry.build({
      config: CONFIG,
      secrets: sharedSecretProviders(new EnvSecretProvider(SECRETS)),
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
    // WITH a valid credential, so a 404 unambiguously means "not mounted"
    // rather than "gated" — the point is that no front door exists here at all.
    const res = await fetch(`http://127.0.0.1:${addr.port}/`, {
      headers: AUTH,
      redirect: "manual",
    });
    expect(res.status).toBe(404);
    s.close();
  });
});
