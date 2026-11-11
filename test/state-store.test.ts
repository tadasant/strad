import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  Lease,
  MemoryBlobStore,
  missingStateStoreEnv,
  namespacePrefix,
  open,
  parseStateKey,
  readStateStoreEnv,
  seal,
  SealError,
  StateStoreConfigError,
  type SealFormat,
} from "../src/state/store.ts";

/**
 * strad's shared state store (`src/state/store.ts`), at its source. Each
 * consumer's suite drives its vendored copy through that consumer's own
 * rules — `servers/whatsapp/shared/test/units.test.ts` and
 * `servers/bundle-api/fork/slack/test/events-config.test.ts` — and `test/vendored.sync.test.ts` keeps the
 * copies byte-identical to this one.
 */

const PEM = "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----";
const SHARED = {
  STRAD_STATE_GCS_BUCKET: "strad-state",
  STRAD_STATE_GCS_CLIENT_EMAIL: "state@example.iam.gserviceaccount.com",
  STRAD_STATE_GCS_PRIVATE_KEY: PEM,
};
const LEGACY = {
  bucket: "OLD_BUCKET",
  clientEmail: "OLD_EMAIL",
  privateKey: "OLD_KEY",
};

describe("where the store is", () => {
  it("reads the three shared names, and names the missing ones by them", () => {
    expect(missingStateStoreEnv({})).toEqual([
      "STRAD_STATE_GCS_BUCKET",
      "STRAD_STATE_GCS_CLIENT_EMAIL",
      "STRAD_STATE_GCS_PRIVATE_KEY",
    ]);
    const where = readStateStoreEnv(SHARED);
    expect(where.bucket).toBe("strad-state");
    expect(where.privateKey).toContain("\nabc\n");
    expect(() => readStateStoreEnv({})).toThrow(StateStoreConfigError);
  });

  it("falls back to a consumer's legacy names, field by field", () => {
    const env = {
      OLD_BUCKET: "old",
      OLD_EMAIL: "old@example.iam.gserviceaccount.com",
      OLD_KEY: PEM,
    };
    expect(missingStateStoreEnv(env, LEGACY)).toEqual([]);
    expect(readStateStoreEnv(env, LEGACY).bucket).toBe("old");
    const mixed = readStateStoreEnv(
      { ...env, STRAD_STATE_GCS_CLIENT_EMAIL: "new@example.com" },
      LEGACY,
    );
    expect(mixed.clientEmail).toBe("new@example.com");
    expect(mixed.bucket).toBe("old");
  });

  it("refuses two buckets rather than choosing one", () => {
    expect(() =>
      readStateStoreEnv({ ...SHARED, OLD_BUCKET: "old" }, LEGACY),
    ).toThrow(/two buckets/);
    expect(
      readStateStoreEnv({ ...SHARED, OLD_BUCKET: "strad-state" }, LEGACY)
        .bucket,
    ).toBe("strad-state");
  });
});

