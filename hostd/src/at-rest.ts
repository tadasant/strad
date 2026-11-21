import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { recordText, type Redactor } from "./redact.js";

/**
 * Bumped when what counts as redacted changes. The marker in the state
 * directory records the version the files on disk were last rewritten to, so
 * the rewrite runs once per version and a restart does not redo it.
 */
export const AT_REST_REDACTION_VERSION = 1;
const MARKER = "at-rest-redaction";

/**
 * Tool calls whose summary carries only ids, coordinates, key names, handles
 * and destinations — nothing a caller could have put a secret in. Every other
 * tool's historic summary (a shell command, a script, a URL, a selector, a
 * typed or set value) is reduced to the tool's name, because an older daemon
 * wrote those raw and no heuristic can prove a free-text line clean.
 */
const ID_ONLY_TOOLS = new Set([
  "activate_tab",
  "close_tab",
  "release_tab",
  "discard_handle",
  "deposit",
  "kill_command",
  "take_screenshot",
  "click",
  "move_mouse",
  "drag",
  "scroll",
  "imessage_get_attachment",
]);

/** The launchd logs `serve` writes to on macOS: `install/com.strad.hostd.plist`. */
export function launchdLogFiles(): string[] {
  if (process.platform !== "darwin") return [];
  const dir = join(homedir(), "Library", "Logs");
  return [
    join(dir, "com.strad.hostd.out.log"),
    join(dir, "com.strad.hostd.err.log"),
  ];
}

/** One historic audit line, rebuilt from its known fields and redacted. */
function redactAuditLine(line: string, known: Redactor): string | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined; // a torn or foreign line: dropped, never kept as-is
  }
  if (!raw || typeof raw !== "object") return undefined;
  const e = raw as Record<string, unknown>;
  if (typeof e.at !== "string" || typeof e.kind !== "string") return undefined;
  const detail = typeof e.detail === "string" ? e.detail : "";
  let kept: string;
  if (e.kind === "tool") {
    const name = /^([a-z_]+)(?::|$)/.exec(detail)?.[1] ?? "tool";
    kept = ID_ONLY_TOOLS.has(name)
      ? recordText(detail, known)
      : `${name}: [arguments removed by at-rest redaction v${AT_REST_REDACTION_VERSION}]`;
  } else {
    kept = recordText(detail, known);
  }
  return JSON.stringify({
    at: e.at,
    kind: e.kind,
    ...(typeof e.capability === "string" ? { capability: e.capability } : {}),
    ...(typeof e.grantId === "string" ? { grantId: e.grantId } : {}),
    detail: kept,
  });
}

export interface AtRestResult {
  /** Whether anything was rewritten this time (false: already done). */
  ran: boolean;
  /** Audit entries whose detail changed. */
  auditChanged: number;
  /** Audit lines dropped because they could not be read. */
  auditDropped: number;
  /** Log lines changed, across every log file. */
  logLinesChanged: number;
}

/**
 * Rewrites what an older daemon left on disk so that nothing there holds a
 * secret: `audit.jsonl` (every tool summary, purpose and refusal, recorded
 * raw before redaction existed) and the launchd stdout/stderr logs. Once per
 * `AT_REST_REDACTION_VERSION`, before the daemon writes anything.
 *
 * The audit file is written whole to a sibling and renamed over the original,
 * so a crash mid-way leaves one complete file or the other. A launchd log is
 * rewritten IN PLACE instead: launchd holds it open for append, and a rename
 * would leave the running daemon writing into an unlinked file.
 *
 * What this cannot do, and the docs say so: an SSD with APFS gives no
 * guarantee that the old blocks are overwritten, and a Time Machine backup or
 * a local snapshot taken earlier still has the old file. A secret that was
 * written raw should be treated as exposed on that disk.
 */
export function redactAtRest(
  stateDir: string,
  known: Redactor,
  logFiles: string[] = [],
): AtRestResult {
  const result: AtRestResult = {
    ran: false,
    auditChanged: 0,
    auditDropped: 0,
    logLinesChanged: 0,
  };
  const marker = join(stateDir, MARKER);
  const done = existsSync(marker)
    ? Number(readFileSync(marker, "utf8").trim())
    : 0;
  if (done >= AT_REST_REDACTION_VERSION) return result;
  result.ran = true;

  const audit = join(stateDir, "audit.jsonl");
  if (existsSync(audit)) {
    const out: string[] = [];
    for (const line of readFileSync(audit, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const kept = redactAuditLine(line, known);
      if (kept === undefined) {
        result.auditDropped++;
        continue;
      }
      if (kept !== line) result.auditChanged++;
      out.push(kept);
    }
    const tmp = `${audit}.redacting`;
    writeFileSync(tmp, out.map((l) => l + "\n").join(""), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, audit);
  }

  for (const file of logFiles) {
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    let changed = 0;
    const out = lines.map((line) => {
      // No display cap here (`screenText` still reads at most 4,000
      // characters of a line, so a longer one is cut). Shapes and known
      // values go as they do everywhere else.
      const kept = recordText(line, known, Number.MAX_SAFE_INTEGER);
      // `screenText` folds whitespace; only lines it actually redacted move.
      if (kept === line.replace(/\s+/g, " ").trim()) return line;
      changed++;
      return kept;
    });
    if (changed > 0) {
      writeFileSync(file, out.join("\n"));
      result.logLinesChanged += changed;
    }
  }

  writeFileSync(marker, `${AT_REST_REDACTION_VERSION}\n`, { mode: 0o600 });
  return result;
}
