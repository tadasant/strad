/**
 * The server end to end, through a real MCP client over an in-memory
 * transport, against the fake Hetzner Cloud API in fake-hetzner.ts.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { ENV } from "../src/config.js";
import { createMCPServer } from "../src/server.js";
import { BLAST_RADIUS, DESCRIPTION_BUDGET } from "../src/tools/shared.js";
import { parseToolGroups, toolNames, type ToolGroup } from "../src/tools.js";
import {
  ACTION_ID,
  BASE,
  FakeHetzner,
  SERVER,
  FIREWALL_ID,
  IMAGE_ID,
  ROOT_PASSWORD,
  SERVER_ID,
  SSH_KEY_ID,
  TOKEN,
  VOLUME_ID,
} from "./fake-hetzner.js";

const READ_TOOLS = [
  "list_servers",
  "get_server",
  "get_server_metrics",
  "list_server_actions",
  "get_action",
  "list_images",
  "list_server_types",
  "list_locations",
  "list_datacenters",
  "list_ssh_keys",
  "list_firewalls",
  "list_networks",
  "list_primary_ips",
  "list_volumes",
];

const WRITE_TOOLS = [
  "create_server",
  "power_server",
  "rebuild_server",
  "change_server_type",
  "create_server_image",
  "delete_server",
  "delete_image",
  "create_ssh_key",
  "delete_ssh_key",
  "set_firewall_rules",
  "apply_firewall",
  "remove_firewall",
  "attach_volume",
  "detach_volume",
];

const DESTRUCTIVE_TOOLS = [
  "power_server",
  "rebuild_server",
  "change_server_type",
  "delete_server",
  "delete_image",
  "delete_ssh_key",
  "set_firewall_rules",
  "apply_firewall",
  "remove_firewall",
  "detach_volume",
];

/**
 * The tools that can take a running machine off the air or lose its data, and
 * so must say in their description that this project is shared.
 * delete_ssh_key is destructive but touches no machine.
 */
const BLAST_RADIUS_TOOLS = DESTRUCTIVE_TOOLS.filter(
  (t) => t !== "delete_ssh_key",
);

const RULE = {
  direction: "in",
  protocol: "tcp",
  port: "22",
  source_ips: ["0.0.0.0/0", "::/0"],
  description: "ssh",
};

