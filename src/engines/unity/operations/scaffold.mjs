import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerOperation, getHandler } from "../../../core/operations.mjs";
import { evidence } from "../../../core/evidence.mjs";
import { assertInside } from "../../../core/workspace.mjs";
import { findDataDir, targetFramework, templateFor } from "../detect.mjs";
import { authorFor, backendFor, loaderFor } from "./defaults.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(HERE, "../../../../templates/unity");

const MOD_TOKENS = ["ModName", "Author", "Guid", "Version", "TargetFramework", "TargetType", "TargetArgType"];
const DEFAULT_TARGET_TYPE = "UnityEngine.Debug";
const PATH_TOKENS = ["GameDir", "ManagedDir", "LoaderDir", "InteropDir", "ModDeployDir"];

// Replaces each $(Token) with its value, passed through escape for the kind of
// file being written.
function render(text, values, tokens, escape = (value) => value) {
  let output = text;
  for (const token of tokens) {
    output = output.split(`$(${token})`).join(escape(String(values[token] ?? "")));
  }
  return output;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// For the inside of a C# string literal.
function escapeCSharp(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replace(/[\u0000-\u001f\u007f]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

const XML_FILE_RE = /\.(csproj|props|targets|xml)$/i;

function escapeFor(fileName) {
  if (fileName.toLowerCase().endsWith(".cs")) return escapeCSharp;
  if (XML_FILE_RE.test(fileName)) return escapeXml;
  return undefined;
}

function walk(dir, base = dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, files);
    else if (entry.isFile()) files.push(path.relative(base, full));
  }
  return files.sort();
}

// MelonLoader keeps MelonLoader.dll and 0Harmony.dll in MelonLoader/net6
// (IL2CPP) or MelonLoader/net472 and net35 (Mono), and writes the IL2CPP interop
// assemblies to MelonLoader/Il2CppAssemblies on first launch.
function melonLoaderDir(gameDir, backend) {
  const root = path.join(gameDir, "MelonLoader");
  if (backend === "il2cpp") return path.join(root, "net6");
  const net472 = path.join(root, "net472");
  const net35 = path.join(root, "net35");
  return !fs.existsSync(net472) && fs.existsSync(net35) ? net35 : net472;
}

function loaderDirectories(gameDir, loader, backend, profile) {
  const loaderDir = loader === "melonloader" ? melonLoaderDir(gameDir, backend) : path.join(gameDir, "BepInEx");
  const dataDir = profile.paths?.data || findDataDir(gameDir);
  const managedDir = profile.paths?.managed || (dataDir ? path.join(dataDir, "Managed") : "");
  let interopDir = "";
  if (backend === "il2cpp" && loader === "bepinex6") interopDir = profile.paths?.interop || path.join(loaderDir, "interop");
  if (backend === "il2cpp" && loader === "melonloader") interopDir = path.join(gameDir, "MelonLoader", "Il2CppAssemblies");
  const deployDir = loader === "melonloader" ? path.join(gameDir, "Mods") : path.join(loaderDir, "plugins");
  return { loaderDir, managedDir, interopDir, deployDir };
}

function modGuid(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return `com.gmf.${slug || "mod"}`;
}

const operation = {
  id: "unity.scaffold",
  title: "Scaffold a Unity mod",
  summary:
    "Render a BepInEx 5, BepInEx 6 Mono, BepInEx 6 IL2CPP or MelonLoader mod project into the workspace mods folder.",
  engine: "unity",
  inputs: {
    type: "object",
    properties: {
      name: { type: "string" },
      author: { type: "string" },
      loader: { type: "string" },
      backend: { type: "string" },
      outputDir: { type: "string" },
      targetType: { type: "string" },
    },
    required: ["name"],
  },
  outputs: {
    type: "object",
    properties: {
      files: { type: "array" },
      outputDir: { type: "string" },
    },
  },
  effects: ["read", "workspaceWrite"],
  requires: [],
  gates: ["auto"],
  skill: "unity-bepinex",
  docs: [],
  handler: async (inputs, context) => {
    const name = typeof inputs.name === "string" ? inputs.name.trim() : "";
    if (!/^[A-Za-z][A-Za-z0-9_.]*$/.test(name)) {
      const error = new Error(
        "Mod name must start with a letter and contain only letters, digits, underscores or dots",
      );
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Pass a C#-safe name such as FixtureMod.";
      throw error;
    }

    if (!context.workspace?.root) {
      const error = new Error("unity.scaffold needs a workspace");
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Run gmf init and gmf investigate first.";
      throw error;
    }
    const profile = context.workspace.profile;
    if (!profile) {
      const error = new Error("unity.scaffold needs a workspace profile; run gmf investigate first");
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Run gmf investigate --game <dir> so gmf.profile.json exists.";
      throw error;
    }
    const gameDir = context.workspace.local?.gameDir || profile.game?.installDir;
    if (!gameDir) {
      const error = new Error("unity.scaffold cannot find the game folder in the workspace");
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Run gmf init --game <dir> so gmf.local.json records the game path.";
      throw error;
    }

    const loader = loaderFor(inputs, context);
    const backend = backendFor(inputs, context);
    if (!loader || !backend) {
      const error = new Error("unity.scaffold needs a loader and a backend");
      error.code = "GMF-E-EXEC-001";
      error.remediation =
        "Pass --input loader=bepinex5|bepinex6|melonloader --input backend=mono|il2cpp, or run gmf investigate first.";
      throw error;
    }

    const template = templateFor(loader, backend);
    const framework = targetFramework(loader, backend);
    const templateDir = path.join(TEMPLATES_DIR, template);
    if (!fs.existsSync(templateDir)) {
      const error = new Error(`Template folder is missing: ${templateDir}`);
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Reinstall GMF; the templates/unity folder is incomplete.";
      throw error;
    }

    const outputDir = assertInside(
      context.workspace,
      inputs.outputDir || path.join(context.workspace.root, "mods", name),
    );
    if (fs.existsSync(outputDir) && fs.readdirSync(outputDir).length > 0) {
      const error = new Error(`Mod project already exists at ${outputDir}`);
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Choose another name or remove the existing project folder.";
      throw error;
    }

    const targetType =
      typeof inputs.targetType === "string" && inputs.targetType.trim() ? inputs.targetType.trim() : DEFAULT_TARGET_TYPE;
    if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(targetType)) {
      const error = new Error(`Invalid target type: ${targetType}`);
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Pass a dotted C# type name such as UnityEngine.Debug.";
      throw error;
    }

    const directories = loaderDirectories(gameDir, loader, backend, profile);
    const values = {
      ModName: name,
      Author: String(authorFor(inputs, context)).replace(/[\r\n\t]+/g, " ").trim(),
      Guid: modGuid(name),
      Version: "0.1.0",
      TargetFramework: framework,
      TargetType: targetType,
      TargetArgType: backend === "il2cpp" ? "Il2CppSystem.Object" : "object",
      GameDir: path.resolve(gameDir),
      ManagedDir: directories.managedDir || "",
      LoaderDir: directories.loaderDir,
      InteropDir: directories.interopDir || "",
      ModDeployDir: directories.deployDir,
    };

    fs.mkdirSync(outputDir, { recursive: true });
    const written = [];
    for (const relative of walk(templateDir)) {
      if (path.basename(relative) === "template.json") continue;
      const source = path.join(templateDir, relative);
      const withoutSuffix = relative.replace(/\.tpl$/, "");
      const targetRelative = render(withoutSuffix, values, MOD_TOKENS);
      const target = path.join(outputDir, targetRelative);
      assertInside(context.workspace, target);
      let content = fs.readFileSync(source, "utf8");
      const escape = escapeFor(targetRelative);
      content = render(content, values, MOD_TOKENS, escape);
      if (path.basename(targetRelative) === "Directory.Build.props" || targetRelative.endsWith(".md")) {
        content = render(content, values, PATH_TOKENS, escape);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      written.push(target);
    }

    return {
      data: {
        files: written.sort(),
        outputDir,
        template,
        targetFramework: framework,
      },
      evidence: [
        evidence({
          claim: `Rendered the ${template} mod project for ${name}`,
          confidence: "observed",
          authority: "shipped-artifact",
          source: outputDir,
          detail: { template, targetFramework: framework },
        }),
      ],
    };
  },
};

if (!getHandler(operation.id)) registerOperation(operation, operation.handler);

export default operation;
