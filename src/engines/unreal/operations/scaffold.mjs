// unreal.scaffold: render a Lua, C++ or pak/Blueprint mod project into the workspace mods folder.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureInsideWorkspace, gmfError, workspaceRoot } from "./shared.mjs";

const TEMPLATES_ROOT = fileURLToPath(new URL("../../../../templates/unreal/", import.meta.url));

const TYPE_TO_TEMPLATE = {
  lua: "lua-structured",
  "lua-minimal": "lua-minimal",
  "lua-structured": "lua-structured",
  cpp: "cpp",
  "c++": "cpp",
  pak: "pak-blueprint",
  "pak-blueprint": "pak-blueprint",
};

function cppIdentifier(name) {
  const sanitized = String(name).replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(sanitized) ? `_${sanitized}` : sanitized;
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function render(text, values) {
  return String(text).replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  );
}

// The author is user text rendered into source files. It is escaped for the language of the file it lands in,
// so a quote, a backslash, a line break or a closing long bracket cannot end a literal or a comment early.
const CPP_EXTENSIONS = new Set([".cpp", ".hpp", ".h", ".cc", ".cxx"]);
const SIMPLE_ESCAPES = { "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t" };

function escapeLiteral(text, control) {
  return text.replace(/[\\"\u0000-\u001f\u007f]/g, (char) => SIMPLE_ESCAPES[char] ?? control(char.charCodeAt(0)));
}

function authorFor(author, file) {
  const extension = path.extname(file).toLowerCase();
  if (extension === ".lua") {
    return escapeLiteral(author, (code) => `\\${String(code).padStart(3, "0")}`).replaceAll("]]", "]\\093");
  }
  if (CPP_EXTENSIONS.has(extension)) {
    return escapeLiteral(author, (code) => `\\${code.toString(8).padStart(3, "0")}`);
  }
  if (extension === ".json") return JSON.stringify(author).slice(1, -1);
  return author.replace(/[\u0000-\u001f\u007f]/g, " ");
}

// Device names Windows reserves, with or without an extension.
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function validateName(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) {
    throw gmfError("GMF-E-PLAN-001", "unreal.scaffold needs a non-empty mod name.", "Pass --input name=<name>.");
  }
  if (trimmed.endsWith(".") || RESERVED_NAME.test(trimmed.split(".")[0])) {
    throw gmfError(
      "GMF-E-PLAN-001",
      `Invalid mod name: ${trimmed}`,
      "Windows does not allow a trailing dot or the device names con, prn, aux, nul, com1-9 and lpt1-9.",
    );
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..") || /^[.]/.test(trimmed)) {
    throw gmfError("GMF-E-PLAN-001", `Invalid mod name: ${trimmed}`, "Use a name without path separators or '..'.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(trimmed)) {
    throw gmfError("GMF-E-PLAN-001", `Invalid mod name: ${trimmed}`, "Use letters, digits, spaces, dots, underscores and hyphens.");
  }
  return trimmed;
}

function templateFiles(templateDir) {
  const manifestPath = path.join(templateDir, "template.json");
  if (!fs.existsSync(manifestPath)) {
    throw gmfError("GMF-E-TOOL-001", `Template manifest is missing: ${manifestPath}`, "Restore templates/unreal.");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw gmfError("GMF-E-TOOL-001", `Template ${manifest.id || templateDir} lists no files.`, "Fix the template manifest.");
  }
  return manifest;
}

// Resolves requested feature or helper names against the template manifest of that folder.
// Names are looked up in the manifest's own file list, so a path or an unknown name never reaches the filesystem.
function resolveModules(kind, names) {
  if (names === undefined || names === null) return [];
  if (!Array.isArray(names)) {
    throw gmfError("GMF-E-PLAN-001", `${kind}s must be an array of names.`, `Pass --input ${kind}s=<name>,<name>.`);
  }
  if (names.length === 0) return [];
  const folder = `${kind}s`;
  const manifest = templateFiles(path.join(TEMPLATES_ROOT, folder));
  const available = new Map(manifest.files.map((file) => [file.replace(/\.lua$/, ""), file]));
  return [...new Set(names.map((name) => String(name).trim()))].map((name) => {
    const file = available.get(name);
    if (!file) {
      throw gmfError(
        "GMF-E-TEMPLATE-001",
        `Unknown ${kind} template: ${name}`,
        `Use one of: ${[...available.keys()].join(", ")}.`,
      );
    }
    return { name, source: path.join(TEMPLATES_ROOT, folder, file), target: `Scripts/${folder}/${file}` };
  });
}

export const scaffoldOperation = {
  id: "unreal.scaffold",
  title: "Scaffold an Unreal mod",
  summary:
    "Render a UE4SS Lua mod, a UE4SS C++ mod or a pak/Blueprint mod project into the workspace mods folder.",
  engine: "unreal",
  inputs: {
    type: "object",
    properties: {
      name: { type: "string" },
      author: { type: "string" },
      type: { type: "string" },
      features: { type: "array", items: { type: "string" } },
      helpers: { type: "array", items: { type: "string" } },
    },
    required: ["name", "type"],
  },
  outputs: {
    type: "object",
    properties: {
      files: { type: "array" },
      dir: { type: "string" },
      template: { type: "string" },
    },
  },
  effects: ["read", "workspaceWrite"],
  requires: [],
  gates: ["auto"],
  skill: "unreal-ue4ss-lua",
  docs: [],

  async handler(inputs, context = {}) {
    const name = validateName(inputs.name);
    const type = String(inputs.type || "").toLowerCase();
    const templateName = TYPE_TO_TEMPLATE[type];
    if (!templateName) {
      throw gmfError(
        "GMF-E-PLAN-001",
        `Unknown Unreal mod type: ${inputs.type}`,
        "Use lua, lua-minimal, lua-structured, cpp or pak.",
      );
    }

    const extras = [...resolveModules("feature", inputs.features), ...resolveModules("helper", inputs.helpers)];
    if (extras.length > 0 && !templateName.startsWith("lua")) {
      throw gmfError(
        "GMF-E-PLAN-001",
        `Features and helpers are Lua modules and do not apply to the ${templateName} template.`,
        "Use type lua or lua-structured.",
      );
    }

    const featureNames = extras.filter((extra) => extra.target.startsWith("Scripts/features/"));
    if (featureNames.length > 0 && templateName !== "lua-structured") {
      throw gmfError(
        "GMF-E-PLAN-001",
        `Features need the lua-structured template, which loads them from FEATURE_MODULES; ${templateName} has no feature loader.`,
        "Use type lua or lua-structured, or pass only helpers.",
      );
    }

    const templateDir = path.join(TEMPLATES_ROOT, templateName);
    const manifest = templateFiles(templateDir);

    const modsRoot = path.join(workspaceRoot(context), "mods");
    const modDir = ensureInsideWorkspace(context, path.join(modsRoot, name), "mod directory");
    if (fs.existsSync(modDir)) {
      throw gmfError(
        "GMF-E-PLAN-001",
        `Mod directory already exists: ${modDir}`,
        "Choose another name or remove the existing directory.",
      );
    }

    const author = String(inputs.author || "").trim() || "unknown";
    const values = {
      name,
      author,
      slug: slugify(name),
      cppName: cppIdentifier(name),
      year: new Date().getFullYear(),
      engine: "unreal",
    };

    const files = [];
    for (const relative of manifest.files) {
      const renderedRelative = render(relative, values)
        .split("/")
        .filter((segment) => segment && segment !== "." && segment !== "..")
        .join(path.sep);
      if (!renderedRelative) continue;
      const target = path.join(modDir, renderedRelative);
      ensureInsideWorkspace(context, target, "scaffold file");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const source = path.join(templateDir, relative);
      if (!fs.existsSync(source)) {
        throw gmfError("GMF-E-TOOL-001", `Template file is missing: ${source}`, "Restore templates/unreal.");
      }
      fs.writeFileSync(target, render(fs.readFileSync(source, "utf8"), { ...values, author: authorFor(author, target) }));
      files.push(target);
    }
    for (const extra of extras) {
      const target = path.join(modDir, ...extra.target.split("/"));
      ensureInsideWorkspace(context, target, "scaffold file");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(extra.source, target);
      files.push(target);
    }
    fs.mkdirSync(modDir, { recursive: true });
    if (featureNames.length > 0) listFeatureModules(path.join(modDir, "Scripts", "main.lua"), featureNames);

    return {
      data: {
        files,
        dir: modDir,
        template: manifest.id || templateName,
        type,
        name,
      },
    };
  },
};

// A copied feature only runs when main.lua lists its require path in
// FEATURE_MODULES. Insert one entry per feature after the opening brace.
function listFeatureModules(mainFile, features) {
  const text = fs.readFileSync(mainFile, "utf8");
  const marker = "local FEATURE_MODULES = {";
  const at = text.indexOf(marker);
  if (at < 0) {
    throw gmfError("GMF-E-TOOL-001", `main.lua has no FEATURE_MODULES table: ${mainFile}`, "Restore templates/unreal/lua-structured.");
  }
  const lines = features
    .map((extra) => `    "features.${path.basename(extra.target, ".lua")}",`)
    .join("\n");
  const insertAt = at + marker.length;
  fs.writeFileSync(mainFile, `${text.slice(0, insertAt)}\n${lines}${text.slice(insertAt)}`);
}

export default scaffoldOperation;
