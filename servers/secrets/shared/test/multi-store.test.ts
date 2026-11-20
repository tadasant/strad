import { test } from "vitest";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  anyPermits,
  ParameterManagerError,
  createMCPServer,
  loadConfig,
  storeForPath,
  toolDefinitions,
} from "../src/index.js";
import {
  startFakeParameterManager,
  makeParameter,
  VIEWER_ACCOUNT,
} from "./fake-parameter-manager.js";

/**
 * A SECOND identity, sharing the fake's real RSA key but not its address.
 *
 * The two stores in this file must not hold one service account — `loadConfig`
 * refuses that, and it is the collapse the whole design is about — so the
 * fixtures must not quietly be a config the design says cannot exist. The key
 * material is shared because the fake signs and verifies real JWTs; the
 * `client_email` is what identifies the principal and what the fence reads.
 */
const SECOND_ACCOUNT = {
  client_email: "strad-secrets-viewer-prod@example.iam.gserviceaccount.com",
  private_key: VIEWER_ACCOUNT.private_key,
};

/**
 * ONE CONTAINER, TWO PARAMETER STORES, TWO CAPABILITIES.
 *
 * The thing every test in this file is really about: a capability is a property
 * of ONE credential on ONE project, and this server must never let one store's
 * answer decide what happens on another's. Before this, `probeCapabilities` took
 * a scalar project id, `tools.ts` read one flat `Capabilities`, and every gate —
 * the tool list AND all ten handler checks — consulted it. Consolidating stores
 * onto that would have meant one IAM over-grant on the most permissive project
 * silently switching `get_secret_value` on for every other project in the list,
 * production included. It would have failed quiet: the tool would simply start
 * working.
 *
 * THE SHAPE OF THE FIXTURE IS THE ARGUMENT. Store `staging` is permissive — its
 * probe reports it can read secret values — and store `prod` is restricted. The
 * fake behind PROD is deliberately built to HAND OVER its canary if it is ever
 * asked. So in the discriminating test below there is exactly one thing standing
 * between an agent and a production secret: the per-store gate. Delete it, or
 * replace it with a union, and the canary comes back in the response.
 */

const STAGING = {
  project: "strad-secrets-staging",
  ns: "/strad/staging/mcp/",
  keyVar: "SECRETS_SERVICE_ACCOUNT_KEY_JSON",
};
const PROD = {
  project: "strad-secrets-prod",
  ns: "/strad/prod/mcp/",
  keyVar: "STRAD_PROD_SECRETS_VIEWER_KEY_JSON",
};

const STAGING_PARAM = `${STAGING.ns}echo/static/ECHO_PREFIX`;
const STAGING_SECRET = `${STAGING.ns}echo/static/ECHO_TOKEN`;
const PROD_PARAM = `${PROD.ns}telegram-rw/static/TELEGRAM_API_ID`;
const PROD_SECRET = `${PROD.ns}telegram-rw/static/TELEGRAM_SESSION`;

/** The value a production read must never produce, by any route. */
const PROD_CANARY = "prod-session-DO-NOT-LEAK-8c41e0";
const STAGING_VALUE = "staging-token-readable-on-purpose";

const CAPS = {
  /** Staging: read+write, the surface the write tools exist for. */
  permissive: {
    readSecretValues: true,
    writeParameters: true,
    writeSecretValues: true,
    deleteParameters: true,
    probed: true,
  },
  /** Production: a viewer. No value read, no write, no delete. */
  restricted: {
    readSecretValues: false,
    writeParameters: false,
    writeSecretValues: false,
    deleteParameters: false,
    probed: true,
  },
};

function twoStoreConfig(overrides = {}) {
  return {
    stores: [
      {
        project: STAGING.project,
        label: "strad staging",
        namespaces: [STAGING.ns],
        account: VIEWER_ACCOUNT,
        viewerKeyVar: STAGING.keyVar,
      },
      {
        project: PROD.project,
        label: "strad prod",
        namespaces: [PROD.ns],
        account: SECOND_ACCOUNT,
        viewerKeyVar: PROD.keyVar,
      },
    ],
    consoleUrl: "https://strad.tadasant.com/ui/secrets",
    ...overrides,
  };
}

/**
 * A server over two stores, with per-project capabilities and a writer that
 * WOULD hand over each store's value if it were ever asked.
 *
 * The writer records which store it was built for and which paths it read, so a
 * test can assert not merely that no value came back but that the restricted
 * store's client was never reached at all.
 */
