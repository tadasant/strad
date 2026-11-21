import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import http from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AT_REST_REDACTION_VERSION, redactAtRest } from "../src/at-rest.js";
import { AuditLog } from "../src/audit.js";
import { computerCapability } from "../src/computer/foreground.js";
import { computerHeadlessCapability } from "../src/computer/headless.js";
import { depositToken } from "../src/custody/deposit-wire.js";
import { startDaemon, type RunningDaemon } from "../src/daemon.js";
import type { HelperClient } from "../src/native/client.js";
import { configSecrets, replaceKnown } from "../src/redact.js";
import {
  connect,
  resultJson,
  resultText,
  ScriptedPrompter,
  SHELL_KEY,
  testConfig,
  tmpState,
} from "./helpers.js";

/**
 * Every value here is a fixture made up for this file. The point of each test
 * is that a secret-bearing call leaves NOTHING of the secret in any place the
 * daemon writes down: `audit.jsonl`, the audit's in-memory tail, the status
 * page, or a launchd log an older daemon wrote.
 */
const CUSTODY_KEY = "custody-key-fixture-0123456789abcdef01234567";
/** No digits, so no shape heuristic would catch it: only the exact pass can. */
const DESTINATION_KEY = "destination-key-for-tests-only-not-a-real-credential";
const BEARER = "faketoken0123456789abcdefghijklmnopqrstuv";
const QUERY_SECRET = "querysecretfixture0123456789ABCDEFGHIJ";
const TYPED = "hunter2-correct-horse";

describe("redaction of what is written down", () => {
  it("takes known values out exactly, labelled, before the shape rules", () => {
    const audit = new AuditLog();
    audit.redactKnown((t) =>
      replaceKnown(t, [
        { label: "secret h_abc", needles: ["plainwordsecretvalue"] },
      ]),
    );
    audit.record({
      kind: "tool",
      capability: "shell",
      detail: `run_command: echo plainwordsecretvalue && curl -H "Authorization: Bearer ${BEARER}" https://example.invalid/?token=${QUERY_SECRET}`,
    });
    const [entry] = audit.tail(1);
    expect(entry!.detail).toContain("[secret h_abc]");
    expect(entry!.detail).toContain("run_command: echo");
    for (const s of ["plainwordsecretvalue", BEARER, QUERY_SECRET])
      expect(entry!.detail).not.toContain(s);
  });

  it("knows every key the daemon holds, and the deposit bearers derived from them", () => {
    const config = testConfig({
      custody: {
        destinations: {
          other: { url: "https://strad.example.invalid", key: DESTINATION_KEY },
        },
      },
    });
    config.capabilities.custody = {
      enabled: true,
      key: CUSTODY_KEY,
      displayName: "custody-test-mbp",
      clientKeys: { laptop: "client-key-fixture-0123456789abcdef0123" },
    };
    const text = [
      SHELL_KEY,
      CUSTODY_KEY,
      depositToken(CUSTODY_KEY),
      DESTINATION_KEY,
      depositToken(DESTINATION_KEY),
      "client-key-fixture-0123456789abcdef0123",
    ].join(" ");
    const out = replaceKnown(text, configSecrets(config));
    expect(out).toContain("[redacted other destination key]");
    expect(out).toContain("[redacted deposit bearer]");
    for (const s of text.split(" ")) expect(out).not.toContain(s);
  });

  it("never puts a typed or set value in a tool's summary", () => {
    const helper = {} as HelperClient;
    const config = testConfig();
    const typeText = computerCapability(config, helper).tools.find(
      (t) => t.name === "type_text",
    )!;
    const setValue = computerHeadlessCapability(config, helper).tools.find(
      (t) => t.name === "set_value",
    )!;
    expect(typeText.summarize!({ text: TYPED })).toBe(
      `type_text: ${TYPED.length} chars`,
    );
    const set = setValue.summarize!({ element: "e1", value: TYPED });
    expect(set).toBe(`set_value: e1 = (text, ${TYPED.length} chars)`);
    expect(setValue.summarize!({ element: "e2", value: 3 })).toBe(
      "set_value: e2 = 3",
    );
  });
});

/** Raw http, because fetch will not let a test forge `Host`. */
function getPage(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(
        {
          host: "127.0.0.1",
          port,
          path: "/",
          headers: { host: `127.0.0.1:${port}` },
        },
        (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => resolve(body));
        },
      )
      .on("error", reject);
  });
}

