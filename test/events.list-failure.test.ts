import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  listFailureDetail,
  UpstreamError,
} from "../src/gateway/adapters/http.ts";
import type { ServerAdapter } from "../src/gateway/adapters/types.ts";
import { registerEventHandlers } from "../src/gateway/events.ts";
import type { Registry } from "../src/gateway/registry.ts";

/**
 * `mcp.events_list_failed` names the KIND of failure, the way the tools and
 * resources `_failed` records do (#475), and still never the upstream's text.
 */
describe("mcp.events_list_failed", () => {
  it("carries the injected status / class discriminator and no upstream text", async () => {
    const adapter = {
      supportsEvents: async () => true,
      listEvents: async () => {
        throw new UpstreamError(
          "feed",
          new StreamableHTTPError(404, "upstream says no"),
        );
      },
    } as unknown as ServerAdapter;
    const registry = { get: () => adapter } as unknown as Registry;
    const logged: Array<Record<string, unknown>> = [];

    const server = new Server(
      { name: "t", version: "0" },
      { capabilities: { tools: {} } },
    );
    registerEventHandlers(server, {
      selected: ["feed"],
      registry,
      principalId: "test",
      log: (e) => logged.push(e),
      describeListFailure: listFailureDetail,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);
    try {
      const res = await client.request(
        { method: "events/list", params: {} },
        ResultSchema.passthrough(),
      );
      expect((res as { events?: unknown }).events).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }

    expect(logged).toEqual([
      {
        evt: "mcp.events_list_failed",
        slug: "feed",
        status: 404,
        error_class: "StreamableHTTPError",
      },
    ]);
    expect(JSON.stringify(logged)).not.toMatch(/upstream says no/);
  });
});
