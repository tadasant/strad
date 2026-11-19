/**
 * What the strad bundle host relies on from the vendored pulsemcp-cms-admin
 * tree. The tree is VENDOR (README.md) and upstream ships no suite, so these
 * pin the seams the host uses rather than the tools' own formatting:
 *
 * - the surface: 71 tools at the upstream default, which is every group but
 *   `tenants_destructive`, and the 34 a read-only key can usefully call;
 * - that the key and base URL the host hands `PulseMCPAdminClient` are the ones
 *   on the wire, because a per-slug mount builds its client from its OWN
 *   variables and a wrong origin is a credential sent somewhere else;
 * - that a client factory which throws (the host's answer to a missing key)
 *   fails the call and leaves the server serving.
 *
 * Tests live at the TREE root rather than in `shared/`, which a re-vendor
 * overwrites. They import the vendored TypeScript sources directly. No network,
 * no PulseMCP credential: `fetch` is stubbed and the key is a placeholder.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createMCPServer,
  PulseMCPAdminClient,
  type ClientFactory,
} from "../shared/src/index.js";

async function connect(factory: ClientFactory): Promise<Client> {
  const { server, registerHandlers } = createMCPServer({ version: "test" });
  await registerHandlers(server, factory);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

const DESTRUCTIVE = ["delete_tenant", "delete_api_key", "revoke_api_key"];

/** The tools `isWriteOperation: false` marks — what a read-only slug allows. */
const READS = [
  "get_newsletter_posts", "get_newsletter_post", "get_authors",
  "search_mcp_implementations", "get_draft_mcp_implementations", "find_providers",
  "get_official_mirror_queue_items", "get_official_mirror_queue_item",
  "get_unofficial_mirrors", "get_unofficial_mirror", "get_official_mirrors",
  "get_official_mirror", "get_tenants", "get_tenant", "list_tenant_servers",
  "get_mcp_jsons", "get_mcp_json", "list_mcp_servers", "get_mcp_server",
  "get_redirects", "get_redirect", "list_good_jobs", "get_good_job",
  "list_good_job_cron_schedules", "list_good_job_processes",
  "get_good_job_queue_statistics", "get_exam_result", "list_proctor_runs",
  "get_proctor_metadata", "list_discovered_urls", "get_discovered_url_stats",
  "get_moz_metrics", "get_moz_backlinks", "get_moz_stored_metrics",
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the surface the bundle host serves", () => {
  it("is 71 tools, and none of the destructive tenant tools", async () => {
    // The host scrubs TOOL_GROUPS (capability is the gateway's job), so the
    // default is what every strad mount serves.
    vi.stubEnv("TOOL_GROUPS", "");
    const client = await connect(() => new PulseMCPAdminClient("k"));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toHaveLength(71);
    for (const name of DESTRUCTIVE) expect(names).not.toContain(name);
    for (const name of READS) expect(names).toContain(name);
  });

  it("has exactly 34 reads — the list a read-only slug's `tools: allow` names", async () => {
    // Every `_readonly` group at once is the upstream definition of "reads".
    const { server } = createMCPServer({ version: "test" });
    const { createRegisterTools } = await import("../shared/src/tools.js");
    createRegisterTools(
      () => new PulseMCPAdminClient("k"),
      [
        "newsletter", "server_directory", "official_queue", "unofficial_mirrors",
        "official_mirrors", "tenants", "mcp_jsons", "mcp_servers", "redirects",
        "good_jobs", "proctor", "discovered_urls", "moz",
      ].map((g) => `${g}_readonly`).join(","),
    )(server);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...READS].sort());
  });
});

describe("the client the host builds per slug", () => {
  it("sends the slug's own key to the slug's own base URL", async () => {
    vi.stubEnv("PULSEMCP_ADMIN_INTERNAL_SECRET", "");
    const calls: { url: string; headers: Headers }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, headers: new Headers(init?.headers) });
        return new Response(
          JSON.stringify({
            data: [{ id: 7, slug: "acme", is_admin: false }],
            meta: { current_page: 1, total_pages: 1, total_count: 1, has_next: false, limit: 30 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const client = await connect(
      () => new PulseMCPAdminClient("ro-key", "https://admin.staging.example.test"),
    );
    const result = await client.callTool({ name: "get_tenants", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("acme");
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).origin).toBe("https://admin.staging.example.test");
    expect(new URL(calls[0]!.url).pathname).toBe("/api/tenants");
    expect(calls[0]!.headers.get("x-api-key")).toBe("ro-key");
  });

  it("defaults to admin.pulsemcp.com when the host passes no base URL", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify({ data: [], meta: {} }), { status: 200 });
      }),
    );
    const client = await connect(() => new PulseMCPAdminClient("k", undefined));
    await client.callTool({ name: "get_tenants", arguments: {} });
    expect(new URL(urls[0]!).origin).toBe("https://admin.pulsemcp.com");
  });

  it("reports a rejected key as a tool error naming it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    const client = await connect(() => new PulseMCPAdminClient("bad"));
    const result = await client.callTool({ name: "get_tenants", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Invalid API key");
  });

  it("fails the call, not the server, when the factory throws for a missing key", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const client = await connect(() => {
      throw new Error("PULSEMCP_ADMIN_API_KEY is not set for pulse-cms-ro");
    });
    await expect(
      client.callTool({ name: "get_tenants", arguments: {} }),
    ).rejects.toThrow(/PULSEMCP_ADMIN_API_KEY is not set/);
    expect(fetchSpy).not.toHaveBeenCalled();
    // Still serving.
    expect((await client.listTools()).tools.length).toBe(71);
  });
});
