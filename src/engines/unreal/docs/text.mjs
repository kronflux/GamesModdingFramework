// Text, number and JSON helpers for the docs builder.
//
// The pages this builder writes are compared byte for byte with pages written by a Python
// builder, so values read from the dump keep the distinctions Python keeps: a JSON number
// written with a fraction or an exponent is a float (`PyFloat`) and prints as Python prints a
// float ("1.0", "1e-05"); an integer outside the safe range is a BigInt; an object whose keys
// look like array indexes is a Map, because a plain object would move those keys to the
// front. Every other JSON object is a plain object. Use `get`, `entries`, `isDict` and
// `truthy` on parsed values instead of property access.

import { closeSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

// --- values

/** A JSON number that Python reads as a float. */
export class PyFloat {
  constructor(value) {
    this.value = value;
  }
}

export function isDict(value) {
  return value instanceof Map || (value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof PyFloat));
}

export function isList(value) {
  return Array.isArray(value);
}

/** Python `dict.get(key)`: undefined when the key is absent or `object` is not a dict. */
export function get(object, key) {
  if (object instanceof Map) return object.get(key);
  if (isDict(object) && Object.hasOwn(object, key)) return object[key];
  return undefined;
}

/** Python `dict.get(key, fallback)`: the fallback only when the key is absent. */
export function getOr(object, key, fallback) {
  if (object instanceof Map) return object.has(key) ? object.get(key) : fallback;
  if (isDict(object) && Object.hasOwn(object, key)) return object[key];
  return fallback;
}

export function has(object, key) {
  if (object instanceof Map) return object.has(key);
  return isDict(object) && Object.hasOwn(object, key);
}

export function keys(object) {
  if (object instanceof Map) return [...object.keys()];
  return isDict(object) ? Object.keys(object) : [];
}

export function entries(object) {
  if (object instanceof Map) return [...object.entries()];
  return isDict(object) ? Object.entries(object) : [];
}

export function size(object) {
  if (object instanceof Map) return object.size;
  if (Array.isArray(object)) return object.length;
  if (typeof object === "string") return cpLen(object);
  return isDict(object) ? Object.keys(object).length : 0;
}

/** Python truthiness. */
export function truthy(value) {
  if (value === undefined || value === null || value === false) return false;
  if (value === true) return true;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "bigint") return value !== 0n;
  if (typeof value === "string") return value.length > 0;
  if (value instanceof PyFloat) return value.value !== 0 && !Number.isNaN(value.value);
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  if (isDict(value)) return Object.keys(value).length > 0;
  return true;
}

/** Python `a or b`. */
export function or(value, fallback) {
  return truthy(value) ? value : fallback;
}

// --- JSON

let sourceSupported = false;
try {
  JSON.parse("1.0", (_key, value, context) => {
    sourceSupported = context !== undefined && context.source === "1.0";
    return value;
  });
} catch {
  sourceSupported = false;
}

function reviver(_key, value, context) {
  if (typeof value === "number") {
    const source = context.source;
    for (let i = 0; i < source.length; i += 1) {
      const c = source.charCodeAt(i);
      if (c === 46 || c === 101 || c === 69) return new PyFloat(value);
    }
    if (!Number.isSafeInteger(value)) return BigInt(source);
    // Python reads the integer -0 as 0.
    if (value === 0) return 0;
  }
  return value;
}

const INDEX_KEY = /"(?:0|[1-9][0-9]*)"\s*:/;

/**
 * JSON text to values the way Python's json.loads reads it (see the header). NaN, Infinity and
 * -Infinity are accepted, as Python accepts them.
 */
export function parseJson(text) {
  if (sourceSupported && !INDEX_KEY.test(text)) {
    try {
      return JSON.parse(text, reviver);
    } catch {
      // NaN or Infinity, or invalid JSON: the slow parser accepts the first and reports the second.
    }
  }
  return new SlowParser(text).parse();
}

const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;

class SlowParser {
  constructor(text) {
    this.text = text;
    this.i = 0;
  }

