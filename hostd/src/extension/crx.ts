import {
  createPrivateKey,
  createPublicKey,
  createSign,
  generateKeyPairSync,
  createHash,
  type KeyObject,
} from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

import { readOrCreateSecret } from "./secret.js";

/**
 * A CRX3 packer, so the daemon can serve the extension to a policy-installed
 * Chrome without a Web Store listing and without the owner running Chrome's
 * "Pack extension" by hand. Chrome verifies a policy-installed CRX against
 * the key inside it and derives the extension's id from that key, so the key
 * lives in the state directory and never changes: a new key is a new
 * extension id and a configuration profile that force-installs the old one.
 *
 * Format (https://chromium.googlesource.com/chromium/src/+/main/components/crx_file/crx3.proto):
 *
 *   "Cr24" · uint32 LE version=3 · uint32 LE header length · CrxFileHeader · zip
 *
 *   CrxFileHeader { repeated AsymmetricKeyProof sha256_with_rsa = 2;
 *                   bytes signed_header_data = 10000 }
 *   AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2 }
 *   SignedData { bytes crx_id = 1 }
 *
 * The signature is RSA-PKCS1-v1.5 over SHA-256 of
 *   "CRX3 SignedData\0" · uint32 LE len(signed_header_data) · signed_header_data · zip
 */

/** The extension id Chrome derives from a public key: SHA-256's first 16 bytes, in a–p. */
export function extensionIdFor(publicKey: KeyObject): string {
  const spki = publicKey.export({ type: "spki", format: "der" });
  const digest = createHash("sha256").update(spki).digest().subarray(0, 16);
  return [...digest]
    .map(
      (b) =>
        String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)),
    )
    .join("");
}

/** The signing key, made on first use. RSA because CRX3's proof is RSA or ECDSA and Chrome checks the RSA one first. */
export function loadOrCreateSigningKey(path: string): KeyObject {
  const pem = readOrCreateSecret(path, () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    return privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  });
  return createPrivateKey(pem);
}

function varint(n: number): Buffer {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}

/** A length-delimited protobuf field. */
function field(number: number, bytes: Buffer): Buffer {
  return Buffer.concat([
    varint((number << 3) | 2),
    varint(bytes.length),
    bytes,
  ]);
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

/** Every regular file under `dir`, sorted, as zip entry names. Dotfiles are left out. */
export function listExtensionFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith(".")) continue;
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.push(relative(dir, full).split(sep).join("/"));
    }
  };
  walk(dir);
  return out;
}

/** A deterministic zip of a directory: deflated entries, fixed timestamps, sorted names. */
export function zipDirectory(dir: string): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const name of listExtensionFiles(dir)) {
    const data = readFileSync(join(dir, name));
    const packed = deflateRawSync(data);
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    // 1980-01-01 00:00, DOS time and date.
    const common = Buffer.concat([
      u16(20), // version needed
      u16(0x0800), // flags: UTF-8 names
      u16(8), // deflate
      u16(0),
      u16(0x21),
      u32(crc),
      u32(packed.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0), // extra
    ]);
    const local = Buffer.concat([u32(0x04034b50), common, nameBytes, packed]);
    central.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20), // version made by
        common,
        u16(0), // comment
        u16(0), // disk
        u16(0), // internal attrs
        u32(0), // external attrs
        u32(offset),
        nameBytes,
      ]),
    );
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(central.length),
    u16(central.length),
    u32(cd.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, cd, eocd]);
}

export function packCrx(zip: Buffer, privateKey: KeyObject): Buffer {
  const publicKey = createPublicKey(privateKey);
  const spki = publicKey.export({ type: "spki", format: "der" });
  const crxId = createHash("sha256").update(spki).digest().subarray(0, 16);
  const signedHeaderData = field(1, crxId);
  const signer = createSign("RSA-SHA256");
  signer.update(Buffer.from("CRX3 SignedData\0", "latin1"));
  signer.update(u32(signedHeaderData.length));
  signer.update(signedHeaderData);
  signer.update(zip);
  const signature = signer.sign(privateKey);
  const proof = Buffer.concat([field(1, spki), field(2, signature)]);
  const header = Buffer.concat([
    field(2, proof),
    field(10000, signedHeaderData),
  ]);
  return Buffer.concat([
    Buffer.from("Cr24", "latin1"),
    u32(3),
    u32(header.length),
    header,
    zip,
  ]);
}

/** The manifest's version, which is what Chrome compares against the installed copy. */
export function extensionVersion(dir: string): string {
  const manifest = JSON.parse(
    readFileSync(join(dir, "manifest.json"), "utf8"),
  ) as { version?: string };
  if (!manifest.version) throw new Error(`${dir}/manifest.json has no version`);
  return manifest.version;
}

/** Chrome's update manifest: one app, one codebase. */
export function updateManifestXml(
  id: string,
  version: string,
  codebase: string,
): string {
  const esc = (s: string) =>
    s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return (
    `<?xml version='1.0' encoding='UTF-8'?>\n` +
    `<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n` +
    `  <app appid='${esc(id)}'>\n` +
    `    <updatecheck codebase='${esc(codebase)}' version='${esc(version)}' />\n` +
    `  </app>\n` +
    `</gupdate>\n`
  );
}

export interface PackedExtension {
  id: string;
  version: string;
  crx: Buffer;
}

/** Pack the extension directory with the state directory's key. */
export function packExtension(
  dir: string,
  privateKey: KeyObject,
): PackedExtension {
  if (!existsSync(join(dir, "manifest.json")))
    throw new Error(`no extension at ${dir}`);
  return {
    id: extensionIdFor(createPublicKey(privateKey)),
    version: extensionVersion(dir),
    crx: packCrx(zipDirectory(dir), privateKey),
  };
}
