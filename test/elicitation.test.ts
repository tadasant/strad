/**
 * The caller's confirmation channel: read, held to the allowlist, forwarded.
 *
 * End to end through the real `/mcp` app: a caller's `X-Elicitation-Url`
 * reaches a `supplementary-image` upstream as core's own `_meta`, and only
 * there. A third party's `remote-http` server never sees it, a client cannot
 * forge the key by sending `_meta` of its own, and a URL off the allowlist
 * arrives as a refusal with its reason rather than vanishing.
 *
 * And the call itself, for a confirmed slug: the slug's `confirmationHeaders:`
 * ride with the channel, a caller that goes away (or a hop that runs out of
 * time) tears the upstream request down so the bundle never sends into the
 * void, and the bundle's keepalives reach a caller that asked for progress.
 *
 * A slug that declares `skipConfirmations: true` gets core's waiver on every
 * call instead, and never the caller's URL.
 *
 * The bundle half — the confirmed tool refusing without a channel, and asking
 * at the forwarded URL with one — is `images/bundle-google/test/confirm.test.ts`.
 */
import { createServer, type Server as HttpServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { mintToken } from "../src/auth/tokens.ts";
import { parseConfig } from "../src/config/load.ts";
import {
  ELICITATION_META_KEY,
  confirmationTtlMs,
  elicitationChannelFrom,
} from "../src/gateway/elicitation.ts";
import { bundleUrlEnvName, Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";

const ZIMMER = "https://zimmer.example.com";
const PREFIX = `${ZIMMER}/api/v1/elicitations/session/`;
const SESSION_URL = `${PREFIX}42-abc`;

describe("elicitationChannelFrom", () => {
  const allowed = [PREFIX];

  it("no header is no channel", () => {
    expect(elicitationChannelFrom(undefined, allowed)).toBeUndefined();
  });

  it("a URL under an allowed prefix passes, query and fragment stripped", () => {
    expect(elicitationChannelFrom(`${SESSION_URL}?x=1#y`, allowed)).toEqual({
      url: SESSION_URL,
    });
  });

  it.each([
    [
      "https://evil.example.com/api/v1/elicitations/session/1",
      /evil\.example\.com that is not under/,
    ],
    // The right host is not enough: the path is the boundary.
    [`${ZIMMER}/api/v1/admin/delete`, /not under any/],
    [`${PREFIX}../../admin/delete`, /not under any/],
    [`${PREFIX}%2e%2e/%2e%2e/admin`, /not under any/],
    [PREFIX, /not under any/],
    [
      "https://zimmer.example.com:8443/api/v1/elicitations/session/1",
      /not under any/,
    ],
    ["http://zimmer.example.com/api/v1/elicitations/session/1", /plain http/],
    [
      "https://u:p@zimmer.example.com/api/v1/elicitations/session/1",
      /userinfo/,
    ],
    ["file:///etc/passwd", /not a web URL/],
    ["nonsense", /not a URL/],
    [`${SESSION_URL}, ${SESSION_URL}`, /exactly one URL/],
    [`${SESSION_URL} x`, /exactly one URL/],
  ])("%s is refused", (value, reason) => {
    const channel = elicitationChannelFrom(value, allowed);
    expect(channel && "refused" in channel && channel.refused).toMatch(reason);
  });

  it("a repeated header is refused, not resolved by picking one", () => {
    const channel = elicitationChannelFrom([SESSION_URL, SESSION_URL], allowed);
    expect(channel).toHaveProperty("refused");
  });

  it("plain http is accepted for a loopback prefix alone", () => {
    expect(
      elicitationChannelFrom("http://127.0.0.1:3000/s/1", [
        "http://127.0.0.1:3000/s/",
      ]),
    ).toEqual({ url: "http://127.0.0.1:3000/s/1" });
  });

  it("an empty allowlist accepts nothing, and says so", () => {
    const channel = elicitationChannelFrom(SESSION_URL, []);
    expect(channel && "refused" in channel && channel.refused).toMatch(
      /allowedUrlPrefixes is empty/,
    );
  });

  it("the deadline always falls before the hop's timeout", () => {
    for (const timeout of [1_000, 60_000, 120_000, 900_000]) {
      const ttl = confirmationTtlMs(timeout);
      expect(ttl).toBeLessThan(timeout);
      expect(ttl).toBeGreaterThan(0);
    }
    expect(confirmationTtlMs(900_000)).toBe(885_000);
  });
});

describe("config", () => {
  it.each([
    [`${ZIMMER}/api/v1/elicitations/session`, /ends in `\/`/],
    [ZIMMER, /ends in `\/`/],
    ["http://zimmer.example.com/s/", /plain http/],
    [`${PREFIX}?q=1`, /no userinfo, query or fragment/],
    ["not a url", /absolute URL/],
  ])("%s is not an allowed URL prefix", (value, problem) => {
    expect(() =>
      parseConfig(`
version: 1
auth: {}
gateway: { elicitation: { allowedUrlPrefixes: ["${value}"] } }
`),
    ).toThrow(problem);
  });

  it("an origin with a trailing slash is a valid (whole-host) prefix", () => {
    const cfg = parseConfig(`
version: 1
auth: {}
gateway: { elicitation: { allowedUrlPrefixes: ["${ZIMMER}/"] } }
`);
    expect(cfg.gateway.elicitation.allowedUrlPrefixes).toEqual([`${ZIMMER}/`]);
  });
});

describe("confirmationHeaders config", () => {
  const withHeaders = (confirmations: boolean, headers: string) => `
version: 1
auth: {}
roles: { admin: { servers: ["*"] } }
bundles: [{ name: bundle }]
servers:
  - slug: gmail-rw-external
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /gmail
    confirmations: ${confirmations}
    confirmationHeaders: ${headers}
    entitlements: [admin]
`;

  it("is accepted beside confirmations: true", () => {
    const cfg = parseConfig(
      withHeaders(true, `{ CF-Access-Client-Id: "\${EDGE_ID}" }`),
    );
    const server = cfg.servers[0];
    expect(
      server?.kind === "supplementary-image" && server.confirmationHeaders,
    ).toEqual({ "CF-Access-Client-Id": "${EDGE_ID}" });
  });

  it("is refused without confirmations: true, where nothing would send it", () => {
    expect(() =>
      parseConfig(withHeaders(false, `{ CF-Access-Client-Id: "x" }`)),
    ).toThrow(/declares confirmationHeaders but not confirmations: true/);
  });

  it.each(["Content-Type", "host", "bad name"])(
    "refuses %s, a name the bundle owns or cannot send",
    (name) => {
      expect(() =>
        parseConfig(withHeaders(true, `{ "${name}": "x" }`)),
      ).toThrow(/confirmationHeaders/);
    },
  );
});

describe("skipConfirmations config", () => {
  const slug = (fields: string) => `
version: 1
auth: {}
roles: { admin: { servers: ["*"] } }
bundles: [{ name: bundle }]
servers:
  - slug: gmail-own
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /gmail
${fields}
    entitlements: [admin]
`;

  it("defaults off, so a slug that declares nothing keeps refusing", () => {
    const server = parseConfig(slug("")).servers[0];
    expect(
      server?.kind === "supplementary-image" && server.skipConfirmations,
    ).toBe(false);
  });

  it("is accepted on its own", () => {
    const server = parseConfig(slug("    skipConfirmations: true")).servers[0];
    expect(
      server?.kind === "supplementary-image" && server.skipConfirmations,
    ).toBe(true);
  });

  it("is refused beside confirmations: true, not resolved", () => {
    expect(() =>
      parseConfig(slug("    confirmations: true\n    skipConfirmations: true")),
    ).toThrow(/both confirmations: true and skipConfirmations: true/);
  });
});

// --- end to end -------------------------------------------------------------

/** An MCP upstream that records the `_meta` of every tools/call it serves. */
function recordingUpstream(seen: unknown[]): HttpServer {
  return createServer(async (req, res) => {
    const server = new Server(
      { name: "rec", version: "1" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: "send_email", inputSchema: { type: "object", properties: {} } },
        { name: "hold", inputSchema: { type: "object", properties: {} } },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      seen.push(request.params._meta);
      if (request.params.name === "hold") {
        // A confirmation that is still waiting: beat, then wait to be dropped.
        const record = { aborted: false, at: Date.now() };
        held.push(record);
        const token = request.params._meta?.progressToken;
        for (let i = 1; i <= 3 && token !== undefined; i++) {
          await extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken: token, progress: i, message: "waiting" },
          });
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 3_000);
          extra.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            record.aborted = true;
            record.at = Date.now() - record.at;
            resolve();
          });
        });
      }
      return { content: [{ type: "text", text: "ok" }] };
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
}

