/**
 * Boot smoke test for the bundle-google image.
 *
 * Connects a real MCP client to each mounted path over Streamable HTTP and lists
 * tools — the same thing strad's gateway does. It asserts the CREDENTIAL-FREE
 * contract: with no Google secrets set, every server must still boot, handshake,
 * and enumerate its tools. (Tool *calls* need credentials; listing does not.)
 *
 * Usage:  node scripts/smoke.mjs [baseUrl]
 *   baseUrl defaults to $SMOKE_BASE_URL or http://127.0.0.1:8080
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = process.env.SMOKE_BASE_URL ?? process.argv[2] ?? "http://127.0.0.1:8080";

// Default (all tool groups) tool counts for each vendored server. A mismatch
// means a server failed to register its full toolset.
const EXPECTED = {
  "/gmail": 9,
  "/google-calendar": 7,
  "/google-docs": 11,
  // Four read tools, six write tools and share_spreadsheet. A strad `-ro` slug
  // is this same mount with the write six and the share withheld by the
  // gateway's tools.allow, and a `-rw` slug withholds the share alone.
  "/google-sheets": 11,
};

// The MCP SDK's per-request timeout defaults to 60s at every hop; be explicit.
const TIMEOUT_MS = 120_000;

let failed = false;

for (const [path, expected] of Object.entries(EXPECTED)) {
  const url = new URL(path, BASE);
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client(
    { name: "bundle-google-smoke", version: "0.0.0" },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
    const { tools } = await client.listTools({}, { timeout: TIMEOUT_MS });
    const names = tools.map((t) => t.name).sort();
    const ok = tools.length === expected;
    console.log(
      `${ok ? "OK  " : "FAIL"} ${path}: ${tools.length} tools (expected ${expected})`,
    );
    console.log(`     ${names.join(", ")}`);
    if (!ok) failed = true;
  } catch (err) {
    console.error(`FAIL ${path}: ${err?.message ?? err}`);
    failed = true;
  } finally {
    await client.close().catch(() => {});
  }
}

if (failed) {
  console.error("\nsmoke test FAILED");
  process.exit(1);
}
console.log(
  "\nsmoke test PASSED — all 4 servers list tools with no credentials present",
);
