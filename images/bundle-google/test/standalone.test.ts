/**
 * `src/standalone/` — one server from this image, run on its own, over both
 * transports its README documents. Spawns the BUILT entrypoint (`npm test`
 * builds first) with no Google credentials in its env, because that is the
 * state a first-time reader is in: the server must still boot, handshake and
 * list its tools.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseOptions } from "../src/standalone/serve.js";

const CALENDAR = fileURLToPath(new URL("../dist/standalone/google-calendar.js", import.meta.url));
const DRIVE = fileURLToPath(new URL("../dist/standalone/google-drive.js", import.meta.url));
const SEARCH_CONSOLE = fileURLToPath(new URL("../dist/standalone/google-search-console.js", import.meta.url));
const DOCS = fileURLToPath(new URL("../dist/standalone/google-docs.js", import.meta.url));
const GMAIL = fileURLToPath(new URL("../dist/standalone/gmail.js", import.meta.url));
const GMAIL_READ_TOOLS = [
  "download_email_attachments",
  "get_email_conversation",
  "list_draft_emails",
  "list_email_conversations",
  "search_email_conversations",
];
const GMAIL_TOOLS = [
  ...GMAIL_READ_TOOLS,
  "change_email_conversation",
  "create_email_label",
  "delete_draft_email",
  "list_email_labels",
  "upsert_draft_email",
].sort();
const DOCS_READ_TOOLS = ["export_document", "get_document", "get_document_outline", "list_comments"];
const DOCS_WRITE_TOOLS = [
  "add_comment",
  "append_text",
  "create_document",
  "delete_document",
  "insert_content",
  "insert_text",
  "replace_text",
  "reply_to_comment",
  "update_document",
];
const DOCS_TOOLS = [...DOCS_READ_TOOLS, ...DOCS_WRITE_TOOLS, "share_document"].sort();
const DRIVE_TOOLS = [
  "copy_file",
  "create_file",
  "create_folder",
  "get_file",
  "move_file",
  "read_file",
  "restore_file",
  "search_files",
  "trash_file",
  "update_file_metadata",
];
const SEARCH_CONSOLE_TOOLS = [
  "get_site",
  "get_sitemap",
  "inspect_url",
  "list_sitemaps",
  "list_sites",
  "query_search_analytics",
];
const CALENDAR_TOOLS = [
  "create_calendar_event",
  "delete_calendar_event",
  "get_calendar_event",
  "list_calendar_events",
  "list_calendars",
  "query_calendar_freebusy",
  "update_calendar_event",
];

/** process.env minus every credential and toggle the server reads. */
function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith("GCAL_") || k.startsWith("GOOGLE_CALENDAR_") || k.startsWith("GOOGLE_DRIVE_") || k.startsWith("GOOGLE_SEARCH_CONSOLE_") || k.startsWith("GOOGLE_DOCS_") || k.startsWith("GMAIL_") || k.startsWith("ELICITATION_") || k.endsWith("ENABLED_TOOLGROUPS") || k === "PORT") continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

async function toolNames(client: Client): Promise<string[]> {
  const { tools } = await client.listTools();
  return tools.map((t) => t.name).sort();
}

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

