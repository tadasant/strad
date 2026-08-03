import { describe, expect, it, vi } from "vitest";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type {
  ClientFactory,
  IPulseSubregistryClient,
} from "../src/client.js";
import { listServersTool } from "../src/tools/list-servers.js";
import { getServerTool } from "../src/tools/get-server.js";

function clientFactory(
  client: Partial<IPulseSubregistryClient>,
): ClientFactory {
  return () =>
    ({
      listServers: vi.fn(),
      getServer: vi.fn(),
      setTenantId: vi.fn(),
      ...client,
    }) as IPulseSubregistryClient;
}

describe("list_servers", () => {
  it("passes defaults and returns truncated JSON", async () => {
    const listServers = vi.fn().mockResolvedValue({
      servers: [
        {
          server: {
            name: "io.github.example/test",
            description: "x".repeat(500),
          },
          _meta: {
            "com.pulsemcp/server": { visitorsEstimateTotal: 100 },
          },
        },
      ],
      metadata: { count: 1, nextCursor: "cursor-2" },
    });

    const tool = listServersTool({} as Server, clientFactory({ listServers }));
    const result = await tool.handler({});

    expect(listServers).toHaveBeenCalledWith({
      limit: 30,
      cursor: undefined,
      search: undefined,
      updatedSince: undefined,
      version: "latest",
    });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.metadata.nextCursor).toBe("cursor-2");
    expect(parsed.servers[0].server.description).toBe(
      '[TRUNCATED - use expand_fields: ["servers[].server.description"] to see full content]',
    );
  });

  it("can include all versions", async () => {
    const listServers = vi.fn().mockResolvedValue({
      servers: [],
      metadata: { count: 0 },
    });

    const tool = listServersTool({} as Server, clientFactory({ listServers }));
    await tool.handler({ latest_only: false, limit: 10 });

    expect(listServers).toHaveBeenCalledWith(
      expect.not.objectContaining({ version: expect.anything() }),
    );
  });
});

describe("get_server", () => {
  it("passes server name and default version", async () => {
    const getServer = vi.fn().mockResolvedValue({
      server: { name: "io.github.example/test", version: "1.0.0" },
      _meta: {},
    });

    const tool = getServerTool({} as Server, clientFactory({ getServer }));
    const result = await tool.handler({ server_name: "io.github.example/test" });

    expect(getServer).toHaveBeenCalledWith({
      serverName: "io.github.example/test",
      version: "latest",
    });
    expect(JSON.parse(result.content[0]!.text).server.version).toBe("1.0.0");
  });
});
