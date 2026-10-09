import { generateKeyPairSync, createVerify } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, missingCredentials, parseEncryptionKey } from "../src/config.js";
import { ApitureClient } from "../src/apiture.js";
import { loginError } from "../src/cognito.js";
import { open, seal, SealError } from "../src/crypto.js";
import { DeviceStore } from "../src/device-store.js";
import { deriveDownloadKey, mintDownloadToken, verifyDownloadToken } from "../src/download-link.js";
import { GcsBlobStore, MemoryBlobStore } from "../src/gcs.js";
import { redact, registerSecret } from "../src/logging.js";
import { normalizeStatement, resolveRange, statementFilename } from "../src/statements.js";
import { listen, type Listening } from "./fakes.js";

const KEY = Buffer.alloc(32, 9).toString("base64");

const fullEnv = (): NodeJS.ProcessEnv => ({
  LIVEOAK_USERNAME: "me@example.com",
  LIVEOAK_PASSWORD: "pass word ",
  LIVEOAK_STATE_ENCRYPTION_KEY: KEY,
  LIVEOAK_GCS_BUCKET: "bucket",
  LIVEOAK_GCS_CLIENT_EMAIL: "sa@p.iam.gserviceaccount.com",
  LIVEOAK_GCS_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
});

describe("config", () => {
  it("names what is missing, in order", () => {
    expect(missingCredentials({ LIVEOAK_USERNAME: "x", LIVEOAK_PASSWORD: "  " })).toEqual([
      "LIVEOAK_PASSWORD",
      "LIVEOAK_STATE_ENCRYPTION_KEY",
      "LIVEOAK_GCS_BUCKET",
      "LIVEOAK_GCS_CLIENT_EMAIL",
      "LIVEOAK_GCS_PRIVATE_KEY",
    ]);
  });

  it("keeps the password exactly as set, unescapes the PEM, and defaults the prefix", () => {
    const c = loadConfig(fullEnv());
    expect(c.password).toBe("pass word ");
    expect(c.privateKey).toContain("\nabc\n");
    expect(c.prefix).toBe("liveoak");
    expect(c.downloadLink).toBeUndefined();
    expect(c.downloadUnavailable).toContain("STRAD_PUBLIC_URL");
  });

  it("builds a download link config from the three variables", () => {
    const c = loadConfig({
      ...fullEnv(),
      STRAD_PUBLIC_URL: "https://strad.example.com/",
      STRAD_INTERNAL_TOKEN: "t",
      LIVEOAK_PUBLIC_SLUG: "liveoak-tadas",
    });
    expect(c.downloadLink).toEqual({
      publicBaseUrl: "https://strad.example.com",
      internalToken: "t",
      publicSlug: "liveoak-tadas",
    });
  });

  it("refuses a short key without quoting it", () => {
    expect(() => parseEncryptionKey("c2hvcnQ=")).toThrow(/exactly 32 bytes/);
    try {
      parseEncryptionKey("c2hvcnQ=");
    } catch (e) {
      expect((e as Error).message).not.toContain("c2hvcnQ=");
    }
    expect(parseEncryptionKey("ab".repeat(32))).toHaveLength(32);
  });

  it("the not-configured error never quotes a value", () => {
    const env = fullEnv();
    delete env.LIVEOAK_GCS_BUCKET;
    expect(() => loadConfig(env)).toThrow(/LIVEOAK_GCS_BUCKET is not set/);
    try {
      loadConfig(env);
    } catch (e) {
      expect((e as Error).message).not.toContain("pass word");
    }
  });
});

describe("sealing", () => {
  const key = Buffer.alloc(32, 1);

  it("opens only under the name it was sealed to", () => {
    const sealed = seal(key, "liveoak/device.sealed", Buffer.from("x"));
    expect(open(key, "liveoak/device.sealed", sealed).toString()).toBe("x");
    expect(() => open(key, "other/device.sealed", sealed)).toThrow(SealError);
    expect(() => open(Buffer.alloc(32, 2), "liveoak/device.sealed", sealed)).toThrow(SealError);
  });

  it("the device store round-trips, and a half-written state reads as none", async () => {
    const blobs = new MemoryBlobStore();
    const store = new DeviceStore(blobs, key, "p");
    expect(await store.load()).toBeNull();
    const state = {
      userIdForSrp: "u",
      deviceKey: "us-east-1_d",
      deviceGroupKey: "-g",
      devicePassword: "pw",
      enrolledAt: "2026-10-09T00:00:00.000Z",
    };
    await store.save(state);
    expect(await store.load()).toEqual(state);
    await blobs.write("p/device.sealed", seal(key, "p/device.sealed", Buffer.from(JSON.stringify({ ...state, deviceKey: "" }))));
    expect(await store.load()).toBeNull();
    await store.clear();
    expect(blobs.objects.size).toBe(0);
  });
});

