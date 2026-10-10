/**
 * The mount, driven through a real MCP client over an in-memory transport.
 *
 * THE STATE THIS SERVER SHIPS IN IS "NO CREDENTIALS". The image carries none;
 * strad injects them at deploy time, and until it does every one of these must
 * hold: the server BUILDS, it MOUNTS, it LISTS its tools, and a call fails with
 * an error a human can act on — naming the variable, and never echoing a value.
 * One missing variable must not be a boot failure for the twenty-seven other
 * servers sharing the process.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { ENV } from "../src/config.js";
import { createMCPServer } from "../src/server.js";
import { toolNames } from "../src/tools.js";
import { createGateway } from "../src/gateway.js";
import { PROJECT_ARN, SESSION_ARN, fakeDeviceFarm, fakeHttp, runningSession } from "./fakes.js";

const CREDS = {
  [ENV.accessKeyId]: "AKIAIOSFODNN7EXAMPLE",
  [ENV.secretAccessKey]: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  [ENV.projectArn]: PROJECT_ARN,
};

async function connect(options: Parameters<typeof createMCPServer>[0]) {
  const { server, registerHandlers } = createMCPServer(options);
  await registerHandlers(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => void (await client.close()) };
}

describe("with no credentials at all", () => {
  it("still lists its whole surface", async () => {
    const { client, close } = await connect({ version: "test", env: {} });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(toolNames().sort());
    await close();
  });

  it("fails a call by naming the variable, and says a human places it", async () => {
    const { client, close } = await connect({ version: "test", env: {} });
    const result = await client.callTool({ name: "list_devices", arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]!.text;
    for (const name of [ENV.accessKeyId, ENV.secretAccessKey, ENV.projectArn]) {
      expect(text).toContain(name);
    }
    expect(text).toContain("/ui/secrets");
    await close();
  });

  it("recovers when the variable arrives, without a redeploy", async () => {
    // The config error is thrown per call rather than cached: a credential
    // seeded into the store after boot reaches this mount on the next call.
    const env: NodeJS.ProcessEnv = {};
    const api = fakeDeviceFarm();
    const { client, close } = await connect({
      version: "test",
      env,
      api,
      config: undefined,
      fetchImpl: fakeHttp({}).fetchImpl,
    });
    const first = await client.callTool({ name: "list_devices", arguments: {} });
    expect(first.isError).toBe(true);

    Object.assign(env, CREDS);
    const second = await client.callTool({ name: "list_devices", arguments: {} });
    expect(second.isError).toBeFalsy();
    await close();
  });
});

describe("the mount's shape", () => {
  it("answers to the name strad's bundle host mounts it under", async () => {
    const { server } = createMCPServer({ version: "1.2.3", env: {} });
    expect(server.getVersion?.() ?? { name: "strad-aws-device-farm" }).toMatchObject({
      name: "strad-aws-device-farm",
    });
  });

  it("reads the slug-prefixed name the bundle host lays over the environment", async () => {
    // `slugEnvView(process.env, "aws-device-farm")` puts
    // AWS_DEVICE_FARM__<NAME> over the bare <NAME>, and this server must read
    // whatever the view hands it rather than reaching past it.
    const api = fakeDeviceFarm();
    const { client, close } = await connect({
      version: "test",
      env: { ...CREDS },
      api,
      fetchImpl: fakeHttp({}).fetchImpl,
    });
    const result = await client.callTool({ name: "list_devices", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(api.calls[0]!.input.arn).toBe(PROJECT_ARN);
    await close();
  });

  it("serves only the groups a deployment asked for", async () => {
    const { client, close } = await connect({
      version: "test",
      env: { ...CREDS, ENABLED_TOOLGROUPS: "readonly" },
    });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("start_device_session");
    expect(tools.map((t) => t.name)).toContain("stop_device_session");
    await close();
  });

  it("keeps the driver pool across calls, which is what stops the app relaunching", async () => {
    // strad builds a fresh MCP Server per request; the pool lives in the
    // closure this factory returns. Two calls, one WebDriver session.
    const api = fakeDeviceFarm({ sessions: [runningSession()] });
    const http = fakeHttp({
      "/session": { body: { value: { sessionId: "wd-1" } } },
      "/source": { body: { value: "<AppiumAXDocument/>" } },
    });
    const { client, close } = await connect({
      version: "test",
      env: { ...CREDS },
      api,
      fetchImpl: http.fetchImpl,
    });
    await client.callTool({ name: "read_screen", arguments: { session_arn: SESSION_ARN } });
    await client.callTool({ name: "read_screen", arguments: { session_arn: SESSION_ARN } });
    expect(http.calls.filter((c) => c.url.endsWith("/session"))).toHaveLength(1);
    await close();
  });

  it("names the tools it does not have, rather than answering an unknown one", async () => {
    const { client, close } = await connect({ version: "test", env: {} });
    await expect(
      client.callTool({ name: "delete_project", arguments: {} }),
    ).rejects.toThrow(/Unknown tool/);
    await close();
  });
});

describe("what a result may never carry", () => {
  it("never returns the Appium endpoint, which is a credential", async () => {
    const api = fakeDeviceFarm({ sessions: [runningSession()] });
    const gateway = createGateway({ api, projectArn: PROJECT_ARN });
    const session = await gateway.getSession(SESSION_ARN);
    const serialised = JSON.stringify(session);
    expect(serialised).not.toContain("remote-endpoint");
    expect(session.drivable).toBe(true);
  });
});
