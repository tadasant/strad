import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditLog } from "../src/audit.js";
import {
  MAX_SCREEN_CHARS,
  normalizeSession,
  screenText,
} from "../src/consent/display.js";
import { ConsentGate } from "../src/consent/gate.js";
import { GrantStore, RECENT_CALLS } from "../src/consent/grants.js";
import { startDaemon, type RunningDaemon } from "../src/daemon.js";
import { KillSwitch } from "../src/killswitch.js";
import type { HelperClient } from "../src/native/client.js";
import { Presence } from "../src/native/presence.js";
import {
  connect,
  resultJson,
  ScriptedPrompter,
  SHELL_KEY,
  testConfig,
  tmpState,
} from "./helpers.js";

describe("call summaries headed for the screen", () => {
  it.each([
    [
      `curl -H "Authorization: Bearer abc.def.ghi" https://x.test`,
      "abc.def.ghi",
    ],
    ["curl -H 'authorization: token s3cr3tvalue' x", "s3cr3tvalue"],
    ["mysql --password hunter2forreal db", "hunter2forreal"],
    ["deploy --api-key=AbC123xyz", "AbC123xyz"],
    ["export GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "ghp_aaaa"],
    ["open https://x.test/cb?code=1&access_token=zzz999yyy", "zzz999yyy"],
    ["git clone https://me:hunter2@github.com/o/r", "hunter2"],
    [`echo '{"client_secret": "qwertyuiop"}'`, "qwertyuiop"],
    [
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "eyJhbGci",
    ],
    ["aws AKIAABCDEFGHIJKLMNOP s3 ls", "AKIAABCDEFGHIJKLMNOP"],
    [
      "echo dGhpcyBpcyBhIHNlY3JldCBrZXkgdGhhdCBpcyBsb25nIEVOT1VHSDEyMw==",
      "dGhpcyBp",
    ],
    [
      "printf '-----BEGIN OPENSSH PRIVATE KEY-----\\nb3BlbnNzaA\\n-----END OPENSSH PRIVATE KEY-----'",
      "b3BlbnNzaA",
    ],
    ["curl -H 'Cookie: theme=dark; auth=abcdef123456' x", "abcdef123456"],
    ["curl -u admin:hunter2 https://x.test", "hunter2"],
    [`doctl --access-token dop_v1_${"ab12".repeat(16)}`, "dop_v1_ab12"],
    [`echo dop_v1_${"ab12".repeat(16)}`, "dop_v1_ab12"],
    ["stripe sk_live_abcdefghijklmnop1234", "sk_live_abc"],
    ["echo npm_abcdefghijklmnopqrstuvwxyz0123", "npm_abcdef"],
    [
      `curl -H 'X-Auth: ${"0123456789abcdef".repeat(2)}' x`,
      "0123456789abcdef0123",
    ],
  ])("scrubs %s", (raw, secret) => {
    const out = screenText(raw);
    expect(out).not.toContain(secret);
    expect(out).toMatch(/\[redacted/);
  });

  it.each([
    "run_command: git checkout 0123456789abcdef0123456789abcdef01234567",
    "run_command: ls /Users/someone/Library/Application_Support/SomethingLong2/Cache",
    "navigate_tab: https://example.com/docs/getting-started?page=2",
    "click_element: button[data-test=submit-token-form]",
    "run_command: git commit -m 'refresh the token handling'",
    "run_command: git log --author=someone -n 5",
  ])("leaves ordinary text alone: %s", (raw) => {
    expect(screenText(raw)).toBe(raw);
  });

  it("shows the length of typed or set text, never the text", () => {
    expect(screenText('type_text: "hunter2"')).toBe("type_text: 7 chars");
    expect(screenText(`type_text: ${JSON.stringify("x".repeat(80))}`)).toBe(
      "type_text: 80+ chars",
    );
    expect(screenText('set_value: e12 = "hunter2"')).toBe(
      "set_value: e12 = (text, 7 chars)",
    );
    // The browser's own summary already carries only a length.
    expect(screenText("type_text: 7 chars into #pw")).toBe(
      "type_text: 7 chars into #pw",
    );
  });

  it("caps the length and strips control characters", () => {
    const out = screenText(`run_command: ${"x ".repeat(400)}`);
    expect(out.length).toBe(MAX_SCREEN_CHARS);
    expect(out.endsWith("…")).toBe(true);
    expect(screenText("a‮b\u0007c")).toBe("a b c");
  });
});

describe("the session a caller says it acts for", () => {
  it("links an https URL and labels a Zimmer-shaped one by its id", () => {
    expect(
      normalizeSession("https://zimmer.example.com/sessions/28427"),
    ).toEqual({
      label: "zimmer.example.com · session 28427",
      url: "https://zimmer.example.com/sessions/28427",
    });
  });

  it("names the host the link really goes to, and keeps no query or fragment", () => {
    expect(
      normalizeSession("https://evil.example/sessions/1234?token=abc#x"),
    ).toEqual({
      label: "evil.example · session 1234",
      url: "https://evil.example/sessions/1234",
    });
    expect(normalizeSession("https://x.test/runs/9/")).toEqual({
      label: "x.test/runs/9",
      url: "https://x.test/runs/9/",
    });
  });

  it("strips link arrows and invisible characters from a label", () => {
    expect(normalizeSession("session 99 ↗ (verified)")).toEqual({
      label: "session 99 (verified)",
    });
    expect(normalizeSession("a\u200fb\u200bc")).toEqual({ label: "a b c" });
  });

  it("never links anything but https, and never a URL carrying userinfo", () => {
    expect(normalizeSession("file:///etc/passwd")).toBeUndefined();
    expect(normalizeSession("http://x.test/sessions/1")).toBeUndefined();
    expect(normalizeSession("https://u:p@x.test/sessions/1")).toBeUndefined();
  });

  it("keeps a bare id or a title as a label with no link, and drops junk", () => {
    expect(normalizeSession("28427")).toEqual({ label: "session 28427" });
    expect(normalizeSession("nightly triage")).toEqual({
      label: "nightly triage",
    });
    expect(normalizeSession(42)).toBeUndefined();
    expect(normalizeSession("   ")).toBeUndefined();
    expect(normalizeSession("x".repeat(201))).toBeUndefined();
  });
});

describe("a grant's calls, for the banner", () => {
  it("shows a call while it runs and moves it to recent, newest first, capped", () => {
    const clock = { t: 1000 };
    let changes = 0;
    const store = new GrantStore({
      idleMs: 600_000,
      now: () => clock.t,
      onChange: () => (changes += 1),
    });
    const g = store.create({
      capability: "shell",
      server: "s",
      purpose: "p",
      ttlMs: 600_000,
    });
    const done = store.begin(g.id, "run_command", "run_command: sleep 5");
    expect(store.active()[0].inFlight).toEqual([
      { tool: "run_command", summary: "run_command: sleep 5", startedAt: 1000 },
    ]);
    clock.t = 6000;
    done(true);
    done(true); // a second finish is ignored
    const view = store.active()[0];
    expect(view.inFlight).toEqual([]);
    expect(view.recent).toEqual([
      {
        tool: "run_command",
        summary: "run_command: sleep 5",
        startedAt: 1000,
        endedAt: 6000,
        ok: true,
      },
    ]);
    for (let i = 0; i < RECENT_CALLS + 3; i++)
      store.begin(g.id, "t", `call ${i}`)(i % 2 === 0);
    const recent = store.active()[0].recent;
    expect(recent).toHaveLength(RECENT_CALLS);
    expect(recent[0].summary).toBe(`call ${RECENT_CALLS + 2}`);
    // create, begin, finish, and two per later call: the banner hears each.
    expect(changes).toBe(3 + 2 * (RECENT_CALLS + 3));
  });

  it("forgets a call whose grant has ended, and a begin on no grant is a no-op", () => {
    const store = new GrantStore({ idleMs: 600_000 });
    const g = store.create({
      capability: "shell",
      server: "s",
      purpose: "p",
      ttlMs: 600_000,
    });
    const done = store.begin(g.id, "t", "t");
    store.end(g.id, "killed");
    expect(() => done(false)).not.toThrow();
    expect(() => store.begin("g_missing", "t", "t")(true)).not.toThrow();
  });
});

describe("what set_state carries", () => {
  it("adds timing, the session, the calls and the left-running commands to each grant", async () => {
    const clock = { t: 5_000_000 };
    const killSwitch = new KillSwitch(tmpState());
    const gate = new ConsentGate({
      config: testConfig(),
      prompter: new ScriptedPrompter("allowed"),
      killSwitch,
      audit: new AuditLog(),
      now: () => clock.t,
    });
    const d = await gate.request({
      capability: "shell",
      server: "shell-test-mbp",
      purpose: "Run the test suite and report failures.",
      minutes: 10,
      session: "https://zimmer.example.com/sessions/7",
    });
    if (!d.ok) throw new Error(d.reason);
    const presence = new Presence({
      helper: {} as HelperClient,
      gate,
      killSwitch,
      running: () => [
        "npm test",
        "curl -H 'Authorization: Bearer abcdefgh123' x",
      ],
    });
    gate.grants.begin(d.grant.id, "run_command", "run_command: npm test");
    clock.t += 3000;

    expect(presence.state()).toEqual({
      disabled: false,
      grants: [
        {
          id: d.grant.id,
          server: "shell-test-mbp",
          purpose: "Run the test suite and report failures.",
          foreground: false,
          started_at: 5_000_000,
          expires_at: 5_000_000 + 10 * 60_000,
          calls: 0,
          session: "zimmer.example.com · session 7",
          session_url: "https://zimmer.example.com/sessions/7",
          in_flight_count: 1,
          in_flight: [
            {
              tool: "run_command",
              summary: "run_command: npm test",
              started_at: 5_000_000,
            },
          ],
          // `npm test` is the call above; the other outlived its call, scrubbed.
          background_count: 1,
          background: [
            "run_command: curl -H 'Authorization: Bearer [redacted]' x",
          ],
          recent: [],
        },
      ],
    });
  });

  it("leaves session fields off a grant that claimed none", async () => {
    const killSwitch = new KillSwitch(tmpState());
    const gate = new ConsentGate({
      config: testConfig(),
      prompter: new ScriptedPrompter("allowed"),
      killSwitch,
      audit: new AuditLog(),
    });
    await gate.request({
      capability: "shell",
      server: "s",
      purpose: "Look at the logs for errors.",
    });
    const [g] = new Presence({
      helper: {} as HelperClient,
      gate,
      killSwitch,
    }).state().grants;
    expect(g).not.toHaveProperty("session");
    expect(g).not.toHaveProperty("session_url");
    expect(g.background).toEqual([]);
  });
});

describe("the caps on what a grant shows", () => {
  it("sends the oldest three calls and commands, with the real totals", async () => {
    const killSwitch = new KillSwitch(tmpState());
    const gate = new ConsentGate({
      config: testConfig(),
      prompter: new ScriptedPrompter("allowed"),
      killSwitch,
      audit: new AuditLog(),
    });
    const d = await gate.request({
      capability: "shell",
      server: "s",
      purpose: "Run several long jobs at once.",
    });
    if (!d.ok) throw new Error(d.reason);
    for (let i = 0; i < 5; i++)
      gate.grants.begin(d.grant.id, "run_command", `run_command: job ${i}`);
    const [g] = new Presence({
      helper: {} as HelperClient,
      gate,
      killSwitch,
      // Two identical commands: one is a call's, the other outlived its call.
      running: () => [
        "job 0",
        "job 0",
        "a",
        "b",
        "c",
        "d",
        "job 1",
        "job 2",
        "job 3",
        "job 4",
      ],
    }).state().grants;
    expect(g.in_flight_count).toBe(5);
    expect(g.in_flight.map((c) => c.summary)).toEqual([
      "run_command: job 0",
      "run_command: job 1",
      "run_command: job 2",
    ]);
    expect(g.background_count).toBe(5);
    expect(g.background).toEqual([
      "run_command: job 0",
      "run_command: a",
      "run_command: b",
    ]);
  });
});

describe("through the daemon: request_control(session) → a call in flight → recent", () => {
  let daemon: RunningDaemon;
  beforeAll(async () => {
    daemon = await startDaemon(testConfig(), {
      stateDir: tmpState(),
      prompter: new ScriptedPrompter("allowed"),
      ephemeralPorts: true,
    });
  });
  afterAll(() => daemon.stop());

  it("shows the running command, scrubbed, while it runs and after", async () => {
    const client = await connect(daemon.mcpPort, "/shell/mcp", SHELL_KEY);
    const { grant_id } = resultJson<{ grant_id: string }>(
      await client.callTool({
        name: "request_control",
        arguments: {
          purpose: "Check the banner's in-flight line.",
          session: "https://zimmer.example.com/sessions/99",
        },
      }),
    );
    const command = "sleep 1; echo token=supersecretvalue";
    const call = client.callTool({
      name: "run_command",
      arguments: { grant_id, command, wait_seconds: 10 },
    });

    let during;
    for (let i = 0; i < 50; i++) {
      during = daemon.core.presence
        .state()
        .grants.find((g) => g.id === grant_id);
      if (during?.in_flight.length) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(during).toMatchObject({
      session: "zimmer.example.com · session 99",
      session_url: "https://zimmer.example.com/sessions/99",
      in_flight: [
        {
          tool: "run_command",
          summary: "run_command: sleep 1; echo token=[redacted]",
        },
      ],
      background: [],
    });

    await call;
    const after = daemon.core.presence
      .state()
      .grants.find((g) => g.id === grant_id);
    expect(after?.in_flight).toEqual([]);
    expect(after?.recent).toEqual([
      expect.objectContaining({
        tool: "run_command",
        summary: "run_command: sleep 1; echo token=[redacted]",
        ok: true,
      }),
    ]);
    expect(after?.calls).toBe(1);
    // The audit log records the claimed session with the grant.
    expect(
      daemon.core.deps.audit
        .tail(50)
        .some(
          (e) =>
            e.kind === "granted" &&
            e.detail.includes("(for https://zimmer.example.com/sessions/99)"),
        ),
    ).toBe(true);
    await client.close();
  });

  it("puts a call that fails into recent with ok: false", async () => {
    const client = await connect(daemon.mcpPort, "/shell/mcp", SHELL_KEY);
    const { grant_id } = resultJson<{ grant_id: string }>(
      await client.callTool({
        name: "request_control",
        arguments: { purpose: "Check the banner's failed-call line." },
      }),
    );
    const r = await client.callTool({
      name: "get_command",
      arguments: { grant_id, command_id: "c_missing" },
    });
    expect(r.isError).toBe(true);
    const g = daemon.core.presence
      .state()
      .grants.find((x) => x.id === grant_id);
    expect(g).not.toHaveProperty("session");
    expect(g?.recent[0]).toMatchObject({ tool: "get_command", ok: false });
    await client.close();
  });
});
