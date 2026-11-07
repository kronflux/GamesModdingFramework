// Dependency-free PE32+ parser and AOB scanner.
// Offsets named "raw" or "file" are file offsets; RVAs are virtual addresses relative to the image base.

const IMAGE_DOS_SIGNATURE = 0x5a4d;
const IMAGE_NT_SIGNATURE = 0x00004550;
const OPTIONAL_HDR_MAGIC_PE32 = 0x10b;
const OPTIONAL_HDR_MAGIC_PE32PLUS = 0x20b;
export const IMAGE_SCN_MEM_EXECUTE = 0x20000000;

function readCString(buffer, offset) {
  let end = buffer.indexOf(0, offset);
  if (end === -1) end = buffer.length;
  return buffer.toString("latin1", offset, end);
}

// Translate an RVA to a file offset using the larger of virtual and raw size as the extent.
function tableRvaToOffset(sections, rva) {
  for (const sec of sections) {
    const end = sec.virtualAddress + Math.max(sec.virtualSize, sec.rawSize);
    if (rva >= sec.virtualAddress && rva < end) {
      const delta = rva - sec.virtualAddress;
      return delta < sec.rawSize ? sec.rawOffset + delta : null;
    }
  }
  return null;
}

function parseExports(sections, buffer, exportDirRva) {
  const exportRvas = {};
  const dir = tableRvaToOffset(sections, exportDirRva);
  if (dir === null || dir + 40 > buffer.length) return exportRvas;
  const numFunctions = buffer.readUInt32LE(dir + 20);
  const numNames = buffer.readUInt32LE(dir + 24);
  const funcs = tableRvaToOffset(sections, buffer.readUInt32LE(dir + 28));
  const names = tableRvaToOffset(sections, buffer.readUInt32LE(dir + 32));
  const ords = tableRvaToOffset(sections, buffer.readUInt32LE(dir + 36));
  if (funcs === null || names === null || ords === null) return exportRvas;
  for (let i = 0; i < numNames; i += 1) {
    const namePtr = names + i * 4;
    const ordPtr = ords + i * 2;
    if (namePtr + 4 > buffer.length || ordPtr + 2 > buffer.length) break;
    const ordinal = buffer.readUInt16LE(ordPtr);
    if (ordinal >= numFunctions) continue;
    const funcPtr = funcs + ordinal * 4;
    if (funcPtr + 4 > buffer.length) continue;
    const nameOffset = tableRvaToOffset(sections, buffer.readUInt32LE(namePtr));
    if (nameOffset === null) continue;
    const name = readCString(buffer, nameOffset);
    if (name) exportRvas[name] = buffer.readUInt32LE(funcPtr);
  }
  return exportRvas;
}

// Walk the IMAGE_IMPORT_DESCRIPTOR entries and read the imported DLL names.
function parseImports(sections, buffer, importDirRva) {
  const imports = [];
  let desc = tableRvaToOffset(sections, importDirRva);
  if (desc === null) return imports;
  for (let guard = 0; guard < 4096 && desc + 20 <= buffer.length; guard += 1, desc += 20) {
    const originalFirstThunk = buffer.readUInt32LE(desc);
    const nameRva = buffer.readUInt32LE(desc + 12);
    const firstThunk = buffer.readUInt32LE(desc + 16);
    if (!originalFirstThunk && !nameRva && !firstThunk) break;
    const nameOffset = tableRvaToOffset(sections, nameRva);
    if (nameOffset === null) continue;
    const names = [];
    let thunk = tableRvaToOffset(sections, originalFirstThunk || firstThunk);
    while (thunk !== null && thunk + 8 <= buffer.length && names.length < 65536) {
      const entry = buffer.readBigUInt64LE(thunk);
      if (entry === 0n) break;
      if ((entry & (1n << 63n)) === 0n) {
        const hintName = tableRvaToOffset(sections, Number(entry & 0x7fffffffn));
        if (hintName !== null && hintName + 2 < buffer.length) names.push(readCString(buffer, hintName + 2));
      } else {
        names.push(`#${Number(entry & 0xffffn)}`);
      }
      thunk += 8;
    }
    imports.push({ dll: readCString(buffer, nameOffset), names });
  }
  return imports;
}