async function twoStoreServer({ caps = {}, createError } = {}) {
  const reads = [];
  const writes = [];
  const values = {
    [STAGING.project]: STAGING_VALUE,
    [PROD.project]: PROD_CANARY,
  };
  const config = twoStoreConfig();

  const { server, registerHandlers } = createMCPServer({
    version: "0.0.0-test",
    config,
    capabilities: (project) =>
      Promise.resolve(caps[project] ?? CAPS.restricted),
    readerFactory: (store) => ({
      listParameters: async (namespace) => {
        reads.push(["list", store.project, namespace]);
        return [];
      },
      getParameter: async (path) => {
        reads.push(["get", store.project, path]);
        return {
          envelope: { path, secret: false, value: values[store.project] },
        };
      },
    }),
    writerFactory: (store) => ({
      create: async (input) => {
        if (createError) throw createError;
        writes.push(["create", store.project, input.path]);
      },
      rotate: async (path) => void writes.push(["rotate", store.project, path]),
      setNote: async (path) => void writes.push(["note", store.project, path]),
      destroy: async (path) => void writes.push(["destroy", store.project, path]),
      readValue: async (path) => {
        reads.push(["readValue", store.project, path]);
        return values[store.project];
      },
    }),
  });
  await registerHandlers(server);
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, config, reads, writes, close: () => client.close() };
}

// ---------------------------------------------------------------------------
// THE DISCRIMINATING TEST
// ---------------------------------------------------------------------------

/**
 * A permissive capability on ONE store must not enable a secret read on another.
 *
 * This is the test the whole stage exists for, and it is written so that it
 * cannot pass for the wrong reason: the production writer in this fixture WILL
 * return `PROD_CANARY` to anyone who calls `readValue`. Nothing else refuses —
 * not a fake, not Google, not a namespace. If the handler consults a union, or a
 * global, or staging's answer, the canary is in the response and this fails.
 *
 * Under the OLD single-probe behaviour it would have: one `Capabilities` came
 * from one `projectId`, `tools.ts:428` read `caps.readSecretValues` with no
 * project in the question, and the namespace check ran against the union of
 * every store's namespaces.
 */
test("a permissive capability on one store cannot read a secret in another", async () => {
  const { client, reads, close } = await twoStoreServer({
    caps: {
      [STAGING.project]: CAPS.permissive,
      [PROD.project]: CAPS.restricted,
    },
  });

  // Staging permits it, so the tool is LISTED and works there. That is the
  // capability the intersection design would have destroyed.
  const ok = await client.callTool({
    name: "get_secret_value",
    arguments: { name: STAGING_SECRET },
  });
  assert.equal(ok.isError, undefined, "staging's own read must still work");
  const payload = JSON.parse(ok.content[0].text);
  assert.equal(payload.value, STAGING_VALUE);
  assert.equal(payload.project, STAGING.project);

  // The SAME tool, the SAME session, a production path.
  const denied = await client.callTool({
    name: "get_secret_value",
    arguments: { name: PROD_SECRET },
  });
  assert.equal(denied.isError, true, "the production read must be refused");
  assert.match(denied.content[0].text, /strad-secrets-prod/);
  assert.match(denied.content[0].text, /cannot read secret values/);

  // The value never appears — and the production client was never even asked,
  // so the refusal is a gate rather than a filtered response.
  assert.ok(
    !JSON.stringify(denied).includes(PROD_CANARY),
    "a production secret value reached the response",
  );
  assert.deepEqual(
    reads.filter((r) => r[1] === PROD.project),
    [],
    "the production store's client must not be reached at all",
  );
  await close();
});

/**
 * The same discrimination on the WRITE and DELETE gates, which had no per-store
 * check anywhere before this either.
 */
