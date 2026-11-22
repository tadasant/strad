import { spawn } from "node:child_process";

/**
 * What the person at the machine said.
 *
 * `unavailable` is its own answer, not a flavour of `timeout`: a dialog that was
 * shown and ignored is a decision the owner's config may interpret, and a dialog
 * that could not be shown at all is a request nobody had the chance to refuse.
 * The second is always a denial.
 *
 * `rejected_cooldown` is a Reject that also asks for quiet: the owner chose
 * "Disallow and cool down", so the server's next requests are refused without a
 * dialog for the cooldown. A plain Reject asks for nothing more than this once.
 */
export type PromptAnswer =
  "allowed" | "rejected" | "rejected_cooldown" | "timeout" | "unavailable";

/**
 * The third button's label. The dialog script spells it out rather than
 * interpolate it, so its source carries no `${`; the prompter tests hold it to
 * this constant.
 */
export const COOLDOWN_LABEL = "Disallow and cool down";

export interface PromptRequest {
  /** The requesting server's display name, e.g. `shell-tadas-mbp`. */
  server: string;
  purpose: string;
  seconds: number;
  /** What an unanswered dialog will mean, so the dialog can say so. */
  onTimeout: "deny" | "allow";
  /** One more line for a server whose cost is not obvious from its name. */
  note?: string;
  signal?: AbortSignal;
}

export interface Prompter {
  prompt(req: PromptRequest): Promise<PromptAnswer>;
}

export function dialogText(req: PromptRequest): string {
  const tail =
    req.onTimeout === "allow"
      ? `Allowed automatically in ${req.seconds} seconds unless you reject it.`
      : `Denied automatically in ${req.seconds} seconds unless you allow it.`;
  const note = req.note ? `${req.note}\n\n` : "";
  return `Remote control requested by ${req.server} MCP server for purpose: ${req.purpose}\n\n${note}${tail}`;
}

/** Run a dialog helper to completion. Text travels as ARGV, never as source. */
function run(
  cmd: string,
  args: string[],
  req: PromptRequest,
): Promise<{
  code: number | null;
  stdout: string;
  stderr?: string;
  spawnFailed: boolean;
}> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (code: number | null, spawnFailed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(backstop);
      resolve({ code, stdout, stderr, spawnFailed });
    };
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 2000) stderr += d.toString("utf8");
    });
    child.on("error", () => done(null, true));
    child.on("close", (code) => done(code, false));
    // The helper owns the countdown; this only covers one that hangs.
    const backstop = setTimeout(
      () => child.kill("SIGKILL"),
      (req.seconds + 5) * 1000,
    );
    req.signal?.addEventListener("abort", () => child.kill("SIGKILL"), {
      once: true,
    });
  });
}

/**
 * The macOS dialog, as JavaScript for Automation over the Cocoa bridge: an
 * `NSAlert` whose buttons answer the MOUSE and nothing else.
 *
 * `display dialog` cannot be made to do that. Its default button answers
 * Return, a button named Cancel answers Escape, and with Full Keyboard Access on
 * the focused button answers Space — so a dialog that takes focus while the
 * owner is typing in another app gets decided by the next keystroke. Here every
 * button has its key equivalent cleared and refuses first responder, so Return,
 * Escape, Space and Tab do nothing. Clearing Allow's key equivalent is also what
 * empties the window's default button cell: `layout` only makes a button the
 * default if its key is Return. Typing into it is swallowed, not answered.
 *
 * No line here assigns JavaScript `null` to an Objective-C property. The bridge
 * passes `NSNull`, not `nil`, and AppKit throws on it: an
 * `alert.window.defaultButtonCell = null` made every one of these dialogs fail
 * on macOS, which is how the keyboard-answerable fallback became the dialog
 * that was actually shown.
 *
 * Before `runModal`, the script checks what it relies on — no key on any
 * button, none able to take focus, no default button cell — and throws rather
 * than show a dialog a key could answer. A throw is a dialog that was not
 * shown, so the request is `unavailable`, which is a denial.
 *
 * The countdown is `abortModal` scheduled on the run loop, the stock NSAlert
 * timeout: `runModal` then returns an abort code and the script prints
 * `timeout`, so an unanswered dialog reaches `onTimeout` like any other.
 * Text arrives as `argv`, never as source.
 */
