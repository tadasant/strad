import { spawn } from "node:child_process";

/**
 * A notification on the machine when a grant starts and when it ends.
 *
 * The consent dialog is gone in five seconds, and under `onTimeout: "allow"` it
 * can come and go with nobody looking. A notification stays in the OS's
 * notification list, so "something took control of this machine while I was
 * away" is a thing its owner finds out from the machine, not from a log.
 *
 * It is NOT the persistent on-screen banner a driven machine deserves. That
 * needs a process that stays on screen and that a caller with a shell cannot
 * quietly dismiss, which is the native helper the design page describes.
 */
export interface Notifier {
  notify(title: string, body: string): void;
}

const APPLESCRIPT = `on run argv
  display notification (item 2 of argv) with title (item 1 of argv)
end run`;

function fire(cmd: string, args: string[]): void {
  try {
    const child = spawn(cmd, args, { stdio: "ignore" });
    // A machine with no notifier is not an error worth a crashed daemon.
    child.on("error", () => {});
    child.unref();
  } catch {
    // Same.
  }
}

/** Text travels as ARGV to a constant script, as it does for the dialog. */
export class MacNotifier implements Notifier {
  notify(title: string, body: string): void {
    fire("/usr/bin/osascript", ["-e", APPLESCRIPT, title, body]);
  }
}

export class NotifySendNotifier implements Notifier {
  notify(title: string, body: string): void {
    fire("notify-send", ["--app-name=strad-hostd", title, body]);
  }
}

export class SilentNotifier implements Notifier {
  notify(): void {}
}

export function platformNotifier(platform = process.platform): Notifier {
  if (platform === "darwin") return new MacNotifier();
  if (platform === "linux") return new NotifySendNotifier();
  return new SilentNotifier();
}
