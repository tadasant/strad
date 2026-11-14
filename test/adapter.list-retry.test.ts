import type { Server as HttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { buildGatewayServer, listToolsFor } from "../src/gateway/mcpServer.ts";
import { Registry } from "../src/gateway/registry.ts";
import { compileToolPolicies } from "../src/gateway/toolPolicy.ts";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  disableEventExport,
  enableEventExport,
  resetEventThrottle,
} from "../src/telemetry/events.ts";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  isTransientListFailure,
  listFailureDetail,
  LocalMachineOfflineError,
  UpstreamError,
} from "../src/gateway/adapters/http.ts";
import { ServerUnconfiguredError } from "../src/gateway/unconfigured.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";

/**
 * The claim under test (tadasant/strad#379):
 *
 *   **One bad second at an upstream does not page. A bad minute still does.**
 *
 * A listing that fails emits `mcp.list_tools_failed` / `mcp.list_resources_failed`
 * at ERROR, and that record pages. Prod paged on ONE `resources/list` from a
 * hosted remote-http server, isolated, with nothing around it. So the adapter
 * gives a transient failure — `429`, a `5xx`, a dropped socket — a short,
 * bounded retry, and emits the `_failed` event only once that is spent. A real
 * answer (`404`, `400`, …) is not retried at all.
 *
 * Real MCP over real HTTP. The upstream is a stateless MCP server behind a
 * middleware that answers the next N requests for one method with a status of
 * the test's choosing.
 */

interface Stub {
  url: string;
  close: () => Promise<void>;
  /** Requests for `method` that reached the stub, failed or not. */
  seen: (method: string) => number;
  /** Answer the next `times` requests for `method` with `status`. */
  fail: (method: string, status: number, times: number) => void;
  /** Destroy the socket under the next `times` requests for `method`. */
  drop: (method: string, times: number) => void;
  /** Answer the next `times` requests for `method` with a JSON-RPC error. */
  rpcError: (method: string, code: number, times: number) => void;
}

