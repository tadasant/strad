import type { Server as HttpServer } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import {
  clientMetadataDocument,
  clientMetadataUrl,
  clientSource,
  discoverUpstream,
  metadataDocumentEligible,
  upstreamConnectorFor,
  upstreamPlan,
  type UpstreamPlan,
} from "../src/connectors/upstream.ts";
import {
  CLIENT_METADATA_ROUTE,
  createClientMetadataHandler,
} from "../src/http/client-metadata.ts";
import type { ParameterMeta } from "../src/secrets/parameters/index.ts";

/**
 * Connect as a CLIENT ID METADATA DOCUMENT client: the document strad serves
 * per slug, the order `clientSource` picks a client in, and discovery reading
 * `client_id_metadata_document_supported`. The shapes are Loops' official
 * server, which takes a metadata document and offers no registration.
 * test/connector.upstream.e2e.test.ts runs the whole Connect against one.
 */

const PUBLIC = "https://strad.example";
const DOC = `${PUBLIC}/_strad/oauth/client/loops.json`;
const CALLBACK = `${PUBLIC}/ui/oauth/callback`;

const REFS = `
      tokenUrl: "\${LOOPS_TOKEN_URL}"
      clientId: "\${LOOPS_CLIENT_ID}"
      refreshToken: "\${LOOPS_REFRESH_TOKEN}"
      resource: "\${LOOPS_RESOURCE}"`;

function configOf(
  oauthRefresh = REFS,
  publicUrl: string | null = PUBLIC,
  extra = "",
) {
  return parseConfig(`
version: 1
gateway:
  name: strad
  env: test
${publicUrl === null ? "" : `  publicUrl: ${publicUrl}`}
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
servers:
  - slug: loops
    kind: remote-http
    url: https://mcp.loops.so/
    entitlements: [admin]
    oauthRefresh:${oauthRefresh}
  - slug: plain
    kind: remote-http
    url: https://mcp.example/mcp
    entitlements: [admin]
${extra}`);
}