describe("redact", () => {
  it("removes a registered password wherever it appears, and token-shaped runs", () => {
    registerSecret("s3cret-pw");
    expect(redact("user s3cret-pw failed; again s3cret-pw")).toBe("user [redacted] failed; again [redacted]");
    expect(redact(`Bearer ${"a".repeat(30)}.${"b".repeat(30)}`)).toBe("Bearer [redacted]");
    // Too short to be worth scrubbing: refused rather than destroying every message.
    registerSecret("ab");
    expect(redact("about")).toBe("about");
  });
});

describe("download tokens", () => {
  const key = deriveDownloadKey("internal", "liveoak-tadas", "Me@Example.com");

  it("verifies, expires, and binds to the slug and the account", () => {
    const now = Date.parse("2026-10-09T12:00:00Z");
    const minted = mintDownloadToken(key, "stmt-1", now);
    expect(verifyDownloadToken(key, minted.token, now)).toMatchObject({ ok: true, statementId: "stmt-1" });
    expect(verifyDownloadToken(key, minted.token, now + 16 * 60_000)).toMatchObject({ ok: false, status: 410 });
    expect(deriveDownloadKey("internal", "liveoak-tadas", "me@example.com").equals(key)).toBe(true);
    for (const other of [
      deriveDownloadKey("internal", "liveoak-other", "me@example.com"),
      deriveDownloadKey("internal", "liveoak-tadas", "someone@example.com"),
      deriveDownloadKey("rotated", "liveoak-tadas", "me@example.com"),
    ]) {
      expect(verifyDownloadToken(other, minted.token, now)).toMatchObject({ ok: false, status: 403 });
    }
  });

  it("is opaque: the statement id does not appear in the token", () => {
    const minted = mintDownloadToken(key, "stmt-very-identifiable");
    expect(minted.token).not.toContain("stmt");
    expect(Buffer.from(minted.token, "base64url").toString("latin1")).not.toContain("stmt");
  });
});

describe("statements", () => {
  const now = new Date("2026-10-09T12:00:00Z");

  it("a range becomes the portal's startOn + period, with a month of slack", () => {
    expect(resolveRange("2026-09-01", "2026-09-30", now)).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
      startOn: "2026-09-01T00:00:00.000Z",
      period: "P2M",
    });
    expect(resolveRange("2026-09-15", undefined, now).startOn).toBe("2026-09-01T00:00:00.000Z");
    expect(resolveRange(undefined, undefined, now)).toMatchObject({ from: "2025-10-01", to: "2026-10-09", period: "P14M" });
  });

  it("refuses bad dates, inverted ranges and spans over seven years", () => {
    expect(() => resolveRange("2026/09/01", undefined, now)).toThrow(/YYYY-MM-DD/);
    expect(() => resolveRange("2026-09-30", "2026-09-01", now)).toThrow(/after/);
    expect(() => resolveRange("2010-01-01", "2026-09-01", now)).toThrow(/at most 84/);
  });

  it("normalizes a document defensively, and masks the account to four digits", () => {
    expect(
      normalizeStatement({
        _id: "abc",
        endOn: "2026-09-30T00:00:00.000Z",
        name: "Savings Statement",
        accounts: [{ accountNumbers: { masked: "*****9876" }, name: "Savings" }],
        _links: {},
      }),
    ).toEqual({
      statement_id: "abc",
      end_on: "2026-09-30",
      name: "Savings Statement",
      account: "*9876",
      account_name: "Savings",
    });
    expect(normalizeStatement({ name: "no id" })).toBeNull();
    expect(statementFilename({ statement_id: "x", end_on: "2026-09-30", account: "*9876" }, "application/pdf")).toBe(
      "liveoak-statement-2026-09-30-9876.pdf",
    );
    expect(statementFilename({ statement_id: "x" }, "application/pdf")).toBe("liveoak-statement.pdf");
  });
});

