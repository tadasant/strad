import {
  discoverOAuthProtectedResourceMetadata,
  extractResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Request } from "express";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import {
  metadataBaseUrl,
  PROTECTED_RESOURCE_ROUTES,
  protectedResourceMetadata,
  resourceIdentifier,
  resourceMetadataUrl,
  wwwAuthenticate,
} from "../src/auth/protected-resource.ts";
import { mintToken } from "../src/auth/tokens.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";

/**
 * Discovery on `/mcp`: the RFC 9728 document, and the `401` that points at it.
 *
 * The thing being asserted is that a client which knows nothing about strad can
 * learn what `/mcp` accepts from strad itself. So the client half of these
 * tests is the MCP SDK's own discovery code rather than a re-implementation of
 * it — `extractResourceMetadataUrl` reads the header, and
 * `discoverOAuthProtectedResourceMetadata` fetches and SCHEMA-PARSES what it
 * points at. A document that satisfies a hand-written `toEqual` but not the
 * SDK's parser would pass a worse test than this one.
 *
 * The other half is the regression this change must not cause. The static
 * `strad_<env>_<pubid>_<secret>` path is the only credential `/mcp` accepts and
 * is load-bearing for every machine client, so it is exercised here too, end to
 * end through a real MCP client — additive metadata is the whole change, and a
 * token that stopped working would make it a rewrite.
 */

const YAML = `
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
servers:
  - slug: alpha
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
`;

const PUBLIC_URL = "https://strad.example.com";

const CONFIG = parseConfig(YAML);
const CONFIG_WITH_PUBLIC_URL = parseConfig(
  YAML.replace(
    "gateway: { name: strad, env: test }",
    `gateway: { name: strad, env: test, publicUrl: "${PUBLIC_URL}" }`,
  ),
);

const adminToken = mintToken({ env: "test", label: "admin", roles: ["admin"] });
const env: NodeJS.ProcessEnv = {
  STRAD_TOKENS: JSON.stringify([adminToken.record]),
};

interface Running {
  server: Server;
  baseUrl: string;
}

