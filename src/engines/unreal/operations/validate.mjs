// unreal.validate: structural and reference checks for Unreal mod projects.

import fs from "node:fs";
import path from "node:path";
import { detectUe4ss, findBinariesDir } from "../detect.mjs";
import { checkLuaBalance, checkModuleRefs } from "../luacheck.mjs";
import {
  ensureGameDir,
  findPakFiles,
  inferModType,
  isFile,
  resolveModDirInput,
  walkFiles,
} from "./shared.mjs";

function findLog(gameDir, loader) {
  const roots = [loader?.path, findBinariesDir(gameDir), gameDir].filter(Boolean);
  for (const root of roots) {
    for (const name of ["UE4SS.log", "UE4SS_Log.txt"]) {
      const candidate = path.join(root, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function validateLua(modDir, gameDir, errors, warnings) {
  const scriptsDir = path.join(modDir, "Scripts");
  const main = path.join(scriptsDir, "main.lua");
  if (!isFile(main)) {
    errors.push("Scripts/main.lua is missing.");
    return;
  }
  if (!isFile(path.join(modDir, "enabled.txt"))) {
    errors.push("enabled.txt is missing; UE4SS will not load the mod without it.");
  }

  const source = fs.readFileSync(main, "utf8");
  if (!/^\s*local\s+MOD_NAME\s*=/m.test(source)) {
    errors.push("main.lua is missing the module field MOD_NAME.");
  }
  if (!/^\s*local\s+MOD_VERSION\s*=/m.test(source)) {
    warnings.push("main.lua does not declare MOD_VERSION.");
  }
  if (!/^\s*local\s+MOD_AUTHOR\s*=/m.test(source)) {
    warnings.push("main.lua does not declare MOD_AUTHOR.");
  }

  const luaFiles = walkFiles(scriptsDir).filter((file) => file.toLowerCase().endsWith(".lua"));
  for (const file of luaFiles) {
    const name = path.relative(scriptsDir, file).split(path.sep).join("/");
    for (const found of checkLuaBalance(fs.readFileSync(file, "utf8"), name)) {
      errors.push(`${found.file}:${found.line} ${found.message}`);
    }
  }
  for (const found of checkModuleRefs(scriptsDir)) {
    const text = `${found.file}:${found.line} ${found.message}`;
    if (found.severity === "error") errors.push(text);
    else warnings.push(text);
  }

  if (!gameDir) return;
  const loader = detectUe4ss(gameDir);
  if (loader.installed && loader.path) {
    const deployed = path.join(loader.path, "Mods", path.basename(modDir), "Scripts", "main.lua");
    if (!isFile(deployed)) {
      warnings.push(`The mod is not deployed to ${path.join(loader.path, "Mods", path.basename(modDir))}; run unreal.deploy.`);
    }
    const log = findLog(gameDir, loader);
    warnings.push(
      log
        ? `Read ${log} after launching the game with UE4SS to see script load errors.`
        : "After launching the game with UE4SS, read the UE4SS log to see script load errors.",
    );
  }
}

function validateCpp(modDir, errors) {
  const dlls = walkFiles(modDir).filter((file) => file.toLowerCase().endsWith(".dll"));
  if (dlls.length === 0) errors.push("No compiled DLL was found; run unreal.build before validate.");
}

function validatePak(modDir, errors) {
  if (findPakFiles(modDir).length === 0) {
    errors.push("No .pak file was found; cook and package the mod before validate.");
  }
}

export const validateOperation = {
  id: "unreal.validate",
  title: "Validate an Unreal mod",
  summary:
    "Check the Lua structure and require references, or confirm that a C++ DLL or pak file exists, and return log guidance.",
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
      ok: { type: "boolean" },
      errors: { type: "array" },
      warnings: { type: "array" },
    },
  },
  effects: ["read"],
  requires: [],
  gates: ["auto"],
  skill: "unreal-debugging",
  docs: [],

  async handler(inputs, context = {}) {
    const modDir = resolveModDirInput(inputs, context);
    const errors = [];
    const warnings = [];
    // A gameDir the caller passes must exist. One remembered by the workspace may be stale: it is skipped
    // with a warning so the mod itself can still be validated.
    let gameDir = null;
    if (inputs.gameDir) {
      gameDir = ensureGameDir(inputs.gameDir);
    } else {
      const remembered =
        context?.workspace?.local?.gameDir ||
        context?.workspace?.profile?.game?.installDir ||
        context?.profile?.game?.installDir ||
        null;
      if (remembered) {
        try {
          gameDir = ensureGameDir(remembered);
        } catch {
          warnings.push(`The game folder the workspace remembers does not exist, so game checks were skipped: ${remembered}`);
        }
      }
    }
    const type = String(inputs.type || inferModType(modDir)).toLowerCase();

    if (type === "lua") validateLua(modDir, gameDir, errors, warnings);
    else if (type === "cpp") validateCpp(modDir, errors);
    else if (type === "pak") validatePak(modDir, errors);
    else errors.push(`Unknown mod type: ${type}. Use lua, cpp or pak.`);

    return {
      data: { ok: errors.length === 0, errors, warnings, type, modDir, gameDir },
    };
  },
};

export default validateOperation;
