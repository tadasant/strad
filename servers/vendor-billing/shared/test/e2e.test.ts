import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { describe, expect, it } from "vitest";

import { createMCPServer, OPENROUTER_API } from "../build/index.js";

/**
 * The same path a bundle mount takes: the tree's handlers registered on a real
 * SDK `Server`, driven by a real SDK `Client` over a linked transport.
 */
async function connect(env: Record<string, string>, fetchImpl: typeof fetch) {
  const server = new Server({ name: "strad-vendor-billing", version: "test" }, { capabilities: { tools: {} } });
  await createMCPServer({ version: "test", env, fetch: fetchImpl }).registerHandlers(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "e2e", version: "test" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe("over a real MCP client", () => {
  it("lists four tools, answers one configured tool and refuses an unconfigured one", async () => {
    const key = "sk-or-v1-e2e-0123456789abcdef0123456789";
    const client = await connect({ OPENROUTER_MANAGEMENT_KEY: key }, (async (url: string) => {
      expect(url).toBe(`${OPENROUTER_API}/credits`);
      return new Response(JSON.stringify({ data: { total_credits: 10, total_usage: 4 } }));
    }) as typeof fetch);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_gcp_month_to_date",
      "get_openai_costs",
      "get_openrouter_credits",
      "get_openrouter_key_usage",
    ]);

    const ok = await client.callTool({ name: "get_openrouter_credits", arguments: {} });
    expect(ok.isError).toBeFalsy();
    const text = (ok.content as Array<{ text: string }>)[0]!.text;
    expect(JSON.parse(text)).toEqual({ currency: "USD", total_credits: 10, total_usage: 4, remaining: 6 });
    expect(text).not.toContain(key);

    const refused = await client.callTool({ name: "get_openai_costs", arguments: { start_date: "2026-11-01" } });
    expect(refused.isError).toBe(true);
    expect((refused.content as Array<{ text: string }>)[0]!.text).toMatch(
      /^not configured: get_openai_costs needs OPENAI_ADMIN_KEY/,
    );
    await client.close();
  });
});
