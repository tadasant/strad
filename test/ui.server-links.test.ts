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
import { consoleView } from "../src/ui/roster-page.ts";
import { renderServerOverview } from "../src/ui/server-overview.ts";

/**
 * Every row on `/connectors` links to `/ui/<slug>`, and every such link lands on
 * a page.
 *
 * The case that found it: six `oauth:` connector slugs whose entries said "No
 * view" while their Connect page answered on `/ui/<slug>`, because the entry
 * asked a narrower question than the route answers. The other half is the kinds
 * with no dedicated view at all, whose link has to land on something better than
 * a 404 — the read-only overview.
 *
 * `/ui/<slug>` is the half of the console that did NOT move when the roster and
 * the front page were consolidated, and this file is what says so: the roster
 * moved to `/connectors`, every link on it still points here, and
 * `/ui/oauth/callback` — a Google-registered redirect URI — is under the same
 * prefix.
 */

const YAML = `
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
servers:
  - slug: sheets-connector
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /sheets-connector
    entitlements: [admin]
    oauth:
      provider: generic
      label: Linear
      authorizeUrl: https://linear.app/oauth/authorize
      tokenUrl: https://api.linear.app/oauth/token
      scopes: [read]
      clientIdVariable: LINEAR_OAUTH_CLIENT_ID
      clientSecretVariable: LINEAR_OAUTH_CLIENT_SECRET
      refreshTokenVariable: LINEAR_OAUTH_TOKEN
  - slug: object-store
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /gcs
    entitlements: [admin]
    env:
      GCS_BUCKET: "demo-bucket"
  - slug: deepwiki
    kind: remote-http
    url: https://deepwiki.example.com/mcp/key-in-the-path
    entitlements: [admin]
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
  - slug: retired
    kind: remote-http
    url: https://retired.example.com/mcp
    enabled: false
    entitlements: [admin]
`;

const CONFIG = parseConfig(YAML);
const BOOTSTRAP = "bootstrap-secret-links";
const AUTH = { authorization: `Bearer ${BOOTSTRAP}` };
const BAG: Record<string, string> = {
  STRAD_TOKENS: "[]",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
};
const ENV: NodeJS.ProcessEnv = {
  ALLOW_DEV_AUTH: "true",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
  STRAD_BUNDLE_URL_BUNDLE: "http://127.0.0.1:1",
  STRAD_TOKENS: "[]",
};

let server: Server;
let baseUrl: string;
let index: string;

const get = (path: string) => fetch(`${baseUrl}${path}`, { headers: AUTH });

beforeAll(async () => {
  const provider = new EnvSecretProvider(BAG);
  const registry = await Registry.build({
    config: CONFIG,
    secrets: sharedSecretProviders(provider),
    mode: "core",
    env: ENV,
  });
  const app = createApp({
    config: CONFIG,
    registry,
    tokenStore: tokenStoreFromConfig(CONFIG, ENV),
    mode: "core",
    env: ENV,
    secrets: BAG,
    secretProvider: sharedSecretProviders(provider),
  });
  server = app.listen(0);
  await new Promise<void>((r) => server.on("listening", () => r()));
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  index = await (await get("/connectors")).text();
});

afterAll(() => server?.close());

