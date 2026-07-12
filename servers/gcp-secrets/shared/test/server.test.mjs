import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  createMCPServer,
  loadConfig,
  parseAccount,
  inManagedNamespace,
  toolDefinitions,
  SecretManagerReadClient,
} from "../build/index.js";
import {
  startFakeSecretManager,
  VIEWER_ACCOUNT,
} from "./fake-secret-manager.mjs";

/**
 * These tests drive the server through a REAL MCP client over an in-memory
 * transport — the same thing an agent does — and through the real HTTP client
 * against a fake Secret Manager that enforces IAM the way Google does.
 *
 * The two claims under test:
 *   1. No tool can return a secret value. (Asserted on the schema AND by calling
 *      every tool and searching every response for a planted canary.)
 *   2. The credential could not fetch one even if a tool tried. (Asserted by
 *      trying, and getting the 403 a viewer service account really gets.)
 */

const CANARY = "sk-canary-DO-NOT-LEAK-9f3a2b";

async function fixture() {
  const fake = await startFakeSecretManager({
    secrets: new Map([
      [
        "mcp-openai-api-key",
        {
          annotations: { note: "Billing account. Rotate quarterly." },
          labels: { "managed-by": "strad" },
          createTime: "2026-03-01T10:00:00Z",
          versions: [CANARY],
        },
      ],
      [
        "mcp-empty-secret",
        { annotations: {}, labels: {}, createTime: "2026-04-01T10:00:00Z", versions: [] },
      ],
      // Outside the managed namespace: strad's OWN token store. It must never
      // appear in a listing, even though the project contains it.
      [
        "strad-staging-STRAD_TOKENS",
        { annotations: {}, labels: {}, createTime: "2026-01-01T10:00:00Z", versions: ["[]"] },
      ],
    ]),
  });

  const config = {
    projectId: fake.projectId,
    namespaces: ["mcp-"],
    account: VIEWER_ACCOUNT,
    consoleUrl: "https://staging.strad.tadasant.com/ui/gcp-secrets",
    apiBase: fake.apiBase,
    tokenUrl: fake.tokenUrl,
  };

  const { server, registerHandlers } = createMCPServer({ version: "0.0.0-test", config });
  await registerHandlers(server);

  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { fake, config, client, close: () => fake.close() };
}

