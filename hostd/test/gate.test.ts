import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { AuditLog } from "../src/audit.js";
import { ConsentGate } from "../src/consent/gate.js";
import { KillSwitch } from "../src/killswitch.js";
import { ScriptedPrompter, testConfig, tmpState } from "./helpers.js";

const PURPOSE = "Look for the tax PDFs in ~/Documents.";

function gateWith(
  prompter: ScriptedPrompter,
  over: Record<string, unknown> = {},
  clock = { t: 1_000_000 },
) {
  const killSwitch = new KillSwitch(tmpState());
  const audit = new AuditLog();
  const gate = new ConsentGate({
    config: testConfig(over),
    prompter,
    killSwitch,
    audit,
    now: () => clock.t,
  });
  return { gate, killSwitch, audit, clock };
}

const ask = (gate: ConsentGate, purpose: unknown = PURPOSE) =>
  gate.request({ capability: "shell", server: "shell-test-mbp", purpose });

describe("the consent gate", () => {
  it("grants when the person allows, and shows them the server and the purpose", async () => {
    const prompter = new ScriptedPrompter("allowed");
    const { gate } = gateWith(prompter);
    const d = await ask(gate);
    expect(d.ok && d.how).toBe("allowed");
    expect(prompter.seen).toEqual([
      expect.objectContaining({
        server: "shell-test-mbp",
        purpose: PURPOSE,
        seconds: 10,
        onTimeout: "deny",
      }),
    ]);
  });

  it("FAILS CLOSED on an unanswered dialog by default", async () => {
    const { gate } = gateWith(new ScriptedPrompter("timeout"));
    const d = await ask(gate);
    expect(d).toMatchObject({ ok: false, code: "timeout" });
    expect(gate.grants.active()).toEqual([]);
  });

  it("treats an unanswered dialog as a veto window only when the owner configured that", async () => {
    const { gate } = gateWith(new ScriptedPrompter("timeout"), {
      consent: { onTimeout: "allow" },
    });
    const d = await ask(gate);
    expect(d.ok && d.how).toBe("timeout-allow");
  });

  it("denies when no dialog could be shown, even with onTimeout allow", async () => {
    const { gate } = gateWith(new ScriptedPrompter("unavailable"), {
      consent: { onTimeout: "allow" },
    });
    expect(await ask(gate)).toMatchObject({ ok: false, code: "no_display" });
  });

  it("starts NO cooldown on a plain Reject: the next request gets a fresh dialog", async () => {
    const prompter = new ScriptedPrompter("rejected");
    const { gate } = gateWith(prompter);
    expect(await ask(gate)).toMatchObject({ ok: false, code: "rejected" });
    prompter.answer = "allowed";
    expect((await ask(gate)).ok).toBe(true);
    expect(prompter.seen).toHaveLength(2);
  });

  it("starts no cooldown on an unanswered dialog either", async () => {
    const prompter = new ScriptedPrompter("timeout");
    const { gate } = gateWith(prompter);
    expect(await ask(gate)).toMatchObject({ ok: false, code: "timeout" });
    prompter.answer = "allowed";
    expect((await ask(gate)).ok).toBe(true);
    expect(prompter.seen).toHaveLength(2);
  });

  it("goes quiet after 'Disallow and cool down', without showing another dialog", async () => {
    const prompter = new ScriptedPrompter("rejected_cooldown");
    const { gate, clock, audit } = gateWith(prompter);
    expect(await ask(gate)).toMatchObject({ ok: false, code: "rejected" });
    prompter.answer = "allowed";
    expect(await ask(gate)).toMatchObject({ ok: false, code: "cooldown" });
    expect(prompter.seen).toHaveLength(1);
    // Per capability: another server still asks.
    expect(
      (
        await gate.request({
          capability: "browser",
          server: "browser-use-test-mbp-headless",
          purpose: PURPOSE,
        })
      ).ok,
    ).toBe(true);
    clock.t += 61_000;
    expect((await ask(gate)).ok).toBe(true);
    expect(
      audit
        .tail()
        .filter((e) => e.kind === "denied")
        .map((e) => e.detail),
    ).toEqual([
      expect.stringMatching(/^cooldown: /),
      expect.stringMatching(/^rejected: .*asked for no more/),
    ]);
  });

  it("a kill-all cools down every server that held a grant", async () => {
    const { gate } = gateWith(new ScriptedPrompter("allowed"));
    const browser = () =>
      gate.request({
        capability: "browser",
        server: "browser-use-test-mbp-headless",
        purpose: PURPOSE,
      });
    expect((await ask(gate)).ok).toBe(true);
    expect((await browser()).ok).toBe(true);
    expect(gate.grants.endAll("killed")).toBe(2);
    expect(await ask(gate)).toMatchObject({ code: "cooldown" });
    expect(await browser()).toMatchObject({ code: "cooldown" });
  });

  it("goes quiet after the owner KILLS a grant, and not after any other ending", async () => {
    const prompter = new ScriptedPrompter("allowed");
    const { gate, clock } = gateWith(prompter);
    for (const reason of [
      "ended",
      "expired",
      "idle",
      "owner_input",
      "disabled",
    ] as const) {
      const d = await ask(gate);
      if (!d.ok) throw new Error(d.reason);
      gate.grants.end(d.grant.id, reason);
      expect((await ask(gate)).ok, reason).toBe(true);
      gate.grants.endAll("ended");
    }
    const d = await ask(gate);
    if (!d.ok) throw new Error(d.reason);
    const shown = prompter.seen.length;
    gate.grants.end(d.grant.id, "killed");
    expect(await ask(gate)).toMatchObject({ ok: false, code: "cooldown" });
    expect(prompter.seen).toHaveLength(shown);
    clock.t += 61_000;
    expect((await ask(gate)).ok).toBe(true);
  });

  it("refuses a bad purpose before anyone is shown anything", async () => {
    const prompter = new ScriptedPrompter("allowed");
    const { gate } = gateWith(prompter);
    expect(await ask(gate, null)).toMatchObject({
      ok: false,
      code: "bad_purpose",
    });
    expect(await ask(gate, "One. Two. Three. Four.")).toMatchObject({
      ok: false,
      code: "bad_purpose",
    });
    expect(prompter.seen).toHaveLength(0);
  });

  it("shows no dialog and grants nothing while the kill switch is on", async () => {
    const prompter = new ScriptedPrompter("allowed");
    const { gate, killSwitch } = gateWith(prompter);
    killSwitch.disable();
    expect(await ask(gate)).toMatchObject({ ok: false, code: "disabled" });
    expect(prompter.seen).toHaveLength(0);
  });

  it("denies when the switch is thrown WHILE the dialog is up, even if Allow was clicked", async () => {
    const prompter = new ScriptedPrompter("allowed");
    const made = gateWith(prompter);
    prompter.answer = async () => {
      made.killSwitch.disable();
      return "allowed";
    };
    expect(await ask(made.gate)).toMatchObject({ ok: false, code: "disabled" });
  });

  it("disableAll ends every grant and aborts its signal", async () => {
    const { gate } = gateWith(new ScriptedPrompter("allowed"));
    const d = await ask(gate);
    if (!d.ok) throw new Error("expected a grant");
    expect(gate.disableAll()).toBe(1);
    expect(d.grant.signal.aborted).toBe(true);
    expect(gate.grants.use(d.grant.id, "shell", "run_command").ok).toBe(false);
  });

  it("caps a grant at the owner's maximum, and expires and idles it", async () => {
    const { gate, clock } = gateWith(new ScriptedPrompter("allowed"));
    const d = await gate.request({
      capability: "shell",
      server: "s",
      purpose: PURPOSE,
      minutes: 100_000,
    });
    if (!d.ok) throw new Error("expected a grant");
    expect(d.grant.expiresAt - d.grant.createdAt).toBe(120 * 60_000);

    clock.t += 9 * 60_000;
    expect(gate.grants.use(d.grant.id, "shell", "run_command").ok).toBe(true);
    clock.t += 11 * 60_000;
    expect(gate.grants.use(d.grant.id, "shell", "run_command").ok).toBe(false);
    expect(d.grant.signal.aborted).toBe(true);
  });

  it("does not honour a grant on a different capability's server", async () => {
    const { gate } = gateWith(new ScriptedPrompter("allowed"));
    const d = await ask(gate);
    if (!d.ok) throw new Error("expected a grant");
    expect(gate.grants.use(d.grant.id, "browser", "list_tabs").ok).toBe(false);
  });

  it("limits how many grants can be live at once", async () => {
    const { gate } = gateWith(new ScriptedPrompter("allowed"), {
      consent: { maxActiveGrants: 2 },
    });
    expect((await ask(gate)).ok).toBe(true);
    expect((await ask(gate)).ok).toBe(true);
    expect(await ask(gate)).toMatchObject({
      ok: false,
      code: "too_many_grants",
    });
  });

  it("shows ONE dialog at a time, so concurrent requests cannot get around the cooldown", async () => {
    // The cooldown is written only when the answer comes back. Without the
    // one-dialog rule, twenty requests fired together put several dialogs up
    // before the first "no" landed.
    const prompter = new ScriptedPrompter(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return "rejected_cooldown";
    });
    const { gate } = gateWith(prompter);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => ask(gate)),
    );
    expect(prompter.seen).toHaveLength(1);
    const codes = results.map((r) => (r.ok ? "granted" : r.code));
    expect(codes.filter((c) => c === "rejected")).toHaveLength(1);
    expect(codes.filter((c) => c === "dialog_busy")).toHaveLength(19);
    // And the one "cool down" holds off whoever asks next.
    expect(await ask(gate)).toMatchObject({ ok: false, code: "cooldown" });
    expect(prompter.seen).toHaveLength(1);
  });

  it("ends live grants when the switch FILE appears by any means — a bare `touch` calls nothing", async () => {
    const { gate, killSwitch } = gateWith(new ScriptedPrompter("allowed"));
    const d = await ask(gate);
    if (!d.ok) throw new Error("expected a grant");
    expect(gate.enforce()).toBe(0);
    expect(d.grant.signal.aborted).toBe(false);

    writeFileSync(killSwitch.path, "touched by hand\n");
    expect(gate.enforce()).toBe(1);
    expect(d.grant.signal.aborted).toBe(true);
    expect(gate.grants.active()).toEqual([]);
  });

  it("writes the request, the decision and the end to the audit log", async () => {
    const { gate, audit } = gateWith(new ScriptedPrompter("allowed"));
    const d = await ask(gate);
    if (!d.ok) throw new Error("expected a grant");
    gate.grants.end(d.grant.id, "killed");
    expect(audit.tail().map((e) => e.kind)).toEqual([
      "killed",
      "granted",
      "request",
    ]);
  });
});
