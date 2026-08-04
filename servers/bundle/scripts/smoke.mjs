#!/usr/bin/env node
/**
 * Smoke-test the collapsed bundle from INSIDE the container:
 *
 *   docker exec <container> node /app/scripts/smoke.mjs
 *
 * It speaks raw streamable-HTTP JSON-RPC (no SDK, no deps) to every mount and
 * reports the tool count each one lists. Credential-free: listing tools touches
 * no upstream API, so this passes on a container with no secrets — which is
 * exactly what CI has.
 *
 * One mount qualifies that. `secrets` derives its surface from a capability
 * PROBE (servers/secrets/shared/src/capabilities.ts), so with a credential
 * present it does make one call, to Cloud Resource Manager, and its count is
 * credential-dependent. CI has no credential, the probe fails closed, and the
 * count is the read-only 4 below.
 *
 * What it is really checking is that sixteen servers, nine dependency trees and
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
  // upload_file, refresh_link, list_files, download_file, set_sensitivity,
  // delete_file — the artifact store's whole surface.
  "remote-filesystem-tmp-public": 7,
  "google-flights": 3,
  gmail: 8,
  "google-calendar": 7,
  "google-docs": 11,
  onepassword: 9,
  // Four tools, and not one of them can return a SECRET value. This is the
  // CREDENTIAL-FREE count: the probe fails closed here, so it is the floor of
  // the surface rather than the whole of it. A deployment whose credential can
  // write lists more, by design. If this number grows in CI — where there is no
  // credential to widen it — someone added a tool to the read-only surface.
  secrets: 4,
  "good-eggs": null, // browser servers vary with their app surface; just list
  fetchpet: null,
  pointsyeah: null,
  "x-twitter": 9,
};

const X_TWITTER_TOOLS = new Set([
  "get_my_account", "get_user", "get_home_timeline", "get_user_tweets",
  "get_bookmarks", "search_recent_tweets", "get_tweets", "create_bookmark", "remove_bookmark",
]);

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

// The mount SET is an assertion, not a printout. Without this, a mount added to
// buildMounts() and left out of EXPECT ships with no tool-count coverage and no
// complaint — the loop below only walks what EXPECT already names. Each side is
// named rather than counted, because a rename moves a mount without moving the
// count, and "16 mounted, 16 in EXPECT" would otherwise read like a pass.
const mounted = new Set(health.servers.map((s) => s.slug));
const expectedSlugs = new Set(Object.keys(EXPECT));
const unchecked = [...mounted].filter((s) => !expectedSlugs.has(s));
const absent = [...expectedSlugs].filter((s) => !mounted.has(s));
if (unchecked.length || absent.length) {
  failed += 1;
  console.log(
    "FAIL mount set:" +
      (unchecked.length ? ` mounted but unchecked: ${unchecked.join(", ")};` : "") +
      (absent.length ? ` in EXPECT but not mounted: ${absent.join(", ")};` : "") +
      ` (${mounted.size} mounted, ${expectedSlugs.size} in EXPECT)`,
  );
}

// Two trees registering the SAME slug is the collision a nine-tree single process
// invites, and it collapses to one route — the set above cannot see it, because a
// Set of 17 mounts' slugs is 16 entries wide and matches EXPECT exactly.
if (health.servers.length !== mounted.size) {
  failed += 1;
  console.log(
    `FAIL duplicate mount slug: ${health.servers.length} mounts report only ${mounted.size} distinct slugs`,
  );
}

for (const [slug, expected] of Object.entries(EXPECT)) {
  try {
    const tools = await listTools(`/${slug}`);
    const isExactXSurface = slug !== "x-twitter" ||
      tools.length === X_TWITTER_TOOLS.size && tools.every((tool) => X_TWITTER_TOOLS.has(tool));
    const ok = (expected === null || tools.length === expected) && isExactXSurface;
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
