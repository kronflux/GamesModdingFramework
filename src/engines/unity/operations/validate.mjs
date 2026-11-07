import fs from "node:fs";
import path from "node:path";
import { registerOperation, getHandler } from "../../../core/operations.mjs";
import { evidence } from "../../../core/evidence.mjs";
import { assertGameDir, findDataDir } from "../detect.mjs";
import { gameDirFor, modDirFor } from "./defaults.mjs";

const ATTRIBUTE_START_RE = /[\[,]\s*(?:[A-Za-z0-9_.]+\.)?HarmonyPatch(?:Attribute)?\b(?!\w)\s*/g;
const TYPEOF_RE = /^typeof\s*\(\s*(?:global::)?([A-Za-z0-9_.]+)\s*(?:<[^()]*>)?\s*\)$/;
const NAMEOF_RE = /^nameof\s*\(\s*([A-Za-z0-9_.]+)\s*\)$/;
const STRING_ARG_RE = /^"([^"\\]*)"$/;
// A parameter type list such as new[] { typeof(int) } selects an overload.
const ARGUMENT_TYPES_RE = /^new\b/;
const METHOD_TYPE_RE = /^(?:HarmonyLib\.)?MethodType\.([A-Za-z]+)$/;

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " ")).replace(/^[ \t]*\/\/.*$/gm, "");
}

// Splits "a, b(c, d), \"e,f\"" at the commas outside brackets and strings.
function splitArguments(text) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      current += ch;
      if (ch === "\\") {
        current += text[i + 1] ?? "";
        i += 1;
      } else if (ch === '"') quoted = false;
    } else if (ch === '"') {
      quoted = true;
      current += ch;
    } else if ("([{<".includes(ch)) {
      depth += 1;
      current += ch;
    } else if (")]}>".includes(ch)) {
      depth -= 1;
      current += ch;
    } else if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += ch;
  }
  if (current.trim() !== "") parts.push(current.trim());
  return parts;
}

// The text between the parentheses that open at index, or null when they do
// not close.
function balancedArguments(text, index) {
  let depth = 0;
  let quoted = false;
  for (let i = index; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === "\\") i += 1;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return { inner: text.slice(index + 1, i), end: i + 1 };
    }
  }
  return null;
}

// One HarmonyPatch attribute: the type (typeof), the method (a string or
// nameof) and a MethodType; arguments after those are ignored. unparsed holds
// the text of an argument that names none of them.
function parseAttribute(inner) {
  const attribute = { type: null, method: null, methodType: null, unparsed: null };
  for (const [position, argument] of splitArguments(inner).entries()) {
    let match;
    if ((match = argument.match(TYPEOF_RE))) attribute.type = match[1];
    else if ((match = argument.match(STRING_ARG_RE))) attribute.method = match[1];
    else if ((match = argument.match(NAMEOF_RE))) attribute.method = match[1].split(".").pop();
    else if ((match = argument.match(METHOD_TYPE_RE))) attribute.methodType = match[1];
    else if (position === 0 && !ARGUMENT_TYPES_RE.test(argument)) attribute.unparsed = argument;
  }
  return attribute;
}

// Every HarmonyPatch target in one source file, with a warning for each
// attribute that could not be read. Consecutive attributes combine into one
// target; a method-only attribute takes the type of the nearest earlier
// type-only attribute.
export function findPatchTargets(rawText) {
  const text = stripComments(rawText);
  const attributes = [];
  ATTRIBUTE_START_RE.lastIndex = 0;
  for (let match = ATTRIBUTE_START_RE.exec(text); match; match = ATTRIBUTE_START_RE.exec(text)) {
    const open = match.index + match[0].length;
    if (text[open] !== "(") {
      ATTRIBUTE_START_RE.lastIndex = open;
      continue;
    }
    const args = balancedArguments(text, open);
    if (!args) {
      attributes.push({ start: match.index, end: text.length, unparsed: text.slice(open).split("\n")[0].trim() });
      break;
    }
    attributes.push({ start: match.index, end: args.end, ...parseAttribute(args.inner) });
    ATTRIBUTE_START_RE.lastIndex = args.end;
  }
  const groups = [];
  for (const attribute of attributes) {
    const previous = groups[groups.length - 1];
    const between = previous ? text.slice(previous.end, attribute.start + 1) : null;
    if (previous && /^[\s\]\[,]*$/.test(between)) {
      previous.type = previous.type || attribute.type;
      previous.method = previous.method || attribute.method;
      previous.methodType = previous.methodType || attribute.methodType;
      previous.unparsed = previous.unparsed || attribute.unparsed;
      previous.end = attribute.end;
    } else {
      groups.push({ ...attribute });
    }
  }
  const targets = [];
  const warnings = [];
  let classType = null;
  for (const group of groups) {
    if (group.unparsed) {
      warnings.push(group.unparsed);
      continue;
    }
    if (group.type && !group.method) classType = group.type;
    const type = group.type || classType;
    if (!type) {
      warnings.push(group.method ? `"${group.method}"` : "HarmonyPatch");
      continue;
    }
    targets.push({ type, method: group.method, methodType: group.methodType });
  }
  return { targets, warnings };
}

