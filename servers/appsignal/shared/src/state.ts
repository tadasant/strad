// State management for the AppSignal MCP server

// STRAD DELTA (servers/appsignal/README.md, delta 1): an app ID can be scoped to
// one async call chain. Upstream reads the app ID from `process.env` or one
// module-wide variable, which is right for one server per process and wrong for
// the strad bundle, where several AppSignal mounts — each its own app — share a
// process. The scope is consulted first; outside one, upstream's behaviour is
// unchanged.
import { AsyncLocalStorage } from 'node:async_hooks';

const instanceScope = new AsyncLocalStorage<{ appId: string }>();

/**
 * Run `fn` with `appId` as the effective, locked app ID for everything it awaits.
 */
export function runWithAppId<T>(appId: string, fn: () => T): T {
  return instanceScope.run({ appId }, fn);
}

// In-memory state to store the selected app ID
let selectedAppId: string | undefined = undefined;

export function getSelectedAppId(): string | undefined {
  return selectedAppId;
}

export function setSelectedAppId(appId: string): void {
  selectedAppId = appId;
}

export function clearSelectedAppId(): void {
  selectedAppId = undefined;
}

/**
 * Get the effective app ID (env var takes precedence over selected)
 */
export function getEffectiveAppId(): string | undefined {
  const scoped = instanceScope.getStore();
  if (scoped) return scoped.appId || undefined;
  return process.env.APPSIGNAL_APP_ID || selectedAppId;
}

/**
 * Check if the app ID is locked (configured via environment variable)
 */
export function isAppIdLocked(): boolean {
  if (instanceScope.getStore()) return true;
  return !!process.env.APPSIGNAL_APP_ID;
}
