// Unreal asset operations, following the community workflow (checked 2026-11-07):
//   extract   retoc to-legacy --filter (IoStore) or repak unpack -i (pak)
//   inspect   UAssetGUI tojson <asset> <json> <major.minor> [usmap]
//   stage     UAssetGUI fromjson <json> mods/<Mod>/pak/<mount path> [usmap]
//   pack      retoc to-zen --version UE5_x (IoStore) or repak pack --version V11
// The game is only read; mods ship as <Mod>_P files in Content/Paks/~mods.

import fs from "node:fs";
import path from "node:path";
import { evidence } from "../../../core/evidence.mjs";
import { isInside } from "../../../core/fsutil.mjs";
import {
  ensureInsideWorkspace,
  gmfError,
  isDirectory,
  requireTool,
  resolveGameDirInput,
  runResolvedTool,
  walkFiles,
} from "./shared.mjs";

export { PAK_TOOL_ID } from "./shared.mjs";

// Blueprint logic mods for the UE4SS BPModLoader; asset override mods go to ~mods.
export function pakDeployDir(gameDir) {
  return path.join(gameDir, "Content", "Paks", "LogicMods");
}

export function assetModDeployDir(gameDir) {
  return path.join(gameDir, "Content", "Paks", "~mods");
}

function paksDirFor(gameDir) {
  return path.join(gameDir, "Content", "Paks");
}

// IoStore games ship .utoc/.ucas containers next to the .pak.
export function isIoStore(paksDir) {
  try {
    return fs.readdirSync(paksDir).some((name) => name.toLowerCase().endsWith(".utoc"));
  } catch {
    return false;
  }
}

