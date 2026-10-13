import { describe, expect, it } from "vitest";
import {
  ConfigError,
  fingerprintOf,
  hostKeyAlgorithms,
  loadConfig,
  matchesPin,
  missingCredentials,
  normalisePrivateKey,
  parseHostKeyPins,
  parseHint,
  parseToolGroups,
  redact,
  shellQuote,
} from "../src/index.js";
import { keyPair } from "./fake-host.js";

const host = keyPair("ed25519");
const hostRsa = keyPair("rsa");
const client = keyPair("ed25519");

function blobOf(pub: string): Buffer {
  return Buffer.from(pub.trim().split(/\s+/)[1]!, "base64");
}

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    SSH_HOST: "203.0.113.7",
    SSH_USERNAME: "runner",
    SSH_PRIVATE_KEY: client.private,
    SSH_HOST_KEY: host.public,
    ...overrides,
  };
}

describe("missingCredentials", () => {
  it("names every absent required value, host key included", () => {
    expect(missingCredentials({})).toEqual([
      "SSH_HOST",
      "SSH_USERNAME",
      "SSH_PRIVATE_KEY",
      "SSH_HOST_KEY",
    ]);
  });

  it("treats whitespace as absent", () => {
    expect(missingCredentials(env({ SSH_HOST_KEY: "  " }))).toEqual(["SSH_HOST_KEY"]);
  });

  it("does not require the optional values", () => {
    expect(missingCredentials(env())).toEqual([]);
  });
});

describe("loadConfig", () => {
  it("refuses to build a config with no pinned host key", () => {
    expect(() => loadConfig(env({ SSH_HOST_KEY: undefined }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ SSH_HOST_KEY: undefined }))).toThrow(/SSH_HOST_KEY is not set/);
  });

  it("names all missing values in one error, with where to seed them", () => {
    try {
      loadConfig({});
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/SSH_HOST, SSH_USERNAME, SSH_PRIVATE_KEY, SSH_HOST_KEY are not set/);
      expect((err as Error).message).toMatch(/static\/<NAME>/);
    }
  });

  it("defaults the port to 22 and validates an explicit one", () => {
    expect(loadConfig(env()).port).toBe(22);
    expect(loadConfig(env({ SSH_PORT: "2222" })).port).toBe(2222);
    expect(() => loadConfig(env({ SSH_PORT: "70000" }))).toThrow(/SSH_PORT/);
    expect(() => loadConfig(env({ SSH_PORT: "ssh" }))).toThrow(/SSH_PORT/);
  });

  it("reports the key's type and never needs the agent", () => {
    const c = loadConfig(env({ SSH_AUTH_SOCK: "/tmp/agent.sock" }));
    expect(c.keyType).toBe("ssh-ed25519");
    expect(JSON.stringify(c)).not.toContain("agent.sock");
  });

  it("refuses a public key where the private key belongs", () => {
    expect(() => loadConfig(env({ SSH_PRIVATE_KEY: client.public }))).toThrow(ConfigError);
  });

  it("refuses garbage as a key without echoing it", () => {
    try {
      loadConfig(env({ SSH_PRIVATE_KEY: "-----BEGIN OPENSSH PRIVATE KEY-----\nnotakey\n-----END OPENSSH PRIVATE KEY-----" }));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).not.toContain("notakey");
    }
  });

  it("refuses an encrypted key with no passphrase, and accepts it with one", () => {
    const enc = keyPair("ed25519", "correct horse");
    expect(() => loadConfig(env({ SSH_PRIVATE_KEY: enc.private }))).toThrow(/SSH_PASSPHRASE/);
    const c = loadConfig(env({ SSH_PRIVATE_KEY: enc.private, SSH_PASSPHRASE: "correct horse" }));
    expect(c.passphrase).toBe("correct horse");
  });

  it("validates timeouts", () => {
    expect(loadConfig(env({ SSH_TIMEOUT: "5000" })).connectTimeoutMs).toBe(5000);
    expect(() => loadConfig(env({ SSH_COMMAND_TIMEOUT: "10" }))).toThrow(/SSH_COMMAND_TIMEOUT/);
  });
});

describe("normalisePrivateKey", () => {
  it("restores newlines pasted as literal \\n", () => {
    const flat = client.private.trim().split("\n").join("\\n");
    expect(normalisePrivateKey(flat)).toBe(client.private.trim() + "\n");
    expect(() => loadConfig(env({ SSH_PRIVATE_KEY: flat }))).not.toThrow();
  });

  it("decodes a key pasted as base64", () => {
    const b64 = Buffer.from(client.private).toString("base64");
    expect(normalisePrivateKey(b64)).toBe(client.private.trim() + "\n");
  });
});