function parseHeaders(buffer) {
  const eLfanew = buffer.readUInt32LE(0x3c);
  if (eLfanew + 4 > buffer.length) throw new Error("invalid e_lfanew: past end of file");
  if (buffer.readUInt32LE(eLfanew) !== IMAGE_NT_SIGNATURE) throw new Error("not a PE image: missing PE\\0\\0 signature");

  const coff = eLfanew + 4;
  const machine = buffer.readUInt16LE(coff);
  const numSections = buffer.readUInt16LE(coff + 2);
  const timestamp = buffer.readUInt32LE(coff + 4);
  const optionalSize = buffer.readUInt16LE(coff + 16);
  const opt = coff + 20;
  const magic = buffer.readUInt16LE(opt);
  if (magic === OPTIONAL_HDR_MAGIC_PE32) throw new Error("32-bit PE (PE32) is not supported; expected PE32+");
  if (magic !== OPTIONAL_HDR_MAGIC_PE32PLUS) throw new Error(`unknown optional header magic: 0x${magic.toString(16).toUpperCase()}`);

  const imageBase = Number(buffer.readBigUInt64LE(opt + 24));
  const dirCount = buffer.readUInt32LE(opt + 108);
  const dataDirectory = (index) => {
    const at = opt + 112 + index * 8;
    if (dirCount <= index || at + 8 > buffer.length) return { rva: 0, size: 0 };
    return { rva: buffer.readUInt32LE(at), size: buffer.readUInt32LE(at + 4) };
  };

  const sections = [];
  const table = opt + optionalSize;
  for (let i = 0; i < numSections; i += 1) {
    const base = table + i * 40;
    if (base + 40 > buffer.length) throw new Error(`section header ${i} past end of file`);
    sections.push({
      name: buffer.toString("latin1", base, base + 8).replace(/\0+$/, ""),
      virtualAddress: buffer.readUInt32LE(base + 12),
      virtualSize: buffer.readUInt32LE(base + 8),
      rawOffset: buffer.readUInt32LE(base + 20),
      rawSize: buffer.readUInt32LE(base + 16),
      flags: buffer.readUInt32LE(base + 36),
    });
  }

  const exportDir = dataDirectory(0);
  const importDir = dataDirectory(1);
  const exportRvas = exportDir.rva && exportDir.size ? parseExports(sections, buffer, exportDir.rva) : {};
  const imports = importDir.rva ? parseImports(sections, buffer, importDir.rva) : [];
  const exec = sections.find((s) => (s.flags & IMAGE_SCN_MEM_EXECUTE) !== 0);
  return {
    imageBase,
    machine,
    isPe32Plus: true,
    timestamp,
    sections,
    imports,
    exports: Object.keys(exportRvas),
    exportRvas,
    // File-offset range of the first executable section, or {start: 0, end: 0} when there is none.
    textRange: exec ? { start: exec.rawOffset, end: exec.rawOffset + exec.rawSize } : { start: 0, end: 0 },
  };
}

export function parsePe(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length < 0x40) throw new Error("file too small to be a PE image");
  if (buffer.readUInt16LE(0) !== IMAGE_DOS_SIGNATURE) throw new Error("not a PE image: missing MZ signature");
  try {
    return parseHeaders(buffer);
  } catch (error) {
    if (error instanceof RangeError) throw new Error(`malformed or truncated PE: ${error.message}`);
    throw error;
  }
}

export function execSections(pe) {
  return pe.sections.filter((s) => (s.flags & IMAGE_SCN_MEM_EXECUTE) !== 0);
}

export function execSection(pe) {
  const first = execSections(pe)[0];
  if (!first) throw new Error("no executable section found");
  return first;
}

// The virtual size bounds the mapped extent; raw size is only the fallback when it is zero.
export function rvaInSection(pe, rva, section) {
  const extent = section.virtualSize ? section.virtualSize : section.rawSize;
  return rva >= section.virtualAddress && rva < section.virtualAddress + extent;
}

// RVA to file offset through the section that contains it, or null when unmapped or past the raw data.
export function rvaToFileOffset(pe, rva) {
  for (const sec of pe.sections) {
    if (rvaInSection(pe, rva, sec)) {
      const delta = rva - sec.virtualAddress;
      return delta < sec.rawSize ? sec.rawOffset + delta : null;
    }
  }
  return null;
}

// File offset to RVA through the section whose raw data contains it, or null outside every section.
export function fileOffsetToRva(pe, offset) {
  for (const sec of pe.sections) {
    if (offset >= sec.rawOffset && offset < sec.rawOffset + sec.rawSize) return sec.virtualAddress + (offset - sec.rawOffset);
  }
  return null;
}

