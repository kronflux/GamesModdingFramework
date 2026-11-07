// unreal.deploy: copy a Lua, C++ or pak mod into the game with a backup before every overwrite.

import fs from "node:fs";
import path from "node:path";
import { evidence } from "../../../core/evidence.mjs";
import { detectUe4ss } from "../detect.mjs";
import {
  copyTreeWithBackup,
  findPakFiles,
  gmfError,
  inferModType,
  resolveGameDirInput,
  resolveModDirInput,
  walkFiles,
} from "./shared.mjs";

function loadUe4ss(gameDir) {
  const loader = detectUe4ss(gameDir);
  if (!loader.installed || !loader.path) {
    throw gmfError(
      "GMF-E-TOOL-001",
      "GMF-E-TOOL-001: UE4SS is not installed in the game folder.",
      "Run unreal.setup_ue4ss with an authorization for toolInstall first.",
    );
  }
  return loader;
}

// The mod's DLL: main.dll, else the DLL named after the mod, else the only DLL. With several unrelated DLLs
// the first one under build/ (xmake writes to build/windows/x64/release) wins, then the first by path, and
// the choice is reported as a warning.
function pickDll(modDir) {
  const dlls = walkFiles(modDir).filter((file) => file.toLowerCase().endsWith(".dll")).sort();
  if (dlls.length === 0) return { dll: null, warnings: [] };
  const named = (wanted) => dlls.find((file) => path.basename(file).toLowerCase() === wanted);
  const exact = named("main.dll") || named(`${path.basename(modDir).toLowerCase()}.dll`);
  if (exact || dlls.length === 1) return { dll: exact || dlls[0], warnings: [] };
  const underBuild = dlls.find((file) => path.relative(modDir, file).split(path.sep)[0].toLowerCase() === "build");
  const dll = underBuild || dlls[0];
  return {
    dll,
    warnings: [
      `The mod folder holds ${dlls.length} DLLs and none is main.dll or named after the mod; deployed ${path.relative(modDir, dll)}. Name the one to deploy main.dll.`,
    ],
  };
}

function deployLua(context, modDir, gameDir) {
  const loader = loadUe4ss(gameDir);
  const modName = path.basename(modDir);
  const targetDir = path.join(loader.path, "Mods", modName);
  const deployed = [];

  const files = walkFiles(modDir);
  if (files.length === 0) {
    throw gmfError("GMF-E-PLAN-001", `The mod folder is empty: ${modDir}`, "Run unreal.scaffold first.");
  }
  deployed.push(...copyTreeWithBackup(context, files.map((source) => ({ source, target: path.join(targetDir, path.relative(modDir, source)) }))));
  fs.mkdirSync(targetDir, { recursive: true });
  return { deployed, target: targetDir, modName, loader };
}

function deployCpp(context, modDir, gameDir) {
  const loader = loadUe4ss(gameDir);
  const modName = path.basename(modDir);
  const targetDir = path.join(loader.path, "Mods", modName, "dlls");
  const { dll, warnings } = pickDll(modDir);
  if (!dll) {
    throw gmfError(
      "GMF-E-EXEC-001",
      "No compiled DLL was found in the mod folder.",
      "Run unreal.build before unreal.deploy.",
    );
  }
  const pairs = [{ source: dll, target: path.join(targetDir, "main.dll") }];
  const enabled = path.join(modDir, "enabled.txt");
  if (fs.existsSync(enabled)) pairs.push({ source: enabled, target: path.join(loader.path, "Mods", modName, "enabled.txt") });
  const deployed = copyTreeWithBackup(context, pairs);
  return { deployed, target: targetDir, modName, loader, warnings };
}

// An asset mod packed by unreal.pack_mod (dist/ beside a staged pak/ folder)
// overrides game assets from Content/Paks/~mods; other pak mods are Blueprint
// logic mods for the UE4SS BPModLoader in Content/Paks/LogicMods.
function deployPak(context, modDir, gameDir) {
  const dist = path.join(modDir, "dist");
  if (fs.existsSync(path.join(modDir, "pak")) && fs.existsSync(dist) && findPakFiles(dist).length > 0) {
    const targetDir = path.join(gameDir, "Content", "Paks", "~mods");
    fs.mkdirSync(targetDir, { recursive: true });
    const deployed = copyTreeWithBackup(context, findPakFiles(dist).map((source) => ({ source, target: path.join(targetDir, path.basename(source)) })));
    return { deployed, target: targetDir, modName: path.basename(modDir), loader: null };
  }
  const files = findPakFiles(modDir);
  if (files.length === 0) {
    throw gmfError(
      "GMF-E-EXEC-001",
      "No .pak file or IoStore sidecar was found in the mod folder.",
      "Cook and package the mod first, then run unreal.deploy again.",
    );
  }
  const targetDir = path.join(gameDir, "Content", "Paks", "LogicMods");
  fs.mkdirSync(targetDir, { recursive: true });
  const deployed = copyTreeWithBackup(context, files.map((source) => ({ source, target: path.join(targetDir, path.basename(source)) })));
  return { deployed, target: targetDir, modName: path.basename(modDir), loader: null };
}

export const deployOperation = {
  id: "unreal.deploy",
  title: "Deploy an Unreal mod",
  summary:
    "Copy a UE4SS Lua mod to the Mods folder, a C++ mod DLL to Mods/<name>/dlls, or a pak mod to Content/Paks/LogicMods. Every overwritten file is backed up first.",
  engine: "unreal",
  inputs: {
    type: "object",
    properties: {
      modDir: { type: "string" },
      gameDir: { type: "string" },
      type: { type: "string" },
    },
    required: [],
  },
  outputs: {
    type: "object",
    properties: {
      deployed: { type: "array" },
      backup: { type: "array" },
      target: { type: "string" },
      warnings: { type: "array" },
    },
  },
  effects: ["read", "gameWrite"],
  requires: [],
  gates: ["soft"],
  skill: "unreal-ue4ss-lua",
  docs: [],

  async handler(inputs, context = {}) {
    const modDir = resolveModDirInput(inputs, context);
    const gameDir = resolveGameDirInput(inputs, context);
    const type = String(inputs.type || inferModType(modDir)).toLowerCase();

    let result;
    if (type === "lua") result = deployLua(context, modDir, gameDir);
    else if (type === "cpp") result = deployCpp(context, modDir, gameDir);
    else if (type === "pak") result = deployPak(context, modDir, gameDir);
    else throw gmfError("GMF-E-PLAN-001", `Unknown Unreal mod type for deploy: ${type}`, "Use lua, cpp or pak.");

    const backups = result.deployed
      .filter((entry) => entry.backup)
      .map((entry) => ({ target: entry.target, path: entry.backup, sha256: entry.sha256 }));

    return {
      data: {
        deployed: result.deployed,
        backup: backups,
        target: result.target,
        type,
        modName: result.modName,
        warnings: result.warnings || [],
        ue4ss: result.loader ? result.loader.path : null,
      },
      evidence: [
        evidence({
          claim: `${result.deployed.length} file(s) deployed to ${result.target}.`,
          confidence: "observed",
          authority: "controlled-replay",
          source: result.target,
          detail: { type, backups: backups.length },
        }),
      ],
    };
  },
};

export default deployOperation;