// "5.6.1" -> "5.6"; null when unknown.
function engineMajorMinor(inputs, context) {
  const raw = inputs.engineVersion || context?.workspace?.profile?.engine?.version || context?.profile?.engine?.version || null;
  const match = String(raw || "").match(/^(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}` : null;
}

function requireEngineVersion(inputs, context) {
  const version = engineMajorMinor(inputs, context);
  if (!version) {
    throw gmfError(
      "GMF-E-PLAN-001",
      "The Unreal Engine version is unknown.",
      "Run gmf investigate so the profile records it, or pass --input engineVersion=5.6.",
    );
  }
  return version;
}

export function retocVersion(majorMinor) {
  return `UE${majorMinor.replace(".", "_")}`;
}

// repak pak versions by engine (repak README compatibility table).
export function repakVersion(majorMinor) {
  const [major, minor] = majorMinor.split(".").map(Number);
  if (major >= 5 || (major === 4 && minor >= 26)) return "V11";
  if (minor === 25) return "V9";
  if (minor >= 23) return "V8B";
  if (minor === 22) return "V8A";
  if (minor === 21) return "V7";
  if (minor === 20) return "V5";
  if (minor >= 16) return "V4";
  return "V3";
}

// The mappings file UE5 needs for unversioned properties: the input, else the
// newest .usmap under the workspace dumps/ folder (UE4SS writes one).
function mappingsFor(inputs, context) {
  if (inputs.mappings) return path.resolve(String(inputs.mappings));
  const dumps = path.join(context.workspace.root, "dumps");
  const found = fs.existsSync(dumps) ? walkFiles(dumps).filter((file) => file.toLowerCase().endsWith(".usmap")) : [];
  found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return found[0] || null;
}

function requireWorkspace(context, id) {
  if (!context?.workspace?.root) {
    throw gmfError("GMF-E-EXEC-001", `${id} needs a workspace.`, "Run gmf init first.");
  }
  return context.workspace.root;
}

function legacyRoot(root) {
  return path.join(root, "extracted", "unreal", "legacy");
}

function jsonRoot(root) {
  return path.join(root, "extracted", "unreal", "json");
}

function posix(relative) {
  return relative.split(path.sep).join("/");
}

function modName(value) {
  const name = String(value || "").trim();
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name) || name.includes("..")) {
    throw gmfError("GMF-E-PLAN-001", `Not a mod name: ${value}`, "Use letters, digits, '_', '-' or '.'.");
  }
  return name;
}

async function run(context, tool, args, label) {
  const result = await runResolvedTool(context, tool, args, { timeoutMs: context.timeoutMs || 1800000 });
  if (result.code !== 0) {
    const tail = `${result.stderr || ""}\n${result.stdout || ""}`.trim().split(/\r?\n/).slice(-8).join(" | ");
    throw gmfError("GMF-E-EXEC-001", `${label} failed (exit ${result.code}): ${tail}`, "Read the tool output above; nothing in the game was changed.");
  }
  return result;
}

export const extractAssetsOperation = {
  id: "unreal.extract_assets",
  title: "Extract Unreal assets",
  summary:
    "Copy cooked assets out of the game into the workspace as legacy .uasset/.uexp files: retoc to-legacy on IoStore games, repak unpack on pak games. Pass a filter; a whole game can be gigabytes.",
  engine: "unreal",
  inputs: {
    type: "object",
    properties: {
      gameDir: { type: "string" },
      filter: { type: "string", description: "Asset file name filter, e.g. DT_LoadingScreenTips." },
      outputDir: { type: "string" },
    },
    required: [],
  },
  outputs: {
    type: "object",
    properties: {
      assets: { type: "array" },
      outputDir: { type: "string" },
      container: { type: "string" },
    },
  },
  effects: ["read", "workspaceWrite"],
  requires: ["retoc", "repak"],
  gates: ["auto"],
  skill: "unreal-pak-blueprint",
  docs: ["knowledge/unreal/asset-pipeline.md"],
  async handler(inputs, context = {}) {
    const root = requireWorkspace(context, "unreal.extract_assets");
    const gameDir = resolveGameDirInput(inputs, context);
    const paksDir = paksDirFor(gameDir);
    if (!isDirectory(paksDir)) {
      throw gmfError(
        "GMF-E-GAME-001",
        `GMF-E-GAME-001: the game has no Content/Paks folder: ${paksDir}`,
        "Pass the game's project folder, for example --input gameDir=<install>/<Project>.",
      );
    }
    const outputDir = ensureInsideWorkspace(context, inputs.outputDir || legacyRoot(root), "outputDir");
    const iostore = isIoStore(paksDir);
    const filter = inputs.filter ? String(inputs.filter) : null;
    // The tool is resolved before the output folder exists, so a missing tool
    // leaves the workspace as it was.
    const tool = requireTool(context, iostore ? "retoc" : "repak");
    fs.mkdirSync(outputDir, { recursive: true });

    if (iostore) {
      const retoc = tool;
      await run(context, retoc, ["to-legacy", ...(filter ? ["--filter", filter] : []), paksDir, outputDir], "retoc to-legacy");
    } else {
      const repak = tool;
      const paks = fs.readdirSync(paksDir).filter((name) => name.toLowerCase().endsWith(".pak")).map((name) => path.join(paksDir, name));
      for (const pak of paks) {
        let include = [];
        if (filter) {
          const listed = await run(context, repak, ["list", pak], "repak list");
          include = String(listed.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && line.toLowerCase().includes(filter.toLowerCase()));
          if (include.length === 0) continue;
        }
        await run(context, repak, ["unpack", "-o", outputDir, "-f", ...include.flatMap((entry) => ["-i", entry]), pak], "repak unpack");
      }
    }

    const assets = walkFiles(outputDir)
      .map((file) => posix(path.relative(outputDir, file)))
      .filter((relative) => /\.(uasset|umap|uexp|ubulk|uptnl)$/i.test(relative))
      .filter((relative) => !filter || relative.toLowerCase().includes(filter.toLowerCase()));
    return {
      data: { assets, outputDir, container: iostore ? "iostore" : "pak", count: assets.length },
      evidence: [
        evidence({
          claim: `Extracted ${assets.length} asset files from the ${iostore ? "IoStore" : "pak"} game into the workspace`,
          confidence: "observed",
          authority: "shipped-artifact",
          source: paksDir,
          detail: { filter, tool: iostore ? "retoc" : "repak" },
        }),
      ],
    };
  },
};

export const inspectAssetOperation = {
  id: "unreal.inspect_asset",
  title: "Inspect an Unreal asset",
  summary:
    "Convert an extracted asset to UAssetAPI JSON with UAssetGUI (engine version from the profile, .usmap from dumps/) and list its exports. Edit the JSON, then run unreal.stage_asset.",
  engine: "unreal",
  inputs: {
    type: "object",
    properties: {
      assetPath: { type: "string", description: "An extracted .uasset/.umap, absolute or relative to extracted/unreal/legacy." },
      mountPath: { type: "string", description: "The asset path inside the pak; required when the asset is outside extracted/unreal/legacy." },
      engineVersion: { type: "string" },
      mappings: { type: "string", description: "A .usmap file; default the newest under dumps/." },
    },
    required: ["assetPath"],
  },
  outputs: {
    type: "object",
    properties: {
      jsonPath: { type: "string" },
      mountPath: { type: "string" },
      exports: { type: "array" },
    },
  },
  effects: ["read", "workspaceWrite"],
  requires: ["uassetgui"],
  gates: ["auto"],
  skill: "unreal-pak-blueprint",
  docs: ["knowledge/unreal/asset-pipeline.md"],
  async handler(inputs, context = {}) {
    const root = requireWorkspace(context, "unreal.inspect_asset");
    const legacy = legacyRoot(root);
    const asset = path.isAbsolute(String(inputs.assetPath)) ? path.resolve(String(inputs.assetPath)) : path.join(legacy, String(inputs.assetPath));
    ensureInsideWorkspace(context, asset, "assetPath");
    if (!fs.existsSync(asset)) {
      throw gmfError("GMF-E-EXEC-001", `Asset not found: ${asset}`, "Run unreal.extract_assets with a filter first.");
    }
    let mountPath;
    if (inputs.mountPath) {
      mountPath = posix(String(inputs.mountPath));
      if (path.isAbsolute(mountPath) || mountPath.split("/").includes("..")) {
        throw gmfError("GMF-E-PLAN-001", `Mount path must be relative and stay inside the content tree: ${mountPath}`, "Use a path such as <Project>/Content/.../Asset.uasset.");
      }
    } else if (isInside(legacy, asset)) {
      mountPath = posix(path.relative(legacy, asset));
    } else {
      throw gmfError(
        "GMF-E-PLAN-001",
        `The asset is outside extracted/unreal/legacy, so its mount path is unknown; pass the mountPath input: ${asset}`,
        "Pass --input mountPath=<Project>/Content/.../Asset.uasset, or extract the asset with unreal.extract_assets.",
      );
    }
    const jsonPath = path.join(jsonRoot(root), mountPath.replace(/\.(uasset|umap)$/i, ".json"));
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    const version = requireEngineVersion(inputs, context);
    const mappings = mappingsFor(inputs, context);
    const tool = requireTool(context, "uassetgui");
    await run(context, tool, ["tojson", asset, jsonPath, version, ...(mappings ? [mappings] : [])], "UAssetGUI tojson");
    if (!fs.existsSync(jsonPath)) {
      throw gmfError("GMF-E-EXEC-001", `UAssetGUI wrote no JSON to ${jsonPath}`, "Check the engine version and the .usmap; UE5 unversioned assets need mappings.");
    }
    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    const exports = (parsed.Exports || []).map((entry) => ({
      name: entry.ObjectName,
      type: String(entry.$type || "").split(",")[0].split(".").pop(),
    }));
    return {
      data: { jsonPath, mountPath, exports, engineVersion: version, mappings },
      evidence: [
        evidence({
          claim: `Converted ${mountPath} to JSON with UAssetGUI`,
          confidence: "observed",
          authority: "shipped-artifact",
          source: asset,
          detail: { exports: exports.length, mappings: Boolean(mappings) },
        }),
      ],
    };
  },
};

export const stageAssetOperation = {
  id: "unreal.stage_asset",
  title: "Stage an edited Unreal asset in a mod",
  summary:
    "Convert edited UAssetAPI JSON back to a cooked asset with UAssetGUI, at the same mount path inside mods/<mod>/pak/, ready for unreal.pack_mod.",
  engine: "unreal",
  inputs: {
    type: "object",
    properties: {
      mod: { type: "string", description: "The mod name; files go to mods/<mod>/pak/." },
      jsonPath: { type: "string", description: "Edited JSON from unreal.inspect_asset." },
      mountPath: { type: "string", description: "Override the asset path inside the pak, e.g. Game/Content/Data/DT_X.uasset." },
      mappings: { type: "string" },
    },
    required: ["mod", "jsonPath"],
  },
  outputs: {
    type: "object",
    properties: {
      staged: { type: "array" },
      mountPath: { type: "string" },
    },
  },
  effects: ["read", "workspaceWrite"],
  requires: ["uassetgui"],
  gates: ["auto"],
  skill: "unreal-pak-blueprint",
  docs: ["knowledge/unreal/asset-pipeline.md"],
  async handler(inputs, context = {}) {
    const root = requireWorkspace(context, "unreal.stage_asset");
    const mod = modName(inputs.mod);
    const json = ensureInsideWorkspace(context, path.isAbsolute(String(inputs.jsonPath)) ? String(inputs.jsonPath) : path.join(root, String(inputs.jsonPath)), "jsonPath");
    if (!fs.existsSync(json)) throw gmfError("GMF-E-EXEC-001", `JSON not found: ${json}`, "Run unreal.inspect_asset first.");
    let mountPath = inputs.mountPath ? posix(String(inputs.mountPath)) : null;
    if (!mountPath) {
      const relative = path.relative(jsonRoot(root), json);
      if (!isInside(jsonRoot(root), json)) {
        throw gmfError("GMF-E-PLAN-001", "The JSON is not under extracted/unreal/json, so its mount path is unknown.", "Pass --input mountPath=<Project>/Content/.../Asset.uasset.");
      }
      const base = posix(relative).replace(/\.json$/i, "");
      mountPath = fs.existsSync(path.join(legacyRoot(root), `${base}.umap`)) ? `${base}.umap` : `${base}.uasset`;
    }
    if (mountPath.split("/").includes("..")) throw gmfError("GMF-E-PLAN-001", `Mount path escapes the mod: ${mountPath}`, "Use a path inside the game's content tree.");
    const target = path.join(root, "mods", mod, "pak", ...mountPath.split("/"));
    ensureInsideWorkspace(context, target, "staged asset");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const mappings = mappingsFor(inputs, context);
    const tool = requireTool(context, "uassetgui");
    await run(context, tool, ["fromjson", json, target, ...(mappings ? [mappings] : [])], "UAssetGUI fromjson");
    const stem = target.replace(/\.(uasset|umap)$/i, "");
    const staged = [".uasset", ".umap", ".uexp", ".ubulk", ".uptnl"].map((ext) => stem + ext).filter((file) => fs.existsSync(file));
    if (staged.length === 0) throw gmfError("GMF-E-EXEC-001", `UAssetGUI wrote nothing at ${target}`, "Check the JSON and the .usmap.");
    return {
      data: { staged, mountPath, modDir: path.join(root, "mods", mod) },
      evidence: [
        evidence({ claim: `Staged ${mountPath} in mod ${mod}`, confidence: "observed", authority: "controlled-replay", source: target, detail: { files: staged.length } }),
      ],
    };
  },
};

export const packModOperation = {
  id: "unreal.pack_mod",
  title: "Pack an Unreal asset mod",
  summary:
    "Pack mods/<mod>/pak/ into mods/<mod>/dist/<mod>_P: .pak, .utoc and .ucas with retoc to-zen on IoStore games, one .pak with repak otherwise. Deploy with unreal.deploy --input type=pak.",
  engine: "unreal",
  inputs: {
    type: "object",
    properties: {
      mod: { type: "string" },
      gameDir: { type: "string" },
      engineVersion: { type: "string" },
    },
    required: ["mod"],
  },
  outputs: {
    type: "object",
    properties: {
      files: { type: "array" },
      container: { type: "string" },
    },
  },
  effects: ["read", "workspaceWrite"],
  requires: ["retoc", "repak"],
  gates: ["auto"],
  skill: "unreal-pak-blueprint",
  docs: ["knowledge/unreal/asset-pipeline.md"],
  async handler(inputs, context = {}) {
    const root = requireWorkspace(context, "unreal.pack_mod");
    const mod = modName(inputs.mod);
    const source = path.join(root, "mods", mod, "pak");
    if (!fs.existsSync(source) || walkFiles(source).length === 0) {
      throw gmfError("GMF-E-EXEC-001", `Nothing to pack in ${source}`, "Stage assets with unreal.stage_asset first.");
    }
    const gameDir = resolveGameDirInput(inputs, context);
    const iostore = isIoStore(paksDirFor(gameDir));
    const version = requireEngineVersion(inputs, context);
    const dist = path.join(root, "mods", mod, "dist");
    fs.mkdirSync(dist, { recursive: true });
    const base = `${mod}_P`;
    for (const ext of [".pak", ".utoc", ".ucas"]) fs.rmSync(path.join(dist, base + ext), { force: true });
    if (iostore) {
      const retoc = requireTool(context, "retoc");
      await run(context, retoc, ["to-zen", "--version", retocVersion(version), source, path.join(dist, `${base}.utoc`)], "retoc to-zen");
    } else {
      const repak = requireTool(context, "repak");
      await run(context, repak, ["pack", "--version", repakVersion(version), source, path.join(dist, `${base}.pak`)], "repak pack");
    }
    const files = [".pak", ".utoc", ".ucas"].map((ext) => path.join(dist, base + ext)).filter((file) => fs.existsSync(file));
    if (files.length === 0) throw gmfError("GMF-E-EXEC-001", `The pack step wrote nothing to ${dist}`, "Read the tool output.");
    return {
      data: { files, container: iostore ? "iostore" : "pak", dist },
      evidence: [
        evidence({ claim: `Packed ${mod} as ${base} (${iostore ? "IoStore" : "pak"})`, confidence: "observed", authority: "controlled-replay", source: dist, detail: { files: files.length, version } }),
      ],
    };
  },
};

export const assetOperations = [extractAssetsOperation, inspectAssetOperation, stageAssetOperation, packModOperation];
