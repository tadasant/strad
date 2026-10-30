/**
 * google-docs WRITES comments, a strad delta on the vendored tree
 * (`vendor/google-docs-shared/README.md`, `HACKS.md` #132): `add_comment` and
 * `reply_to_comment`, over Drive's `comments.create` and `replies.create`.
 *
 * The server is built through strad's own `src/docs.ts` layer, the one both
 * the bundle and the standalone entrypoint mount. The first tests fake the
 * CLIENT, to pin what each tool asks it for; the last ones fake `fetch`, to pin
 * the Drive requests the real client sends. `standalone.test.ts` drives the
 * built binary against the same Drive shapes.
 */
import { afterEach, expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { OAuth2Client } from "google-auth-library";
import type { IGoogleDocsClient } from "google-docs-workspace-mcp-server-shared";

import { createDefaultClient, createMCPServer } from "../src/docs.js";

const DOC_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

type Recorded = { method: string; args: unknown[] };

function fakeClient() {
  const calls: Recorded[] = [];
  const client = {
    async createComment(...args: unknown[]) {
      calls.push({ method: "createComment", args });
      const options = args[1] as { content: string; quotedText?: string };
      return {
        id: "AAAAcomment1",
        author: { displayName: "Tadas" },
        content: options.content,
        createdTime: "2026-10-30T12:00:00.000Z",
        ...(options.quotedText
          ? { quotedFileContent: { mimeType: "text/plain", value: options.quotedText } }
          : {}),
      };
    },
    async createReply(...args: unknown[]) {
      calls.push({ method: "createReply", args });
      const options = args[2] as { content?: string; action?: string };
      return {
        id: "AAAAreply1",
        author: { displayName: "Tadas" },
        content: options.content,
        createdTime: "2026-10-30T12:01:00.000Z",
        ...(options.action ? { action: options.action } : {}),
      };
    },
  } as unknown as IGoogleDocsClient;
  return { client, calls };
}

async function connect(
  client: () => IGoogleDocsClient,
  env: Record<string, string> = {},
): Promise<Client> {
  const server = new Server(
    { name: "google-docs-workspace-mcp-server", version: "test" },
    { capabilities: { tools: {} } },
  );
  await createMCPServer({ version: "test", env }).registerHandlers(server, client);
  const mcp = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), mcp.connect(a)]);
  return mcp;
}