function startStub(): Promise<Stub> {
  const counts = new Map<string, number>();
  const failing = new Map<string, { status: number; left: number }>();
  const dropping = new Map<string, number>();
  const erroring = new Map<string, { code: number; left: number }>();

  const build = (): McpServer => {
    const server = new McpServer({ name: "stub", version: "0" });
    server.registerTool("ping", { description: "ping" }, async () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    server.registerResource(
      "app",
      "ui://stub/app.html",
      { mimeType: "text/html" },
      async (uri) => ({ contents: [{ uri: uri.href, text: "<p>app</p>" }] }),
    );
    return server;
  };

  const app = express();
  app.use(express.json());
  app.post("/mcp", async (req: Request, res: Response) => {
    const method = (req.body as { method?: string } | undefined)?.method;
    if (method) counts.set(method, (counts.get(method) ?? 0) + 1);
    const d = method ? (dropping.get(method) ?? 0) : 0;
    if (method && d > 0) {
      dropping.set(method, d - 1);
      req.socket.destroy();
      return;
    }
    const e = method ? erroring.get(method) : undefined;
    if (e && e.left > 0) {
      e.left--;
      // A real JSON-RPC error response over a working transport: HTTP 200,
      // the code in the body. The message is upstream prose.
      res.status(200).json({
        jsonrpc: "2.0",
        id: (req.body as { id?: unknown }).id,
        error: { code: e.code, message: "upstream says no" },
      });
      return;
    }
    const f = method ? failing.get(method) : undefined;
    if (f && f.left > 0) {
      f.left--;
      res.status(f.status).send("upstream says no");
      return;
    }
    // Stateless: a fresh server per request, so a retried request needs no
    // session to survive the failure before it.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const server = build();
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return new Promise((resolve) => {
    const s: HttpServer = app.listen(0, () => {
      const addr = s.address();
      if (typeof addr === "string" || !addr) throw new Error("no port");
      resolve({
        url: `http://127.0.0.1:${addr.port}/mcp`,
        close: () =>
          new Promise<void>((r) => {
            s.closeAllConnections();
            s.close(() => r());
          }),
        seen: (m) => counts.get(m) ?? 0,
        fail: (m, status, times) => failing.set(m, { status, left: times }),
        drop: (m, times) => dropping.set(m, times),
        rpcError: (m, code, times) => erroring.set(m, { code, left: times }),
      });
    });
  });
}

const CONFIG = (url: string, kind = "remote-http") =>
  parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
servers:
  - slug: apify
    kind: ${kind}
    url: "${url}"
    entitlements: [admin]
`);

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

/** A registry over one remote-http slug, and the fault stream it writes. */
async function setup(kind?: string): Promise<{
  stub: Stub;
  registry: Registry;
  faults: () => string[];
  /** The Info-level `mcp.list_retry` records, parsed. */
  retries: () => Array<Record<string, unknown>>;
}> {
  const stub = await startStub();
  const config = CONFIG(stub.url, kind);
  const registry = await Registry.build({
    config,
    secrets: sharedSecretProviders(new EnvSecretProvider({})),
    mode: "core",
    env: {},
  });
  resetEventThrottle();
  // `_failed` events go to stderr; that stream is the fault stream.
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  cleanup.push(async () => {
    stderr.mockRestore();
    stdout.mockRestore();
    await registry.close();
    await stub.close();
  });
  return {
    stub,
    registry,
    faults: () => stderr.mock.calls.map((c) => String(c[0])),
    retries: () =>
      stdout.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes('"mcp.list_retry"'))
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

const NO_POLICIES = () => compileToolPolicies(CONFIG("http://127.0.0.1:1/mcp"));

async function listTools(registry: Registry): Promise<string[]> {
  const tools = await listToolsFor(
    ["apify"],
    registry,
    NO_POLICIES(),
    () => {},
  );
  return tools.map((t) => t.name);
}

/** `resources/list` through the gateway, as a real client drives it. */
async function listResources(registry: Registry): Promise<string[]> {
  const server = buildGatewayServer({
    config: CONFIG("http://127.0.0.1:1/mcp"),
    registry,
    policies: NO_POLICIES(),
    mode: "core",
    selected: ["apify"],
    principalId: "test",
    log: () => {},
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  try {
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const { resources } = await client.listResources();
    return resources.map((r) => r.uri);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

describe("a listing rides out a transient upstream failure", () => {
  it("tools/list: a 503 then success lists the tools and pages nobody", async () => {
    const { stub, registry, faults, retries } = await setup();
    stub.fail("tools/list", 503, 1);

    expect(await listTools(registry)).toEqual(["apify__ping"]);
    expect(stub.seen("tools/list")).toBe(2);
    expect(faults().filter((l) => l.includes("_failed"))).toEqual([]);
    // The absorbed attempt is on the record, at Info (stdout, not stderr).
    expect(retries()).toEqual([
      expect.objectContaining({
        evt: "mcp.list_retry",
        slug: "apify",
        listing: "tools",
        attempt: 1,
      }),
    ]);
  });

  it("resources/list: a 502 then success lists the resources and pages nobody", async () => {
    const { stub, registry, faults, retries } = await setup();
    stub.fail("resources/list", 502, 1);

    expect(await listResources(registry)).toEqual(["ui://stub/app.html"]);
    expect(stub.seen("resources/list")).toBe(2);
    expect(faults().filter((l) => l.includes("_failed"))).toEqual([]);
    expect(retries()).toEqual([
      expect.objectContaining({ listing: "resources", attempt: 1 }),
    ]);
  });

  it("a 408 is transient too", async () => {
    const { stub, registry, faults } = await setup();
    stub.fail("tools/list", 408, 1);
    expect(await listTools(registry)).toEqual(["apify__ping"]);
    expect(stub.seen("tools/list")).toBe(2);
    expect(faults().filter((l) => l.includes("_failed"))).toEqual([]);
  });

  it("resources/list: one JSON-RPC -32603 then success pages nobody (#475)", async () => {
    // The page this exists for: a hosted server answering one listing with an
    // InternalError and the next one normally.
    const { stub, registry, faults, retries } = await setup();
    stub.rpcError("resources/list", -32603, 1);

    expect(await listResources(registry)).toEqual(["ui://stub/app.html"]);
    expect(stub.seen("resources/list")).toBe(2);
    expect(faults().filter((l) => l.includes("_failed"))).toEqual([]);
    expect(retries()).toEqual([
      expect.objectContaining({ listing: "resources", attempt: 1 }),
    ]);
  });

  it("a 429 is transient too", async () => {
    const { stub, registry } = await setup();
    stub.fail("tools/list", 429, 1);
    expect(await listTools(registry)).toEqual(["apify__ping"]);
    expect(stub.seen("tools/list")).toBe(2);
  });

  it("a socket dropped under the request is retried", async () => {
    const { stub, registry, faults } = await setup();
    stub.drop("tools/list", 1);
    expect(await listTools(registry)).toEqual(["apify__ping"]);
    expect(stub.seen("tools/list")).toBe(2);
    expect(faults().filter((l) => l.includes("_failed"))).toEqual([]);
  });

  it("a failed handshake is retried like a failed listing", async () => {
    // The first listing on a fresh adapter handshakes first, and an edge having
    // a bad second does not care which request it refuses.
    const { stub, registry, faults } = await setup();
    stub.fail("initialize", 500, 1);
    expect(await listTools(registry)).toEqual(["apify__ping"]);
    expect(stub.seen("initialize")).toBe(2);
    expect(faults().filter((l) => l.includes("_failed"))).toEqual([]);
  });
});

describe("a sustained failure still pages", () => {
  it("tools/list: a persistent 503 emits mcp.list_tools_failed after 3 attempts", async () => {
    const { stub, registry, faults, retries } = await setup();
    stub.fail("tools/list", 503, 100);

    // An unnamed listing drops the slug rather than failing the request.
    expect(await listTools(registry)).toEqual([]);
    expect(stub.seen("tools/list")).toBe(3);
    const failed = faults().filter((l) => l.includes("mcp.list_tools_failed"));
    expect(failed).toHaveLength(1);
    // Two absorbed attempts at Info, then the one ERROR record, which says
    // the budget was spent rather than never entered.
    expect(retries().map((r) => r.attempt)).toEqual([1, 2]);
    expect(faults().filter((l) => l.includes("mcp.list_retry"))).toEqual([]);
    expect(JSON.parse(failed[0]!)).toMatchObject({
      attempts: 3,
      retry: "budget",
    });
  });

  it("a NAMED listing of a slug that stays down still fails, once, after the budget", async () => {
    // The page this rule must keep: a client asked for this slug by name, and
    // it is down for longer than a blip.
    const { stub, registry, faults, retries } = await setup();
    stub.fail("tools/list", 503, 100);

    await expect(
      listToolsFor(["apify"], registry, NO_POLICIES(), () => {}, {
        onUnlistable: () => {},
      }),
    ).rejects.toThrow(/could not be listed/);
    expect(stub.seen("tools/list")).toBe(3);
    expect(
      faults().filter((l) => l.includes("mcp.list_tools_failed")),
    ).toHaveLength(1);
    expect(retries()).toHaveLength(2);
  });

  it("resources/list: a persistent -32603 still pages, once, after 3 attempts", async () => {
    const { stub, registry, faults } = await setup();
    stub.rpcError("resources/list", -32603, 100);

    expect(await listResources(registry)).toEqual([]);
    expect(stub.seen("resources/list")).toBe(3);
    const failed = faults().filter((l) =>
      l.includes("mcp.list_resources_failed"),
    );
    expect(failed).toHaveLength(1);
    expect(JSON.parse(failed[0]!)).toMatchObject({
      attempts: 3,
      retry: "budget",
      rpc_code: -32603,
      error_class: "McpError",
    });
  });

  it("resources/list: a persistent 503 emits mcp.list_resources_failed after 3 attempts", async () => {
    const { stub, registry, faults } = await setup();
    stub.fail("resources/list", 503, 100);

    expect(await listResources(registry)).toEqual([]);
    expect(stub.seen("resources/list")).toBe(3);
    const failed = faults().filter((l) =>
      l.includes("mcp.list_resources_failed"),
    );
    expect(failed).toHaveLength(1);
  });
});

describe("a real answer is not retried", () => {
  for (const status of [400, 403, 404, 501]) {
    it(`a ${status} fails on the first attempt`, async () => {
      const { stub, registry, faults, retries } = await setup();
      stub.fail("tools/list", status, 100);

      expect(await listTools(registry)).toEqual([]);
      expect(stub.seen("tools/list")).toBe(1);
      const failed = faults().filter((l) =>
        l.includes("mcp.list_tools_failed"),
      );
      expect(failed).toHaveLength(1);
      expect(JSON.parse(failed[0]!)).toMatchObject({
        attempts: 1,
        retry: "not_transient",
        status,
        error_class: "StreamableHTTPError",
      });
      expect(retries()).toEqual([]);
    });
  }

  it("a JSON-RPC error other than -32603 fails on the first attempt, and says which", async () => {
    const { stub, registry, faults } = await setup();
    stub.rpcError("tools/list", -32602, 100);

    expect(await listTools(registry)).toEqual([]);
    expect(stub.seen("tools/list")).toBe(1);
    const failed = faults().filter((l) => l.includes("mcp.list_tools_failed"));
    expect(failed).toHaveLength(1);
    const record = JSON.parse(failed[0]!) as Record<string, unknown>;
    expect(record).toMatchObject({
      attempts: 1,
      retry: "not_transient",
      rpc_code: -32602,
      error_class: "McpError",
    });
    expect(record).not.toHaveProperty("status");
  });

  it("a 4xx on resources/list is not retried either", async () => {
    const { stub, registry, faults } = await setup();
    stub.fail("resources/list", 404, 100);

    expect(await listResources(registry)).toEqual([]);
    expect(stub.seen("resources/list")).toBe(1);
    expect(
      faults().filter((l) => l.includes("mcp.list_resources_failed")),
    ).toHaveLength(1);
  });

  it("a local-tunnel edge answering 503 is an offline machine, reported at once", async () => {
    // The offline verdict has its own event and its own remedy; retrying it
    // would only make a closed laptop take longer to say so.
    const { stub, registry, faults } = await setup("local-tunnel");
    stub.fail("initialize", 503, 100);
    await listTools(registry);
    expect(stub.seen("initialize")).toBe(1);
    expect(faults().filter((l) => l.includes("_failed"))).toEqual([]);
  });

  it("a tools/call is never retried, whatever the status", async () => {
    // A 5xx says nothing about whether the tool ran.
    const { stub, registry } = await setup();
    stub.fail("tools/call", 503, 100);
    await expect(registry.get("apify")!.callTool("ping", {})).rejects.toThrow();
    expect(stub.seen("tools/call")).toBe(1);
  });
});

describe("what counts as transient", () => {
  const fetchFailed = (code: string): Error =>
    new TypeError("fetch failed", {
      cause: Object.assign(new Error(code), { code }),
    });
  const up = (cause: unknown) => new UpstreamError("apify", cause);

  it.each([
    ["503", up(new StreamableHTTPError(503, "x")), true],
    ["429", up(new StreamableHTTPError(429, "x")), true],
    [
      "connection closed",
      up(new McpError(ErrorCode.ConnectionClosed, "x")),
      true,
    ],
    ["socket reset", up(fetchFailed("ECONNRESET")), true],
    ["refused connect", up(fetchFailed("ECONNREFUSED")), true],
    ["undici socket", up(fetchFailed("UND_ERR_SOCKET")), true],
    ["408", up(new StreamableHTTPError(408, "x")), true],
    [
      "JSON-RPC internal error",
      up(new McpError(ErrorCode.InternalError, "x")),
      true,
    ],
    ["404", up(new StreamableHTTPError(404, "x")), false],
    ["403", up(new StreamableHTTPError(403, "x")), false],
    ["409", up(new StreamableHTTPError(409, "x")), false],
    ["-32602", up(new McpError(ErrorCode.InvalidParams, "x")), false],
    ["401", up(new StreamableHTTPError(401, "x")), false],
    ["501", up(new StreamableHTTPError(501, "x")), false],
    ["-32601", up(new McpError(ErrorCode.MethodNotFound, "x")), false],
    ["SDK timeout", up(new McpError(ErrorCode.RequestTimeout, "x")), false],
    ["DNS try-again", up(fetchFailed("EAI_AGAIN")), true],
    ["DNS", up(fetchFailed("ENOTFOUND")), false],
    ["bad certificate", up(fetchFailed("CERT_HAS_EXPIRED")), false],
    ["connect timeout", up(fetchFailed("UND_ERR_CONNECT_TIMEOUT")), false],
    ["bare fetch failed", up(new TypeError("fetch failed")), false],
    [
      "unconfigured",
      new ServerUnconfiguredError("apify", ["APIFY_TOKEN"]),
      false,
    ],
    [
      "offline machine",
      new LocalMachineOfflineError(
        "apify",
        new StreamableHTTPError(503, "x"),
        undefined,
      ),
      false,
    ],
  ])("%s -> %s", (_label, err, transient) => {
    expect(isTransientListFailure(err)).toBe(transient);
  });
});

describe("what kind of failure a _failed record names (#475)", () => {
  const up = (cause: unknown) => new UpstreamError("apify", cause);

  it.each([
    [
      "an HTTP status",
      up(new StreamableHTTPError(404, "Not Found: secret-ish body")),
      { status: 404, error_class: "StreamableHTTPError" },
    ],
    [
      "a JSON-RPC code",
      up(new McpError(ErrorCode.InternalError, "upstream prose")),
      { rpc_code: -32603, error_class: "McpError" },
    ],
    [
      "a fetch with no response",
      up(new TypeError("fetch failed")),
      { error_class: "TypeError" },
    ],
    [
      "a DOMException by its name",
      up(new DOMException("timed out", "TimeoutError")),
      { error_class: "TimeoutError" },
    ],
    [
      "a class this repo did not list",
      up(new (class SomethingNew extends Error {})("x")),
      { error_class: "other" },
    ],
    ["a thrown non-error", up("a string"), { error_class: "other" }],
  ])("%s", (_label, err, expected) => {
    expect(listFailureDetail(err)).toEqual(expected);
  });
});

describe("what the exporter ships", () => {
  it("a retried-then-failed listing exports Info retries and one ERROR _failed with its counts, and no upstream text", async () => {
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor({ exporter })],
    });
    logs.disable();
    logs.setGlobalLoggerProvider(provider);
    enableEventExport("strad-test", "0.0.0");
    try {
      const { stub, registry } = await setup();
      stub.fail("tools/list", 503, 100);
      expect(await listTools(registry)).toEqual([]);

      const records = exporter.getFinishedLogRecords();
      const retry = records.filter((r) => r.body === "mcp.list_retry");
      // Throttled per slug: the second retry inside the same minute is
      // stdout-only, which is why the counts ride on `_failed`.
      expect(retry).toHaveLength(1);
      expect(retry[0]!.severityNumber).toBe(SeverityNumber.INFO);
      expect(Object.keys(retry[0]!.attributes).sort()).toEqual(
        [
          "attempt",
          "delay_ms",
          "error.kind",
          "listing",
          "slug",
          "strad.evt",
        ].sort(),
      );
      expect(retry[0]!.attributes).toMatchObject({
        slug: "apify",
        listing: "tools",
        attempt: 1,
      });

      const failed = records.filter((r) => r.body === "mcp.list_tools_failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]!.severityNumber).toBe(SeverityNumber.ERROR);
      expect(failed[0]!.attributes).toMatchObject({
        slug: "apify",
        attempts: 3,
        retry: "budget",
        status: 503,
        error_class: "StreamableHTTPError",
      });
      expect(JSON.stringify(records)).not.toMatch(/upstream says no/);
    } finally {
      disableEventExport();
      await provider.shutdown().catch(() => {});
      logs.disable();
    }
  });
});
