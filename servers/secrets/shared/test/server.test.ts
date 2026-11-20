import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  createMCPServer,
  loadConfig,
  parseAccount,
  inManagedNamespace,
  storeForPath,
  toolDefinitions,
  parameterId,
  ParameterManagerReadClient,
  PROBE_PERMISSIONS,
} from "../src/index.js";
import {
  startFakeParameterManager,
  makeParameter,
  VIEWER_ACCOUNT,
} from "./fake-parameter-manager.js";

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
  "/strad/staging/mcp/remote-filesystem-tmp-public/static/REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_CLIENT_EMAIL";
const P_KEY =
  "/strad/staging/mcp/remote-filesystem-tmp-public/static/REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_PRIVATE_KEY";
const P_OUTSIDE = "/strad/staging/core/static/STRAD_TOKENS";
/**
 * A parameter of the `oauth` KIND — a credential strad MINTED through a console
 * consent, rather than one a human typed.
 *
 * It is inside the same `/strad/staging/mcp/` namespace this server is scoped
 * to, so it must be LISTED exactly as a `static` one is, and its value must be
 * as unreachable as any other secret parameter's. That pairing is the whole of
 * the viewer's half of the `oauth` kind: an agent can see that a slug has been
 * authorized, and can never read what it was authorized with.
 */
const P_OAUTH =
  "/strad/staging/mcp/google-sheets-personal-ro/oauth/GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN";

const EMAIL_VALUE = "remote-fs@strad-staging.iam.gserviceaccount.com";
/** The secret's bytes. They live only in Secret Manager and must never appear. */
const CANARY = "-----BEGIN PRIVATE KEY-----canary-DO-NOT-LEAK-9f3a2b";
/** The minted token's bytes. Same rule, and a separate canary so a leak names itself. */
const CANARY_OAUTH = "1//0e-REFRESH-TOKEN-canary-DO-NOT-LEAK-4c81d";
/** A second canary, on a parameter OUTSIDE the namespace. Also never appears. */
const CANARY_OUTSIDE = "strad-token-DO-NOT-LEAK-tttt";

/**
 * @param caps Capabilities to report, injected rather than probed.
 *
 * HERMETIC ON PURPOSE. Without this the probe runs for real and every
 * `tools/list` in this file makes a live HTTPS call to
 * cloudresourcemanager.googleapis.com — which passes only because it fails
 * closed, and which makes the suite depend on the network. Injecting also lets
 * the write surface be tested at all: the probe would never report it here.
 */
