import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { AuditLog } from "../src/audit.js";
import { ConsentGate } from "../src/consent/gate.js";
import type { Notifier } from "../src/consent/notifier.js";
import { KillSwitch } from "../src/killswitch.js";
import { ScriptedPrompter, testConfig, tmpState } from "./helpers.js";

class Recorder implements Notifier {
  readonly sent: [string, string][] = [];
  notify(title: string, body: string): void {
    this.sent.push([title, body]);
  }
}

function gate(
  answer: "allowed" | "timeout" | "rejected",
  over: Record<string, unknown> = {},
) {
  const notifier = new Recorder();
  const g = new ConsentGate({
    config: testConfig(over),
    prompter: new ScriptedPrompter(answer),
    killSwitch: new KillSwitch(tmpState()),
    audit: new AuditLog(),
    notifier,
    controlUrl: "http://127.0.0.1:7312",
  });
  return { g, notifier };
}

const ask = (g: ConsentGate) =>
  g.request({
    capability: "shell",
    server: "shell-test-mbp",
    purpose: "Tidy the downloads folder.",
  });

describe("what the machine is told", () => {
  it("notifies when a grant starts, with the purpose and where to kill it, and again when it ends", async () => {
    const { g, notifier } = gate("allowed");
    const d = await ask(g);
    if (!d.ok) throw new Error("expected a grant");
    expect(notifier.sent).toEqual([
      [
        "shell-test-mbp has control of Test Mac",
        "Tidy the downloads folder. — see or kill it at http://127.0.0.1:7312",
      ],
    ]);
    g.grants.end(d.grant.id, "killed");
    expect(notifier.sent[1]).toEqual([
      "shell-test-mbp no longer has control",
      "Grant killed after 0 calls. shell-test-mbp is refused for 60s.",
    ]);
  });

  it("says so when NOBODY answered — the case where the dialog was never seen", async () => {
    const { g, notifier } = gate("timeout", {
      consent: { onTimeout: "allow" },
    });
    await ask(g);
    expect(notifier.sent[0]![1]).toMatch(
      /^Nobody answered the dialog, so it was allowed\. /,
    );
  });

  it("notifies nothing for a request that was refused", async () => {
    const { g, notifier } = gate("rejected");
    await ask(g);
    expect(notifier.sent).toEqual([]);
  });

  it("passes caller text to osascript as ARGV, never inside the script source", () => {
    // A purpose is caller-authored. Interpolated into AppleScript it could close
    // the string and reach `do shell script`; as argv it is only ever data.
    const scripts: [string, string, string][] = [
      ["src/consent/notifier.ts", "APPLESCRIPT", "item 1 of argv"],
      ["src/consent/prompter.ts", "APPLESCRIPT_DIALOG", "item 1 of argv"],
      ["src/consent/prompter.ts", "JXA_DIALOG", "argv[0]"],
    ];
    for (const [file, name, reads] of scripts) {
      const src = readFileSync(file, "utf8");
      const script = new RegExp(`const ${name} = \`([^\`]*)\``).exec(src)?.[1];
      expect(script, name).toBeDefined();
      expect(script, name).not.toContain("${");
      expect(script, name).toContain(reads);
    }
  });
});