describe("consoleView", () => {
  const view = (slug: string) =>
    consoleView(
      CONFIG,
      CONFIG.servers.find((s) => s.slug === slug)!,
    );

  it("reads a connector the way the route does — before env detection", () => {
    expect(view("sheets-connector")).toBe("connector");
    expect(view("object-store")).toBe("gcs");
    expect(view("deepwiki")).toBe("overview");
    expect(view("echo")).toBe("overview");
  });

  it("gives a DISABLED connector with no other view the overview, as the route does", () => {
    // connectorFor answers only for an enabled server, so /ui/<slug> for a
    // disabled one falls through to env detection. The card has to agree.
    const disabled = parseConfig(
      YAML.replace(
        "path: /sheets-connector\n",
        "path: /sheets-connector\n    enabled: false\n",
      ),
    );
    const s = disabled.servers.find((x) => x.slug === "sheets-connector")!;
    expect(s.enabled).toBe(false);
    expect(consoleView(disabled, s)).toBe("overview");
  });

  it("puts a declared connector ahead of a bucket, and only while it is enabled", () => {
    const both = (enabled: boolean) => {
      const config = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
bundles:
  - name: bundle
servers:
  - slug: both
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /both
    enabled: ${enabled}
    env:
      GCS_BUCKET: "demo-bucket"
    oauth:
      provider: generic
      authorizeUrl: https://linear.app/oauth/authorize
      tokenUrl: https://api.linear.app/oauth/token
      scopes: [read]
      clientIdVariable: BOTH_OAUTH_CLIENT_ID
      clientSecretVariable: BOTH_OAUTH_CLIENT_SECRET
      refreshTokenVariable: BOTH_OAUTH_TOKEN
`);
      return consoleView(config, config.servers[0]!);
    };
    expect(both(true)).toBe("connector");
    // Disabled, the route skips the connector and resolves the bucket.
    expect(both(false)).toBe("gcs");
  });
});

describe("renderServerOverview", () => {
  const config = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
bundles:
  - name: bundle
servers:
  - slug: plain-image
    kind: supplementary-image
    title: '<b>"Plain"</b>'
    description: "<script>alert(1)</script>"
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /plain
`);
  const html = renderServerOverview({
    server: config.servers[0]!,
    playable: false,
    editable: false,
    base: "",
  });

  it("escapes a declared title and description", () => {
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('<b>"Plain"</b>');
  });

  it("shows a supplementary image's bundle and path", () => {
    expect(html).toMatch(/scope-l">bundle<\/span><code>bundle</);
    expect(html).toMatch(/scope-l">path<\/span><code>\/plain</);
  });

  it("offers no MCP URL without an origin, and says why the playground is not offered", () => {
    expect(html).not.toContain("mcp?servers=");
    expect(html).toContain("The playground is not open");
  });

  it("does not offer the per-entry form on a gateway with no runtime roster", () => {
    // `/connectors/<slug>` answers with the "editor is off" 404 where there is
    // no store to edit, so offering it as a door would send a reader from a
    // working page to a dead one. The roster itself answers either way, and
    // that is what the overview points at instead.
    expect(html).not.toContain('href="/connectors/plain-image"');
    expect(html).toContain('href="/connectors"');

    const editable = renderServerOverview({
      server: config.servers[0]!,
      playable: false,
      editable: true,
      base: "",
    });
    expect(editable).toContain('href="/connectors/plain-image"');
  });
});

describe("GET /connectors — every row links to its own page", () => {
  it("links the name and the CTA of EVERY configured server", () => {
    for (const { slug } of CONFIG.servers) {
      expect(index, slug).toContain(`<a class="conn-name" href="/ui/${slug}">`);
      expect(index, slug).toContain(`<a class="card-cta" href="/ui/${slug}">`);
    }
    expect(index).not.toContain("No view");
  });

  it("labels the CTA by what the page does", () => {
    const cta = (slug: string) =>
      index.match(
        new RegExp(`<a class="card-cta" href="/ui/${slug}">([^<]*)</a>`),
      )?.[1];
    expect(cta("sheets-connector")).toBe("Manage →");
    expect(cta("object-store")).toBe("Browse →");
    expect(cta("deepwiki")).toBe("Details →");
    expect(cta("retired")).toBe("Details →");
  });

  it("nests no control inside a name link", () => {
    for (const m of index.matchAll(
      /<a class="conn-name"[^>]*>([\s\S]*?)<\/a>/g,
    )) {
      expect(m[1]).not.toMatch(/<(a|button)\b/);
    }
  });
});

describe("GET /ui/<slug> — the page each link opens", () => {
  it("serves the connector's own page for an oauth: slug", async () => {
    const res = await get("/ui/sheets-connector");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("What this authorization grants");
  });

  it("serves a read-only overview for a kind with no dedicated view", async () => {
    const res = await get("/ui/deepwiki");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>deepwiki</h1>");
    expect(html).toContain("remote-http");
    expect(html).toContain("deepwiki.example.com");
    // The host, never the path: a vendor that keys by URL keys the path.
    expect(html).not.toContain("key-in-the-path");
    expect(html).toContain(`href="/playground/deepwiki"`);
    // No runtime roster on this gateway, so the door offered is the roster
    // itself rather than a per-entry form that would answer 404.
    expect(html).toContain(`href="/connectors"`);
    expect(html).not.toContain(`href="/connectors/deepwiki"`);
    expect(html).toContain("https://console.example.com/mcp?servers=deepwiki");
    // The same badge the index draws for this entry.
    expect(html).toMatch(/chip-badge">(READY|ISSUE)</);
    // Read-only: no form posts anywhere from this page.
    expect(html).not.toMatch(/<form\b/);
  });

  it("serves the overview for a builtin", async () => {
    const res = await get("/ui/echo");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("builtin");
  });

  it("says a disabled server is disabled, and offers no MCP URL for it", async () => {
    const res = await get("/ui/retired");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Disabled.");
    expect(html).not.toContain("mcp?servers=retired");
    expect(html).not.toContain(`href="/playground/retired"`);
  });

  it("still 404s a slug that names nothing", async () => {
    expect((await get("/ui/nope")).status).toBe(404);
  });
});

describe("the /ui prefix survived the roster moving off it", () => {
  it("redirects /ui itself, and ONLY /ui itself", async () => {
    const root = await fetch(`${baseUrl}/ui`, {
      headers: AUTH,
      redirect: "manual",
    });
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/connectors");

    // The exact-path redirect is what keeps every one of these answering.
    for (const slug of ["deepwiki", "echo", "object-store"]) {
      const res = await fetch(`${baseUrl}/ui/${slug}`, {
        headers: AUTH,
        redirect: "manual",
      });
      expect(res.status, slug).toBe(200);
    }
  });

  it("still routes /ui/oauth/callback, which Google holds as a redirect URI", async () => {
    // THE ONE PATH IN THIS CONSOLE THAT CANNOT MOVE. It is registered with
    // Google as an authorized redirect URI for the production OAuth client, and
    // a change here surfaces as `redirect_uri_mismatch` on a human's screen
    // rather than as a failing test — so this is the test.
    //
    // Asserted as "strad answered", not as a status: the callback with no
    // transaction cookie is a refusal by design. What must never happen is
    // Express's own 404, or the `/ui` redirect swallowing it.
    const res = await fetch(`${baseUrl}/ui/oauth/callback?code=x&state=y`, {
      headers: AUTH,
      redirect: "manual",
    });
    expect(res.status).not.toBe(302);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).not.toContain("Cannot GET");
    expect(body).toContain('<nav class="mainnav"');
  });
});