function collectSources(modDir) {
  const sources = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["bin", "obj", ".git", "node_modules"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".cs")) {
        sources.push({ file: full, text: fs.readFileSync(full, "utf8") });
      }
    }
  };
  walk(path.resolve(modDir));
  return sources;
}

function collectAssemblies(gameDir, profile) {
  const directories = [];
  if (profile?.paths?.managed) directories.push(profile.paths.managed);
  if (profile?.paths?.interop) directories.push(profile.paths.interop);
  if (directories.length === 0) {
    const dataDir = findDataDir(gameDir);
    if (dataDir) directories.push(path.join(dataDir, "Managed"));
  }
  const assemblies = [];
  for (const dir of directories) {
    if (!dir || !fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".dll")) {
        assemblies.push(path.join(dir, entry.name));
      }
    }
  }
  return assemblies;
}

const isIdentifierByte = (byte) =>
  byte !== undefined && ((byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) || byte === 95);

// True when the name occurs as a whole identifier: the bytes around it (a null
// between string heap entries, a space, a dot) are not identifier characters.
// unit is 1 for single-byte text and 2 for UTF-16.
function hasWholeName(buffer, needle, unit) {
  for (let at = buffer.indexOf(needle); at >= 0; at = buffer.indexOf(needle, at + 1)) {
    const before = at >= unit ? buffer[at - unit] : undefined;
    const after = buffer[at + needle.length];
    const beforeHigh = unit === 2 && at >= 2 ? buffer[at - 1] : 0;
    const afterHigh = unit === 2 ? buffer[at + needle.length + 1] : 0;
    const joinedBefore = isIdentifierByte(before) && beforeHigh === 0;
    const joinedAfter = isIdentifierByte(after) && afterHigh === 0;
    if (!joinedBefore && !joinedAfter) return true;
  }
  return false;
}

function containsName(buffer, name) {
  return hasWholeName(buffer, Buffer.from(name, "utf8"), 1) || hasWholeName(buffer, Buffer.from(name, "utf16le"), 2);
}

function lastSegment(name) {
  return name.slice(name.lastIndexOf(".") + 1);
}

// The member names a patch can mean: a getter or setter patch targets the
// property accessor.
function memberNames(target) {
  if (!target.method) return [];
  if (target.methodType === "Getter") return [`get_${target.method}`, target.method];
  if (target.methodType === "Setter") return [`set_${target.method}`, target.method];
  return [target.method];
}

// Classes from <workspace>/dumps/unity-*.json, or null when there is no dump.
function loadDumpClasses(workspaceRoot) {
  if (!workspaceRoot) return null;
  const dir = path.join(workspaceRoot, "dumps");
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((name) => /^unity-.*\.json$/i.test(name));
  } catch {
    return null;
  }
  const classes = [];
  for (const name of files) {
    try {
      const dump = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      if (Array.isArray(dump.classes)) classes.push(...dump.classes);
    } catch {
      // An unreadable dump is skipped; validation falls back if none is usable.
    }
  }
  return classes.length > 0 ? classes : null;
}

// Every class a type name can mean. "Debug" matches by name; a dotted name
// matches the class whose namespace is the prefix, or whose namespace the
// prefix extends with the names of enclosing classes.
function findClasses(classes, typeName) {
  const dot = typeName.lastIndexOf(".");
  const name = dot >= 0 ? typeName.slice(dot + 1) : typeName;
  const prefix = dot >= 0 ? typeName.slice(0, dot) : null;
  return classes.filter((entry) => {
    if (entry.name !== name) return false;
    if (prefix === null) return true;
    const namespace = entry.namespace || "";
    return namespace === prefix || (namespace !== "" && prefix.startsWith(`${namespace}.`));
  });
}