const planOf = (config: ReturnType<typeof configOf>): UpstreamPlan =>
  upstreamPlan(upstreamConnectorFor(config, "loops")!);

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function serve(config: ReturnType<typeof configOf>): Promise<string> {
  const app = express();
  app.get(CLIENT_METADATA_ROUTE, createClientMetadataHandler(config));
  const server: HttpServer = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe("the client metadata document", () => {
  it("is served at its own client_id, public, as JSON, naming the Connect callback and a public client", async () => {
    const base = await serve(configOf());
    const res = await fetch(`${base}/_strad/oauth/client/loops.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc).toEqual({
      client_id: DOC,
      client_name: "strad (test) loops",
      redirect_uris: [CALLBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    // The id is the address the document is served at, exactly.
    expect(doc.client_id).toBe(clientMetadataUrl(configOf(), "loops"));
    expect(JSON.stringify(doc)).not.toMatch(/secret|LOOPS_/i);
  });

  it("takes registration.clientName as its name", () => {
    const doc = clientMetadataDocument(
      configOf(`${REFS}
      registration:
        clientName: Claude Code (strad)`),
      "loops",
    );
    expect(doc?.client_name).toBe("Claude Code (strad)");
  });

  it("is a bare 404 for an unknown slug, a server that is not a Connect, and any other file", async () => {
    const base = await serve(configOf());
    for (const path of [
      "nobody.json",
      "plain.json",
      "loops",
      "loops.txt",
      "loops.json.json",
    ]) {
      const res = await fetch(`${base}/_strad/oauth/client/${path}`);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });

  it("is not published for a client the document could not stand for", () => {
    // A literal client id: the config names its client.
    expect(
      clientMetadataDocument(
        configOf(`
      tokenUrl: "\${LOOPS_TOKEN_URL}"
      clientId: hand-registered
      refreshToken: "\${LOOPS_REFRESH_TOKEN}"`),
        "loops",
      ),
    ).toBeNull();
    // A declared client secret: a confidential client, never this document.
    expect(
      clientMetadataDocument(
        configOf(`${REFS}
      clientSecret: "\${LOOPS_CLIENT_SECRET}"`),
        "loops",
      ),
    ).toBeNull();
    // A disabled server is never built.
    expect(
      clientMetadataDocument(
        parseConfig(`
version: 1
gateway: { name: strad, env: test, publicUrl: ${PUBLIC} }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
servers:
  - slug: loops
    kind: remote-http
    enabled: false
    url: https://mcp.loops.so/
    entitlements: [admin]
    oauthRefresh:${REFS}
`),
        "loops",
      ),
    ).toBeNull();
  });

  it("needs an https public URL: none, or plain http, is no document and no client id", () => {
    expect(clientMetadataUrl(configOf(REFS, null), "loops")).toBeNull();
    expect(clientMetadataDocument(configOf(REFS, null), "loops")).toBeNull();
    const http = configOf(REFS, "http://strad.example");
    expect(clientMetadataUrl(http, "loops")).toBeNull();
    expect(clientMetadataDocument(http, "loops")).toBeNull();
    // A trailing slash on the origin is not a doubled one in the id.
    expect(clientMetadataUrl(configOf(REFS, `${PUBLIC}/`), "loops")).toBe(DOC);
  });
});

describe("clientSource: supplied > metadata document > registration > seeded", () => {
  const seeded = new Map<string, ParameterMeta>([
    [
      "LOOPS_CLIENT_ID",
      {
        path: "/strad/test/mcp/loops/static/LOOPS_CLIENT_ID",
        variable: "LOOPS_CLIENT_ID",
        hasValue: true,
      } as ParameterMeta,
    ],
  ]);
  const both = { metadataDocument: DOC, registration: true };

  it("a literal client id beats a server that takes a metadata document", () => {
    const plan = planOf(
      configOf(`
      tokenUrl: "\${LOOPS_TOKEN_URL}"
      clientId: hand-registered
      refreshToken: "\${LOOPS_REFRESH_TOKEN}"`),
    );
    expect(clientSource(plan, both, seeded)).toEqual({
      kind: "literal",
      clientId: "hand-registered",
    });
  });

  it("a server that takes a metadata document AND registers gets the document; so does one that only takes the document", () => {
    const plan = planOf(configOf());
    expect(metadataDocumentEligible(plan)).toBe(true);
    const doc = { kind: "metadata_document", clientId: DOC };
    expect(clientSource(plan, both, new Map())).toEqual(doc);
    expect(
      clientSource(
        plan,
        { metadataDocument: DOC, registration: false },
        new Map(),
      ),
    ).toEqual(doc);
    // Ahead of a held client id, which is what an earlier Connect wrote.
    expect(clientSource(plan, both, seeded)).toEqual(doc);
  });

  it("no document to offer: registration, then the seeded client, then nothing", () => {
    const plan = planOf(configOf());
    const reg = { metadataDocument: null, registration: true };
    const none = { metadataDocument: null, registration: false };
    expect(clientSource(plan, reg, seeded)).toEqual({ kind: "register" });
    expect(clientSource(plan, none, seeded)).toEqual({
      kind: "seeded",
      variable: "LOOPS_CLIENT_ID",
      path: "/strad/test/mcp/loops/static/LOOPS_CLIENT_ID",
    });
    expect(clientSource(plan, none, new Map())).toBeNull();
  });

  it("a declared client secret never signs in with the document", () => {
    const plan = planOf(
      configOf(`${REFS}
      clientSecret: "\${LOOPS_CLIENT_SECRET}"`),
    );
    expect(metadataDocumentEligible(plan)).toBe(false);
    expect(
      clientSource(
        plan,
        { metadataDocument: DOC, registration: false },
        new Map(),
      ),
    ).toBeNull();
    expect(
      clientSource(
        plan,
        { metadataDocument: DOC, registration: false },
        seeded,
      ),
    ).toMatchObject({ kind: "seeded" });
  });
});

describe("discoverUpstream, against Loops' shapes", () => {
  it("reads client_id_metadata_document_supported, and an absent registration endpoint", async () => {
    const answers: Record<string, { status: number; json?: unknown }> = {
      "https://mcp.loops.so/": { status: 401 },
      "https://mcp.loops.so/.well-known/oauth-protected-resource": {
        status: 200,
        json: {
          resource: "https://mcp.loops.so",
          authorization_servers: ["https://app.loops.so"],
          scopes_supported: ["mcp"],
        },
      },
      "https://app.loops.so/.well-known/oauth-authorization-server": {
        status: 200,
        json: {
          issuer: "https://app.loops.so",
          authorization_endpoint: "https://app.loops.so/oauth/authorize",
          token_endpoint: "https://app.loops.so/oauth/token",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          client_id_metadata_document_supported: true,
        },
      },
    };
    const f = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const a = answers[url];
      if (!a) return new Response("nope", { status: 404 });
      if (url === "https://mcp.loops.so/") {
        expect(init?.method).toBe("POST");
        return new Response("", {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer resource_metadata="https://mcp.loops.so/.well-known/oauth-protected-resource"',
          },
        });
      }
      return new Response(JSON.stringify(a.json), {
        status: a.status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const d = await discoverUpstream(
      { upstreamUrl: "https://mcp.loops.so/", scopes: null },
      f,
    );
    expect(d).toMatchObject({
      resource: "https://mcp.loops.so",
      issuer: "https://app.loops.so",
      authorizationEndpoint: "https://app.loops.so/oauth/authorize",
      tokenEndpoint: "https://app.loops.so/oauth/token",
      registrationEndpoint: null,
      clientIdMetadataDocumentSupported: true,
      scopes: ["mcp"],
    });
  });
});
