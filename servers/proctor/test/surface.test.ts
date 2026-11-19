/**
 * What the strad bundle host relies on from the vendored proctor tree. The tree
 * is VENDOR (README.md) and upstream ships no suite, so these pin the seams the
 * host uses: the five-tool surface and its two reads, that the key and base URL
 * the host hands `ProctorClient` are the ones on the wire, and that a factory
 * which throws (the host's answer to a missing key) fails the call and leaves
 * the server serving.
 *
 * Tests live at the TREE root rather than in `shared/`, which a re-vendor
 * overwrites. No network, no PulseMCP credential.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createMCPServer,
  createRegisterTools,
  ProctorClient,
  type ClientFactory,
} from "../shared/src/index.js";

async function connect(factory: ClientFactory, groups?: string): Promise<Client> {
  const { server } = createMCPServer({ version: "test" });
  createRegisterTools(factory, groups)(server);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the surface the bundle host serves", () => {
  it("is five tools at the default the host leaves in place", async () => {
    vi.stubEnv("TOOL_GROUPS", "");
    const client = await connect(() => new ProctorClient("k"));
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ["cancel_exam", "destroy_machine", "get_machines", "get_proctor_metadata", "run_exam"].sort(),
    );
  });

  it("has two reads — the list a read-only slug's `tools: allow` names", async () => {
    const client = await connect(
      () => new ProctorClient("k"),
      "exams_readonly,machines_readonly",
    );
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_machines", "get_proctor_metadata"]);
  });
});

describe("the client the host builds per slug", () => {
  it("sends the slug's own key to the slug's own base URL", async () => {
    const calls: { url: string; headers: Headers }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, headers: new Headers(init?.headers) });
        return new Response(JSON.stringify({ runtimes: [], exams: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const client = await connect(
      () => new ProctorClient("rw-key", "https://admin.staging.example.test"),
    );
    const result = await client.callTool({ name: "get_proctor_metadata", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).origin).toBe("https://admin.staging.example.test");
    expect(new URL(calls[0]!.url).pathname).toBe("/api/proctor/metadata");
    expect(calls[0]!.headers.get("x-api-key")).toBe("rw-key");
  });

  it("defaults to admin.pulsemcp.com when the host passes no base URL", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify({ runtimes: [], exams: [] }), { status: 200 });
      }),
    );
    const client = await connect(() => new ProctorClient("k", undefined));
    await client.callTool({ name: "get_proctor_metadata", arguments: {} });
    expect(new URL(urls[0]!).origin).toBe("https://admin.pulsemcp.com");
  });

  it("reports a rejected key as a tool error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    const client = await connect(() => new ProctorClient("bad"));
    const result = await client.callTool({ name: "get_proctor_metadata", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Invalid API key");
  });

  it("fails the call, not the server, when the factory throws for a missing key", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const client = await connect(() => {
      throw new Error("PROCTOR_API_KEY is not set for proctor-ro");
    });
    const outcome = await client
      .callTool({ name: "get_proctor_metadata", arguments: {} })
      .then((r) => JSON.stringify(r), (e: Error) => e.message);
    expect(outcome).toMatch(/PROCTOR_API_KEY is not set/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await client.listTools()).tools.length).toBe(5);
  });
});
