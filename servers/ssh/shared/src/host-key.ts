/**
 * Host-key pinning: the one check that makes a connection mean "this machine"
 * rather than "whatever answered at this address".
 *
 * STRICT, AND THERE IS NO FIRST USE. OpenSSH's default is to trust a key it has
 * never seen and remember it. A server in a container has nowhere durable to
 * remember it and nobody at a prompt to ask, so trust-on-first-use here would be
 * trust-on-every-use. Instead the key the host must present is part of the
 * configuration, verified by a human out of band, and a connection to a host
 * presenting any other key is refused before authentication — so the private key
 * never signs anything for an impostor.
 *
 * WHAT A PIN LOOKS LIKE. Whatever a human is most likely to paste:
 *
 *   - an `ssh-keyscan` / known_hosts line:   `[zimmer.example]:2222 ssh-ed25519 AAAA…`
 *   - a bare public key:                       `ssh-ed25519 AAAA… comment`
 *   - an OpenSSH fingerprint:                  `SHA256:pRHeXHbwbnQ…`
 *
 * One per line, and any one matching is enough — `ssh-keyscan` prints one line
 * per key type the host has, and pasting all of them is the natural thing to do.
 * The host field of a known_hosts line is NOT compared with `SSH_HOST`: the pin
 * already belongs to exactly one slug, and `ssh-keyscan` writes `[host]:port` or
 * a hashed `|1|…` form depending on flags, so matching it would refuse correct
 * pins for cosmetic reasons. A `@cert-authority` or `@revoked` marker is refused
 * outright rather than half-understood.
 */
import { createHash } from "node:crypto";
import ssh2 from "ssh2";
import { ConfigError } from "./errors.js";

const { utils } = ssh2;

/** Key types a host may present, and the algorithm names ssh2 negotiates for each. */
const HOST_KEY_ALGORITHMS: Record<string, readonly string[]> = {
  "ssh-ed25519": ["ssh-ed25519"],
  "ecdsa-sha2-nistp256": ["ecdsa-sha2-nistp256"],
  "ecdsa-sha2-nistp384": ["ecdsa-sha2-nistp384"],
  "ecdsa-sha2-nistp521": ["ecdsa-sha2-nistp521"],
  // One RSA key, three signature algorithms. The SHA-2 ones first: OpenSSH
  // has refused `ssh-rsa` (SHA-1) signatures by default since 8.8.
  "ssh-rsa": ["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"],
};

export type HostKeyPin =
  | { kind: "key"; type: string; blob: Buffer; fingerprint: string }
  | { kind: "fingerprint"; fingerprint: string };

/** OpenSSH's fingerprint form: `SHA256:` + unpadded base64 of the key blob's digest. */
export function fingerprintOf(blob: Buffer): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

/** The algorithm name encoded at the head of an SSH public-key blob. */
export function blobType(blob: Buffer): string | null {
  if (blob.length < 4) return null;
  const len = blob.readUInt32BE(0);
  if (len === 0 || len > 64 || blob.length < 4 + len) return null;
  return blob.subarray(4, 4 + len).toString("ascii");
}

function invalid(envName: string, line: number, why: string): Error {
  // The pin is a PUBLIC key, so quoting the line number is all the context
  // needed and nothing secret is near this message.
  return new ConfigError(`${envName} line ${line}: ${why}`);
}

/** Every pin in `raw`, or an error naming the first line that is not one. */
export function parseHostKeyPins(
  raw: string,
  envName = "SSH_HOST_KEY",
): HostKeyPin[] {
  const pins: HostKeyPin[] = [];
  // A single-line field may carry `\n` literally; a pin never contains a
  // backslash, so this cannot corrupt one.
  const lines = raw.split("\\n").join("\n").split(/\r?\n/);
  lines.forEach((text, i) => {
    const line = text.trim();
    if (line === "" || line.startsWith("#")) return;
    const n = i + 1;
    if (line.startsWith("@")) {
      throw invalid(
        envName,
        n,
        `markers such as @cert-authority and @revoked are not supported. Pin the ` +
          `host's own key.`,
      );
    }
    const tokens = line.split(/\s+/);

    const fp = tokens.find((t) => t.startsWith("SHA256:"));
    if (fp && tokens.length === 1) {
      const body = fp.slice("SHA256:".length).replace(/=+$/, "");
      if (!/^[A-Za-z0-9+/]{43}$/.test(body)) {
        throw invalid(envName, n, `"${fp}" is not a SHA256 fingerprint.`);
      }
      pins.push({ kind: "fingerprint", fingerprint: `SHA256:${body}` });
      return;
    }

    const at = tokens.findIndex((t) => t in HOST_KEY_ALGORITHMS);
    if (at === -1 || at + 1 >= tokens.length) {
      throw invalid(
        envName,
        n,
        `expected a public key ("ssh-ed25519 AAAA…", optionally after a host ` +
          `field) or a "SHA256:…" fingerprint. Supported key types: ` +
          `${Object.keys(HOST_KEY_ALGORITHMS).join(", ")}.`,
      );
    }
    const type = tokens[at]!;
    const b64 = tokens[at + 1]!;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
      throw invalid(envName, n, `the key after "${type}" is not base64.`);
    }
    const blob = Buffer.from(b64, "base64");
    // A full parse, not just the type header: a key cut short by a paste still
    // starts with the right type and would otherwise pin something no host has.
    const parsed = utils.parseKey(`${type} ${b64}`);
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    if (
      blobType(blob) !== type ||
      key instanceof Error ||
      !key ||
      key.type !== type
    ) {
      throw invalid(
        envName,
        n,
        `the key data does not encode a ${type} key — the line is truncated or ` +
          `the type does not match the key.`,
      );
    }
    pins.push({ kind: "key", type, blob, fingerprint: fingerprintOf(blob) });
  });

  if (pins.length === 0) {
    throw new ConfigError(
      `${envName} holds no host key. Paste the host's key line from ` +
        `\`ssh-keyscan -p <port> <host>\`, verified out of band.`,
    );
  }
  return pins;
}

/** True when the key the server presented is one of the pins. */
export function matchesPin(
  pins: readonly HostKeyPin[],
  presented: Buffer,
): boolean {
  const fingerprint = fingerprintOf(presented);
  return pins.some((pin) =>
    pin.kind === "key"
      ? pin.blob.equals(presented)
      : pin.fingerprint === fingerprint,
  );
}

/**
 * The host-key algorithms to offer, or undefined for ssh2's default list.
 *
 * When every pin is a full key, negotiation is narrowed to those key types, so a
 * host that has an RSA and an Ed25519 key presents the one we pinned instead of
 * whichever it prefers — otherwise pinning the "wrong" one of two genuine keys
 * would look exactly like an impostor. A fingerprint does not say its type, so a
 * pin set holding one leaves the list alone.
 */
export function hostKeyAlgorithms(
  pins: readonly HostKeyPin[],
): string[] | undefined {
  if (pins.some((p) => p.kind === "fingerprint")) return undefined;
  const out: string[] = [];
  for (const pin of pins) {
    if (pin.kind !== "key") continue;
    for (const alg of HOST_KEY_ALGORITHMS[pin.type] ?? []) {
      if (!out.includes(alg)) out.push(alg);
    }
  }
  return out;
}

/** The pins, as connection info reports them. Public material only. */
export function describePins(
  pins: readonly HostKeyPin[],
): Array<{ type: string | null; fingerprint: string }> {
  return pins.map((p) => ({
    type: p.kind === "key" ? p.type : null,
    fingerprint: p.fingerprint,
  }));
}
