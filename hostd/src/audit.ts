import { appendFileSync } from "node:fs";
import { join } from "node:path";

export interface AuditEntry {
  at: string;
  kind:
    | "request"
    | "granted"
    | "denied"
    | "ended"
    | "killed"
    | "expired"
    | "tool"
    | "disabled"
    | "enabled";
  capability?: string;
  grantId?: string;
  /** Human-readable, one line. For a tool call: the tool and a short summary. */
  detail: string;
}

/**
 * What happened on this machine, for its owner. An append-only JSONL file in the
 * state directory plus the last few hundred entries in memory for the status
 * page. It never leaves the machine: no tool returns it and nothing ships it.
 */
export class AuditLog {
  private readonly recent: AuditEntry[] = [];
  private readonly file?: string;

  constructor(
    dir?: string,
    private readonly keep = 300,
  ) {
    this.file = dir ? join(dir, "audit.jsonl") : undefined;
  }

  record(entry: Omit<AuditEntry, "at">): void {
    const full: AuditEntry = { at: new Date().toISOString(), ...entry };
    this.recent.push(full);
    if (this.recent.length > this.keep) this.recent.shift();
    if (this.file) {
      try {
        appendFileSync(this.file, JSON.stringify(full) + "\n", { mode: 0o600 });
      } catch {
        // A full disk must not turn into a refused kill or a crashed daemon.
      }
    }
  }

  tail(n = 50): AuditEntry[] {
    return this.recent.slice(-n).reverse();
  }
}
