import { generateKeyPairSync } from "node:crypto";
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
import type { ServiceAccount } from "../src/secrets/parameters/service-account.ts";
import { createGcsLister, GcsError } from "../src/ui/gcs-client.ts";

/**
 * The GCS browser's own half of the shared service-account mint.
 *
 * `createGcsLister` no longer signs its own JWT — it calls the store-neutral
 * `mintAccessToken` in src/secrets/parameters/service-account.ts. Three things
 * about that seam are load-bearing and invisible to the type system:
 *
 *   1. The scope stays the NARROW one. `MintOptions.scope` is required, so it
 *      cannot be widened by omission — but it can be widened by editing, and
 *      this browser must never hold write access to a bucket.
 *   2. A rejected exchange must still reach the console as a `GcsError` with the
 *      HTTP status on it. src/ui/index.ts renders its 403 explanation from
 *      `.status`; the shared module throws `ServiceAccountAuthError` instead.
 *   3. The per-client_email token cache is this client's, not the shared
 *      module's, and survives the conversion.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";

function account(email: string): ServiceAccount {
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  return {
    client_email: email,
    // The escaped-newline shape a key carries when it travels through an env
    // var. The repair lives in the shared module; signing proves it ran.
    private_key: pem.replace(/\n/g, "\\n"),
  };
}

const ACCOUNT = account("browser@demo.iam.gserviceaccount.com");

interface Stub {
  calls: { url: string; body?: string }[];
  fetchImpl: typeof fetch;
}

/**
 * A two-endpoint stub: Google's token endpoint, and the GCS JSON API. `token`
 * decides what the exchange answers; the listing is always the same page.
 */
function stub(token: { status: number; body: unknown }): Stub {
  const calls: { url: string; body?: string }[] = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    if (url === TOKEN_URL) {
      calls.push({ url, body: String(init?.body ?? "") });
      return new Response(JSON.stringify(token.body), {
        status: token.status,
        statusText: token.status === 403 ? "Forbidden" : "OK",
        headers: { "content-type": "application/json" },
      });
    }
    calls.push({ url });
    return new Response(
      JSON.stringify({
        items: [{ name: "shots/readme.txt", size: "42" }],
        prefixes: ["shots/2024/"],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const OK_TOKEN = {
  status: 200,
  body: { access_token: "at-1", expires_in: 3600 },
};

function claimsOf(body: string): Record<string, unknown> {
  const assertion = new URLSearchParams(body).get("assertion") ?? "";
  const payload = assertion.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

describe("createGcsLister mints through the shared service-account flow", () => {
  it("signs the escaped-newline key and lists the bucket", async () => {
    const s = stub(OK_TOKEN);
    const list = createGcsLister(s.fetchImpl);

    const result = await list(ACCOUNT, { bucket: "demo", prefix: "shots/" });

    expect(result.objects).toEqual([{ name: "shots/readme.txt", size: 42 }]);
    expect(result.prefixes).toEqual(["shots/2024/"]);
    // The exchange happened, and the listing carried the minted token.
    expect(s.calls[0]!.url).toBe(TOKEN_URL);
    expect(s.calls[1]!.url).toContain("storage.googleapis.com");
  });

  it("asks for the read-only Storage scope, never cloud-platform", async () => {
    const s = stub(OK_TOKEN);
    await createGcsLister(s.fetchImpl)(ACCOUNT, { bucket: "demo" });

    const claims = claimsOf(s.calls[0]!.body!);
    expect(claims.scope).toBe(
      "https://www.googleapis.com/auth/devstorage.read_only",
    );
    expect(claims.iss).toBe(ACCOUNT.client_email);
    expect(claims.aud).toBe(TOKEN_URL);
  });

  it("caches the token per client_email", async () => {
    const s = stub(OK_TOKEN);
    const list = createGcsLister(s.fetchImpl);

    await list(ACCOUNT, { bucket: "demo" });
    await list(ACCOUNT, { bucket: "demo", prefix: "shots/" });
    expect(s.calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(1);

    // A different account is a different credential and mints its own.
    await list(account("other@demo.iam.gserviceaccount.com"), {
      bucket: "demo",
    });
    expect(s.calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(2);
  });

  it("turns a rejected exchange into a GcsError carrying the status", async () => {
    const s = stub({
      status: 403,
      body: { error: "unauthorized_client", error_description: "no" },
    });

    const err = await createGcsLister(s.fetchImpl)(ACCOUNT, {
      bucket: "demo",
    }).catch((e: unknown) => e);

    // The type is what src/ui/index.ts branches on; the status is what it
    // renders. A ServiceAccountAuthError reaching the view would lose both.
    expect(err).toBeInstanceOf(GcsError);
    expect((err as GcsError).status).toBe(403);
    expect((err as GcsError).message).toContain("GCS token exchange failed");
    expect((err as GcsError).message).toContain("403");
    // The listing was never attempted with a token we do not have.
    expect(s.calls).toHaveLength(1);
  });

  it("turns a 200 with no access_token into a 502 GcsError", async () => {
    const s = stub({ status: 200, body: { expires_in: 3600 } });

    const err = await createGcsLister(s.fetchImpl)(ACCOUNT, {
      bucket: "demo",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GcsError);
    expect((err as GcsError).status).toBe(502);
  });
});

// --- and through the console, which is what a human sees -------------------

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
      GCS_CLIENT_EMAIL: "\${GCS_CLIENT_EMAIL}"
      GCS_PRIVATE_KEY: "\${GCS_PRIVATE_KEY}"
`);

const SECRETS = {
  GCS_CLIENT_EMAIL: ACCOUNT.client_email,
  GCS_PRIVATE_KEY: ACCOUNT.private_key,
};

const BOOTSTRAP = "bootstrap-secret-xyz";

const env: NodeJS.ProcessEnv = {
  ALLOW_DEV_AUTH: "true",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
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
    // The REAL lister, over a stubbed network — the converted mint included.
    gcsList: createGcsLister(
      stub({ status: 403, body: { error: "unauthorized_client" } }).fetchImpl,
    ),
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => server?.close());

describe("the console's credential panel", () => {
  it("still explains a rejected exchange by its status", async () => {
    const res = await fetch(`${baseUrl}/ui/gcs`, {
      headers: { authorization: `Bearer ${BOOTSTRAP}` },
    });

    expect(res.status).toBe(502);
    const html = await res.text();
    expect(html).toContain("Could not list this bucket");
    // `${err.status} — ${err.message}`, the shape index.ts has always rendered.
    expect(html).toContain("403 — GCS token exchange failed: 403");
    expect(html).toContain("credential or bucket-permission problem");
  });
});
