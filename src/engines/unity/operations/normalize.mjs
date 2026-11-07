// unity.normalize_dump: build a normalized dump from a decompiled C# tree
// (ilspycmd project output, Il2CppDumper dump.cs) or a Cpp2IL text dump.
//
// Only metadata is kept: class names, namespaces, assemblies, member names,
// type references and string literals. Method bodies never enter the dump.

import fs from "node:fs";
import path from "node:path";
import { registerOperation, getHandler } from "../../../core/operations.mjs";
import { evidence } from "../../../core/evidence.mjs";
import { assertInside } from "../../../core/workspace.mjs";
import { emptyDump, dedupeStrings, writeNormalizedDump } from "../../../operations/analyze/normalize.mjs";
import { backendFor } from "./defaults.mjs";

const LIFECYCLE = new Set(["Awake", "Start", "Update", "FixedUpdate", "LateUpdate", "OnEnable", "OnDisable", "OnDestroy", "Main"]);
const PLUGIN_ATTRIBUTES = /\[(BepInPlugin|MelonInfo|BepInProcess)\b/;
const TYPE_RE = /^\s*(?:\[[^\]]*\]\s*)*(?:(?:public|private|protected|internal|static|sealed|abstract|partial|readonly|unsafe|new)\s+)*(class|struct|interface|enum)\s+([A-Za-z_][\w]*)/;
const NAMESPACE_RE = /^\s*namespace\s+([A-Za-z_][\w.]*)/;
const METHOD_RE = /^\s*(?:\[[^\]]*\]\s*)*(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|extern|unsafe|async|new|partial)\s+)+[\w<>\[\],.?]+\s+([A-Za-z_][\w]*)\s*(?:<[^>]*>)?\s*\(/;
const FIELD_RE = /^\s*(?:\[[^\]]*\]\s*)*(?:(?:public|private|protected|internal|static|readonly|volatile|const|new)\s+)+[\w<>\[\],.?]+\s+([A-Za-z_][\w]*)\s*(?:=[^;]*)?;/;
const STRING_RE = /"((?:[^"\\]|\\.)*)"/g;
const WORD_RE = /\b([A-Z][A-Za-z0-9_]*)\b/g;

function listFiles(dir, ext, found = []) {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, ext, found);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(ext)) found.push(full);
  }
  return found;
}

// Cpp2IL writes one folder per output format (DiffableCs/, DummyDll/, ...)
// with one folder per assembly inside it.
const FORMAT_FOLDERS = new Set(["diffablecs", "dummydll", "isildump", "isil"]);

function assemblyFor(root, file) {
  let relative = path.relative(root, file).split(/[\\/]/);
  if (relative.length > 2 && FORMAT_FOLDERS.has(relative[0].toLowerCase())) relative = relative.slice(1);
  return relative.length > 1 ? relative[0] : path.basename(file, path.extname(file));
}

const FIELD_OFFSET_RE = /\/\/\s*Field offset:\s*(0x[0-9A-Fa-f]+)/;

const blank = (text) => text.replace(/[^\r\n]/g, " ");

// Splits C# source into its code and its string literals. The returned code
// keeps every line and column, with comments and the inside of string and
// character literals replaced by spaces, so brace counting and pattern
// matching see only code. Handles regular, verbatim (@""), interpolated and
// raw (""") strings.
function scanSource(text) {
  let code = "";
  const strings = [];
  const length = text.length;
  let i = 0;
  while (i < length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      let stop = text.indexOf("\n", i);
      if (stop < 0) stop = length;
      code += blank(text.slice(i, stop));
      i = stop;
    } else if (ch === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      const stop = close < 0 ? length : close + 2;
      code += blank(text.slice(i, stop));
      i = stop;
    } else if (ch === '"' && text.startsWith('"""', i)) {
      const close = text.indexOf('"""', i + 3);
      const stop = close < 0 ? length : close + 3;
      strings.push(text.slice(i + 3, close < 0 ? length : close));
      code += '"""' + blank(text.slice(i + 3, close < 0 ? length : close)) + (close < 0 ? "" : '"""');
      i = stop;
    } else if (ch === '"') {
      let k = i - 1;
      let verbatim = false;
      while (k >= 0 && (text[k] === "@" || text[k] === "$")) {
        if (text[k] === "@") verbatim = true;
        k -= 1;
      }
      let j = i + 1;
      while (j < length) {
        if (verbatim) {
          if (text[j] === '"') {
            if (text[j + 1] === '"') j += 2;
            else break;
          } else j += 1;
        } else if (text[j] === "\\") j += 2;
        else if (text[j] === '"' || text[j] === "\n") break;
        else j += 1;
      }
      const content = text.slice(i + 1, Math.min(j, length));
      strings.push(content);
      code += '"' + blank(content) + (text[j] === '"' ? '"' : "");
      i = j + (text[j] === '"' ? 1 : 0);
    } else if (ch === "'") {
      const close = text.slice(i + 2, i + 12).search(/'|\n/);
      if (close >= 0 && text[i + 2 + close] === "'") {
        const stop = i + 2 + close + 1;
        code += "'" + blank(text.slice(i + 1, stop - 1)) + "'";
        i = stop;
      } else {
        code += ch;
        i += 1;
      }
    } else {
      code += ch;
      i += 1;
    }
  }
  return { code, strings };
}