const listening: HttpServer[] = [];
async function listen(server: HttpServer): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  listening.push(server);
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  return `http://127.0.0.1:${addr.port}`;
}

const bundleSeen: unknown[] = [];
const held: Array<{ aborted: boolean; at: number }> = [];
const thirdPartySeen: unknown[] = [];
const token = mintToken({ env: "test", label: "admin", roles: ["admin"] });
let coreUrl = "";

beforeAll(async () => {
  const bundleUrl = await listen(recordingUpstream(bundleSeen));
  const thirdPartyUrl = await listen(recordingUpstream(thirdPartySeen));
  const cfg = parseConfig(`
version: 1
gateway:
  name: strad
  env: test
  elicitation: { allowedUrlPrefixes: ["${PREFIX}"] }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles:
  - name: bundle
servers:
  - slug: gmail-rw-external
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /gmail
    timeoutMs: 600000
    confirmations: true
    entitlements: [admin]
  - slug: gmail-edge
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /gmail-edge
    confirmations: true
    confirmationHeaders:
      CF-Access-Client-Id: "\${EDGE_ID}"
      CF-Access-Client-Secret: "\${EDGE_SECRET}"
    entitlements: [admin]
  - slug: gmail-unseeded
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /gmail-unseeded
    confirmations: true
    confirmationHeaders:
      CF-Access-Client-Id: "\${NOT_SEEDED_ID}"
    mayBeUnseeded: [NOT_SEEDED_ID]
    entitlements: [admin]
  - slug: gmail-short
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /gmail-short
    timeoutMs: 400
    confirmations: true
    entitlements: [admin]
  - slug: gmail-own
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /gmail-own
    skipConfirmations: true
    entitlements: [admin]
  - slug: slack
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /slack
    entitlements: [admin]
  - slug: third-party
    kind: remote-http
    url: ${thirdPartyUrl}/mcp
    entitlements: [admin]
`);
  const env: NodeJS.ProcessEnv = {
    STRAD_TOKENS: JSON.stringify([token.record]),
    [bundleUrlEnvName("bundle")]: bundleUrl,
  };
  const registry = await Registry.build({
    config: cfg,
    secrets: sharedSecretProviders(
      new EnvSecretProvider({ EDGE_ID: "id.access", EDGE_SECRET: "s3cret" }),
    ),
    mode: "core",
    env,
  });
  const app = createApp({
    config: cfg,
    registry,
    tokenStore: tokenStoreFromConfig(cfg, env),
    mode: "core",
    env,
  });
  const core = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () =>
      resolve(s as unknown as HttpServer),
    );
  });
  listening.push(core);
  const addr = core.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  coreUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  while (listening.length) listening.pop()?.close();
});

