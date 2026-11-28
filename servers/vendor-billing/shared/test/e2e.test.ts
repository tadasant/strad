import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { BIGQUERY_API, createMCPServer, GOOGLE_TOKEN_URL, OPENROUTER_API } from "../build/index.js";

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
  it("lists five tools, answers one configured tool and refuses an unconfigured one", async () => {
    const key = "sk-or-v1-e2e-0123456789abcdef0123456789";
    const client = await connect({ OPENROUTER_MANAGEMENT_KEY: key }, (async (url: string) => {
      expect(url).toBe(`${OPENROUTER_API}/credits`);
      return new Response(JSON.stringify({ data: { total_credits: 10, total_usage: 4 } }));
    }) as typeof fetch);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_gcp_cost_breakdown",
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

  it("answers a [service, sku] breakdown with the grouped rows and the bound parameters", async () => {
    const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const env = {
      GCP_BILLING_SA_KEY_JSON: JSON.stringify({ type: "service_account", private_key: pem, client_email: "e2e.invalid" }),
      GCP_BILLING_EXPORT_PROJECT: "example-project",
      GCP_BILLING_EXPORT_DATASET: "billing_export",
      GCP_BILLING_EXPORT_TABLE: "gcp_billing_export_v1_EXAMPLE",
    };
    const bodies: string[] = [];
    const client = await connect(env, (async (url: string, init: RequestInit = {}) => {
      if (url === GOOGLE_TOKEN_URL) return new Response(JSON.stringify({ access_token: "ya29.e2e-token-abcdefgh" }));
      expect(url).toBe(`${BIGQUERY_API}/projects/example-project/queries`);
      bodies.push(String(init.body));
      return new Response(
        JSON.stringify({
          jobComplete: true,
          totalBytesProcessed: "2048",
          schema: {
            fields: ["service", "sku_id", "sku", "usage_unit", "currency", "cost", "credits", "usage_amount", "row_rank", "group_count", "currency_cost", "currency_credits", "range_latest_usage_end_time"].map((name) => ({ name })),
          },
          rows: [{ f: ["Secret Manager", "6D5B", "Secret access operations", "requests", "USD", "2.5", "0", "830000", "1", "1", "2.5", "0", "2026-11-20T18:00:00Z"].map((v) => ({ v })) }],
        }),
      );
    }) as typeof fetch);

    const r = await client.callTool({
      name: "get_gcp_cost_breakdown",
      arguments: { start_date: "2026-11-01", end_date: "2026-11-20", group_by: ["service", "sku"], service: "Secret Manager" },
    });
    expect(r.isError).toBeFalsy();
    const out = JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;
    expect(out.rows).toEqual([
      {
        service: "Secret Manager",
        sku_id: "6D5B",
        sku: "Secret access operations",
        usage_amount: 830000,
        usage_unit: "requests",
        currency: "USD",
        cost: 2.5,
        credits: 0,
        net: 2.5,
      },
    ]);
    expect(out.bytes_processed).toBe(2048);
    const sent = JSON.parse(bodies[0]!) as { query: string; queryParameters: Array<{ name: string }> };
    expect(sent.query).not.toContain("Secret Manager");
    expect(sent.queryParameters.map((p) => p.name)).toEqual(["start_date", "end_date", "max_rows", "service"]);
    await client.close();
  });
});