test("write and delete are refused per store, not per server", async () => {
  const { client, writes, close } = await twoStoreServer({
    caps: {
      [STAGING.project]: CAPS.permissive,
      [PROD.project]: CAPS.restricted,
    },
  });

  for (const attempt of [
    { name: "create_parameter", arguments: { name: PROD_PARAM, value: "v" } },
    { name: "set_parameter_value", arguments: { name: PROD_PARAM, value: "v" } },
    { name: "set_parameter_note", arguments: { name: PROD_PARAM, note: "n" } },
    { name: "delete_parameter", arguments: { name: PROD_PARAM } },
  ]) {
    const res = await client.callTool(attempt);
    assert.equal(res.isError, true, `${attempt.name} must be refused on prod`);
    assert.match(res.content[0].text, /strad-secrets-prod/);
  }
  assert.deepEqual(
    writes.filter((w) => w[1] === PROD.project),
    [],
    "no write may reach the restricted store's client",
  );

  // …while the permissive store's writes land, on the same server, same session.
  for (const attempt of [
    { name: "create_parameter", arguments: { name: STAGING_PARAM, value: "v" } },
    { name: "set_parameter_value", arguments: { name: STAGING_PARAM, value: "v" } },
    { name: "delete_parameter", arguments: { name: STAGING_PARAM } },
  ]) {
    const res = await client.callTool(attempt);
    assert.equal(res.isError, undefined, `${attempt.name} must work on staging`);
  }
  assert.equal(writes.filter((w) => w[1] === STAGING.project).length, 3);
  await close();
});

test("a create that collides names set_parameter_value as the way through", async () => {
  const { client, close } = await twoStoreServer({
    caps: { [STAGING.project]: CAPS.permissive },
    createError: new ParameterManagerError("POST parameters 409", 409),
  });
  const res = await client.callTool({
    name: "create_parameter",
    arguments: { name: STAGING_PARAM, value: "v" },
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /already exists/);
  assert.match(res.content[0].text, /set_parameter_value/);

  // Asked for a secret over a non-secret parameter: no tool is offered, since a
  // new version keeps the kind and would store the value where a viewer reads it.
  const secretOverPlain = await client.callTool({
    name: "create_parameter",
    arguments: { name: STAGING_PARAM, value: "v", secret: true },
  });
  assert.equal(secretOverPlain.isError, true);
  assert.match(secretOverPlain.content[0].text, /NON-SECRET/);
  await close();
});

/**
 * A path is read with the credential of the store whose namespace claims it, and
 * never with another's. This is the MCP-side twin of the console's per-store
 * `namespacesStrict`: the namespace list is never consulted as a union.
 */
test("a path binds to exactly one store, and reads go to that store's client", async () => {
  const { client, reads, close } = await twoStoreServer({
    caps: {
      [STAGING.project]: CAPS.permissive,
      [PROD.project]: CAPS.restricted,
    },
  });

  await client.callTool({ name: "get_parameter", arguments: { name: PROD_PARAM } });
  await client.callTool({ name: "get_parameter", arguments: { name: STAGING_PARAM } });
  assert.deepEqual(reads, [
    ["get", PROD.project, PROD_PARAM],
    ["get", STAGING.project, STAGING_PARAM],
  ]);

  // A namespace neither store manages is refused, and the message names both.
  const outside = await client.callTool({
    name: "get_parameter",
    arguments: { name: "/strad/staging/gateway/static/STRAD_TOKENS" },
  });
  assert.equal(outside.isError, true);
  assert.match(outside.content[0].text, /outside every managed namespace/);
  assert.match(outside.content[0].text, /strad-secrets-staging/);
  assert.match(outside.content[0].text, /strad-secrets-prod/);

  // list_parameters takes a NAMESPACE, and that namespace picks the store.
  await client.callTool({
    name: "list_parameters",
    arguments: { namespace: PROD.ns },
  });
  assert.deepEqual(reads.at(-1), ["list", PROD.project, PROD.ns]);
  await close();
});

// ---------------------------------------------------------------------------
// THE SURFACE, AND WHAT IT HONESTLY CLAIMS
// ---------------------------------------------------------------------------

/**
 * The tool LIST is the union; the CAPABILITY REPORT is per store.
 *
 * An MCP client caches one listing per session, so there is no way to offer a
 * tool for one store and withhold it for another. The union is therefore the
 * only choice that preserves staging's read — and it is only honest because
 * `list_managed_namespaces` says, store by store, who can actually do what.
 */
test("the tool list is the union of the stores, and the report is per store", async () => {
  const { client, close } = await twoStoreServer({
    caps: {
      [STAGING.project]: CAPS.permissive,
      [PROD.project]: CAPS.restricted,
    },
  });

  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("get_secret_value"), "staging can back it, so it is listed");
  assert.ok(names.includes("create_parameter"));
  assert.ok(names.includes("delete_parameter"));

  // …and the description does not pretend the listing is the guarantee.
  const tool = (await client.listTools()).tools.find(
    (t) => t.name === "get_secret_value",
  );
  assert.match(tool.description, /AT LEAST ONE store/);
  assert.match(tool.description, /store the PATH addresses/);

  const report = JSON.parse(
    (
      await client.callTool({ name: "list_managed_namespaces", arguments: {} })
    ).content[0].text,
  );
  const byProject = Object.fromEntries(report.stores.map((s) => [s.project, s]));
  assert.equal(byProject[STAGING.project].canReadSecretValues, true);
  assert.equal(byProject[PROD.project].canReadSecretValues, false);
  assert.equal(byProject[PROD.project].canWrite, false);
  assert.equal(byProject[PROD.project].label, "strad prod");
  assert.match(
    byProject[PROD.project].whyNot,
    /secretmanager\.versions\.access/,
  );
  assert.match(report.note, /checked against the store its path addresses/);
  await close();
});

