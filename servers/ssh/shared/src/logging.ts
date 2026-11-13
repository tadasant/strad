/**
 * Scrubbing for anything this server says: tool errors and its own log lines.
 *
 * The private key is the whole credential, and a root key on a production host
 * at that. Nothing in this tree puts it in a message on purpose; this is the net
 * under the cases nobody thought of — an upstream error that quotes its input, a
 * parse failure that echoes a line. Any PEM or OpenSSH block is removed, and so
 * are the literal configured key and passphrase.
 *
 * Log lines carry the slug, the host and what happened. Never a command, a path
 * or file content: those are tool arguments and results, which strad's telemetry
 * rule keeps out of every channel.
 */

const PEM_BLOCK =
  /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(-----END [A-Z0-9 ]+-----|$)/g;

export function redact(
  text: string,
  secrets: ReadonlyArray<string | undefined> = [],
): string {
  let out = text.replace(PEM_BLOCK, "[redacted key]");
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    out = out.split(secret).join("[redacted]");
    const trimmed = secret.trim();
    if (trimmed !== secret && trimmed.length >= 4) {
      out = out.split(trimmed).join("[redacted]");
    }
  }
  return out;
}

export function log(label: string, message: string): void {
  console.error(`[ssh ${label}] ${message}`);
}
