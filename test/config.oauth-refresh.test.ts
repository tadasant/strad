import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { unknownConfigKeys } from "../src/config/strict.ts";
import { collectSecretRefs } from "../src/deploy/appspec.ts";
import { runtimeRefsBySlug } from "../src/deploy/server-namespaces.ts";
import { referencesBySlug, unusedWaivers } from "../src/deploy/unseeded.ts";
import { collectRequirements } from "../src/ui/secret-status.ts";

/**
 * `oauthRefresh:` on a `remote-http` server — what the schema accepts, what it
 * refuses, and that every ref-walker sees the block's `${NAME}`s. A walker that
 * missed them would let a deploy through without the refresh token, or leave
 * it off the console's roster.
 */

function config(servers: string): string {
  return `
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
servers:${servers}
`;
}

const GRANOLA = `
  - slug: granola
    kind: remote-http
    url: https://mcp.granola.ai/mcp
    entitlements: [admin]
    oauthRefresh:
      tokenUrl: https://mcp-auth.granola.ai/oauth2/token
      clientId: \${GRANOLA_CLIENT_ID}
      clientSecret: \${GRANOLA_CLIENT_SECRET}
      refreshToken: \${GRANOLA_REFRESH_TOKEN}
      scope: "\${GRANOLA_SCOPE}"
      resource: https://mcp.granola.ai/mcp`;