  parse() {
    const value = this.value();
    this.ws();
    if (this.i !== this.text.length) this.fail("extra data");
    return value;
  }

  fail(what) {
    throw new SyntaxError(`invalid JSON (${what}) at character ${this.i}`);
  }

  ws() {
    const text = this.text;
    while (this.i < text.length) {
      const c = text.charCodeAt(this.i);
      if (c === 32 || c === 9 || c === 10 || c === 13) this.i += 1;
      else break;
    }
  }

  literal(word, value) {
    if (this.text.startsWith(word, this.i)) {
      this.i += word.length;
      return value;
    }
    return this.fail("unexpected character");
  }

  value() {
    this.ws();
    const text = this.text;
    const c = text[this.i];
    if (c === "{") {
      this.i += 1;
      const map = new Map();
      this.ws();
      if (text[this.i] === "}") {
        this.i += 1;
        return map;
      }
      for (;;) {
        this.ws();
        if (text[this.i] !== '"') this.fail("expected a key");
        const key = this.string();
        this.ws();
        if (text[this.i] !== ":") this.fail("expected ':'");
        this.i += 1;
        map.set(key, this.value());
        this.ws();
        if (text[this.i] === ",") {
          this.i += 1;
          continue;
        }
        if (text[this.i] === "}") {
          this.i += 1;
          return map;
        }
        this.fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      this.i += 1;
      const list = [];
      this.ws();
      if (text[this.i] === "]") {
        this.i += 1;
        return list;
      }
      for (;;) {
        list.push(this.value());
        this.ws();
        if (text[this.i] === ",") {
          this.i += 1;
          continue;
        }
        if (text[this.i] === "]") {
          this.i += 1;
          return list;
        }
        this.fail("expected ',' or ']'");
      }
    }
    if (c === '"') return this.string();
    if (c === "t") return this.literal("true", true);
    if (c === "f") return this.literal("false", false);
    if (c === "n") return this.literal("null", null);
    if (c === "N") return this.literal("NaN", new PyFloat(NaN));
    if (c === "I") return this.literal("Infinity", new PyFloat(Infinity));
    if (c === "-" && text[this.i + 1] === "I") return this.literal("-Infinity", new PyFloat(-Infinity));
    NUMBER.lastIndex = this.i;
    const match = NUMBER.exec(text);
    if (!match) return this.fail("unexpected character");
    this.i += match[0].length;
    if (match[1] !== undefined || match[2] !== undefined) return new PyFloat(Number(match[0]));
    const number = Number(match[0]);
    if (number === 0) return 0;
    return Number.isSafeInteger(number) ? number : BigInt(match[0]);
  }

  string() {
    const text = this.text;
    const start = this.i;
    let j = start + 1;
    let escaped = false;
    for (;;) {
      const c = text.charCodeAt(j);
      if (Number.isNaN(c)) this.fail("unterminated string");
      if (c === 34) break;
      if (c === 92) {
        escaped = true;
        j += 2;
        continue;
      }
      j += 1;
    }
    this.i = j + 1;
    return escaped ? JSON.parse(text.slice(start, j + 1)) : text.slice(start + 1, j);
  }
}

/** Python repr() of a float. */
export function pyFloatRepr(value) {
  if (Number.isNaN(value)) return "nan";
  if (value === Infinity) return "inf";
  if (value === -Infinity) return "-inf";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const sign = value < 0 ? "-" : "";
  const [mantissa, exponentText] = Math.abs(value).toExponential().split("e");
  const digits = mantissa.replace(".", "");
  const exponent = Number(exponentText);
  if (exponent < -4 || exponent >= 16) {
    const head = digits[0] + (digits.length > 1 ? "." + digits.slice(1) : "");
    return sign + head + "e" + (exponent < 0 ? "-" : "+") + String(Math.abs(exponent)).padStart(2, "0");
  }
  if (exponent >= 0) {
    const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, "0");
    const fraction = digits.slice(exponent + 1);
    return sign + whole + "." + (fraction || "0");
  }
  return sign + "0." + "0".repeat(-exponent - 1) + digits;
}

