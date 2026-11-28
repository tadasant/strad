import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addDestination,
  ConfigSchema,
  loadConfig,
  reloadKeys,
  removeDestination,
} from "../src/config.js";
import { depositToken } from "../src/custody/deposit-wire.js";
import {
  destinationNames,
  resolveDestination,
} from "../src/custody/destinations.js";
import { startDaemon, type RunningDaemon } from "../src/daemon.js";
import {
  BROWSER_KEY,
  connect,
  resultJson,
  resultText,
  ScriptedPrompter,
  SHELL_KEY,
  testConfig,
  tmpState,
} from "./helpers.js";

/**
 * Every key here is a fixture, and both strads are fakes that record what they
 * were sent. Handles come from generate_keypair, so no Chrome is needed.
 */
const CUSTODY_KEY = "custody-key-0123456789abcdef0123456789abcd";
const PULSE_KEY = "pulse-deposit-key-0123456789abcdef01234567";

interface Seen {
  url: string;
  authorization?: string;
  value: string;
}

/** A fake strad deposit route that records each call and answers 201. */
function fakeStrad(seen: Seen[], env: string): Server {
  return createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const value = (JSON.parse(body || "{}") as { value: string }).value;
      seen.push({
        url: req.url ?? "",
        authorization: req.headers.authorization,
        value,
      });
      const [, , , slug, variable] = (req.url ?? "").split("/");
      res.writeHead(201, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          protocol: 1,
          path: `/strad/${env}/mcp/${slug}/static/${variable}`,
          version: "v1",
        }),
      );
    });
  });
}

const listen = async (s: Server) => {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
};

describe("custody destinations in the config", () => {
  const base = {
    capabilities: {
      shell: { enabled: true, key: SHELL_KEY },
      custody: { enabled: true, key: CUSTODY_KEY },
    },
  };

  it("is today's single destination when none are named", () => {
    const cfg = ConfigSchema.parse({
      ...base,
      custody: { stradUrl: "https://strad.example.com" },
    });
    expect(destinationNames(cfg)).toEqual(["default"]);
    const d = resolveDestination(cfg);
    expect(d).toMatchObject({
      ok: true,
      destination: {
        name: "default",
        url: "https://strad.example.com",
        key: CUSTODY_KEY,
        default: true,
      },
    });
  });

  it("refuses a destination key that opens a server on this machine", () => {
    for (const key of [SHELL_KEY, CUSTODY_KEY]) {
      const r = ConfigSchema.safeParse({
        ...base,
        custody: {
          destinations: {
            pulsemcp: { url: "https://strad.pulsemcp.com", key },
          },
        },
      });
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toMatch(/could open that server/);
    }
    const client = ConfigSchema.safeParse({
      capabilities: {
        shell: {
          enabled: true,
          key: SHELL_KEY,
          clientKeys: { laptop: PULSE_KEY },
        },
      },
      custody: {
        destinations: {
          pulsemcp: { url: "https://strad.pulsemcp.com", key: PULSE_KEY },
        },
      },
    });
    expect(client.success).toBe(false);
  });

  it("refuses a shared key, the default's name, plain http and a bad name", () => {
    const twice = ConfigSchema.safeParse({
      ...base,
      custody: {
        destinations: {
          a: { url: "https://a.example.com", key: PULSE_KEY },
          b: { url: "https://b.example.com", key: PULSE_KEY },
        },
      },
    });
    expect(twice.success).toBe(false);
    const clash = ConfigSchema.safeParse({
      ...base,
      custody: {
        stradName: "mine",
        destinations: {
          mine: { url: "https://x.example.com", key: PULSE_KEY },
        },
      },
    });
    expect(clash.success).toBe(false);
    const http = ConfigSchema.safeParse({
      ...base,
      custody: {
        destinations: {
          p: { url: "http://strad.pulsemcp.com", key: PULSE_KEY },
        },
      },
    });
    expect(http.success).toBe(false);
    const name = ConfigSchema.safeParse({
      ...base,
      custody: {
        destinations: {
          "Pulse MCP": { url: "https://x.example.com", key: PULSE_KEY },
        },
      },
    });
    expect(name.success).toBe(false);
  });

  it("adds a destination to the raw file object, once, and removes it", () => {
    const raw: Record<string, unknown> = structuredClone(base);
    addDestination(
      raw,
      "pulsemcp",
      "https://strad.pulsemcp.com",
      PULSE_KEY,
      "PulseMCP",
    );
    expect(ConfigSchema.parse(raw).custody.destinations).toEqual({
      pulsemcp: {
        url: "https://strad.pulsemcp.com",
        key: PULSE_KEY,
        title: "PulseMCP",
      },
    });
    expect(() =>
      addDestination(
        raw,
        "pulsemcp",
        "https://strad.pulsemcp.com",
        `${PULSE_KEY}x`,
      ),
    ).toThrow(/already exists/);
    // A refused add leaves nothing behind for the next write to carry.
    expect(() =>
      addDestination(raw, "other", "https://o.example.com", SHELL_KEY),
    ).toThrow();
    expect(
      Object.keys((raw.custody as { destinations: object }).destinations),
    ).toEqual(["pulsemcp"]);
    expect(removeDestination(raw, "pulsemcp")).toBe(true);
    expect(removeDestination(raw, "pulsemcp")).toBe(false);
  });

  it("treats a name that is also an Object.prototype key as just a name", () => {
    const raw: Record<string, unknown> = structuredClone(base);
    expect(removeDestination(raw, "constructor")).toBe(false);
    addDestination(raw, "constructor", "https://c.example.com", PULSE_KEY);
    expect(removeDestination(raw, "constructor")).toBe(true);
  });

  it("reloads destinations live, so a removal revokes at once", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "hostd-dest-")),
      "config.json",
    );
    const raw: Record<string, unknown> = structuredClone(base);
    addDestination(raw, "pulsemcp", "https://strad.pulsemcp.com", PULSE_KEY);
    writeFileSync(path, JSON.stringify(raw));
    const live = loadConfig(path);
    expect(resolveDestination(live, "pulsemcp").ok).toBe(true);
    removeDestination(raw, "pulsemcp");
    writeFileSync(path, JSON.stringify(raw));
    reloadKeys(live, path);
    expect(resolveDestination(live, "pulsemcp").ok).toBe(false);
    // A file whose client key collides with a destination key never goes live.
    addDestination(raw, "pulsemcp", "https://strad.pulsemcp.com", PULSE_KEY);
    (raw.capabilities as { shell: Record<string, unknown> }).shell.clientKeys =
      { laptop: PULSE_KEY };
    writeFileSync(path, JSON.stringify(raw));
    expect(() => reloadKeys(live, path)).toThrow(/could open that server/);
    expect(live.capabilities.shell.clientKeys).toEqual({});
  });

  it("does not resolve a name off the object prototype", () => {
    const cfg = ConfigSchema.parse(base);
    for (const name of ["constructor", "__proto__", "toString"])
      expect(resolveDestination(cfg, name).ok).toBe(false);
  });
});

