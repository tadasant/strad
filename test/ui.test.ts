import { sharedSecretProviders } from "../src/secrets/provider/index.ts";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { resolveSelection } from "../src/gateway/entitlements.ts";
import type { GcsLister } from "../src/ui/gcs-client.ts";
import {
  resolveServerView,
  normalisePrefix,
  serverLooksGcs,
} from "../src/ui/resolve.ts";
import { sanitizePrefix } from "../src/ui/index.ts";
import { humanSize } from "../src/ui/render.ts";
import { EnvSecretProvider } from "../src/secrets/provider/index.ts";

/**
 * The human, SSO-gated resource browser.
 *
 * Two things must hold and are easy to get wrong:
 *   1. /ui is gated by the SAME console SSO as /console — a softer door here
 *      would be a hole on the open internet.
 *   2. The browse scope comes from the SERVER'S config (bucket + prefix + creds
 *      resolved from ${refs}), never from ambient globals.
 */

const CONFIG = parseConfig(`
version: 1
gateway: { name: strad, env: test }
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
`);

const SECRETS = {
  GCS_CLIENT_EMAIL: "svc@demo.iam.gserviceaccount.com",
  GCS_PRIVATE_KEY:
    "-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----",
};

const BOOTSTRAP = "bootstrap-secret-xyz";

// A GCS listing surface with no network. The route hands it a resolved account.
const fakeList: GcsLister = async (_account, options) => {
  if (options.prefix === "screenshots/") {
    return {
      objects: [
        {
          name: "screenshots/readme.txt",
          size: 42,
          updated: new Date().toISOString(),
        },
      ],
      prefixes: ["screenshots/2024/", "screenshots/archive/"],
    };
  }
  if (options.prefix === "screenshots/2024/") {
    return {
      objects: [
        {
          name: "screenshots/2024/pr-123.png",
          size: 204_800,
          updated: new Date().toISOString(),
        },
      ],
      prefixes: [],
    };
  }
  return { objects: [], prefixes: [] };
};

// --- pure units ------------------------------------------------------------

describe("resolveServerView (scope from config)", () => {
  it("resolves a GCS server's bucket, prefix and credentials from its config", () => {
    const view = resolveServerView(CONFIG, "gcs", SECRETS);
    expect(view.kind).toBe("gcs");
    if (view.kind !== "gcs") throw new Error("unreachable");
    expect(view.bucket).toBe("demo-bucket");
    expect(view.prefix).toBe("screenshots/");
    expect(view.account?.client_email).toBe("svc@demo.iam.gserviceaccount.com");
  });

  it("degrades to no-credentials (not a crash) when ${refs} are not injected", () => {
    const view = resolveServerView(CONFIG, "gcs", {});
    expect(view.kind).toBe("gcs");
    if (view.kind !== "gcs") throw new Error("unreachable");
    expect(view.account).toBeNull();
    expect(view.accountReason).toBeTruthy();
  });

  it("reports no_viewer for a non-GCS server", () => {
    const view = resolveServerView(CONFIG, "echo", SECRETS);
    expect(view.kind).toBe("no_viewer");
  });

  it("reports not_found for an unknown server", () => {
    expect(resolveServerView(CONFIG, "nope", SECRETS).kind).toBe("not_found");
  });
});

describe("helpers", () => {
  it("normalisePrefix tidies slashes", () => {
    expect(normalisePrefix("")).toBe("");
    expect(normalisePrefix("screenshots")).toBe("screenshots/");
    expect(normalisePrefix("/a/b/")).toBe("a/b/");
  });
  it("sanitizePrefix strips traversal and empty segments", () => {
    expect(sanitizePrefix("")).toBe("");
    expect(sanitizePrefix("2024/")).toBe("2024/");
    expect(sanitizePrefix("/../../etc/")).toBe("etc/");
    expect(sanitizePrefix(123)).toBe("");
  });
  it("humanSize is human", () => {
    expect(humanSize(0)).toBe("0 B");
    expect(humanSize(42)).toBe("42 B");
    expect(humanSize(204_800)).toBe("200 KB");
  });
  it("serverLooksGcs detects a GCS-backed server", () => {
    expect(serverLooksGcs(CONFIG.servers[0]!)).toBe(true);
    expect(serverLooksGcs(CONFIG.servers[1]!)).toBe(false);
  });
});

// --- through the real Express app ------------------------------------------

