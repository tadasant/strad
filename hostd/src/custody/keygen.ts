import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";

/**
 * An SSH keypair minted on this machine for custody's `generate_keypair`.
 *
 * The private half is returned ONCE, to the one caller that puts it straight
 * into the vault; nothing else in the daemon sees it. The public half and its
 * fingerprint are what a model is told, and both are public by definition.
 *
 * ed25519 only. Node's crypto mints the key but has no OpenSSH encoder, so the
 * `openssh-key-v1` container (PROTOCOL.key in OpenSSH's source) is built here:
 * unencrypted, one key, the form `ssh-keygen -t ed25519 -N ''` writes and the
 * form the ssh server's `ssh2` parser reads.
 */
export const KEY_TYPES = ["ed25519"] as const;
export type KeyType = (typeof KEY_TYPES)[number];

export interface MintedKeypair {
  /** `-----BEGIN OPENSSH PRIVATE KEY-----` … SECRET. */
  privateKey: string;
  /** `ssh-ed25519 AAAA… comment`, one line, no newline. */
  publicKey: string;
  /** `SHA256:…`, as `ssh-keygen -lf` prints it. */
  fingerprint: string;
}

/** A comment that cannot break the one-line public key or an authorized_keys file. */
export const KEY_COMMENT = /^[\x21-\x7e](?:[\x20-\x7e]{0,118}[\x21-\x7e])?$/;

const ED25519_TYPE = "ssh-ed25519";

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

/** An SSH wire `string`: a uint32 length, then the bytes. */
function sshString(bytes: Buffer | string): Buffer {
  const b = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  return Buffer.concat([u32(b.length), b]);
}

export function mintKeypair(type: KeyType, comment: string): MintedKeypair {
  if (type !== "ed25519") throw new Error(`unsupported key type ${type}`);
  if (!KEY_COMMENT.test(comment))
    throw new Error(
      "the comment must be 1–120 printable ASCII characters with no leading or trailing space",
    );
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // The raw 32-byte halves are the tails of the DER encodings: SPKI for the
  // public key, PKCS#8 (an OCTET STRING around the seed) for the private one.
  const spki = publicKey.export({ format: "der", type: "spki" });
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
  const pub = Buffer.from(spki.subarray(spki.length - 32));
  const seed = Buffer.from(pkcs8.subarray(pkcs8.length - 32));
  pkcs8.fill(0);

  const blob = Buffer.concat([sshString(ED25519_TYPE), sshString(pub)]);
  const check = randomBytes(4);
  // OpenSSH's ed25519 private key is the seed followed by the public key.
  const secret = Buffer.concat([seed, pub]);
  seed.fill(0);
  const body = Buffer.concat([
    check,
    check,
    sshString(ED25519_TYPE),
    sshString(pub),
    sshString(secret),
    sshString(comment),
  ]);
  secret.fill(0);
  // Padded to the cipher block size, 8 for "none", with 1, 2, 3, ….
  const padLength = (8 - (body.length % 8)) % 8;
  const pad = Buffer.from(Array.from({ length: padLength }, (_, i) => i + 1));
  const priv = Buffer.concat([body, pad]);
  body.fill(0);

  const container = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "latin1"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    u32(1),
    sshString(blob),
    sshString(priv),
  ]);
  priv.fill(0);
  const b64 = container.toString("base64");
  container.fill(0);
  const lines = b64.match(/.{1,70}/g) ?? [];
  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `${ED25519_TYPE} ${blob.toString("base64")} ${comment}`,
    fingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`,
  };
}
