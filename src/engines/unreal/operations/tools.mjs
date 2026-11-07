// unreal.crash_stack and unreal.lua_check: read-only diagnostics for UE4SS mods.

import fs from "node:fs";
import path from "node:path";
import { parseCrashStack } from "../crash.mjs";
import { checkLuaBalance, checkModuleRefs, runLanguageServer } from "../luacheck.mjs";
import { gmfError, isDirectory, isFile, resolveModDirInput, walkFiles, workspaceRoot } from "./shared.mjs";

export const crashStackOperation = {
  id: "unreal.crash_stack",
  title: "Read a UE4SS crash stack",
  summary: "Parse a crash log or cdb stack text into frames, the faulting module and the nearest mod file.",
  engine: "unreal",
  inputs: {
    type: "object",
    properties: { file: { type: "string" } },
    required: ["file"],
  },
  outputs: {
    type: "object",
    properties: {
      frames: { type: "array" },
      faultingModule: { type: ["string", "null"] },
      nearestMod: { type: ["string", "null"] },
    },
  },
  effects: ["read"],
  requires: [],
  gates: ["auto"],
  skill: "unreal-debugging",
  docs: [],

  async handler(inputs, context = {}) {
    const raw = String(inputs?.file || "");
    const file = path.resolve(path.isAbsolute(raw) ? raw : path.join(workspaceRoot(context), raw));
    if (!raw || !isFile(file)) {
      throw gmfError(
        "GMF-E-GAME-001",
        `GMF-E-GAME-001: crash log does not exist: ${file}`,
        "Pass the crash log or saved stack text, for example --input file=<path>.",
      );
    }
    return { data: { file, ...parseCrashStack(fs.readFileSync(file, "utf8")) } };
  },
};

export const luaCheckOperation = {
  id: "unreal.lua_check",
  title: "Check Lua structure",
  summary:
    "Check block and bracket balance, module field references and, when lua-language-server is on PATH, its warnings. Nothing is installed.",
  engine: "unreal",
  inputs: {
    type: "object",
    properties: {
      modDir: { type: "string" },
      languageServer: { type: "boolean", default: true },
    },
    required: [],
  },
  outputs: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      issues: { type: "array" },
      languageServer: { type: "object" },
    },
  },
  effects: ["read"],
  requires: [],
  gates: ["auto"],
  skill: "unreal-debugging",
  docs: [],

  async handler(inputs = {}, context = {}) {
    const modDir = resolveModDirInput(inputs, context);
    const scriptsDir = path.join(modDir, "Scripts");
    if (!isDirectory(scriptsDir)) {
      throw gmfError(
        "GMF-E-GAME-001",
        `GMF-E-GAME-001: the mod has no Scripts folder: ${scriptsDir}`,
        "Pass a Lua mod folder created by unreal.scaffold.",
      );
    }
    const issues = [];
    for (const file of walkFiles(scriptsDir).filter((entry) => entry.toLowerCase().endsWith(".lua"))) {
      const rel = path.relative(scriptsDir, file).split(path.sep).join("/");
      issues.push(...checkLuaBalance(fs.readFileSync(file, "utf8"), rel));
    }
    issues.push(...checkModuleRefs(scriptsDir));

    let languageServer = { ran: false, reason: "disabled by input" };
    if (inputs.languageServer !== false) {
      const result = runLanguageServer(scriptsDir);
      languageServer = result.ran ? { ran: true } : { ran: false, reason: result.reason };
      issues.push(...result.issues);
    }
    return {
      data: {
        ok: !issues.some((entry) => entry.severity === "error"),
        modDir,
        issues,
        languageServer,
      },
    };
  },
};

export const toolOperations = [crashStackOperation, luaCheckOperation];
