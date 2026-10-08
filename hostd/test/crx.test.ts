import { createHash, createPublicKey, createVerify } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  extensionIdFor,
  extensionVersion,
  listExtensionFiles,
  loadOrCreateSigningKey,
  packExtension,
  updateManifestXml,
  zipDirectory,
} from "../src/extension/crx.js";
import { extensionDir } from "../src/extension/paths.js";
import { renderMobileconfig } from "../src/extension/policy.js";

const state = () => mkdtempSync(join(tmpdir(), "hostd-crx-"));

/** Read a CRX3 back the way Chrome does, far enough to check the signature. */
function unpackCrx(crx: Buffer) {
  expect(crx.subarray(0, 4).toString("latin1")).toBe("Cr24");
  expect(crx.readUInt32LE(4)).toBe(3);
  const headerLen = crx.readUInt32LE(8);
  const header = crx.subarray(12, 12 + headerLen);
  const zip = crx.subarray(12 + headerLen);
  // A minimal protobuf walk: every field here is length-delimited.
  const fields = (buf: Buffer) => {
    const out: { number: number; bytes: Buffer }[] = [];
    let i = 0;
    const varint = () => {
      let n = 0;
      let shift = 0;
      for (;;) {
        const b = buf[i++]!;
        n |= (b & 0x7f) << shift;
        if (!(b & 0x80)) return n >>> 0;
        shift += 7;
      }
    };
    while (i < buf.length) {
      const tag = varint();
      expect(tag & 7).toBe(2);
      const len = varint();
      out.push({ number: tag >>> 3, bytes: buf.subarray(i, i + len) });
      i += len;
    }
    return out;
  };
  const top = fields(header);
  const proofs = top.filter((f) => f.number === 2);
  const signed = top.find((f) => f.number === 10000)!.bytes;
  const proof = fields(proofs[0]!.bytes);
  const publicKey = proof.find((f) => f.number === 1)!.bytes;
  const signature = proof.find((f) => f.number === 2)!.bytes;
  const crxId = fields(signed).find((f) => f.number === 1)!.bytes;
  return { zip, publicKey, signature, signed, crxId };
}

describe("the CRX the daemon serves to a policy-installed Chrome", () => {
  it("derives Chrome's extension id from the signing key, and keeps it across runs", () => {
    const dir = state();
    const key = loadOrCreateSigningKey(join(dir, "extension-key.pem"));
    const id = extensionIdFor(createPublicKey(key));
    expect(id).toMatch(/^[a-p]{32}$/);
    expect(
      extensionIdFor(
        createPublicKey(loadOrCreateSigningKey(join(dir, "extension-key.pem"))),
      ),
    ).toBe(id);
    expect(
      extensionIdFor(
        createPublicKey(loadOrCreateSigningKey(join(state(), "other.pem"))),
      ),
    ).not.toBe(id);
  });

  it("zips the unpacked extension deterministically, every file, dotfiles out", () => {
    const files = listExtensionFiles(extensionDir());
    expect(files).toEqual([
      "background.js",
      "manifest.json",
      "options.html",
      "options.js",
      "schema.json",
    ]);
    const a = zipDirectory(extensionDir());
    expect(a.equals(zipDirectory(extensionDir()))).toBe(true);
    // The first local header names the first file, deflated, and inflates back.
    expect(a.readUInt32LE(0)).toBe(0x04034b50);
    const nameLen = a.readUInt16LE(26);
    expect(a.subarray(30, 30 + nameLen).toString()).toBe("background.js");
    const packedLen = a.readUInt32LE(18);
    expect(
      inflateRawSync(a.subarray(30 + nameLen, 30 + nameLen + packedLen)).equals(
        readFileSync(join(extensionDir(), "background.js")),
      ),
    ).toBe(true);
    // The end-of-central-directory record counts every entry.
    const eocd = a.length - 22;
    expect(a.readUInt32LE(eocd)).toBe(0x06054b50);
    expect(a.readUInt16LE(eocd + 10)).toBe(files.length);
  });

  it("signs a CRX3 whose proof verifies, whose id matches the key, and whose zip is the payload", () => {
    const key = loadOrCreateSigningKey(join(state(), "k.pem"));
    const packed = packExtension(extensionDir(), key);
    expect(packed.version).toBe(extensionVersion(extensionDir()));
    const { zip, publicKey, signature, signed, crxId } = unpackCrx(packed.crx);
    expect(zip.equals(zipDirectory(extensionDir()))).toBe(true);
    expect(
      publicKey.equals(
        createPublicKey(key).export({ type: "spki", format: "der" }),
      ),
    ).toBe(true);
    expect(
      crxId.equals(
        createHash("sha256").update(publicKey).digest().subarray(0, 16),
      ),
    ).toBe(true);
    expect(extensionIdFor(createPublicKey(key))).toBe(packed.id);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(signed.length);
    const verifier = createVerify("RSA-SHA256");
    verifier.update(Buffer.from("CRX3 SignedData\0", "latin1"));
    verifier.update(len);
    verifier.update(signed);
    verifier.update(zip);
    expect(
      verifier.verify(
        createPublicKey({ key: publicKey, format: "der", type: "spki" }),
        signature,
      ),
    ).toBe(true);
  });

  it("refuses a directory with no manifest, and a manifest with no version", () => {
    const key = loadOrCreateSigningKey(join(state(), "k.pem"));
    expect(() => packExtension(state(), key)).toThrow(/no extension/);
    const bad = state();
    writeFileSync(join(bad, "manifest.json"), "{}");
    expect(() => packExtension(bad, key)).toThrow(/no version/);
  });

  it("writes an update manifest and a profile that name the same id and URL, escaped", () => {
    const xml = updateManifestXml(
      "abcdefghijklmnopabcdefghijklmnop",
      "0.1.0",
      "http://127.0.0.1:7312/extension/strad-hostd.crx",
    );
    expect(xml).toContain("appid='abcdefghijklmnopabcdefghijklmnop'");
    expect(xml).toContain(
      "codebase='http://127.0.0.1:7312/extension/strad-hostd.crx' version='0.1.0'",
    );
    const profile = renderMobileconfig({
      extensionId: "abcdefghijklmnopabcdefghijklmnop",
      updateUrl: "http://127.0.0.1:7312/extension/update.xml",
      daemonUrl: "ws://127.0.0.1:7312/extension",
      token: "tok<en>",
      machine: "Tadas's Mac",
    });
    expect(profile).toContain("<key>abcdefghijklmnopabcdefghijklmnop</key>");
    expect(profile).toContain("<string>force_installed</string>");
    expect(profile).toContain(
      "<key>PayloadType</key><string>com.google.Chrome.extensions.abcdefghijklmnopabcdefghijklmnop</string>",
    );
    expect(profile).toContain(
      "<key>token</key><string>tok&#60;en&#62;</string>",
    );
    expect(profile).toContain("Tadas&#39;s Mac");
    expect(profile).not.toContain("tok<en>");
    // Same input, same UUIDs: re-installing replaces rather than stacks.
    expect(
      renderMobileconfig({
        extensionId: "abcdefghijklmnopabcdefghijklmnop",
        updateUrl: "x",
        daemonUrl: "y",
        token: "z",
        machine: "m",
      }).match(/PayloadUUID<\/key><string>([^<]+)/g),
    ).toEqual(profile.match(/PayloadUUID<\/key><string>([^<]+)/g));
  });
});
