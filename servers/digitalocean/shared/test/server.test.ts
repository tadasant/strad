/**
 * The server end to end, through a real MCP client over an in-memory
 * transport, against the fake DigitalOcean API in fake-do.ts.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { ENV } from "../src/config.js";
import { createMCPServer } from "../src/server.js";
import { DESCRIPTION_BUDGET } from "../src/tools/shared.js";
import { parseToolGroups, toolNames, type ToolGroup } from "../src/tools.js";
import {
  APP_ID,
  BASE,
  DB_ID,
  DB_PASSWORD,
  DEPLOY_ACTIVE,
  DEPLOY_LATEST,
  FakeDigitalOcean,
  LOG_TEXT,
  LOGS_ORIGIN,
  TOKEN,
  USER_PASSWORD,
} from "./fake-do.js";

const READ_TOOLS = [
  "account-get-information",
  "balance-get",
  "billing-history-list",
  "region-list",
  "size-list",
  "image-list",
  "key-list",
  "droplet-list",
  "droplet-get",
  "droplet-action-get",
  "apps-list",
  "apps-get-info",
  "apps-get-deployment-status",
  "apps-get-logs",
  "db-cluster-list",
  "db-cluster-get",
  "db-cluster-list-backups",
  "db-cluster-get-firewall-rules",
  "db-cluster-list-users",
];

const WRITE_TOOLS = [
  "droplet-create",
  "droplet-action",
  "droplet-delete",
  "apps-create-app-from-spec",
  "apps-update",
  "apps-create-deployment",
  "apps-delete",
  "db-cluster-create",
  "db-cluster-resize",
  "db-cluster-delete",
];

const DESTRUCTIVE_TOOLS = [
  "droplet-action",
  "droplet-delete",
  "apps-update",
  "apps-delete",
  "db-cluster-resize",
  "db-cluster-delete",
];

const SPEC = { name: "web", region: "nyc", services: [{ name: "api" }] };

/** One happy-path call per tool, and the request each must make. */
const HAPPY: Array<{
  tool: string;
  args: Record<string, unknown>;
  method: string;
  path: string;
}> = [
  {
    tool: "account-get-information",
    args: {},
    method: "GET",
    path: "/v2/account",
  },
  {
    tool: "balance-get",
    args: {},
    method: "GET",
    path: "/v2/customers/my/balance",
  },
  {
    tool: "billing-history-list",
    args: {},
    method: "GET",
    path: "/v2/customers/my/billing_history",
  },
  { tool: "region-list", args: {}, method: "GET", path: "/v2/regions" },
  { tool: "size-list", args: {}, method: "GET", path: "/v2/sizes" },
  {
    tool: "image-list",
    args: { type: "distribution" },
    method: "GET",
    path: "/v2/images",
  },
  { tool: "key-list", args: {}, method: "GET", path: "/v2/account/keys" },
  {
    tool: "droplet-list",
    args: { tag_name: "web" },
    method: "GET",
    path: "/v2/droplets",
  },
  {
    tool: "droplet-get",
    args: { droplet_id: 3164444 },
    method: "GET",
    path: "/v2/droplets/3164444",
  },
  {
    tool: "droplet-action-get",
    args: { droplet_id: 3164444, action_id: 36804636 },
    method: "GET",
    path: "/v2/droplets/3164444/actions/36804636",
  },
  { tool: "apps-list", args: {}, method: "GET", path: "/v2/apps" },
  {
    tool: "apps-get-info",
    args: { app_id: APP_ID },
    method: "GET",
    path: `/v2/apps/${APP_ID}`,
  },
  {
    tool: "apps-get-deployment-status",
    args: { app_id: APP_ID },
    method: "GET",
    path: `/v2/apps/${APP_ID}/deployments`,
  },
  {
    tool: "apps-get-logs",
    args: { app_id: APP_ID, type: "BUILD" },
    method: "GET",
    path: `/v2/apps/${APP_ID}/deployments/${DEPLOY_LATEST}/logs`,
  },
  { tool: "db-cluster-list", args: {}, method: "GET", path: "/v2/databases" },
  {
    tool: "db-cluster-get",
    args: { cluster_id: DB_ID },
    method: "GET",
    path: `/v2/databases/${DB_ID}`,
  },
  {
    tool: "db-cluster-list-backups",
    args: { cluster_id: DB_ID },
    method: "GET",
    path: `/v2/databases/${DB_ID}/backups`,
  },
  {
    tool: "db-cluster-get-firewall-rules",
    args: { cluster_id: DB_ID },
    method: "GET",
    path: `/v2/databases/${DB_ID}/firewall`,
  },
  {
    tool: "db-cluster-list-users",
    args: { cluster_id: DB_ID },
    method: "GET",
    path: `/v2/databases/${DB_ID}/users`,
  },
  {
    tool: "droplet-create",
    args: {
      name: "web-2",
      region: "nyc3",
      size: "s-1vcpu-1gb",
      image: "ubuntu-24-04-x64",
      ssh_keys: ["512189", "3b:16:bf:e4"],
      monitoring: true,
    },
    method: "POST",
    path: "/v2/droplets",
  },
  {
    tool: "droplet-action",
    args: { droplet_id: 3164444, type: "power_off" },
    method: "POST",
    path: "/v2/droplets/3164444/actions",
  },
  {
    tool: "droplet-delete",
    args: { droplet_id: 3164444 },
    method: "DELETE",
    path: "/v2/droplets/3164444",
  },
  {
    tool: "apps-create-app-from-spec",
    args: { spec: SPEC },
    method: "POST",
    path: "/v2/apps",
  },
  {
    tool: "apps-update",
    args: { app_id: APP_ID, spec: SPEC },
    method: "PUT",
    path: `/v2/apps/${APP_ID}`,
  },
  {
    tool: "apps-create-deployment",
    args: { app_id: APP_ID, force_build: true },
    method: "POST",
    path: `/v2/apps/${APP_ID}/deployments`,
  },
  {
    tool: "apps-delete",
    args: { app_id: APP_ID },
    method: "DELETE",
    path: `/v2/apps/${APP_ID}`,
  },
  {
    tool: "db-cluster-create",
    args: {
      name: "app-db",
      engine: "pg",
      version: "17",
      region: "nyc3",
      size: "db-s-1vcpu-1gb",
      num_nodes: 1,
    },
    method: "POST",
    path: "/v2/databases",
  },
  {
    tool: "db-cluster-resize",
    args: { cluster_id: DB_ID, size: "db-s-2vcpu-4gb", num_nodes: 2 },
    method: "PUT",
    path: `/v2/databases/${DB_ID}/resize`,
  },
  {
    tool: "db-cluster-delete",
    args: { cluster_id: DB_ID },
    method: "DELETE",
    path: `/v2/databases/${DB_ID}`,
  },
];

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function harness(
  opts: {
    env?: NodeJS.ProcessEnv;
    toolGroups?: ToolGroup[];
    fake?: FakeDigitalOcean;
    logCapBytes?: number;
  } = {},
) {
  const fake = opts.fake ?? new FakeDigitalOcean();
  const { server, registerHandlers } = createMCPServer({
    version: "test",
    env: opts.env ?? { [ENV.apiToken]: TOKEN },
    fetch: fake.fetch,
    baseUrl: BASE,
    ...(opts.toolGroups ? { toolGroups: opts.toolGroups } : {}),
    ...(opts.logCapBytes ? { logCapBytes: opts.logCapBytes } : {}),
  });
  await registerHandlers(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "t" });
  await Promise.all([server.connect(a), client.connect(b)]);
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    const text = result.content[0]!.text;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a parsed tool result, asserted field by field
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { text, json, isError: result.isError === true };
  };
  return { fake, client, call };
}