/** Start the HTTP mode on an OS-chosen port and resolve with the URL it logs. */
async function startHttp(
  args: string[],
  env = cleanEnv(),
  entry = CALENDAR,
): Promise<{ url: URL; stderr: () => string }> {
  const child = spawn(process.execPath, [entry, "--transport", "http", "--port", "0", ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stderr = "";
  let stdout = "";
  child.stdout!.on("data", (d) => (stdout += d));
  const url = await new Promise<URL>((resolve, reject) => {
    child.stderr!.on("data", (d) => {
      stderr += d;
      const m = /serving MCP on (http:\/\/\S+\/mcp)/.exec(stderr);
      if (m) resolve(new URL(m[1]));
    });
    child.on("exit", (code) => reject(new Error(`exited ${code}: ${stderr}`)));
  });
  expect(stdout).toBe("");
  return { url, stderr: () => stderr };
}

describe("google-calendar standalone", () => {
  it("serves all seven tools over stdio with no credentials set", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CALENDAR],
      env: cleanEnv(),
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr!.on("data", (d) => (stderr += d));
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()?.name).toBe("google-calendar-workspace-mcp-server");
      expect(await toolNames(client)).toEqual(CALENDAR_TOOLS);
      expect(stderr).toContain("GCAL_SERVICE_ACCOUNT_CLIENT_EMAIL");
    } finally {
      await client.close();
    }
  });

  it("serves all seven tools over Streamable HTTP on the port it is given", async () => {
    const { url } = await startHttp([]);
    expect(url.hostname).toBe("127.0.0.1");
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      expect(await toolNames(client)).toEqual(CALENDAR_TOOLS);
    } finally {
      await client.close();
    }

    const health = await fetch(new URL("/healthz", url));
    expect(await health.json()).toEqual({ ok: true, server: "google-calendar" });
  });

  it("answers a second request in the same session (stateless, fresh server per request)", async () => {
    const { url } = await startHttp([]);
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      expect(await toolNames(client)).toEqual(CALENDAR_TOOLS);
      expect(await toolNames(client)).toEqual(CALENDAR_TOOLS);
    } finally {
      await client.close();
    }
  });

  it("refuses a non-loopback Host header on a loopback bind (DNS rebinding)", async () => {
    const { url } = await startHttp([]);
    // `fetch` drops a caller's Host header, so this goes through node:http.
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        url,
        {
          method: "POST",
          headers: {
            host: "attacker.example",
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end(body);
    });
    expect(status).toBe(403);
  });

  it("honours GOOGLE_CALENDAR_ENABLED_TOOLGROUPS=readonly", async () => {
    const { url } = await startHttp([], cleanEnv({ GOOGLE_CALENDAR_ENABLED_TOOLGROUPS: "readonly" }));
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      expect(await toolNames(client)).toEqual([
        "get_calendar_event",
        "list_calendar_events",
        "list_calendars",
        "query_calendar_freebusy",
      ]);
    } finally {
      await client.close();
    }
  });

  it("fails a tool call, not the boot, when credentials are missing", async () => {
    const { url } = await startHttp([]);
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      const result = await client.callTool({ name: "list_calendars", arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("GCAL_SERVICE_ACCOUNT_CLIENT_EMAIL");
    } finally {
      await client.close();
    }
  });

  it("refuses to start on a tool group it does not know, rather than serving every tool", async () => {
    const child = spawn(process.execPath, [CALENDAR], {
      env: cleanEnv({ GOOGLE_CALENDAR_ENABLED_TOOLGROUPS: "read-only" }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr!.on("data", (d) => (stderr += d));
    const [code] = await once(child, "exit");
    expect(code).toBe(2);
    expect(stderr).toContain('unknown tool group(s) "read-only"');
  });

  it("in GOOGLE_CALENDAR_AUTH_MODE=oauth, warns about and fails on the OAuth variables instead", async () => {
    const { url, stderr } = await startHttp([], cleanEnv({ GOOGLE_CALENDAR_AUTH_MODE: "oauth" }));
    expect(stderr()).toContain("GOOGLE_CALENDAR_OAUTH_CLIENT_ID, GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET, GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN not set");
    expect(stderr()).not.toContain("GCAL_");
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      const result = await client.callTool({ name: "list_calendars", arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("GOOGLE_CALENDAR_AUTH_MODE=oauth, but GOOGLE_CALENDAR_OAUTH_CLIENT_ID");
    } finally {
      await client.close();
    }
  });

  it("refuses to start on an auth mode it does not know", async () => {
    const child = spawn(process.execPath, [CALENDAR], {
      env: cleanEnv({ GOOGLE_CALENDAR_AUTH_MODE: "personal" }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr!.on("data", (d) => (stderr += d));
    const [code] = await once(child, "exit");
    expect(code).toBe(2);
    expect(stderr).toContain('GOOGLE_CALENDAR_AUTH_MODE="personal" is not a mode');
  });

  it("answers GET and DELETE with 405, and a malformed body with a JSON-RPC parse error", async () => {
    const { url } = await startHttp([]);
    expect((await fetch(url)).status).toBe(405);
    expect((await fetch(url, { method: "DELETE" })).status).toBe(405);
    const bad = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: "{not json",
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32700 } });
  });

  it("exits 0 and prints usage to stdout on --help", async () => {
    const child = spawn(process.execPath, [CALENDAR, "--help"], { env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let stdout = "";
    child.stdout!.on("data", (d) => (stdout += d));
    const [code] = await once(child, "exit");
    expect(code).toBe(0);
    expect(stdout).toContain("--transport");
  });

  it("exits 2 with usage on an unknown flag", async () => {
    const child = spawn(process.execPath, [CALENDAR, "--prot", "1"], { env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let stderr = "";
    child.stderr!.on("data", (d) => (stderr += d));
    const [code] = await once(child, "exit");
    expect(code).toBe(2);
    expect(stderr).toContain("--transport");
  });
});

describe("google-drive standalone", () => {
  it("serves all ten tools over stdio with no credentials set", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DRIVE],
      env: cleanEnv(),
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr!.on("data", (d) => (stderr += d));
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()?.name).toBe("google-drive-workspace-mcp-server");
      expect(await toolNames(client)).toEqual(DRIVE_TOOLS);
      expect(stderr).toContain("GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN");
    } finally {
      await client.close();
    }
  });

  it("serves all ten tools over Streamable HTTP on the port it is given", async () => {
    const { url } = await startHttp([], cleanEnv(), DRIVE);
    expect(url.hostname).toBe("127.0.0.1");
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      expect(await toolNames(client)).toEqual(DRIVE_TOOLS);
      expect(await toolNames(client)).toEqual(DRIVE_TOOLS);
    } finally {
      await client.close();
    }
    const health = await fetch(new URL("/healthz", url));
    expect(await health.json()).toEqual({ ok: true, server: "google-drive" });
  });

  it("honours GOOGLE_DRIVE_ENABLED_TOOLGROUPS=readonly", async () => {
    const { url } = await startHttp([], cleanEnv({ GOOGLE_DRIVE_ENABLED_TOOLGROUPS: "readonly" }), DRIVE);
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      expect(await toolNames(client)).toEqual(["get_file", "read_file", "search_files"]);
    } finally {
      await client.close();
    }
  });

  it("honours GOOGLE_DRIVE_ENABLED_TOOLGROUPS=readwrite: the reads and the two creates, no edits", async () => {
    const { url } = await startHttp([], cleanEnv({ GOOGLE_DRIVE_ENABLED_TOOLGROUPS: "readwrite" }), DRIVE);
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      expect(await toolNames(client)).toEqual(["create_file", "create_folder", "get_file", "read_file", "search_files"]);
    } finally {
      await client.close();
    }
  });

  it("fails a tool call, not the boot, when credentials are missing", async () => {
    const { url } = await startHttp([], cleanEnv(), DRIVE);
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      const result = await client.callTool({ name: "search_files", arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("GOOGLE_DRIVE_OAUTH_CLIENT_ID");
    } finally {
      await client.close();
    }
  });

  it("refuses to start on a tool group it does not know, rather than serving every tool", async () => {
    const child = spawn(process.execPath, [DRIVE], {
      env: cleanEnv({ GOOGLE_DRIVE_ENABLED_TOOLGROUPS: "read-only" }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr!.on("data", (d) => (stderr += d));
    const [code] = await once(child, "exit");
    expect(code).toBe(2);
    expect(stderr).toContain('unknown tool group(s) "read-only"');
  });
});
describe("google-search-console standalone", () => {
  it("serves all six tools over stdio with no credentials set", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SEARCH_CONSOLE],
      env: cleanEnv(),
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr!.on("data", (d) => (stderr += d));
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()?.name).toBe("google-search-console-workspace-mcp-server");
      expect(await toolNames(client)).toEqual(SEARCH_CONSOLE_TOOLS);
      expect(stderr).toContain("GOOGLE_SEARCH_CONSOLE_OAUTH_REFRESH_TOKEN");
    } finally {
      await client.close();
    }
  });

  it("serves all six tools over Streamable HTTP, and a call without a credential names it", async () => {
    const { url } = await startHttp([], cleanEnv(), SEARCH_CONSOLE);
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      expect(await toolNames(client)).toEqual(SEARCH_CONSOLE_TOOLS);
      const result = (await client.callTool({ name: "list_sites", arguments: {} })) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("GOOGLE_SEARCH_CONSOLE_OAUTH_CLIENT_ID");
    } finally {
      await client.close();
    }
    const health = await fetch(new URL("/healthz", url));
    expect(await health.json()).toEqual({ ok: true, server: "google-search-console" });
  });
});

