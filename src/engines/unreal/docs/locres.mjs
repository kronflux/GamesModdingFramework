// Reader and writer for Unreal .locres localization resources.
//
// Layout follows Unreal's TextLocalizationResource.cpp (FTextLocalizationResource::LoadFromArchive
// and SaveToArchive) and its ELocResVersion enum: 0 Legacy, 1 Compact, 2 Optimized_CRC32,
// 3 Optimized_CityHash64_UTF16.
//
//   version >= 1 starts with the 16-byte magic GUID 7574140E FC034A67 9D90154A 1B7F37C3 (four
//   little-endian uint32) and a uint8 version; a file without the magic is the legacy format and
//   starts at byte 0.
//   version >= 1: int64 offset of the localized string array (-1 when absent).
//   version >= 2: int32 total entry count.
//   uint32 namespace count; per namespace:
//     version >= 2: uint32 name hash; FString name; uint32 key count; per key:
//       version >= 2: uint32 key hash; FString key; uint32 source string hash;
//       version >= 1: int32 index into the string array; version 0: FString text.
//   string array at the offset: int32 count; per item FString and, version >= 2, an int32 ref count.
//   FString: int32 length. Positive: that many bytes including a NUL, single byte text. Negative:
//   -length UTF-16LE code units including a NUL.
//
// The reader decodes the hashes away; the writer stores zero hashes, which is enough for tests.

const MAGIC = Uint8Array.from([
  0x0e, 0x14, 0x74, 0x75, 0x67, 0x4a, 0x03, 0xfc, 0x4a, 0x15, 0x90, 0x9d, 0xc3, 0x37, 0x7f, 0x1b,
]);

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = 0;
  }

  need(count) {
    if (count < 0 || this.pos + count > this.bytes.length) {
      throw new Error(`Truncated .locres: need ${count} bytes at offset ${this.pos} of ${this.bytes.length}`);
    }
  }

  u8() {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }

  i32() {
    this.need(4);
    const value = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return value;
  }

  u32() {
    this.need(4);
    const value = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return value;
  }

  i64() {
    this.need(8);
    const value = Number(this.view.getBigInt64(this.pos, true));
    this.pos += 8;
    return value;
  }

  fstring() {
    const length = this.i32();
    if (length === 0) return "";
    if (length > 0) {
      this.need(length);
      const text = Buffer.from(this.bytes.buffer, this.bytes.byteOffset + this.pos, length - 1).toString("latin1");
      this.pos += length;
      return text;
    }
    const units = -length;
    this.need(units * 2);
    const text = Buffer.from(this.bytes.buffer, this.bytes.byteOffset + this.pos, (units - 1) * 2).toString("utf16le");
    this.pos += units * 2;
    return text;
  }
}

function hasMagic(bytes) {
  if (bytes.length < MAGIC.length) return false;
  return MAGIC.every((byte, i) => bytes[i] === byte);
}

/** Parse a .locres file. Throws an Error naming the version when it is not 0 to 3. */
export function parseLocres(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const reader = new Reader(bytes);
  let version = 0;
  if (hasMagic(bytes)) {
    reader.pos = MAGIC.length;
    version = reader.u8();
    if (version > 3) throw new Error(`Unsupported .locres version ${version}`);
  }

  let strings = null;
  if (version >= 1) {
    const arrayOffset = reader.i64();
    if (arrayOffset >= 0) {
      const mainPos = reader.pos;
      reader.pos = arrayOffset;
      const count = reader.i32();
      if (count < 0 || count > bytes.length) throw new Error(`Corrupt .locres: string count ${count}`);
      strings = [];
      for (let i = 0; i < count; i++) {
        strings.push(reader.fstring());
        if (version >= 2) reader.i32();
      }
      reader.pos = mainPos;
    } else {
      strings = [];
    }
  }
  if (version >= 2) reader.i32();

  const namespaceCount = reader.u32();
  const namespaces = [];
  for (let n = 0; n < namespaceCount; n++) {
    if (version >= 2) reader.u32();
    const name = reader.fstring();
    const keyCount = reader.u32();
    const entries = [];
    for (let k = 0; k < keyCount; k++) {
      if (version >= 2) reader.u32();
      const key = reader.fstring();
      reader.u32();
      let text;
      if (version >= 1) {
        const index = reader.i32();
        if (index < 0 || index >= strings.length) throw new Error(`Corrupt .locres: string index ${index} of ${strings.length}`);
        text = strings[index];
      } else {
        text = reader.fstring();
      }
      entries.push({ key, text });
    }
    namespaces.push({ name, entries });
  }
  return { version, namespaces };
}

function fstringBytes(text) {
  const value = String(text);
  if (value === "") return Buffer.alloc(4);
  const ascii = /^[\x01-\x7f]*$/.test(value);
  if (ascii) {
    const body = Buffer.from(`${value}\0`, "latin1");
    const head = Buffer.alloc(4);
    head.writeInt32LE(body.length);
    return Buffer.concat([head, body]);
  }
  const body = Buffer.from(`${value}\0`, "utf16le");
  const head = Buffer.alloc(4);
  head.writeInt32LE(-(body.length / 2));
  return Buffer.concat([head, body]);
}

function u32Bytes(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0);
  return out;
}

/** Write a .locres file for tests. Hashes are written as zero. */
export function writeLocres(namespaces, version = 3) {
  if (!Number.isInteger(version) || version < 0 || version > 3) throw new Error(`Unsupported .locres version ${version}`);
  const strings = [];
  const parts = [];
  let total = 0;
  for (const ns of namespaces) {
    if (version >= 2) parts.push(u32Bytes(0));
    parts.push(fstringBytes(ns.name), u32Bytes(ns.entries.length));
    for (const entry of ns.entries) {
      total++;
      if (version >= 2) parts.push(u32Bytes(0));
      parts.push(fstringBytes(entry.key), u32Bytes(0));
      if (version >= 1) {
        const index = Buffer.alloc(4);
        index.writeInt32LE(strings.length);
        strings.push(entry.text);
        parts.push(index);
      } else {
        parts.push(fstringBytes(entry.text));
      }
    }
  }
  const head = [];
  if (version >= 1) head.push(Buffer.from(MAGIC), Buffer.from([version]));
  const offsetAt = head.reduce((sum, part) => sum + part.length, 0);
  if (version >= 1) head.push(Buffer.alloc(8));
  if (version >= 2) {
    const count = Buffer.alloc(4);
    count.writeInt32LE(total);
    head.push(count);
  }
  head.push(u32Bytes(namespaces.length));
  const main = Buffer.concat([...head, ...parts]);
  if (version === 0) return new Uint8Array(main);
  main.writeBigInt64LE(BigInt(main.length), offsetAt);
  const tail = [Buffer.alloc(4)];
  tail[0].writeInt32LE(strings.length);
  for (const text of strings) {
    tail.push(fstringBytes(text));
    if (version >= 2) tail.push(u32Bytes(1));
  }
  return new Uint8Array(Buffer.concat([main, ...tail]));
}
