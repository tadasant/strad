import {
  createDecipheriv,
  createCipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { Sealer } from "../session.ts";

/**
 * Key material for strad's own authorization server.
 *
 * strad has NO datastore, and that single fact decides the shape of everything
 * in this directory. There is no table of issued codes, no table of clients and
 * no table of refresh tokens — every one of those is a self-contained value the
 * gateway hands out and later reads back, and the only thing that makes it
 * trustworthy is a key held by the process. The console session took the same
 * road for the same reason (`src/auth/session.ts`), so the primitive is reused:
 * `Sealer` is HKDF + HMAC-SHA256 over a base64url payload.
 *
 * WHAT `Sealer` CANNOT DO is keep a secret, and two of the values here carry
 * one. A strad authorization code and a strad refresh token both embed the
 * GOOGLE refresh token the grant is backed by (see `grants.ts` for why), and an
 * authorization code travels through the user's browser in a query string —
 * into history, into a referrer, into whatever the client logs. A signed
 * payload is world-readable, so the values that carry a credential are
 * ENCRYPTED rather than signed: AES-256-GCM, which authenticates as well as
 * hides, so an encrypted value is still unforgeable.
 *
 * DOMAIN SEPARATION, as in `session.ts`: one input keying material, six derived
 * keys, one per kind of value. A refresh token presented as an access token, or
 * a client registration presented as an authorization code, is unreadable
 * garbage rather than a type confusion.
 *
 * It is the HKDF `info` string that does that work, and it is worth saying
 * exactly which half separates these from the CONSOLE's cookies, because the
 * six keys here do not all take the same route. The four `Cipher` keys are
 * derived under this module's own salt; the two `Sealer` keys are derived by
 * `src/auth/session.ts`, under the console's salt, and are separated from the
 * console's own keys by their `info` alone. Both are sufficient — HKDF's
 * `info` is the field the RFC gives this job — but only one of them is a
 * different salt, so do not read the salt as the thing keeping an OAuth token
 * away from a console session.
 *
 * `Cipher` has one consumer outside this module: `ConsoleSessions.connectorSecret`
 * in `src/auth/session.ts`, which encrypts a registered client's secret inside a
 * connector transaction. It derives from the CONSOLE's key material under its
 * own `info`, and so shares this module's salt but none of its keys.
 *
 * THE KEY ITSELF is `STRAD_OAUTH_KEY` when set, else the console's own chain
 * (`CONSOLE_SESSION_SECRET`, else `GOOGLE_CLIENT_SECRET`). The fallback is what
 * makes this feature work on a deployment that has already provisioned a Google
 * OAuth client and nothing else — which is every deployment that has a console.
 * Set `STRAD_OAUTH_KEY` when you want the kill switch: rotating it invalidates
 * every access token, every refresh token and every registered client at once,
 * and leaves console sessions alone.
 */

const HKDF_SALT = "strad.mcp-oauth.v1";

/** Signed: a client registration. Public metadata, unforgeable. */
const INFO_CLIENT = "strad.mcp-oauth.client.v1";
/** Signed: the in-flight browser transaction, in a cookie. */
const INFO_TX = "strad.mcp-oauth.tx.v1";
/** Encrypted: the authorization code. Carries a Google refresh token. */
const INFO_CODE = "strad.mcp-oauth.code.v1";
/** Encrypted: the consent form's pending-grant blob. Carries the same. */
const INFO_APPROVAL = "strad.mcp-oauth.approval.v1";
/** Encrypted: the access token. */
const INFO_ACCESS = "strad.mcp-oauth.access.v1";
/** Encrypted: the refresh token. Carries a Google refresh token. */
const INFO_REFRESH = "strad.mcp-oauth.refresh.v1";

/**
 * The shortest key material we will derive from — the same floor, and the same
 * reasoning, as `src/auth/session.ts`. HKDF spreads its input over 32 bytes but
 * creates no entropy, and every format in this directory is public in it.
 */
const MIN_KEY_CHARS = 24;

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Seals a JSON payload under one derived key, with AES-256-GCM.
 *
 * `base64url(iv ‖ tag ‖ ciphertext)`. GCM authenticates, so `open()` returning
 * a payload is proof this process sealed it — the same guarantee `Sealer` gives,
 * with confidentiality on top. A tampered byte anywhere fails the tag check and
 * comes back null rather than as a partially-decrypted object.
 *
 * There is no expiry check here. Two of the four things sealed with a `Cipher`
 * expire and two do not, so the deadline belongs to the payload's own reader
 * (`grants.ts`) rather than to the envelope.
 */
export class Cipher {
  private readonly key: Buffer;

  constructor(ikm: string, info: string) {
    this.key = Buffer.from(
      hkdfSync("sha256", Buffer.from(ikm, "utf8"), HKDF_SALT, info, 32),
    );
  }

  seal(payload: object): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
  }

  /** The payload, or null for anything this key did not seal. */
  open<T extends { v: 1 }>(token: string | undefined): T | null {
    if (!token) return null;
    const raw = Buffer.from(token, "base64url");
    if (raw.length <= IV_BYTES + TAG_BYTES) return null;

    // One `try`, around everything that can throw. `Buffer.from(…,
    // "base64url")` above is not one of them — Node drops characters outside
    // the alphabet rather than raising — which is why the length guard is what
    // rejects a truncated value there.
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        raw.subarray(0, IV_BYTES),
      );
      decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      const plain = Buffer.concat([
        decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]).toString("utf8");
      const payload = JSON.parse(plain) as T;
      // The tag proves we sealed it; it does not prove the shape. The version
      // tag exists so a future v2 payload cannot be read as a v1 one under the
      // same key, and enforcing it is what makes it worth carrying.
      if (payload?.v !== 1) return null;
      return payload;
    } catch {
      // A failed tag, a truncated value, a body that is not JSON. One answer for
      // all of them: this is not a value we issued.
      return null;
    }
  }
}

export interface McpOAuthKeys {
  /** Client registrations. Signed — the metadata inside is public by design. */
  client: Sealer;
  /** The browser's in-flight transaction cookie. */
  tx: Sealer;
  code: Cipher;
  approval: Cipher;
  access: Cipher;
  refresh: Cipher;
}

/** Build the keys, or null when there is no usable key material. */
export function mcpOAuthKeysFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): McpOAuthKeys | null {
  const ikm = oauthIkm(env);
  if (!ikm || ikm.length < MIN_KEY_CHARS) return null;
  return {
    client: new Sealer(ikm, INFO_CLIENT),
    tx: new Sealer(ikm, INFO_TX),
    code: new Cipher(ikm, INFO_CODE),
    approval: new Cipher(ikm, INFO_APPROVAL),
    access: new Cipher(ikm, INFO_ACCESS),
    refresh: new Cipher(ikm, INFO_REFRESH),
  };
}

function oauthIkm(env: NodeJS.ProcessEnv): string | undefined {
  return (
    env.STRAD_OAUTH_KEY ||
    env.CONSOLE_SESSION_SECRET ||
    env.GOOGLE_CLIENT_SECRET ||
    undefined
  );
}

/** Why `mcpOAuthKeysFromEnv` returned null, for the boot warning. */
export function oauthKeyProblem(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const ikm = oauthIkm(env);
  if (!ikm) {
    return "no signing key (set STRAD_OAUTH_KEY, CONSOLE_SESSION_SECRET or GOOGLE_CLIENT_SECRET)";
  }
  if (ikm.length < MIN_KEY_CHARS) {
    return `the OAuth signing key is shorter than ${MIN_KEY_CHARS} characters and is refused as forgeable`;
  }
  return null;
}
