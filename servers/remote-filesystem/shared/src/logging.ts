/**
 * stderr only. stdout is the stdio transport's wire in some hosts, and in the
 * bundle it is a stream strad deliberately does not ship — so a log line here is
 * for a human reading container output, never for telemetry.
 */

const PREFIX = "[remote-filesystem]";

export function logWarning(message: string): void {
  console.error(`${PREFIX} WARN ${message}`);
}

export function logError(message: string): void {
  console.error(`${PREFIX} ERROR ${message}`);
}
