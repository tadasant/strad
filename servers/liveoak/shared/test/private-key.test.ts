/**
 * LIVEOAK_GCS_PRIVATE_KEY in every shape a human has pasted it in, each one
 * proven by SIGNING with the result and verifying against the public half —
 * and the shapes that are not a key at all, refused by name without quoting
 * a byte of the value.
 */
import { createSign, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { parsePrivateKey } from "../src/private-key.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PKCS1 = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const BODY = PEM.split("\n").slice(1, -2).join("");
const EMAIL = "liveoak@project.iam.gserviceaccount.com";
const KEY_FILE = JSON.stringify(
  { type: "service_account", project_id: "p", private_key: PEM, client_email: EMAIL },
  null,
  2,
);

function signs(pem: string): boolean {
  const sig = createSign("RSA-SHA256").update("x").sign(pem);
  return createVerify("RSA-SHA256").update("x").verify(publicKey, sig);
}

describe("LIVEOAK_GCS_PRIVATE_KEY: the shapes it is accepted in", () => {
  const shapes: Record<string, string> = {
    "a PEM, as is": PEM,
    "escaped newlines (an App Platform env var)": PEM.replace(/\n/g, "\\n"),
    "CRLF line ends": PEM.replace(/\n/g, "\r\n"),
    "escaped CRLF": PEM.replace(/\n/g, "\\r\\n"),
    "line breaks stripped (a password input)": PEM.replace(/\n/g, ""),
    "line breaks turned to spaces": PEM.replace(/\n/g, " "),
    "the JSON string, quotes and all": JSON.stringify(PEM),
    "single-quoted": `'${PEM}'`,
    "double-quoted with real newlines": `"${PEM}"`,
    "PKCS#1 (BEGIN RSA PRIVATE KEY)": PKCS1,
    "the PEM base64-wrapped once more": Buffer.from(PEM).toString("base64"),
    "the base64 body with its armour lost": BODY,
    "the whole key file": KEY_FILE,
    "the whole key file, on one line": JSON.stringify(JSON.parse(KEY_FILE)),
    "the whole key file, base64-wrapped": Buffer.from(KEY_FILE).toString("base64"),
    "surrounding whitespace": `\n  ${PEM}  \n`,
  };
  for (const [shape, value] of Object.entries(shapes)) {
    it(shape, () => {
      const parsed = parsePrivateKey(value);
      expect(parsed.pem).toMatch(/^-----BEGIN (RSA )?PRIVATE KEY-----\n/);
      expect(parsed.pem.split("\n").every((l) => l.length <= 64)).toBe(true);
      expect(signs(parsed.pem)).toBe(true);
    });
  }

  it("a key file also yields its client_email", () => {
    expect(parsePrivateKey(KEY_FILE).clientEmail).toBe(EMAIL);
    expect(parsePrivateKey(PEM).clientEmail).toBeUndefined();
  });
});

describe("LIVEOAK_GCS_PRIVATE_KEY: what it refuses, and how", () => {
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" });
  const encrypted = privateKey
    .export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "pw" })
    .toString();
  const cases: Array<[string, string, RegExp]> = [
    ["nothing like a key", "not-a-key", /no BEGIN PRIVATE KEY line/],
    ["a public key", publicKey.export({ type: "spki", format: "pem" }).toString(), /public key, not a private key/],
    ["an EC key", ec.toString(), /an EC key, and a Google service-account key is RSA/],
    ["an encrypted key", encrypted, /encrypted with a passphrase/],
    ["a key cut short (no END line)", PEM.slice(0, 400), /no matching END line/],
    ["a key missing part of its body", PEM.split("\n").filter((_, i) => i < 5 || i > 9).join("\n"), /does not decode to a private key/],
    ["a body that is not base64", "-----BEGIN PRIVATE KEY-----\n!!!\n-----END PRIVATE KEY-----", /not base64/],
    ["a key file with no private_key", JSON.stringify({ type: "service_account" }), /no "private_key" field/],
    ["a key file cut short", KEY_FILE.slice(0, 200), /not valid JSON/],
    [
      "an OpenSSH key",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
      /an OpenSSH key/,
    ],
    [
      "an encrypted PKCS#1 key",
      "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,00\n\nAAAA\n-----END RSA PRIVATE KEY-----",
      /encrypted with a passphrase/,
    ],
  ];
  for (const [what, value, expected] of cases) {
    it(what, () => {
      let error: unknown;
      try {
        parsePrivateKey(value);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as Error).message;
      expect(message).toMatch(expected);
      expect(message).toContain("LIVEOAK_GCS_PRIVATE_KEY");
      expect(message).toContain("docs/servers/liveoak");
      // Not a byte of the key itself.
      expect(message).not.toContain(BODY.slice(0, 16));
      expect(message).not.toContain(BODY.slice(-16));
      expect(message).not.toMatch(/DECODER|routines/);
    });
  }
});

describe("loadConfig and the key", () => {
  const env = (key: string, email = EMAIL): NodeJS.ProcessEnv => ({
    LIVEOAK_USERNAME: "me@example.com",
    LIVEOAK_PASSWORD: "pw",
    LIVEOAK_STATE_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    LIVEOAK_GCS_BUCKET: "bucket",
    LIVEOAK_GCS_CLIENT_EMAIL: email,
    LIVEOAK_GCS_PRIVATE_KEY: key,
  });

  it("loads a mangled key as a signing PEM", () => {
    expect(signs(loadConfig(env(PEM.replace(/\n/g, ""))).privateKey)).toBe(true);
    expect(signs(loadConfig(env(KEY_FILE)).privateKey)).toBe(true);
  });

  it("refuses at load, before any tool runs, with a ConfigError", () => {
    expect(() => loadConfig(env("garbage"))).toThrow(ConfigError);
  });

  it("refuses a key file for a different account than LIVEOAK_GCS_CLIENT_EMAIL, naming both", () => {
    expect(() => loadConfig(env(KEY_FILE, "other@project.iam.gserviceaccount.com"))).toThrow(
      /key file for service account "liveoak@…", but LIVEOAK_GCS_CLIENT_EMAIL is "other@…"/,
    );
  });
});
