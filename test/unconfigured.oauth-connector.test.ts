import type { Server as HttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
  type ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import type { StradConfig } from "../src/config/schema.ts";
import { buildGatewayServer, listToolsFor } from "../src/gateway/mcpServer.ts";
import { probeToolSurfaces } from "../src/gateway/reachability.ts";
import { Registry } from "../src/gateway/registry.ts";
import { compileToolPolicies } from "../src/gateway/toolPolicy.ts";
import {
  awaitingConsent,
  ServerUnconfiguredError,
} from "../src/gateway/unconfigured.ts";
import { createFakeGcp } from "../src/secrets/parameters/fake.ts";
import { serverParameterPath } from "../src/secrets/parameters/namespace.ts";
import {
  buildSecretProviders,
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";
import {
  disableEventExport,
  enableEventExport,
  errorKind,
  resetEventThrottle,
} from "../src/telemetry/index.ts";

/**
 * tadasant/strad#446: an `oauth:` slug nobody has connected yet paged
 * `strad_log_faults` as an `upstream_error`, because a live listing on it failed
 * the way any broken upstream fails.
 *
 * Both halves are the claim, and the second is the one that must never regress:
 *
 *   1. NEVER CONNECTED — no refresh token in the slug's namespaces — is
 *      `mcp.server_unconfigured` at Info, `unconfigured` on `/healthz`, and an
 *      MCP error in strad's own words.
 *   2. CONNECTED AND FAILING — a refresh token held, the upstream broken — is
 *      still `mcp.list_tools_failed` at ERROR, and still pages.
 *
 * The upstream is a real HTTP server answering 404 to everything: a definite,
 * non-transient failure, so the adapter's retry budget does not enter into it.
 */

const ENV = "test";
const SLUG = "google-docs-tadas412-ro";
const REFRESH = "GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

/** A bundle that answers every request 404. */
async function brokenBundle(): Promise<string> {
  const app = express();
  app.use((_req, res) => {
    res.status(404).send("<html>not found</html>");
  });
  const server = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  cleanup.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  return `http://127.0.0.1:${addr.port}`;
}

function configFor(provider: "gcp-parameter-store" | "env"): StradConfig {
  return parseConfig(`
version: 1
gateway:
  name: strad
  env: ${ENV}
  secrets: { provider: ${provider} }
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle
servers:
  - slug: ${SLUG}
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /${SLUG}
    entitlements: [admin]
    oauth:
      provider: google
      account: tadas412@gmail.com
      scopes: [https://www.googleapis.com/auth/documents.readonly]
`);
}

/** A core registry over the store, with or without the slug connected. */
async function storeRegistry(connected: boolean): Promise<{
  registry: Registry;
  config: StradConfig;
}> {
  const config = configFor("gcp-parameter-store");
  const fake = createFakeGcp();
  if (connected) {
    await fake.store.create({
      path: serverParameterPath(ENV, SLUG, "oauth", REFRESH),
      secret: true,
      value: "1//refresh-token",
    });
  }
  const env = { STRAD_BUNDLE_URL_BUNDLE: await brokenBundle() };
  const registry = await Registry.build({
    config,
    secrets: buildSecretProviders({ config, env, resolver: fake.store }),
    mode: "core",
    env,
  });
  cleanup.push(() => registry.close());
  return { registry, config };
}

/** Run `drive` with the OTLP log export wired the way the process wires it. */
async function recordsFrom(
  drive: () => Promise<void>,
): Promise<ReadableLogRecord[]> {
  const exporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter })],
  });
  logs.disable();
  logs.setGlobalLoggerProvider(provider);
  enableEventExport("strad-test", "0.0.0");
  resetEventThrottle();
  try {
    await drive();
    return exporter.getFinishedLogRecords();
  } finally {
    disableEventExport();
    await provider.shutdown().catch(() => {});
    logs.disable();
  }
}

/** A NAMED listing of the slug alone — the shape the catalog agent sent. */
async function namedListing(registry: Registry, config: StradConfig) {
  let thrown: unknown;
  const records = await recordsFrom(async () => {
    try {
      await listToolsFor(
        [SLUG],
        registry,
        compileToolPolicies(config),
        () => {},
        {
          onUnlistable: () => {},
        },
      );
    } catch (err) {
      thrown = err;
    }
  });
  return { records, thrown };
}

const errors = (records: ReadableLogRecord[]) =>
  records.filter((r) => r.severityNumber === SeverityNumber.ERROR);

