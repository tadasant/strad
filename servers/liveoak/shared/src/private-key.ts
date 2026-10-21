/**
 * `LIVEOAK_GCS_PRIVATE_KEY`, from whatever shape a human pasted it in, to the
 * one shape `createSign` accepts: an RSA private key as a PEM.
 *
 * WHY THIS IS LENIENT. A service-account key arrives as a JSON file, and the
 * PEM inside it is a JSON string with escaped newlines. Between that file and
 * this process it can be pasted with its quotes, pasted as the whole file,
 * carried with `\r\n`, or have its line breaks stripped by a password input
 * (strad's console did that until #438). Every one of those still holds the
 * same base64 between the same two armour lines, so the key is rebuilt from
 * that rather than refused. Node's own refusal for all of them is
 * `error:1E08010C:DECODER routines::unsupported`, which names nothing a human
 * can act on.
 *
 * Messages say "BEGIN line", not the armour itself: `redact` removes anything
 * shaped like a PEM block, which would remove the advice with it.
 *
 * WHAT IS NEVER DONE: quote the value. Every error here describes the SHAPE of
 * what was set — no armour line, a public key, an EC key, base64 that does not
 * decode — and nothing of its content.
 */
import { createPrivateKey, type KeyObject } from "node:crypto";
import { ConfigError } from "./config.js";

const NAME = "LIVEOAK_GCS_PRIVATE_KEY";

const WHAT_TO_PASTE =
  `Paste the service account's JSON key file whole, or just its "private_key" ` +
  `value (from its BEGIN PRIVATE KEY line to its END PRIVATE KEY line). ` +
  `See docs/servers/liveoak (Setup).`;

export interface ParsedPrivateKey {
  /** A PEM `createSign` accepts, with standard 64-column line breaks. */
  pem: string;
  /** Present when a whole JSON key file was pasted. Not a secret. */
  clientEmail?: string;
}

function refuse(problem: string): never {
  throw new ConfigError(`${NAME} is set but is not a usable private key: ${problem}. ${WHAT_TO_PASTE}`);
}

/** A JSON string literal, `"…"`, decoded; or the value with one pair of plain quotes removed. */
function unquote(value: string): string {
  const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
  if (!quoted) return value;
  if (quoted[1] === '"') {
    try {
      const decoded: unknown = JSON.parse(value);
      if (typeof decoded === "string") return decoded.trim();
    } catch {
      // Not valid JSON (a raw newline inside, say): fall through and strip.
    }
  }
  return quoted[2]!.trim();
}

function fromKeyFile(value: string): ParsedPrivateKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    refuse("it starts with `{` but is not valid JSON (was the key file cut short?)");
  }
  const file = (parsed ?? {}) as { private_key?: unknown; client_email?: unknown };
  if (typeof file.private_key !== "string" || file.private_key.trim() === "") {
    refuse('it is a JSON object with no "private_key" field');
  }
  return {
    pem: fromPem(file.private_key),
    ...(typeof file.client_email === "string" && file.client_email.trim() !== ""
      ? { clientEmail: file.client_email.trim() }
      : {}),
  };
}

const ARMOUR = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/;

function fromPem(raw: string): string {
  // Escaped newlines (an App Platform env var, or a JSON string pasted raw)
  // and CRLF line ends. Whitespace inside the base64 is dropped below anyway,
  // so a key whose line breaks were stripped or turned to spaces still
  // rebuilds.
  const text = raw.replace(/\\r/g, "").replace(/\\n/g, "\n").replace(/\r/g, "");
  const armour = ARMOUR.exec(text);
  if (!armour) {
    if (/-----BEGIN [A-Z0-9 ]+-----/.test(text)) {
      refuse("it has a BEGIN line but no matching END line (was it cut short?)");
    }
    const bare = text.replace(/\s+/g, "");
    if (bare.length >= 64 && /^[A-Za-z0-9+/]+={0,2}$/.test(bare)) return fromBase64(bare);
    refuse("it has no BEGIN PRIVATE KEY line");
  }
  const label = armour[1]!;
  if (/PUBLIC KEY|CERTIFICATE/.test(label)) refuse(`it is a ${label.toLowerCase()}, not a private key`);
  if (label === "ENCRYPTED PRIVATE KEY") refuse("it is encrypted with a passphrase");
  if (!/PRIVATE KEY$/.test(label)) refuse(`its armour says ${label.toLowerCase()}, not a private key`);
  const body = armour[2]!.replace(/\s+/g, "");
  if (body === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) {
    refuse("the text between its BEGIN and END lines is not base64");
  }
  const lines = body.match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

/**
 * Base64 with no armour: either a whole PEM (or key file) base64-wrapped once
 * more, or the key's DER body with its armour lost.
 */
function fromBase64(bare: string): string {
  const decoded = Buffer.from(bare, "base64").toString("utf8");
  if (decoded.includes("-----BEGIN ")) return fromPem(decoded);
  if (decoded.trimStart().startsWith("{")) return fromKeyFile(decoded.trim()).pem;
  const lines = bare.match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
}

function check(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    refuse("its base64 does not decode to a private key (is part of it missing?)");
  }
  if (key.asymmetricKeyType !== "rsa") {
    refuse(
      `it is ${key.asymmetricKeyType ? `an ${key.asymmetricKeyType.toUpperCase()}` : "a non-RSA"} key, ` +
        `and a Google service-account key is RSA`,
    );
  }
  return key;
}

/**
 * The key, normalized and proven to load as an RSA private key. Throws a
 * {@link ConfigError} describing the shape of a value that is not one.
 */
export function parsePrivateKey(raw: string): ParsedPrivateKey {
  const value = unquote(raw.trim());
  const parsed = value.startsWith("{") ? fromKeyFile(value) : { pem: fromPem(value) };
  check(parsed.pem);
  return parsed;
}
