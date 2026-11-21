import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { recordText, type Redactor } from "./redact.js";

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
  /**
   * Human-readable, one line. For a tool call: the tool and a short summary.
   * Redacted before it is kept anywhere (`src/redact.ts`): never a value.
   */
  detail: string;
}

/**
 * What happened on this machine, for its owner. An append-only JSONL file in the
 * state directory plus the last few hundred entries in memory for the status
 * page. It never leaves the machine: no tool returns it and nothing ships it.
 *
 * It is also at rest on the owner's disk, in Time Machine and on the status
 * page, so it records WHICH secret went WHERE and never a secret's bytes:
 * every entry's `detail` is redacted on the way in, before the file or the
 * tail sees it. There is no un-redacted copy to fall back to.
 */
export class AuditLog {
  private readonly recent: AuditEntry[] = [];
  private readonly file?: string;
  private known: Redactor = (s) => s;

  constructor(
    dir?: string,
    private readonly keep = 300,
  ) {
    this.file = dir ? join(dir, "audit.jsonl") : undefined;
  }

  /** The exact values to take out: the vault's and the daemon's own keys. */
  redactKnown(known: Redactor): void {
    this.known = known;
  }

  /** The same redaction, for other text the daemon writes down or shows. */
  scrub(text: string, max?: number): string {
    return recordText(text, this.known, max);
  }

  record(entry: Omit<AuditEntry, "at">): void {
    const full: AuditEntry = {
      at: new Date().toISOString(),
      ...entry,
      detail: this.scrub(entry.detail),
    };
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
