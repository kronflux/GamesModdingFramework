// Validation and writer for normalized engine dumps.
//
// A normalized dump is the JSON shape the analyze.* operations read (see
// dump.mjs). Producers call validateDump before writeNormalizedDump so a dump
// can never carry decompiled bodies, raw bytes or other reserved keys.

import fs from "node:fs";
import path from "node:path";
import { ANALYSIS_SECTIONS } from "./dump.mjs";
import { isInside } from "../../core/fsutil.mjs";

export const DUMP_VERSION = 1;
export const DUMP_ENGINES = ["unity", "unreal"];

// Keys the reader strips; a producer that emits one has leaked content.
export const RESERVED_DUMP_KEYS = [
  "base64",
  "blob",
  "body",
  "bytes",
  "code",
  "content",
  "decompiled",
  "evidence",
  "hex",
  "il",
  "il2cpp",
  "raw",
  "source",
  "text",
];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function dumpError(message, remediation) {
  const error = new Error(message);
  error.code = "GMF-E-DUMP-001";
  error.remediation = remediation;
  return error;
}

function findReserved(value, trail = []) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const hit = findReserved(value[index], [...trail, String(index)]);
      if (hit) return hit;
    }
    return null;
  }
  if (!isObject(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    if (RESERVED_DUMP_KEYS.includes(key)) return [...trail, key].join(".");
    const hit = findReserved(child, [...trail, key]);
    if (hit) return hit;
  }
  return null;
}

export function validateDump(dump) {
  if (!isObject(dump)) throw dumpError("dump must be an object", "Produce a normalized dump object.");
  if (dump.version !== DUMP_VERSION) {
    throw dumpError(`dump.version must be ${DUMP_VERSION}`, "Set version to 1.");
  }
  if (!DUMP_ENGINES.includes(dump.engine)) {
    throw dumpError(`dump.engine must be one of ${DUMP_ENGINES.join(", ")}`, "Set engine to unity or unreal.");
  }
  for (const section of ANALYSIS_SECTIONS) {
    if (dump[section] !== undefined && !Array.isArray(dump[section])) {
      throw dumpError(`dump.${section} must be an array`, `Emit ${section} as an array of records.`);
    }
  }
  const reserved = findReserved(dump);
  if (reserved) {
    throw dumpError(
      `dump contains the reserved key ${reserved}; bodies, raw bytes and sources never enter a dump`,
      "Remove the key from the producer output.",
    );
  }
  return dump;
}

export function emptyDump(engine) {
  const dump = { version: DUMP_VERSION, engine };
  for (const section of ANALYSIS_SECTIONS) dump[section] = [];
  return dump;
}

// Write a validated dump to <root>/dumps/<fileName> and return the path. The
// file name may not escape the dumps folder.
export function writeNormalizedDump(root, fileName, dump) {
  validateDump(dump);
  const dumpsDir = path.resolve(root, "dumps");
  const target = path.resolve(dumpsDir, fileName);
  if (!isInside(dumpsDir, target)) {
    throw dumpError(`dump file must be inside ${dumpsDir}`, "Pass a plain file name such as unity-mono.json.");
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(dump, null, 2)}\n`);
  return target;
}

export function dedupeStrings(values, limit = 20000) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    out.push({ value });
    if (out.length >= limit) break;
  }
  return out;
}