describe("tools/list", () => {
  it("serves exactly the read tools under readonly", async () => {
    const { client } = await harness({ toolGroups: ["readonly"] });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.sort()).toEqual([...READ_TOOLS].sort());
    expect(toolNames(["readonly"]).sort()).toEqual([...READ_TOOLS].sort());
  });

  it("serves everything under readwrite, and by default", async () => {
    const all = [...READ_TOOLS, ...WRITE_TOOLS].sort();
    const { client } = await harness({ toolGroups: ["readwrite"] });
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(
      all,
    );
    expect(toolNames().sort()).toEqual(all);
    const byDefault = await harness({ env: { [ENV.apiToken]: TOKEN } });
    expect((await byDefault.client.listTools()).tools).toHaveLength(all.length);
  });

  it("honours ENABLED_TOOLGROUPS and fails closed on a typo", async () => {
    expect(parseToolGroups(undefined)).toEqual(["readonly", "readwrite"]);
    expect(parseToolGroups("readonly")).toEqual(["readonly"]);
    expect(parseToolGroups("read-only")).toEqual(["readonly"]);
    const { client } = await harness({
      env: { [ENV.apiToken]: TOKEN, ENABLED_TOOLGROUPS: "redonly" },
    });
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(
      [...READ_TOOLS].sort(),
    );
  });

  it("annotates every tool, with destructiveHint on exactly the destructive ones", async () => {
    const { client } = await harness();
    for (const tool of (await client.listTools()).tools) {
      const a = tool.annotations!;
      expect(a.openWorldHint, tool.name).toBe(true);
      expect(a.readOnlyHint, tool.name).toBe(READ_TOOLS.includes(tool.name));
      expect(a.destructiveHint, tool.name).toBe(
        DESTRUCTIVE_TOOLS.includes(tool.name),
      );
      expect(typeof a.idempotentHint, tool.name).toBe("boolean");
    }
  });

  it("keeps every description within the budget a client shows", async () => {
    const { client } = await harness();
    const over = (await client.listTools()).tools
      .filter((t) => (t.description ?? "").length > DESCRIPTION_BUDGET)
      .map((t) => `${t.name} (${t.description!.length})`);
    expect(over).toEqual([]);
  });

  it("lists with no credential at all, and makes no request", async () => {
    const { client, fake } = await harness({ env: {} });
    expect((await client.listTools()).tools.length).toBe(
      READ_TOOLS.length + WRITE_TOOLS.length,
    );
    expect(fake.calls).toHaveLength(0);
  });
});