describe("deposit, through the daemon, to named destinations", () => {
  let daemon: RunningDaemon;
  let mine: Server;
  let pulse: Server;
  const toMine: Seen[] = [];
  const toPulse: Seen[] = [];

  type C = Awaited<ReturnType<typeof connect>>;
  let custody: C;
  let grant = "";
  const call = (name: string, args: Record<string, unknown> = {}) =>
    custody.callTool({ name, arguments: { grant_id: grant, ...args } });
  const mintHandle = async () =>
    resultJson<{ handle: string }>(
      await call("generate_keypair", { comment: "strad destination test" }),
    ).handle;
  const lastPrivateKeyOf = (seen: Seen[]) => seen.at(-1)?.value ?? "";

  beforeAll(async () => {
    mine = fakeStrad(toMine, "prod");
    pulse = fakeStrad(toPulse, "prod");
    const mineUrl = await listen(mine);
    const pulseUrl = await listen(pulse);
    const base = testConfig({
      consent: { rejectCooldownSeconds: 0 },
      custody: {
        stradUrl: mineUrl,
        stradName: "mine",
        destinations: {
          pulsemcp: {
            url: pulseUrl,
            key: PULSE_KEY,
            title: "PulseMCP's strad",
          },
        },
      },
    });
    base.capabilities.custody = {
      enabled: true,
      key: CUSTODY_KEY,
      displayName: "custody-test-mbp",
      clientKeys: {},
    };
    daemon = await startDaemon(base, {
      stateDir: tmpState(),
      prompter: new ScriptedPrompter("allowed"),
      ephemeralPorts: true,
    });
    custody = await connect(daemon.mcpPort, "/custody/mcp", CUSTODY_KEY);
    grant = resultJson<{ grant_id: string }>(
      await custody.callTool({
        name: "request_control",
        arguments: { purpose: "Destination test. Nothing else." },
      }),
    ).grant_id;
  }, 30_000);

  afterAll(async () => {
    await custody?.close();
    await daemon?.stop();
    mine?.close();
    pulse?.close();
  });

  it("offers exactly the configured names, and no URL argument", async () => {
    const { tools } = await custody.listTools();
    const deposit = tools.find((t) => t.name === "deposit")!;
    const props = deposit.inputSchema.properties as Record<
      string,
      { enum?: string[] }
    >;
    expect(props.destination?.enum).toEqual(["mine", "pulsemcp"]);
    expect(Object.keys(props).sort()).toEqual([
      "destination",
      "gateway",
      "grant_id",
      "handle",
      "replace",
      "slug",
      "store",
      "target",
      "variable",
    ]);
    expect(deposit.inputSchema.required).not.toContain("destination");
    expect(deposit.description).toMatch(/"pulsemcp": PulseMCP's strad/);
  });

  it("omitted, goes to the default strad with the custody slug's derived bearer", async () => {
    const handle = await mintHandle();
    const res = await call("deposit", {
      handle,
      slug: "linear",
      variable: "LINEAR_API_KEY",
    });
    expect(resultJson(res)).toEqual({
      deposited: true,
      destination: "mine",
      path: "/strad/prod/mcp/linear/static/LINEAR_API_KEY",
      version: "v1",
    });
    expect(toMine).toHaveLength(1);
    expect(toPulse).toHaveLength(0);
    expect(toMine[0]).toMatchObject({
      url: "/_strad/deposit/linear/LINEAR_API_KEY",
      authorization: `Bearer ${depositToken(CUSTODY_KEY)}`,
    });
    expect(lastPrivateKeyOf(toMine)).toMatch(/OPENSSH PRIVATE KEY/);
  });

  it("named as the default, goes to the same place", async () => {
    const handle = await mintHandle();
    await call("deposit", {
      handle,
      slug: "granola",
      variable: "GRANOLA_KEY",
      destination: "mine",
    });
    expect(toMine).toHaveLength(2);
    expect(toPulse).toHaveLength(0);
  });

  it("pulsemcp, goes only there, with ITS key's bearer, never the custody one", async () => {
    const handle = await mintHandle();
    const res = await call("deposit", {
      handle,
      slug: "linear",
      variable: "LINEAR_API_KEY",
      destination: "pulsemcp",
    });
    expect(resultJson(res)).toMatchObject({
      deposited: true,
      destination: "pulsemcp",
    });
    expect(toMine).toHaveLength(2);
    expect(toPulse).toHaveLength(1);
    expect(toPulse[0]!.authorization).toBe(`Bearer ${depositToken(PULSE_KEY)}`);
    expect(toPulse[0]!.authorization).not.toBe(
      `Bearer ${depositToken(CUSTODY_KEY)}`,
    );
    const { handles } = resultJson<{
      handles: { handle: string; state: string; destination?: string }[];
    }>(await call("list_handles"));
    expect(handles.find((h) => h.handle === handle)).toMatchObject({
      state: "deposited",
      destination: "pulsemcp",
    });
  });

  it("refuses a name it does not have, and a URL, sending nothing anywhere", async () => {
    const handle = await mintHandle();
    for (const destination of [
      "evil",
      "https://attacker.example.com",
      "__proto__",
    ]) {
      const res = await call("deposit", {
        handle,
        slug: "linear",
        variable: "LINEAR_API_KEY",
        destination,
      });
      expect(res.isError).toBe(true);
      expect(resultText(res)).toMatch(
        /No deposit destination named .* Nothing was sent; the handle is still held/,
      );
    }
    expect(toMine).toHaveLength(2);
    expect(toPulse).toHaveLength(1);
    const { handles } = resultJson<{
      handles: { handle: string; state: string }[];
    }>(await call("list_handles"));
    expect(handles.find((h) => h.handle === handle)?.state).toBe("held");
    await call("discard_handle", { handle });
  });

  it("the pulsemcp key opens no server on this machine", async () => {
    await expect(
      connect(daemon.mcpPort, "/custody/mcp", PULSE_KEY),
    ).rejects.toThrow();
    await expect(
      connect(daemon.mcpPort, "/browser/mcp", PULSE_KEY),
    ).rejects.toThrow();
    // The real keys still do.
    const b = await connect(daemon.mcpPort, "/browser/mcp", BROWSER_KEY);
    await b.close();
  });
});

describe("deposit with no default strad set up", () => {
  it("names custody.stradUrl as what is missing", () => {
    const cfg = ConfigSchema.parse({
      capabilities: { custody: { enabled: true, key: CUSTODY_KEY } },
    });
    const r = resolveDestination(cfg);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.message).toMatch(/custody\.stradUrl is unset/);
  });
});