describe("parseHostKeyPins", () => {
  it("reads an ssh-keyscan line with a [host]:port field", () => {
    const line = `[zimmer.example]:2222 ${host.public.trim()}`;
    const [pin] = parseHostKeyPins(line);
    expect(pin).toMatchObject({ kind: "key", type: "ssh-ed25519" });
    expect(pin!.fingerprint).toBe(fingerprintOf(blobOf(host.public)));
  });

  it("reads a bare public key with a comment", () => {
    expect(parseHostKeyPins(`${host.public.trim()} root@box`)).toHaveLength(1);
  });

  it("reads several lines, skipping blanks and comments, and literal \\n separators", () => {
    const text = `# keyscan\n${host.public.trim()}\n\n${hostRsa.public.trim()}`;
    expect(parseHostKeyPins(text)).toHaveLength(2);
    expect(parseHostKeyPins(text.split("\n").join("\\n"))).toHaveLength(2);
  });

  it("reads a SHA256 fingerprint", () => {
    const fp = fingerprintOf(blobOf(host.public));
    expect(parseHostKeyPins(fp)).toEqual([{ kind: "fingerprint", fingerprint: fp }]);
  });

  it("refuses markers, unknown types, mismatched and truncated keys, and nothing at all", () => {
    expect(() => parseHostKeyPins(`@cert-authority * ${host.public}`)).toThrow(/not supported/);
    expect(() => parseHostKeyPins("ssh-dss AAAAB3NzaC1kc3M=")).toThrow(/Supported key types/);
    const blob = host.public.trim().split(/\s+/)[1]!;
    expect(() => parseHostKeyPins(`ssh-rsa ${blob}`)).toThrow(/does not encode a ssh-rsa/);
    expect(() => parseHostKeyPins(`ssh-ed25519 ${blob.slice(0, 20)}`)).toThrow(ConfigError);
    expect(() => parseHostKeyPins("SHA256:short")).toThrow(/not a SHA256 fingerprint/);
    expect(() => parseHostKeyPins("# only a comment\n")).toThrow(/holds no host key/);
  });
});

describe("matchesPin and hostKeyAlgorithms", () => {
  it("matches the pinned key and nothing else", () => {
    const pins = parseHostKeyPins(host.public);
    expect(matchesPin(pins, blobOf(host.public))).toBe(true);
    expect(matchesPin(pins, blobOf(hostRsa.public))).toBe(false);
  });

  it("matches by fingerprint", () => {
    const pins = parseHostKeyPins(fingerprintOf(blobOf(hostRsa.public)));
    expect(matchesPin(pins, blobOf(hostRsa.public))).toBe(true);
    expect(matchesPin(pins, blobOf(host.public))).toBe(false);
  });

  it("narrows negotiation to the pinned types, SHA-2 RSA first", () => {
    expect(hostKeyAlgorithms(parseHostKeyPins(host.public))).toEqual(["ssh-ed25519"]);
    expect(hostKeyAlgorithms(parseHostKeyPins(hostRsa.public))).toEqual([
      "rsa-sha2-512",
      "rsa-sha2-256",
      "ssh-rsa",
    ]);
    expect(
      hostKeyAlgorithms(parseHostKeyPins(`${host.public}\n${fingerprintOf(blobOf(hostRsa.public))}`)),
    ).toBeUndefined();
  });
});

describe("redact", () => {
  it("removes any key block and the literal secrets", () => {
    const text = `boom ${client.private} and pass=hunter22 end`;
    const out = redact(text, ["hunter22"]);
    expect(out).not.toContain("PRIVATE KEY");
    expect(out).not.toContain("hunter22");
    expect(out).toContain("boom");
  });
});

describe("parseToolGroups", () => {
  it("is everything when unset and fails closed to readonly on garbage", () => {
    expect(parseToolGroups(undefined)).toEqual(["readonly", "write", "admin"]);
    expect(parseToolGroups("readonly,write")).toEqual(["readonly", "write"]);
    expect(parseToolGroups("admn")).toEqual(["readonly"]);
  });
});

describe("shellQuote", () => {
  it("keeps a path one word whatever it holds", () => {
    expect(shellQuote("/srv/it's here")).toBe(`'/srv/it'\\''s here'`);
  });
});

describe("parseHint", () => {
  it("is one plain line, capped, or nothing", () => {
    expect(parseHint(undefined)).toBeUndefined();
    expect(parseHint("  \n\t ")).toBeUndefined();
    expect(parseHint("Spun down.\r\nUse the workflow.")).toBe("Spun down. Use the workflow.");
    expect(parseHint("a\u202ebc\u2028d\u0085e")).toBe("a bc d e");
    expect(() => loadConfig(env({ SSH_TIMEOUT: "600000" }))).toThrow(/between 1000 and 120000/);
    const long = parseHint("x".repeat(900))!;
    expect(long.length).toBe(500);
    expect(long.endsWith("…")).toBe(true);
  });
});
