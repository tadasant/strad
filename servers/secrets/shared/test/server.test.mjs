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
  parameterId,
  ParameterManagerReadClient,
} from "../build/index.js";
import {
  startFakeParameterManager,
  makeParameter,
  VIEWER_ACCOUNT,
} from "./fake-parameter-manager.mjs";

/**
 * These tests drive the server through a REAL MCP client over an in-memory
 * transport — the same thing an agent does — and through the real HTTP client
 * against a fake Parameter Manager that models the two-store split the way Google
 * enforces it.
 *
 * The claims under test:
 *   1. No tool returns a SECRET value. (Asserted on the schema, by reading a
 *      secret parameter and getting a refusal, and by sweeping every response for
 *      a planted canary.)
 *   2. A NON-secret value IS readable — non-secrets are configuration, not
 *      credentials.
 *   3. The namespace fences the blast radius: strad's own parameters are neither
 *      listable nor gettable.
 */

const NS = "/strad/staging/mcp/";
const P_EMAIL =
  "/strad/staging/mcp/remote-fs-screenshots/static/REMOTE_FS_SCREENSHOTS_GCS_CLIENT_EMAIL";
const P_KEY =
  "/strad/staging/mcp/remote-fs-screenshots/static/REMOTE_FS_SCREENSHOTS_GCS_PRIVATE_KEY";
const P_OUTSIDE = "/strad/staging/core/static/STRAD_TOKENS";

const EMAIL_VALUE = "remote-fs@strad-staging.iam.gserviceaccount.com";
/** The secret's bytes. They live only in Secret Manager and must never appear. */
const CANARY = "-----BEGIN PRIVATE KEY-----canary-DO-NOT-LEAK-9f3a2b";
/** A second canary, on a parameter OUTSIDE the namespace. Also never appears. */
const CANARY_OUTSIDE = "strad-token-DO-NOT-LEAK-tttt";

async function fixture() {
  const projectId = "test-project";
  const secretId = "strad-staging-remote-fs-screenshots-gcs-private-key";

  const seeds = [
    makeParameter(projectId, {
      path: P_EMAIL,
      secret: false,
      value: EMAIL_VALUE,
      note: "the GCS service account email; non-secret configuration",
    }),
    makeParameter(projectId, {
      path: P_KEY,
      secret: true,
      secretId,
      note: "rotate on staff change",
    }),
    // Managed by strad, but OUTSIDE the mcp namespace: strad's own token store.
    // It must never appear in an mcp listing, nor be gettable through this server.
    makeParameter(projectId, {
      path: P_OUTSIDE,
      secret: false,
      value: CANARY_OUTSIDE,
      note: "strad's own tokens",
    }),
  ];

  const parameters = new Map(seeds.map((s) => [s.id, s.entry]));
  const secretManager = new Map([[secretId, CANARY]]);

  const fake = await startFakeParameterManager({
    projectId,
    parameters,
    secretManager,
  });

  const config = {
    projectId: fake.projectId,
    namespaces: [NS],
    account: VIEWER_ACCOUNT,
    consoleUrl: "https://staging.strad.tadasant.com/ui/secrets",
    apiBase: fake.apiBase,
    tokenUrl: fake.tokenUrl,
  };

  const { server, registerHandlers } = createMCPServer({
    version: "0.0.0-test",
    config,
  });
  await registerHandlers(server);

  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return { fake, config, client, close: () => fake.close() };
}

