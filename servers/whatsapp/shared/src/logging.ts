/**
 * stderr only, and NEVER a message's text or a key.
 *
 * The bundle's stdout/stderr stream is not shipped anywhere — a line here is for
 * a human reading container output. What this server holds is the whole
 * account: the Signal state, the sealing key, and the text of every chat. No
 * code here passes any of that to these functions, but the text they carry is
 * often an error from a library this repo does not own (Baileys, the GCS
 * client), so `redact` runs over every line and over every error a tool returns.
 *
 * Baileys' own logger is silenced (level `silent` in socket.ts) for the same
 * reason: at `debug` it prints decrypted message nodes.
 */

const PREFIX = "[whatsapp]";

/**
 * Anything shaped like a secret: a long base64/hex run (a key, a signed token,
 * a serialized Signal record) and a PEM block. A phone number is NOT redacted —
 * it is too short to match, and it is the thing an operator needs to see.
 */
const SECRET_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
  /[A-Za-z0-9+/=_-]{40,}/g,
];

export function redact(message: string): string {
  return SECRET_SHAPES.reduce(
    (text, shape) => text.replace(shape, "[redacted]"),
    message,
  );
}

export function logInfo(message: string): void {
  console.error(`${PREFIX} ${redact(message)}`);
}

export function logWarning(message: string): void {
  console.error(`${PREFIX} WARN ${redact(message)}`);
}

export function logError(message: string): void {
  console.error(`${PREFIX} ERROR ${redact(message)}`);
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * libsignal — Baileys' Signal implementation — writes to `console` directly,
 * and what it writes is the Signal state itself: `console.info("Closing
 * session:", session)` prints a session's root key and ratchet private keys in
 * full, on ordinary events (a contact's new device, an incoming prekey
 * message). Baileys has a few `console` calls of its own. None of it passes
 * through a logger this server can silence.
 *
 * So `console` is wrapped, once, before Baileys is loaded — and the wrapper
 * acts ONLY on calls whose stack runs through `node_modules/libsignal/` or
 * `node_modules/baileys/`. Everything else in this process (the bundle hosts
 * twenty-three other servers) is passed through untouched. From those two
 * libraries, `log` / `info` / `debug` are dropped, and `warn` / `error` keep
 * only their leading string, redacted: never an object, never a stack.
 */
const NOISY_LIBRARY = /[\\/]node_modules[\\/](libsignal|baileys)[\\/]/;
const GUARDED = Symbol.for("strad.whatsapp.consoleGuard");

export function installConsoleGuard(target: Console = console): void {
  const marked = target as unknown as Record<symbol, boolean>;
  if (marked[GUARDED]) return;
  marked[GUARDED] = true;
  for (const level of ["log", "info", "debug", "trace", "warn", "error"] as const) {
    const original = target[level].bind(target);
    target[level] = (...args: unknown[]) => {
      if (!NOISY_LIBRARY.test(new Error().stack ?? "")) {
        original(...args);
        return;
      }
      if (level !== "warn" && level !== "error") return;
      const lead = typeof args[0] === "string" ? args[0] : "(non-text message)";
      original(`${PREFIX} ${level === "warn" ? "WARN" : "ERROR"} [signal] ${redact(lead)}`);
    };
  }
}
