import { sharedSecretProviders } from "../src/secrets/provider/index.ts";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { EnvSecretProvider } from "../src/secrets/provider/index.ts";
import { SHELL_PATHS, THEME_COLOR } from "../src/ui/pwa.ts";

/**
 * The PWA surface: `/manifest.webmanifest`, `/sw.js`, the icons, `/pwa/offline`.
 *
 * Two things are being held here, and they pull in opposite directions.
 *
 * The first is that these routes MUST answer an anonymous request. A browser
 * fetches `<link rel="manifest">` without credentials, so a gated manifest is a
 * 401 and nothing is installable; the worker script and the icons are in the
 * same position. Every one of them is therefore in front of the SSO gate.
 *
 * The second is that being in front of the gate is only acceptable because each
 * is a static brand asset — the same bytes for every visitor, naming no server,
 * no bucket, no identity and no config value. The leak assertions below are that
 * claim, written against the payloads an anonymous caller can actually pull.
 *
 * The gated surfaces are asserted to be unchanged: `/` and `/ui` still 401.
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
      GCS_CLIENT_EMAIL: "\${GCS_CLIENT_EMAIL}"
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
`);

const SECRETS = { GCS_CLIENT_EMAIL: "svc@demo.iam.gserviceaccount.com" };
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
});

afterAll(() => {
  server?.close();
});

/** Only the fields these tests read. The route's shape is pwa.ts's business. */
interface ManifestShape {
  name: string;
  short_name: string;
  /** What the browser keys the install on. Pinned, so `start_url` may move. */
  id: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: { src: string; sizes: string; type?: string; purpose?: string }[];
}

async function readManifest(): Promise<ManifestShape> {
  return (await (
    await fetch(`${baseUrl}/manifest.webmanifest`)
  ).json()) as ManifestShape;
}