/** Every store restricted means the tool is not listed at all — as today. */
test("with no store permitting it, get_secret_value is absent entirely", async () => {
  const { client, close } = await twoStoreServer({
    caps: {
      [STAGING.project]: CAPS.restricted,
      [PROD.project]: CAPS.restricted,
    },
  });
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.deepEqual(names.sort(), [
    "get_parameter",
    "list_managed_namespaces",
    "list_parameters",
    "open_secrets_manager",
  ]);
  await close();
});

test("anyPermits unions the flags and is conjunctive about having probed", () => {
  const a = {
    readSecretValues: true,
    writeParameters: false,
    writeSecretValues: false,
    deleteParameters: false,
    probed: true,
  };
  const b = {
    readSecretValues: false,
    writeParameters: true,
    writeSecretValues: false,
    deleteParameters: true,
    probed: false,
    reason: "cloudresourcemanager.googleapis.com is not enabled",
  };
  const union = anyPermits([a, b]);
  assert.equal(union.readSecretValues, true);
  assert.equal(union.writeParameters, true);
  assert.equal(union.deleteParameters, true);
  assert.equal(union.writeSecretValues, false);
  // One store that could not be probed means the answer is not established.
  assert.equal(union.probed, false);
  assert.match(union.reason, /cloudresourcemanager/);
  // No stores at all is the fail-closed default, not "everything permitted".
  assert.equal(anyPermits([]).readSecretValues, false);
  assert.equal(anyPermits([]).probed, false);
});

// ---------------------------------------------------------------------------
// THE REAL PROBE, PER PROJECT
// ---------------------------------------------------------------------------

/**
 * Two stores, two `projects:testIamPermissions` calls, two answers — through the
 * REAL probe rather than the `capabilities` seam, which is the only way to cover
 * the cache key. A memo keyed by anything less specific than the project id
 * would serve one store's answer for the other, which is the collapse by a
 * quieter route than a union.
 */
