/**
 * The three hundred bytes of the ZIP format an .xlsx actually uses.
 *
 * An OOXML workbook is a ZIP archive of XML parts, and reading one needs no ZIP
 * library: every entry is either STORED or DEFLATEd, and `node:zlib` does the
 * second. That is worth doing by hand here rather than taking a dependency,
 * because this code runs in the bundle container beside twenty-one other MCP
 * servers and holds three Google accounts' refresh tokens — the npm packages
 * that read xlsx are large, and the popular one has been unmaintained on npm
 * since 0.18.5 with a live prototype-pollution advisory against it.
 *
 * The reader is CENTRAL-DIRECTORY-FIRST and LAZY: it indexes every entry once,
 * then inflates only the handful of parts a workbook read needs. A workbook with
 * two hundred worksheets costs two hundred index entries and however many parts
 * the caller asks for.
 *
 * IT IS ALSO A PARSER OF HOSTILE INPUT — the bytes come from a Drive file, and a
 * zip bomb is 40 KB that inflates to a gigabyte. Every inflate is bounded, and
 * so is their sum.
 */
import { inflateRawSync } from 'node:zlib';

/** Signatures, little-endian, as they appear on disk. */
const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

/**
 * What one entry may inflate to, and what all of them together may.
 *
 * Sized against the container, not against the format: the bundle runs on 2GB
 * shared by twenty-two MCP servers, so the failure to avoid is an OOM that takes
 * all of them down. A refusal with a message is strictly better, and these
 * bounds are far above any workbook that fits under the 20MB download cap.
 */
const MAX_ENTRY_BYTES = 48 * 1024 * 1024;
const MAX_TOTAL_INFLATED_BYTES = 128 * 1024 * 1024;

/** A ZIP64 archive says "look in the ZIP64 record" with these sentinels. */
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;

interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate. Nothing else is legal in an OOXML package. */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipFormatError';
  }
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Find the end-of-central-directory record.
 *
 * It is the LAST thing in the file, but it carries a variable-length comment, so
 * it is found by scanning backwards from the end over the largest comment a ZIP
 * can have (65535) plus the record itself (22).
 */
function findEndOfCentralDirectory(buffer: Buffer): number {
  const earliest = Math.max(0, buffer.length - (0xffff + 22));
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new ZipFormatError(
    'Not a ZIP archive: no end-of-central-directory record. An .xlsx is a ZIP, so ' +
      'this file is either a different format or was truncated in transit.'
  );
}

/**
 * A ZIP archive, indexed and ready to be read one part at a time.
 *
 * Construction reads the central directory only; `read` is what inflates.
 */
export class ZipArchive {
  private readonly buffer: Buffer;
  private readonly entries = new Map<string, ZipEntry>();
  private inflatedBytes = 0;

  private constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  static open(bytes: Uint8Array): ZipArchive {
    const buffer = asBuffer(bytes);
    if (buffer.length < 22) {
      throw new ZipFormatError(`Not a ZIP archive: the file is only ${buffer.length} bytes.`);
    }

    const archive = new ZipArchive(buffer);
    const eocd = findEndOfCentralDirectory(buffer);
    const entryCount = buffer.readUInt16LE(eocd + 10);
    const directoryOffset = buffer.readUInt32LE(eocd + 16);

    if (entryCount === ZIP64_SENTINEL_16 || directoryOffset === ZIP64_SENTINEL_32) {
      throw new ZipFormatError(
        'This is a ZIP64 archive, which this reader does not implement. A workbook that ' +
          'large is past what this server will read anyway.'
      );
    }

    let cursor = directoryOffset;
    for (let i = 0; i < entryCount; i += 1) {
      if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_HEADER) {
        throw new ZipFormatError(
          `Corrupt ZIP central directory at entry ${i + 1} of ${entryCount}.`
        );
      }
      const nameLength = buffer.readUInt16LE(cursor + 28);
      const extraLength = buffer.readUInt16LE(cursor + 30);
      const commentLength = buffer.readUInt16LE(cursor + 32);
      const entry: ZipEntry = {
        // OOXML part names are ASCII paths, so the general-purpose bit 11
        // (UTF-8) question never arises: both encodings agree on them.
        name: buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength),
        method: buffer.readUInt16LE(cursor + 10),
        compressedSize: buffer.readUInt32LE(cursor + 20),
        uncompressedSize: buffer.readUInt32LE(cursor + 24),
        localHeaderOffset: buffer.readUInt32LE(cursor + 42),
      };
      archive.entries.set(entry.name, entry);
      cursor += 46 + nameLength + extraLength + commentLength;
    }

    return archive;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Every part name, in central-directory order. */
  names(): string[] {
    return [...this.entries.keys()];
  }

  /** One part's bytes, inflated if it was deflated. Undefined if absent. */
  read(name: string): Buffer | undefined {
    const entry = this.entries.get(name);
    if (!entry) return undefined;

    const { buffer } = this;
    const header = entry.localHeaderOffset;
    if (header + 30 > buffer.length || buffer.readUInt32LE(header) !== LOCAL_HEADER) {
      throw new ZipFormatError(`Corrupt ZIP entry "${name}": no local file header.`);
    }
    // The local header repeats the name and extra fields, and its extra field is
    // NOT always the same length as the central directory's — so the data offset
    // has to be computed from this header, not from that one.
    const nameLength = buffer.readUInt16LE(header + 26);
    const extraLength = buffer.readUInt16LE(header + 28);
    const start = header + 30 + nameLength + extraLength;
    const end = start + entry.compressedSize;
    if (end > buffer.length) {
      throw new ZipFormatError(`Corrupt ZIP entry "${name}": data runs past the end of the file.`);
    }
    const compressed = buffer.subarray(start, end);

    if (entry.method === 0) {
      // A stored entry is a view into a buffer this process already holds, so it
      // allocates nothing and is already bounded by the download cap. It is
      // still measured against MAX_ENTRY_BYTES, so that the header's claim —
      // every part bounded, and their sum bounded — is what the code does.
      if (compressed.length > MAX_ENTRY_BYTES) {
        throw new ZipFormatError(
          `ZIP entry "${name}" is ${compressed.length} bytes, past what this server reads.`
        );
      }
      return compressed;
    }
    if (entry.method !== 8) {
      throw new ZipFormatError(
        `ZIP entry "${name}" uses compression method ${entry.method}; an OOXML package ` +
          'uses only stored (0) and deflate (8).'
      );
    }

    // maxOutputLength is the zip-bomb bound: a declared uncompressed size is a
    // claim by the archive, and an attacker writes whatever they like there.
    const limit = Math.min(MAX_ENTRY_BYTES, MAX_TOTAL_INFLATED_BYTES - this.inflatedBytes);
    let inflated: Buffer;
    try {
      inflated = inflateRawSync(compressed, { maxOutputLength: Math.max(limit, 1) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ZipFormatError(
        `Could not decompress ZIP entry "${name}": ${message}. If this file is very large ` +
          'or deliberately crafted, this server will not read it.'
      );
    }
    this.charge(name, inflated.length);
    return inflated;
  }

  private charge(name: string, bytes: number): void {
    this.inflatedBytes += bytes;
    if (this.inflatedBytes > MAX_TOTAL_INFLATED_BYTES) {
      throw new ZipFormatError(
        `This workbook expands past ${Math.round(MAX_TOTAL_INFLATED_BYTES / (1024 * 1024))}MB ` +
          `while reading "${name}", which is more than this server will hold in memory.`
      );
    }
  }
}