test("tools/list exposes exactly four read-only tools, none of which returns a secret value", async () => {
  const { client, close } = await fixture();
  const { tools } = await client.listTools();

  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [
      "get_parameter",
      "list_managed_namespaces",
      "list_parameters",
      "open_secrets_manager",
    ],
  );

  for (const tool of tools) {
    assert.equal(
      tool.annotations?.readOnlyHint,
      true,
      `${tool.name} must be readOnlyHint`,
    );
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

test("list_parameters returns paths, secret flags and NOTES, and never a secret value", async () => {
  const { client, close } = await fixture();

  const res = await client.callTool({
    name: "list_parameters",
    arguments: { namespace: NS },
  });
  const payload = JSON.parse(res.content[0].text);

  assert.equal(payload.count, 2);
  const byName = Object.fromEntries(payload.parameters.map((p) => [p.name, p]));

  assert.ok(byName[P_EMAIL], "the non-secret parameter is listed");
  assert.equal(byName[P_EMAIL].secret, false);
  assert.equal(byName[P_EMAIL].variable, "REMOTE_FS_SCREENSHOTS_GCS_CLIENT_EMAIL");

  assert.ok(byName[P_KEY], "the secret parameter is listed");
  assert.equal(byName[P_KEY].secret, true);
  assert.equal(byName[P_KEY].note, "rotate on staff change");
  assert.ok(byName[P_KEY].latestVersion, "the secret parameter has a version");

  // The listing is metadata only: no `value` field on any entry, and the secret's
  // bytes are nowhere in the response.
  for (const p of payload.parameters) {
    assert.equal(p.value, undefined, "list_parameters must not carry a value");
  }
  assert.ok(!JSON.stringify(res).includes(CANARY), "a secret value reached the listing");
  await close();
});

test("get_parameter returns a NON-secret value", async () => {
  const { client, close } = await fixture();
  const res = await client.callTool({
    name: "get_parameter",
    arguments: { name: P_EMAIL },
  });
  assert.ok(!res.isError, "reading a non-secret is allowed");
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.name, P_EMAIL);
  assert.equal(payload.secret, false);
  assert.equal(payload.value, EMAIL_VALUE);
  assert.equal(payload.note, "the GCS service account email; non-secret configuration");
  await close();
});

test("get_parameter on a SECRET parameter refuses, and returns no value", async () => {
  const { client, close } = await fixture();
  const res = await client.callTool({
    name: "get_parameter",
    arguments: { name: P_KEY },
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /is a SECRET parameter/);
  assert.match(res.content[0].text, /open_secrets_manager/);
  // Neither the secret bytes NOR the Secret Manager reference leak.
  assert.ok(!JSON.stringify(res).includes(CANARY));
  assert.ok(!JSON.stringify(res).includes("__REF__"));
  await close();
});

test("the namespace bounds the blast radius: strad's own parameters are invisible", async () => {
  const { client, close } = await fixture();

  // Not in the listing, even though the project contains it.
  const list = await client.callTool({
    name: "list_parameters",
    arguments: { namespace: NS },
  });
  assert.ok(!JSON.stringify(list).includes("STRAD_TOKENS"));
  assert.ok(!JSON.stringify(list).includes(CANARY_OUTSIDE));

  // An unmanaged namespace is refused rather than silently listed.
  const badNs = await client.callTool({
    name: "list_parameters",
    arguments: { namespace: "/strad/staging/core/" },
  });
  assert.equal(badNs.isError, true);
  assert.match(badNs.content[0].text, /not a managed namespace/);

  // get_parameter on a path outside the namespace is refused, not fetched.
  const badGet = await client.callTool({
    name: "get_parameter",
    arguments: { name: P_OUTSIDE },
  });
  assert.equal(badGet.isError, true);
  assert.match(badGet.content[0].text, /outside the managed namespaces/);
  assert.ok(!JSON.stringify(badGet).includes(CANARY_OUTSIDE));
  await close();
});

test("list_managed_namespaces states plainly that it cannot read a secret value", async () => {
  const { client, close } = await fixture();
  const res = await client.callTool({
    name: "list_managed_namespaces",
    arguments: {},
  });
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.canReadSecretValues, false);
  assert.deepEqual(payload.managedNamespaces, [NS]);
  assert.match(payload.whyNot, /secretmanager\.versions\.access/);
  await close();
});

test("calling EVERY tool with EVERY argument shape never yields a canary", async () => {
  const { client, close } = await fixture();
  const { tools } = await client.listTools();

  const attempts = [
    { name: "list_managed_namespaces", arguments: {} },
    { name: "list_parameters", arguments: { namespace: NS } },
    { name: "list_parameters", arguments: { namespace: "" } },
    { name: "get_parameter", arguments: { name: P_EMAIL } },
    { name: "get_parameter", arguments: { name: P_KEY } },
    { name: "get_parameter", arguments: { name: P_OUTSIDE } },
    { name: "open_secrets_manager", arguments: {} },
    { name: "open_secrets_manager", arguments: { secret: P_KEY } },
  ];
  assert.equal(new Set(attempts.map((a) => a.name)).size, tools.length);

  for (const attempt of attempts) {
    const res = await client.callTool(attempt);
    const blob = JSON.stringify(res);
    assert.ok(!blob.includes(CANARY), `${attempt.name} leaked a secret value`);
    assert.ok(
      !blob.includes(CANARY_OUTSIDE),
      `${attempt.name} leaked an out-of-namespace value`,
    );
  }
  await close();
});

test("open_secrets_manager returns a console deep link, not a value", async () => {
  const { client, close } = await fixture();
  const res = await client.callTool({
    name: "open_secrets_manager",
    arguments: { secret: P_KEY },
  });
  const payload = JSON.parse(res.content[0].text);
  assert.equal(
    payload.url,
    `https://staging.strad.tadasant.com/ui/secrets?param=${encodeURIComponent(P_KEY)}`,
  );
  await close();
});

test("the read client has no value-reading method — not on the surface, not at all", async () => {
  const { config, close } = await fixture();
  const client = new ParameterManagerReadClient({
    projectId: config.projectId,
    account: VIEWER_ACCOUNT,
    apiBase: config.apiBase,
    tokenUrl: config.tokenUrl,
  });
  // There is no render, no access, no getValue. getParameter returns an envelope
  // whose secret `value` is only ever a reference — never the bytes.
  assert.equal(typeof client.render, "undefined");
  assert.equal(typeof client.accessVersion, "undefined");
  assert.equal(typeof client.getValue, "undefined");

  const record = await client.getParameter(P_KEY);
  assert.equal(record.envelope.secret, true);
  assert.ok(record.envelope.value.startsWith("__REF__("));
  assert.ok(!record.envelope.value.includes(CANARY));
  await close();
});

test("the viewer enumerates versions and reads the greatest ENABLED one", async () => {
  // Parameter Manager has no `latest` alias, so the reader lists versions and
  // picks the greatest enabled `v{n}`. Seed a parameter whose NEWEST version
  // (v2) is disabled: the current value must come from v1, not v2.
  const projectId = "test-project";
  const path = "/strad/staging/mcp/echo/static/ECHO_PREFIX";
  const id = parameterId(path);
  const v1 = JSON.stringify({ path, secret: false, note: "the live one", value: "hello" });
  const v2 = JSON.stringify({ path, secret: false, note: "rolled back", value: "SUPERSEDED" });

  const fake = await startFakeParameterManager({
    projectId,
    parameters: new Map([
      [
        id,
        {
          labels: { "managed-by": "strad", secret: "false" },
          createTime: "2026-05-01T00:00:00Z",
          versions: [v1, v2],
          disabledVersions: [2], // v2 is disabled
        },
      ],
    ]),
  });

  const config = {
    projectId,
    namespaces: ["/strad/staging/mcp/"],
    account: VIEWER_ACCOUNT,
    apiBase: fake.apiBase,
    tokenUrl: fake.tokenUrl,
  };
  const { server, registerHandlers } = createMCPServer({ version: "0.0.0-test", config });
  await registerHandlers(server);
  const c = new Client({ name: "t", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), c.connect(ct)]);

  const res = await c.callTool({ name: "get_parameter", arguments: { name: path } });
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.value, "hello", "must read the greatest ENABLED version, not the disabled newer one");
  assert.equal(payload.note, "the live one");
  assert.ok(!JSON.stringify(res).includes("SUPERSEDED"));

  const listed = await c.callTool({
    name: "list_parameters",
    arguments: { namespace: "/strad/staging/mcp/" },
  });
  const lp = JSON.parse(listed.content[0].text).parameters[0];
  assert.equal(lp.latestVersion, "v1");
  await fake.close();
});

