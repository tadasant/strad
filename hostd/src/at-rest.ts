import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  ID_ONLY_TOOLS,
  recordText,
  REDACTION_VERSION,
  summaryTool,
  type Redactor,
} from "./redact.js";

/** The version the files on disk were last rewritten to; bump `REDACTION_VERSION` to rerun. */
export const AT_REST_REDACTION_VERSION = REDACTION_VERSION;
const MARKER = "at-rest-redaction";

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
  // Written by a daemon that already redacted it: kept exactly as it is, so
  // a re-run (a failed one, or a version bump) never cuts a new record.
  if (typeof e.redacted === "number" && e.redacted >= AT_REST_REDACTION_VERSION)
    return line;
  const detail = typeof e.detail === "string" ? e.detail : "";
  const removed = `[removed by at-rest redaction v${AT_REST_REDACTION_VERSION}]`;
  let kept: string;
  if (e.kind === "tool") {
    // Historic summaries were recorded raw, and no heuristic can prove a
    // free-text line clean: everything but an id-only summary is cut to the
    // tool's name.
    const name = summaryTool(detail) ?? "tool";
    kept = ID_ONLY_TOOLS.has(name)
      ? recordText(detail, known, undefined, { shapes: false })
      : `${name}: ${removed}`;
  } else if (e.kind === "request" || e.kind === "granted") {
    // A purpose is caller-authored free text too. What precedes it — the
    // server, or how and for how long it was granted — is the daemon's.
    const colon = detail.indexOf(": ");
    kept = colon === -1 ? removed : `${detail.slice(0, colon)}: ${removed}`;
    kept = recordText(kept, known);
  } else {
    kept = recordText(detail, known);
  }
  return JSON.stringify({
    at: e.at,
    kind: e.kind,
    ...(typeof e.capability === "string" ? { capability: e.capability } : {}),
    ...(typeof e.grantId === "string" ? { grantId: e.grantId } : {}),
    detail: kept,
    redacted: AT_REST_REDACTION_VERSION,
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
 * would leave the running daemon writing into an unlinked file. A crash in
 * the middle of that write can lose the log, which is the cheaper failure.
 *
 * `stdio` runs do not migrate. One appending while `serve` rewrites can lose
 * its line to the rename.
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
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, out.map((l) => l + "\n").join(""));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
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
