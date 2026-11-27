/**
 * The server end to end, through a real MCP client over an in-memory transport,
 * against a fake Hatchbox answering on the paths the npm `hatchbox-mcp-server`
 * calls, in the shapes it parses. The SSH reader is injected here; ssh.test.ts
 * drives the real one.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  createMCPServer,
  degradedReason,
  HATCHBOX_ENV_NAMES,
  MAX_RESULT_CHARS,
  TOOL_NAMES,
  type EnvironReader,
} from "../src/index.js";
import { keyPair } from "./fake-host.js";

const API_KEY = "hb-api-key-0123456789abcdef";
const DEPLOY_KEY = "dk_0123456789abcdefXYZ";
const CLIENT_KEY = keyPair();
const HOST_PIN = `ssh-ed25519 ${keyPair().public.trim().split(/\s+/)[1]}`;

const API_ENV = { HATCHBOX_APP_ID: "8540", HATCHBOX_ACCOUNT_ID: "1852", HATCHBOX_API_KEY: API_KEY };
const DEPLOY_ENV = { HATCHBOX_APP_ID: "8540", HATCHBOX_DEPLOY_KEY: DEPLOY_KEY };
const SSH_ENV = {
  HATCHBOX_APP_ID: "8540",
  HATCHBOX_SSH_HOST: "203.0.113.7",
  HATCHBOX_SSH_PRIVATE_KEY: CLIENT_KEY.private,
  HATCHBOX_SSH_HOST_KEY: HOST_PIN,
};
const FULL_ENV = { ...API_ENV, ...DEPLOY_ENV, ...SSH_ENV };

interface Seen {
  url: URL;
  init: RequestInit;
}

type Route = (url: URL, init: RequestInit) => { status?: number; body: unknown; headers?: Record<string, string> };

function fakeHatchbox(routes: Record<string, Route> = {}) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    seen.push({ url, init: init ?? {} });
    const route = routes[`${init?.method ?? "GET"} ${url.pathname}`];
    if (!route) return new Response(JSON.stringify({ error: "Not Found" }), { status: 404 });
    const r = route(url, init ?? {});
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

const ENV_PATH = "/api/v1/accounts/1852/apps/8540/env_vars";

const reader =
  (vars: Record<string, string>): EnvironReader =>
  async () => ({
    pid: 4242,
    vars: Object.entries(vars)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function connect(
  env: Record<string, string>,
  opts: { fetch?: typeof fetch; readEnviron?: EnvironReader } = {},
) {
  const created = createMCPServer({ version: "test", env, ...opts });
  const server = new Server({ name: "strad-hatchbox", version: "test" }, { capabilities: { tools: {} } });
  await created.registerHandlers(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "test" });
  await Promise.all([server.connect(a), client.connect(b)]);
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    return { text: r.content[0]!.text, isError: r.isError === true };
  };
  return { client, call, created };
}

describe("the tool surface", () => {
  it("lists all six tools with no configuration at all — never an empty tools/list", async () => {
    const { client } = await connect({});
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "getEnvVars",
      "getEnvVar",
      "setEnvVar",
      "deleteEnvVars",
      "triggerDeploy",
      "checkDeploy",
    ]);
    expect(TOOL_NAMES).toHaveLength(6);
  });

  it("lists all six whatever upstream's READONLY / ALLOW_DEPLOYS say (pulsemcp/pulsemcp#3492)", async () => {
    const { client } = await connect({ READONLY: "true", ALLOW_DEPLOYS: "false" });
    expect((await client.listTools()).tools).toHaveLength(6);
  });

  it("annotates the reads read-only and the writes and the deploy destructive", async () => {
    const { client } = await connect({});
    const by = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t.annotations]));
    for (const name of ["getEnvVars", "getEnvVar", "checkDeploy"]) {
      expect(by[name]).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    for (const name of ["setEnvVar", "deleteEnvVars", "triggerDeploy"]) {
      expect(by[name]).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    expect(by.triggerDeploy).toMatchObject({ idempotentHint: false });
  });

  it("is discovered on HATCHBOX_APP_ID alone, so every tier is found without another tier's key", () => {
    expect(HATCHBOX_ENV_NAMES).toEqual(["HATCHBOX_APP_ID"]);
  });
});

describe("degraded and refused", () => {
  it("is degraded with nothing configured, naming what is missing", () => {
    const reason = degradedReason({});
    expect(reason).toMatch(/no tool group is configured/);
    expect(reason).toContain("HATCHBOX_API_KEY");
    expect(reason).toContain("HATCHBOX_DEPLOY_KEY");
    expect(reason).toContain("HATCHBOX_SSH_PRIVATE_KEY");
  });

  it("is healthy with any one group configured", () => {
    expect(degradedReason(DEPLOY_ENV)).toBeNull();
    expect(degradedReason(SSH_ENV)).toBeNull();
    expect(degradedReason(API_ENV)).toBeNull();
  });

  it("is degraded, and refuses every call, while an upstream variable is set", async () => {
    for (const legacy of ["READONLY", "ALLOW_DEPLOYS", "WEB_SERVER_IP_ADDRESS", "SSH_KEY_PATH"]) {
      const hb = fakeHatchbox();
      const env = { ...FULL_ENV, [legacy]: legacy === "READONLY" ? "true" : "x" };
      expect(degradedReason(env)).toContain(legacy);
      const { call } = await connect(env, { fetch: hb.fetchImpl, readEnviron: reader({ A: "1" }) });
      for (const [tool, args] of [
        ["triggerDeploy", {}],
        ["setEnvVar", { name: "A", value: "b" }],
        ["getEnvVar", { name: "A" }],
      ] as const) {
        const r = await call(tool, args);
        expect(r.isError).toBe(true);
        expect(r.text).toContain(legacy);
        expect(r.text).toMatch(/does not read/);
      }
      expect(hb.seen).toHaveLength(0);
    }
  });

  it("names what a tool's group is missing and sends nothing", async () => {
    const hb = fakeHatchbox();
    let read = false;
    const { call } = await connect(DEPLOY_ENV, {
      fetch: hb.fetchImpl,
      readEnviron: async () => {
        read = true;
        return { pid: 1, vars: [] };
      },
    });
    const set = await call("setEnvVar", { name: "A", value: "b" });
    expect(set.isError).toBe(true);
    expect(set.text).toContain("HATCHBOX_ACCOUNT_ID, HATCHBOX_API_KEY are not set");
    const get = await call("getEnvVars");
    expect(get.isError).toBe(true);
    expect(get.text).toContain("HATCHBOX_SSH_HOST, HATCHBOX_SSH_PRIVATE_KEY, HATCHBOX_SSH_HOST_KEY");
    expect(hb.seen).toHaveLength(0);
    expect(read).toBe(false);
  });

  it("refuses a deploy key that is a whole URL, without quoting it", async () => {
    const url = `https://hatchbox.io/webhooks/deployments/${DEPLOY_KEY}`;
    const { call } = await connect({ ...DEPLOY_ENV, HATCHBOX_DEPLOY_KEY: url });
    const r = await call("triggerDeploy");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/last path segment/);
    expect(r.text).not.toContain(DEPLOY_KEY);
  });

  it("refuses a public key where the private one goes", async () => {
    const { call } = await connect({ ...SSH_ENV, HATCHBOX_SSH_PRIVATE_KEY: CLIENT_KEY.public });
    const r = await call("getEnvVars");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/PUBLIC key|could not be read/);
  });

  it("refuses an app name that is not a plain name", async () => {
    const { call } = await connect({ ...SSH_ENV, HATCHBOX_APP_NAME: "x'; rm -rf / #" }, { readEnviron: reader({}) });
    const r = await call("getEnvVars");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("HATCHBOX_APP_NAME");
  });
});

describe("env var writes", () => {
  it("setEnvVar PUTs one variable with the bearer key, and returns names, never values", async () => {
    const hb = fakeHatchbox({
      [`PUT ${ENV_PATH}`]: () => ({
        body: {
          env_vars: [
            { name: "FEATURE_X", value: "on" },
            { name: "DATABASE_URL", value: "postgres://u:hunter2@db/app" },
          ],
        },
      }),
    });
    const { call } = await connect(API_ENV, { fetch: hb.fetchImpl });
    const r = await call("setEnvVar", { name: "FEATURE_X", value: "on" });
    expect(r.isError).toBe(false);
    expect(hb.seen).toHaveLength(1);
    const { url, init } = hb.seen[0]!;
    expect(url.origin).toBe("https://hatchbox.io");
    expect(url.pathname).toBe(ENV_PATH);
    expect(init.method).toBe("PUT");
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(init.body as string)).toEqual({ env_vars: [{ name: "FEATURE_X", value: "on" }] });
    const out = JSON.parse(r.text);
    expect(out).toMatchObject({ set: "FEATURE_X", count: 2, names: ["FEATURE_X", "DATABASE_URL"] });
    expect(r.text).not.toContain("hunter2");
  });

  it("setEnvVar accepts an empty response body", async () => {
    const hb = fakeHatchbox({ [`PUT ${ENV_PATH}`]: () => ({ body: "" }) });
    const { call } = await connect(API_ENV, { fetch: hb.fetchImpl });
    const r = await call("setEnvVar", { name: "A", value: "" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toEqual({ set: "A", takes_effect: "on the next deploy" });
  });

  it("deleteEnvVars DELETEs the de-duplicated names", async () => {
    const hb = fakeHatchbox({
      [`DELETE ${ENV_PATH}`]: () => ({ body: { env_vars: [{ name: "KEEP", value: "1" }] } }),
    });
    const { call } = await connect(API_ENV, { fetch: hb.fetchImpl });
    const r = await call("deleteEnvVars", { names: ["OLD", "OLDER", "OLD"] });
    expect(r.isError).toBe(false);
    expect(JSON.parse(hb.seen[0]!.init.body as string)).toEqual({ env_vars: ["OLD", "OLDER"] });
    expect(JSON.parse(r.text)).toMatchObject({ deleted: ["OLD", "OLDER"], remaining_count: 1 });
  });

  it("refuses bad names and arguments before sending anything", async () => {
    const hb = fakeHatchbox();
    const { call } = await connect(API_ENV, { fetch: hb.fetchImpl });
    for (const [tool, args] of [
      ["setEnvVar", { name: "1BAD", value: "x" }],
      ["setEnvVar", { name: "A=B", value: "x" }],
      ["setEnvVar", { name: "A", value: 5 }],
      ["setEnvVar", { name: "A", value: "x", extra: true }],
      ["deleteEnvVars", { names: [] }],
      ["deleteEnvVars", { names: ["OK", "../x"] }],
      ["deleteEnvVars", { names: Array.from({ length: 51 }, (_, i) => `V${i}`) }],
    ] as const) {
      const r = await call(tool, args as Record<string, unknown>);
      expect(r.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
    }
    expect(hb.seen).toHaveLength(0);
  });

  it("says what a 401 means, from an HTML body", async () => {
    const hb = fakeHatchbox({ [`PUT ${ENV_PATH}`]: () => ({ status: 401, body: "<html></html>" }) });
    const { call } = await connect(API_ENV, { fetch: hb.fetchImpl });
    const r = await call("setEnvVar", { name: "A", value: "b" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/HTTP 401/);
    expect(r.text).toMatch(/rejected HATCHBOX_API_KEY/);
  });

  it("passes Hatchbox's own 422 message through", async () => {
    const hb = fakeHatchbox({
      [`PUT ${ENV_PATH}`]: () => ({ status: 422, body: { errors: ["Name is reserved"] } }),
    });
    const { call } = await connect(API_ENV, { fetch: hb.fetchImpl });
    const r = await call("setEnvVar", { name: "A", value: "b" });
    expect(r.text).toContain("Name is reserved");
  });

  it("refuses a redirect rather than following it with the key", async () => {
    const hb = fakeHatchbox({
      [`PUT ${ENV_PATH}`]: () => ({ status: 301, body: "", headers: { location: "https://elsewhere.example/" } }),
    });
    const { call } = await connect(API_ENV, { fetch: hb.fetchImpl });
    const r = await call("setEnvVar", { name: "A", value: "b" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/redirect \(HTTP 301\)/);
    expect(hb.seen).toHaveLength(1);
  });

  it("scrubs the API key from an error that echoes it", async () => {
    const hb = fakeHatchbox({
      [`PUT ${ENV_PATH}`]: () => ({ status: 403, body: { error: `token ${API_KEY} may not` } }),
    });
    const { call } = await connect(API_ENV, { fetch: hb.fetchImpl });
    const r = await call("setEnvVar", { name: "A", value: "b" });
    expect(r.text).not.toContain(API_KEY);
    expect(r.text).toContain("[redacted]");
  });

  it("reports a transport failure and a timeout as such", async () => {
    const failing = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }) as typeof fetch;
    const a = await connect(API_ENV, { fetch: failing });
    const r = await a.call("setEnvVar", { name: "A", value: "b" });
    expect(r.text).toMatch(/Could not reach Hatchbox.*ECONNREFUSED/);

    const hung = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof fetch;
    const created = createMCPServer({ version: "t", env: API_ENV, fetch: hung, timeoutMs: 50 });
    const server = new Server({ name: "s", version: "t" }, { capabilities: { tools: {} } });
    await created.registerHandlers(server);
    const [x, y] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "t" });
    await Promise.all([server.connect(x), client.connect(y)]);
    clients.push(client);
    const t = (await client.callTool({ name: "setEnvVar", arguments: { name: "A", value: "b" } })) as {
      content: Array<{ text: string }>;
    };
    expect(t.content[0]!.text).toMatch(/did not answer within 50 ms.*check before retrying a write/);
  });
});

describe("deploys", () => {
  const hook = `/webhooks/deployments/${DEPLOY_KEY}`;

  it("triggerDeploy POSTs the webhook for the latest commit, with no Authorization header", async () => {
    const hb = fakeHatchbox({ [`POST ${hook}`]: () => ({ body: { id: 98765, status: "pending" } }) });
    const { call } = await connect(DEPLOY_ENV, { fetch: hb.fetchImpl });
    const r = await call("triggerDeploy");
    expect(r.isError).toBe(false);
    const { url, init } = hb.seen[0]!;
    expect(url.search).toBe("?latest=true");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(r.text)).toMatchObject({ triggered: true, activity_id: "98765", status: "pending" });
    // The deploy key is in the URL; it never comes back in a result.
    expect(r.text).not.toContain(DEPLOY_KEY);
  });

  it("triggerDeploy deploys a given sha, and refuses one that is not hex", async () => {
    const hb = fakeHatchbox({ [`POST ${hook}`]: () => ({ body: { activity_id: "a1" } }) });
    const { call } = await connect(DEPLOY_ENV, { fetch: hb.fetchImpl });
    const ok = await call("triggerDeploy", { sha: "ff28bd55fb6a" });
    expect(hb.seen[0]!.url.search).toBe("?sha=ff28bd55fb6a");
    expect(JSON.parse(ok.text).activity_id).toBe("a1");
    for (const sha of ["main", "ff28bd5&latest=true", "abc"]) {
      expect((await call("triggerDeploy", { sha })).isError).toBe(true);
    }
    expect(hb.seen).toHaveLength(1);
  });

  it("triggerDeploy says when Hatchbox returned no activity id", async () => {
    const hb = fakeHatchbox({ [`POST ${hook}`]: () => ({ body: {} }) });
    const { call } = await connect(DEPLOY_ENV, { fetch: hb.fetchImpl });
    const out = JSON.parse((await call("triggerDeploy")).text);
    expect(out.activity_id).toBeNull();
    expect(out.next).toMatch(/no activity id/);
  });

  it("triggerDeploy reports Hatchbox's 404 for an unknown deploy key", async () => {
    // The live answer for an unknown key: 404 {"message":"App not found"}.
    const hb = fakeHatchbox({ [`POST ${hook}`]: () => ({ status: 404, body: { message: "App not found" } }) });
    const { call } = await connect(DEPLOY_ENV, { fetch: hb.fetchImpl });
    const r = await call("triggerDeploy");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("App not found");
    expect(r.text).not.toContain(DEPLOY_KEY);
  });

  it("checkDeploy reads the activity and keeps the END of long output", async () => {
    const long = "x".repeat(30_000) + "\nERROR: migration failed";
    const hb = fakeHatchbox({
      [`GET /apps/${DEPLOY_KEY}/activities/98765`]: () => ({ body: { status: "failed", output: long } }),
    });
    const { call } = await connect(DEPLOY_ENV, { fetch: hb.fetchImpl });
    const out = JSON.parse((await call("checkDeploy", { activityId: "98765" })).text);
    expect(out.status).toBe("failed");
    expect(out.output.endsWith("ERROR: migration failed")).toBe(true);
    expect(out.output).toHaveLength(20_000);
    expect(out.output_cut).toMatch(/last 20000/);
  });

  it("checkDeploy refuses an activity id that would splice the path", async () => {
    const hb = fakeHatchbox();
    const { call } = await connect(DEPLOY_ENV, { fetch: hb.fetchImpl });
    expect((await call("checkDeploy", { activityId: "../../x" })).isError).toBe(true);
    expect(hb.seen).toHaveLength(0);
  });
});

describe("env var reads", () => {
  it("getEnvVars returns the running environment, or its names only", async () => {
    const { call } = await connect(SSH_ENV, { readEnviron: reader({ RAILS_ENV: "production", SECRET: "s3cr3t" }) });
    const full = JSON.parse((await call("getEnvVars")).text);
    expect(full).toMatchObject({ app_id: "8540", pid: 4242, count: 2, env_vars: { RAILS_ENV: "production", SECRET: "s3cr3t" } });
    const names = await call("getEnvVars", { names_only: true });
    expect(JSON.parse(names.text).names).toEqual(["RAILS_ENV", "SECRET"]);
    expect(names.text).not.toContain("s3cr3t");
  });

  it("getEnvVar returns one value, or says it is not set", async () => {
    const { call } = await connect(SSH_ENV, { readEnviron: reader({ RAILS_ENV: "production" }) });
    expect(JSON.parse((await call("getEnvVar", { name: "RAILS_ENV" })).text)).toEqual({
      name: "RAILS_ENV",
      found: true,
      value: "production",
    });
    const missing = JSON.parse((await call("getEnvVar", { name: "NOPE" })).text);
    expect(missing.found).toBe(false);
    expect(missing.note).toMatch(/next deploy/);
  });

  it("scrubs this slug's own credentials out of the app's environment", async () => {
    const { call } = await connect(FULL_ENV, {
      readEnviron: reader({ HATCHBOX_DEPLOY_KEY: DEPLOY_KEY, OTHER: `has ${API_KEY} inside` }),
    });
    const r = await call("getEnvVars");
    expect(r.text).not.toContain(DEPLOY_KEY);
    expect(r.text).not.toContain(API_KEY);
  });

  it("cuts a result over the cap, and says how to ask for less", async () => {
    const vars = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`VAR_${i}`, "v".repeat(300)]));
    const { call } = await connect(SSH_ENV, { readEnviron: reader(vars) });
    const r = await call("getEnvVars");
    expect(r.text.length).toBeLessThan(MAX_RESULT_CHARS + 300);
    expect(r.text).toMatch(/names_only/);
  });
});