function jsonFloat(value) {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  return pyFloatRepr(value);
}

function asciiString(text) {
  return JSON.stringify(text).replace(/[\u007f-\uffff]/g, (c) => (c === "\u007f" ? c : "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")));
}

function dumps(value, quote) {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return quote(value);
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : jsonFloat(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof PyFloat) return jsonFloat(value.value);
  if (Array.isArray(value)) return "[" + value.map((item) => dumps(item, quote)).join(", ") + "]";
  if (isDict(value)) return "{" + entries(value).map(([k, v]) => quote(k) + ": " + dumps(v, quote)).join(", ") + "}";
  return quote(String(value));
}

/** Python json.dumps(value, ensure_ascii=False). */
export function pyDumps(value) {
  return dumps(value, JSON.stringify);
}

/** Python json.dumps(value), non-ASCII characters escaped. */
export function pyDumpsAscii(value) {
  return dumps(value, asciiString);
}

/** Python repr(). */
export function pyRepr(value) {
  if (typeof value === "string") {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    let out = "";
    for (const c of value) {
      const code = c.codePointAt(0);
      if (c === "\\") out += "\\\\";
      else if (c === quote) out += "\\" + c;
      else if (c === "\n") out += "\\n";
      else if (c === "\r") out += "\\r";
      else if (c === "\t") out += "\\t";
      else if (code < 0x20 || (code >= 0x7f && code <= 0xa0)) out += "\\x" + code.toString(16).padStart(2, "0");
      else out += c;
    }
    return quote + out + quote;
  }
  if (Array.isArray(value)) return "[" + value.map(pyRepr).join(", ") + "]";
  if (isDict(value)) return "{" + entries(value).map(([k, v]) => pyRepr(k) + ": " + pyRepr(v)).join(", ") + "}";
  return pyStr(value);
}

/** Python str(), as an f-string prints a value. */
export function pyStr(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : pyFloatRepr(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof PyFloat) return pyFloatRepr(value.value);
  return pyRepr(value);
}

/** A number as Python's str() prints it. */
export function formatNumber(value) {
  return pyStr(value);
}

function toDouble(value) {
  if (value instanceof PyFloat) return value.value;
  if (typeof value === "bigint") return Number(value);
  return Number(value);
}

/** A parsed JSON number (number, BigInt or PyFloat) as a JavaScript number, for comparisons. */
export function num(value) {
  return toDouble(value);
}

/** Python format(value, ".<digits>f"): exact binary value, rounded half to even. */
export function pyFixed(value, digits) {
  const x = toDouble(value);
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  const negative = x < 0 || Object.is(x, -0);
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(x));
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  let mantissa = bits & 0xfffffffffffffn;
  let exponent;
  if (biased === 0) exponent = -1074;
  else {
    mantissa |= 1n << 52n;
    exponent = biased - 1075;
  }
  const scale = 10n ** BigInt(digits);
  let q;
  if (exponent >= 0) q = (mantissa << BigInt(exponent)) * scale;
  else {
    const numerator = mantissa * scale;
    const denominator = 1n << BigInt(-exponent);
    q = numerator / denominator;
    const twice = (numerator % denominator) * 2n;
    if (twice > denominator || (twice === denominator && q % 2n === 1n)) q += 1n;
  }
  let text = q.toString().padStart(digits + 1, "0");
  if (digits > 0) text = text.slice(0, text.length - digits) + "." + text.slice(text.length - digits);
  return (negative ? "-" : "") + text;
}

/** Python format(value, "X"). */
export function pyHex(value) {
  const n = BigInt(value instanceof PyFloat ? value.value : value);
  return n < 0n ? "-" + (-n).toString(16).toUpperCase() : n.toString(16).toUpperCase();
}

// --- strings

const SURROGATE = /[\uD800-\uDFFF]/;

