import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import {
  authorizationServerCandidates,
  bearerChallenge,
  discoverUpstream,
  protectedResourceCandidates,
  registerPublicClient,
  resourceCovers,
  upstreamConnectorFor,
  upstreamPlan,
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

describe("registerPublicClient", () => {
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
    expect(await registerPublicClient(input, f)).toBe("c1");
  });

  it("refuses a confidential answer and a refusal, without quoting either body", async () => {
    await expect(
      registerPublicClient(
        input,
        scripted({
          [`${AS}/register`]: {
            json: { client_id: "c1", client_secret: "SECRET-CANARY" },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "registration_confidential" });
    const refused = await registerPublicClient(
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
