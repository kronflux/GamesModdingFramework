// unity.setup_loader: install a Unity mod loader next to the game executable.
//
// The loader archive (for BepInEx 6: winhttp.dll, doorstop_config.ini,
// .doorstop_version, BepInEx/, dotnet/) is fetched through the tool registry
// and copied into the game root, backing up every file it would overwrite.
// It needs a toolInstall authorization (download) and a gameWrite one (the
// game folder). After the install the game must be launched once so the loader
// generates its interop assemblies (IL2CPP) before mods can build.

import fs from "node:fs";
import path from "node:path";
import { registerOperation, getHandler } from "../../../core/operations.mjs";
import { activePlan, authorizationOverrides, resolveAuthorization } from "../../../core/authorization.mjs";
import { evidence } from "../../../core/evidence.mjs";
import { installTool, toolCacheDir } from "../../../core/tools.mjs";
import { copyFilesWithBackup } from "../../../core/gamewrite.mjs";
import { assertGameDir, detectBackend, detectLoader, findDataDir } from "../detect.mjs";
import { gameDirFor } from "./defaults.mjs";

// Loader ids accepted by this operation, mapped to their tool registry id.
export const LOADER_TOOLS = Object.freeze({
  "bepinex6-il2cpp": "bepinex6-il2cpp",
});

// The loader the plan draft proposes for a backend.
export function defaultLoaderFor(backend) {
  return backend === "il2cpp" ? "bepinex6-il2cpp" : "bepinex5";
}

function gateError(message) {
  const error = new Error(message);
  error.code = "GMF-E-GATE-001";
  error.remediation =
    'Add toolInstall and gameWrite authorizations to the plan, or pass --authorized toolInstall,gameWrite --source "<user instruction>".';
  return error;
}

export const overridesFrom = authorizationOverrides;

function walk(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

const operation = {
  id: "unity.setup_loader",
  title: "Install a Unity mod loader",
  summary:
    "Download a registered Unity mod loader (BepInEx 6 bleeding edge for IL2CPP) and copy it next to the game executable, backing up every file it overwrites. Needs toolInstall and gameWrite authorizations.",
  engine: "unity",
  inputs: {
    type: "object",
    properties: {
      gameDir: { type: "string" },
      loader: { type: "string", description: "bepinex6-il2cpp. Default: the loader for the detected backend." },
    },
    required: [],
  },
  outputs: {
    type: "object",
    properties: {
      loader: { type: "string" },
      version: { type: "string" },
      files: { type: "integer" },
      backups: { type: "array" },
      verification: { type: "object" },
    },
  },
  effects: ["read", "network", "toolInstall", "gameWrite"],
  requires: [],
  gates: ["soft"],
  skill: "unity-bepinex",
  docs: ["knowledge/unity/bepinex.md", "knowledge/unity/il2cpp-interop.md"],
  handler: async (inputs, context = {}) => {
    const gameDirInput = gameDirFor(inputs, context);
    if (!gameDirInput) {
      const error = new Error("unity.setup_loader needs a game directory");
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Pass --input gameDir=<dir>, or run gmf investigate first.";
      throw error;
    }
    const gameDir = assertGameDir(gameDirInput);
    // The profile's backend, else the one the game folder shows.
    const backend = context.workspace?.profile?.runtime?.backend || detectBackend(gameDir, findDataDir(gameDir)).backend;
    if (!inputs.loader && backend !== "mono" && backend !== "il2cpp") {
      const error = new Error(`unity.setup_loader cannot tell which scripting backend ${gameDir} uses`);
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Run gmf investigate first, or pass --input loader=bepinex6-il2cpp for an IL2CPP game.";
      throw error;
    }
    const loader = inputs.loader || defaultLoaderFor(backend);
    const toolId = LOADER_TOOLS[loader];
    if (!toolId) {
      const error = new Error(`Unsupported loader: ${loader}`);
      error.code = "GMF-E-PLAN-001";
      error.remediation = `Use one of ${Object.keys(LOADER_TOOLS).join(", ")}.`;
      throw error;
    }

    const plan = context.plan || activePlan(context);
    const overrides = overridesFrom(context);
    const sources = {};
    for (const effect of ["toolInstall", "gameWrite"]) {
      const authorization = resolveAuthorization({ effects: [effect], plan, overrides });
      if (!authorization.allowed) {
        throw gateError(`GMF-E-GATE-001: unity.setup_loader needs a ${effect} authorization (${authorization.reason}).`);
      }
      sources[effect] = authorization.source;
    }
    if (!context.workspace?.root) {
      throw gateError("GMF-E-GATE-001: unity.setup_loader needs a workspace so overwritten game files can be backed up.");
    }

    const source = sources.toolInstall;
    const installed = await installTool(toolId, {
      authorized: true,
      source,
      catalog: context.catalog,
      cacheDir: context.toolCacheDir || toolCacheDir(context.env || process.env),
      fetchImpl: context.fetchImpl || globalThis.fetch,
    });

    // The archive root (the folder holding the entry file) maps onto the game root.
    const sourceRoot = path.dirname(installed.path);
    const pairs = walk(sourceRoot).map((file) => ({ source: file, target: path.join(gameDir, path.relative(sourceRoot, file)) }));
    const written = copyFilesWithBackup(context.workspace, pairs);
    const backups = written.backups;
    const files = written.deployed.length;

    const detected = detectLoader(gameDir, backend).loader;
    return {
      data: {
        loader,
        version: installed.version,
        release: installed.release || null,
        files,
        backups,
        verification: installed.verification,
        detected: { id: detected.id, installed: detected.installed },
        next: "Launch the game once so the loader generates its interop assemblies, then rerun gmf investigate.",
      },
      evidence: [
        evidence({
          claim: `${loader} ${installed.version} was copied into ${gameDir} (${files} files, ${backups.length} backed up).`,
          confidence: "observed",
          authority: "controlled-replay",
          source: gameDir,
          detail: { loader, verification: installed.verification },
        }),
      ],
      authorization: {
        effect: "toolInstall,gameWrite",
        source: [...new Set(Object.values(sources))].join("; "),
        sources,
      },
    };
  },
};

if (!getHandler(operation.id)) registerOperation(operation, operation.handler);

export default operation;
