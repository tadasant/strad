import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * A secret that lives in the state directory and is made on first use, mode
 * 0600, so the daemon and the CLI read the same one whichever ran first.
 */
export function readOrCreateSecret(path: string, make: () => string): string {
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const value = make();
  writeFileSync(path, value, { mode: 0o600 });
  return value.trim();
}

/** The extension's pairing token: 32 random bytes, base64url. */
export function pairingToken(path: string): string {
  return readOrCreateSecret(path, () => randomBytes(32).toString("base64url"));
}
