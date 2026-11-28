import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import {
  authorizationServerCandidates,
  beginUpstreamAuthorization,
  bearerChallenge,
  checkTokenEndpoint,
  clientSource,
  discoverUpstream,
  endpointAllowed,
  parseSuppliedDocument,
  protectedResourceCandidates,
  registerClient,
  resourceCovers,
  upstreamConnectorFor,
  upstreamPlan,
  upstreamWrites,
  UpstreamConnectError,
} from "../src/connectors/upstream.ts";
import { consoleView } from "../src/ui/roster-page.ts";

/**
 * The pieces of the `remote-http` Connect flow that do not need a server:
 * reading a challenge, the well-known paths, the resource rule, what a config
 * lets the flow write, and discovery's refusals against a scripted `fetch`.
 * test/connector.upstream.e2e.test.ts drives the whole thing over real sockets.
 */

const UP = "https://mcp.rippling.com/mcp";

function configOf(oauthRefresh: string, url = UP, extra = "") {
  return parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
servers:
  - slug: rippling
    kind: remote-http
    url: "${url}"
    entitlements: [admin]
    oauthRefresh:${oauthRefresh}
${extra}`);
}

const ALL_REFS = `
      tokenUrl: "\${RIPPLING_TOKEN_URL}"
      clientId: "\${RIPPLING_CLIENT_ID}"
      refreshToken: "\${RIPPLING_REFRESH_TOKEN}"`;

/** `clientSource` offers: registration only, and nothing at all. */
const REG = { metadataDocument: null, registration: true };
const NONE = { metadataDocument: null, registration: false };

/** A scripted fetch: url -> answer. Anything unlisted is a 404. */
function scripted(
  answers: Record<
    string,
    { status?: number; json?: unknown; headers?: Record<string, string> }
  >,
): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    const a = answers[url];
    if (!a) return new Response("nope", { status: 404 });
    return new Response(a.json === undefined ? "" : JSON.stringify(a.json), {
      status: a.status ?? 200,
      headers: { "content-type": "application/json", ...a.headers },
    });
  }) as typeof fetch & { calls: string[] };
  f.calls = calls;
  return f;
}

const PRM = "https://mcp.rippling.com/.well-known/oauth-protected-resource/mcp";
const AS = "https://auth.rippling.example";
const AS_META = `${AS}/.well-known/oauth-authorization-server`;

const challenge = {
  status: 401,
  headers: {
    "www-authenticate": `Bearer realm="OAuth", resource_metadata="${PRM}", error="invalid_token"`,
  },
};

const asMeta = (extra: Record<string, unknown> = {}) => ({
  json: {
    issuer: AS,
    authorization_endpoint: `${AS}/authorize`,
    token_endpoint: `${AS}/token`,
    registration_endpoint: `${AS}/register`,
    code_challenge_methods_supported: ["S256"],
    ...extra,
  },
});

describe("bearerChallenge", () => {
  it("reads Rippling's real 401 header", () => {
    expect(
      bearerChallenge(
        'Bearer realm="OAuth", resource_metadata="https://mcp.rippling.com/.well-known/oauth-protected-resource/mcp", error="invalid_token", error_description="Missing or invalid access token"',
      ),
    ).toEqual({ resourceMetadata: PRM, scope: null });
  });

  it("takes unquoted values and any case, and ignores a non-Bearer challenge", () => {
    expect(
      bearerChallenge(`bearer Resource_Metadata=${PRM}, scope="a b"`),
    ).toEqual({ resourceMetadata: PRM, scope: "a b" });
    expect(bearerChallenge(`Basic realm="x"`)).toEqual({
      resourceMetadata: null,
      scope: null,
    });
    expect(bearerChallenge(null).resourceMetadata).toBeNull();
  });
});

describe("well-known paths", () => {
  it("protected resource: path-suffixed, then root", () => {
    expect(protectedResourceCandidates(UP)).toEqual([
      PRM,
      "https://mcp.rippling.com/.well-known/oauth-protected-resource",
    ]);
    expect(protectedResourceCandidates("https://x.example/")).toEqual([
      "https://x.example/.well-known/oauth-protected-resource",
    ]);
  });

  it("authorization server: RFC 8414 then both OpenID Connect forms", () => {
    expect(authorizationServerCandidates("https://a.example/tenant/1")).toEqual(
      [
        "https://a.example/.well-known/oauth-authorization-server/tenant/1",
        "https://a.example/.well-known/openid-configuration/tenant/1",
        "https://a.example/tenant/1/.well-known/openid-configuration",
      ],
    );
    expect(authorizationServerCandidates("https://a.example")).toEqual([
      "https://a.example/.well-known/oauth-authorization-server",
      "https://a.example/.well-known/openid-configuration",
    ]);
  });
});

describe("resourceCovers", () => {
  it("same origin, at or above the upstream's path", () => {
    expect(resourceCovers(UP, UP)).toBe(true);
    expect(resourceCovers("https://mcp.rippling.com/", UP)).toBe(true);
    expect(resourceCovers("https://mcp.rippling.com/mcp/", UP)).toBe(true);
    expect(resourceCovers("https://mcp.rippling.com/other", UP)).toBe(false);
    expect(resourceCovers("https://evil.example/mcp", UP)).toBe(false);
    // A prefix of a SEGMENT is not a parent path.
    expect(resourceCovers("https://mcp.rippling.com/mc", UP)).toBe(false);
  });
});

describe("upstreamPlan: what the flow may write", () => {
  it("every ${NAME} is a write, and there is nothing in the way", () => {
    const entry = upstreamConnectorFor(configOf(ALL_REFS), "rippling")!;
    const plan = upstreamPlan(entry);
    expect(plan.problems).toEqual([]);
    expect(plan.tokenUrl).toEqual({
      mode: "write",
      variable: "RIPPLING_TOKEN_URL",
    });
    expect(plan.clientId).toEqual({
      mode: "write",
      variable: "RIPPLING_CLIENT_ID",
    });
    expect(plan.refreshVariable).toBe("RIPPLING_REFRESH_TOKEN");
    expect(plan.resource).toBeNull();
    expect(plan.scopes).toBeNull();
    expect(plan.clientSecretVariable).toBeNull();
  });

  it("a literal is the config's, and a ${NAME} inside a longer string is a problem", () => {
    const entry = upstreamConnectorFor(
      configOf(`
      tokenUrl: "https://\${HOST}/token"
      clientId: fixed-client
      refreshToken: "\${RT}"
      scope: "read offline_access"`),
      "rippling",
    )!;
    const plan = upstreamPlan(entry);
    expect(plan.clientId).toEqual({ mode: "literal", value: "fixed-client" });
    expect(plan.scopes).toEqual(["read", "offline_access"]);
    expect(plan.problems).toHaveLength(1);
    expect(plan.problems[0]).toContain("oauthRefresh.tokenUrl");
  });

  it("registration: is null unless declared, and only then may a declared secret be registered", () => {
    const secret = `${ALL_REFS}
      clientSecret: "\${RIPPLING_CLIENT_SECRET}"`;
    const without = upstreamPlan(
      upstreamConnectorFor(configOf(secret), "rippling")!,
    );
    expect(without.registration).toBeNull();
    expect(clientSource(without, REG, new Map())).toBeNull();
    expect(
      upstreamPlan(upstreamConnectorFor(configOf(ALL_REFS), "rippling")!)
        .registration,
    ).toBeNull();

    const withIt = upstreamPlan(
      upstreamConnectorFor(
        configOf(`${secret}
      registration:
        clientName: Claude Code (strad)`),
        "rippling",
      )!,
    );
    expect(withIt.problems).toEqual([]);
    expect(withIt.registration).toEqual({ clientName: "Claude Code (strad)" });
    expect(clientSource(withIt, REG, new Map())).toEqual({ kind: "register" });
    // No registration endpoint: still the seeded client, as without it.
    expect(clientSource(withIt, NONE, new Map())).toBeNull();
  });

  it("registration: with a literal clientId is a problem, and a ${NAME} clientName does not parse", () => {
    const plan = upstreamPlan(
      upstreamConnectorFor(
        configOf(`
      tokenUrl: "\${RIPPLING_TOKEN_URL}"
      clientId: fixed-client
      refreshToken: "\${RIPPLING_REFRESH_TOKEN}"
      registration:
        clientName: Claude Code (strad)`),
        "rippling",
      )!,
    );
    expect(plan.problems[0]).toContain("oauthRefresh.registration is set");
    expect(() =>
      configOf(`${ALL_REFS}
      registration:
        clientName: "\${NAME}"`),
    ).toThrow(/clientName must be a literal/);
  });

  it("a url carrying a ${NAME} cannot be discovered from", () => {
    const entry = upstreamConnectorFor(
      configOf(ALL_REFS, "https://mcp.rippling.com/${RIPPLING_PATH}"),
      "rippling",
    )!;
    expect(upstreamPlan(entry).problems[0]).toContain("url: is a ${NAME}");
  });

  it("only an enabled remote-http with oauthRefresh: is a connector, and the roster links it to its page", () => {
    const config = configOf(ALL_REFS);
    expect(upstreamConnectorFor(config, "rippling")).not.toBeNull();
    expect(consoleView(config, config.servers[0]!)).toBe("connector");
    const disabled = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
servers:
  - slug: rippling
    kind: remote-http
    enabled: false
    url: "${UP}"
    entitlements: [admin]
    oauthRefresh:${ALL_REFS}
  - slug: plain
    kind: remote-http
    url: "${UP}"
    entitlements: [admin]
`);
    expect(upstreamConnectorFor(disabled, "rippling")).toBeNull();
    expect(upstreamConnectorFor(disabled, "plain")).toBeNull();
  });
});