describe("a consumer's namespace", () => {
  const rule = { variable: "X_STATE_PREFIX", root: "x" };

  it("defaults to the root, and allows any folder under it", () => {
    expect(namespacePrefix({}, rule)).toBe("x");
    expect(namespacePrefix({ X_STATE_PREFIX: "/x/prod/" }, rule)).toBe(
      "x/prod",
    );
  });

  it("refuses everything outside the root, the bucket root included", () => {
    for (const outside of ["/", "y", "xy", "xy/prod", "y/x", "../x"]) {
      expect(
        () => namespacePrefix({ X_STATE_PREFIX: outside }, rule),
        outside,
      ).toThrow(/outside this server's folder/);
    }
  });

  it("reads a legacy variable, and refuses one that disagrees", () => {
    const legacy = { ...rule, legacyVariable: "X_OLD_PREFIX" };
    expect(namespacePrefix({ X_OLD_PREFIX: "x/prod" }, legacy)).toBe("x/prod");
    expect(
      namespacePrefix(
        { X_OLD_PREFIX: "x/prod", X_STATE_PREFIX: "/x/prod/" },
        legacy,
      ),
    ).toBe("x/prod");
    expect(() =>
      namespacePrefix(
        { X_OLD_PREFIX: "x/prod", X_STATE_PREFIX: "x/other" },
        legacy,
      ),
    ).toThrow(/two folders/);
  });

  it("parses a 32-byte key in three spellings and never quotes a bad one", () => {
    const raw = randomBytes(32);
    for (const form of ["base64", "base64url", "hex"] as const) {
      expect(parseStateKey(raw.toString(form), "K").equals(raw)).toBe(true);
    }
    const short = randomBytes(16).toString("base64");
    expect(() => parseStateKey(short, "K")).toThrow(/K must be exactly 32/);
    try {
      parseStateKey(short, "K");
    } catch (err) {
      expect((err as Error).message).not.toContain(short);
    }
  });
});

describe("the seal", () => {
  const A: SealFormat = {
    magic: "AAA1",
    what: "an A object",
    keyVariable: "A_KEY",
    recovery: "Do the A thing.",
  };
  const B: SealFormat = { ...A, magic: "BBB1", what: "a B object" };

  it("binds an object to its name, its key and its consumer", () => {
    const key = randomBytes(32);
    const sealed = seal(key, "a/x.bin", Buffer.from("plain"), A);
    expect(sealed.includes(Buffer.from("plain"))).toBe(false);
    expect(open(key, "a/x.bin", sealed, A).toString()).toBe("plain");
    expect(() => open(key, "a/y.bin", sealed, A)).toThrow(
      /does not open with A_KEY.*Do the A thing\./,
    );
    expect(() => open(randomBytes(32), "a/x.bin", sealed, A)).toThrow(
      SealError,
    );
    // Same key, same name, another consumer: not even parsed.
    expect(() => open(key, "a/x.bin", sealed, B)).toThrow(/is not a B object/);
    expect(() => open(key, "a/x.bin", Buffer.from("AAA1"), A)).toThrow(
      SealError,
    );
  });
});

describe("the lease", () => {
  it("makes the newest claimant the owner, and the old one superseded", async () => {
    const blobs = new MemoryBlobStore();
    let now = 0;
    const clock = () => now;
    const a = new Lease(blobs, "x/lease.json", { clock });
    const b = new Lease(blobs, "x/lease.json", { clock });
    await a.claim();
    await b.claim();
    expect(await a.check()).toBe(true); // inside the interval: no read
    now += 30_000;
    expect(await a.check()).toBe(false);
    expect(a.superseded).toBe(true);
    expect(a.view.owner).toBe(b.instanceId);
    expect(await b.check(true)).toBe(true);
  });

  it("heartbeats by default, and a superseded process reclaims only a stale lease", async () => {
    const blobs = new MemoryBlobStore();
    let now = 1_000;
    const clock = () => now;
    const a = new Lease(blobs, "x/lease.json", { clock });
    const b = new Lease(blobs, "x/lease.json", { clock });
    await a.claim();
    await b.claim();
    expect(await a.check(true)).toBe(false);
    now += 60_000;
    expect(await b.check(true)).toBe(true); // b's heartbeat
    expect(await a.reclaimIfStale(90_000)).toBe(false);
    now += 120_000; // b went quiet
    expect(await a.reclaimIfStale(90_000)).toBe(true);
    expect(a.superseded).toBe(false);
    expect(await b.check(true)).toBe(false);
  });

  it("with heartbeat off, a check is a read and writes nothing", async () => {
    const blobs = new MemoryBlobStore();
    const lease = new Lease(blobs, "x/lease.json", { heartbeat: false });
    await lease.claim();
    const writes = blobs.writes;
    expect(await lease.check(true)).toBe(true);
    expect(blobs.writes).toBe(writes);
  });

  it("reads a lease written in the pre-heartbeat shape", async () => {
    const blobs = new MemoryBlobStore();
    await blobs.write(
      "x/lease.json",
      Buffer.from(JSON.stringify({ owner: "someone", claimed_at: 0 })),
    );
    const lease = new Lease(blobs, "x/lease.json", { clock: () => 10 });
    expect(await lease.check(true)).toBe(false);
    expect(await lease.reclaimIfStale(5)).toBe(true);
  });
});