function refusal(yaml: string): string {
  try {
    parseConfig(yaml);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected the config to be refused");
}

describe("oauthRefresh: parses", () => {
  it("accepts the full block and defaults clientAuth to basic", () => {
    const parsed = parseConfig(config(GRANOLA));
    const server = parsed.servers[0]!;
    expect(server.kind).toBe("remote-http");
    if (server.kind !== "remote-http") return;
    expect(server.oauthRefresh).toMatchObject({
      clientAuth: "basic",
      refreshToken: "${GRANOLA_REFRESH_TOKEN}",
    });
    expect(unknownConfigKeys(config(GRANOLA), parsed)).toEqual([]);
  });

  it("accepts a public client, a tokenUrl from the store, and http to loopback", () => {
    expect(() =>
      parseConfig(
        config(`
  - slug: a
    kind: remote-http
    url: https://a.example/mcp
    oauthRefresh:
      tokenUrl: \${A_TOKEN_URL}
      clientId: a-client
      refreshToken: \${A_RT}
  - slug: b
    kind: remote-http
    url: https://b.example/mcp
    oauthRefresh:
      tokenUrl: http://127.0.0.1:9999/token
      clientId: b-client
      clientAuth: post
      refreshToken: \${B_RT}`),
      ),
    ).not.toThrow();
  });
});

describe("oauthRefresh.authorizeParams:", () => {
  const withParams = (params: string): string =>
    config(`
  - slug: g
    kind: remote-http
    url: https://g.example/mcp
    oauthRefresh:
      tokenUrl: https://g.example/token
      clientId: \${G_CLIENT_ID}
      refreshToken: \${G_RT}
      authorizeParams: ${params}`);

  it("parses, is a known key to the deploy gate, and is absent unless declared", () => {
    const yaml = withParams("{ access_type: offline, prompt: consent }");
    const parsed = parseConfig(yaml);
    const server = parsed.servers[0]!;
    if (server.kind !== "remote-http") throw new Error("kind");
    expect(server.oauthRefresh?.authorizeParams).toEqual({
      access_type: "offline",
      prompt: "consent",
    });
    expect(unknownConfigKeys(yaml, parsed)).toEqual([]);

    // No default: the block is one of the terms a Connect transaction binds,
    // and a slug that does not declare this keeps the terms it had.
    const bare = parseConfig(config(GRANOLA)).servers[0]!;
    if (bare.kind !== "remote-http") throw new Error("kind");
    expect(bare.oauthRefresh).not.toHaveProperty("authorizeParams");
  });

  it.each([
    "client_id",
    "redirect_uri",
    "response_type",
    "scope",
    "state",
    "code_challenge",
    "code_challenge_method",
    "resource",
    "request",
    "request_uri",
    "response_mode",
    "authorization_details",
    "include_granted_scopes",
    "Redirect_URI",
  ])("refuses %s", (key) => {
    expect(refusal(withParams(`{ ${key}: x }`))).toContain(
      `oauthRefresh.authorizeParams.${key}, which is not a config's to set`,
    );
  });

  it("refuses a padded or blank key, and a value from a ${NAME}", () => {
    expect(refusal(withParams(`{ " scope": x }`))).toMatch(/blank or padded/);
    expect(refusal(withParams(`{ "": x }`))).toMatch(/blank or padded/);
    expect(refusal(withParams('{ login_hint: "${G_LOGIN}" }'))).toMatch(
      /must be a literal and never a secret/,
    );
  });
});

describe("oauthRefresh: refuses", () => {
  const one = (block: string, headers = "") =>
    config(`
  - slug: granola
    kind: remote-http
    url: https://mcp.granola.ai/mcp${headers}
    oauthRefresh:${block}`);

  it("a literal refresh token", () => {
    expect(
      refusal(
        one(`
      tokenUrl: https://auth.example/token
      clientId: c
      refreshToken: rt-a-literal-credential`),
      ),
    ).toMatch(/refreshToken to something other than exactly one \$\{NAME\}/);
  });

  it("a refresh token with anything around the reference", () => {
    expect(
      refusal(
        one(`
      tokenUrl: https://auth.example/token
      clientId: c
      refreshToken: "Bearer \${RT}"`),
      ),
    ).toMatch(/exactly one \$\{NAME\}/);
  });

  it("a literal client secret", () => {
    expect(
      refusal(
        one(`
      tokenUrl: https://auth.example/token
      clientId: c
      clientSecret: hunter2
      refreshToken: \${RT}`),
      ),
    ).toMatch(/clientSecret to something other than exactly one/);
  });

  it("an Authorization header beside it, in any spelling", () => {
    expect(
      refusal(
        one(
          `
      tokenUrl: https://auth.example/token
      clientId: c
      refreshToken: \${RT}`,
          `
    headers:
      authorization: "Bearer \${STATIC}"`,
        ),
      ),
    ).toMatch(/both oauthRefresh: and an Authorization header/);
  });

  it("a plain-http token endpoint that is not loopback", () => {
    expect(
      refusal(
        one(`
      tokenUrl: http://auth.example/token
      clientId: c
      refreshToken: \${RT}`),
      ),
    ).toMatch(/must be an https URL/);
  });

  it("two enabled servers minting from one refresh token, but not a disabled one", () => {
    const pair = (enabled: boolean) =>
      config(`
  - slug: a
    kind: remote-http
    url: https://a.example/mcp
    oauthRefresh: { tokenUrl: "https://t.example/t", clientId: c, refreshToken: "\${SHARED_RT}" }
  - slug: b
    kind: remote-http
    url: https://b.example/mcp
    enabled: ${enabled}
    oauthRefresh: { tokenUrl: "https://t.example/t", clientId: c, refreshToken: "\${SHARED_RT}" }`);
    expect(refusal(pair(true))).toMatch(
      /server "b" and server "a" both mint from \$\{SHARED_RT\}/,
    );
    expect(() => parseConfig(pair(false))).not.toThrow();
  });

  it("on a local-tunnel: the deploy gate names it as a key the kind does not have", () => {
    const yaml = config(`
  - slug: anki
    kind: local-tunnel
    url: https://anki.example.com/
    oauthRefresh: { tokenUrl: "https://t.example/t", clientId: c, refreshToken: "\${RT}" }`);
    const parsed = parseConfig(yaml);
    expect(
      unknownConfigKeys(yaml, parsed).map((u) => `${u.path}.${u.key}`),
    ).toEqual(["servers[0].oauthRefresh"]);
  });
});

describe("every ref-walker sees the block", () => {
  const parsed = parseConfig(config(GRANOLA));
  const names = [
    "GRANOLA_CLIENT_ID",
    "GRANOLA_CLIENT_SECRET",
    "GRANOLA_REFRESH_TOKEN",
    "GRANOLA_SCOPE",
  ];

  it("the unseeded gate, the per-server namespace layer, and the render walk", () => {
    expect([...referencesBySlug(parsed).get("granola")!].sort()).toEqual(names);
    expect([...runtimeRefsBySlug(parsed).get("granola")!].sort()).toEqual(
      names,
    );
    expect(collectSecretRefs(parsed).sort()).toEqual(names);
  });

  it("the console roster, as gateway-resolved requirements", () => {
    const required = collectRequirements(parsed).filter((r) =>
      r.name.startsWith("GRANOLA_"),
    );
    expect(required.map((r) => r.name).sort()).toEqual(names);
    for (const r of required) expect(r.deliveries).toEqual(["gateway"]);
  });

  it("mayBeUnseeded may defer the refresh token a human has not authorized yet", () => {
    const deferred = parseConfig(
      config(`${GRANOLA}
    mayBeUnseeded: [GRANOLA_REFRESH_TOKEN]`),
    );
    expect(unusedWaivers(deferred)).toEqual([]);
  });
});