async function fixture(caps) {
  const projectId = "test-project";
  const secretId = "strad-staging-remote-filesystem-tmp-public-gcs-private-key";
  const oauthSecretId = "strad-staging-google-sheets-personal-ro-oauth-refresh-token";

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
    // The `oauth` kind: written by the console's consent callback, secret by
    // construction, and listed under the same namespace as everything else.
    makeParameter(projectId, {
      path: P_OAUTH,
      secret: true,
      secretId: oauthSecretId,
      note: "connected as personal@example.com via the strad console on 2026-09-11T00:00:00.000Z; granted: https://www.googleapis.com/auth/spreadsheets.readonly",
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
  const secretManager = new Map([
    [secretId, CANARY],
    [oauthSecretId, CANARY_OAUTH],
  ]);

  const fake = await startFakeParameterManager({
    projectId,
    parameters,
    secretManager,
  });

  const config = {
    stores: [
      {
        project: fake.projectId,
        namespaces: [NS],
        account: VIEWER_ACCOUNT,
        viewerKeyVar: "SECRETS_SERVICE_ACCOUNT_KEY_JSON",
      },
    ],
    consoleUrl: "https://staging.strad.tadasant.com/ui/secrets",
    apiBase: fake.apiBase,
    tokenUrl: fake.tokenUrl,
  };

  const { server, registerHandlers } = createMCPServer({
    version: "0.0.0-test",
    config,
    capabilities: () =>
      Promise.resolve(
        caps ?? {
          readSecretValues: false,
          writeParameters: false,
          writeSecretValues: false,
          deleteParameters: false,
          probed: true,
        },
      ),
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

/**
 * THE TOOL SURFACE IS DERIVED FROM THE CREDENTIAL, not from a config flag.
 *
 * `toolDefinitions` is the single place that decision is made, so it is asserted
 * directly: four permission shapes in, four surfaces out. The point of a probe
 * over a flag is that these cannot disagree with what Google will enforce, and
 * the fail-closed default is what protects a deployment whose probe cannot run.
 */
const CAPS = {
  none: {
    readSecretValues: false,
    writeParameters: false,
    writeSecretValues: false,
    deleteParameters: false,
    probed: true,
  },
  readWrite: {
    readSecretValues: true,
    writeParameters: true,
    writeSecretValues: true,
    deleteParameters: true,
    probed: true,
  },
  writeNonSecretOnly: {
    readSecretValues: false,
    writeParameters: true,
    writeSecretValues: false,
    deleteParameters: false,
    probed: true,
  },
  unprobed: {
    readSecretValues: false,
    writeParameters: false,
    writeSecretValues: false,
    deleteParameters: false,
    probed: false,
    reason: "cloudresourcemanager.googleapis.com is not enabled",
  },
};

/**
 * The same capability on every store this config fronts.
 *
 * `toolDefinitions` takes a MAP of project -> capability, because a capability
 * that is not keyed by a project is the collapse this server must not have. A
 * single-store config has a one-entry map; multi-store discrimination is
 * asserted in multi-store.test.ts.
 */
function capsMap(config, caps) {
  return new Map(config.stores.map((s) => [s.project, caps]));
}

test("the tool surface is derived from the credential's permissions", async () => {
  const { config, close } = await fixture();

  // Prod's viewer: the four read-only tools and nothing else.
  const readOnly = toolDefinitions(config, capsMap(config, CAPS.none)).map(
    (t) => t.name,
  );
  assert.deepEqual(readOnly.sort(), [
    "get_parameter",
    "list_managed_namespaces",
    "list_parameters",
    "open_secrets_manager",
  ]);

  // Staging's read-write credential: writes AND the value read appear.
  const full = toolDefinitions(config, capsMap(config, CAPS.readWrite)).map(
    (t) => t.name,
  );
  for (const name of [
    "create_parameter",
    "set_parameter_value",
    "set_parameter_note",
    "delete_parameter",
    "get_secret_value",
  ]) {
    assert.ok(full.includes(name), `expected ${name} with a read-write credential`);
  }

  // A credential that can write configuration but not secrets: writes are
  // offered, the value read is NOT, and delete is NOT.
  const partial = toolDefinitions(
    config,
    capsMap(config, CAPS.writeNonSecretOnly),
  ).map((t) => t.name);
  assert.ok(partial.includes("create_parameter"));
  assert.ok(!partial.includes("get_secret_value"));
  assert.ok(!partial.includes("delete_parameter"));
  // …and the description says so, rather than letting the call fail at Google.
  const create = toolDefinitions(
    config,
    capsMap(config, CAPS.writeNonSecretOnly),
  ).find((t) => t.name === "create_parameter");
  assert.match(create.description, /CANNOT be written by this deployment's credentials/);

  // FAIL CLOSED: an unrunnable probe yields the read-only surface, never more.
  assert.deepEqual(
    toolDefinitions(config, capsMap(config, CAPS.unprobed))
      .map((t) => t.name)
      .sort(),
    readOnly.sort(),
  );

  // And with no capabilities argument at all — the default — same thing.
  assert.deepEqual(
    toolDefinitions(config).map((t) => t.name).sort(),
    readOnly.sort(),
  );

  await close();
});

test("a write tool refuses when the probe says the credential cannot", async () => {
  // The listing is advisory; the handler is the gate. A client with a cached
  // tools/list from a moment ago must still be refused.
  const { fake, config } = await (async () => {
    const f = await fixture();
    return f;
  })();

  const { createMCPServer: make } = await import("../src/index.js");
  const { server, registerHandlers } = make({
    version: "test",
    config,
    capabilities: () => Promise.resolve(CAPS.none),
    writerFactory: () => {
      throw new Error("the writer must never be constructed when denied");
    },
  });
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await registerHandlers(server);
  await Promise.all([server.connect(st), client.connect(ct)]);

  const res = await client.callTool({
    name: "create_parameter",
    arguments: { name: `${NS}wired/static/NOPE`, value: "v" },
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /cannot write parameters/);
  await fake.close();
});

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

  assert.equal(payload.count, 3);
  const byName = Object.fromEntries(payload.parameters.map((p) => [p.name, p]));

  assert.ok(byName[P_EMAIL], "the non-secret parameter is listed");
  assert.equal(byName[P_EMAIL].secret, false);
  assert.equal(byName[P_EMAIL].variable, "REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_CLIENT_EMAIL");

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

test("an `oauth` kind parameter is listed as metadata, and its token is not", async () => {
  const { client, close } = await fixture();

  const res = await client.callTool({
    name: "list_parameters",
    arguments: { namespace: NS },
  });
  const payload = JSON.parse(res.content[0].text);
  const entry = payload.parameters.find((p) => p.name === P_OAUTH);

  // LISTED. A kind the viewer could not see would leave an agent unable to tell
  // a slug that has been authorized from one that never was.
  assert.ok(entry, "the oauth-kind parameter is listed");
  assert.equal(entry.secret, true);
  assert.equal(entry.variable, "GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN");
  assert.ok(entry.latestVersion, "it has a version");
  // The note strad wrote at consent time is safe metadata by construction: who
  // consented, what was granted, when. It is exactly what an agent needs to tell
  // a human whether to re-authorize.
  assert.match(entry.note, /connected as personal@example\.com/);
  assert.equal(entry.value, undefined, "a listing never carries a value");
  assert.ok(!JSON.stringify(res).includes(CANARY_OAUTH));

  // AND NEVER READABLE. Same refusal as any other secret parameter — the kind
  // buys the agent no new reach.
  const got = await client.callTool({
    name: "get_parameter",
    arguments: { name: P_OAUTH },
  });
  assert.equal(got.isError, true);
  assert.match(got.content[0].text, /is a SECRET parameter/);
  assert.ok(!JSON.stringify(got).includes(CANARY_OAUTH));
  assert.ok(!JSON.stringify(got).includes("__REF__"));
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
  assert.match(badGet.content[0].text, /outside every managed namespace/);
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
  assert.equal(payload.stores.length, 1);
  assert.equal(payload.stores[0].canReadSecretValues, false);
  assert.deepEqual(payload.stores[0].managedNamespaces, [NS]);
  assert.match(payload.stores[0].whyNot, /secretmanager\.versions\.access/);
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
    { name: "get_parameter", arguments: { name: P_OAUTH } },
    { name: "open_secrets_manager", arguments: {} },
    { name: "open_secrets_manager", arguments: { secret: P_KEY } },
    { name: "open_secrets_manager", arguments: { secret: P_OAUTH } },
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
    // The `oauth` kind is swept by the same canary rule as everything else: the
    // kind changes where a credential comes FROM, never what a tool may return.
    assert.ok(
      !blob.includes(CANARY_OAUTH),
      `${attempt.name} leaked a minted OAuth credential`,
    );
  }
  await close();
});

test("open_secrets_manager returns a console link, not a value", async () => {
  const { client, config, close } = await fixture();
  const res = await client.callTool({
    name: "open_secrets_manager",
    arguments: { secret: P_KEY },
  });
  const payload = JSON.parse(res.content[0].text);
  // The link names the store the path resolved to, and nothing finer: the
  // console has no per-parameter page, so the parameter is named in the
  // `instructions` instead. See console-link.test.ts.
  assert.equal(
    payload.url,
    `https://staging.strad.tadasant.com/ui/secrets?project=${config.stores[0].project}`,
  );
  assert.equal(payload.project, config.stores[0].project);
  assert.ok(payload.instructions.includes(P_KEY), payload.instructions);
  await close();
});

test("the read client has no value-reading method — not on the surface, not at all", async () => {
  const { config, close } = await fixture();
  const client = new ParameterManagerReadClient({
    projectId: config.stores[0].project,
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
    stores: [
      {
        project: projectId,
        namespaces: ["/strad/staging/mcp/"],
        account: VIEWER_ACCOUNT,
        viewerKeyVar: "SECRETS_SERVICE_ACCOUNT_KEY_JSON",
      },
    ],
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

test("the viewer lists a Zimmer-written parameter and skips an unlabelled one", async () => {
  // Zimmer writes the same envelope into the same stores, labelled
  // `managed-by=zimmer`. A listing keyed on `strad` alone hid it from both
  // doors while a create still collided with it.
  const projectId = "test-project";
  const ns = "/zimmer/production/secrets/";
  const zimmerPath = `${ns}static/OPENROUTER_API_KEY`;
  const foreignPath = `${ns}static/HAND_MADE`;
  const envelope = (path) =>
    JSON.stringify({
      path,
      secret: true,
      value: `__REF__("//secretmanager.googleapis.com/projects/${projectId}/secrets/${parameterId(path)}/versions/latest")`,
    });
  const fake = await startFakeParameterManager({
    projectId,
    parameters: new Map([
      [
        parameterId(zimmerPath),
        { labels: { "managed-by": "zimmer" }, createTime: "2026-11-01T00:00:00Z", versions: [envelope(zimmerPath)] },
      ],
      [
        parameterId(foreignPath),
        { labels: { "managed-by": "terraform" }, createTime: "2026-11-01T00:00:00Z", versions: [envelope(foreignPath)] },
      ],
    ]),
  });
  const client = new ParameterManagerReadClient({
    projectId,
    account: VIEWER_ACCOUNT,
    apiBase: fake.apiBase,
    tokenUrl: fake.tokenUrl,
  });
  const listed = await client.listParameters(ns);
  assert.deepEqual(
    listed.map((p) => [p.name, p.secret]),
    [[zimmerPath, true]],
  );
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
  // so the id never carries a double dash. The fold itself is vendored from the
  // src/ half (parameter-wire.ts), which addresses the same GCP resource; this
  // asserts the properties that fold has to have, from inside this tree.
  assert.ok(!idEmail.includes("--"), `double dash in ${idEmail}`);
  assert.ok(!idKey.includes("--"), `double dash in ${idKey}`);
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
  // No `mcpStores:` is still exactly one store, out of the same three variables,
  // with the same credential — every config written before this keeps working.
  assert.equal(cfg.stores.length, 1);
  const only = cfg.stores[0];
  assert.equal(only.project, "p");
  assert.equal(only.viewerKeyVar, "SECRETS_SERVICE_ACCOUNT_KEY_JSON");
  assert.deepEqual(only.namespaces, ["/strad/staging/mcp/", "/strad/staging/other/"]);
  assert.equal(only.account, null);

  assert.ok(inManagedNamespace("/strad/staging/mcp/x/static/Y", only.namespaces));
  assert.ok(!inManagedNamespace("/strad/staging/core/static/STRAD_TOKENS", only.namespaces));
  assert.equal(storeForPath("/strad/staging/mcp/x/static/Y", cfg.stores).store, only);
  assert.match(
    storeForPath("/strad/staging/core/static/STRAD_TOKENS", cfg.stores).error,
    /outside every managed namespace/,
  );
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
  const defs = toolDefinitions({
    stores: [
      {
        project: "p",
        namespaces: [NS],
        account: null,
        viewerKeyVar: "SECRETS_SERVICE_ACCOUNT_KEY_JSON",
      },
    ],
  });
  const get = defs.find((d) => d.name === "get_parameter");
  assert.match(get.description, /SECRET, this returns an error/);
  const list = defs.find((d) => d.name === "list_parameters");
  assert.match(list.description, /never a secret value/);
});

test("the write tool's description steers an agent away from the `oauth` kind", () => {
  // A path's kind segment decides WHO owns the value. `oauth/` belongs to the
  // console's consent callback and is read FIRST, so an agent that wrote a value
  // there would silently outrank the `static/` one a human set — and nothing
  // would fail. The tool description is the only place an agent learns that
  // before it picks a path, so it is asserted rather than left to prose.
  const defs = toolDefinitions(
    {
      stores: [
        {
          project: "p",
          namespaces: [NS],
          account: null,
          viewerKeyVar: "SECRETS_SERVICE_ACCOUNT_KEY_JSON",
        },
      ],
    },
    new Map([["p", CAPS.readWrite]]),
  );
  const create = defs.find((d) => d.name === "create_parameter");
  assert.ok(create, "the write tool is listed when the credential can write");
  const name = create.inputSchema.properties.name.description;
  assert.match(name, /<kind>/);
  assert.match(name, /oauth/);
  assert.match(name, /Write to "static"/);
});

/**
 * ONE probe per process, over MANY registerHandlers calls.
 *
 * The bundle host serves this mount statelessly: a fresh `Server` and a fresh
 * `registerHandlers` call for EVERY HTTP request. A memo declared inside that
 * function is therefore rebuilt per request, and this server's memo was — so
 * every `tools/list` in production carried an OAuth token mint plus a
 * `projects:testIamPermissions` round trip to Google, which is what made this
 * mount's listing several times slower than its peers'. Slow enough that it was
 * always the in-flight loser of the concurrent-listing race in
 * tadasant/strad#81.
 *
 * The probe is deliberately NOT stubbed through the `capabilities` seam here —
 * that seam bypasses the memo, so using it would assert nothing.
 */
test("the capability probe is memoised across registerHandlers calls", async () => {
  const { Server: SdkServer } = await import(
    "@modelcontextprotocol/sdk/server/index.js"
  );

  const json = (body) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });

  const probes = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.startsWith("http://token.invalid")) {
      return json({ access_token: "at", expires_in: 3600 });
    }
    if (href.includes(":testIamPermissions")) {
      probes.push(href);
      return json({ permissions: [] });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };

  try {
    const created = createMCPServer({
      version: "0.0.0-test",
      config: {
        stores: [
          {
            project: "p",
            namespaces: [NS],
            account: VIEWER_ACCOUNT,
            viewerKeyVar: "SECRETS_SERVICE_ACCOUNT_KEY_JSON",
          },
        ],
        consoleUrl: "https://example.invalid/ui/secrets",
        apiBase: "http://pm.invalid",
        tokenUrl: "http://token.invalid",
      },
    });

    for (let request = 0; request < 3; request += 1) {
      const server = new SdkServer(
        { name: "secrets-mcp-server", version: "0.0.0-test" },
        { capabilities: { tools: {} } },
      );
      await created.registerHandlers(server);
      const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(st), client.connect(ct)]);
      const { tools } = await client.listTools();
      assert.ok(tools.length > 0, "the listing must survive a failed probe");
      await client.close();
      await server.close();
    }

    assert.equal(
      probes.length,
      1,
      `Google was asked ${probes.length} times for one process's capabilities`,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// What the memo may remember, and for how long (tadasant/strad#270)
// ---------------------------------------------------------------------------

/**
 * The production symptom these two tests are about.
 *
 * `list_managed_namespaces` against prod returned, on every call, minutes apart:
 * `capabilitiesProbed: false`, every capability `false`, and
 * `"could not mint an access token (fetch failed)"` — while `list_parameters`
 * on the SAME container and the same session served 29 parameters perfectly. The
 * credential was fine and the egress was fine; ONE probe's token mint had failed
 * once, and the memo had remembered it as the answer for the life of the
 * process. The only cure was a redeploy.
 *
 * So the two halves, one test each: an absence expires, an ANSWER does not.
 *
 * Neither test stubs the `capabilities` seam — that seam bypasses the memo, so
 * using it here would assert nothing. Both drive the real probe against a faked
 * `fetch`, and both fake `Date` only: `probeCapabilities` arms a real
 * `setTimeout` for its abort, and faking that would hang the request.
 */

const MEMO_STORE = {
  project: "p",
  namespaces: [NS],
  account: VIEWER_ACCOUNT,
  viewerKeyVar: "SECRETS_SERVICE_ACCOUNT_KEY_JSON",
};

/** One request's worth of client: a fresh Server, exactly as the host serves it. */
async function askTheServer(created) {
  const { Server: SdkServer } =
    await import("@modelcontextprotocol/sdk/server/index.js");
  const server = new SdkServer(
    { name: "secrets-mcp-server", version: "0.0.0-test" },
    { capabilities: { tools: {} } },
  );
  await created.registerHandlers(server);
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const res = await client.callTool({
    name: "list_managed_namespaces",
    arguments: {},
  });
  const tools = (await client.listTools()).tools.map((t) => t.name);
  await client.close();
  await server.close();
  const report = JSON.parse(res.content[0].text);
  const byProject = new Map(report.stores.map((s) => [s.project, s]));
  return { store: report.stores[0], byProject, tools };
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

test("a probe that never reached Google is not remembered as the answer", async () => {
  const mints = [];
  const probes = [];
  let mintWorks = false;
  const realFetch = globalThis.fetch;
  const realErr = console.error;
  const logged = [];
  console.error = (...args) => void logged.push(args.join(" "));
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.startsWith("http://token.invalid")) {
      mints.push(href);
      // The production failure, verbatim: the mint never reaches Google.
      if (!mintWorks) throw new TypeError("fetch failed");
      return jsonResponse({ access_token: "at", expires_in: 3600 });
    }
    if (href.includes(":testIamPermissions")) {
      probes.push(href);
      return jsonResponse({ permissions: Object.values(PROBE_PERMISSIONS) });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
  vi.useFakeTimers({ toFake: ["Date"] });
  const t0 = Date.now();

  try {
    const created = createMCPServer({
      version: "0.0.0-test",
      config: {
        stores: [MEMO_STORE],
        consoleUrl: "https://example.invalid/ui/secrets",
        apiBase: "http://pm.invalid",
        tokenUrl: "http://token.invalid",
      },
    });

    // 1. The failed mint fails CLOSED for the call it happened on. That half of
    //    the behaviour is not what changed and must not change.
    const first = await askTheServer(created);
    assert.equal(first.store.capabilitiesProbed, false);
    assert.equal(first.store.canWrite, false);
    assert.equal(first.store.canReadSecretValues, false);
    assert.equal(first.store.canDelete, false);
    assert.match(first.store.whyNot, /could not mint an access token/);
    assert.ok(
      !first.tools.includes("create_parameter"),
      "an unestablished capability must not list a write tool",
    );
    assert.equal(mints.length, 1);
    assert.equal(probes.length, 0, "the probe never got past the mint");

    // 2. Within the TTL it is still a memo — an outage must not cost a mint per
    //    request, which is the regression the memo exists to prevent.
    vi.setSystemTime(t0 + 10_000);
    const second = await askTheServer(created);
    assert.equal(second.store.capabilitiesProbed, false);
    assert.equal(
      mints.length,
      1,
      `Google was asked ${mints.length} times inside one TTL`,
    );

    // 3. Past the TTL the next caller re-asks — and this time Google answers.
    //    Before the fix this call returned the remembered failure forever.
    mintWorks = true;
    vi.setSystemTime(t0 + 16_000);
    const third = await askTheServer(created);
    assert.equal(
      third.store.capabilitiesProbed,
      true,
      "a transient mint failure must not pin the store to NO_CAPABILITIES",
    );
    assert.equal(third.store.canWrite, true);
    assert.equal(third.store.canDelete, true);
    assert.equal(third.store.canReadSecretValues, true);
    assert.equal(third.store.whyNot, undefined);
    assert.ok(
      third.tools.includes("create_parameter"),
      "the recovered surface is the real one, not the fail-closed one",
    );
    assert.equal(probes.length, 1);

    // 4. And THAT answer is kept: an observation does not expire.
    vi.setSystemTime(t0 + 16_000 + 10 * 60_000);
    const fourth = await askTheServer(created);
    assert.equal(fourth.store.capabilitiesProbed, true);
    assert.equal(probes.length, 1, "a completed answer must not be re-asked");

    // 5. The degraded state says so on stderr. Nothing used to.
    assert.equal(
      logged.filter((line) => line.includes("did not complete")).length,
      1,
      `stderr carried ${logged.length} lines: ${logged.join(" | ")}`,
    );
    assert.match(logged[0], /\[secrets\] capability probe for "p"/);
    assert.match(logged[0], /could not mint an access token/);
    assert.match(logged[0], /failing closed, and the next call after 15s re-asks/);
  } finally {
    vi.useRealTimers();
    globalThis.fetch = realFetch;
    console.error = realErr;
  }
});

test("Google's explicit denial is a completed answer, and is still cached", async () => {
  const probes = [];
  const mints = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.startsWith("http://token.invalid")) {
      mints.push(href);
      return jsonResponse({ access_token: "at", expires_in: 3600 });
    }
    if (href.includes(":testIamPermissions")) {
      probes.push(href);
      // Google answered. What it said is "you hold none of these" — a viewer
      // credential, which is exactly prod's posture. `probed: true`.
      return jsonResponse({ permissions: [] });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
  vi.useFakeTimers({ toFake: ["Date"] });
  const t0 = Date.now();

  try {
    const created = createMCPServer({
      version: "0.0.0-test",
      config: {
        stores: [MEMO_STORE],
        consoleUrl: "https://example.invalid/ui/secrets",
        apiBase: "http://pm.invalid",
        tokenUrl: "http://token.invalid",
      },
    });

    const first = await askTheServer(created);
    assert.equal(first.store.capabilitiesProbed, true);
    assert.equal(first.store.canWrite, false);
    assert.match(first.store.whyNot, /denied by Google/);

    // An hour later, over several requests: still one probe. The fix must not
    // turn a denial into a round trip per call — a denial is an answer.
    for (const minutes of [2, 30, 60]) {
      vi.setSystemTime(t0 + minutes * 60_000);
      const again = await askTheServer(created);
      assert.equal(again.store.capabilitiesProbed, true);
      assert.equal(again.store.canWrite, false);
    }
    assert.equal(
      probes.length,
      1,
      `Google was asked ${probes.length} times for one answer it had already given`,
    );
    assert.equal(mints.length, 1);
  } finally {
    vi.useRealTimers();
    globalThis.fetch = realFetch;
  }
});

test("a probe that never settles fails closed on a deadline", async () => {
  // The token mint passes no abort signal, so a connection that HANGS rather
  // than fails hangs for as long as the socket does — and every concurrent
  // listing shares that one promise. Without a deadline the memo would never
  // expire either: `expiresAt` stays Infinity until the probe settles, so the
  // retry this whole change is about would never fire.
  const realFetch = globalThis.fetch;
  const signals = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.startsWith("http://token.invalid")) {
      signals.push(init?.signal);
      // Never settles. Not a rejection — a stall.
      return new Promise(() => {});
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
  const realErr = console.error;
  console.error = () => {};
  vi.useFakeTimers();

  try {
    const created = createMCPServer({
      version: "0.0.0-test",
      config: {
        stores: [MEMO_STORE],
        consoleUrl: "https://example.invalid/ui/secrets",
        apiBase: "http://pm.invalid",
        tokenUrl: "http://token.invalid",
      },
    });

    const inFlight = askTheServer(created);
    await vi.advanceTimersByTimeAsync(6_000);
    const { store, tools } = await inFlight;

    assert.equal(store.capabilitiesProbed, false);
    assert.equal(store.canWrite, false);
    assert.match(store.whyNot, /did not answer within 6s/);
    assert.ok(
      !tools.includes("create_parameter"),
      "a stalled probe must not open anything",
    );
    assert.ok(
      tools.includes("list_parameters"),
      "and the read-only surface is served rather than withheld",
    );

    // The request is cancelled, not merely abandoned. `probeCapabilities` builds
    // its own AbortController only AFTER the mint returns, so on this path
    // nothing of its own ever fires: a fresh socket every fifteen seconds would
    // pile up until undici timed each one out.
    assert.equal(signals.length, 1);
    assert.equal(
      signals[0]?.aborted,
      true,
      "the abandoned mint must be aborted, not left running",
    );
  } finally {
    vi.useRealTimers();
    globalThis.fetch = realFetch;
    console.error = realErr;
  }
});

test("a persistent probe fault is logged once, not once per retry", async () => {
  // A store whose probe fails deterministically — Cloud Resource Manager not
  // enabled, a revoked key — fails on every retry for the life of the container.
  // A line each time is thousands a day saying one thing, so the log is on the
  // transition: the first failure, and any CHANGE of reason.
  let status = 403;
  const realFetch = globalThis.fetch;
  const realErr = console.error;
  const logged = [];
  console.error = (...args) => void logged.push(args.join(" "));
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.startsWith("http://token.invalid")) {
      return jsonResponse({ access_token: "at", expires_in: 3600 });
    }
    if (href.includes(":testIamPermissions")) {
      return new Response("nope", { status });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
  vi.useFakeTimers({ toFake: ["Date"] });
  const t0 = Date.now();

  try {
    const created = createMCPServer({
      version: "0.0.0-test",
      config: {
        stores: [MEMO_STORE],
        consoleUrl: "https://example.invalid/ui/secrets",
        apiBase: "http://pm.invalid",
        tokenUrl: "http://token.invalid",
      },
    });

    // Four probes, one reason, over a minute.
    for (const seconds of [0, 16, 32, 48]) {
      vi.setSystemTime(t0 + seconds * 1000);
      const { store } = await askTheServer(created);
      assert.equal(store.capabilitiesProbed, false);
      assert.match(store.whyNot, /testIamPermissions returned 403/);
    }
    assert.equal(
      logged.length,
      1,
      `stderr carried ${logged.length} lines for one unchanged fault`,
    );
    assert.match(logged[0], /testIamPermissions returned 403/);

    // A DIFFERENT reason is news, and says so.
    status = 500;
    vi.setSystemTime(t0 + 64_000);
    await askTheServer(created);
    assert.equal(logged.length, 2);
    assert.match(logged[1], /testIamPermissions returned 500/);
  } finally {
    vi.useRealTimers();
    globalThis.fetch = realFetch;
    console.error = realErr;
  }
});

test("one store's absence expiring does not disturb another's answer", async () => {
  // The lifetime is a SECOND axis on the guarantee this file's multi-store
  // sibling is about: not just "one store's answer is never served for another",
  // but "one store's retry is never another's". Both maps — the memo and the
  // logged-fault map — are keyed by project id, and this is what says so.
  const probes = [];
  let aWorks = false;
  const realFetch = globalThis.fetch;
  const realErr = console.error;
  console.error = () => {};
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.startsWith("http://token.invalid")) {
      return jsonResponse({ access_token: "at", expires_in: 3600 });
    }
    if (href.includes(":testIamPermissions")) {
      const project = href.includes("pa") ? "pa" : "pb";
      probes.push(project);
      if (project === "pb") return jsonResponse({ permissions: [] });
      return aWorks
        ? jsonResponse({ permissions: Object.values(PROBE_PERMISSIONS) })
        : new Response("nope", { status: 500 });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
  vi.useFakeTimers({ toFake: ["Date"] });
  const t0 = Date.now();

  try {
    const created = createMCPServer({
      version: "0.0.0-test",
      config: {
        stores: [
          { ...MEMO_STORE, project: "pa", namespaces: ["/strad/a/mcp/"] },
          {
            ...MEMO_STORE,
            project: "pb",
            namespaces: ["/strad/b/mcp/"],
            account: {
              client_email: "second@example.iam.gserviceaccount.com",
              private_key: VIEWER_ACCOUNT.private_key,
            },
          },
        ],
        consoleUrl: "https://example.invalid/ui/secrets",
        apiBase: "http://pm.invalid",
        tokenUrl: "http://token.invalid",
      },
    });

    const first = await askTheServer(created);
    assert.equal(first.byProject.get("pa").capabilitiesProbed, false);
    assert.equal(first.byProject.get("pb").capabilitiesProbed, true);
    assert.equal(first.byProject.get("pb").canWrite, false);

    // pa's absence expires and is re-asked; pb's answer is an answer and is not.
    aWorks = true;
    vi.setSystemTime(t0 + 16_000);
    const second = await askTheServer(created);
    assert.equal(second.byProject.get("pa").capabilitiesProbed, true);
    assert.equal(second.byProject.get("pa").canWrite, true);
    assert.equal(second.byProject.get("pb").capabilitiesProbed, true);
    assert.equal(
      second.byProject.get("pb").canWrite,
      false,
      "pa recovering must not hand pb a capability Google never granted",
    );
    assert.deepEqual(probes, ["pa", "pb", "pa"]);
  } finally {
    vi.useRealTimers();
    globalThis.fetch = realFetch;
    console.error = realErr;
  }
});

test("concurrent callers share one in-flight probe", async () => {
  // A memo whose entry only becomes shareable once it RESOLVES would let every
  // request in a cold-start burst mint its own token. The entry is installed
  // before the probe settles, so N concurrent listings are one round trip.
  let releaseMint;
  const gate = new Promise((resolve) => {
    releaseMint = resolve;
  });
  const mints = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.startsWith("http://token.invalid")) {
      mints.push(href);
      await gate;
      throw new TypeError("fetch failed");
    }
    throw new Error(`unexpected fetch: ${href}`);
  };

  try {
    const created = createMCPServer({
      version: "0.0.0-test",
      config: {
        stores: [MEMO_STORE],
        consoleUrl: "https://example.invalid/ui/secrets",
        apiBase: "http://pm.invalid",
        tokenUrl: "http://token.invalid",
      },
    });
    const inFlight = [askTheServer(created), askTheServer(created)];
    // Both requests are parked on the same mint before it is allowed to fail.
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseMint();
    const [a, b] = await Promise.all(inFlight);
    assert.equal(a.store.capabilitiesProbed, false);
    assert.equal(b.store.capabilitiesProbed, false);
    assert.equal(
      mints.length,
      1,
      `${mints.length} concurrent callers each minted their own token`,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// refresh_gateway — the agent's copy of the console's "Re-read the store"
// ---------------------------------------------------------------------------

/**
 * The gateway holds one reading of the store per process for its TTL. A write
 * through THIS server goes through a client of its own, so the gateway learns
 * nothing until the reading ages out — unless it is told. The host hands in a
 * hook that can tell it; these tests pin what the surface does with it.
 */
async function fixtureWithRefresh(opts) {
  // No store behind it: the tools under test never read one, and the writer
  // is a stub that records what landed. What is under test is the seam
  // between a write and the gateway, not the write itself.
  const writes = [];
  const writer = {
    create: async (input) => void writes.push(["create", input.path]),
    rotate: async (path) => void writes.push(["rotate", path]),
    setNote: async (path) => void writes.push(["note", path]),
    destroy: async (path) => void writes.push(["destroy", path]),
    readValue: async () => {
      throw new Error("not under test");
    },
  };
  const config = {
    stores: [
      {
        project: "test-project",
        namespaces: [NS],
        account: VIEWER_ACCOUNT,
        viewerKeyVar: "SECRETS_SERVICE_ACCOUNT_KEY_JSON",
      },
    ],
    consoleUrl: "https://strad.example/ui/secrets",
  };
  const { server, registerHandlers } = createMCPServer({
    version: "0.0.0-test",
    config,
    capabilities: () => Promise.resolve(opts.caps ?? CAPS.none),
    refreshGateway: opts.refresh,
    writerFactory: () => writer,
  });
  await registerHandlers(server);
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, writes, close: () => client.close() };
}

test("refresh_gateway is offered only when the host can reach core", async () => {
  // Without a hook the surface is exactly what it was: a listed tool that
  // fails on every call is worse than none.
  const without = await fixtureWithRefresh({});
  const before = (await without.client.listTools()).tools.map((t) => t.name);
  assert.ok(!before.includes("refresh_gateway"));
  await without.close();

  // With one, it is offered on the read-only credential too: it reads and
  // writes nothing in the store, it only makes the gateway's next read reach it.
  const withHook = await fixtureWithRefresh({
    refresh: async () => ({ refreshed: true }),
  });
  const after = (await withHook.client.listTools()).tools;
  const tool = after.find((t) => t.name === "refresh_gateway");
  assert.ok(tool, "refresh_gateway must be listed when the host can reach core");
  assert.equal(tool.annotations?.readOnlyHint, true);
  assert.match(tool.description, /once every 30 seconds/);
  await withHook.close();
});

test("refresh_gateway calls the hook and reports what the gateway did", async () => {
  let calls = 0;
  let outcome = { refreshed: true };
  const { client, close } = await fixtureWithRefresh({
    refresh: async () => {
      calls += 1;
      return outcome;
    },
  });

  const ok = await client.callTool({ name: "refresh_gateway", arguments: {} });
  assert.equal(ok.isError, undefined);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(ok.content[0].text).refreshed, true);

  // A floored or failed refresh is an OUTCOME the agent can read — not a
  // throw, not a tool error, and never a claim that it landed. Nothing is
  // broken when the gateway keeps a reading it took a moment ago.
  outcome = { refreshed: false, reason: "core re-read the store 4s ago" };
  const held = await client.callTool({ name: "refresh_gateway", arguments: {} });
  assert.equal(held.isError, undefined);
  const payload = JSON.parse(held.content[0].text);
  assert.equal(payload.refreshed, false);
  assert.equal(payload.reason, "core re-read the store 4s ago");
  assert.match(payload.note, /within gateway\.secrets\.ttlSeconds/);
  assert.equal(calls, 2);
  await close();
});

test("a write through this server tells the gateway, and says whether it listened", async () => {
  let calls = 0;
  const { client, close } = await fixtureWithRefresh({
    caps: CAPS.readWrite,
    refresh: async () => {
      calls += 1;
      return calls === 1
        ? { refreshed: true }
        : { refreshed: false, reason: "core re-read the store 1s ago" };
    },
  });
  const path = `${NS}wired/static/ROTATES`;

  const created = await client.callTool({
    name: "create_parameter",
    arguments: { name: path, value: "v1", secret: false },
  });
  assert.equal(created.isError, undefined);
  assert.equal(calls, 1);
  assert.match(JSON.parse(created.content[0].text).gateway, /dropped its reading/);

  const rotated = await client.callTool({
    name: "set_parameter_value",
    arguments: { name: path, value: "v2" },
  });
  assert.equal(rotated.isError, undefined, "a floored refresh must not fail the write");
  assert.equal(calls, 2);
  assert.match(
    JSON.parse(rotated.content[0].text).gateway,
    /was not made to re-read it now \(core re-read the store 1s ago\)/,
  );

  // A note is metadata the gateway never reads: no call.
  await client.callTool({
    name: "set_parameter_note",
    arguments: { name: path, note: "n" },
  });
  assert.equal(calls, 2);

  const deleted = await client.callTool({
    name: "delete_parameter",
    arguments: { name: path },
  });
  assert.equal(deleted.isError, undefined);
  assert.equal(calls, 3);
  await close();
});

test("a write with no hook says the TTL will land it, and claims no more", async () => {
  const { client, close } = await fixtureWithRefresh({ caps: CAPS.readWrite });
  const res = await client.callTool({
    name: "create_parameter",
    arguments: { name: `${NS}wired/static/QUIET`, value: "v", secret: false },
  });
  assert.equal(res.isError, undefined);
  assert.match(
    JSON.parse(res.content[0].text).gateway,
    /within gateway\.secrets\.ttlSeconds; this server cannot reach it/,
  );
  await close();
});