async function call(
  slug: string,
  headers: Record<string, string>,
  meta?: Record<string, unknown>,
  tool = "send_email",
  onprogress?: (p: { progress: number }) => void,
) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } =
    await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const transport = new StreamableHTTPClientTransport(
    new URL(`${coreUrl}/mcp?servers=${slug}`),
    {
      requestInit: {
        headers: { authorization: `Bearer ${token.plaintext}`, ...headers },
      },
    },
  );
  const client = new Client({ name: "zimmer", version: "1" });
  await client.connect(transport);
  try {
    return await client.callTool(
      {
        name: `${slug}__${tool}`,
        arguments: {},
        ...(meta ? { _meta: meta } : {}),
      },
      undefined,
      onprogress ? { onprogress } : undefined,
    );
  } finally {
    await client.close();
  }
}

describe("/mcp forwards the channel to strad's own containers only", () => {
  it("an allowed URL reaches the bundle as core's _meta, with the slug and a deadline", async () => {
    bundleSeen.length = 0;
    await call("gmail-rw-external", { "x-elicitation-url": SESSION_URL });
    expect(bundleSeen).toEqual([
      {
        [ELICITATION_META_KEY]: {
          url: SESSION_URL,
          slug: "gmail-rw-external",
          ttlMs: confirmationTtlMs(600_000),
        },
        // The SDK's own, for the hop: what the bundle's keepalives answer to.
        progressToken: expect.any(Number),
      },
    ]);
  });

  it("no header: nothing is forwarded, so the confirmed tool refuses", async () => {
    bundleSeen.length = 0;
    await call("gmail-rw-external", {});
    expect(bundleSeen).toEqual([{ progressToken: expect.any(Number) }]);
  });

  it("an origin off the allowlist arrives as a refusal carrying the reason", async () => {
    bundleSeen.length = 0;
    await call("gmail-rw-external", {
      "x-elicitation-url": "https://attacker.example/collect",
    });
    expect(bundleSeen).toEqual([
      {
        [ELICITATION_META_KEY]: {
          refused: expect.stringMatching(/attacker\.example that is not under/),
        },
        progressToken: expect.any(Number),
      },
    ]);
  });

  it("a client cannot forge the key with _meta of its own", async () => {
    bundleSeen.length = 0;
    await call(
      "gmail-rw-external",
      {},
      {
        [ELICITATION_META_KEY]: { url: "https://attacker.example/collect" },
      },
    );
    expect(bundleSeen).toEqual([{ progressToken: expect.any(Number) }]);
  });

  it("a sibling mount on the same bundle without `confirmations: true` never receives it", async () => {
    bundleSeen.length = 0;
    await call("slack", { "x-elicitation-url": SESSION_URL });
    expect(bundleSeen).toEqual([undefined]);
  });

  it("a third party's server never receives the caller's URL", async () => {
    thirdPartySeen.length = 0;
    await call("third-party", { "x-elicitation-url": SESSION_URL });
    expect(thirdPartySeen).toEqual([undefined]);
  });
});