test("tools/list exposes exactly three read-only tools, none of which can return a value", async () => {
  const { client, close } = await fixture();
  const { tools } = await client.listTools();

  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ["list_managed_namespaces", "list_secrets", "open_secrets_manager"],
  );

  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} must be readOnlyHint`);
    // No tool ACCEPTS a value: no input property may be value-shaped.
    const props = Object.keys(tool.inputSchema.properties ?? {});
    for (const p of props) {
      assert.ok(
        !/value|payload|secretdata|password/i.test(p),
        `${tool.name} takes a value-shaped input "${p}"`,
      );
    }
  }
  await close();
});

test("list_secrets returns names and NOTES, and never the value", async () => {
  const { client, close } = await fixture();

  const res = await client.callTool({
    name: "list_secrets",
    arguments: { namespace: "mcp-" },
  });
  const payload = JSON.parse(res.content[0].text);

  assert.equal(payload.count, 2);
  const byName = Object.fromEntries(payload.secrets.map((s) => [s.name, s]));

  assert.equal(byName["mcp-openai-api-key"].note, "Billing account. Rotate quarterly.");
  assert.equal(byName["mcp-openai-api-key"].latestVersion, "1");
  // A secret with no version yet reads as "no value", not as an error.
  assert.equal(byName["mcp-empty-secret"].latestVersion, undefined);

  // The whole response, canary-free.
  assert.ok(!JSON.stringify(res).includes(CANARY), "a secret value reached the MCP response");
  await close();
});

test("the managed namespace bounds the blast radius: strad's own secrets are invisible", async () => {
  const { client, close } = await fixture();

  const res = await client.callTool({
    name: "list_secrets",
    arguments: { namespace: "mcp-" },
  });
  assert.ok(!JSON.stringify(res).includes("STRAD_TOKENS"));

  // And an unmanaged namespace is refused rather than silently listed.
  const escape = await client.callTool({
    name: "list_secrets",
    arguments: { namespace: "strad-staging-" },
  });
  assert.equal(escape.isError, true);
  assert.match(escape.content[0].text, /not a managed namespace/);
  await close();
});

test("calling EVERY tool with EVERY argument shape never yields the canary", async () => {
  const { client, close } = await fixture();
  const { tools } = await client.listTools();

  const attempts = [
    { name: "list_managed_namespaces", arguments: {} },
    { name: "list_secrets", arguments: { namespace: "mcp-" } },
    { name: "list_secrets", arguments: { namespace: "" } },
    { name: "open_secrets_manager", arguments: {} },
    { name: "open_secrets_manager", arguments: { secret: "mcp-openai-api-key" } },
  ];
  assert.equal(new Set(attempts.map((a) => a.name)).size, tools.length);

  for (const attempt of attempts) {
    const res = await client.callTool(attempt);
    assert.ok(
      !JSON.stringify(res).includes(CANARY),
      `${attempt.name} leaked a secret value`,
    );
  }
  await close();
});

test("open_secrets_manager returns a console deep link, not a value", async () => {
  const { client, close } = await fixture();
  const res = await client.callTool({
    name: "open_secrets_manager",
    arguments: { secret: "mcp-openai-api-key" },
  });
  const payload = JSON.parse(res.content[0].text);
  assert.equal(
    payload.url,
    "https://staging.strad.tadasant.com/ui/gcp-secrets?secret=mcp-openai-api-key",
  );
  await close();
});

test("THE IAM PROOF: the MCP credential is refused a value by Secret Manager itself", async () => {
  const { fake, config, close } = await fixture();

  // The read client has no method that fetches a payload — so to prove the IAM
  // half we must go around it and speak to the API directly, with the SAME
  // service account the MCP container runs as. This is what a bug, or a
  // prompt-injected tool call, would amount to.
  const client = new SecretManagerReadClient({
    projectId: config.projectId,
    account: VIEWER_ACCOUNT,
    apiBase: config.apiBase,
    tokenUrl: config.tokenUrl,
  });
  assert.equal(
    typeof client.accessVersion,
    "undefined",
    "the read client must not grow a value-reading method",
  );

  const token = await mintViewerToken(config);
  const res = await fetch(
    `${fake.apiBase}/v1/projects/${fake.projectId}/secrets/mcp-openai-api-key/versions/latest:access`,
    { headers: { authorization: `Bearer ${token}` } },
  );

  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error.status, "PERMISSION_DENIED");
  assert.match(body.error.message, /secretmanager\.versions\.access/);
  await close();
});

test("config fails closed: no namespaces means no server, not every secret", () => {
  assert.throws(
    () => loadConfig({ GCP_SECRETS_PROJECT_ID: "p" }),
    /must name at least one prefix/,
  );
  assert.throws(() => loadConfig({}), /GCP_SECRETS_PROJECT_ID/);

  const cfg = loadConfig({
    GCP_SECRETS_PROJECT_ID: "p",
    GCP_SECRETS_NAMESPACES: "mcp-, other- ",
  });
  assert.deepEqual(cfg.namespaces, ["mcp-", "other-"]);
  assert.equal(cfg.account, null);

  assert.ok(inManagedNamespace("mcp-x", cfg.namespaces));
  assert.ok(!inManagedNamespace("strad-staging-X", cfg.namespaces));
});

test("a malformed service-account key is reported by SHAPE, never by content", () => {
  assert.throws(() => parseAccount("{not json"), (err) => {
    assert.match(err.message, /not valid JSON/);
    assert.ok(!err.message.includes("not json"), "the error echoed the key material");
    return true;
  });
  assert.throws(
    () => parseAccount(JSON.stringify({ client_email: "a@b" })),
    /missing client_email \/ private_key/,
  );
});

test("the tool descriptions tell the agent it cannot have the value", () => {
  const defs = toolDefinitions({
    projectId: "p",
    namespaces: ["mcp-"],
    account: null,
  });
  const listing = defs.find((d) => d.name === "list_secrets");
  assert.match(listing.description, /never the value itself/);
});

/** Mint an access token exactly as the read client does, to drive the fake IAM. */
async function mintViewerToken(config) {
  const { createSign } = await import("node:crypto");
  const b64 = (s) =>
    Buffer.from(s, "utf8").toString("base64url").replace(/=+$/, "");
  const iat = Math.floor(Date.now() / 1000);
  const input = `${b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64(
    JSON.stringify({
      iss: VIEWER_ACCOUNT.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: config.tokenUrl,
      iat,
      exp: iat + 3600,
    }),
  )}`;
  const sig = createSign("RSA-SHA256")
    .update(input)
    .sign(VIEWER_ACCOUNT.private_key, "base64url")
    .replace(/=+$/, "");
  const res = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${input}.${sig}`,
    }),
  });
  return (await res.json()).access_token;
}
