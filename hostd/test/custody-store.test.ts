import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { depositToken } from "../src/custody/deposit-wire.js";
import { startDaemon, type RunningDaemon } from "../src/daemon.js";
import {
  connect,
  resultJson,
  resultText,
  ScriptedPrompter,
  testConfig,
  tmpState,
} from "./helpers.js";

/**
 * The `deposit` tool's STORE form — `store` + `target`, and `replace` — against
 * a fake strad that records what it was sent. strad's own rules (which store,
 * which prefixes, whether replace is allowed) are core's and are tested there
 * (test/deposit-store.test.ts); what this side owes is the wire: the route, the
 * body, the bearer, and refusing a malformed call before anything is sent.
 */
const CUSTODY_KEY = "custody-key-0123456789abcdef0123456789abcd";

interface Seen {
  url: string;
  authorization?: string;
  body: { value?: string; replace?: unknown };
}

describe("deposit into a named store", () => {
  let daemon: RunningDaemon;
  let strad: Server;
  const seen: Seen[] = [];
  let custody: Awaited<ReturnType<typeof connect>>;
  let grant = "";
  const call = (name: string, args: Record<string, unknown> = {}) =>
    custody.callTool({ name, arguments: { grant_id: grant, ...args } });
  const mintHandle = async () =>
    resultJson<{ handle: string }>(
      await call("generate_keypair", { comment: "store deposit test" }),
    ).handle;

  beforeAll(async () => {
    strad = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as Seen["body"];
        seen.push({
          url: req.url ?? "",
          authorization: req.headers.authorization,
          body,
        });
        const target = decodeURIComponent((req.url ?? "").split("/").at(-1)!);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            protocol: 1,
            path: target,
            version: "v1",
            ...(body.replace === true
              ? { replaced: true, valueVersion: "2" }
              : {}),
          }),
        );
      });
    });
    await new Promise<void>((r) => strad.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(strad.address() as { port: number }).port}`;
    const base = testConfig({
      consent: { rejectCooldownSeconds: 0 },
      custody: { stradUrl: url },
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
        arguments: { purpose: "Store deposit test. Nothing else." },
      }),
    ).grant_id;
  }, 30_000);

  afterAll(async () => {
    await custody?.close();
    await daemon?.stop();
    strad?.close();
  });

  it("posts to _store/{store}/{target}, the target as ONE encoded segment", async () => {
    const handle = await mintHandle();
    const target =
      "/zimmer/production/secrets/static/TRANSCRIPT_STORAGE_BUCKET";
    const res = await call("deposit", {
      handle,
      store: "zimmer-production",
      target,
    });
    expect(resultJson(res)).toEqual({
      deposited: true,
      destination: "default",
      store: "zimmer-production",
      path: target,
      version: "v1",
    });
    expect(seen.at(-1)).toMatchObject({
      url: `/_strad/deposit/_store/zimmer-production/${encodeURIComponent(target)}`,
      authorization: `Bearer ${depositToken(CUSTODY_KEY)}`,
    });
    // Create-only unless asked: no `replace` key on the wire at all.
    expect(Object.keys(seen.at(-1)!.body)).toEqual(["value"]);
  });

  it("sends replace: true only when the call asks, and reports what it replaced", async () => {
    const handle = await mintHandle();
    const res = await call("deposit", {
      handle,
      store: "deploy-workflow",
      target: "app-otel-ingest-token",
      replace: true,
    });
    expect(resultJson(res)).toMatchObject({
      store: "deploy-workflow",
      replaced: true,
      value_version: "2",
    });
    expect(seen.at(-1)!.body.replace).toBe(true);
  });

  it.each([
    [{ store: "s" }, /store AND target/],
    [{ target: "app-x" }, /store AND target/],
    [{ store: "s", target: "app-x", slug: "linear" }, /none of slug/],
    [{ store: "s", target: "app-x", variable: "X" }, /none of slug/],
    [{ store: "S_BAD", target: "app-x" }, /deposit store's name/],
    [{ store: "s", target: "/a/../b" }, /parameter path or a secret id/],
    [{ slug: "linear", variable: "K", replace: true }, /store deposit only/],
  ])("refuses %j before sending anything", async (args, message) => {
    const handle = await mintHandle();
    const before = seen.length;
    const res = await call("deposit", { handle, ...args });
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(message);
    expect(resultText(res)).toMatch(/Nothing was sent/);
    expect(seen.length).toBe(before);
    await call("discard_handle", { handle });
  });
});
