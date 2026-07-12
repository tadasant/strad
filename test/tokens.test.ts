import { describe, expect, it } from "vitest";
import {
  EnvTokenStore,
  mintToken,
  parseToken,
  verifyToken,
} from "../src/auth/tokens.ts";

describe("mintToken", () => {
  it("produces strad_<env>_<pubid>_<secret>", () => {
    const { plaintext, record } = mintToken({
      env: "staging",
      label: "probe",
      roles: ["admin"],
    });
    const parts = plaintext.split("_");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("strad");
    expect(parts[1]).toBe("staging");
    expect(parts[2]).toBe(record.pubid);
  });

  it("never stores the plaintext", () => {
    const { plaintext, record } = mintToken({
      env: "staging",
      label: "probe",
      roles: ["admin"],
    });
    expect(JSON.stringify(record)).not.toContain(plaintext.split("_")[3]);
    expect(record.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is unique per mint", () => {
    const a = mintToken({ env: "s", label: "a", roles: [] });
    const b = mintToken({ env: "s", label: "b", roles: [] });
    expect(a.plaintext).not.toBe(b.plaintext);
  });
});

describe("parseToken", () => {
  it("rejects a foreign prefix", () => {
    expect(parseToken("nope_staging_abc_secret")).toBeNull();
  });
  it("rejects the wrong segment count", () => {
    expect(parseToken("strad_staging_abc")).toBeNull();
  });
});

describe("verifyToken", () => {
  const minted = mintToken({
    env: "staging",
    label: "probe",
    roles: ["admin"],
  });
  const store = new EnvTokenStore(JSON.stringify([minted.record]));

  it("accepts the real token", async () => {
    const v = await verifyToken(minted.plaintext, store, "staging");
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error("unreachable");
    expect(v.record.roles).toEqual(["admin"]);
  });

  it("rejects a tampered secret", async () => {
    const tampered = `${minted.plaintext.slice(0, -1)}${
      minted.plaintext.endsWith("A") ? "B" : "A"
    }`;
    const v = await verifyToken(tampered, store, "staging");
    expect(v).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects an unknown pubid", async () => {
    const other = mintToken({ env: "staging", label: "x", roles: [] });
    const v = await verifyToken(other.plaintext, store, "staging");
    expect(v).toEqual({ ok: false, reason: "unknown" });
  });

  it("rejects a token minted for another environment", async () => {
    // A staging token must not open prod, even if the record somehow exists.
    const v = await verifyToken(minted.plaintext, store, "prod");
    expect(v).toEqual({ ok: false, reason: "wrong_env" });
  });

  it("honours soft revocation", async () => {
    const revoked = new EnvTokenStore(
      JSON.stringify([
        { ...minted.record, revokedAt: new Date().toISOString() },
      ]),
    );
    const v = await verifyToken(minted.plaintext, revoked, "staging");
    expect(v).toEqual({ ok: false, reason: "revoked" });
  });

  it("rejects everything when the store is empty", async () => {
    const empty = new EnvTokenStore(undefined);
    const v = await verifyToken(minted.plaintext, empty, "staging");
    expect(v).toEqual({ ok: false, reason: "unknown" });
  });
});