describe("a happy-path call for every tool", () => {
  it("covers every tool the server lists", () => {
    expect(HAPPY.map((h) => h.tool).sort()).toEqual(
      [...READ_TOOLS, ...WRITE_TOOLS].sort(),
    );
  });

  for (const h of HAPPY) {
    it(`${h.tool} -> ${h.method} ${h.path}`, async () => {
      const { call, fake } = await harness();
      const result = await call(h.tool, h.args);
      expect(result.isError, result.text).toBe(false);
      expect(result.json).toBeDefined();
      const api = fake.calls.filter(
        (c) => c.url.origin === new URL(BASE).origin,
      );
      expect(
        api.some((c) => c.method === h.method && c.url.pathname === h.path),
      ).toBe(true);
      for (const c of api)
        expect(c.headers.authorization).toBe(`Bearer ${TOKEN}`);
    });
  }
});

describe("read-only tools", () => {
  it("only ever issue GET", async () => {
    const { call, fake } = await harness();
    for (const h of HAPPY.filter((x) => READ_TOOLS.includes(x.tool))) {
      await call(h.tool, h.args);
    }
    expect(fake.calls.length).toBeGreaterThan(READ_TOOLS.length - 1);
    expect(new Set(fake.calls.map((c) => c.method))).toEqual(new Set(["GET"]));
  });
});

describe("without a credential", () => {
  it("fails every call naming the variable and how to get it, with no request made", async () => {
    const { call, fake } = await harness({ env: {} });
    for (const h of HAPPY) {
      const result = await call(h.tool, h.args);
      expect(result.isError, h.tool).toBe(true);
      expect(result.text).toContain(ENV.apiToken);
      expect(result.text).toContain(
        "cloud.digitalocean.com/account/api/tokens",
      );
    }
    expect(fake.calls).toHaveLength(0);
  });
});

describe("the credential never reaches a result", () => {
  it("is scrubbed when the upstream echoes it, on success and on failure", async () => {
    const fake = new FakeDigitalOcean();
    fake.mutate = (text) =>
      text.replace(/"active"/g, JSON.stringify(`active ${TOKEN}`));
    fake.on("GET /v2/customers/my/balance", {
      status: 401,
      body: { id: "unauthorized", message: `token ${TOKEN} is bad` },
    });
    fake.on(`GET ${new URL(LOGS_ORIGIN).host}/logs/abc`, {
      text: `boot with Bearer ${TOKEN}\n`,
    });
    const { call } = await harness({ fake });
    for (const h of HAPPY) {
      const result = await call(h.tool, h.args);
      expect(result.text, h.tool).not.toContain(TOKEN);
      expect(result.text, h.tool).not.toContain(TOKEN.slice(7));
    }
    // The echo really reached the server: a success payload carried it.
    const account = await call("account-get-information");
    expect(account.json.status).toBe("active [redacted]");
    const failed = await call("balance-get");
    expect(failed.isError).toBe(true);
    expect(failed.text).toMatch(/HTTP 401/);
  });
});