describe("a deposit and a secret-carrying shell call, through the daemon", () => {
  let daemon: RunningDaemon;
  let strad: Server;
  let stateDir: string;
  const deposited: string[] = [];
  type C = Awaited<ReturnType<typeof connect>>;
  let custody: C;
  let shell: C;
  const grants: Record<string, string> = {};
  const call = (
    c: C,
    server: string,
    name: string,
    args: Record<string, unknown> = {},
  ) => c.callTool({ name, arguments: { grant_id: grants[server], ...args } });
  /** Every place the daemon writes down what happened. */
  const sinks = async () => [
    readFileSync(join(stateDir, "audit.jsonl"), "utf8"),
    JSON.stringify(daemon.core.deps.audit.tail(300)),
    await getPage(daemon.controlPort),
  ];

  beforeAll(async () => {
    strad = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        deposited.push((JSON.parse(body || "{}") as { value: string }).value);
        const [, , , slug, variable] = (req.url ?? "").split("/");
        res.writeHead(201, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            protocol: 1,
            path: `/strad/test/mcp/${slug}/static/${variable}`,
            version: "v1",
          }),
        );
      });
    });
    await new Promise<void>((r) => strad.listen(0, "127.0.0.1", r));
    const stradUrl = `http://127.0.0.1:${(strad.address() as { port: number }).port}`;
    const config = testConfig({
      consent: { rejectCooldownSeconds: 0 },
      custody: {
        stradUrl,
        destinations: {
          other: { url: stradUrl, key: DESTINATION_KEY },
        },
      },
    });
    config.capabilities.custody = {
      enabled: true,
      key: CUSTODY_KEY,
      displayName: "custody-test-mbp",
      clientKeys: {},
    };
    stateDir = tmpState();
    daemon = await startDaemon(config, {
      stateDir,
      prompter: new ScriptedPrompter("allowed"),
      ephemeralPorts: true,
    });
    custody = await connect(daemon.mcpPort, "/custody/mcp", CUSTODY_KEY);
    shell = await connect(daemon.mcpPort, "/shell/mcp", SHELL_KEY);
    for (const [name, c] of [
      ["custody", custody],
      ["shell", shell],
    ] as const) {
      grants[name] = resultJson<{ grant_id: string }>(
        await c.callTool({
          name: "request_control",
          arguments: {
            purpose: `Redaction test with password=${QUERY_SECRET} in it.`,
          },
        }),
      ).grant_id;
    }
  }, 30_000);

  afterAll(async () => {
    for (const c of [custody, shell]) await c?.close();
    await daemon?.stop();
    strad?.close();
  });

  it("records which secret went where, and never the secret", async () => {
    const { handle } = resultJson<{ handle: string }>(
      await call(custody, "custody", "generate_keypair", {
        comment: "strad ssh-redaction-test",
      }),
    );
    const res = await call(custody, "custody", "deposit", {
      handle,
      destination: "other",
      slug: "ssh-redaction-test",
      variable: "SSH_PRIVATE_KEY",
    });
    expect(res.isError).toBeFalsy();
    const value = deposited.at(-1)!;
    expect(value).toMatch(/PRIVATE KEY/);
    const bodyLines = value
      .split("\n")
      .filter((l) => l.length >= 24 && !l.startsWith("-----"));

    // Freed once deposited, the shell is used with the same value pasted in
    // (refused and recorded as a custody denial), and with secrets the vault
    // never held, in a command that is still running on the status page.
    const refused = await call(shell, "shell", "run_command", {
      command: `echo ${bodyLines[0]}`,
    });
    expect(refused.isError).toBe(true);
    await call(shell, "shell", "run_command", {
      command: `sleep 20 # curl -H "Authorization: Bearer ${BEARER}" --data key=${DESTINATION_KEY} "https://example.invalid/?token=${QUERY_SECRET}"`,
      wait_seconds: 0,
    });

    const all = await sinks();
    for (const sink of all) {
      expect(sink).not.toContain("PRIVATE KEY");
      for (const line of bodyLines) expect(sink).not.toContain(line);
      expect(sink).not.toContain(BEARER);
      expect(sink).not.toContain(DESTINATION_KEY);
      expect(sink).not.toContain(QUERY_SECRET);
      expect(sink).not.toContain(depositToken(DESTINATION_KEY));
    }
    const [file, , page] = all;
    // Still auditable: which handle, which destination, which slug/variable.
    expect(file).toContain(
      `deposit: ${handle} → other:ssh-redaction-test/SSH_PRIVATE_KEY`,
    );
    expect(file).toContain("[redacted other destination key]");
    expect(page).toContain("sleep 20");
    expect(page).toContain("Redaction test with password=[redacted]");
    expect(resultText(refused)).toMatch(/arguments contain the secret/);
  }, 30_000);
});

