#!/usr/bin/env node
/**
 * A stand-in for the pinned mcp-victorialogs binary.
 *
 * The real one is a Go executable baked into the bundle image; `smoke.mjs`
 * boots it there, and `upstream.test.ts` runs against it when
 * `MCP_VICTORIALOGS_BINARY` names a copy. What these tests care about is the
 * SEAM: the allowlisted environment, the pinned stdio mode, tools and results
 * forwarded verbatim, a dead child replaced. Like the real binary, it refuses to
 * start without `VL_INSTANCE_ENTRYPOINT`, or in any mode but stdio.
 *
 * Newline-delimited JSON-RPC on stdout, logs on stderr — the same contract the
 * real binary keeps.
 */
import process, { argv, env, exit, pid, stdin, stdout } from "node:process";

const FLAGS = argv.slice(2);

if (!env.VL_INSTANCE_ENTRYPOINT) {
  process.stderr.write("FATAL: Error initializing config: VL_INSTANCE_ENTRYPOINT is not set\n");
  exit(1);
}
if ((env.MCP_SERVER_MODE ?? "stdio") !== "stdio") {
  // The real binary would open a listener and never answer on stdout.
  process.stderr.write(`FATAL: not stdio: ${env.MCP_SERVER_MODE}\n`);
  exit(1);
}

const TOOLS = [
  {
    name: "echo_call",
    description: "Returns the call params it received.",
    inputSchema: { type: "object", properties: { note: { type: "string" } } },
  },
  {
    name: "echo_process",
    description: "Returns this process's pid, argv and environment.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "die",
    description: "Answers, then exits — a child that went away mid-session.",
    inputSchema: { type: "object", properties: {} },
  },
];

function send(message) {
  stdout.write(JSON.stringify(message) + "\n");
}

function result(id, payload) {
  send({ jsonrpc: "2.0", id, result: payload });
}

function text(id, value) {
  result(id, { content: [{ type: "text", text: JSON.stringify(value) }] });
}

function handle(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    result(id, {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "fake-mcp-victorialogs", version: "v1.9.0" },
    });
    return;
  }
  if (method === "notifications/initialized") return;

  if (method === "tools/list") {
    result(id, { tools: TOOLS });
    return;
  }

  if (method === "tools/call") {
    const name = params?.name;
    if (name === "echo_call") {
      text(id, params);
      return;
    }
    if (name === "echo_process") {
      text(id, { pid, flags: FLAGS, env: { ...env } });
      return;
    }
    if (name === "die") {
      text(id, { dying: true });
      // After the answer is on the wire, not before: the test is about a child
      // that goes away between calls, not one that fails a call.
      setTimeout(() => exit(0), 10);
      return;
    }
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: `unknown tool ${String(name)}` },
    });
    return;
  }

  if (id !== undefined) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `unknown method ${String(method)}` },
    });
  }
}

let buffered = "";
stdin.on("data", (chunk) => {
  buffered += chunk.toString();
  let index;
  while ((index = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, index).trim();
    buffered = buffered.slice(index + 1);
    if (line) handle(JSON.parse(line));
  }
});
stdin.on("end", () => exit(0));
