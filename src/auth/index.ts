import type { StradConfig } from "../config/schema.ts";
import { bearerToken } from "./credential.ts";
import { EnvTokenStore, verifyToken, type TokenStore } from "./tokens.ts";

/**
 * Who is making this request, and what are they entitled to?
 *
 * `roles` is the ONLY thing downstream authorization reads. It comes from the
 * server side — a token record or a verified Google identity — never from
 * anything the caller can set.
 */
export interface Principal {
  kind: "system-token" | "google" | "console-bypass";
  /** Loggable identifier. Never a secret. */
  id: string;
  label: string;
  roles: string[];
}

export class Unauthenticated extends Error {
  constructor(
    message: string,
    /** For server logs. Never returned to the caller. */
    readonly reason: string,
  ) {
    super(message);
  }
}

/**
 * Authenticate a request to /mcp.
 *
 * Static system tokens, and nothing else. Not the console session, not the dev
 * bypass, not "no header means dev mode". strad sits on the open internet with
 * no network perimeter in front of it, so this function is the entire gate.
 */
export async function authenticateMcp(
  authorizationHeader: string | undefined,
  store: TokenStore,
  expectedEnv: string,
): Promise<Principal> {
  const raw = bearerToken(authorizationHeader);
  if (!raw) {
    throw new Unauthenticated(
      "missing bearer token",
      "no_authorization_header",
    );
  }

  const verdict = await verifyToken(raw, store, expectedEnv);
  if (!verdict.ok) {
    // The caller always gets the same 401; `reason` is for our logs.
    throw new Unauthenticated("invalid token", verdict.reason);
  }

  return {
    kind: "system-token",
    id: verdict.record.pubid,
    label: verdict.record.label,
    roles: verdict.record.roles,
  };
}

export function tokenStoreFromConfig(
  cfg: StradConfig,
  env: NodeJS.ProcessEnv = process.env,
): TokenStore {
  if (!cfg.auth.staticTokens.enabled) {
    // An empty store, not a disabled check. /mcp still requires a token; it
    // just can never satisfy one. Fail closed.
    return new EnvTokenStore(undefined);
  }
  return new EnvTokenStore(env.STRAD_TOKENS);
}
