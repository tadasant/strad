import { describe, expect, it } from "vitest";

import {
  APPLESCRIPT_DIALOG,
  JXA_DIALOG,
  MOUSE_ONLY_NOTE,
  MacDialogPrompter,
  type DialogRunner,
  type PromptRequest,
} from "../src/consent/prompter.js";

const REQ: PromptRequest = {
  server: "shell-test-mbp",
  purpose: "Tidy the downloads folder.",
  seconds: 10,
  onTimeout: "deny",
};

type Outcome = Awaited<ReturnType<DialogRunner>>;
const out = (stdout: string, code: number | null = 0): Outcome => ({
  stdout,
  code,
  spawnFailed: false,
});

/** Answers each osascript run in turn, and remembers what it was asked. */
function scripted(...outcomes: Outcome[]) {
  const calls: string[][] = [];
  const runner: DialogRunner = async (_cmd, args) => {
    calls.push(args);
    return outcomes.shift() ?? out("", 1);
  };
  return { runner, calls };
}

describe("the macOS consent dialog", () => {
  it("is the JXA dialog, with the text, title and window as arguments", async () => {
    const { runner, calls } = scripted(out("Allow\n"));
    expect(await new MacDialogPrompter(runner).prompt(REQ)).toBe("allowed");
    expect(calls).toHaveLength(1);
    const [lang, js, e, script, text, title, seconds] = calls[0]!;
    expect([lang, js, e, script]).toEqual([
      "-l",
      "JavaScript",
      "-e",
      JXA_DIALOG,
    ]);
    expect(text).toContain("purpose: Tidy the downloads folder.");
    expect(text).toContain(MOUSE_ONLY_NOTE);
    expect(title).toBe("strad-hostd");
    expect(seconds).toBe("10");
  });

  it("maps Reject and the countdown the way it always has", async () => {
    expect(
      await new MacDialogPrompter(scripted(out("Reject")).runner).prompt(REQ),
    ).toBe("rejected");
    expect(
      await new MacDialogPrompter(scripted(out("timeout")).runner).prompt(REQ),
    ).toBe("timeout");
  });

  it("no button answers a key: every key equivalent is cleared and none can take focus", () => {
    expect(JXA_DIALOG).toContain('keyEquivalent = ""');
    expect(JXA_DIALOG).toContain("refusesFirstResponder = true");
    expect(JXA_DIALOG).toContain("initialFirstResponder = null");
    // The countdown still ends the dialog, as an abort the script reads as timeout.
    expect(JXA_DIALOG).toContain('"abortModal"');
    // It is JavaScript osascript can parse; `$` and `ObjC` are its globals.
    expect(
      () => new Function("ObjC", "$", `${JXA_DIALOG}\nreturn run;`),
    ).not.toThrow();
  });

  it("the AppleScript fallback has no default button and no Cancel, so neither Return nor Escape answers it", () => {
    expect(APPLESCRIPT_DIALOG).not.toMatch(/default button/);
    expect(APPLESCRIPT_DIALOG).not.toMatch(/cancel button|"Cancel"/);
    expect(APPLESCRIPT_DIALOG).toContain('buttons {"Reject", "Allow"}');
  });

  it("falls back to AppleScript only when the JXA dialog failed without answering", async () => {
    const { runner, calls } = scripted(out("", 1), out("Reject"));
    expect(await new MacDialogPrompter(runner).prompt(REQ)).toBe("rejected");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.slice(0, 2)).toEqual(["-e", APPLESCRIPT_DIALOG]);
  });

  it("is unavailable when neither dialog could be shown", async () => {
    const { runner } = scripted(out("", 1), out("", 1));
    expect(await new MacDialogPrompter(runner).prompt(REQ)).toBe("unavailable");
  });

  it("does not show a second dialog after an aborted or unanswered first one", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const a = scripted(out("", null));
    expect(
      await new MacDialogPrompter(a.runner).prompt({
        ...REQ,
        signal: aborted.signal,
      }),
    ).toBe("unavailable");
    expect(a.calls).toHaveLength(1);

    const b = scripted(out("", 0));
    expect(await new MacDialogPrompter(b.runner).prompt(REQ)).toBe("timeout");
    expect(b.calls).toHaveLength(1);
  });

  it("is unavailable when osascript itself will not start", async () => {
    const runner: DialogRunner = async () => ({
      stdout: "",
      code: null,
      spawnFailed: true,
    });
    expect(await new MacDialogPrompter(runner).prompt(REQ)).toBe("unavailable");
  });
});