// Parse one C# file into class records. Namespaces nest by brace depth; a
// class body is skipped for members only by depth, not by reading its code.
// bodies[i] is the code (no comments or literals) of classes[i], used to find
// the types that class mentions.
export function parseCSharp(text, assembly) {
  const classes = [];
  const spans = [];
  const namespaceStack = [];
  const classStack = [];
  const { code, strings } = scanSource(text);
  const codeLines = code.split(/\r?\n/);
  const rawLines = text.split(/\r?\n/);
  let depth = 0;
  let pluginPending = false;
  for (const [index, line] of codeLines.entries()) {
    // A loader attribute decorates the next type, which may be on this line.
    if (PLUGIN_ATTRIBUTES.test(line)) pluginPending = true;
    const ns = line.match(NAMESPACE_RE);
    if (ns) {
      namespaceStack.push({ name: ns[1], depth });
    }
    const type = line.match(TYPE_RE);
    if (type) {
      const record = {
        name: type[2],
        kind: type[1],
        namespace: namespaceStack.map((n) => n.name).join("."),
        assembly,
        methods: [],
        fields: [],
        plugin: pluginPending,
        _depth: depth,
        _span: { start: index, end: codeLines.length - 1 },
      };
      pluginPending = false;
      classes.push(record);
      classStack.push(record);
    } else if (classStack.length > 0) {
      const current = classStack[classStack.length - 1];
      const method = line.match(METHOD_RE);
      if (method && depth === current._depth + 1) {
        if (!current.methods.includes(method[1])) current.methods.push(method[1]);
      } else {
        const field = line.match(FIELD_RE);
        if (field && depth === current._depth + 1 && !current.fields.some((entry) => entry.name === field[1])) {
          const offset = (rawLines[index] || "").match(FIELD_OFFSET_RE);
          current.fields.push({ name: field[1], offset: offset ? offset[1].toUpperCase().replace(/^0X/, "0x") : null });
        }
      }
    }
    for (const ch of line) {
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        while (namespaceStack.length > 0 && namespaceStack[namespaceStack.length - 1].depth >= depth) namespaceStack.pop();
        while (classStack.length > 0 && classStack[classStack.length - 1]._depth >= depth) {
          classStack.pop().$ended = index;
        }
      }
    }
  }
  const bodies = classes.map((record) => {
    const last = record.$ended === undefined ? record._span.end : record.$ended;
    return codeLines.slice(record._span.start, last + 1).join("\n");
  });
  for (const record of classes) {
    delete record._depth;
    delete record._span;
    delete record.$ended;
  }
  return { classes, strings, bodies };
}

// Cpp2IL text dump: "Type: Full.Name[ : Base]" blocks with indented
// "Method: Name(...)" and "Field: Name (...)" lines.
export function parseCpp2IlText(text, assembly = "GameAssembly") {
  const classes = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const type = line.match(/^Type:\s*([\w.]+)/);
    if (type) {
      const full = type[1];
      const dot = full.lastIndexOf(".");
      current = {
        name: dot >= 0 ? full.slice(dot + 1) : full,
        kind: "class",
        namespace: dot >= 0 ? full.slice(0, dot) : "",
        assembly,
        methods: [],
        fields: [],
        plugin: false,
      };
      classes.push(current);
      continue;
    }
    if (!current) continue;
    const method = line.match(/^\s+Method:\s*([A-Za-z_][\w]*)/);
    if (method) {
      if (!current.methods.includes(method[1])) current.methods.push(method[1]);
      continue;
    }
    const field = line.match(/^\s+Field:\s*([A-Za-z_][\w]*)/);
    if (field && !current.fields.some((entry) => entry.name === field[1])) current.fields.push({ name: field[1], offset: null });
  }
  return { classes, strings: [] };
}

function qualifiedName(record) {
  return record.namespace ? `${record.namespace}.${record.name}` : record.name;
}