/** Python len() of a string: code points. */
export function cpLen(text) {
  if (!SURROGATE.test(text)) return text.length;
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

/** Python text[:count] by code points. */
export function cpSlice(text, count) {
  if (!SURROGATE.test(text)) return text.slice(0, count);
  let out = "";
  let n = 0;
  for (const c of text) {
    if (n >= count) break;
    out += c;
    n += 1;
  }
  return out;
}

const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_LSTRIP = new RegExp(`^[${PY_SPACE}]+`);
const PY_RSTRIP = new RegExp(`[${PY_SPACE}]+$`);

/** Python str.strip() with no argument. */
export function pyStrip(text) {
  return text.replace(PY_LSTRIP, "").replace(PY_RSTRIP, "");
}

/** Python str.rstrip() with no argument. */
export function pyRstrip(text) {
  return text.replace(PY_RSTRIP, "");
}

/** Python str.strip(chars) / rstrip(chars) for one character. */
export function stripChar(text, char, left = true, right = true) {
  let start = 0;
  let end = text.length;
  if (left) while (start < end && text[start] === char) start += 1;
  if (right) while (end > start && text[end - 1] === char) end -= 1;
  return text.slice(start, end);
}

/** Python str.lower(). */
export function pyLower(text) {
  return text.toLowerCase();
}

function rank(code) {
  // Code point order for UTF-16 units: surrogates (astral characters) sort above U+E000..U+FFFF.
  if (code >= 0xd800 && code <= 0xdfff) return code + 0x2000;
  if (code >= 0xe000) return code - 0x800;
  return code;
}

/** Python string comparison (code points), as a sort comparator. */
export function cmpStr(a, b) {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) {
      if (x < 0xd800 && y < 0xd800) return x < y ? -1 : 1;
      return rank(x) < rank(y) ? -1 : 1;
    }
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

/** Python comparison of two values of the same kind: strings, numbers, booleans, tuples. */
export function cmpPy(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i += 1) {
      const c = cmpPy(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  if (typeof a === "string" && typeof b === "string") return cmpStr(a, b);
  const x = typeof a === "boolean" ? Number(a) : a;
  const y = typeof b === "boolean" ? Number(b) : b;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Python sorted() of strings. */
export function sortedStrings(items) {
  return [...items].sort(cmpStr);
}

/** Python sorted() of tuples (arrays) or other comparable values. */
export function sortedPy(items) {
  return [...items].sort(cmpPy);
}

/** Python sorted(items, key=key): stable, keys compared as Python compares them. */
export function sortedBy(items, key) {
  const decorated = [...items].map((item, index) => ({ item, key: key(item), index }));
  decorated.sort((a, b) => cmpPy(a.key, b.key) || a.index - b.index);
  return decorated.map((entry) => entry.item);
}

const NATURAL_SPLIT = /([0-9]+)/;

function compareDigits(a, b) {
  const x = a.replace(/^0+/, "");
  const y = b.replace(/^0+/, "");
  if (x.length !== y.length) return x.length < y.length ? -1 : 1;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The natural sort key of make_docs.py: digit runs by value, other text lowercased. */
export function naturalKey(text) {
  return pyStr(text).split(NATURAL_SPLIT).map((part, index) => (index % 2 === 1 ? { digits: part } : part.toLowerCase()));
}

export function cmpNatural(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i];
    const y = b[i];
    const c = typeof x === "string" ? cmpStr(x, y) : compareDigits(x.digits, y.digits);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

/** Python collections.Counter(...).most_common(n): by count, descending, first seen first. */
export function mostCommon(counter, n = Infinity) {
  const list = [...counter.entries()].map(([key, count], index) => ({ key, count, index }));
  list.sort((a, b) => b.count - a.count || a.index - b.index);
  return list.slice(0, n).map((entry) => [entry.key, entry.count]);
}

export function countInto(counter, key) {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

// --- shared markdown helpers of make_docs.py

const GUID_SUFFIX = /^(.*?)_\p{Nd}+_[0-9A-Fa-f]{32}$/su;
export const MAX_CELL = 160;

/** A Blueprint-made member is stored as Name_<n>_<32 hex digits>; returns the Name part. */
export function readable(name) {
  const match = GUID_SUFFIX.exec(name);
  return match ? match[1] : name;
}

/** The last name in an object path: /Game/A/B.C:D gives D. */
export function leaf(path) {
  if (!truthy(path)) return "";
  const parts = path.split(/[.:]/);
  return parts[parts.length - 1];
}

/** Text made safe for a markdown table cell. */
export function md(value) {
  // "](" is broken up so that game text which looks like a markdown link is not read as one
  // (the Python builder did not do this; a value with "](" is the only place the output differs).
  const text = pyStr(value).replaceAll("|", "\\|").replaceAll("\r", " ").replaceAll("\n", " ").replaceAll("](", "]\\(");
  return cpLen(text) <= MAX_CELL ? text : cpSlice(text, MAX_CELL - 1) + "…";
}

// --- paths, as Python's os.path on Windows treats these relative, "/"-separated paths

/** os.path.dirname. */
export function dirname(path) {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (at < 0) return "";
  let head = path.slice(0, at + 1);
  const stripped = head.replace(/[\\/]+$/, "");
  return stripped || head;
}

/** os.path.basename. */
export function basename(path) {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return at < 0 ? path : path.slice(at + 1);
}

function parts(path) {
  const out = [];
  for (const part of path.split(/[\\/]+/)) {
    if (!part || part === ".") continue;
    if (part === ".." && out.length && out[out.length - 1] !== "..") out.pop();
    else out.push(part);
  }
  return out;
}

/** os.path.relpath(path, start) on Windows, with "/" separators: components compare without case. */
export function relpath(path, start) {
  const to = parts(path);
  const from = parts(start);
  let i = 0;
  while (i < to.length && i < from.length && to[i].toLowerCase() === from[i].toLowerCase()) i += 1;
  const out = [...Array(from.length - i).fill(".."), ...to.slice(i)];
  return out.length ? out.join("/") : ".";
}

/** os.path.normpath(os.path.join(folder, target)) with "/" separators. */
export function joinNormal(folder, target) {
  const joined = folder ? folder + "/" + target : target;
  const out = parts(joined);
  return out.length ? out.join("/") : ".";
}

// --- reading files

/**
 * Calls `onLine(line, number)` for every line of a text file, read in chunks so that a file of
 * hundreds of megabytes is never held whole. Lines split at "\n", "\r\n" and "\r" as Python's
 * universal newlines do; the line ending is not passed.
 */
export function eachLine(path, onLine) {
  const fd = openSync(path, "r");
  let number = 0;
  try {
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(1 << 22);
    let pending = "";
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      const eof = read === 0;
      pending += eof ? decoder.end() : decoder.write(buffer.subarray(0, read));
      let start = 0;
      let at = 0;
      let cr = pending.indexOf("\r");
      for (;;) {
        const lf = pending.indexOf("\n", at);
        if (cr >= 0 && cr < at) cr = pending.indexOf("\r", at);
        let end;
        if (cr >= 0 && (lf < 0 || cr < lf)) end = cr;
        else end = lf;
        if (end < 0) break;
        if (end === cr && end + 1 === pending.length && !eof) break;
        onLine(pending.slice(start, end), number);
        number += 1;
        at = end === cr && pending.charCodeAt(end + 1) === 10 ? end + 2 : end + 1;
        start = at;
      }
      pending = pending.slice(start);
      if (eof) break;
    }
    if (pending) onLine(pending, number);
  } finally {
    closeSync(fd);
  }
}

/** The JSON objects of a .jsonl file, without its header line (blank lines skipped). */
export function readJsonLines(path, onRecord) {
  eachLine(path, (line, number) => {
    const text = pyStrip(line);
    if (number && text) onRecord(parseJson(text));
  });
}