describe("database credentials", () => {
  for (const tool of [
    "db-cluster-list",
    "db-cluster-get",
    "db-cluster-list-users",
    "db-cluster-create",
  ]) {
    it(`${tool} returns no password, in a field or a URI`, async () => {
      const { call } = await harness();
      const h = HAPPY.find((x) => x.tool === tool)!;
      const result = await call(tool, h.args);
      expect(result.isError).toBe(false);
      expect(result.text).not.toContain(DB_PASSWORD);
      expect(result.text).not.toContain(USER_PASSWORD);
      expect(result.text).not.toContain("PRIVATE KEY");
    });
  }

  it("db-cluster-get keeps the host, port and user and marks what it withheld", async () => {
    const { call } = await harness();
    const { json } = await call("db-cluster-get", { cluster_id: DB_ID });
    expect(json.connection.host).toBe("db-host.b.db.ondigitalocean.com");
    expect(json.connection.password).toBe("[redacted]");
    expect(json.connection.uri).toContain("doadmin:[redacted]@");
    expect(json.private_connection.password).toBe("[redacted]");
    expect(json.standby_connection.password).toBe("[redacted]");
    expect(
      json.users.every(
        (u: { password: string }) => u.password === "[redacted]",
      ),
    ).toBe(true);
  });

  it("an app spec's plaintext connection string loses its password too", async () => {
    const { call } = await harness();
    const result = await call("apps-get-info", { app_id: APP_ID });
    expect(result.text).not.toContain(USER_PASSWORD);
    expect(result.text).toContain("postgres://app:[redacted]@db-host");
  });
});

describe("pagination", () => {
  it("passes page and per_page, clamps per_page at 200, and reports the next page", async () => {
    const { call, fake } = await harness();
    const { json } = await call("billing-history-list", {
      page: 1,
      per_page: 5000,
    });
    expect(fake.calls[0]!.url.searchParams.get("per_page")).toBe("200");
    expect(json).toMatchObject({
      total: 45,
      has_next_page: true,
      next_page: 2,
    });
  });

  it("db-cluster-list pages locally, since DigitalOcean returns every cluster at once", async () => {
    const { call } = await harness();
    const first = await call("db-cluster-list", { per_page: 1 });
    expect(first.json).toMatchObject({
      total: 2,
      has_next_page: true,
      next_page: 2,
    });
    expect(first.json.items).toHaveLength(1);
    const second = await call("db-cluster-list", { page: 2, per_page: 1 });
    expect(second.json.items[0].name).toBe("db-2");
    expect(second.json.has_next_page).toBe(false);
  });
});

describe("droplets", () => {
  it("droplet-list summarises and flattens the addresses", async () => {
    const { call } = await harness();
    const { json } = await call("droplet-list", {});
    expect(json.items[0]).toMatchObject({
      id: 3164444,
      region: "nyc3",
      public_ipv4: "104.236.32.182",
      private_ipv4: "10.128.0.2",
    });
    expect(json.items[0].networks).toBeUndefined();
  });

  it("droplet-list refuses tag_name and name together", async () => {
    const { call, fake } = await harness();
    const result = await call("droplet-list", { tag_name: "a", name: "b" });
    expect(result.isError).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });

  it("droplet-create sends numeric ids as numbers and hands back the action to poll", async () => {
    const { call, fake } = await harness();
    const { json } = await call(
      "droplet-create",
      HAPPY.find((h) => h.tool === "droplet-create")!.args,
    );
    expect(fake.calls[0]!.body).toEqual({
      name: "web-2",
      region: "nyc3",
      size: "s-1vcpu-1gb",
      image: "ubuntu-24-04-x64",
      ssh_keys: [512189, "3b:16:bf:e4"],
      monitoring: true,
    });
    expect(json.action_id).toBe(36805022);
    expect(json.droplet.status).toBe("new");
  });

  it("droplet-action sends the type-specific arguments", async () => {
    const { call, fake } = await harness();
    await call("droplet-action", {
      droplet_id: 3164444,
      type: "resize",
      size: "s-2vcpu-4gb",
    });
    await call("droplet-action", {
      droplet_id: "3164444",
      type: "snapshot",
      name: "before-upgrade",
    });
    await call("droplet-action", {
      droplet_id: 3164444,
      type: "rename",
      name: "web-renamed",
    });
    expect(fake.calls.map((c) => c.body)).toEqual([
      { type: "resize", size: "s-2vcpu-4gb", disk: false },
      { type: "snapshot", name: "before-upgrade" },
      { type: "rename", name: "web-renamed" },
    ]);
  });

  it("droplet-action returns the action object", async () => {
    const { call } = await harness();
    const { json } = await call("droplet-action", {
      droplet_id: 3164444,
      type: "reboot",
    });
    expect(json).toMatchObject({
      id: 36804637,
      status: "in-progress",
      type: "reboot",
    });
  });
});