test("parameterId is deterministic, legal, and hash-truncates long paths", () => {
  const legal = (id) => /^[a-z][a-z0-9-]*$/.test(id) && id.length <= 63;

  // The two example paths are both > 63 chars folded, so both take the hash tail.
  const idEmail = parameterId(P_EMAIL);
  const idKey = parameterId(P_KEY);
  assert.ok(legal(idEmail), `illegal id: ${idEmail}`);
  assert.ok(legal(idKey), `illegal id: ${idKey}`);
  // The 54-char head is trimmed of trailing dashes before the hash tail joins,
  // so the id never carries a double dash — and stays byte-identical to the
  // src/ half, which addresses the same GCP resource.
  assert.ok(!idEmail.includes("--"), `double dash in ${idEmail}`);
  assert.ok(!idKey.includes("--"), `double dash in ${idKey}`);
  assert.equal(idEmail, "strad-staging-mcp-remote-fs-screenshots-static-remote-ca3865c5");
  assert.equal(idKey, "strad-staging-mcp-remote-fs-screenshots-static-remote-d0bc237a");
  // Deterministic: same input, same output; and the two distinct paths, which
  // share a 54-char head, are disambiguated by the hash tail.
  assert.equal(parameterId(P_EMAIL), idEmail);
  assert.notEqual(idEmail, idKey);
  assert.match(idEmail, /-[0-9a-f]{8}$/);

  // A short path stays readable (no hash, no p- prefix needed).
  const short = parameterId("/strad/staging/mcp/echo/static/ECHO_PREFIX");
  assert.ok(legal(short));
  assert.equal(short, "strad-staging-mcp-echo-static-echo-prefix");
});