/** The BUILT cli, against a state dir, as the owner runs it on the Mac. */
const cli = (home: string, args: string[]) =>
  promisify(execFile)(process.execPath, ["build/cli.js", ...args], {
    env: { ...process.env, STRAD_HOSTD_HOME: home },
  });

describe("`strad-hostd destination add` against a running daemon", () => {
  let daemon: RunningDaemon;
  let pulse: Server;
  const toPulse: Seen[] = [];
  let pulseUrl = "";
  let home = "";
  let custody: Awaited<ReturnType<typeof connect>>;
  let grant = "";
  const call = (name: string, args: Record<string, unknown> = {}) =>
    custody.callTool({ name, arguments: { grant_id: grant, ...args } });
  const depositToPulse = async () => {
    const { handle } = resultJson<{ handle: string }>(
      await call("generate_keypair", { comment: "destination add test" }),
    );
    return call("deposit", {
      handle,
      slug: "linear",
      variable: "LINEAR_API_KEY",
      destination: "pulsemcp",
    });
  };

  beforeAll(async () => {
    pulse = fakeStrad(toPulse, "prod");
    pulseUrl = await listen(pulse);
    home = tmpState();
    const configPath = join(home, "config.json");
    const config = testConfig({ consent: { rejectCooldownSeconds: 0 } });
    config.capabilities.custody = {
      enabled: true,
      key: CUSTODY_KEY,
      displayName: "custody-test-mbp",
      clientKeys: {},
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    daemon = await startDaemon(config, {
      stateDir: home,
      prompter: new ScriptedPrompter("allowed"),
      ephemeralPorts: true,
      configPath,
    });
    // The cli finds the control listener by the file's controlPort.
    writeFileSync(
      configPath,
      JSON.stringify({ ...config, controlPort: daemon.controlPort }, null, 2),
    );
    custody = await connect(daemon.mcpPort, "/custody/mcp", CUSTODY_KEY);
    grant = resultJson<{ grant_id: string }>(
      await custody.callTool({
        name: "request_control",
        arguments: { purpose: "Destination add test. Nothing else." },
      }),
    ).grant_id;
  }, 30_000);

  afterAll(async () => {
    await custody?.close();
    await daemon?.stop();
    pulse?.close();
  });

  it("deposits into the new destination with no restart", async () => {
    const before = await depositToPulse();
    expect(before.isError).toBe(true);
    expect(resultText(before)).toMatch(
      /No deposit destination named "pulsemcp"/,
    );

    const { stdout } = await cli(home, [
      "destination",
      "add",
      "pulsemcp",
      "--url",
      pulseUrl,
    ]);
    expect(stdout).toMatch(/The running daemon deposits there at once/);
    const key = (
      JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
        custody: { destinations: Record<string, { key: string }> };
      }
    ).custody.destinations.pulsemcp!.key;

    const after = await depositToPulse();
    expect(resultJson(after)).toMatchObject({
      deposited: true,
      destination: "pulsemcp",
    });
    expect(toPulse).toHaveLength(1);
    expect(toPulse[0]!.authorization).toBe(`Bearer ${depositToken(key)}`);
  }, 30_000);

  it("says so when no daemon is running, and still writes the file", async () => {
    const stopped = tmpState();
    const { stdout } = await cli(stopped, ["init"]).then(() =>
      cli(stopped, ["destination", "add", "pulsemcp", "--url", pulseUrl]),
    );
    expect(stdout).toMatch(/The daemon is not running/);
    expect(
      Object.keys(
        (
          JSON.parse(readFileSync(join(stopped, "config.json"), "utf8")) as {
            custody: { destinations: object };
          }
        ).custody.destinations,
      ),
    ).toEqual(["pulsemcp"]);
  }, 30_000);
});
