// unreal.remove_mod: remove a deployed UE4SS mod from the game, backing up
// every file into the workspace first, so generic.restore can bring it back.

import fs from "node:fs";
import path from "node:path";
import { resolveAuthorization } from "../../../core/authorization.mjs";
import { backupFile } from "../../../core/workspace.mjs";
import { evidence } from "../../../core/evidence.mjs";
import { detectUe4ss } from "../detect.mjs";
import { gmfError, resolveGameDirInput, walkFiles } from "./shared.mjs";
import { authorizationContext } from "./setup_ue4ss.mjs";

// Folders UE4SS itself uses inside Mods/; they are not mods.
const RESERVED = new Set(["shared"]);

export const removeModOperation = {
  id: "unreal.remove_mod",
  title: "Remove a deployed UE4SS mod",
  summary:
    "Back up and remove a deployed mod: a UE4SS mod folder under ue4ss/Mods, or a pak mod's <name>_P files in Content/Paks/~mods or LogicMods. Needs a gameWrite authorization.",
  engine: "unreal",
  inputs: {
    type: "object",
    properties: {
      gameDir: { type: "string" },
      name: { type: "string", description: "The UE4SS mod folder name, or the pak mod name (without _P)." },
    },
    required: ["name"],
  },
  outputs: {
    type: "object",
    properties: {
      removed: { type: "array" },
      target: { type: "string" },
    },
  },
  effects: ["read", "workspaceWrite", "gameWrite"],
  requires: [],
  gates: ["soft"],
  skill: "unreal-ue4ss-lua",
  docs: ["knowledge/unreal/ue4ss-install-config.md"],
  async handler(inputs, context = {}) {
    const name = String(inputs.name || "").trim();
    if (!name || name !== path.basename(name) || name === "." || name === ".." || RESERVED.has(name.toLowerCase())) {
      throw gmfError("GMF-E-PLAN-001", `Not a mod folder name: ${inputs.name}`, "Pass the folder name of one mod under ue4ss/Mods.");
    }
    const gameDir = resolveGameDirInput(inputs, context);
    const { plan, overrides } = authorizationContext(context);
    const authorization = resolveAuthorization({ effects: ["gameWrite"], plan, overrides });
    if (!authorization.allowed) {
      throw gmfError(
        "GMF-E-GATE-001",
        "GMF-E-GATE-001: removing a mod writes into the game folder and needs a gameWrite authorization.",
        'Add a gameWrite authorization to the plan, or pass --authorized gameWrite --source "<user instruction>".',
      );
    }
    if (!context?.workspace?.root) {
      throw gmfError("GMF-E-GATE-001", "GMF-E-GATE-001: removing a mod needs a workspace for the backups.", "Run gmf init first.");
    }
    // A pak mod: <name>_P or <name> container files in Content/Paks/~mods
    // (asset mods) or Content/Paks/LogicMods (Blueprint mods). UE4SS is not needed.
    const pakFiles = [];
    for (const folder of ["~mods", "LogicMods"]) {
      const dir = path.join(gameDir, "Content", "Paks", folder);
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        const match = file.match(/^(.+?)\.(pak|utoc|ucas|sig)$/i);
        if (match && (match[1] === name || match[1] === `${name}_P`)) pakFiles.push(path.join(dir, file));
      }
    }
    if (pakFiles.length > 0) {
      const removed = pakFiles.map((file) => ({ target: file, backup: backupFile(context.workspace, file).backupPath }));
      for (const file of pakFiles) fs.rmSync(file, { force: true });
      return {
        data: { removed, target: path.dirname(pakFiles[0]) },
        evidence: [
          evidence({
            claim: `Removed pak mod ${name} (${removed.length} files) after backing each file up.`,
            confidence: "observed",
            authority: "controlled-replay",
            source: path.dirname(pakFiles[0]),
            detail: { files: removed.length },
          }),
        ],
        authorization: { effect: "gameWrite", source: authorization.source },
      };
    }
    const loader = detectUe4ss(gameDir);
    if (!loader.installed || !loader.path) {
      throw gmfError("GMF-E-TOOL-001", "GMF-E-TOOL-001: UE4SS is not installed in this game.", "Nothing to remove.");
    }
    const target = path.join(loader.path, "Mods", name);
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      throw gmfError("GMF-E-PLAN-001", `No deployed mod named ${name} under ${path.dirname(target)}`, "Check the folder name.");
    }
    const removed = walkFiles(target).map((file) => ({ target: file, backup: backupFile(context.workspace, file).backupPath }));
    fs.rmSync(target, { recursive: true, force: true });
    return {
      data: { removed, target },
      evidence: [
        evidence({
          claim: `Removed ${name} (${removed.length} files) from ${path.dirname(target)} after backing each file up.`,
          confidence: "observed",
          authority: "controlled-replay",
          source: target,
          detail: { files: removed.length },
        }),
      ],
      authorization: { effect: "gameWrite", source: authorization.source },
    };
  },
};

export default removeModOperation;