const operation = {
  id: "unity.validate",
  title: "Validate a Unity mod",
  summary:
    "Check that every Harmony patch in the mod source names a type and method that exists in the game's assemblies.",
  engine: "unity",
  inputs: {
    type: "object",
    properties: {
      modDir: { type: "string" },
      gameDir: { type: "string" },
    },
    required: [],
  },
  outputs: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      errors: { type: "array" },
      warnings: { type: "array" },
      targets: { type: "array" },
    },
  },
  effects: ["read"],
  requires: [],
  gates: ["auto"],
  skill: "unity-testing",
  docs: [],
  handler: async (inputs, context) => {
    const gameDirInput = gameDirFor(inputs, context);
    if (!gameDirInput) {
      const error = new Error("unity.validate needs a game directory");
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Pass --input gameDir=<dir>, or run gmf investigate first.";
      throw error;
    }
    const gameDir = assertGameDir(gameDirInput);
    const modDir = modDirFor(inputs, context);
    if (!modDir) {
      const error = new Error("unity.validate needs a mod project folder");
      error.code = "GMF-E-EXEC-001";
      error.remediation =
        "Pass --input modDir=<dir>, or scaffold exactly one mod so the workspace mods folder has one project.";
      throw error;
    }
    if (!fs.existsSync(modDir) || !fs.statSync(modDir).isDirectory()) {
      const error = new Error(`Mod project folder does not exist: ${modDir}`);
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Run unity.scaffold first or pass the mod project folder.";
      throw error;
    }

    const profile = context.workspace?.profile || null;
    const targets = [];
    const warnings = [];
    for (const source of collectSources(modDir)) {
      const relative = path.relative(modDir, source.file).split(path.sep).join("/");
      const found = findPatchTargets(source.text);
      for (const target of found.targets) {
        targets.push({ type: target.type, method: target.method, source: relative, found: false });
        targets[targets.length - 1].names = memberNames(target);
      }
      for (const text of found.warnings) {
        warnings.push(`A HarmonyPatch attribute could not be read and was not checked: ${text} (${relative})`);
      }
    }

    const errors = [];
    // Prefer the normalized dump: it knows which class owns which method.
    // The byte search below is the fallback and can match a name used anywhere.
    const dumpClasses = loadDumpClasses(context.workspace?.root);
    if (dumpClasses) {
      for (const target of targets) {
        const owners = findClasses(dumpClasses, target.type);
        const methodFound =
          owners.length > 0 &&
          (target.names.length === 0 || owners.some((owner) => target.names.some((name) => (owner.methods || []).includes(name))));
        target.found = methodFound;
        target.checkedBy = "dump";
        if (owners.length === 0) {
          errors.push(`Harmony target type ${target.type} was not found in the normalized dump (${target.source})`);
        } else if (!methodFound) {
          const owner = owners[0];
          errors.push(`Harmony method ${target.type}.${target.method} was not found on ${owner.namespace ? `${owner.namespace}.` : ""}${owner.name} (${target.source})`);
        }
        delete target.names;
      }
      return {
        data: { ok: errors.length === 0 && warnings.length === 0, errors, warnings, targets, checkedBy: "dump" },
        evidence: [
          evidence({
            claim: `Validated ${targets.length} Harmony targets against the normalized dump`,
            confidence: "observed",
            authority: "shipped-artifact",
            source: modDir,
            detail: { targets: targets.length, errors: errors.length, warnings: warnings.length },
          }),
        ],
      };
    }
    const assemblyFiles = collectAssemblies(gameDir, profile);
    if (targets.length > 0 && assemblyFiles.length === 0) {
      errors.push(
        "No game assemblies were found to validate against; check the profile managed and interop paths.",
      );
    }
    const buffers = targets.length > 0 ? assemblyFiles.map((file) => fs.readFileSync(file)) : [];
    for (const target of targets) {
      const typeFound = buffers.some((data) => containsName(data, lastSegment(target.type)));
      const methodFound =
        target.names.length === 0 || buffers.some((data) => target.names.some((name) => containsName(data, name)));
      target.found = typeFound && methodFound;
      target.checkedBy = "bytes";
      delete target.names;
      if (!typeFound) {
        errors.push(
          `Harmony target type ${target.type} was not found in the game assemblies (${target.source})`,
        );
      } else if (!methodFound) {
        errors.push(
          `Harmony method ${target.type}.${target.method} was not found in the game assemblies (${target.source})`,
        );
      }
    }

    return {
      data: { ok: errors.length === 0 && warnings.length === 0, errors, warnings, targets },
      evidence: [
        evidence({
          claim: `Validated ${targets.length} Harmony targets against ${assemblyFiles.length} game assemblies`,
          confidence: "observed",
          authority: "shipped-artifact",
          source: modDir,
          detail: { targets: targets.length, assemblies: assemblyFiles.length, errors: errors.length, warnings: warnings.length },
        }),
      ],
    };
  },
};

if (!getHandler(operation.id)) registerOperation(operation, operation.handler);

export default operation;
