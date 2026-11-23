import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  COOLDOWN_LABEL,
  JXA_DIALOG,
  MOUSE_ONLY_NOTE,
  MacDialogPrompter,
  UnavailablePrompter,
  platformPrompter,
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
const out = (
  stdout: string,
  code: number | null = 0,
  stderr = "",
): Outcome => ({
  stdout,
  stderr,
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

const quiet = () => {};

/**
 * A stand-in for the JXA Cocoa bridge, faithful in the two ways that matter
 * here. A property assigned JavaScript `null` arrives as NSNull, not nil, and
 * AppKit throws on it (observed on macOS 27.2.1:
 * `-[NSNull setKeyEquivalent:]: unrecognized selector`). And `layout` makes a
 * button the window's default button cell only if its key is still Return.
 */
function bridge(
  opts: {
    keySticks?: boolean;
    focusSticks?: boolean;
    keyViewSticks?: boolean;
    defaultSticks?: boolean;
    modal?: unknown;
  } = {},
) {
  const events: string[] = [];
  const NIL = { isNil: () => true };
  const nsnullThrows = (prop: string) => (v: unknown) => {
    if (v === null)
      throw new Error(
        `-[NSNull ${prop}]: unrecognized selector sent to instance`,
      );
  };
  const buttons: { title: string; key: string; refuses: boolean }[] = [];
  let defaultCell: unknown = NIL;
  const button = (title: string) => {
    const b = { title, key: buttons.length === 0 ? "\r" : "", refuses: false };
    buttons.push(b);
    return {
      get keyEquivalent() {
        return { js: b.key };
      },
      set keyEquivalent(v: string) {
        if (!opts.keySticks) b.key = v;
      },
      get refusesFirstResponder() {
        return b.refuses;
      },
      set refusesFirstResponder(v: boolean) {
        if (!opts.focusSticks) b.refuses = v;
      },
      get canBecomeKeyView() {
        return opts.keyViewSticks ? true : !b.refuses;
      },
    };
  };
  const window = {
    get defaultButtonCell() {
      return defaultCell;
    },
    set defaultButtonCell(v: unknown) {
      nsnullThrows("setKeyEquivalent:")(v);
      defaultCell = v;
    },
    get initialFirstResponder() {
      return NIL;
    },
    set initialFirstResponder(v: unknown) {
      nsnullThrows("acceptsFirstResponder")(v);
    },
    level: 0,
  };
  const alert = {
    messageText: "",
    informativeText: "",
    addButtonWithTitle: button,
    get layout() {
      defaultCell =
        opts.defaultSticks || buttons.some((b) => b.key === "\r")
          ? { isNil: () => false }
          : NIL;
      return undefined;
    },
    window,
    get runModal() {
      events.push("runModal");
      return opts.modal ?? -1001;
    },
  };
  const app = {
    setActivationPolicy: () => {},
    activateIgnoringOtherApps: () => events.push("activate"),
    performSelectorWithObjectAfterDelayInModes: () => {},
  };
  const $ = Object.assign((v: unknown) => v, {
    NSApplication: { sharedApplication: app },
    NSAlert: { alloc: { init: alert } },
  });
  const ObjC = { import: () => {} };
  const run = new Function("ObjC", "$", `${JXA_DIALOG}\nreturn run;`)(
    ObjC,
    $,
  ) as (argv: string[]) => string;
  return { run: () => run(["text", "strad-hostd", "10"]), events, alert };
}

describe("the macOS consent dialog", () => {
  it("is the JXA dialog, with the text, title and window as arguments", async () => {
    const { runner, calls } = scripted(out("Allow\n"));
    expect(await new MacDialogPrompter(runner, quiet).prompt(REQ)).toBe(
      "allowed",
    );
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

  it("puts Allow in the primary place and 'Disallow and cool down' last", () => {
    const order = ["Allow", "Reject", COOLDOWN_LABEL].map((label) =>
      JXA_DIALOG.indexOf(`addButtonWithTitle("${label}")`),
    );
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(JXA_DIALOG).toContain('if (r === 1000) return "Allow"');
    expect(JXA_DIALOG).toContain('if (r === 1001) return "Reject"');
    expect(JXA_DIALOG).toContain('if (r === 1002) return "Cooldown"');
  });

  it("maps each button and the countdown", async () => {
    const p = (o: Outcome) =>
      new MacDialogPrompter(scripted(o).runner, quiet).prompt(REQ);
    expect(await p(out("Reject"))).toBe("rejected");
    expect(await p(out("Cooldown\n"))).toBe("rejected_cooldown");
    expect(await p(out("timeout"))).toBe("timeout");
  });

  it("runs on a bridge that turns null into NSNull, and reaches runModal with no key and no focus on any button", () => {
    // The regression: `defaultButtonCell = null` threw on every Mac, so the
    // keyboard-answerable fallback was the dialog that was really shown.
    const b = bridge({ modal: 1001 });
    expect(b.run()).toBe("Reject");
    expect(b.events).toEqual(["activate", "runModal"]);
    expect(JXA_DIALOG).not.toMatch(/=\s*null\b/);
  });

  it("reads each modal code the way the prompter does", () => {
    expect(bridge({ modal: 1000 }).run()).toBe("Allow");
    expect(bridge({ modal: 1002 }).run()).toBe("Cooldown");
    expect(bridge({ modal: -1001 }).run()).toBe("timeout"); // abortModal
  });

  it("reads each modal code when the bridge hands it back wrapped, as osascript does", () => {
    // On a real Mac runModal's NSInteger arrives as an object that prints as
    // "1000" and is not === 1000; compared raw, every click and every
    // countdown was "unexpected modal response" and the request no_display.
    const wrap = (n: number) => ({
      toString: () => String(n),
      valueOf: () => ({}),
    });
    expect(bridge({ modal: wrap(1000) }).run()).toBe("Allow");
    expect(bridge({ modal: wrap(1001) }).run()).toBe("Reject");
    expect(bridge({ modal: wrap(1002) }).run()).toBe("Cooldown");
    expect(bridge({ modal: wrap(-1001) }).run()).toBe("timeout");
    expect(() => bridge({ modal: wrap(-1000) }).run()).toThrow(
      /unexpected modal/,
    );
  });

  it("does not read any other end of the modal as the countdown, which onTimeout: allow would grant", () => {
    expect(() => bridge({ modal: -1000 }).run()).toThrow(/unexpected modal/); // stopModal
    expect(() => bridge({ modal: 0 }).run()).toThrow(/unexpected modal/);
  });

  it("refuses to show the dialog if a default button survives, or a button is still a key view", () => {
    const d = bridge({ defaultSticks: true });
    expect(() => d.run()).toThrow(/default button remains/);
    expect(d.events).not.toContain("runModal");
    const k = bridge({ keyViewSticks: true });
    expect(() => k.run()).toThrow(/is a key view/);
    expect(k.events).not.toContain("runModal");
  });

  it("refuses to show the dialog if Return would still answer it", () => {
    const b = bridge({ keySticks: true });
    expect(() => b.run()).toThrow(/kept a key/);
    expect(b.events).not.toContain("runModal");
  });

  it("refuses to show the dialog if a button could still take focus (Space under Full Keyboard Access)", () => {
    const b = bridge({ focusSticks: true });
    expect(() => b.run()).toThrow(/can take focus/);
    expect(b.events).not.toContain("runModal");
  });

  it("has no fallback: a failed dialog is unavailable, logged, and never a second dialog", async () => {
    const lines: string[] = [];
    const { runner, calls } = scripted(
      out("", 1, "execution error: Error: a button kept a key (-2700)\n"),
      out("Allow"),
    );
    expect(
      await new MacDialogPrompter(runner, (l) => lines.push(l)).prompt(REQ),
    ).toBe("unavailable");
    expect(calls).toHaveLength(1);
    expect(lines.join("\n")).toMatch(
      /exit 1\): execution error: Error: a button kept a key/,
    );
  });

  it("has no keyboard-answerable dialog anywhere in the module", () => {
    const src = readFileSync("src/consent/prompter.ts", "utf8");
    expect(src).not.toMatch(/display dialog\b[^`]*with title/);
    expect(src).not.toMatch(/on run argv/);
    expect(src).not.toMatch(/"zenity"/);
  });

  it("never reads an exit it does not recognise as the countdown, which onTimeout: allow would grant", async () => {
    for (const o of [out("", 0), out("garbage\n", 0), out("", null)]) {
      const r = scripted(o);
      expect(await new MacDialogPrompter(r.runner, quiet).prompt(REQ)).toBe(
        "unavailable",
      );
      expect(r.calls).toHaveLength(1);
    }
  });

  it("cuts the purpose out of a diagnostic before logging it", async () => {
    const lines: string[] = [];
    const { runner } = scripted(
      out("", 1, `error near: ${REQ.purpose} (-2700)\n`),
    );
    await new MacDialogPrompter(runner, (l) => lines.push(l)).prompt(REQ);
    expect(lines.join("\n")).not.toContain(REQ.purpose);
    expect(lines.join("\n")).toContain("error near: [purpose] (-2700)");
  });

  it("is unavailable when aborted, or when osascript will not start", async () => {
    const aborted = new AbortController();
    aborted.abort();
    expect(
      await new MacDialogPrompter(scripted(out("", null)).runner, quiet).prompt(
        { ...REQ, signal: aborted.signal },
      ),
    ).toBe("unavailable");
    const runner: DialogRunner = async () => ({
      stdout: "",
      code: null,
      stderr: "",
      spawnFailed: true,
    });
    expect(await new MacDialogPrompter(runner, quiet).prompt(REQ)).toBe(
      "unavailable",
    );
  });
});

describe("other platforms", () => {
  it("show no dialog, because none there ignores the keyboard", async () => {
    expect(platformPrompter("linux")).toBeInstanceOf(UnavailablePrompter);
    expect(platformPrompter("win32")).toBeInstanceOf(UnavailablePrompter);
    expect(platformPrompter("darwin")).toBeInstanceOf(MacDialogPrompter);
    expect(await platformPrompter("linux").prompt(REQ)).toBe("unavailable");
  });
});