describe("GcsBlobStore", () => {
  let gcs: Listening | undefined;
  afterEach(async () => {
    await gcs?.close();
  });

  it("signs a service-account JWT, then reads, writes and deletes one object", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const objects = new Map<string, Buffer>();
    const seen: string[] = [];
    gcs = await listen((req, res, body) => {
      const url = new URL(req.url ?? "/", "http://x");
      seen.push(`${req.method} ${url.pathname}`);
      if (url.pathname === "/token") {
        const assertion = new URLSearchParams(body.toString()).get("assertion")!;
        const [h, p, sig] = assertion.split(".");
        const valid = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, sig!, "base64url");
        const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
        if (!valid || claims.iss !== "sa@example.com") {
          res.statusCode = 401;
          return void res.end("{}");
        }
        res.setHeader("content-type", "application/json");
        return void res.end(JSON.stringify({ access_token: "gcs-token", expires_in: 3600 }));
      }
      if (req.headers.authorization !== "Bearer gcs-token") {
        res.statusCode = 401;
        return void res.end();
      }
      const m = /^\/storage\/v1\/b\/bkt\/o\/(.+)$/.exec(url.pathname);
      if (url.pathname === "/upload/storage/v1/b/bkt/o" && req.method === "POST") {
        objects.set(url.searchParams.get("name")!, body);
        return void res.end("{}");
      }
      if (m && req.method === "GET") {
        const o = objects.get(decodeURIComponent(m[1]!));
        res.statusCode = o ? 200 : 404;
        return void res.end(o ?? "");
      }
      if (m && req.method === "DELETE") {
        res.statusCode = objects.delete(decodeURIComponent(m[1]!)) ? 204 : 404;
        return void res.end();
      }
      res.statusCode = 400;
      res.end();
    });
    const store = new GcsBlobStore({
      bucket: "bkt",
      clientEmail: "sa@example.com",
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      apiEndpoint: gcs.url,
      tokenUrl: `${gcs.url}/token`,
    });
    expect(await store.read("liveoak/device.sealed")).toBeNull();
    await store.write("liveoak/device.sealed", Buffer.from("sealed-bytes"));
    expect((await store.read("liveoak/device.sealed"))!.toString()).toBe("sealed-bytes");
    await store.delete("liveoak/device.sealed");
    await store.delete("liveoak/device.sealed");
    expect(await store.read("liveoak/device.sealed")).toBeNull();
    // One token, reused.
    expect(seen.filter((s) => s.endsWith("/token"))).toHaveLength(1);
  });
});

describe("ApitureClient guards", () => {
  let api: Listening | undefined;
  afterEach(async () => {
    await api?.close();
  });

  it("refuses a `next` page on another origin rather than send it the token", async () => {
    const seen: (string | undefined)[] = [];
    api = await listen((req, res) => {
      seen.push(req.headers.authorization);
      res.setHeader("content-type", "application/hal+json");
      res.end(
        JSON.stringify({
          _embedded: { items: [{ _id: "a" }] },
          _links: { next: { href: "https://elsewhere.example.com/documents/documents?page=2" } },
        }),
      );
    });
    const client = new ApitureClient({ apiRoot: api.url });
    await expect(client.listStatements("tok", "2026-01-01T00:00:00.000Z", "P2M")).rejects.toThrow(
      /another origin/,
    );
    expect(seen).toEqual(["Bearer tok"]);
  });

  it("follows a non-https document link only when the API itself is on loopback", async () => {
    const client = new ApitureClient({ apiRoot: "https://api.example.com" });
    await expect(
      client.fetchContent("tok", { _id: "a", _links: { "apiture:document": { href: "http://127.0.0.1:1/x" } } }),
    ).rejects.toThrow(/not https/);
  });
});

describe("login errors", () => {
  it("an expired challenge session is not reported as a bad password", () => {
    const expired = loginError({ code: "NotAuthorizedException", message: "Invalid session for the user, session is expired." });
    expect(expired.message).toContain("Call enrol_device for a new code");
    expect(expired.message).not.toContain("LIVEOAK_PASSWORD");
    const bad = loginError({ code: "NotAuthorizedException", message: "Incorrect username or password." });
    expect(bad.message).toContain("LIVEOAK_PASSWORD");
  });
});