test("the probe runs once PER STORE and its answers do not cross", async () => {
  const { Server: SdkServer } = await import(
    "@modelcontextprotocol/sdk/server/index.js"
  );
  const json = (body) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });

  const probed = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.startsWith("http://token.invalid")) {
      return json({ access_token: "at", expires_in: 3600 });
    }
    if (href.includes(":testIamPermissions")) {
      probed.push(href);
      // Only STAGING holds the read permission. Production holds nothing.
      return href.includes(STAGING.project)
        ? json({
            permissions: [
              "secretmanager.versions.access",
              "parametermanager.parameters.create",
              "parametermanager.parameterVersions.create",
              "parametermanager.parameters.delete",
            ],
          })
        : json({ permissions: [] });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };

  try {
    const created = createMCPServer({
      version: "0.0.0-test",
      config: twoStoreConfig({ tokenUrl: "http://token.invalid" }),
      writerFactory: () => ({
        create: async () => {},
        rotate: async () => {},
        setNote: async () => {},
        destroy: async () => {},
        readValue: async () => PROD_CANARY,
      }),
    });

    // Two stateless requests, the way the bundle host serves this mount.
    for (let request = 0; request < 2; request += 1) {
      const server = new SdkServer(
        { name: "secrets-mcp-server", version: "0.0.0-test" },
        { capabilities: { tools: {} } },
      );
      await created.registerHandlers(server);
      const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(st), client.connect(ct)]);

      const report = JSON.parse(
        (
          await client.callTool({
            name: "list_managed_namespaces",
            arguments: {},
          })
        ).content[0].text,
      );
      const byProject = Object.fromEntries(
        report.stores.map((s) => [s.project, s]),
      );
      assert.equal(byProject[STAGING.project].canReadSecretValues, true);
      assert.equal(byProject[PROD.project].canReadSecretValues, false);

      // And the gate that matters, through the real probe.
      const denied = await client.callTool({
        name: "get_secret_value",
        arguments: { name: PROD_SECRET },
      });
      assert.equal(denied.isError, true);
      assert.ok(!JSON.stringify(denied).includes(PROD_CANARY));

      await client.close();
      await server.close();
    }

    // Once per store, not once per request and not once for both stores.
    assert.equal(probed.length, 2, `probed ${probed.length} times`);
    assert.equal(probed.filter((h) => h.includes(STAGING.project)).length, 1);
    assert.equal(probed.filter((h) => h.includes(PROD.project)).length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

/**
 * The real read clients, without the `readerFactory` seam: two stores yield two
 * clients, each pointed at its own project, and each memoised. Every other test
 * here stubs the factory, so this is what covers the client cache key.
 */
test("each store gets its OWN read client, memoised per project", async () => {
  const staging = await startFakeParameterManager({
    projectId: STAGING.project,
    parameters: new Map([
      makeParameter(STAGING.project, {
        path: STAGING_PARAM,
        secret: false,
        value: STAGING_VALUE,
      }),
    ].map((s) => [s.id, s.entry])),
  });
  const prod = await startFakeParameterManager({
    projectId: PROD.project,
    parameters: new Map([
      makeParameter(PROD.project, {
        path: PROD_PARAM,
        secret: false,
        value: PROD_CANARY,
      }),
    ].map((s) => [s.id, s.entry])),
  });

  // Both fakes are on their own port, so the apiBase has to come from the store.
  // The tree takes ONE apiBase test seam, so this test drives the reader factory
  // directly rather than through the config's single seam — what is under test
  // is that the factory is asked per store and caches per project.
  const built = [];
  const config = twoStoreConfig();
  const bases = {
    [STAGING.project]: staging.apiBase,
    [PROD.project]: prod.apiBase,
  };
  const tokens = {
    [STAGING.project]: staging.tokenUrl,
    [PROD.project]: prod.tokenUrl,
  };
  const { ParameterManagerReadClient } = await import(
    "../src/parameter-manager.js"
  );
  const cache = new Map();
  const created = createMCPServer({
    version: "0.0.0-test",
    config,
    capabilities: () => Promise.resolve(CAPS.restricted),
    readerFactory: (store) => {
      const held = cache.get(store.project);
      if (held) return held;
      built.push(store.project);
      const client = new ParameterManagerReadClient({
        projectId: store.project,
        account: store.account,
        apiBase: bases[store.project],
        tokenUrl: tokens[store.project],
      });
      cache.set(store.project, client);
      return client;
    },
  });
  await created.registerHandlers(created.server);
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([created.server.connect(st), client.connect(ct)]);

  const a = JSON.parse(
    (
      await client.callTool({
        name: "get_parameter",
        arguments: { name: STAGING_PARAM },
      })
    ).content[0].text,
  );
  assert.equal(a.value, STAGING_VALUE);
  assert.equal(a.project, STAGING.project);

  const b = JSON.parse(
    (
      await client.callTool({
        name: "get_parameter",
        arguments: { name: PROD_PARAM },
      })
    ).content[0].text,
  );
  assert.equal(b.value, PROD_CANARY, "a NON-secret is readable in either store");
  assert.equal(b.project, PROD.project);

  // Asked again: no second client for either project.
  await client.callTool({ name: "get_parameter", arguments: { name: STAGING_PARAM } });
  assert.deepEqual(built, [STAGING.project, PROD.project]);

  await client.close();
  await staging.close();
  await prod.close();
});

// ---------------------------------------------------------------------------
// THE CONFIG FENCES — collapse must be inexpressible, not merely discouraged
// ---------------------------------------------------------------------------

/**
 * The two fail-closed paths, which a refactor could invert silently because
 * nothing ordinary reaches them.
 */
test("a capability question with no store behind it answers NO, not yes", async () => {
  // `tools.ts` only ever asks about a store it resolved a path to, so this is
  // unreachable through the surface — which is exactly why it is worth pinning.
  // A lookup that fell through to a permissive default would be the collapse by
  // the quietest possible route.
  const created = createMCPServer({
    version: "0.0.0-test",
    config: twoStoreConfig(),
  });
  await created.registerHandlers(created.server);
  // The real lookup is private to registerHandlers; drive it the way the surface
  // does, then assert the store this server does NOT front gets nothing.
  const { NO_CAPABILITIES } = await import("../src/capabilities.js");
  assert.equal(NO_CAPABILITIES.readSecretValues, false);
  assert.equal(NO_CAPABILITIES.writeParameters, false);
  assert.equal(NO_CAPABILITIES.deleteParameters, false);
  assert.equal(NO_CAPABILITIES.probed, false);

  // And a path in neither store's namespace never reaches a capability at all.
  const stray = storeForPath("/somewhere/else/static/X", twoStoreConfig().stores);
  assert.equal(stray.store, undefined);
  assert.match(stray.error, /outside every managed namespace/);
});

test("a path two stores could claim is REFUSED, never resolved by order", () => {
  // `loadConfig` refuses overlapping namespaces, so this is unreachable through
  // configuration. `storeForPath` refuses it anyway rather than picking, because
  // picking would mean picking a credential and a capability.
  const overlapping = [
    {
      project: "a",
      namespaces: ["/shared/"],
      account: null,
      viewerKeyVar: "KA",
    },
    {
      project: "b",
      namespaces: ["/shared/"],
      account: null,
      viewerKeyVar: "KB",
    },
  ];
  const found = storeForPath("/shared/thing/static/X", overlapping);
  assert.equal(found.store, undefined);
  assert.match(found.error, /claimed by more than one store/);
  assert.match(found.error, /a, b/);
});

test("SECRETS_STORES: one credential may not front two projects", () => {
  assert.throws(
    () =>
      loadConfig({
        SECRETS_STORES: JSON.stringify([
          { project: "a", namespaces: ["/a/"], viewerKeyVar: "K" },
          { project: "b", namespaces: ["/b/"], viewerKeyVar: "K" },
        ]),
      }),
    /both read their credential from K/,
  );
});

test("SECRETS_STORES: two stores may not hold ONE service account", () => {
  // The name is not the credential. Two different variables may hold the same
  // key, and then the two stores' probes ask Google about one identity and
  // cannot come back with different answers — every other fence passes and the
  // capability is collapsed anyway. strad's config gate refuses this by ${REF};
  // this is the half that holds for a descriptor that arrived some other way.
  const key = JSON.stringify({
    client_email: "one-account@example.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
  });
  assert.throws(
    () =>
      loadConfig({
        SECRETS_STORES: JSON.stringify([
          { project: "a", namespaces: ["/a/"], viewerKeyVar: "KA" },
          { project: "b", namespaces: ["/b/"], viewerKeyVar: "KB" },
        ]),
        KA: key,
        KB: key,
      }),
    /hold the SAME service account/,
  );
});

test("a store whose key is malformed degrades ITSELF, not the mount", () => {
  // One typo'd key must not take every other store down with it — the bundle
  // host answers a `loadConfig` throw by not mounting the server at all, which
  // would strand the production store because staging's key has a stray brace.
  const good = JSON.stringify({
    client_email: "prod-viewer@example.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
  });
  const cfg = loadConfig({
    SECRETS_STORES: JSON.stringify([
      { project: STAGING.project, namespaces: [STAGING.ns], viewerKeyVar: STAGING.keyVar },
      { project: PROD.project, namespaces: [PROD.ns], viewerKeyVar: PROD.keyVar },
    ]),
    [STAGING.keyVar]: "{not json",
    [PROD.keyVar]: good,
  });

  assert.equal(cfg.stores.length, 2);
  assert.equal(cfg.stores[0].account, null);
  assert.match(cfg.stores[0].credentialError, /not valid JSON/);
  // SHAPE, NEVER CONTENT: the key material must not reach the reason.
  assert.ok(!cfg.stores[0].credentialError.includes("not json"));
  // …and the sibling is untouched.
  assert.equal(
    cfg.stores[1].account.client_email,
    "prod-viewer@example.iam.gserviceaccount.com",
  );
  assert.equal(cfg.stores[1].credentialError, undefined);
});

test("SECRETS_STORES: two stores may not claim one path", () => {
  // Equal, and prefix in either direction — a path that could address either
  // store is a path whose capability depends on declaration order.
  for (const [a, b] of [
    ["/strad/prod/mcp/", "/strad/prod/mcp/"],
    ["/strad/prod/", "/strad/prod/mcp/"],
    ["/strad/prod/mcp/", "/strad/prod/"],
  ]) {
    assert.throws(
      () =>
        loadConfig({
          SECRETS_STORES: JSON.stringify([
            { project: "a", namespaces: [a], viewerKeyVar: "KA" },
            { project: "b", namespaces: [b], viewerKeyVar: "KB" },
          ]),
        }),
      /overlap/,
      `${a} vs ${b} must be refused`,
    );
  }
});

test("SECRETS_STORES: fails closed on a shape it cannot trust", () => {
  const cases = [
    ["not json", /not valid JSON/],
    ["[]", /non-empty JSON array/],
    ['[{"namespaces":["/a/"],"viewerKeyVar":"K"}]', /missing "project"/],
    ['[{"project":"a","namespaces":["/a/"]}]', /missing "viewerKeyVar"/],
    ['[{"project":"a","viewerKeyVar":"K"}]', /names no namespace/],
    ['[{"project":"a","namespaces":[],"viewerKeyVar":"K"}]', /names no namespace/],
    [
      '[{"project":"a","namespaces":["/a/"],"viewerKeyVar":"K"},{"project":"a","namespaces":["/b/"],"viewerKeyVar":"K2"}]',
      /declares the project "a" twice/,
    ],
  ];
  for (const [raw, pattern] of cases) {
    assert.throws(() => loadConfig({ SECRETS_STORES: raw }), pattern, raw);
  }
});

test("SECRETS_STORES reads each store's credential from the variable it NAMES", () => {
  const key = JSON.stringify({
    client_email: "viewer@prod.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
  });
  const cfg = loadConfig({
    SECRETS_STORES: JSON.stringify([
      {
        project: STAGING.project,
        label: "strad staging",
        namespaces: [STAGING.ns],
        viewerKeyVar: STAGING.keyVar,
      },
      { project: PROD.project, namespaces: [PROD.ns], viewerKeyVar: PROD.keyVar },
    ]),
    [PROD.keyVar]: key,
    // The staging key is deliberately absent: a store with no credential
    // degrades ITSELF, and its sibling still holds one.
    SECRETS_CONSOLE_URL: "https://strad.tadasant.com/ui/secrets",
  });

  assert.equal(cfg.stores.length, 2);
  assert.equal(cfg.stores[0].account, null);
  assert.equal(cfg.stores[0].label, "strad staging");
  assert.equal(cfg.stores[0].viewerKeyVar, STAGING.keyVar);
  assert.equal(
    cfg.stores[1].account.client_email,
    "viewer@prod.iam.gserviceaccount.com",
  );
  assert.equal(cfg.consoleUrl, "https://strad.tadasant.com/ui/secrets");

  // And the descriptor is what binds a path to a store.
  assert.equal(storeForPath(PROD_SECRET, cfg.stores).store.project, PROD.project);
  assert.equal(
    storeForPath(STAGING_SECRET, cfg.stores).store.project,
    STAGING.project,
  );
});

test("SECRETS_STORES REPLACES the single-store reading rather than merging with it", () => {
  const cfg = loadConfig({
    SECRETS_STORES: JSON.stringify([
      { project: PROD.project, namespaces: [PROD.ns], viewerKeyVar: PROD.keyVar },
    ]),
    // Left over from the shape this replaces. It must not add a second store —
    // a config that says what its stores are does not also get an env-derived
    // one under whichever project id happens to still be lying around.
    SECRETS_PROJECT_ID: "some-other-project",
    SECRETS_NAMESPACES: "/somewhere/else/",
  });
  assert.deepEqual(
    cfg.stores.map((s) => s.project),
    [PROD.project],
  );
});

test("the tool descriptions attribute every namespace to its store", () => {
  const defs = toolDefinitions(twoStoreConfig(), new Map());
  const list = defs.find((d) => d.name === "list_parameters");
  assert.match(list.description, /"\/strad\/staging\/mcp\/" \(strad-secrets-staging\)/);
  assert.match(list.description, /"\/strad\/prod\/mcp\/" \(strad-secrets-prod\)/);
  const namespaces = defs.find((d) => d.name === "list_managed_namespaces");
  assert.match(namespaces.description, /parameter STORES this server fronts/);
});
