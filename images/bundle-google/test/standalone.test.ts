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
const DRIVE_TOOLS = ["create_file", "create_folder", "get_file", "read_file", "search_files"];
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
    if (v === undefined || k.startsWith("GCAL_") || k.startsWith("GOOGLE_DRIVE_") || k.endsWith("ENABLED_TOOLGROUPS") || k === "PORT") continue;
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
  it("serves all five tools over stdio with no credentials set", async () => {
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

  it("serves all five tools over Streamable HTTP on the port it is given", async () => {
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