async function call(
  client: () => IGoogleDocsClient,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const mcp = await connect(client);
  try {
    const result = (await mcp.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    return { text: result.content[0].text, isError: result.isError === true };
  } finally {
    await mcp.close();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("add_comment creates a comment and returns the ID reply_to_comment takes", async () => {
  const { client, calls } = fakeClient();
  const { text, isError } = await call(() => client, "add_comment", {
    document_id: `https://docs.google.com/document/d/${DOC_ID}/edit?tab=t.0`,
    content: "Should this say Q3?",
    quoted_text: "Revenue grew 12% in Q2.",
  });
  expect(isError).toBe(false);
  expect(calls).toEqual([
    {
      method: "createComment",
      args: [DOC_ID, { content: "Should this say Q3?", quotedText: "Revenue grew 12% in Q2." }],
    },
  ]);
  expect(text).toContain("**Comment ID:** AAAAcomment1");
  expect(text).toContain('"Revenue grew 12% in Q2." (shown, not anchored)');
});

test("add_comment refuses empty text without calling Drive", async () => {
  const { client, calls } = fakeClient();
  const { text, isError } = await call(() => client, "add_comment", {
    document_id: DOC_ID,
    content: "   ",
  });
  expect(isError).toBe(true);
  expect(text).toMatch(/^Error adding comment/);
  expect(calls).toEqual([]);
});

test("add_comment's description does not promise an anchor", async () => {
  const mcp = await connect(() => fakeClient().client);
  try {
    const { tools } = await mcp.listTools();
    const description = tools.find((t) => t.name === "add_comment")?.description ?? "";
    expect(description).toContain("not attached to a passage of text");
  } finally {
    await mcp.close();
  }
});

test.each([
  [{ content: "Fixed." }, { content: "Fixed.", action: undefined }, undefined],
  [{ content: "Done.", resolve: true }, { content: "Done.", action: "resolve" }, "resolved"],
  [{ resolve: true }, { content: undefined, action: "resolve" }, "resolved"],
  [{ resolve: false }, { content: undefined, action: "reopen" }, "reopened"],
])("reply_to_comment %j sends %j", async (extra, expected, thread) => {
  const { client, calls } = fakeClient();
  const { text, isError } = await call(() => client, "reply_to_comment", {
    document_id: DOC_ID,
    comment_id: "AAAAcomment1",
    ...extra,
  });
  expect(isError).toBe(false);
  expect(calls).toEqual([{ method: "createReply", args: [DOC_ID, "AAAAcomment1", expected] }]);
  expect(text).toContain("**Reply ID:** AAAAreply1");
  if (thread) expect(text).toContain(`**Thread:** ${thread}`);
  else expect(text).not.toContain("**Thread:**");
});

test("reply_to_comment with neither text nor resolve is refused without calling Drive", async () => {
  const { client, calls } = fakeClient();
  const { text, isError } = await call(() => client, "reply_to_comment", {
    document_id: DOC_ID,
    comment_id: "AAAAcomment1",
  });
  expect(isError).toBe(true);
  expect(text).toContain("content is required unless resolve is set");
  expect(calls).toEqual([]);
});

test("neither tool is listed in readonly; both are in readwrite", async () => {
  const names = async (group: string) => {
    const mcp = await connect(() => fakeClient().client, {
      GOOGLE_DOCS_ENABLED_TOOLGROUPS: group,
    });
    try {
      return (await mcp.listTools()).tools.map((t) => t.name);
    } finally {
      await mcp.close();
    }
  };
  const readonly = await names("readonly");
  expect(readonly).not.toContain("add_comment");
  expect(readonly).not.toContain("reply_to_comment");
  expect(await names("readwrite")).toEqual(
    expect.arrayContaining(["add_comment", "reply_to_comment"]),
  );
});

test("the real client POSTs comments.create and replies.create with a fields mask", async () => {
  vi.spyOn(OAuth2Client.prototype, "getAccessToken").mockResolvedValue({
    token: "stub-token",
    res: null,
  } as never);
  const requests: Array<{ url: URL; method?: string; body: unknown }> = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    requests.push({ url, method: init?.method, body: JSON.parse(String(init?.body)) });
    const reply = url.pathname.endsWith("/replies");
    return new Response(
      JSON.stringify(reply ? { id: "r1", action: "resolve" } : { id: "c1" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  const client = createDefaultClient({
    GOOGLE_DOCS_OAUTH_CLIENT_ID: "comments-id",
    GOOGLE_DOCS_OAUTH_CLIENT_SECRET: "comments-secret",
    GOOGLE_DOCS_OAUTH_REFRESH_TOKEN: "comments-refresh",
  });
  await client.createComment(DOC_ID, { content: "Hi", quotedText: "Quote" });
  await client.createReply(DOC_ID, "c1", { action: "resolve" });

  expect(requests.map((r) => [r.method, r.url.origin + r.url.pathname])).toEqual([
    ["POST", `https://www.googleapis.com/drive/v3/files/${DOC_ID}/comments`],
    ["POST", `https://www.googleapis.com/drive/v3/files/${DOC_ID}/comments/c1/replies`],
  ]);
  expect(requests.every((r) => r.url.searchParams.get("fields")?.includes("id"))).toBe(true);
  expect(requests[0].body).toEqual({
    content: "Hi",
    quotedFileContent: { mimeType: "text/plain", value: "Quote" },
  });
  // No `anchor`: Docs does not honour one sent through the API.
  expect(requests[0].body).not.toHaveProperty("anchor");
  expect(requests[1].body).toEqual({ action: "resolve" });
});
