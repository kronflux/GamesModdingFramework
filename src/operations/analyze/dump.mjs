// Shared reader for engine dump data used by the analyze.* operations.
//
// A dump file is JSON shaped like:
//   {
//     "version": 1,
//     "engine": "unity" | "unreal",
//     "entrypoints": [...], "classes": [...], "objects": [...],
//     "references": [...], "assets": [...], "strings": [...]
//   }
// Files live under <workspace>/dumps, under profile.paths.dumps, or in the path
// given by profile.dumpDir. Every section is optional and sections from several
// dump files are merged. Only metadata is copied into results; decompiled bodies
// and raw byte payloads are dropped so an operation never returns game content.

import fs from "node:fs";
import path from "node:path";
import { evidence } from "../../core/evidence.mjs";

export const ANALYSIS_SECTIONS = Object.freeze([
  "entrypoints",
  "classes",
  "objects",
  "references",
  "assets",
  "strings",
]);

// Keys that would carry decompiled code, raw bytes or a conflicting provenance.
const RESERVED_KEYS = new Set([
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
]);

const QUERY_KEYS = new Set([
  "class",
  "className",
  "from",
  "fullName",
  "kind",
  "module",
  "name",
  "namespace",
  "objectPath",
  "path",
  "signature",
  "to",
  "type",
  "value",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function analysisError(message, remediation) {
  const error = new Error(message);
  error.code = "GMF-E-EXEC-001";
  error.remediation = remediation;
  return error;
}

// Relative paths such as gmf.profile.json belong to the workspace, not to the
// framework checkout that context.root names.
function baseDir(context = {}) {
  return context.workspace?.root || context.cwd || context.root || process.cwd();
}

function resolveFromBase(target, context) {
  return path.isAbsolute(target) ? path.resolve(target) : path.resolve(baseDir(context), target);
}

export function resolveProfile(input, context = {}) {
  if (isObject(input)) return input;
  if (typeof input !== "string" || input.trim() === "") {
    throw analysisError(
      "profile must be a profile object or a path to a profile JSON file",
      "Pass the profile object from gmf.profile.json or the path to that file.",
    );
  }
  const value = input.trim();
  if (value.startsWith("{")) {
    try {
      return JSON.parse(value);
    } catch {
      throw analysisError(
        "profile string is not valid JSON",
        "Pass a profile object or a path to a profile JSON file.",
      );
    }
  }
  const file = resolveFromBase(value, context);
  if (!fs.existsSync(file)) {
    throw analysisError(
      `Profile file does not exist: ${file}`,
      "Run gmf investigate to write gmf.profile.json first.",
    );
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw analysisError(
      `Profile file is not valid JSON: ${file}`,
      "Run gmf investigate to write gmf.profile.json again.",
    );
  }
}

export function dumpRoots(profile, context = {}) {
  const roots = [];
  const declared = profile?.paths?.dumps ?? profile?.dumpDir ?? profile?.dumps?.dir;
  if (typeof declared === "string" && declared.trim() !== "") {
    roots.push(resolveFromBase(declared, context));
  }
  const localDumpDir = context.workspace?.local?.dumpsDir;
  if (typeof localDumpDir === "string" && localDumpDir.trim() !== "") {
    roots.push(resolveFromBase(localDumpDir, context));
  }
  if (typeof context.workspace?.root === "string" && context.workspace.root) {
    roots.push(path.join(context.workspace.root, "dumps"));
  }
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

// Collected dumper runs live under <dumps>/unreal/runs. Their files are raw reflection data, not
// normalized dumps, so the readers do not look inside.
const COLLECTED_RUNS = "unreal/runs";

function walkJson(dir, files = [], top = dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path.relative(top, full).split(path.sep).join("/") === COLLECTED_RUNS) continue;
      walkJson(full, files, top);
    }
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) files.push(full);
  }
  return files;
}

function collectDumpFiles(root) {
  let stat;
  try {
    stat = fs.statSync(root);
  } catch {
    return [];
  }
  if (stat.isFile()) return root.toLowerCase().endsWith(".json") ? [root] : [];
  return walkJson(root);
}