describe("apps", () => {
  it("apps-get-logs RUN defaults to the active deployment and returns a bounded tail", async () => {
    const { call, fake } = await harness();
    const { json } = await call("apps-get-logs", {
      app_id: APP_ID,
      component_name: "core",
    });
    expect(json).toMatchObject({
      deployment_id: DEPLOY_ACTIVE,
      selected: "active deployment",
      type: "RUN",
      component_name: "core",
      total_lines: 450,
      returned_lines: 200,
      dropped_lines: 250,
    });
    expect(json.text.split("\n").at(-1)).toBe("line 450");
    const logsCall = fake.calls.find((c) =>
      c.url.pathname.endsWith("/components/core/logs"),
    )!;
    expect(logsCall.url.searchParams.get("type")).toBe("RUN");
    expect(logsCall.url.searchParams.get("follow")).toBe("false");
    // The signed link is fetched without the token, and never returned.
    const storage = fake.calls.find((c) => c.url.origin === LOGS_ORIGIN)!;
    expect(storage.headers.authorization).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain("X-Amz-Signature");
  });

  it("apps-get-logs honours lower line and byte limits", async () => {
    const { call } = await harness();
    const { json } = await call("apps-get-logs", {
      app_id: APP_ID,
      type: "DEPLOY",
      max_lines: 10,
      max_bytes: 20,
    });
    expect(json.returned_bytes).toBeLessThanOrEqual(20);
    expect(json.dropped_lines).toBe(450 - json.returned_lines);
  });

  it("apps-get-logs says so when there are no stored logs", async () => {
    const fake = new FakeDigitalOcean();
    fake.on(`GET /v2/apps/${APP_ID}/deployments/${DEPLOY_LATEST}/logs`, {
      body: { historic_urls: [] },
    });
    const { call } = await harness({ fake });
    const { json } = await call("apps-get-logs", {
      app_id: APP_ID,
      type: "BUILD",
    });
    expect(json.text).toBe("");
    expect(json.note).toMatch(/no stored logs/);
  });

  it("apps-get-logs reads RUN_RESTARTED from the active deployment", async () => {
    const { call, fake } = await harness();
    const { json } = await call("apps-get-logs", {
      app_id: APP_ID,
      type: "RUN_RESTARTED",
    });
    expect(json).toMatchObject({
      deployment_id: DEPLOY_ACTIVE,
      selected: "active deployment",
      type: "RUN_RESTARTED",
    });
    const logsCall = fake.calls.find((c) => c.url.pathname.endsWith("/logs"))!;
    expect(logsCall.url.searchParams.get("type")).toBe("RUN_RESTARTED");
  });

  it("apps-get-logs says when only a live stream exists, and opens nothing", async () => {
    const fake = new FakeDigitalOcean();
    fake.on(`GET /v2/apps/${APP_ID}/deployments/${DEPLOY_ACTIVE}/logs`, {
      body: { live_url: "wss://live.example/x?token=abc", historic_urls: [] },
    });
    const { call } = await harness({ fake });
    const { json, text } = await call("apps-get-logs", { app_id: APP_ID });
    expect(json.live_only).toBe(true);
    expect(json.text).toBe("");
    expect(json.note).toMatch(/only a live stream/);
    expect(text).not.toContain("live.example");
    expect(fake.calls.every((c) => c.url.host !== "live.example")).toBe(true);
  });

  it("apps-get-logs says when the stored log was cut at the fetch cap", async () => {
    const fake = new FakeDigitalOcean();
    const { call } = await harness({ fake, logCapBytes: 500 });
    const { json } = await call("apps-get-logs", { app_id: APP_ID });
    expect(json.fetch_truncated).toBe(true);
    expect(json.total_bytes).toBe(Buffer.byteLength(LOG_TEXT));
    expect(json.note).toMatch(/only its last \d+ were read/);
    expect(json.text.split("\n").at(-1)).toBe("line 450");
  });

  it("apps-get-logs refuses a log link off DigitalOcean's storage", async () => {
    const fake = new FakeDigitalOcean();
    fake.on(`GET /v2/apps/${APP_ID}/deployments/${DEPLOY_ACTIVE}/logs`, {
      body: { historic_urls: ["https://attacker.example/logs"] },
    });
    const { call } = await harness({ fake });
    const result = await call("apps-get-logs", { app_id: APP_ID });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/will not follow/);
    expect(fake.calls.every((c) => c.url.host !== "attacker.example")).toBe(
      true,
    );
  });

  it("apps-get-deployment-status names the failed steps of the latest deployment", async () => {
    const { call } = await harness();
    const { json } = await call("apps-get-deployment-status", {
      app_id: APP_ID,
    });
    expect(json.phase).toBe("ERROR");
    expect(json.failed_steps.map((s: { name: string }) => s.name)).toEqual([
      "build",
      "build-core",
    ]);
  });

  it("apps-get-deployment-status reads a named deployment", async () => {
    const { call, fake } = await harness();
    const { json } = await call("apps-get-deployment-status", {
      app_id: APP_ID,
      deployment_id: DEPLOY_ACTIVE,
    });
    expect(json.phase).toBe("ACTIVE");
    expect(fake.calls[0]!.url.pathname).toBe(
      `/v2/apps/${APP_ID}/deployments/${DEPLOY_ACTIVE}`,
    );
  });

  it("apps-update sends the spec as given, and apps-create-deployment the force flag", async () => {
    const { call, fake } = await harness();
    await call("apps-update", { app_id: APP_ID, spec: SPEC });
    await call("apps-create-deployment", { app_id: APP_ID });
    expect(fake.calls[0]!.body).toEqual({ spec: SPEC });
    expect(fake.calls[1]!.body).toEqual({ force_build: false });
  });
});