describe("a slug with skipConfirmations: true", () => {
  it("gets core's waiver on every call, and never the caller's URL", async () => {
    bundleSeen.length = 0;
    await call("gmail-own", { "x-elicitation-url": SESSION_URL });
    await call("gmail-own", {});
    const waiver = {
      [ELICITATION_META_KEY]: { skip: true, slug: "gmail-own" },
    };
    expect(bundleSeen).toEqual([waiver, waiver]);
    expect(JSON.stringify(bundleSeen)).not.toContain(PREFIX);
  });

  it("a client cannot forge the waiver on a slug that did not declare it", async () => {
    bundleSeen.length = 0;
    await call(
      "gmail-rw-external",
      {},
      { [ELICITATION_META_KEY]: { skip: true, slug: "gmail-rw-external" } },
    );
    await call("slack", {}, { [ELICITATION_META_KEY]: { skip: true } });
    expect(bundleSeen).toEqual([
      { progressToken: expect.any(Number) },
      undefined,
    ]);
  });
});

describe("a confirmed slug's call", () => {
  it("carries the slug's confirmationHeaders, resolved by core, with the channel", async () => {
    bundleSeen.length = 0;
    await call("gmail-edge", { "x-elicitation-url": SESSION_URL });
    expect(bundleSeen[0]).toMatchObject({
      [ELICITATION_META_KEY]: {
        url: SESSION_URL,
        headers: {
          "CF-Access-Client-Id": "id.access",
          "CF-Access-Client-Secret": "s3cret",
        },
      },
    });
  });

  it("an unseeded confirmation header refuses the channel, naming the variable and no value", async () => {
    bundleSeen.length = 0;
    const res = await call("gmail-unseeded", {
      "x-elicitation-url": SESSION_URL,
    });
    // The tool still ran (and, on a real bundle, refused): the slug is not
    // down, only its confirmation channel is.
    expect(res.isError).not.toBe(true);
    expect(bundleSeen).toEqual([
      {
        [ELICITATION_META_KEY]: {
          refused: expect.stringMatching(/NOT_SEEDED_ID not seeded/),
        },
        progressToken: expect.any(Number),
      },
    ]);
  });

  it("a caller that goes away tears the upstream request down, even on a busy connection", async () => {
    held.length = 0;
    // A second call on the same slug keeps the pooled connection leased, so
    // retiring it on the failure would not close the dropped call's request:
    // only aborting that request's own fetch does.
    const busy = call(
      "gmail-rw-external",
      { "x-elicitation-url": SESSION_URL },
      undefined,
      "hold",
    );
    await expect.poll(() => held.length).toBe(1);
    const controller = new AbortController();
    const pending = fetch(`${coreUrl}/mcp?servers=gmail-rw-external`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.plaintext}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-elicitation-url": SESSION_URL,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "gmail-rw-external__hold", arguments: {} },
      }),
      signal: controller.signal,
    }).then((r) => r.text());
    await expect.poll(() => held.length).toBe(2);
    controller.abort();
    await expect(pending).rejects.toThrow();
    await expect.poll(() => held[1]?.aborted, { timeout: 1_000 }).toBe(true);
    expect(held[0]!.aborted).toBe(false);
    await busy;
  });

  it("a hop that runs out of time tears the upstream request down too", async () => {
    held.length = 0;
    await expect(
      call(
        "gmail-short",
        { "x-elicitation-url": SESSION_URL },
        undefined,
        "hold",
      ),
    ).rejects.toThrow();
    await expect.poll(() => held[0]?.aborted, { timeout: 2_000 }).toBe(true);
    expect(held[0]!.at).toBeLessThan(2_000);
  });

  it("the bundle's keepalives reach a caller that asked for progress", async () => {
    held.length = 0;
    const beats: number[] = [];
    await call(
      "gmail-short",
      { "x-elicitation-url": SESSION_URL },
      undefined,
      "hold",
      (p) => beats.push(p.progress),
    ).catch(() => {});
    expect(beats).toEqual([1, 2, 3]);
  });
});
