#!/usr/bin/env node
/**
 * Smoke-test the collapsed bundle from INSIDE the container:
 *
 *   docker exec <container> node /app/scripts/smoke.mjs
 *
 * It speaks raw streamable-HTTP JSON-RPC (no SDK, no deps) to every mount and
 * reports the tool count each one lists. Credential-free: listing tools never
 * touches an upstream API, so this passes on a container with no secrets — which
 * is exactly what CI has.
 *
 * What it is really checking is that fifteen servers, seven dependency trees and
 * one Chromium came up in ONE process without stepping on each other. Pass
 * `--tools` to print the names too.
 */
const BASE = process.env.SMOKE_BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8080}`;
const SHOW_TOOLS = process.argv.includes("--tools");

/** The mounts, and the tool count each should list at FULL capability. */
const EXPECT = {
  slack: 9,
  "serpapi-hotels": 3,
  tailscale: 15,
  "monarch-money": 23,
  gcs: 9, // 13 minus the 4 bucket-level tools, which GCS_BUCKET hides
  "remote-fs-screenshots": 5,
  "google-flights": 3,
  gmail: 8,
  "google-calendar": 7,
  "google-docs": 11,
  onepassword: 9,
  // Four tools, and not one of them can return a SECRET value. If this number
  // ever GROWS, someone added a tool to a secrets server, and that is a thing CI
  // should stop.
  secrets: 4,
  "good-eggs": null, // browser servers vary with their app surface; just list
  fetchpet: null,
  pointsyeah: null,
};

async function rpc(path, body, sessionId) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // A streamable-HTTP response is either JSON or an SSE frame carrying JSON.
  const payload = text.startsWith("event:") || text.startsWith("data:")
    ? JSON.parse(text.split("\n").find((l) => l.startsWith("data:")).slice(5))
    : JSON.parse(text);
  return { payload, sessionId: res.headers.get("mcp-session-id") ?? sessionId };
}

async function listTools(path) {
  const init = await rpc(path, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke", version: "1" },
    },
  });
  if (init.payload.error) throw new Error(JSON.stringify(init.payload.error));

  const listed = await rpc(
    path,
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    init.sessionId,
  );
  if (listed.payload.error) throw new Error(JSON.stringify(listed.payload.error));
  return listed.payload.result.tools.map((t) => t.name);
}

const health = await (await fetch(`${BASE}/healthz`)).json();
console.log(
  `bundle v${health.version}: ${health.servers.length} mounts, chromium up=${health.chromium.up} launches=${health.chromium.launches}`,
);

let failed = 0;
for (const [slug, expected] of Object.entries(EXPECT)) {
  try {
    const tools = await listTools(`/${slug}`);
    const ok = expected === null || tools.length === expected;
    if (!ok) failed += 1;
    console.log(
      `${ok ? "ok  " : "FAIL"} /${slug}: ${tools.length} tools${expected === null ? "" : ` (expected ${expected})`}`,
    );
    if (SHOW_TOOLS) console.log(`       ${tools.join(", ")}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL /${slug}: ${err.message}`);
  }
}

if (failed) {
  console.error(`\n${failed} mount(s) failed`);
  process.exit(1);
}
console.log("\nall mounts healthy");