export function loadDumpSection({ profile, context = {}, section }) {
  if (!ANALYSIS_SECTIONS.includes(section)) throw new Error(`Unknown analysis section: ${section}`);

  const roots = dumpRoots(profile, context);
  const existing = roots.filter((root) => fs.existsSync(root));
  if (existing.length === 0) {
    throw analysisError(
      `No engine dump directory found while reading ${section}; looked in ${
        roots.length > 0 ? roots.join(", ") : "(no dump path)"
      }`,
      "Run the engine dump first: unity.decompile for Unity or unreal.dump for Unreal.",
    );
  }

  const engine = profile?.engine?.id;
  const files = [...new Set(existing.flatMap((root) => collectDumpFiles(root)))].sort();
  const entries = [];
  const sources = [];
  const skipped = [];

  for (const file of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      skipped.push(file);
      continue;
    }
    if (!isObject(data)) continue;
    if (
      typeof data.engine === "string" &&
      typeof engine === "string" &&
      engine !== "unknown" &&
      data.engine !== engine
    ) {
      continue;
    }
    if (!Array.isArray(data[section])) continue;
    const records = data[section].filter((entry) => isObject(entry));
    for (const entry of records) entries.push({ entry, source: path.resolve(file) });
    sources.push({ file: path.resolve(file), count: records.length });
  }

  return { entries, sources, skipped };
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (isObject(value)) {
    const copy = {};
    for (const [key, inner] of Object.entries(value)) {
      if (RESERVED_KEYS.has(key)) continue;
      copy[key] = sanitize(inner);
    }
    return copy;
  }
  return value;
}

function label(entry) {
  for (const key of ["name", "fullName", "value", "from", "path", "to"]) {
    if (typeof entry[key] === "string" && entry[key].trim() !== "") return entry[key];
  }
  return "entry";
}

export function buildResult(entry, source, { operation, engine }) {
  const name = label(entry);
  return {
    ...sanitize(entry),
    source,
    evidence: evidence({
      claim: `${operation} read ${name} from the engine dump`,
      confidence: "observed",
      authority: "shipped-artifact",
      source,
      detail: { operation, engine: engine || null, name },
    }),
  };
}

// Return what in an entry matches the query: "name", "path" and the other
// identity keys by name, "method:<m>" and "field:<f>" for members, or an empty
// list. An empty or absent query matches everything with no reasons.
export function queryMatches(entry, query) {
  if (query === undefined || query === null) return [];
  const needle = String(query).trim().toLowerCase();
  if (needle === "") return [];
  const reasons = [];
  const hit = (text) => typeof text === "string" && text.toLowerCase().includes(needle);
  for (const [key, value] of Object.entries(entry)) {
    if (key === "methods" || key === "fields") {
      const label = key === "methods" ? "method" : "field";
      for (const item of Array.isArray(value) ? value : []) {
        const memberName = typeof item === "string" ? item : isObject(item) ? item.name : null;
        if (hit(memberName)) reasons.push(`${label}:${memberName}`);
      }
      continue;
    }
    if (!QUERY_KEYS.has(key)) continue;
    if (hit(value)) reasons.push(key);
    else if (Array.isArray(value) && value.some((item) => hit(item) || (isObject(item) && hit(item.name)))) reasons.push(key);
  }
  return reasons;
}

export function matchesQuery(entry, query) {
  if (query === undefined || query === null || String(query).trim() === "") return true;
  return queryMatches(entry, query).length > 0;
}

export function createAnalyzeOperation({ id, section, title, summary }) {
  if (!ANALYSIS_SECTIONS.includes(section)) throw new Error(`Unknown analysis section: ${section}`);

  const descriptor = {
    id,
    title,
    summary,
    engine: "core",
    inputs: {
      type: "object",
      properties: {
        profile: {
          description: "Profile object, or a path to a gmf.profile.json file; a relative path resolves in the workspace.",
        },
        query: {
          type: "string",
          description:
            "Case-insensitive substring filter over names, paths, kinds, values, method names and field names. Each result lists its matches, such as name or field:Stamina. Empty or absent returns every entry.",
        },
      },
      required: ["profile"],
    },
    outputs: {
      type: "object",
      properties: {
        results: {
          type: "array",
          description: "Dump metadata records, each with a source path and an evidence record.",
          items: { type: "object" },
        },
        skipped: {
          type: "array",
          description: "Dump files that were not valid JSON and so contributed nothing.",
          items: { type: "string" },
        },
      },
      required: ["results"],
    },
    effects: ["read"],
    requires: [],
    gates: ["auto"],
    skill: "gmf-investigate",
    docs: [],
  };

  const handler = async (inputs = {}, context = {}) => {
    const profile = resolveProfile(inputs.profile, context);
    const { entries, sources, skipped } = loadDumpSection({ profile, context, section });
    const results = entries
      .filter(({ entry }) => matchesQuery(entry, inputs.query))
      .map(({ entry, source }) => {
        const result = buildResult(entry, source, { operation: id, engine: profile?.engine?.id || null });
        const matches = queryMatches(entry, inputs.query);
        return matches.length > 0 ? { ...result, matches } : result;
      });
    const records = sources.map(({ file, count }) =>
      evidence({
        claim: `Read ${count} ${section} records for ${id} from the engine dump`,
        confidence: "observed",
        authority: "shipped-artifact",
        source: file,
        detail: { operation: id, section, count },
      }),
    );
    return { data: { results, skipped }, evidence: records };
  };

  return { descriptor, handler };
}