export const JXA_DIALOG = `ObjC.import("Cocoa");
function run(argv) {
  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy(1); // NSApplicationActivationPolicyAccessory
  var alert = $.NSAlert.alloc.init;
  alert.messageText = argv[1];
  alert.informativeText = argv[0];
  var buttons = [
    alert.addButtonWithTitle("Allow"),
    alert.addButtonWithTitle("Reject"),
    alert.addButtonWithTitle("Disallow and cool down")
  ];
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].keyEquivalent = "";
    buttons[i].refusesFirstResponder = true;
  }
  alert.layout;
  // Allow is the first button, the one AppKit gives Return. If clearing that
  // did not take, Return would ALLOW: refuse to show this dialog at all.
  for (var j = 0; j < buttons.length; j++) {
    if (buttons[j].keyEquivalent.js !== "") throw new Error("a button kept a key");
    if (buttons[j].refusesFirstResponder !== true) throw new Error("a button can take focus");
    if (buttons[j].canBecomeKeyView !== false) throw new Error("a button is a key view");
  }
  var cell = alert.window.defaultButtonCell;
  if (typeof cell.isNil !== "function" || !cell.isNil()) throw new Error("a default button remains");
  alert.window.level = 3; // NSFloatingWindowLevel
  app.activateIgnoringOtherApps(true);
  app.performSelectorWithObjectAfterDelayInModes("abortModal", null, parseInt(argv[2], 10), $(["kCFRunLoopCommonModes"]));
  var r = alert.runModal;
  if (r === 1000) return "Allow"; // NSAlertFirstButtonReturn
  if (r === 1001) return "Reject"; // NSAlertSecondButtonReturn
  if (r === 1002) return "Cooldown"; // NSAlertThirdButtonReturn
  return "timeout";
}`;

/** Said under the request in the dialog, which no key answers. */
export const MOUSE_ONLY_NOTE =
  "Click a button. The keyboard cannot answer this dialog.";

export type DialogRunner = typeof run;

function parseMac(stdout: string): PromptAnswer | undefined {
  const answer = stdout.trim();
  if (answer === "Allow") return "allowed";
  if (answer === "Reject") return "rejected";
  if (answer === "Cooldown") return "rejected_cooldown";
  if (answer === "timeout") return "timeout";
  return undefined;
}

/**
 * macOS: `osascript`, which needs no TCC grant and no helper app, running the
 * JXA dialog and nothing else. There is no fallback: every other dialog
 * `osascript` can show answers a key, so a JXA run that fails is a dialog that
 * could not be shown, and the request is `unavailable`. The purpose is an
 * ARGUMENT to a constant script — it is never interpolated into source, so a
 * purpose cannot close a string and start a `do shell script`.
 */
export class MacDialogPrompter implements Prompter {
  constructor(
    private readonly runner: DialogRunner = run,
    private readonly log: (line: string) => void = (line) =>
      console.error(line),
  ) {}

  async prompt(req: PromptRequest): Promise<PromptAnswer> {
    const r = await this.runner(
      "/usr/bin/osascript",
      [
        "-l",
        "JavaScript",
        "-e",
        JXA_DIALOG,
        `${dialogText(req)}\n\n${MOUSE_ONLY_NOTE}`,
        "strad-hostd",
        String(req.seconds),
      ],
      req,
    );
    if (r.spawnFailed) {
      this.log("[consent] the dialog could not start: osascript did not run");
      return "unavailable";
    }
    const answer = parseMac(r.stdout);
    if (answer) return answer;
    if (req.signal?.aborted) return "unavailable";
    // Exited 0 having printed nothing: a dialog nobody answered. Killed by the
    // backstop (`code: null`): it hung with a dialog up.
    if (r.code === 0 || r.code === null) return "timeout";
    // Failed: no window server (an ssh session, a logged-out Mac), or the
    // script refused to show a dialog a key could answer. Its stderr is
    // osascript's error and the script's own `throw`, never the purpose.
    const why = (r.stderr ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    this.log(
      `[consent] the dialog was not shown (osascript exit ${r.code}): ${why || "no error text"}`,
    );
    return "unavailable";
  }
}

/** Nothing can show a dialog here, so nothing is ever agreed to. */
export class UnavailablePrompter implements Prompter {
  async prompt(): Promise<PromptAnswer> {
    return "unavailable";
  }
}

/**
 * Only macOS has a dialog the keyboard cannot answer. `zenity`, the Linux one,
 * keeps its keys — Tab reaches Allow and Space presses it — so Linux shows no
 * dialog and every request there is `unavailable`. Run it with `--no-consent`
 * over stdio, where the MCP client is the one asking.
 */
export function platformPrompter(platform = process.platform): Prompter {
  if (platform === "darwin") return new MacDialogPrompter();
  return new UnavailablePrompter();
}