// Compile "48 8B ?? 4? E8" (or "488B...") into parallel value and mask byte arrays.
export function compilePattern(pattern) {
  const text = String(pattern);
  let tokens;
  if (/\s/.test(text.trim())) {
    tokens = text.trim().split(/\s+/);
  } else {
    const compact = text.replace(/\s+/g, "");
    if (compact.length % 2 !== 0) throw new Error("odd number of nibbles in pattern");
    tokens = compact.match(/../g) || [];
  }
  const value = [];
  const mask = [];
  for (const token of tokens) {
    if (!/^[0-9A-Fa-f?]{2}$/.test(token)) throw new Error(`invalid pattern token: '${token}'`);
    let v = 0;
    let m = 0;
    if (token[0] !== "?") {
      v |= parseInt(token[0], 16) << 4;
      m |= 0xf0;
    }
    if (token[1] !== "?") {
      v |= parseInt(token[1], 16);
      m |= 0x0f;
    }
    value.push(v);
    mask.push(m);
  }
  if (value.length === 0) throw new Error("empty pattern");
  return { value: Uint8Array.from(value), mask: Uint8Array.from(mask) };
}

export function findInRange(buffer, compiled, start, stop, hits = []) {
  const { value, mask } = compiled;
  const limit = stop - value.length;
  for (let off = start; off <= limit; off += 1) {
    let ok = true;
    for (let j = 0; j < value.length; j += 1) {
      if ((buffer[off + j] & mask[j]) !== value[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(off);
  }
  return hits;
}

// Scan the raw ranges of the sections (or just `section`) and return matching RVAs.
export function scan(pe, pattern, buffer, section = null) {
  const compiled = compilePattern(pattern);
  const results = [];
  for (const sec of section ? [section] : pe.sections) {
    if (sec.rawSize === 0) continue;
    const start = sec.rawOffset;
    const stop = Math.min(sec.rawOffset + sec.rawSize, buffer.length);
    if (start >= stop) continue;
    for (const off of findInRange(buffer, compiled, start, stop)) results.push(sec.virtualAddress + (off - sec.rawOffset));
  }
  return results;
}

const VERSION_KEYS = ["ProductName", "ProductVersion", "FileVersion", "CompanyName", "FileDescription", "OriginalFilename"];

// Read the version resource strings (VS_VERSIONINFO String entries) of an
// executable. Each entry is wLength, wValueLength, wType, a UTF-16 key with a
// terminator, padding to 32 bits, then the UTF-16 value. The .rsrc section is
// searched when the buffer parses as a PE; otherwise the whole buffer is.
export function readVersionStrings(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  let start = 0;
  let end = buffer.length;
  try {
    const rsrc = parsePe(buffer).sections.find((section) => section.name === ".rsrc");
    if (rsrc) {
      start = rsrc.rawOffset;
      end = Math.min(buffer.length, rsrc.rawOffset + rsrc.rawSize);
    }
  } catch {
    // Not a PE image: scan the whole buffer.
  }
  const strings = {};
  for (const key of VERSION_KEYS) {
    const needle = Buffer.from(`${key}\0`, "utf16le");
    let at = buffer.indexOf(needle, start);
    while (at >= 0 && at < end) {
      const structStart = at - 6;
      if (structStart >= start) {
        const valueLength = buffer.readUInt16LE(structStart + 2);
        let valueAt = at + needle.length;
        valueAt += (4 - ((valueAt - structStart) % 4)) % 4;
        if (valueLength > 0 && valueAt + valueLength * 2 <= end) {
          const value = buffer.toString("utf16le", valueAt, valueAt + valueLength * 2).replace(/\0+$/, "");
          if (value) {
            strings[key] = value;
            break;
          }
        }
      }
      at = buffer.indexOf(needle, at + 2);
    }
  }
  return strings;
}

// Unreal shipping builds stamp "++UE5+Release-5.6-CL-44394996" into their
// version resource. Return the engine version, changelist and branch, or null.
export function parseUeBuildVersion(text) {
  const match = /^(\+\+UE\d\+Release-(\d+\.\d+))(?:-CL-(\d+))?/.exec(String(text || "").trim());
  if (!match) return null;
  return { version: match[2], changelist: match[3] || null, branch: match[1] };
}
