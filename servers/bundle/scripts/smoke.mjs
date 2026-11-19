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
 * What it is really checking is that thirty-six servers, twenty-seven dependency trees and
 * one Chromium came up in ONE process without stepping on each other. Pass
 * `--tools` to print the names too.
 *
 * `--json` prints ONE JSON document and asserts nothing:
 *
 *   { "version": "…", "mounts": { "/gmail": { "tools": [...] }, … } }
 *
 * That is the observed half of the pre-deploy tool-policy check — every
 * `tools: allow` entry in a config is matched against the names a mount really
 * serves, before a deploy rather than after it (scripts/check-tool-policy.ts).
 * The mount set comes from /healthz, not from EXPECT: the check should see what
 * the container actually mounts, including a mount nobody added here.
 *
 * A mount whose surface this container cannot show in full says so, in
 * `partial`, and the checker skips it rather than reading a tool it could never
 * have listed as a typo. See PARTIAL_SURFACES.
 */
const BASE = process.env.SMOKE_BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8080}`;
const SHOW_TOOLS = process.argv.includes("--tools");
const AS_JSON = process.argv.includes("--json");

/**
 * The mounts are gated on the internal token core presents (host
 * `src/internal-auth.ts`), so this script has to present it too. It runs INSIDE
 * the container, where `STRAD_INTERNAL_TOKEN` is already in `process.env` — the
 * deploy bakes it onto every supplementary component, and CI passes it to
 * `docker run`.
 *
 * `/healthz` is deliberately not gated and is fetched without it below, which is
 * also how this script proves the platform's health prober still gets through.
 */
const TOKEN = process.env.STRAD_INTERNAL_TOKEN;
const AUTH = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};

/** The mounts, and the tool count each should list at FULL capability. */
const EXPECT = {
  slack: 14, // upstream's 9, the fork's four DM tools and slack_events_status
  "serpapi-hotels": 3,
  tailscale: 15,
  "monarch-money": 24,
  gcs: 9, // 13 minus the 4 bucket-level tools, which GCS_BUCKET hides
  // upload_file, refresh_link, list_files, download_file, set_sensitivity,
  // delete_file — the artifact store's whole surface.
  "remote-filesystem-tmp-public": 7,
  "google-flights": 3,
  gmail: 9,
  "google-calendar": 7,
  "google-docs": 14,
  // Four read tools, six write tools and share_spreadsheet. A strad
  // `google-sheets-*-ro` slug is this same mount with the write six and the
  // share withheld by the gateway; a `-rw` slug withholds the share alone.
  "google-sheets": 11,
  onepassword: 9,
  // Four tools, and not one of them can return a SECRET value. This is the
  // CREDENTIAL-FREE, CORE-LESS count: the probe fails closed here, so it is the
  // floor of the surface rather than the whole of it. A deployment whose
  // credential can write lists more, by design, and one whose host can reach
  // core (STRAD_CORE_URL + STRAD_INTERNAL_TOKEN, every deployed bundle) lists
  // `refresh_gateway` as well — five on prod, ten on staging. If this number
  // grows in CI — where there is neither — someone added a tool to the
  // read-only floor.
  secrets: 4,
  "good-eggs": null, // browser servers vary with their app surface; just list
  fetchpet: null,
  pointsyeah: null,
  "x-twitter": 9,
  "pulse-subregistry": 2,
  // One tool, `scrape`, and the count is a FORK assertion: upstream grows an
  // `extract` parameter when LLM credentials are present, and strad removed that
  // feature so the surface cannot vary with the environment.
  "strad-fetch": 1,
  // get_me, list_chats, get_chat, get_chat_history, search_messages, and the one
  // write tool, send_message — which `telegram-ro` is the allow-list without.
  telegram: 6,
  // The WhatsApp bridge's contract with Zimmer's poller: four reads (the
  // attachment read included), the one send, and pair/logout. Named below as
  // well as counted — Zimmer calls these by name every minute, so a rename is
  // an outage there, not a new count here.
  whatsapp: 7,
  // Messenger: four reads (status, threads, messages, attachment) and four
  // admin tools (login start/submit/cancel, logout). There is NO send tool, and
  // eight is also the claim that none has crept in. Named below too: the
  // nightly sweep and the `messenger-tadas` allow-list call these by name.
  messenger: 8,
  // list_coding_fields, list_coding_options, list_transactions,
  // get_transaction_coding, and the one write tool, set_transaction_coding —
  // which `bill-spend-ro` is the allow-list without. The count is also a
  // SECURITY assertion: the apiToken behind this mount is unscoped ADMIN on a
  // company's card program, so the tool surface is the only thing withholding
  // card issuance and budget management. A sixth tool here is that boundary
  // moving, and this is where it gets noticed.
  "bill-spend": 5,
  // The nineteen-tool Device Farm surface: seven reads, two stops, upload +
  // schedule, and the eight that hold and drive a physical phone. The count is
  // also a SPEND assertion — this is the one mount in the image whose tools
  // bill by the minute against a card, and the two `stop_` tools are what a
  // read-only slug is given so it can end a session it can see.
  "aws-device-farm": 19,
  // LiveOak Bank: status, the two statement reads, and the two-step device
  // enrolment. There is no write tool to count — the API client sends GET and
  // nothing else — so five is also the claim that none has crept in.
  liveoak: 5,
  // The SSH server's six: the npm ssh-agent-mcp-server's five names, plus
  // ssh_check_connection, the retry an agent calls after bringing a host back up.
  // Every SSH slug is a store-served instance of this tree at
  // `/_instance/ssh/{slug}`; this conventional mount is the credential-free one,
  // degraded, listing the same surface.
  ssh: 6,
  // Airtable: the npx package's sixteen tools by name, seven of them reads.
  airtable: 16,
  // AeroAPI v4, eight reads. Every call is billed, and there is no write to
  // count; a ninth tool is a new charge an agent can run up.
  flightaware: 8,
  // Droplets, App Platform, managed databases and account: nineteen reads, which
  // `digitalocean-tadasant-ro` allows, and ten creates, actions and deletes.
  digitalocean: 29,
  // Hetzner Cloud: fourteen reads, which `hetzner-pulse-ro` allows, and fourteen
  // writes. None turns delete protection off or returns a root password; a
  // twenty-ninth tool is the place to check that it still does not.
  hetzner: 28,
  // One tool each, and the count is the claim that neither grew a tool that
  // writes a file: these replace npx packages that wrote to the agent's disk,
  // and here they write nothing anywhere.
  "image-diff": 1,
  "svg-tracer": 1,
  // Two estimates and two lookups, all reads. There is no diary or account to
  // write to (spec non-goals), so a fifth tool is a new kind of capability.
  "nutrition-facts": 4,
  // Grafana's 65 tools minus the 13 the binary's `-disable-write` removes. Not a
  // gateway allow-list: the child process does not contain them. If this number
  // moves, either the pin moved or a flag stopped being passed — and the second
  // one is a read-only mount quietly becoming read-write.
  grafana: 52,
  // mcp-victorialogs v1.9.0 serves thirteen tools, every one annotated
  // read-only: LogsQL's query API is all it wraps. Booted here against an
  // entrypoint that cannot resolve (no credential in CI), which is still the
  // binary's own list.
  victorialogs: 13,
  // pulsemcp/mcp-servers' AppSignal tools in upstream's LOCKED mode — no app
  // selection — all reads. custom_graphql_query is one of the twenty and refuses
  // a mutation in strad's layer (servers/appsignal/README.md).
  appsignal: 20,
};

/**
 * Mounts whose surface HERE is a floor, not the whole — and why.
 *
 * This container is credential-free and its environment is not staging's, so a
 * few mounts list less than a real deployment does. That is fine for a count
 * (EXPECT pins the credential-free number) and fatal for a NAME check: an allow
 * entry naming a tool this container cannot show is not evidence of a typo. The
 * checker skips these and prints the reason, because a gate that cries wolf gets
 * turned off.
 *
 * Every mount NOT named here serves a fixed surface, and its names are the
 * whole truth.
 */
const PARTIAL_SURFACES = {
  secrets:
    "surface comes from a capability PROBE and from whether the host can reach core; with neither here it is the read-only floor",
  gcs: "GCS_BUCKET is set in CI, which hides the 4 bucket-level tools",
  "good-eggs": "browser server; its surface follows the app it drives",
  fetchpet: "browser server; its surface follows the app it drives",
  pointsyeah: "browser server; its surface follows the app it drives",
};

const TELEGRAM_TOOLS = new Set([
  "get_me", "list_chats", "get_chat", "get_chat_history", "search_messages", "send_message",
]);

const WHATSAPP_TOOLS = new Set([
  "whatsapp_status", "whatsapp_list_chats", "whatsapp_get_messages",
  "whatsapp_get_attachment", "whatsapp_send_message", "whatsapp_pair",
  "whatsapp_logout",
]);

const MESSENGER_TOOLS = new Set([
  "messenger_status", "messenger_list_threads", "messenger_get_messages",
  "messenger_get_attachment", "messenger_login_start", "messenger_login_submit",
  "messenger_login_cancel", "messenger_logout",
]);

const BILL_SPEND_TOOLS = new Set([
  "list_coding_fields", "list_coding_options", "list_transactions",
  "get_transaction_coding", "set_transaction_coding",
]);

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
      ...AUTH,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // The gate answers `{ "error": … }` with no `jsonrpc` field, and it answers it
  // BEFORE any mount runs — so without this the next line reads `result` off
  // undefined and every mount fails with a TypeError that names neither the
  // status nor the token. 401 is a missing or wrong STRAD_INTERNAL_TOKEN; 503 is
  // a container booted without one, which fails closed on purpose.
  if (res.status === 401 || res.status === 503) {
    let detail = text.slice(0, 200);
    try {
      detail = JSON.parse(text).error ?? detail;
    } catch {}
    throw new Error(
      `HTTP ${res.status} from ${path}: ${detail}` +
        (TOKEN ? "" : " (STRAD_INTERNAL_TOKEN is not set in this environment)"),
    );
  }
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

// --- the machine-readable half ----------------------------------------------
//
// One document on stdout and nothing else, so `docker exec … --json > file` is
// the whole plumbing. It asserts NOTHING: a mount that will not list is recorded
// as an error for the checker to skip, not a failure here. The assertions are
// the other invocation's job, and CI runs both.
if (AS_JSON) {
  const mounts = {};
  for (const server of health.servers) {
    const path = server.path ?? `/${server.slug}`;
    const partial = PARTIAL_SURFACES[server.slug];
    const entry = partial ? { partial } : {};
    try {
      entry.tools = await listTools(path);
    } catch (err) {
      entry.error = err.message;
    }
    mounts[path] = entry;
  }
  console.log(JSON.stringify({ version: health.version, mounts }, null, 2));
  process.exit(0);
}

console.log(
  `bundle v${health.version}: ${health.servers.length} mounts, chromium up=${health.chromium.up} launches=${health.chromium.launches}`,
);

let failed = 0;

// The mount SET is an assertion, not a printout. Without this, a mount added to
// buildMounts() and left out of EXPECT ships with no tool-count coverage and no
// complaint — the loop below only walks what EXPECT already names. Each side is
// named rather than counted, because a rename moves a mount without moving the
// count, and "21 mounted, 21 in EXPECT" would otherwise read like a pass.
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

// Two trees registering the SAME slug is the collision a twelve-tree single process
// invites, and it collapses to one route — the set above cannot see it, because a
// Set of 36 mounts' slugs is 35 entries wide and matches EXPECT exactly.
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
    // Named, not just counted, for the same reason as X: the staging allow-list
    // for `telegram-ro` is these names minus send_message, and a RENAME keeps
    // the count and silently narrows that slug to nothing it can call.
    const isExactTelegramSurface = slug !== "telegram" ||
      tools.length === TELEGRAM_TOOLS.size && tools.every((tool) => TELEGRAM_TOOLS.has(tool));
    // Named for a third reason on top of the other two: this mount's credential
    // can issue a virtual card, and the NAMES are what say it does not. A count
    // of 5 is satisfied by a surface that swapped a read tool for `create_card`.
    const isExactBillSpendSurface = slug !== "bill-spend" ||
      tools.length === BILL_SPEND_TOOLS.size && tools.every((tool) => BILL_SPEND_TOOLS.has(tool));
    const isExactWhatsAppSurface = slug !== "whatsapp" ||
      tools.length === WHATSAPP_TOOLS.size && tools.every((tool) => WHATSAPP_TOOLS.has(tool));
    const isExactMessengerSurface = slug !== "messenger" ||
      tools.length === MESSENGER_TOOLS.size && tools.every((tool) => MESSENGER_TOOLS.has(tool));
    const ok = (expected === null || tools.length === expected) &&
      isExactXSurface && isExactTelegramSurface && isExactBillSpendSurface &&
      isExactWhatsAppSurface && isExactMessengerSurface;
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