// One edge per pair of classes where the first class's own code mentions the
// second's name. A name shared by several classes is written qualified, and a
// mention of it counts for each of them.
function referencesFor(units, classes) {
  const byName = new Map();
  for (const record of classes) {
    if (!byName.has(record.name)) byName.set(record.name, []);
    byName.get(record.name).push(record);
  }
  const label = (record) => (byName.get(record.name).length > 1 ? qualifiedName(record) : record.name);
  const references = [];
  const seen = new Set();
  for (const unit of units) {
    for (const [index, from] of unit.classes.entries()) {
      for (const match of unit.bodies[index].matchAll(WORD_RE)) {
        for (const to of byName.get(match[1]) || []) {
          if (to === from || to.name === from.name) continue;
          const key = `${label(from)}->${label(to)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          references.push({ from: label(from), to: label(to), kind: "type" });
        }
      }
    }
  }
  return references;
}

const BACKENDS = new Set(["mono", "il2cpp"]);

function assertBackend(backend) {
  if (!BACKENDS.has(backend)) {
    const error = new Error(`GMF-E-EXEC-001: unknown Unity backend: ${backend}`);
    error.code = "GMF-E-EXEC-001";
    error.remediation = "Pass backend mono or il2cpp, or run gmf investigate so the profile records it.";
    throw error;
  }
  return backend;
}

export function normalizeUnityDump({ decompiledDir = null, dumpDir = null, backend = "mono" } = {}) {
  assertBackend(backend);
  const dump = emptyDump("unity");
  const allStrings = [];
  const units = [];

  if (decompiledDir) {
    for (const file of listFiles(decompiledDir, ".cs")) {
      const assembly = assemblyFor(decompiledDir, file);
      const text = fs.readFileSync(file, "utf8");
      const parsed = parseCSharp(text, assembly);
      dump.classes.push(...parsed.classes);
      allStrings.push(...parsed.strings);
      units.push(parsed);
    }
  }
  if (dumpDir) {
    for (const file of listFiles(dumpDir, ".txt")) {
      dump.classes.push(...parseCpp2IlText(fs.readFileSync(file, "utf8")).classes);
    }
    for (const file of listFiles(dumpDir, ".cs")) {
      const parsed = parseCSharp(fs.readFileSync(file, "utf8"), "dump");
      dump.classes.push(...parsed.classes);
      allStrings.push(...parsed.strings);
      units.push(parsed);
    }
  }

  for (const record of dump.classes) {
    for (const method of record.methods) {
      if (LIFECYCLE.has(method)) {
        dump.entrypoints.push({ name: method, kind: "lifecycle", class: record.name, namespace: record.namespace, module: record.assembly });
      }
    }
    if (record.plugin) {
      dump.entrypoints.push({ name: record.name, kind: "plugin", class: record.name, namespace: record.namespace, module: record.assembly });
    }
    delete record.plugin;
  }
  dump.references = referencesFor(units, dump.classes);
  dump.strings = dedupeStrings(allStrings);
  dump.backend = backend;
  return dump;
}

const operation = {
  id: "unity.normalize_dump",
  title: "Normalize a Unity decompile or dump",
  summary:
    "Build the normalized dump JSON the analyze operations read from a decompiled C# tree or a Cpp2IL text dump. Keeps names and members only; no method bodies.",
  engine: "unity",
  inputs: {
    type: "object",
    properties: {
      decompiledDir: { type: "string" },
      dumpDir: { type: "string" },
      backend: { type: "string" },
    },
    required: [],
  },
  outputs: {
    type: "object",
    properties: {
      file: { type: "string" },
      classes: { type: "integer" },
      entrypoints: { type: "integer" },
    },
  },
  effects: ["read", "workspaceWrite"],
  requires: [],
  gates: ["auto"],
  skill: "gmf-investigate",
  docs: [],
  handler: async (inputs, context = {}) => {
    const backend = assertBackend(backendFor(inputs, context));
    const root = context.workspace?.root;
    if (!root) {
      const error = new Error("unity.normalize_dump needs a workspace for the dumps folder");
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Run gmf init first.";
      throw error;
    }
    const decompiledDir = inputs.decompiledDir
      ? assertInside(context.workspace, inputs.decompiledDir)
      : path.join(root, "decompiled", "unity", backend);
    const dumpDir = inputs.dumpDir ? assertInside(context.workspace, inputs.dumpDir) : null;
    if (!fs.existsSync(decompiledDir) && !(dumpDir && fs.existsSync(dumpDir))) {
      const error = new Error(`No decompiled output at ${decompiledDir}`);
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Run unity.decompile first or pass decompiledDir or dumpDir.";
      throw error;
    }
    const dump = normalizeUnityDump({
      decompiledDir: fs.existsSync(decompiledDir) ? decompiledDir : null,
      dumpDir,
      backend,
    });
    const file = writeNormalizedDump(root, `unity-${backend}.json`, dump);
    return {
      data: { file, classes: dump.classes.length, entrypoints: dump.entrypoints.length },
      evidence: [
        evidence({
          claim: `Normalized ${dump.classes.length} Unity classes for analysis`,
          confidence: "derived",
          authority: "shipped-artifact",
          source: file,
          detail: { backend, classes: dump.classes.length, entrypoints: dump.entrypoints.length },
        }),
      ],
    };
  },
};

if (!getHandler(operation.id)) registerOperation(operation, operation.handler);

export default operation;
