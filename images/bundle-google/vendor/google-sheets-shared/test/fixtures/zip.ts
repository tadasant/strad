/**
 * A real ZIP writer, so the xlsx tests parse a real archive.
 *
 * The alternative — checking a binary .xlsx into the repo — makes the fixture
 * opaque: nobody can see what the test is asserting against, and nobody can
 * change one cell of it. Writing the archive here keeps every byte of the
 * fixture in readable source, and it is the format's own writer rather than a
 * shape the reader happens to accept: the CRCs are real, the sizes are real, and
 * both compression methods an OOXML package may use are exercised.
 */
import { deflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/**
 * Build a ZIP from `{ name: contents }`.
 *
 * `deflate` names the entries written with method 8; everything else is STORED.
 * Both paths matter — Excel stores tiny parts and deflates large ones, so a
 * reader that only handles one of them works on some workbooks and not others.
 */
export function makeZip(files, options = {}) {
  const deflate = new Set(options.deflate ?? []);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, contents] of Object.entries(files)) {
    const raw = Buffer.from(contents, "utf8");
    const useDeflate = deflate.has(name);
    const data = useDeflate ? deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const localBytes = Buffer.concat(locals);
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(localBytes.length, 16);

  return new Uint8Array(Buffer.concat([localBytes, centralBytes, end]));
}
