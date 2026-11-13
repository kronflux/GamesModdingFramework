// Unreal .ini reader: sections, keys and the array operators Unreal puts in front of a key.

/** Decode ini bytes: UTF-16 (either byte order) or UTF-8, each with or without a BOM. */
export function decodeText(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString("utf8");
  return bytes.toString("utf8");
}

const OPERATORS = new Set(["+", "-", ".", "!"]);

/**
 * Parse ini text into ordered sections. A line starting with ; or # is a comment. Duplicate keys
 * stay in order. A leading + - . or ! on a key is returned as `op`.
 */
export function parseIni(text) {
  const sections = [];
  let current = null;
  const body = String(text);
  const lines = (body.charCodeAt(0) === 0xfeff ? body.slice(1) : body).split(/\r\n|\n|\r/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith(";") || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      current = { name: line.slice(1, -1), entries: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      current = { name: "", entries: [] };
      sections.push(current);
    }
    const eq = line.indexOf("=");
    let key = (eq < 0 ? line : line.slice(0, eq)).trim();
    const value = eq < 0 ? "" : line.slice(eq + 1).trim();
    let op = "";
    if (OPERATORS.has(key[0])) {
      op = key[0];
      key = key.slice(1).trim();
    }
    current.entries.push({ key, value, op });
  }
  return { sections };
}