test("config fails closed: no namespaces means no server, not every parameter", () => {
  assert.throws(
    () => loadConfig({ SECRETS_PROJECT_ID: "p" }),
    /must name at least one path prefix/,
  );
  assert.throws(() => loadConfig({}), /SECRETS_PROJECT_ID/);

  const cfg = loadConfig({
    SECRETS_PROJECT_ID: "p",
    SECRETS_NAMESPACES: "/strad/staging/mcp/, /strad/staging/other/ ",
  });
  assert.deepEqual(cfg.namespaces, ["/strad/staging/mcp/", "/strad/staging/other/"]);
  assert.equal(cfg.account, null);

  assert.ok(inManagedNamespace("/strad/staging/mcp/x/static/Y", cfg.namespaces));
  assert.ok(!inManagedNamespace("/strad/staging/core/static/STRAD_TOKENS", cfg.namespaces));
});

test("a malformed service-account key is reported by SHAPE, never by content", () => {
  assert.throws(
    () => parseAccount("{not json"),
    (err) => {
      assert.match(err.message, /not valid JSON/);
      assert.ok(!err.message.includes("not json"), "the error echoed the key material");
      return true;
    },
  );
  assert.throws(
    () => parseAccount(JSON.stringify({ client_email: "a@b" })),
    /missing client_email \/ private_key/,
  );
});

test("the tool descriptions tell the agent it cannot have a secret value", () => {
  const defs = toolDefinitions({ projectId: "p", namespaces: [NS], account: null });
  const get = defs.find((d) => d.name === "get_parameter");
  assert.match(get.description, /SECRET, this returns an error/);
  const list = defs.find((d) => d.name === "list_parameters");
  assert.match(list.description, /never a secret value/);
});