describe("what an older daemon left on disk", () => {
  const OLD_LINES = [
    {
      at: "2026-11-01T10:00:00.000Z",
      kind: "request",
      capability: "shell",
      detail: `shell-test-mbp: Seed it with token=${QUERY_SECRET} please.`,
    },
    {
      at: "2026-11-01T10:00:01.000Z",
      kind: "tool",
      capability: "shell",
      grantId: "g_old",
      detail: `run_command: echo plainwords | strad-cli set VALUE plainwordsecret`,
    },
    {
      at: "2026-11-01T10:00:02.000Z",
      kind: "tool",
      capability: "computer",
      grantId: "g_old",
      detail: `type_text: ${JSON.stringify(TYPED)}`,
    },
    {
      at: "2026-11-01T10:00:03.000Z",
      kind: "tool",
      capability: "browser",
      grantId: "g_old",
      detail: `evaluate_script: fetch('/x',{headers:{authorization:'Bearer ${BEARER}'}})`,
    },
    {
      at: "2026-11-01T10:00:04.000Z",
      kind: "tool",
      capability: "custody",
      grantId: "g_old",
      detail: "deposit: h_old → default:linear/LINEAR_API_KEY",
      extra: "an unknown field is not carried forward",
    },
  ];

  it("rewrites audit.jsonl and the launchd logs once, keeping who/what/when", async () => {
    const stateDir = tmpState();
    const audit = join(stateDir, "audit.jsonl");
    writeFileSync(
      audit,
      OLD_LINES.map((l) => JSON.stringify(l)).join("\n") +
        `\n{"torn line ${BEARER}\n`,
      { mode: 0o644 },
    );
    const log = join(stateDir, "com.strad.hostd.err.log");
    writeFileSync(
      log,
      `mcp on http://127.0.0.1:7311\nupstream said Authorization: Bearer ${BEARER}\nkey was ${DESTINATION_KEY}\n`,
    );
    const config = testConfig({
      custody: {
        destinations: {
          other: { url: "https://strad.example.invalid", key: DESTINATION_KEY },
        },
      },
    });

    const daemon = await startDaemon(config, {
      stateDir,
      prompter: new ScriptedPrompter("allowed"),
      ephemeralPorts: true,
      atRestLogs: [log, join(stateDir, "absent.log")],
    });
    await daemon.stop();

    const after = readFileSync(audit, "utf8");
    for (const s of [QUERY_SECRET, BEARER, TYPED, "plainwordsecret"])
      expect(after).not.toContain(s);
    const entries = after
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, string>);
    expect(entries).toHaveLength(OLD_LINES.length);
    expect(entries.map((e) => e.at)).toEqual(OLD_LINES.map((l) => l.at));
    expect(entries[1]).toEqual({
      at: OLD_LINES[1]!.at,
      kind: "tool",
      capability: "shell",
      grantId: "g_old",
      detail: `run_command: [arguments removed by at-rest redaction v${AT_REST_REDACTION_VERSION}]`,
    });
    expect(entries[4]!.detail).toBe(
      "deposit: h_old → default:linear/LINEAR_API_KEY",
    );
    expect(entries[4]).not.toHaveProperty("extra");
    expect(statSync(audit).mode & 0o777).toBe(0o600);

    const logAfter = readFileSync(log, "utf8");
    expect(logAfter).toContain("mcp on http://127.0.0.1:7311");
    expect(logAfter).not.toContain(BEARER);
    expect(logAfter).not.toContain(DESTINATION_KEY);
    expect(existsSync(join(stateDir, "at-rest-redaction"))).toBe(true);

    // Idempotent: a second start rewrites nothing, and new lines stay.
    writeFileSync(audit, after + '{"at":"x","kind":"tool","detail":"new"}\n');
    const again = redactAtRest(stateDir, (t) => replaceKnown(t, []), [log]);
    expect(again.ran).toBe(false);
    expect(readFileSync(audit, "utf8")).toContain('"detail":"new"');
  }, 30_000);
});