describe("the manifest", () => {
  it("is served to an anonymous request — a gated one cannot be installed", async () => {
    const res = await fetch(`${baseUrl}/manifest.webmanifest`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain(
      "application/manifest+json",
    );
  });

  it("parses, and carries what a browser demands before it offers an install", async () => {
    const m = await readManifest();

    expect(m.name).toBe("strad console");
    expect(m.short_name).toBe("strad");
    // The console's working surface, which is where an installed app should
    // open. `id` stays `/ui` on purpose — it is what the browser keys the
    // install on, so pinning it is what let `start_url` move without every
    // installed copy becoming a second app.
    expect(m.start_url).toBe("/connectors");
    expect(m.id).toBe("/ui");
    expect(m.scope).toBe("/");
    expect(m.display).toBe("standalone");

    // 192 and 512 are the two sizes the install criteria actually check for.
    const sizes = m.icons.map((i) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect(m.icons.some((i) => i.purpose === "maskable")).toBe(true);
  });

  it("agrees with the console's own background — the window must not flash", async () => {
    const m = await readManifest();
    // `--bg` in render.ts's THEME_CSS, which layout() pins via data-theme="dark".
    expect(THEME_COLOR).toBe("#0f1116");
    expect(m.theme_color).toBe(THEME_COLOR);
    expect(m.background_color).toBe(THEME_COLOR);
  });

  it("names no server, bucket, secret or hostname", async () => {
    const body = await (await fetch(`${baseUrl}/manifest.webmanifest`)).text();
    for (const leak of [
      "gcs",
      "echo",
      "demo-bucket",
      "GCS_CLIENT_EMAIL",
      "svc@demo.iam.gserviceaccount.com",
      "staging.strad.example.com",
      BOOTSTRAP,
    ]) {
      expect(body).not.toContain(leak);
    }
  });
});

describe("the service worker script", () => {
  it("is served from the root, so its scope is the whole origin", async () => {
    const res = await fetch(`${baseUrl}/sw.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
  });

  it("must be revalidated, so a deploy takes effect on the next visit", async () => {
    const res = await fetch(`${baseUrl}/sw.js`);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("shares that with the two shell entries that actually change", async () => {
    // `cache.addAll()` is an ordinary fetch and will be answered from the HTTP
    // cache. A freshness window on these two is therefore a window in which a
    // RE-INSTALLING worker precaches the old bytes — which is exactly the sharp
    // edge HACKS.md #41 is about, so it is not widened here. The icons may sit
    // in the HTTP cache; their bytes do not change without the module changing.
    for (const path of ["/manifest.webmanifest", "/pwa/offline"]) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.headers.get("cache-control"), path).toBe("no-cache");
    }
    for (const path of ["/pwa/icon-192.png", "/pwa/icon.svg"]) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.headers.get("cache-control"), path).toBe(
        "public, max-age=3600",
      );
    }
  });

  it("names only shell paths — no console route appears in its source", async () => {
    const src = await (await fetch(`${baseUrl}/sw.js`)).text();
    // The worker's cache list is a literal in the file. Anything that could
    // reach an authenticated response must be absent from it.
    for (const gated of [
      '"/ui"',
      '"/ui/',
      '"/console"',
      '"/mcp"',
      '"/api/',
      '"/secrets"',
    ]) {
      expect(src).not.toContain(gated);
    }
  });

  it("writes to a cache in exactly one place, and it is the shell", async () => {
    const src = await (await fetch(`${baseUrl}/sw.js`)).text();
    // `cache.put` / `caches.put` is how a response gets persisted. There is no
    // such call: the only write is `addAll` over the constant shell list.
    expect(src).not.toMatch(/\.put\s*\(/);
    expect(src.match(/addAll\s*\(/g)).toHaveLength(1);
    expect(src).toContain("cache.addAll(SHELL)");
  });
});

describe("the shell", () => {
  it("is entirely reachable without credentials — install cannot depend on a session", async () => {
    for (const path of SHELL_PATHS) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status, path).toBe(200);
    }
  });

  it("serves real PNG bytes at both icon sizes", async () => {
    for (const path of ["/pwa/icon-192.png", "/pwa/icon-512.png"]) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.headers.get("content-type")).toContain("image/png");
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(Array.from(bytes.slice(0, 8))).toEqual([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      expect(bytes.byteLength).toBeGreaterThan(512);
    }
  });

  it("declares the icon dimensions the manifest claims", async () => {
    // IHDR is the first chunk: width and height are big-endian u32 at offset 16.
    for (const [path, side] of [
      ["/pwa/icon-192.png", 192],
      ["/pwa/icon-512.png", 512],
      ["/pwa/icon-maskable-512.png", 512],
    ] as const) {
      const buf = Buffer.from(
        await (await fetch(`${baseUrl}${path}`)).arrayBuffer(),
      );
      expect([buf.readUInt32BE(16), buf.readUInt32BE(20)], path).toEqual([
        side,
        side,
      ]);
    }
  });

  it("offers an offline page that names nothing about this deployment", async () => {
    const res = await fetch(`${baseUrl}/pwa/offline`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("No connection");
    // Precached means "written once, shown to whoever opens the app next". A
    // slug, an identity or a hostname baked into it would be frozen on disk.
    for (const leak of [
      "gcs",
      "demo-bucket",
      "svc@demo.iam.gserviceaccount.com",
      "staging.strad.example.com",
      "signed in",
      BOOTSTRAP,
    ]) {
      expect(html).not.toContain(leak);
    }
  });
});

describe("the gate is untouched", () => {
  it("still walls off the console and the landing page", async () => {
    for (const path of ["/", "/ui", "/ui/gcs"]) {
      const res = await fetch(`${baseUrl}${path}`, { redirect: "manual" });
      expect(res.status, path).toBe(401);
    }
  });

  it("keeps every gated route out of the shell list", () => {
    for (const path of SHELL_PATHS) {
      expect(path.startsWith("/pwa/") || path === "/manifest.webmanifest").toBe(
        true,
      );
    }
  });
});

describe("the console page", () => {
  it("links the manifest and registers the worker", async () => {
    const html = await (await fetch(`${baseUrl}/ui`, { headers: AUTH })).text();
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain(`<meta name="theme-color" content="${THEME_COLOR}"`);
    expect(html).toContain('navigator.serviceWorker.register("/sw.js"');
    expect(html).toContain('<link rel="apple-touch-icon"');
  });

  it("registers from the sign-in wall too, so an install can start there", async () => {
    const html = await (await fetch(`${baseUrl}/ui`)).text();
    expect(html).toContain('navigator.serviceWorker.register("/sw.js"');
  });
});