/** One happy-path call per tool, and the request each must make. */
const HAPPY: Array<{
  tool: string;
  args: Record<string, unknown>;
  method: string;
  path: string;
}> = [
  { tool: "list_servers", args: {}, method: "GET", path: "/v1/servers" },
  {
    tool: "get_server",
    args: { server_id: SERVER_ID },
    method: "GET",
    path: `/v1/servers/${SERVER_ID}`,
  },
  {
    tool: "get_server_metrics",
    args: { server_id: SERVER_ID },
    method: "GET",
    path: `/v1/servers/${SERVER_ID}/metrics`,
  },
  {
    tool: "list_server_actions",
    args: { server_id: SERVER_ID },
    method: "GET",
    path: `/v1/servers/${SERVER_ID}/actions`,
  },
  {
    tool: "get_action",
    args: { action_id: ACTION_ID },
    method: "GET",
    path: `/v1/actions/${ACTION_ID}`,
  },
  { tool: "list_images", args: {}, method: "GET", path: "/v1/images" },
  {
    tool: "list_server_types",
    args: {},
    method: "GET",
    path: "/v1/server_types",
  },
  { tool: "list_locations", args: {}, method: "GET", path: "/v1/locations" },
  {
    tool: "list_datacenters",
    args: {},
    method: "GET",
    path: "/v1/datacenters",
  },
  { tool: "list_ssh_keys", args: {}, method: "GET", path: "/v1/ssh_keys" },
  { tool: "list_firewalls", args: {}, method: "GET", path: "/v1/firewalls" },
  { tool: "list_networks", args: {}, method: "GET", path: "/v1/networks" },
  {
    tool: "list_primary_ips",
    args: {},
    method: "GET",
    path: "/v1/primary_ips",
  },
  { tool: "list_volumes", args: {}, method: "GET", path: "/v1/volumes" },
  {
    tool: "create_server",
    args: {
      name: "build-3",
      server_type: "cpx31",
      image: "ubuntu-24.04",
      ssh_keys: ["ci-deploy"],
    },
    method: "POST",
    path: "/v1/servers",
  },
  {
    tool: "power_server",
    args: { server_id: SERVER_ID, action: "shutdown" },
    method: "POST",
    path: `/v1/servers/${SERVER_ID}/actions/shutdown`,
  },
  {
    tool: "rebuild_server",
    args: { server_id: SERVER_ID, image: "ubuntu-24.04" },
    method: "POST",
    path: `/v1/servers/${SERVER_ID}/actions/rebuild`,
  },
  {
    tool: "change_server_type",
    args: { server_id: SERVER_ID, server_type: "ccx43" },
    method: "POST",
    path: `/v1/servers/${SERVER_ID}/actions/change_type`,
  },
  {
    tool: "create_server_image",
    args: { server_id: SERVER_ID, description: "snap" },
    method: "POST",
    path: `/v1/servers/${SERVER_ID}/actions/create_image`,
  },
  {
    tool: "delete_server",
    args: { server_id: SERVER_ID },
    method: "DELETE",
    path: `/v1/servers/${SERVER_ID}`,
  },
  {
    tool: "delete_image",
    args: { image_id: IMAGE_ID },
    method: "DELETE",
    path: `/v1/images/${IMAGE_ID}`,
  },
  {
    tool: "create_ssh_key",
    args: { name: "new", public_key: "ssh-ed25519 AAAAC3Nz new" },
    method: "POST",
    path: "/v1/ssh_keys",
  },
  {
    tool: "delete_ssh_key",
    args: { ssh_key_id: SSH_KEY_ID },
    method: "DELETE",
    path: `/v1/ssh_keys/${SSH_KEY_ID}`,
  },
  {
    tool: "set_firewall_rules",
    args: { firewall_id: FIREWALL_ID, rules: [RULE] },
    method: "POST",
    path: `/v1/firewalls/${FIREWALL_ID}/actions/set_rules`,
  },
  {
    tool: "apply_firewall",
    args: { firewall_id: FIREWALL_ID, server_id: SERVER_ID },
    method: "POST",
    path: `/v1/firewalls/${FIREWALL_ID}/actions/apply_to_resources`,
  },
  {
    tool: "remove_firewall",
    args: { firewall_id: FIREWALL_ID, server_id: SERVER_ID },
    method: "POST",
    path: `/v1/firewalls/${FIREWALL_ID}/actions/remove_from_resources`,
  },
  {
    tool: "attach_volume",
    args: { volume_id: VOLUME_ID, server_id: SERVER_ID },
    method: "POST",
    path: `/v1/volumes/${VOLUME_ID}/actions/attach`,
  },
  {
    tool: "detach_volume",
    args: { volume_id: VOLUME_ID },
    method: "POST",
    path: `/v1/volumes/${VOLUME_ID}/actions/detach`,
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
    fake?: FakeHetzner;
  } = {},
) {
  const fake = opts.fake ?? new FakeHetzner();
  const { server, registerHandlers } = createMCPServer({
    version: "test",
    env: opts.env ?? { [ENV.apiToken]: TOKEN },
    fetch: fake.fetch,
    baseUrl: BASE,
    ...(opts.toolGroups ? { toolGroups: opts.toolGroups } : {}),
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

  it("names the shared project's blast radius on every tool that can take a machine down", async () => {
    const { client } = await harness();
    for (const tool of (await client.listTools()).tools) {
      expect(
        tool.description!.includes(BLAST_RADIUS),
        `${tool.name} blast radius`,
      ).toBe(BLAST_RADIUS_TOOLS.includes(tool.name));
    }
    expect(BLAST_RADIUS).toContain("PulseMCP");
  });

  it("keeps every name verb-first snake_case under 25 characters", () => {
    for (const name of toolNames()) {
      expect(name, name).toMatch(/^[a-z]+(_[a-z]+)+$/);
      expect(name.length, name).toBeLessThan(25);
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
      expect(fake.calls).toHaveLength(1);
      const [req] = fake.calls;
      expect(req!.method).toBe(h.method);
      expect(req!.url.pathname).toBe(h.path);
      expect(req!.url.origin).toBe(new URL(BASE).origin);
      expect(req!.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(req!.redirect).toBe("error");
    });
  }
});

describe("read-only tools", () => {
  it("only ever issue GET", async () => {
    const { call, fake } = await harness();
    for (const h of HAPPY.filter((x) => READ_TOOLS.includes(x.tool))) {
      await call(h.tool, h.args);
    }
    expect(fake.calls).toHaveLength(READ_TOOLS.length);
    expect(new Set(fake.calls.map((c) => c.method))).toEqual(new Set(["GET"]));
  });
});

describe("without a credential", () => {
  it("fails every call naming the variable and how to get it, with no request made", async () => {
    const { call, fake } = await harness({ env: { [ENV.apiToken]: "  " } });
    for (const h of HAPPY) {
      const result = await call(h.tool, h.args);
      expect(result.isError, h.tool).toBe(true);
      expect(result.text).toContain(ENV.apiToken);
      expect(result.text).toContain("console.hetzner.cloud");
    }
    expect(fake.calls).toHaveLength(0);
  });
});

describe("the credential never reaches a result", () => {
  it("is scrubbed when the upstream echoes it, on success and on failure", async () => {
    const fake = new FakeHetzner();
    fake.mutate = (text) =>
      text.replace(/"running"/g, JSON.stringify(`running ${TOKEN}`));
    fake.on("GET /v1/locations", {
      status: 401,
      body: {
        error: { code: "unauthorized", message: `token ${TOKEN} is bad` },
      },
    });
    const { call } = await harness({ fake });
    for (const h of HAPPY) {
      const result = await call(h.tool, h.args);
      expect(result.text, h.tool).not.toContain(TOKEN);
    }
  });
});

describe("root passwords", () => {
  it("rebuild_server reports one was generated and never what it is", async () => {
    const { call } = await harness();
    const result = await call("rebuild_server", {
      server_id: SERVER_ID,
      image: "ubuntu-24.04",
    });
    expect(result.isError).toBe(false);
    expect(result.text).not.toContain(ROOT_PASSWORD);
    expect(result.json.root_password).toBe("[redacted]");
    expect(result.json.action_id).toBe(ACTION_ID);
  });

  it("create_server refuses to run without an SSH key, sending nothing", async () => {
    const { call, fake } = await harness();
    for (const ssh_keys of [undefined, []]) {
      const result = await call("create_server", {
        name: "x",
        server_type: "cpx11",
        image: "ubuntu-24.04",
        ...(ssh_keys ? { ssh_keys } : {}),
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("ssh_keys");
    }
    expect(fake.calls).toHaveLength(0);
  });
});

describe("servers", () => {
  it("list_servers summarises, flattens the addresses and passes filters", async () => {
    const { call, fake } = await harness();
    const result = await call("list_servers", {
      label_selector: "role=ci",
      status: ["running", "off"],
    });
    expect(result.json.items[0]).toMatchObject({
      id: SERVER_ID,
      name: "ci-runner-2",
      server_type: "ccx53",
      cores: 32,
      memory_gb: 128,
      disk_gb: 600,
      location: "fsn1",
      datacenter: "fsn1-dc14",
      image: "ubuntu-24.04",
      public_ipv4: "203.0.113.10",
      private_ips: [{ network: 4711, ip: "10.0.1.2" }],
      firewall_ids: [FIREWALL_ID],
      protection: { delete: true, rebuild: true },
    });
    expect(result.json.items[0].included_traffic).toBeUndefined();
    const url = fake.calls[0]!.url;
    expect(url.searchParams.get("label_selector")).toBe("role=ci");
    expect(url.searchParams.getAll("status")).toEqual(["running", "off"]);
  });

  it("list_servers refuses an unknown status before sending", async () => {
    const { call, fake } = await harness();
    const result = await call("list_servers", { status: ["stopped"] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("off");
    expect(fake.calls).toHaveLength(0);
  });

  it("get_server_metrics asks for a bounded window and summarises the series", async () => {
    const { call, fake } = await harness();
    const result = await call("get_server_metrics", {
      server_id: SERVER_ID,
      types: ["cpu", "network"],
      minutes: 60,
      max_points: 10,
    });
    expect(result.isError, result.text).toBe(false);
    const q = fake.calls[0]!.url.searchParams;
    expect(q.get("type")).toBe("cpu,network");
    expect(q.get("step")).toBe("360");
    const span = Date.parse(q.get("end")!) - Date.parse(q.get("start")!);
    expect(span).toBe(60 * 60_000);
    const cpu = result.json.series.cpu;
    expect(cpu.points).toBe(60);
    expect(cpu.values).toHaveLength(10);
    expect(cpu.min).toBe(100);
    expect(cpu.max).toBe(3011.9);
    expect(cpu.last).toBe(3011.9);
    // The newest point is always one of those listed.
    expect(cpu.values.at(-1)[1]).toBe(3011.9);
  });

  it("power_server posts to the action's own path and hands back the action to poll", async () => {
    const { call, fake } = await harness();
    const result = await call("power_server", {
      server_id: SERVER_ID,
      action: "poweroff",
    });
    expect(fake.calls[0]!.url.pathname).toBe(
      `/v1/servers/${SERVER_ID}/actions/poweroff`,
    );
    expect(result.json).toMatchObject({
      server_id: SERVER_ID,
      action_id: ACTION_ID,
      status: "running",
    });
    expect(result.json.next).toContain("get_action");
  });

  it("power_server refuses an action it does not know", async () => {
    const { call, fake } = await harness();
    const result = await call("power_server", {
      server_id: SERVER_ID,
      action: "rescue",
    });
    expect(result.isError).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });

  it("create_server shapes the body Hetzner takes", async () => {
    const { call, fake } = await harness();
    const result = await call("create_server", {
      name: "build-3",
      server_type: "cpx31",
      image: "123",
      location: "fsn1",
      ssh_keys: ["ci-deploy", "7"],
      labels: { role: "ci" },
      firewall_ids: [FIREWALL_ID],
      network_ids: [4711],
      start_after_create: false,
    });
    expect(result.isError, result.text).toBe(false);
    expect(fake.calls[0]!.body).toEqual({
      name: "build-3",
      server_type: "cpx31",
      image: 123,
      location: "fsn1",
      ssh_keys: ["ci-deploy", 7],
      labels: { role: "ci" },
      firewalls: [{ firewall: FIREWALL_ID }],
      networks: [4711],
      start_after_create: false,
    });
    expect(result.json.action_id).toBe(14);
    expect(result.json.server.status).toBe("initializing");
  });

  it("change_server_type keeps the disk unless asked, because growing it is permanent", async () => {
    const { call, fake } = await harness();
    await call("change_server_type", {
      server_id: SERVER_ID,
      server_type: "ccx43",
    });
    expect(fake.calls[0]!.body).toEqual({
      server_type: "ccx43",
      upgrade_disk: false,
    });
  });

  it("create_server_image always makes a snapshot", async () => {
    const { call, fake } = await harness();
    await call("create_server_image", { server_id: SERVER_ID });
    expect(fake.calls[0]!.body).toEqual({ type: "snapshot" });
  });

  it("list_server_actions asks newest first", async () => {
    const { call, fake } = await harness();
    await call("list_server_actions", {
      server_id: SERVER_ID,
      status: "error",
    });
    const q = fake.calls[0]!.url.searchParams;
    expect(q.get("sort")).toBe("id:desc");
    expect(q.get("status")).toBe("error");
  });
});

describe("more request shapes", () => {
  it("rebuild_server sends a snapshot id as a number and a name as a string", async () => {
    const { call, fake } = await harness();
    await call("rebuild_server", { server_id: SERVER_ID, image: "9100" });
    await call("rebuild_server", {
      server_id: SERVER_ID,
      image: "ubuntu-24.04",
    });
    expect(fake.calls[0]!.body).toEqual({ image: 9100 });
    expect(fake.calls[1]!.body).toEqual({ image: "ubuntu-24.04" });
  });

  it("attach_volume and detach_volume send what Hetzner takes", async () => {
    const { call, fake } = await harness();
    const attached = await call("attach_volume", {
      volume_id: VOLUME_ID,
      server_id: SERVER_ID,
      automount: true,
    });
    await call("detach_volume", { volume_id: VOLUME_ID });
    expect(fake.calls[0]!.body).toEqual({ server: SERVER_ID, automount: true });
    expect(fake.calls[1]!.body).toEqual({});
    expect(attached.json.action_ids).toEqual([ACTION_ID]);
  });

  it("create_server takes SSH key ids as integers, as list_ssh_keys returns them", async () => {
    const { call, fake } = await harness();
    const result = await call("create_server", {
      name: "x",
      server_type: "cpx11",
      image: "ubuntu-24.04",
      ssh_keys: [SSH_KEY_ID, "ci-deploy"],
    });
    expect(result.isError, result.text).toBe(false);
    expect((fake.calls[0]!.body as { ssh_keys: unknown }).ssh_keys).toEqual([
      SSH_KEY_ID,
      "ci-deploy",
    ]);
  });

  it("reads a server's top-level location when the deprecated datacenter is gone", async () => {
    const fake = new FakeHetzner();
    const { datacenter: _dropped, ...rest } = SERVER;
    void _dropped;
    fake.on("GET /v1/servers", {
      body: { servers: [{ ...rest, location: { name: "hel1" } }], meta: {} },
    });
    const { call } = await harness({ fake });
    const row = (await call("list_servers")).json.items[0];
    expect(row.location).toBe("hel1");
    expect(row.datacenter).toBeUndefined();
  });

  it("a request that gets no answer names the call and says a write may have landed", async () => {
    const broken: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const { server, registerHandlers } = createMCPServer({
      version: "t",
      env: { [ENV.apiToken]: TOKEN },
      fetch: broken,
      baseUrl: BASE,
    });
    await registerHandlers(server);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "t" });
    await Promise.all([server.connect(a), client.connect(b)]);
    clients.push(client);
    const result = (await client.callTool({
      name: "delete_server",
      arguments: { server_id: SERVER_ID },
    })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("DELETE /servers/42");
    expect(result.content[0]!.text).toContain("fetch failed");
    expect(result.content[0]!.text).toContain("WRITE");
  });
});

describe("catalog", () => {
  it("list_server_types flattens prices to gross EUR per location", async () => {
    const { call } = await harness();
    const result = await call("list_server_types", {});
    expect(result.json.items[0].prices_eur).toEqual([
      { location: "fsn1", monthly_gross: "297.5", hourly_gross: "0.476" },
    ]);
  });

  it("create_ssh_key refuses a private key and sends nothing", async () => {
    const { call, fake } = await harness();
    const result = await call("create_ssh_key", {
      name: "oops",
      public_key:
        "-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn\n-----END OPENSSH PRIVATE KEY-----",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("PRIVATE");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("firewalls", () => {
  it("set_firewall_rules sends the complete validated rule set", async () => {
    const { call, fake } = await harness();
    const result = await call("set_firewall_rules", {
      firewall_id: FIREWALL_ID,
      rules: [
        RULE,
        {
          direction: "out",
          protocol: "icmp",
          destination_ips: ["0.0.0.0/0"],
        },
      ],
    });
    expect(result.isError, result.text).toBe(false);
    expect(fake.calls[0]!.body).toEqual({
      rules: [
        RULE,
        { direction: "out", protocol: "icmp", destination_ips: ["0.0.0.0/0"] },
      ],
    });
    expect(result.json.action_ids).toEqual([ACTION_ID, ACTION_ID + 1]);
  });

  it("set_firewall_rules refuses an empty set unless clear_all is passed", async () => {
    const { call, fake } = await harness();
    const refused = await call("set_firewall_rules", {
      firewall_id: FIREWALL_ID,
      rules: [],
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("clear_all");
    expect(fake.calls).toHaveLength(0);
    const cleared = await call("set_firewall_rules", {
      firewall_id: FIREWALL_ID,
      rules: [],
      clear_all: true,
    });
    expect(cleared.isError, cleared.text).toBe(false);
    expect(fake.calls[0]!.body).toEqual({ rules: [] });
  });

  it("set_firewall_rules refuses a rule Hetzner would refuse or misread", async () => {
    const { call, fake } = await harness();
    for (const bad of [
      { direction: "in", protocol: "tcp", source_ips: ["0.0.0.0/0"] },
      { direction: "in", protocol: "tcp", port: "22" },
      { direction: "in", protocol: "icmp", port: "22", source_ips: ["::/0"] },
      { direction: "sideways", protocol: "tcp", port: "22" },
      { direction: "in", protocol: "tcp", port: "0", source_ips: ["::/0"] },
      { direction: "in", protocol: "tcp", port: "70000", source_ips: ["::/0"] },
      { direction: "in", protocol: "tcp", port: "90-80", source_ips: ["::/0"] },
    ]) {
      const result = await call("set_firewall_rules", {
        firewall_id: FIREWALL_ID,
        rules: [bad],
      });
      expect(result.isError, JSON.stringify(bad)).toBe(true);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("apply_firewall and remove_firewall name the one server", async () => {
    const { call, fake } = await harness();
    await call("apply_firewall", {
      firewall_id: FIREWALL_ID,
      server_id: SERVER_ID,
    });
    await call("remove_firewall", {
      firewall_id: FIREWALL_ID,
      server_id: SERVER_ID,
    });
    expect(fake.calls[0]!.body).toEqual({
      apply_to: [{ type: "server", server: { id: SERVER_ID } }],
    });
    expect(fake.calls[1]!.body).toEqual({
      remove_from: [{ type: "server", server: { id: SERVER_ID } }],
    });
  });
});

describe("input validation", () => {
  it("refuses an id that would splice another path, sending nothing", async () => {
    const { call, fake } = await harness();
    for (const [tool, args] of [
      ["get_server", { server_id: "42/actions" }],
      ["get_server", { server_id: 0 }],
      ["get_server", { server_id: -1 }],
      ["get_action", { action_id: "13?x=1" }],
      ["delete_image", { image_id: 1.5 }],
      [
        "create_server",
        {
          name: "x",
          server_type: "y",
          image: "z",
          ssh_keys: ["k"],
          firewall_ids: ["1/2"],
        },
      ],
    ] as const) {
      const result = await call(tool, args as Record<string, unknown>);
      expect(result.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("accepts a numeric string id", async () => {
    const { call, fake } = await harness();
    const result = await call("get_server", { server_id: "42" });
    expect(result.isError, result.text).toBe(false);
    expect(fake.calls[0]!.url.pathname).toBe("/v1/servers/42");
  });

  it("clamps per_page at Hetzner's 50 and reports the next page", async () => {
    const fake = new FakeHetzner();
    fake.on("GET /v1/servers", {
      body: {
        servers: [],
        meta: {
          pagination: {
            page: 2,
            per_page: 50,
            next_page: 3,
            total_entries: 140,
          },
        },
      },
    });
    const { call } = await harness({ fake });
    const result = await call("list_servers", { page: 2, per_page: 500 });
    const q = fake.calls[0]!.url.searchParams;
    expect(q.get("per_page")).toBe("50");
    expect(q.get("page")).toBe("2");
    expect(result.json).toMatchObject({
      page: 2,
      per_page: 50,
      total: 140,
      has_next_page: true,
      next_page: 3,
    });
  });

  it("an unknown tool is a protocol error naming what exists", async () => {
    const { client } = await harness();
    await expect(
      client.callTool({ name: "reset_password", arguments: {} }),
    ).rejects.toThrow(/list_servers/);
  });
});

describe("upstream failures", () => {
  it("a 404 says nothing has that id in this project", async () => {
    const { call } = await harness();
    const result = await call("get_server", { server_id: 999 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("HTTP 404");
    expect(result.text).toContain("not_found");
    expect(result.text).toContain("/servers/999");
  });

  it("a protected server says a human lifts protection", async () => {
    const fake = new FakeHetzner();
    fake.on(`DELETE /v1/servers/${SERVER_ID}`, {
      status: 403,
      body: {
        error: {
          code: "protected",
          message: "server deletion is protected",
          details: {},
        },
      },
    });
    const { call } = await harness({ fake });
    const result = await call("delete_server", { server_id: SERVER_ID });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("(protected)");
    expect(result.text).toContain("a human");
  });

  it("a read-only token says a Read & Write token is needed", async () => {
    const fake = new FakeHetzner();
    fake.on(`POST /v1/servers/${SERVER_ID}/actions/reboot`, {
      status: 403,
      body: {
        error: { code: "token_readonly", message: "token is read-only" },
      },
    });
    const { call } = await harness({ fake });
    const result = await call("power_server", {
      server_id: SERVER_ID,
      action: "reboot",
    });
    expect(result.text).toContain("Read & Write");
  });

  it("invalid_input names the fields Hetzner rejected", async () => {
    const fake = new FakeHetzner();
    fake.on("POST /v1/servers", {
      status: 400,
      body: {
        error: {
          code: "invalid_input",
          message: "invalid input in field 'server_type'",
          details: {
            fields: [
              { name: "server_type", messages: ["unknown server type"] },
            ],
          },
        },
      },
    });
    const { call } = await harness({ fake });
    const result = await call("create_server", {
      name: "x",
      server_type: "nope",
      image: "ubuntu-24.04",
      ssh_keys: ["k"],
    });
    expect(result.text).toContain("server_type: unknown server type");
  });

  it("a 429 says to wait", async () => {
    const fake = new FakeHetzner();
    fake.on("GET /v1/servers", {
      status: 429,
      body: { error: { code: "rate_limit_exceeded", message: "limit" } },
    });
    const { call } = await harness({ fake });
    const result = await call("list_servers", {});
    expect(result.text).toContain("3,600");
  });

  it("a non-JSON failure is quoted briefly", async () => {
    const fake = new FakeHetzner();
    fake.on("GET /v1/servers", {
      status: 502,
      text: "<html>Bad Gateway</html>",
    });
    const { call } = await harness({ fake });
    const result = await call("list_servers", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("HTTP 502");
    expect(result.text).toContain("Bad Gateway");
  });
});
