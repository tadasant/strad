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
 * The third button's label, in every dialog that has one. The scripts spell it
 * out rather than interpolate it, so no script source carries a `${`; the
 * prompter tests hold them to this constant.
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
): Promise<{ code: number | null; stdout: string; spawnFailed: boolean }> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const done = (code: number | null, spawnFailed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(backstop);
      resolve({ code, stdout, spawnFailed });
    };
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
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
 * Escape, Space and Tab do nothing, the window has no default button cell for
 * Return to reach, and no initial first responder to fall back to. Typing into it is swallowed, not answered.
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
  alert.window.defaultButtonCell = null;
  alert.window.initialFirstResponder = null;
  // Allow is the first button, the one AppKit gives Return. If clearing that
  // did not take, Return would ALLOW: refuse to show this dialog, so osascript
  // fails and the keyless AppleScript one is shown instead.
  for (var j = 0; j < buttons.length; j++) {
    if (buttons[j].keyEquivalent.js !== "") throw new Error("a button kept a key");
  }
  var cell = alert.window.defaultButtonCell;
  if (cell && typeof cell.isNil === "function" && !cell.isNil()) throw new Error("a default button remains");
  alert.window.level = 3; // NSFloatingWindowLevel
  app.activateIgnoringOtherApps(true);
  app.performSelectorWithObjectAfterDelayInModes("abortModal", null, parseInt(argv[2], 10), $(["kCFRunLoopCommonModes"]));
  var r = alert.runModal;
  if (r === 1000) return "Allow"; // NSAlertFirstButtonReturn
  if (r === 1001) return "Reject"; // NSAlertSecondButtonReturn
  if (r === 1002) return "Cooldown"; // NSAlertThirdButtonReturn
  return "timeout";
}`;

/**
 * The fallback when the Cocoa bridge cannot run: `display dialog` with NO
 * default button and no button named Cancel, so neither Return nor Escape
 * answers it. Space on a focused button still does under Full Keyboard Access,
 * which is why this is the fallback and not the dialog.
 */
export const APPLESCRIPT_DIALOG = `on run argv
  set r to display dialog (item 1 of argv) with title (item 2 of argv) buttons {"Disallow and cool down", "Reject", "Allow"} giving up after ((item 3 of argv) as integer) with icon caution
  if gave up of r then return "timeout"
  if button returned of r is "Disallow and cool down" then return "Cooldown"
  return button returned of r
end run`;

/** Said under the request in the JXA dialog, the one no key answers. */
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
 * macOS: `osascript`, which needs no TCC grant and no helper app. The JXA
 * dialog first; if it exits having answered nothing (a bridge that would not
 * load), the AppleScript one. Either way the purpose is an ARGUMENT to a
 * constant script — it is never interpolated into source, so a purpose cannot
 * close a string and start a `do shell script`.
 */
export class MacDialogPrompter implements Prompter {
  constructor(private readonly runner: DialogRunner = run) {}

  async prompt(req: PromptRequest): Promise<PromptAnswer> {
    const tail = ["strad-hostd", String(req.seconds)];
    const jxa = await this.runner(
      "/usr/bin/osascript",
      [
        "-l",
        "JavaScript",
        "-e",
        JXA_DIALOG,
        `${dialogText(req)}\n\n${MOUSE_ONLY_NOTE}`,
        ...tail,
      ],
      req,
    );
    if (jxa.spawnFailed) return "unavailable";
    const first = parseMac(jxa.stdout);
    if (first) return first;
    if (req.signal?.aborted) return "unavailable";
    // Only a run that FAILED earns a second dialog. One that exited 0 showed a
    // dialog nobody answered; one killed by the backstop (`code: null`) hung
    // with a dialog up, and a second would double the stall.
    if (jxa.code === 0 || jxa.code === null) return "timeout";

    const as = await this.runner(
      "/usr/bin/osascript",
      ["-e", APPLESCRIPT_DIALOG, dialogText(req), ...tail],
      req,
    );
    if (as.spawnFailed) return "unavailable";
    const second = parseMac(as.stdout);
    if (second) return second;
    // No window server (an ssh session, a logged-out Mac): osascript exits
    // non-zero having shown nothing.
    return as.code === 0 ? "timeout" : "unavailable";
  }
}

/** Linux desktops, for the run-it-on-a-friend's-laptop case: `zenity`. */
export class ZenityPrompter implements Prompter {
  constructor(private readonly runner: DialogRunner = run) {}

  async prompt(req: PromptRequest): Promise<PromptAnswer> {
    const { code, stdout, spawnFailed } = await this.runner(
      "zenity",
      [
        "--question",
        "--title=strad-hostd",
        `--text=${dialogText(req)}`,
        "--no-markup",
        "--ok-label=Allow",
        "--cancel-label=Reject",
        `--extra-button=${COOLDOWN_LABEL}`,
        "--default-cancel",
        `--timeout=${req.seconds}`,
      ],
      req,
    );
    if (spawnFailed) return "unavailable";
    if (code === 0) return "allowed";
    // The extra button exits 1 like Reject, and says which it was on stdout.
    if (code === 1)
      return stdout.trim() === COOLDOWN_LABEL
        ? "rejected_cooldown"
        : "rejected";
    if (code === 5) return "timeout";
    return "unavailable";
  }
}

/** Nothing can show a dialog here, so nothing is ever agreed to. */
export class UnavailablePrompter implements Prompter {
  async prompt(): Promise<PromptAnswer> {
    return "unavailable";
  }
}

export function platformPrompter(platform = process.platform): Prompter {
  if (platform === "darwin") return new MacDialogPrompter();
  if (platform === "linux") return new ZenityPrompter();
  return new UnavailablePrompter();
}