describe("a redacted spec is never written back", () => {
  it("apps-get-info's own spec, sent back as is, is refused with nothing sent", async () => {
    const fake = new FakeDigitalOcean();
    const { call } = await harness({ fake });
    const { json } = await call("apps-get-info", { app_id: APP_ID });
    expect(JSON.stringify(json.spec)).toContain("[redacted]");
    const before = fake.calls.length;
    const result = await call("apps-update", {
      app_id: APP_ID,
      spec: json.spec,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/spec\.services\[0\]\.envs\[0\]\.value/);
    expect(result.text).toMatch(/apps-get-info redacts/);
    expect(result.text).toMatch(/Nothing was sent/);
    expect(fake.calls).toHaveLength(before);
  });

  for (const tool of ["apps-update", "apps-create-app-from-spec"]) {
    it(`${tool} refuses the marker at any depth, in a value or a key`, async () => {
      for (const spec of [
        { ...SPEC, envs: [{ key: "X", value: "[redacted]" }] },
        {
          ...SPEC,
          log_destinations: [{ name: "d", datadog: { api_key: "[redacted]" } }],
        },
        { ...SPEC, services: [{ name: "api", "[redacted]": true }] },
      ]) {
        const { call, fake } = await harness();
        const result = await call(tool, { app_id: APP_ID, spec });
        expect(result.isError).toBe(true);
        expect(result.text).toMatch(/literal "\[redacted\]" marker/);
        expect(fake.calls).toHaveLength(0);
      }
    });
  }

  it("both descriptions warn about it", async () => {
    const { client } = await harness();
    const { tools } = await client.listTools();
    for (const name of ["apps-get-info", "apps-update"]) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool.description).toMatch(/\[redacted\]/);
      expect(tool.description).toMatch(/refuse/);
    }
  });
});

