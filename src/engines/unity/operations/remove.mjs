// unity.remove_mod: remove a deployed Unity mod from the game, backing up
// every file into the workspace first, so generic.restore can bring it back.
// BepInEx plugins live in BepInEx/plugins/<name>/ (or BepInEx/plugins/<name>.dll);
// MelonLoader mods are Mods/<name>.dll.

import fs from "node:fs";
import path from "node:path";
import { registerOperation, getHandler } from "../../../core/operations.mjs";
import { authorizeEffects } from "../../../core/authorization.mjs";
import { backupFile } from "../../../core/workspace.mjs";
import { evidence } from "../../../core/evidence.mjs";
import { assertGameDir } from "../detect.mjs";
import { gameDirFor } from "./defaults.mjs";

function fail(code, message, remediation) {
  const error = new Error(message);
  error.code = code;
  error.remediation = remediation;
  return error;
}

// Every regular file under dir. A link or other special entry cannot be backed
// up as a file, so it stops the walk before anything is changed.
function filesUnder(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(full, found);
    else if (entry.isFile()) found.push(full);
    else {
      throw fail(
        "GMF-E-EXEC-001",
        `Refusing to remove a mod folder that holds a link or special entry: ${full}`,
        "Remove that entry by hand, or delete the mod folder yourself; gmf only removes folders it can back up completely.",
      );
    }
  }
  return found;
}

// The deployed mod as { target, loader, isDirectory }, or null.
export function findDeployedMod(gameDir, name) {
  const candidates = [
    { target: path.join(gameDir, "BepInEx", "plugins", name), loader: "bepinex", isDirectory: true },
    { target: path.join(gameDir, "BepInEx", "plugins", `${name}.dll`), loader: "bepinex", isDirectory: false },
    { target: path.join(gameDir, "Mods", `${name}.dll`), loader: "melonloader", isDirectory: false },
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.target)) continue;
    if (fs.statSync(candidate.target).isDirectory() === candidate.isDirectory) return candidate;
  }
  return null;
}

const operation = {
  id: "unity.remove_mod",
  title: "Remove a deployed Unity mod",
  summary:
    "Back up every file of a deployed BepInEx plugin or MelonLoader mod into the workspace, then remove it from the game. Needs a gameWrite authorization.",
  engine: "unity",
  inputs: {
    type: "object",
    properties: {
      gameDir: { type: "string" },
      name: { type: "string", description: "The plugin folder under BepInEx/plugins, or the assembly name under Mods, without .dll." },
    },
    required: ["name"],
  },
  outputs: {
    type: "object",
    properties: {
      removed: { type: "array" },
      target: { type: "string" },
      loader: { type: "string" },
    },
  },
  effects: ["read", "workspaceWrite", "gameWrite"],
  requires: [],
  gates: ["soft"],
  skill: "unity-bepinex",
  docs: ["knowledge/unity/bepinex.md"],
  async handler(inputs, context = {}) {
    const name = String(inputs.name || "").trim().replace(/\.dll$/i, "");
    if (!name || name !== path.basename(name) || name === "." || name === "..") {
      throw fail("GMF-E-PLAN-001", `Not a mod name: ${inputs.name}`, "Pass the plugin folder or assembly name of one deployed mod.");
    }
    const gameDirInput = gameDirFor(inputs, context);
    if (!gameDirInput) {
      throw fail("GMF-E-EXEC-001", "unity.remove_mod needs a game directory", "Pass --input gameDir=<dir>, or run gmf investigate first.");
    }
    const gameDir = assertGameDir(gameDirInput);
    const authorization = authorizeEffects(["gameWrite"], context);
    if (!authorization.allowed) {
      throw fail(
        "GMF-E-GATE-001",
        `GMF-E-GATE-001: removing a mod writes into the game folder and needs a gameWrite authorization (${authorization.reason}).`,
        'Add a gameWrite authorization to the plan, or pass --authorized gameWrite --source "<user instruction>".',
      );
    }
    if (!context.workspace?.root) {
      throw fail("GMF-E-GATE-001", "GMF-E-GATE-001: removing a mod needs a workspace for the backups.", "Run gmf init first.");
    }
    const found = findDeployedMod(gameDir, name);
    if (!found) {
      throw fail(
        "GMF-E-PLAN-001",
        `No deployed mod named ${name} under BepInEx/plugins or Mods in ${gameDir}`,
        "Check the plugin folder or assembly name.",
      );
    }
    if (fs.lstatSync(found.target).isSymbolicLink()) {
      throw fail(
        "GMF-E-EXEC-001",
        `Refusing to remove a link: ${found.target}`,
        "Remove the link by hand; gmf only removes folders and files it can back up.",
      );
    }
    const files = found.isDirectory ? filesUnder(found.target) : [found.target];
    const removed = files.map((file) => ({ target: file, backup: backupFile(context.workspace, file).backupPath }));
    fs.rmSync(found.target, { recursive: true, force: true });
    return {
      data: { removed, target: found.target, loader: found.loader },
      evidence: [
        evidence({
          claim: `Removed ${name} (${removed.length} files) from ${path.dirname(found.target)} after backing each file up.`,
          confidence: "observed",
          authority: "controlled-replay",
          source: found.target,
          detail: { files: removed.length, loader: found.loader },
        }),
      ],
      authorization: { effect: "gameWrite", source: authorization.source, gate: authorization.gate },
    };
  },
};

if (!getHandler(operation.id)) registerOperation(operation, operation.handler);

export default operation;
