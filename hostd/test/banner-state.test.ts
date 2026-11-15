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
  ])("leaves ordinary text alone: %s", (raw) => {
    expect(screenText(raw)).toBe(raw);
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
      label: "session 28427",
      url: "https://zimmer.example.com/sessions/28427",
    });
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
          session: "session 7",
          session_url: "https://zimmer.example.com/sessions/7",
          in_flight: [
            {
              tool: "run_command",
              summary: "run_command: npm test",
              started_at: 5_000_000,
            },
          ],
          // `npm test` is the call above; the other outlived its call, scrubbed.
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
      session: "session 99",
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
    await client.close();
  });
});