const env: NodeJS.ProcessEnv = {
  ALLOW_DEV_AUTH: "true",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
  // So Registry.build can construct the supplementary adapter (no connection).
  STRAD_BUNDLE_URL_BUNDLE_GCS: "http://127.0.0.1:1",
  STRAD_TOKENS: "[]",
};

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

describe("/ui SSO gate", () => {
  it("401s the browser with no token, and does NOT leak content", async () => {
    const res = await fetch(`${baseUrl}/ui/gcs`, { redirect: "manual" });
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain("Sign in required");
    expect(html).not.toContain("demo-bucket");
  });

  it("accepts the bootstrap token, moves it to a cookie, and strips the URL", async () => {
    const res = await fetch(`${baseUrl}/ui/gcs?token=${BOOTSTRAP}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/ui/gcs");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("strad_console=");
    expect(setCookie.toLowerCase()).toContain("httponly");
  });

  it("rejects a wrong token", async () => {
    const res = await fetch(`${baseUrl}/ui/gcs?token=wrong`, {
      redirect: "manual",
    });
    expect(res.status).toBe(401);
  });

  it("a valid session cookie survives a stale/wrong ?token= in the URL", async () => {
    const signin = await fetch(`${baseUrl}/ui/gcs?token=${BOOTSTRAP}`, {
      redirect: "manual",
    });
    const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie).toContain("strad_console=");

    // A stale/wrong ?token= must not shadow the valid cookie.
    const res = await fetch(`${baseUrl}/ui/gcs?token=WRONG`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("demo-bucket");
  });
});

describe("/ui/:server GCS browse", () => {
  const auth = { authorization: `Bearer ${BOOTSTRAP}` };

  it("lists folders and objects for the server's root", async () => {
    const res = await fetch(`${baseUrl}/ui/gcs`, { headers: auth });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("2024");
    expect(html).toContain("archive");
    expect(html).toContain("readme.txt");
    expect(html).toContain("demo-bucket");
  });

  it("descends into a folder via ?prefix and shows a breadcrumb", async () => {
    const res = await fetch(`${baseUrl}/ui/gcs?prefix=2024/`, {
      headers: auth,
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("pr-123.png");
    expect(html).toContain("200 KB");
    // breadcrumb links back to the root
    expect(html).toContain(`href="/ui/gcs"`);
  });

  it("renders a roster of every server, each carrying a secret badge", async () => {
    const res = await fetch(`${baseUrl}/connectors`, { headers: auth });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>Connectors · strad</title>");
    expect(html).toContain("gcs");
    expect(html).toContain("echo");
    // The badge is the point of the roster: every enabled entry carries one.
    expect(html).toMatch(/>READY</);
  });

  it("404s an unknown server", async () => {
    const res = await fetch(`${baseUrl}/ui/nope`, { headers: auth });
    expect(res.status).toBe(404);
  });

  it("shows the read-only overview for a non-GCS server", async () => {
    const res = await fetch(`${baseUrl}/ui/echo`, { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("read-only overview");
  });
});

/**
 * The 424's remediation link, followed.
 *
 * `resolveSelection()` emits `authorize_url` and this app serves it, and the two
 * are separate modules that nothing else joins up: a unit test on either side
 * passes while the link points at a path no route mounts, and the only symptom
 * is a client landing on Express's stock error page. So assert the join, over
 * the real router, by fetching the URL the gateway itself handed out.
 */
describe("the 424's authorize_url resolves to a console route", () => {
  const auth = { authorization: `Bearer ${BOOTSTRAP}` };

  /** The `authorize_url` a 424 would carry for `slug`, against this server. */
  function authorizeUrl(slug: string): string {
    const got = resolveSelection([slug], new Set<string>(), CONFIG, baseUrl);
    if (got.ok) throw new Error("expected an unavailable server");
    const url = got.unavailable[0]?.authorize_url;
    if (!url) throw new Error("expected an authorize_url");
    return url;
  }

  it("lands on the server's own console page when the slug is configured", async () => {
    const res = await fetch(authorizeUrl("gcs"), { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("demo-bucket");
  });

  it("lands on the console's own not-found — not Express's — for an invented slug", async () => {
    const res = await fetch(authorizeUrl("nosuch"), { headers: auth });
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("No such server");
    // The console page, with the server list one click away — the whole reason
    // a per-slug link beats a flat one for a slug that names nothing.
    expect(html).toContain(`href="/connectors"`);
    expect(html).not.toContain("Cannot GET");
  });
});
