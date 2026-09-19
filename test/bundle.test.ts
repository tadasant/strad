import { sharedSecretProviders } from "../src/secrets/provider/index.ts";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { componentToken } from "../src/auth/internal-token.ts";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { mintToken } from "../src/auth/tokens.ts";
import { parseConfig } from "../src/config/load.ts";
import { bundleUrlEnvName, Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { EnvSecretProvider } from "../src/secrets/provider/index.ts";

/**
 * Core -> bundle, the real two-process path.
 *
 * A bundle component is itself a strad gateway, so its tools come back ALREADY
 * namespaced. The first version of this shipped double-prefixed tools
 * (`bundled__bundled__whoami`) whose tools/call then forwarded a bare `whoami`
 * the bundle could not route. Staging caught it; this test keeps it caught.
 */

const YAML = `
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle-api
servers:
  - slug: bundled
    kind: builtin
    module: "./servers/echo.js"
    bundle: bundle-api
    entitlements: [admin]
    options: { greeting: "from the bundle" }
`;

const CONFIG = parseConfig(YAML);
const token = mintToken({ env: "test", label: "admin", roles: ["admin"] });
const INTERNAL = "internal-shared-secret";

let bundleServer: Server;
let coreServer: Server;
let coreUrl: string;

beforeAll(async () => {
  // --- the bundle component: internal-only, authenticated by ITS OWN token —
  //     what the renderer bakes onto it, derived from the root core holds.
  const bundleEnv: NodeJS.ProcessEnv = {
    STRAD_INTERNAL_TOKEN: componentToken(INTERNAL, "bundle-api"),
  };
  const bundleRegistry = await Registry.build({
    config: CONFIG,
    secrets: sharedSecretProviders(new EnvSecretProvider({})),
    mode: "bundle",
    bundleName: "bundle-api",
    env: bundleEnv,
  });
  const bundleApp = createApp({
    config: CONFIG,
    registry: bundleRegistry,
    tokenStore: tokenStoreFromConfig(CONFIG, bundleEnv),
    mode: "bundle",
    env: bundleEnv,
  });
  await new Promise<void>((r) => {
    bundleServer = bundleApp.listen(0, () => r());
  });
  const baddr = bundleServer.address();
  if (typeof baddr === "string" || !baddr) throw new Error("no port");

  // --- the core: reaches the bundle at what App Platform would inject as
  //     ${bundle-api.PRIVATE_URL}
  const coreEnv: NodeJS.ProcessEnv = {
    STRAD_TOKENS: JSON.stringify([token.record]),
    STRAD_INTERNAL_TOKEN: INTERNAL,
    [bundleUrlEnvName("bundle-api")]: `http://127.0.0.1:${baddr.port}`,
  };
  const coreRegistry = await Registry.build({
    config: CONFIG,
    secrets: sharedSecretProviders(new EnvSecretProvider({})),
    mode: "core",
    env: coreEnv,
  });
  const coreApp = createApp({
    config: CONFIG,
    registry: coreRegistry,
    tokenStore: tokenStoreFromConfig(CONFIG, coreEnv),
    mode: "core",
    env: coreEnv,
  });
  await new Promise<void>((r) => {
    coreServer = coreApp.listen(0, () => r());
  });
  const caddr = coreServer.address();
  if (typeof caddr === "string" || !caddr) throw new Error("no port");
  coreUrl = `http://127.0.0.1:${caddr.port}`;
});

afterAll(() => {
  coreServer?.close();
  bundleServer?.close();
});

async function client(servers?: string) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } =
    await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const url = new URL(`${coreUrl}/mcp`);
  if (servers) url.searchParams.set("servers", servers);
  const c = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await c.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: { authorization: `Bearer ${token.plaintext}` },
      },
    }),
  );
  return c;
}

describe("core -> bundle over the private network", () => {
  it("namespaces a bundled tool EXACTLY once", async () => {
    const c = await client();
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["bundled__echo", "bundled__whoami"]);
    // The bug this test exists for:
    expect(names.some((n) => n.includes("bundled__bundled__"))).toBe(false);
    await c.close();
  });

  it("routes a tools/call all the way through to the bundle process", async () => {
    const c = await client();
    const res = await c.callTool({
      name: "bundled__echo",
      arguments: { text: "through the private network" },
    });
    expect(res.content).toEqual([
      { type: "text", text: "through the private network" },
    ]);
    await c.close();
  });

  it("the bundle really is a different process, and says so", async () => {
    const c = await client();
    const res = (await c.callTool({
      name: "bundled__whoami",
      arguments: {},
    })) as { content: { text: string }[] };
    const reported = JSON.parse(res.content[0]!.text) as {
      component: string;
      bundle: string;
      greeting: string;
    };
    expect(reported.component).toBe("bundle");
    expect(reported.bundle).toBe("bundle-api");
    expect(reported.greeting).toBe("from the bundle");
    await c.close();
  });

  it("the bundle rejects a caller with no internal token", async () => {
    // It has no public route, but reachability is not authorization.
    const addr = bundleServer.address();
    if (typeof addr === "string" || !addr) throw new Error("no port");
    const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  // HACKS.md #63. A token is valid at exactly one component: the one it was
  // derived for. Another component's token — a VALID credential, for a
  // different container — and the root itself are both refused here.
  it("the bundle rejects another component's token, and the root", async () => {
    const addr = bundleServer.address();
    if (typeof addr === "string" || !addr) throw new Error("no port");
    for (const presented of [
      componentToken(INTERNAL, "bundle-zimmer-secrets"),
      INTERNAL,
    ]) {
      const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${presented}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        }),
      });
      expect(res.status).toBe(401);
    }
  });
});