async function start(
  config: typeof CONFIG,
  mode: "core" | "bundle",
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<Running> {
  const merged = { ...env, ...extraEnv };
  const registry = await Registry.build({
    config,
    secrets: sharedSecretProviders(new EnvSecretProvider({})),
    mode,
    env: merged,
  });
  const app = createApp({
    config,
    registry,
    tokenStore: tokenStoreFromConfig(config, merged),
    mode,
    env: merged,
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

describe("the metadata document", () => {
  let core: Running;

  beforeAll(async () => {
    core = await start(CONFIG, "core");
  });
  afterAll(() => core?.server.close());

  it("is served, unauthenticated, from the RFC 9728 path-inserted URL", async () => {
    const res = await fetch(
      `${core.baseUrl}/.well-known/oauth-protected-resource/mcp`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual({
      resource: `${core.baseUrl}/mcp`,
      resource_name: "strad",
      bearer_methods_supported: ["header"],
      resource_documentation: "https://docs.strad.tadasant.com/auth/overview/",
    });
  });

  it("is served from the bare well-known path too, identically", async () => {
    const [inserted, root] = await Promise.all(
      PROTECTED_RESOURCE_ROUTES.map(async (route) =>
        (await fetch(`${core.baseUrl}${route}`)).json(),
      ),
    );
    expect(root).toEqual(inserted);
  });

  it("names NO authorization server", async () => {
    const doc = (await (
      await fetch(`${core.baseUrl}/.well-known/oauth-protected-resource/mcp`)
    ).json()) as Record<string, unknown>;
    // The absence is the decision, not an oversight: strad binds no
    // authorization server to `/mcp`, and an issuer whose tokens `/mcp` refuses
    // would send a client through a consent flow to arrive at the same 401.
    expect(doc).not.toHaveProperty("authorization_servers");
  });

  it("prefers gateway.publicUrl over the Host it was asked on", async () => {
    const declared = await start(CONFIG_WITH_PUBLIC_URL, "core");
    try {
      const doc = (await (
        await fetch(
          `${declared.baseUrl}/.well-known/oauth-protected-resource/mcp`,
        )
      ).json()) as { resource: string };
      expect(doc.resource).toBe(`${PUBLIC_URL}/mcp`);
    } finally {
      declared.server.close();
    }
  });

  it("is not mounted on a bundle, which no client discovers", async () => {
    const bundle = await start(CONFIG, "bundle", {
      STRAD_INTERNAL_TOKEN: "internal-token",
    });
    try {
      for (const route of PROTECTED_RESOURCE_ROUTES) {
        const res = await fetch(`${bundle.baseUrl}${route}`);
        expect(res.status).toBe(404);
      }
    } finally {
      bundle.server.close();
    }
  });
});

describe("the 401 on /mcp", () => {
  let core: Running;

  beforeAll(async () => {
    core = await start(CONFIG, "core");
  });
  afterAll(() => core?.server.close());

  it("keeps realm and error, and adds resource_metadata", async () => {
    const res = await fetch(`${core.baseUrl}/mcp`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer realm="strad", error="invalid_token", ` +
        `resource_metadata="${core.baseUrl}/.well-known/oauth-protected-resource/mcp"`,
    );
    await expect(res.json()).resolves.toEqual({ error: "invalid_token" });
  });

  it("points at a URL that actually serves the document", async () => {
    // The SDK's own two steps, in order: read the header, fetch what it names.
    // `discoverOAuthProtectedResourceMetadata` throws on a 404 and schema-parses
    // the body, so this asserts the pointer AND the document's conformance.
    const res = await fetch(`${core.baseUrl}/mcp`, { method: "POST" });
    const url = extractResourceMetadataUrl(res);
    expect(url?.href).toBe(
      `${core.baseUrl}/.well-known/oauth-protected-resource/mcp`,
    );
    const metadata = await discoverOAuthProtectedResourceMetadata(
      `${core.baseUrl}/mcp`,
      { resourceMetadataUrl: url },
    );
    expect(metadata.resource).toBe(`${core.baseUrl}/mcp`);
    expect(metadata.authorization_servers).toBeUndefined();
  });

  it("is discoverable without the header, by path-aware probing alone", async () => {
    const metadata = await discoverOAuthProtectedResourceMetadata(
      `${core.baseUrl}/mcp`,
    );
    expect(metadata.resource).toBe(`${core.baseUrl}/mcp`);
  });

  it("carries no resource_metadata on a bundle", async () => {
    const bundle = await start(CONFIG, "bundle", {
      STRAD_INTERNAL_TOKEN: "internal-token",
    });
    try {
      const res = await fetch(`${bundle.baseUrl}/mcp`, { method: "POST" });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(
        'Bearer realm="strad", error="invalid_token"',
      );
    } finally {
      bundle.server.close();
    }
  });
});

describe("a caller-supplied Host cannot dictate the pointer", () => {
  // The whole chain, over a raw socket, because `fetch` forbids setting `Host`
  // — and the caller's `Host` is the one input to the document and the header
  // that strad does not author. A quote in it would end the `quoted-string`
  // early and let the caller name a second `resource_metadata`.
  const HOSTILE = 'evil.example", resource_metadata="https://attacker.example';

  let core: Running;
  beforeAll(async () => {
    core = await start(CONFIG, "core");
  });
  afterAll(() => core?.server.close());

  function requestWithHost(
    path: string,
    method: string,
  ): Promise<{ status: number; wwwAuth?: string; body: string }> {
    const { port } = core.server.address() as AddressInfo;
    return new Promise((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path, method, headers: { host: HOSTILE } },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (body += c));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              wwwAuth: res.headers["www-authenticate"],
              body,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("is refused rather than echoed into the 401's header", async () => {
    const res = await requestWithHost("/mcp", "POST");
    expect(res.status).toBe(401);
    expect(res.wwwAuth).toBe('Bearer realm="strad", error="invalid_token"');
    expect(res.wwwAuth).not.toContain("attacker.example");
  });

  it("is refused rather than named as the resource", async () => {
    const res = await requestWithHost(
      "/.well-known/oauth-protected-resource/mcp",
      "GET",
    );
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "no_resource_identifier" });
  });
});

describe("the static bearer path is unchanged", () => {
  let core: Running;

  beforeAll(async () => {
    core = await start(CONFIG, "core");
  });
  afterAll(() => core?.server.close());

  it("still authenticates a minted token, end to end", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`${core.baseUrl}/mcp`),
      {
        requestInit: {
          headers: { authorization: `Bearer ${adminToken.plaintext}` },
        },
      },
    );
    const client = new Client({ name: "test", version: "1" }, {});
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "alpha__echo",
      "alpha__whoami",
    ]);
    await client.close();
  });

  it("still refuses a token that is not in the store", async () => {
    const res = await fetch(`${core.baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer strad_test_deadbeef_nope" },
    });
    expect(res.status).toBe(401);
  });

  it("still refuses a scheme-less header carrying the right token", async () => {
    const res = await fetch(`${core.baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: adminToken.plaintext },
    });
    expect(res.status).toBe(401);
  });
});

/** The two fields `metadataBaseUrl` reads off an express request, and no more. */
function fakeRequest(host: string | undefined): Request {
  return { protocol: "http", get: () => host } as unknown as Request;
}

describe("the URL builders", () => {
  it("insert the well-known string between host and path", () => {
    expect(resourceIdentifier(PUBLIC_URL)).toBe(`${PUBLIC_URL}/mcp`);
    expect(resourceMetadataUrl(PUBLIC_URL)).toBe(
      `${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp`,
    );
  });

  it("tolerate a trailing slash on the declared public URL", () => {
    expect(resourceMetadataUrl(`${PUBLIC_URL}/`)).toBe(
      resourceMetadataUrl(PUBLIC_URL),
    );
    expect(protectedResourceMetadata(`${PUBLIC_URL}/`, "strad").resource).toBe(
      `${PUBLIC_URL}/mcp`,
    );
  });

  // A declared `publicUrl` is schema-validated and still reaches here unclean:
  // `z.string().url()` accepts a quote, and so does `new URL()`.
  it.each([
    ['https://a"b.example'],
    ["https://a\\b.example"],
    ["javascript://evil.example"],
    ["file:///etc/passwd"],
    ["not a url"],
  ])("refuses %j as a declared publicUrl", (bad) => {
    expect(metadataBaseUrl(fakeRequest("ok.example"), bad)).toBeNull();
  });

  // The `Host` is whatever the caller sent. A quote in it would end the
  // `quoted-string` on the `401`'s header early and let the caller dictate a
  // second auth-param — so the base is refused and the parameter is omitted.
  it("refuses a Host that would break out of the quoted parameter", () => {
    const host = 'evil.example", resource_metadata="https://attacker.example';
    expect(metadataBaseUrl(fakeRequest(host), undefined)).toBeNull();
  });

  // `trust proxy` is on, so `req.protocol` is `X-Forwarded-Proto` — also the
  // caller's. `javascript://host` parses; it is not a base strad repeats back.
  it("refuses a forwarded scheme that is not http(s)", () => {
    const req = {
      protocol: "javascript",
      get: () => "ok.example",
    } as unknown as Request;
    expect(metadataBaseUrl(req, undefined)).toBeNull();
  });

  it("fall back to the request origin, and to nothing", () => {
    // A request carrying a `Host`, and one that does not. HTTP/1.1 requires the
    // header, so the second is the HTTP/1.0 client and the hand-rolled socket —
    // the cases where there is genuinely no origin to name.
    const withHost = fakeRequest("box:8080");
    const withoutHost = fakeRequest(undefined);
    expect(metadataBaseUrl(withHost, PUBLIC_URL)).toBe(PUBLIC_URL);
    expect(metadataBaseUrl(withHost, undefined)).toBe("http://box:8080");
    expect(metadataBaseUrl(withoutHost, undefined)).toBeNull();
    expect(metadataBaseUrl(withoutHost, PUBLIC_URL)).toBe(PUBLIC_URL);
  });

  it("omit the parameter when there is no URL to name", () => {
    expect(wwwAuthenticate(null)).toBe(
      'Bearer realm="strad", error="invalid_token"',
    );
  });
});