describe("google-docs standalone", () => {
  it("serves all eleven tools over stdio with no credentials set", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DOCS],
      env: cleanEnv(),
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr!.on("data", (d) => (stderr += d));
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()?.name).toBe("google-docs-workspace-mcp-server");
      expect(await toolNames(client)).toEqual(DOCS_TOOLS);
      // Nothing started, so the default mode's names: the service account's.
      expect(stderr).toContain(
        "GOOGLE_DOCS_SERVICE_ACCOUNT_CLIENT_EMAIL, GOOGLE_DOCS_SERVICE_ACCOUNT_PRIVATE_KEY, GOOGLE_DOCS_IMPERSONATE_EMAIL not set",
      );
    } finally {
      await client.close();
    }
  });

  it("serves all eleven tools over Streamable HTTP on the port it is given", async () => {
    const { url } = await startHttp([], cleanEnv(), DOCS);
    expect(url.hostname).toBe("127.0.0.1");
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      expect(await toolNames(client)).toEqual(DOCS_TOOLS);
      expect(await toolNames(client)).toEqual(DOCS_TOOLS);
    } finally {
      await client.close();
    }
    const health = await fetch(new URL("/healthz", url));
    expect(await health.json()).toEqual({ ok: true, server: "google-docs" });
  });

  it("honours GOOGLE_DOCS_ENABLED_TOOLGROUPS: readonly, readwrite, and share_document only in readwrite_external", async () => {
    const tiers: Array<[string, string[]]> = [
      ["readonly", DOCS_READ_TOOLS],
      ["readwrite", [...DOCS_READ_TOOLS, ...DOCS_WRITE_TOOLS].sort()],
      ["readwrite_external", DOCS_TOOLS],
    ];
    for (const [group, expected] of tiers) {
      const { url } = await startHttp([], cleanEnv({ GOOGLE_DOCS_ENABLED_TOOLGROUPS: group }), DOCS);
      const client = new Client({ name: "standalone-test", version: "0.0.0" });
      await client.connect(new StreamableHTTPClientTransport(url));
      try {
        expect(await toolNames(client), group).toEqual(expected);
      } finally {
        await client.close();
      }
    }
  });

  it("fails a tool call, not the boot, when credentials are missing", async () => {
    const { url } = await startHttp([], cleanEnv(), DOCS);
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      const result = await client.callTool({ name: "get_document", arguments: { document_id: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd" } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("GOOGLE_DOCS_SERVICE_ACCOUNT_CLIENT_EMAIL");
    } finally {
      await client.close();
    }
  });

  // Every tab, not only the first (`HACKS.md` #129). The built binary runs
  // with `fixtures/docs-api-stub.mjs` preloaded, which fakes the token
  // exchange and answers `documents.get` the way Google does: the first tab
  // alone unless `includeTabsContent=true` is asked for.
  const DOCS_API_STUB = new URL("./fixtures/docs-api-stub.mjs", import.meta.url).href;
  const tabsEnv = () =>
    cleanEnv({
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${DOCS_API_STUB}`.trim(),
      GOOGLE_DOCS_OAUTH_CLIENT_ID: "id",
      GOOGLE_DOCS_OAUTH_CLIENT_SECRET: "secret",
      GOOGLE_DOCS_OAUTH_REFRESH_TOKEN: "refresh",
    });
  const TABBED_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

  async function readsEveryTab(client: Client): Promise<void> {
    const all = await client.callTool({ name: "get_document", arguments: { document_id: TABBED_ID } });
    expect(all.isError).toBeFalsy();
    const text = JSON.stringify(all.content);
    expect(text).toContain("Dates are in the itinerary tab.");
    expect(text).toContain("Fly to Lisbon.");
    expect(text).toContain("Cervejaria Ramiro, Tuesday 8pm.");

    const outline = JSON.stringify(
      (await client.callTool({ name: "get_document_outline", arguments: { document_id: TABBED_ID } })).content,
    );
    expect(outline).toContain("## Tab: Itinerary / Restaurants");
    expect(outline).toContain("**Tab ID:** t.food");

    const one = JSON.stringify(
      (await client.callTool({ name: "get_document", arguments: { document_id: TABBED_ID, tab_id: "t.food" } }))
        .content,
    );
    expect(one).toContain("Cervejaria Ramiro");
    expect(one).not.toContain("Fly to Lisbon.");
  }

  it("reads every tab of a document over stdio", async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [DOCS], env: tabsEnv(), stderr: "pipe" });
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      await readsEveryTab(client);
    } finally {
      await client.close();
    }
  });

  it("reads every tab of a document over Streamable HTTP", async () => {
    const { url } = await startHttp([], tabsEnv(), DOCS);
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      await readsEveryTab(client);
    } finally {
      await client.close();
    }
  });

  // Comment writes (`HACKS.md` #132), against the same preload's Drive stub,
  // which echoes a create and refuses one without Drive's `fields` mask.
  async function writesComments(client: Client): Promise<void> {
    const added = await client.callTool({
      name: "add_comment",
      arguments: { document_id: TABBED_ID, content: "Is this the right date?" },
    });
    expect(added.isError).toBeFalsy();
    const addedText = JSON.stringify(added.content);
    expect(addedText).toContain(`**Comment ID:** comment-on-${TABBED_ID}`);
    expect(addedText).toContain("on the document as a whole");

    // The stub answers with the text the range really covers in the tab it
    // names, so this fails if the server measures the wrong tab or the wrong indexes.
    const anchored = await client.callTool({
      name: "add_comment",
      arguments: { document_id: TABBED_ID, content: "Is this the right date?", quoted_text: "to Lisbon" },
    });
    expect(anchored.isError).toBeFalsy();
    const anchoredText = JSON.stringify(anchored.content);
    expect(anchoredText).toContain("**Comment ID:** docs-comment-");
    expect(anchoredText).toContain('**Anchored to:** \\"to Lisbon\\"');
    expect(anchoredText).toContain('tab \\"Itinerary\\" (t.itin)');

    const replied = await client.callTool({
      name: "reply_to_comment",
      arguments: { document_id: TABBED_ID, comment_id: "AAAAc1", content: "Yes.", resolve: true },
    });
    expect(replied.isError).toBeFalsy();
    const repliedText = JSON.stringify(replied.content);
    expect(repliedText).toContain("**Reply ID:** reply-to-AAAAc1");
    expect(repliedText).toContain("**Thread:** resolved");
  }

  // Suggest mode (`HACKS.md` #135): each text tool, against the preload's
  // `batchUpdate`, which answers a SUGGEST write with suggestion ids and a
  // direct one with none.
  async function writesSuggestions(client: Client): Promise<void> {
    for (const [name, args] of [
      ["append_text", { text: "Pack sunscreen." }],
      ["insert_text", { index: 1, text: "Draft. " }],
      ["replace_text", { find: "Lisbon", replace: "Porto" }],
      ["update_document", { requests: [{ insertText: { location: { index: 1 }, text: "Hi" } }] }],
    ] as const) {
      const suggested = await client.callTool({
        name,
        arguments: { document_id: TABBED_ID, ...args, suggest: true },
      });
      expect(suggested.isError, name).toBeFalsy();
      const text = JSON.stringify(suggested.content);
      expect(text, name).toContain("**Applied as:** suggestion");
      expect(text, name).toContain("suggest.stub0");

      const direct = await client.callTool({ name, arguments: { document_id: TABBED_ID, ...args } });
      expect(direct.isError, name).toBeFalsy();
      expect(JSON.stringify(direct.content), name).not.toContain("Applied as");
    }

    const refused = await client.callTool({
      name: "update_document",
      arguments: { document_id: TABBED_ID, suggest: true, requests: [{ deleteTab: { tabId: "t.food" } }] },
    });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("requests[0].deleteTab");
  }

  // Anchored edits (`HACKS.md` #136). The stub refuses an insert outside a
  // paragraph of the tab it names, so a wrong tab or index fails here too.
  async function editsByHeading(client: Client): Promise<void> {
    const lines = await client.callTool({
      name: "get_document",
      arguments: {
        document_id: TABBED_ID,
        tab_id: "t.itin",
        heading: "Day 1",
        format: "outline_with_indices",
      },
    });
    expect(lines.isError).toBeFalsy();
    expect(JSON.stringify(lines.content)).toMatch(/1-7 HEADING_2 .*Day 1/);

    const inserted = await client.callTool({
      name: "insert_content",
      arguments: {
        document_id: TABBED_ID,
        heading: "Day 1",
        position: "end_of_section",
        content: "### Evening 🖼️\n\n**Dinner** at eight.",
        suggest: true,
      },
    });
    expect(inserted.isError).toBeFalsy();
    const text = JSON.stringify(inserted.content);
    expect(text).toContain("# Content Suggested");
    expect(text).toContain("t.itin");
    expect(text).toContain("**Applied as:** suggestion");

    for (const [name, args] of [
      ["insert_text", { index: 2, text: "x" }],
      ["append_text", { text: " Bring a coat." }],
      ["replace_text", { find: "Lisbon", replace: "Porto" }],
    ] as const) {
      const result = await client.callTool({
        name,
        arguments: { document_id: TABBED_ID, tab_id: "t.food", ...args },
      });
      expect(result.isError, name).toBeFalsy();
      expect(JSON.stringify(result.content), name).toContain("t.food");
    }

    const offTab = await client.callTool({
      name: "insert_text",
      arguments: { document_id: TABBED_ID, tab_id: "t.food", index: 9000, text: "x" },
    });
    expect(offTab.isError).toBe(true);
  }

  it("edits by heading over stdio", async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [DOCS], env: tabsEnv(), stderr: "pipe" });
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      await editsByHeading(client);
    } finally {
      await client.close();
    }
  });

  it("edits by heading over Streamable HTTP", async () => {
    const { url } = await startHttp([], tabsEnv(), DOCS);
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      await editsByHeading(client);
    } finally {
      await client.close();
    }
  });

  it("makes edits as suggestions over stdio", async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [DOCS], env: tabsEnv(), stderr: "pipe" });
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      await writesSuggestions(client);
    } finally {
      await client.close();
    }
  });

  it("makes edits as suggestions over Streamable HTTP", async () => {
    const { url } = await startHttp([], tabsEnv(), DOCS);
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      await writesSuggestions(client);
    } finally {
      await client.close();
    }
  });

  it("adds and replies to comments over stdio", async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [DOCS], env: tabsEnv(), stderr: "pipe" });
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      await writesComments(client);
    } finally {
      await client.close();
    }
  });

  it("adds and replies to comments over Streamable HTTP", async () => {
    const { url } = await startHttp([], tabsEnv(), DOCS);
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      await writesComments(client);
    } finally {
      await client.close();
    }
  });

  it("once an OAuth variable is set, warns about and fails on the OAuth variables instead", async () => {
    const { url, stderr } = await startHttp([], cleanEnv({ GOOGLE_DOCS_OAUTH_CLIENT_ID: "id" }), DOCS);
    expect(stderr()).toContain("GOOGLE_DOCS_OAUTH_CLIENT_SECRET, GOOGLE_DOCS_OAUTH_REFRESH_TOKEN not set");
    expect(stderr()).not.toContain("SERVICE_ACCOUNT");
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      const result = await client.callTool({ name: "get_document", arguments: { document_id: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd" } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("GOOGLE_DOCS_OAUTH_REFRESH_TOKEN");
      expect(JSON.stringify(result.content)).not.toContain("SERVICE_ACCOUNT");
    } finally {
      await client.close();
    }
  });

  it("serves the union of comma-separated groups", async () => {
    const { url } = await startHttp([], cleanEnv({ GOOGLE_DOCS_ENABLED_TOOLGROUPS: "readonly, readwrite_external" }), DOCS);
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      expect(await toolNames(client)).toEqual(DOCS_TOOLS);
    } finally {
      await client.close();
    }
  });

  it("refuses a half-set OAuth trio beside a complete service account, rather than serving the Workspace user", async () => {
    const child = spawn(process.execPath, [DOCS], {
      env: cleanEnv({
        GOOGLE_DOCS_OAUTH_CLIENT_ID: "id",
        GOOGLE_DOCS_OAUTH_CLIENT_SECRET: "secret",
        GOOGLE_DOCS_SERVICE_ACCOUNT_CLIENT_EMAIL: "sa@example.iam.gserviceaccount.com",
        GOOGLE_DOCS_SERVICE_ACCOUNT_PRIVATE_KEY: "key",
        GOOGLE_DOCS_IMPERSONATE_EMAIL: "user@example.com",
      }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr!.on("data", (d) => (stderr += d));
    const [code] = await once(child, "exit");
    expect(code).toBe(2);
    expect(stderr).toContain("GOOGLE_DOCS_OAUTH_REFRESH_TOKEN not set, so this would serve the service account's user");
  });

  it("refuses to start on a tool group it does not know, rather than serving every tool", async () => {
    const child = spawn(process.execPath, [DOCS], {
      env: cleanEnv({ GOOGLE_DOCS_ENABLED_TOOLGROUPS: "read-only" }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr!.on("data", (d) => (stderr += d));
    const [code] = await once(child, "exit");
    expect(code).toBe(2);
    expect(stderr).toContain("Invalid tool group(s) in GOOGLE_DOCS_ENABLED_TOOLGROUPS: read-only");
  });
});

describe("gmail standalone", () => {
  /** Run the entrypoint with `env` and resolve with its exit code and stderr. */
  async function refused(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
    const child = spawn(process.execPath, [GMAIL], { env: cleanEnv(env), stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    let stderr = "";
    child.stderr!.on("data", (d) => (stderr += d));
    // A refusal that regressed would sit serving stdio; fail fast instead.
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const [code, signal] = await once(child, "exit");
    clearTimeout(timer);
    expect(signal, `still running: ${stderr}`).toBeNull();
    return { code: code as number | null, stderr };
  }

  it("serves the ten read, draft and label tools over stdio with no credentials set, and no send_email", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [GMAIL],
      env: cleanEnv(),
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr!.on("data", (d) => (stderr += d));
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()?.name).toBe("gmail-workspace-mcp-server");
      expect(await toolNames(client)).toEqual(GMAIL_TOOLS);
      expect(stderr).toContain(
        "GMAIL_SERVICE_ACCOUNT_CLIENT_EMAIL, GMAIL_SERVICE_ACCOUNT_PRIVATE_KEY, GMAIL_IMPERSONATE_EMAIL not set",
      );
    } finally {
      await client.close();
    }
  });

  it("serves the same ten over Streamable HTTP on the port it is given", async () => {
    const { url } = await startHttp([], cleanEnv(), GMAIL);
    expect(url.hostname).toBe("127.0.0.1");
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      expect(await toolNames(client)).toEqual(GMAIL_TOOLS);
      expect(await toolNames(client)).toEqual(GMAIL_TOOLS);
    } finally {
      await client.close();
    }
    const health = await fetch(new URL("/healthz", url));
    expect(await health.json()).toEqual({ ok: true, server: "gmail" });
  });

  it("honours GMAIL_ENABLED_TOOLGROUPS: readonly, readwrite, and a comma-separated union", async () => {
    const tiers: Array<[string, string[]]> = [
      ["readonly", GMAIL_READ_TOOLS],
      ["readwrite", GMAIL_TOOLS],
      [" ReadOnly , readwrite ", GMAIL_TOOLS],
      ["readonly,", GMAIL_READ_TOOLS],
      ["", GMAIL_TOOLS],
    ];
    for (const [group, expected] of tiers) {
      const { url } = await startHttp([], cleanEnv({ GMAIL_ENABLED_TOOLGROUPS: group }), GMAIL);
      const client = new Client({ name: "standalone-test", version: "0.0.0" });
      await client.connect(new StreamableHTTPClientTransport(url));
      try {
        expect(await toolNames(client), JSON.stringify(group)).toEqual(expected);
      } finally {
        await client.close();
      }
    }
  });

  it("refuses to start on readwrite_external, alone or beside other groups, rather than serve send_email", async () => {
    for (const groups of ["readwrite_external", "readonly,readwrite_external", "READWRITE_EXTERNAL"]) {
      const { code, stderr } = await refused({ GMAIL_ENABLED_TOOLGROUPS: groups });
      expect(code, groups).toBe(2);
      expect(stderr).toContain("The standalone server does not send mail");
    }
  });

  it("refuses to start on a tool group it does not know, rather than serving every tool", async () => {
    for (const groups of ["read-only", "readonly,bogus"]) {
      const { code, stderr } = await refused({ GMAIL_ENABLED_TOOLGROUPS: groups });
      expect(code, groups).toBe(2);
      expect(stderr).toContain("Invalid tool group(s) in GMAIL_ENABLED_TOOLGROUPS");
    }
    const { code, stderr } = await refused({ GMAIL_ENABLED_TOOLGROUPS: " , " });
    expect(code).toBe(2);
    expect(stderr).toContain("names no group");
  });

  it("fails a tool call, not the boot, when credentials are missing", async () => {
    const { url } = await startHttp([], cleanEnv(), GMAIL);
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      const result = await client.callTool({ name: "list_email_conversations", arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("GMAIL_SERVICE_ACCOUNT_CLIENT_EMAIL");
    } finally {
      await client.close();
    }
  });

  it("once an OAuth variable is set, warns about and fails on the OAuth variables instead", async () => {
    const { url, stderr } = await startHttp([], cleanEnv({ GMAIL_OAUTH_CLIENT_ID: "id" }), GMAIL);
    expect(stderr()).toContain("GMAIL_OAUTH_CLIENT_SECRET, GMAIL_OAUTH_REFRESH_TOKEN not set");
    expect(stderr()).not.toContain("SERVICE_ACCOUNT");
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      const result = await client.callTool({ name: "list_email_conversations", arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("GMAIL_OAUTH_REFRESH_TOKEN");
      expect(JSON.stringify(result.content)).not.toContain("SERVICE_ACCOUNT");
    } finally {
      await client.close();
    }
  });

  it("answers a forged send_email, with core's skip waiver in _meta, as an unknown tool", async () => {
    const { url } = await startHttp([], cleanEnv(), GMAIL);
    const client = new Client({ name: "standalone-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      const result = await client
        .callTool({
          name: "send_email",
          arguments: { to: "someone@example.com", subject: "s", plaintext_body: "b" },
          _meta: { "dev.strad/elicitation": { skip: true } },
        })
        .then(
          (r) => JSON.stringify(r),
          (err: unknown) => String(err),
        );
      expect(result).toMatch(/unknown tool|not found/i);
    } finally {
      await client.close();
    }
  });

  it("refuses a half-set OAuth trio beside a complete service account, rather than serving the Workspace mailbox", async () => {
    const { code, stderr } = await refused({
      GMAIL_OAUTH_CLIENT_ID: "id",
      GMAIL_OAUTH_CLIENT_SECRET: "secret",
      GMAIL_SERVICE_ACCOUNT_CLIENT_EMAIL: "sa@example.iam.gserviceaccount.com",
      GMAIL_SERVICE_ACCOUNT_PRIVATE_KEY: "key",
      GMAIL_IMPERSONATE_EMAIL: "user@example.com",
    });
    expect(code).toBe(2);
    expect(stderr).toContain("GMAIL_OAUTH_REFRESH_TOKEN not set, so this would serve the service account's mailbox");
  });

  it("counts an EMPTY OAuth variable as started, so it too is refused beside a service account", async () => {
    const { code, stderr } = await refused({
      GMAIL_OAUTH_REFRESH_TOKEN: "",
      GMAIL_SERVICE_ACCOUNT_CLIENT_EMAIL: "sa@example.iam.gserviceaccount.com",
      GMAIL_SERVICE_ACCOUNT_PRIVATE_KEY: "key",
      GMAIL_IMPERSONATE_EMAIL: "user@example.com",
    });
    expect(code).toBe(2);
    expect(stderr).toContain("GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET, GMAIL_OAUTH_REFRESH_TOKEN not set");
  });
});

describe("parseOptions", () => {
  it("defaults to stdio, and HTTP to 127.0.0.1:3000", () => {
    expect(parseOptions([], {})).toEqual({ transport: "stdio", port: 0, host: "127.0.0.1" });
    expect(parseOptions(["--transport", "http"], {})).toEqual({ transport: "http", port: 3000, host: "127.0.0.1" });
  });

  it("takes the port from --port over PORT", () => {
    expect(parseOptions(["--transport", "http"], { PORT: "4100" }).port).toBe(4100);
    expect(parseOptions(["--transport", "http", "--port", "4200"], { PORT: "4100" }).port).toBe(4200);
  });

  it("rejects a bad transport and a bad port", () => {
    expect(() => parseOptions(["--transport", "sse"], {})).toThrow(/stdio or http/);
    for (const port of ["http", "70000", "", "0x10", "1e3", "-1"]) {
      expect(() => parseOptions(["--transport", "http", `--port=${port}`], {})).toThrow(/integer/);
    }
  });

  it("ignores the port entirely in stdio mode", () => {
    expect(parseOptions([], { PORT: "not-a-port" }).transport).toBe("stdio");
  });
});
