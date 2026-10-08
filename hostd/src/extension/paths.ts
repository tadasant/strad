import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The unpacked extension, `hostd/extension` in the clone and `app/extension`
 * in an install: a sibling of the `build/` tree this module runs from.
 */
export function extensionDir(): string {
  return fileURLToPath(new URL("../../extension", import.meta.url));
}

export const EXTENSION_TOKEN_FILE = "extension-token";
export const EXTENSION_KEY_FILE = "extension-key.pem";
export const PROFILE_FILE = "strad-hostd-extension.mobileconfig";

export function extensionTokenPath(stateDir: string): string {
  return join(stateDir, EXTENSION_TOKEN_FILE);
}

export function extensionKeyPath(stateDir: string): string {
  return join(stateDir, EXTENSION_KEY_FILE);
}

/** Where the extension connects, and where Chrome fetches the CRX: the control listener. */
export function extensionEndpoint(controlPort: number): string {
  return `ws://127.0.0.1:${controlPort}/extension`;
}

export function updateManifestUrl(controlPort: number): string {
  return `http://127.0.0.1:${controlPort}/extension/update.xml`;
}

export function crxUrl(controlPort: number): string {
  return `http://127.0.0.1:${controlPort}/extension/strad-hostd.crx`;
}