describe("an oauth: slug nobody has connected", () => {
  it("lists as server_unconfigured at Info, and exports no ERROR record", async () => {
    const { registry, config } = await storeRegistry(false);
    const { records, thrown } = await namedListing(registry, config);

    expect(records.find((r) => r.body === "mcp.list_tools_failed")).toBe(
      undefined,
    );
    expect(errors(records)).toEqual([]);
    const pending = records.find((r) => r.body === "mcp.server_unconfigured");
    expect(pending?.severityNumber).toBe(SeverityNumber.INFO);
    expect(pending?.attributes["slug"]).toBe(SLUG);
    expect(pending?.attributes["names"]).toEqual([REFRESH]);

    // The caller is told why, in strad's words, and not as an internal error.
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).code).toBe(ErrorCode.InvalidRequest);
    expect((thrown as McpError).message).toContain("is not connected yet");
    expect((thrown as McpError).message).not.toContain("not found</html>");
  });

  it("is `unconfigured` on /healthz, not degraded", async () => {
    const { registry } = await storeRegistry(false);
    const { snapshot, unconfigured } = await probeToolSurfaces({ registry });
    expect(snapshot.degraded).toEqual([]);
    expect(snapshot.unconfigured).toEqual([SLUG]);
    expect(unconfigured.get(SLUG)).toEqual([REFRESH]);
  });

  it("lists resources quietly too, and a tool call says the same thing", async () => {
    const { registry, config } = await storeRegistry(false);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = buildGatewayServer({
      config,
      registry,
      policies: compileToolPolicies(config),
      mode: "core",
      selected: [SLUG],
      principalId: "test",
      log: () => {},
    });
    const client = new Client({ name: "test", version: "1" }, {});
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    cleanup.push(() => client.close());

    let call: unknown;
    const records = await recordsFrom(async () => {
      expect((await client.listResources()).resources).toEqual([]);
      call = await client
        .callTool({ name: `${SLUG}__readDocument`, arguments: {} })
        .catch((err: unknown) => err);
    });
    expect(
      records.find((r) => r.body === "mcp.list_resources_failed"),
    ).toBeUndefined();
    expect(errors(records)).toEqual([]);
    expect(
      records.find((r) => r.body === "mcp.server_unconfigured")?.severityNumber,
    ).toBe(SeverityNumber.INFO);
    expect((call as McpError).code).toBe(ErrorCode.InvalidRequest);
    expect((call as McpError).message).toContain("is not connected yet");
  });
});

describe("an oauth: slug that IS connected, and fails", () => {
  it("still emits mcp.list_tools_failed at ERROR, so the alert pages", async () => {
    const { registry, config } = await storeRegistry(true);
    const { records, thrown } = await namedListing(registry, config);

    const failed = records.find((r) => r.body === "mcp.list_tools_failed");
    expect(failed?.severityNumber).toBe(SeverityNumber.ERROR);
    expect(failed?.attributes["slug"]).toBe(SLUG);
    expect(failed?.attributes["error.kind"]).not.toBe("server_unconfigured");
    expect(
      records.find((r) => r.body === "mcp.server_unconfigured"),
    ).toBeUndefined();
    expect((thrown as McpError).code).toBe(ErrorCode.InternalError);
  });

  it("is degraded on /healthz, not unconfigured", async () => {
    const { registry } = await storeRegistry(true);
    const { snapshot } = await probeToolSurfaces({ registry });
    expect(snapshot.degraded).toEqual([SLUG]);
    expect(snapshot.unconfigured).toEqual([]);
  });
});

describe("where strad cannot tell, the fault stands", () => {
  it("under the env provider — no own namespace to ask — nothing is translated", async () => {
    const config = configFor("env");
    const env = { STRAD_BUNDLE_URL_BUNDLE: await brokenBundle() };
    const registry = await Registry.build({
      config,
      secrets: sharedSecretProviders(new EnvSecretProvider(env)),
      mode: "core",
      env,
    });
    cleanup.push(() => registry.close());
    const { records } = await namedListing(registry, config);
    expect(
      records.find((r) => r.body === "mcp.list_tools_failed")?.severityNumber,
    ).toBe(SeverityNumber.ERROR);
  });

  const failing = {
    slug: SLUG,
    kind: "supplementary-image" as const,
    listTools: () => Promise.reject(new Error("upstream down")),
    callTool: () => Promise.reject(new Error("upstream down")),
    close: async () => {},
  };

  it("a store that cannot be read leaves the original error", async () => {
    const adapter = awaitingConsent(failing, REFRESH, () =>
      Promise.reject(new Error("store unreachable")),
    );
    await expect(adapter.listTools()).rejects.toThrow("upstream down");
  });

  it("a held token leaves the original error", async () => {
    const adapter = awaitingConsent(failing, REFRESH, async () => true);
    await expect(adapter.listTools()).rejects.toThrow("upstream down");
  });

  it("no held token is unconfigured, classified as itself", async () => {
    const adapter = awaitingConsent(failing, REFRESH, async () => false);
    const err = await adapter.listTools().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerUnconfiguredError);
    expect((err as ServerUnconfiguredError).reason).toBe("unconnected");
    expect(errorKind(err)).toBe("server_unconfigured");
  });

  it("a success never asks the store", async () => {
    let asked = false;
    const adapter = awaitingConsent(
      { ...failing, listTools: async () => [] },
      REFRESH,
      async () => ((asked = true), false),
    );
    expect(await adapter.listTools()).toEqual([]);
    expect(asked).toBe(false);
  });
});
