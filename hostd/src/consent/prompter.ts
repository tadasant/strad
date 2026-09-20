import { spawn } from "node:child_process";

/**
 * What the person at the machine said.
 *
 * `unavailable` is its own answer, not a flavour of `timeout`: a dialog that was
 * shown and ignored is a decision the owner's config may interpret, and a dialog
 * that could not be shown at all is a request nobody had the chance to refuse.
 * The second is always a denial.
 */
export type PromptAnswer = "allowed" | "rejected" | "timeout" | "unavailable";

export interface PromptRequest {
  /** The requesting server's display name, e.g. `shell-tadas-mbp`. */
  server: string;
  purpose: string;
  seconds: number;
  /** What an unanswered dialog will mean, so the dialog can say so. */
  onTimeout: "deny" | "allow";
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
  return `Remote control requested by ${req.server} MCP server for purpose: ${req.purpose}\n\n${tail}`;
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

const APPLESCRIPT = `on run argv
  set r to display dialog (item 1 of argv) with title (item 2 of argv) buttons {"Reject", "Allow"} default button "Reject" giving up after ((item 3 of argv) as integer) with icon caution
  if gave up of r then return "timeout"
  return button returned of r
end run`;

/**
 * macOS: `osascript`'s own `display dialog`, which needs no TCC grant and no
 * helper app. The purpose is passed as an ARGUMENT to a constant script — it is
 * never interpolated into AppleScript source, so a purpose cannot close a string
 * and start a `do shell script`.
 */
export class MacDialogPrompter implements Prompter {
  async prompt(req: PromptRequest): Promise<PromptAnswer> {
    const { stdout, spawnFailed, code } = await run(
      "/usr/bin/osascript",
      ["-e", APPLESCRIPT, dialogText(req), "strad-hostd", String(req.seconds)],
      req,
    );
    if (spawnFailed) return "unavailable";
    const answer = stdout.trim();
    if (answer === "Allow") return "allowed";
    if (answer === "Reject") return "rejected";
    if (answer === "timeout") return "timeout";
    // No window server (an ssh session, a logged-out Mac): osascript exits
    // non-zero having shown nothing.
    return code === 0 ? "timeout" : "unavailable";
  }
}

/** Linux desktops, for the run-it-on-a-friend's-laptop case: `zenity`. */
export class ZenityPrompter implements Prompter {
  async prompt(req: PromptRequest): Promise<PromptAnswer> {
    const { code, spawnFailed } = await run(
      "zenity",
      [
        "--question",
        "--title=strad-hostd",
        `--text=${dialogText(req)}`,
        "--no-markup",
        "--ok-label=Allow",
        "--cancel-label=Reject",
        "--default-cancel",
        `--timeout=${req.seconds}`,
      ],
      req,
    );
    if (spawnFailed) return "unavailable";
    if (code === 0) return "allowed";
    if (code === 1) return "rejected";
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