describe("databases", () => {
  it("db-cluster-resize sends the target shape", async () => {
    const { call, fake } = await harness();
    const { json } = await call("db-cluster-resize", {
      cluster_id: DB_ID,
      size: "db-s-2vcpu-4gb",
      num_nodes: 2,
      storage_size_mib: 20480,
    });
    expect(fake.calls[0]!.body).toEqual({
      size: "db-s-2vcpu-4gb",
      num_nodes: 2,
      storage_size_mib: 20480,
    });
    expect(json.accepted).toBe(true);
  });

  it("db-cluster-get-firewall-rules flags an open cluster", async () => {
    const fake = new FakeDigitalOcean();
    fake.on(`GET /v2/databases/${DB_ID}/firewall`, { body: { rules: [] } });
    const { call } = await harness({ fake });
    const { json } = await call("db-cluster-get-firewall-rules", {
      cluster_id: DB_ID,
    });
    expect(json.open_to_all).toBe(true);
  });
});

describe("input validation", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["droplet-get", {}, /droplet_id/],
    ["droplet-get", { droplet_id: "1/actions" }, /droplet_id/],
    [
      "droplet-action-get",
      { droplet_id: 1, action_id: "x" },
      /`action_id` is required and must be an action's numeric id/,
    ],
    ["droplet-action", { droplet_id: 1 }, /`type` is required/],
    ["droplet-action", { droplet_id: 1, type: "destroy" }, /not one of/],
    ["droplet-action", { droplet_id: 1, type: "resize" }, /`size`/],
    ["droplet-action", { droplet_id: 1, type: "rename" }, /`name`/],
    ["droplet-create", { name: "x", region: "nyc3", size: "s" }, /`image`/],
    ["apps-get-info", { app_id: "../databases" }, /not a UUID/],
    ["apps-get-logs", { app_id: APP_ID, type: "ALL" }, /not one of/],
    [
      "apps-get-logs",
      { app_id: APP_ID, component_name: "core/../x" },
      /component_name/,
    ],
    ["apps-update", { app_id: APP_ID, spec: "name: web" }, /JSON object/],
    [
      "db-cluster-create",
      { name: "x", engine: "oracle", region: "nyc3", size: "s", num_nodes: 1 },
      /not one of/,
    ],
    [
      "db-cluster-create",
      { name: "x", engine: "pg", region: "nyc3", size: "s", num_nodes: 5 },
      /num_nodes/,
    ],
    ["billing-history-list", { page: 0 }, /`page`/],
    ["image-list", { private: "yes" }, /`private`/],
  ];
  for (const [tool, args, pattern] of cases) {
    it(`${tool} ${JSON.stringify(args)} is refused before any request`, async () => {
      const { call, fake } = await harness();
      const result = await call(tool, args);
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(pattern);
      expect(fake.calls).toHaveLength(0);
    });
  }

  it("an unknown tool is a protocol error naming what exists", async () => {
    const { client } = await harness({ toolGroups: ["readonly"] });
    await expect(
      client.callTool({ name: "droplet-delete", arguments: { droplet_id: 1 } }),
    ).rejects.toThrow(/Unknown tool/);
  });
});

describe("upstream failures", () => {
  it("a 404 says nothing has that id", async () => {
    const { call } = await harness();
    const result = await call("droplet-get", { droplet_id: 999 });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/HTTP 404.*not_found/);
  });

  it("an error keeps the ids in the path it quotes", async () => {
    const fake = new FakeDigitalOcean();
    fake.on(`GET /v2/apps/${APP_ID}/deployments/${DEPLOY_ACTIVE}`, {
      status: 404,
      body: { id: "not_found", message: "deployment not found" },
    });
    const { call } = await harness({ fake });
    const result = await call("apps-get-deployment-status", {
      app_id: APP_ID,
      deployment_id: DEPLOY_ACTIVE,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(
      `/apps/${APP_ID}/deployments/${DEPLOY_ACTIVE}`,
    );
  });

  it("a 403 says the token lacks a scope", async () => {
    const fake = new FakeDigitalOcean();
    fake.on("GET /v2/customers/my/balance", {
      status: 403,
      body: { id: "forbidden", message: "You are not authorized" },
    });
    const { call } = await harness({ fake });
    const result = await call("balance-get");
    expect(result.text).toMatch(/lacks the scope/);
  });
});