describe("discoverUpstream", () => {
  it("follows the challenge to the metadata and adds offline_access when the server knows it", async () => {
    const f = scripted({
      [UP]: challenge,
      [PRM]: {
        json: {
          resource: UP,
          authorization_servers: [AS],
          scopes_supported: ["read"],
        },
      },
      [AS_META]: asMeta({ scopes_supported: ["read", "offline_access"] }),
    });
    const d = await discoverUpstream({ upstreamUrl: UP, scopes: null }, f);
    expect(d).toEqual({
      resourceMetadataUrl: PRM,
      resource: UP,
      issuer: AS,
      authorizationEndpoint: `${AS}/authorize`,
      tokenEndpoint: `${AS}/token`,
      registrationEndpoint: `${AS}/register`,
      clientIdMetadataDocumentSupported: false,
      scopes: ["read", "offline_access"],
    });
  });

  it("a configured scope is the whole answer", async () => {
    const f = scripted({
      [UP]: challenge,
      [PRM]: { json: { resource: UP, authorization_servers: [AS] } },
      [AS_META]: asMeta({ scopes_supported: ["offline_access"] }),
    });
    const d = await discoverUpstream({ upstreamUrl: UP, scopes: ["x"] }, f);
    expect(d.scopes).toEqual(["x"]);
  });

  it("a 403 on the metadata — Rippling from a DigitalOcean address — is metadata_blocked, with the URL and the reason", async () => {
    const f = scripted({
      [UP]: challenge,
      [PRM]: { status: 403 },
    });
    const err = await discoverUpstream({ upstreamUrl: UP, scopes: null }, f)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamConnectError);
    expect((err as UpstreamConnectError).code).toBe("metadata_blocked");
    expect((err as UpstreamConnectError).status).toBe(403);
    expect((err as Error).message).toContain(`${PRM} answered HTTP 403`);
    expect((err as Error).message).toContain("firewall");
  });

  it("a 403 names the document and the URL a human can open instead", async () => {
    const prmBlocked = await discoverUpstream(
      { upstreamUrl: UP, scopes: null },
      scripted({ [UP]: challenge, [PRM]: { status: 403 } }),
    ).catch((e: UpstreamConnectError) => e);
    expect(prmBlocked).toMatchObject({
      blocked: { document: "resource", url: PRM },
    });
    expect((prmBlocked as Error).message).toContain("paste the JSON");

    const asBlocked = await discoverUpstream(
      { upstreamUrl: UP, scopes: null },
      scripted({
        [UP]: challenge,
        [PRM]: { json: { resource: UP, authorization_servers: [AS] } },
        [AS_META]: { status: 403 },
      }),
    ).catch((e: UpstreamConnectError) => e);
    expect(asBlocked).toMatchObject({
      code: "metadata_blocked",
      blocked: { document: "authorization_server", url: AS_META },
    });
  });

  it("a supplied document is read in place of the fetch, and checked the same way", async () => {
    const f = scripted({ [UP]: challenge, [AS_META]: asMeta() });
    const d = await discoverUpstream(
      {
        upstreamUrl: UP,
        scopes: null,
        supplied: {
          resource: { resource: UP, authorization_servers: [AS] },
        },
      },
      f,
    );
    expect(f.calls).not.toContain(PRM);
    expect(d.resourceMetadataUrl).toBe(PRM);
    expect(d.tokenEndpoint).toBe(`${AS}/token`);

    // Both supplied: only the MCP probe goes out.
    const g = scripted({ [UP]: challenge });
    const both = await discoverUpstream(
      {
        upstreamUrl: UP,
        scopes: null,
        supplied: {
          resource: { resource: UP, authorization_servers: [AS] },
          authorizationServer: asMeta().json,
        },
      },
      g,
    );
    expect(g.calls).toEqual([UP]);
    expect(both.registrationEndpoint).toBe(`${AS}/register`);

    await expect(
      discoverUpstream(
        {
          upstreamUrl: UP,
          scopes: null,
          supplied: {
            resource: {
              resource: "https://other.example/mcp",
              authorization_servers: [AS],
            },
          },
        },
        scripted({ [UP]: challenge }),
      ),
    ).rejects.toMatchObject({ code: "resource_mismatch" });
    await expect(
      discoverUpstream(
        {
          upstreamUrl: UP,
          scopes: null,
          supplied: {
            resource: { resource: UP, authorization_servers: [AS] },
            authorizationServer: asMeta({ issuer: "https://x.example" }).json,
          },
        },
        scripted({ [UP]: challenge }),
      ),
    ).rejects.toMatchObject({ code: "issuer_mismatch" });

    // A pasted document must carry what a fetched one may omit.
    await expect(
      discoverUpstream(
        {
          upstreamUrl: UP,
          scopes: null,
          supplied: { resource: { authorization_servers: [AS] } },
        },
        scripted({ [UP]: challenge }),
      ),
    ).rejects.toMatchObject({ code: "metadata_invalid" });
    const { issuer: _dropped, ...noIssuer } = asMeta().json;
    await expect(
      discoverUpstream(
        {
          upstreamUrl: UP,
          scopes: null,
          supplied: {
            resource: { resource: UP, authorization_servers: [AS] },
            authorizationServer: noIssuer,
          },
        },
        scripted({ [UP]: challenge }),
      ),
    ).rejects.toThrow(/names no issuer/);
  });

  it("an HTML 200 at the RFC 8414 path is a single-page app, not metadata: the OpenID path is tried next", async () => {
    const calls: string[] = [];
    const f = (async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url === UP) {
        return new Response("", { status: 401, headers: challenge.headers });
      }
      if (url === PRM) {
        return Response.json({ resource: UP, authorization_servers: [AS] });
      }
      if (url === AS_META) {
        return new Response("<!doctype html><html></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (url === `${AS}/.well-known/openid-configuration`) {
        return Response.json(asMeta().json);
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const d = await discoverUpstream({ upstreamUrl: UP, scopes: null }, f);
    expect(d.authorizationEndpoint).toBe(`${AS}/authorize`);
    expect(calls).toContain(`${AS}/.well-known/openid-configuration`);
  });

  it("refuses metadata that describes a different resource", async () => {
    const f = scripted({
      [UP]: challenge,
      [PRM]: {
        json: {
          resource: "https://other.example/mcp",
          authorization_servers: [AS],
        },
      },
    });
    await expect(
      discoverUpstream({ upstreamUrl: UP, scopes: null }, f),
    ).rejects.toMatchObject({ code: "resource_mismatch" });
  });

  it("refuses an issuer mismatch, a server without S256, and a plain-http endpoint", async () => {
    const base = {
      [UP]: challenge,
      [PRM]: { json: { authorization_servers: [AS] } },
    };
    await expect(
      discoverUpstream(
        { upstreamUrl: UP, scopes: null },
        scripted({
          ...base,
          [AS_META]: asMeta({ issuer: "https://x.example" }),
        }),
      ),
    ).rejects.toMatchObject({ code: "issuer_mismatch" });
    await expect(
      discoverUpstream(
        { upstreamUrl: UP, scopes: null },
        scripted({
          ...base,
          [AS_META]: asMeta({ code_challenge_methods_supported: ["plain"] }),
        }),
      ),
    ).rejects.toMatchObject({ code: "pkce_unsupported" });
    await expect(
      discoverUpstream(
        { upstreamUrl: UP, scopes: null },
        scripted({
          ...base,
          [AS_META]: asMeta({ token_endpoint: "http://auth.example/token" }),
        }),
      ),
    ).rejects.toMatchObject({ code: "insecure_endpoint" });
  });

  it("with no protected-resource metadata at all, falls back to the upstream's origin as issuer", async () => {
    const f = scripted({
      [UP]: { status: 401 },
      "https://mcp.rippling.com/.well-known/oauth-authorization-server": {
        json: {
          issuer: "https://mcp.rippling.com",
          authorization_endpoint: "https://mcp.rippling.com/authorize",
          token_endpoint: "https://mcp.rippling.com/token",
        },
      },
    });
    const d = await discoverUpstream({ upstreamUrl: UP, scopes: null }, f);
    expect(d.issuer).toBe("https://mcp.rippling.com");
    expect(d.resourceMetadataUrl).toBeNull();
    expect(d.registrationEndpoint).toBeNull();
    expect(d.resource).toBe(UP);
  });

  it("an upstream that asks for nothing and publishes nothing has no server to connect to", async () => {
    const f = scripted({ [UP]: { status: 200, json: {} } });
    await expect(
      discoverUpstream({ upstreamUrl: UP, scopes: null }, f),
    ).rejects.toMatchObject({ code: "metadata_unavailable" });
  });
});

describe("registerClient", () => {
  const input = {
    registrationEndpoint: `${AS}/register`,
    redirectUri: "https://strad.example/ui/oauth/callback",
    clientName: "strad (test) rippling",
    scopes: [],
  };

  it("returns the client id of a public client", async () => {
    const f = scripted({
      [`${AS}/register`]: {
        status: 201,
        json: { client_id: "c1", token_endpoint_auth_method: "none" },
      },
    });
    expect(await registerClient(input, f)).toEqual({ clientId: "c1" });
  });

  it("confidential: asks for client_secret_<clientAuth> and returns the issued secret, whatever method is echoed", async () => {
    const f = scripted({
      [`${AS}/register`]: {
        status: 201,
        // Figma's answer: `none` echoed back, a secret issued regardless.
        json: {
          client_id: "c2",
          client_secret: "issued",
          token_endpoint_auth_method: "none",
        },
      },
    });
    const sent: Record<string, unknown>[] = [];
    const spy: typeof fetch = async (url, init) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return f(url, init);
    };
    expect(
      await registerClient(
        {
          ...input,
          clientName: "Claude Code (strad)",
          confidential: { clientAuth: "post" },
        },
        spy,
      ),
    ).toEqual({ clientId: "c2", clientSecret: "issued" });
    expect(sent[0]).toMatchObject({
      client_name: "Claude Code (strad)",
      token_endpoint_auth_method: "client_secret_post",
    });
  });

  it("confidential: a registration that issues no secret is refused", async () => {
    await expect(
      registerClient(
        { ...input, confidential: { clientAuth: "basic" } },
        scripted({
          [`${AS}/register`]: { status: 201, json: { client_id: "c3" } },
        }),
      ),
    ).rejects.toMatchObject({ code: "registration_failed" });
  });

  it("refuses a confidential answer and a refusal, without quoting either body", async () => {
    await expect(
      registerClient(
        input,
        scripted({
          [`${AS}/register`]: {
            json: { client_id: "c1", client_secret: "SECRET-CANARY" },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "registration_confidential" });
    const refused = await registerClient(
      input,
      scripted({
        [`${AS}/register`]: {
          status: 403,
          json: { error_description: "UPSTREAM-TEXT-CANARY" },
        },
      }),
    ).catch((e: Error) => e);
    expect(refused).toMatchObject({ code: "registration_failed", status: 403 });
    expect((refused as Error).message).not.toContain("UPSTREAM-TEXT-CANARY");
  });
});

describe("endpointAllowed", () => {
  it("https always; loopback http only when the configured upstream is loopback", () => {
    expect(endpointAllowed(UP, "https://auth.example/x")).toBe(true);
    expect(endpointAllowed(UP, "http://127.0.0.1:8080/admin")).toBe(false);
    expect(endpointAllowed(UP, "http://auth.example/x")).toBe(false);
    expect(
      endpointAllowed("http://127.0.0.1:9/mcp", "http://127.0.0.1:9/token"),
    ).toBe(true);
    expect(
      endpointAllowed("http://127.0.0.1:9/mcp", "http://auth.example/token"),
    ).toBe(false);
  });

  it("refuses an https upstream's metadata that points core at its own loopback", async () => {
    const f = scripted({
      [UP]: {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="http://127.0.0.1:8080/internal"`,
        },
      },
    });
    await expect(
      discoverUpstream({ upstreamUrl: UP, scopes: null }, f),
    ).rejects.toMatchObject({ code: "insecure_endpoint" });
    expect(f.calls).toEqual([UP]);
  });
});

describe("bearerChallenge, adversarially", () => {
  it("does not read a scope= inside a quoted value", () => {
    expect(
      bearerChallenge(
        `Bearer resource_metadata="https://x.example/prm?scope=admin", error="invalid_token"`,
      ),
    ).toEqual({
      resourceMetadata: "https://x.example/prm?scope=admin",
      scope: null,
    });
  });
});

describe("beginUpstreamAuthorization", () => {
  const discovery = {
    resourceMetadataUrl: null,
    resource: "https://up.example/mcp",
    issuer: "https://as.example",
    authorizationEndpoint: "https://as.example/authorize",
    tokenEndpoint: "https://as.example/token",
    registrationEndpoint: null,
    clientIdMetadataDocumentSupported: false,
    scopes: ["read"],
  };
  const begin = (authorizeParams?: Record<string, string>) =>
    new URL(
      beginUpstreamAuthorization({
        discovery,
        clientId: "cid",
        redirectUri: "https://strad.example/ui/oauth/callback",
        ...(authorizeParams ? { authorizeParams } : {}),
      }).url,
    ).searchParams;

  it("without authorizeParams, sends exactly strad's own parameters", () => {
    expect([...begin().keys()].sort()).toEqual([
      "client_id",
      "code_challenge",
      "code_challenge_method",
      "redirect_uri",
      "resource",
      "response_type",
      "scope",
      "state",
    ]);
  });

  it("adds the configured parameters", () => {
    const q = begin({ access_type: "offline", prompt: "consent" });
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent");
    expect(q.get("resource")).toBe("https://up.example/mcp");
  });

  it("drops any other key even past the schema", () => {
    const others = [
      "client_id",
      "client_secret",
      "redirect_uri",
      "response_type",
      "scope",
      "state",
      "code_challenge",
      "code_challenge_method",
      "resource",
      "audience",
      "request",
      "request_uri",
      "response_mode",
      "include_granted_scopes",
      "SCOPE",
      " state ",
      "redirect.uri",
    ];
    const q = begin(Object.fromEntries(others.map((k) => [k, "evil"])));
    expect([...q.values()]).not.toContain("evil");
    expect([...q.keys()].sort()).toEqual([...begin().keys()].sort());
  });
});

describe("upstreamWrites", () => {
  it("writes the refresh token LAST, and only the ${NAME} fields", () => {
    const config = configOf(`
      tokenUrl: "\${RIPPLING_TOKEN_URL}"
      clientId: literal-client
      refreshToken: "\${RIPPLING_REFRESH_TOKEN}"
      resource: "\${RIPPLING_RESOURCE}"`);
    const entry = upstreamConnectorFor(config, "rippling")!;
    const writes = upstreamWrites(
      config,
      entry,
      upstreamPlan(entry),
      {
        clientId: "literal-client",
        registered: false,
        tokenUrl: "https://a/token",
        resource: UP,
        issuer: "https://a",
      },
      "rt",
    );
    expect(writes.map((w) => [w.variable, w.secret])).toEqual([
      ["RIPPLING_TOKEN_URL", false],
      ["RIPPLING_RESOURCE", false],
      ["RIPPLING_REFRESH_TOKEN", true],
    ]);
    expect(
      writes.every((w) => w.path.startsWith("/strad/test/mcp/rippling/oauth/")),
    ).toBe(true);
  });
});

describe("parseSuppliedDocument", () => {
  it("empty is not supplied; a JSON object is; anything else is refused unquoted", () => {
    expect(parseSuppliedDocument("", "resource")).toBeUndefined();
    expect(parseSuppliedDocument("  \n", "resource")).toBeUndefined();
    expect(parseSuppliedDocument(undefined, "resource")).toBeUndefined();
    expect(parseSuppliedDocument(' {"a": 1} ', "resource")).toEqual({ a: 1 });
    for (const bad of ["[1]", "null", "42", "<html>CANARY</html>"]) {
      let err: unknown;
      try {
        parseSuppliedDocument(bad, "authorization_server");
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({ code: "metadata_invalid" });
      expect((err as Error).message).toContain("authorization server metadata");
      expect((err as Error).message).not.toContain("CANARY");
    }
  });
});

describe("checkTokenEndpoint", () => {
  const answer = (
    status: number,
    type: string,
    extra: Record<string, string> = {},
  ) =>
    (async () =>
      new Response("x", {
        status,
        headers: { "content-type": type, ...extra },
      })) as unknown as typeof fetch;

  it("a 403 page is a firewall; an OAuth server's answer to a bare GET is not", async () => {
    // What the two real hosts answer a DigitalOcean address: Cloudflare's
    // block page on mcp.rippling.com, a 405 from app.rippling.com's endpoint.
    await expect(
      checkTokenEndpoint(
        "https://mcp.rippling.com/token",
        answer(403, "text/html; charset=UTF-8", {
          server: "cloudflare",
          "cf-ray": "a466dc386bf85e4b-EWR",
        }),
      ),
    ).rejects.toMatchObject({ code: "token_endpoint_blocked", status: 403 });
    await expect(
      checkTokenEndpoint(
        "https://x.example/token",
        answer(403, "text/html", { server: "AkamaiGHost" }),
      ),
    ).rejects.toMatchObject({ code: "token_endpoint_blocked" });
    // A 403 page nobody signed is what an ordinary server sends a GET on a
    // POST-only path: it passes, and the exchange is where a real refusal shows.
    await expect(
      checkTokenEndpoint(
        "https://x.example/token",
        answer(403, "text/html", { server: "nginx" }),
      ),
    ).resolves.toBeUndefined();
    for (const [status, type] of [
      [405, "text/html; charset=utf-8"],
      [400, "application/json"],
      [403, "application/json"],
      [404, "text/html"],
    ] as const) {
      await expect(
        checkTokenEndpoint(
          "https://app.rippling.com/api/o/token/",
          answer(status, type),
        ),
      ).resolves.toBeUndefined();
    }
  });

  it("a connection that fails is upstream_unreachable", async () => {
    const f = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(
      checkTokenEndpoint("https://auth.example/token", f),
    ).rejects.toMatchObject({ code: "upstream_unreachable" });
  });
});
