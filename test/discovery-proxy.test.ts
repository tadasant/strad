import { describe, expect, it } from "vitest";
import {
  BRIGHTDATA_REQUEST_URL,
  brightDataFetch,
  proxiedOn403,
} from "../src/connectors/discovery-proxy.ts";
import { parseConfig } from "../src/config/load.ts";

/**
 * `oauthRefresh.discoveryProxy:` at the unit level: the Web Unlocker envelope
 * unwrapped into the target's own answer, the GET-only rule, the proxy's own
 * refusals in strad's words, and the direct-first order. The e2e suite
 * (test/connector.upstream.e2e.test.ts) drives it through a whole Connect.
 */

const TARGET =
  "https://mcp.rippling.com/.well-known/oauth-protected-resource/mcp";

function bd(answer: () => Response) {
  const sent: { url: string; init: RequestInit }[] = [];
  const f = (async (input: unknown, init?: RequestInit) => {
    sent.push({ url: String(input), init: init ?? {} });
    return answer();
  }) as typeof fetch;
  return { f, sent };
}

const key = async () => "bd-key";

describe("brightDataFetch", () => {
  it("asks the request API for the target as a JSON envelope, and answers with the target's own status and body", async () => {
    const api = bd(() =>
      Response.json({
        status_code: 200,
        headers: { "content-type": "application/json" },
        body: '{"authorization_servers":["https://app.rippling.com"]}',
      }),
    );
    const proxied = brightDataFetch(
      { apiKey: key, zone: "mcp_server_unlocker" },
      api.f,
    );
    const res = await proxied(TARGET, {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      authorization_servers: ["https://app.rippling.com"],
    });
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]!.url).toBe(BRIGHTDATA_REQUEST_URL);
    expect(api.sent[0]!.init.method).toBe("POST");
    expect(new Headers(api.sent[0]!.init.headers).get("authorization")).toBe(
      "Bearer bd-key",
    );
    expect(JSON.parse(String(api.sent[0]!.init.body))).toEqual({
      zone: "mcp_server_unlocker",
      url: TARGET,
      format: "json",
    });

    const notFound = brightDataFetch(
      { apiKey: key, zone: "z" },
      bd(() => Response.json({ status_code: 404, body: "nope" })).f,
    );
    expect((await notFound(TARGET)).status).toBe(404);

    // Statuses the Fetch API cannot carry a body for, or at all, still answer.
    for (const [given, seen] of [
      [205, 205],
      [304, 304],
      [101, 502],
      [700, 502],
    ] as const) {
      const p = brightDataFetch(
        { apiKey: key, zone: "z" },
        bd(() => Response.json({ status_code: given, body: "x" })).f,
      );
      expect((await p(TARGET)).status).toBe(seen);
    }
    const fractional = brightDataFetch(
      { apiKey: key, zone: "z" },
      bd(() => Response.json({ status_code: 200.5, body: "{}" })).f,
    );
    await expect(fractional(TARGET)).rejects.toMatchObject({
      code: "proxy_failed",
    });
  });

  it("refuses anything but a GET, before the proxy is asked", async () => {
    const api = bd(() => Response.json({ status_code: 200, body: "{}" }));
    const proxied = brightDataFetch({ apiKey: key, zone: "z" }, api.f);
    await expect(
      proxied("https://app.rippling.com/api/o/token/", {
        method: "POST",
        body: "code=SECRET",
      }),
    ).rejects.toThrow(/only a metadata GET/);
    expect(api.sent).toHaveLength(0);
  });

  it("the proxy's own refusal, and an envelope without a status, are proxy_failed, unquoted", async () => {
    const refused = brightDataFetch(
      { apiKey: key, zone: "z" },
      bd(
        () =>
          new Response("BD-ERROR-TEXT zone not found", {
            status: 401,
          }),
      ).f,
    );
    const err = await refused(TARGET).catch((e: Error) => e);
    expect(err).toMatchObject({ code: "proxy_failed", status: 401 });
    expect((err as Error).message).not.toContain("BD-ERROR-TEXT");

    const bare = brightDataFetch(
      { apiKey: key, zone: "z" },
      bd(() => Response.json({ body: "{}" })).f,
    );
    await expect(bare(TARGET)).rejects.toMatchObject({ code: "proxy_failed" });
  });
});

describe("proxiedOn403", () => {
  it("goes through the proxy only for a 403, and reads the key only then", async () => {
    let keyReads = 0;
    const api = bd(() => Response.json({ status_code: 200, body: "{}" }));
    const proxied = brightDataFetch(
      {
        apiKey: async () => {
          keyReads += 1;
          return "k";
        },
        zone: "z",
      },
      api.f,
    );
    const direct = (status: number) =>
      (async () => new Response("", { status })) as unknown as typeof fetch;

    expect((await proxiedOn403(direct(200), proxied)(TARGET)).status).toBe(200);
    expect((await proxiedOn403(direct(404), proxied)(TARGET)).status).toBe(404);
    expect(api.sent).toHaveLength(0);
    expect(keyReads).toBe(0);

    expect((await proxiedOn403(direct(403), proxied)(TARGET)).status).toBe(200);
    expect(api.sent).toHaveLength(1);
    expect(keyReads).toBe(1);
  });
});

describe("the schema", () => {
  const cfg = (proxy: string) => `
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
servers:
  - slug: rippling
    kind: remote-http
    url: https://mcp.rippling.com/mcp
    entitlements: [admin]
    oauthRefresh:
      tokenUrl: "\${RIPPLING_TOKEN_URL}"
      clientId: "\${RIPPLING_CLIENT_ID}"
      refreshToken: "\${RIPPLING_REFRESH_TOKEN}"
      discoveryProxy:${proxy}
`;

  it("defaults strad-fetch's zone, and refuses an apiKeyFrom that names no server", () => {
    const ok = parseConfig(cfg(`\n        via: brightdata`));
    const server = ok.servers[0]!;
    expect(
      server.kind === "remote-http" && server.oauthRefresh?.discoveryProxy,
    ).toEqual({ via: "brightdata", zone: "mcp_server_unlocker" });
    expect(() =>
      parseConfig(
        cfg(`\n        via: brightdata\n        apiKeyFrom: strad-fetch`),
      ),
    ).toThrow(/apiKeyFrom to "strad-fetch", which is not a configured server/);
  });
});
