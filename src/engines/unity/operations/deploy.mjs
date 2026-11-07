import fs from "node:fs";
import path from "node:path";
import { registerOperation, getHandler } from "../../../core/operations.mjs";
import { authorizeEffects } from "../../../core/authorization.mjs";
import { evidence } from "../../../core/evidence.mjs";
import { copyFilesWithBackup } from "../../../core/gamewrite.mjs";
import { assertGameDir, detectLoader } from "../detect.mjs";
import { gameDirFor, modDirFor } from "./defaults.mjs";

// The mod's own assembly under <modDir>/bin: a file named <name>.dll, a Release
// build before any other, then the newest. Returns null when no file carries
// the mod's name, so a dependency DLL is never taken for the mod.
export function findBuiltAssembly(modDir, name = path.basename(modDir)) {
  const root = path.resolve(modDir);
  const wanted = `${name.toLowerCase()}.dll`;
  const found = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase() === wanted) found.push(full);
    }
  };
  const binDir = path.join(root, "bin");
  walk(binDir);
  const isRelease = (file) => path.relative(binDir, file).toLowerCase().split(path.sep).includes("release");
  const rank = (file) => [isRelease(file) ? 1 : 0, fs.statSync(file).mtimeMs];
  found.sort((a, b) => {
    const [releaseA, timeA] = rank(a);
    const [releaseB, timeB] = rank(b);
    return releaseB - releaseA || timeB - timeA || a.localeCompare(b);
  });
  return found[0] || null;
}

function deployDirectory(gameDir, profile, backend) {
  const loaderId = profile?.loader?.id;
  if (loaderId === "bepinex5" || loaderId === "bepinex6") {
    return { loader: loaderId, directory: path.join(gameDir, "BepInEx", "plugins"), nested: true };
  }
  if (loaderId === "melonloader") {
    return { loader: loaderId, directory: path.join(gameDir, "Mods"), nested: false };
  }
  const detected = detectLoader(gameDir, backend).loader;
  if (detected.id === "bepinex5" || detected.id === "bepinex6") {
    return { loader: detected.id, directory: path.join(gameDir, "BepInEx", "plugins"), nested: true };
  }
  if (detected.id === "melonloader") {
    return { loader: detected.id, directory: path.join(gameDir, "Mods"), nested: false };
  }
  return null;
}

const operation = {
  id: "unity.deploy",
  title: "Deploy a Unity mod",
  summary: "Copy a built mod assembly into the installed loader's plugin folder, backing up every overwritten file first.",
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
      deployed: { type: "array" },
      backup: { type: "object" },
    },
  },
  effects: ["gameWrite"],
  requires: [],
  gates: ["soft"],
  skill: "unity-bepinex",
  docs: [],
  handler: async (inputs, context) => {
    const gameDirInput = gameDirFor(inputs, context);
    if (!gameDirInput) {
      const error = new Error("unity.deploy needs a game directory");
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Pass --input gameDir=<dir>, or run gmf investigate first.";
      throw error;
    }
    const gameDir = assertGameDir(gameDirInput);
    if (!context.workspace?.root) {
      const error = new Error(
        "GMF-E-GATE-001: unity.deploy needs a workspace so an overwritten file can be backed up before the write.",
      );
      error.code = "GMF-E-GATE-001";
      error.remediation = "Run gmf init and gmf investigate first, or pass --workspace.";
      throw error;
    }

    const authorization = authorizeEffects(["gameWrite"], context);
    if (!authorization.allowed) {
      const error = new Error(
        `GMF-E-GATE-001: unity.deploy writes into the game folder and needs a gameWrite authorization (${authorization.reason}).`,
      );
      error.code = "GMF-E-GATE-001";
      error.remediation = "Pass --authorized gameWrite --source \"<quoted user instruction or plan step>\".";
      throw error;
    }

    const modDir = modDirFor(inputs, context);
    if (!modDir) {
      const error = new Error("unity.deploy needs a mod project folder");
      error.code = "GMF-E-EXEC-001";
      error.remediation =
        "Pass --input modDir=<dir>, or scaffold exactly one mod so the workspace mods folder has one project.";
      throw error;
    }
    const name = path.basename(modDir);
    const built = findBuiltAssembly(modDir, name);
    if (!built) {
      const error = new Error(`No built assembly was found under ${path.join(modDir, "bin")}`);
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Run unity.build first; deploy copies the assembly from bin/Release.";
      throw error;
    }

    const profile = context.workspace.profile || null;
    const backend = profile?.runtime?.backend || "mono";
    const target = deployDirectory(gameDir, profile, backend);
    if (!target) {
      const error = new Error("No BepInEx or MelonLoader installation was found to deploy into");
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Install BepInEx or MelonLoader for this game, then run unity.deploy again.";
      throw error;
    }

    const deployDir = target.nested ? path.join(target.directory, name) : target.directory;
    const destination = path.join(deployDir, `${name}.dll`);
    const written = copyFilesWithBackup(context.workspace, [{ source: built, target: destination }]);
    const record = written.deployed[0];
    const backup = record.backup ? { backupPath: record.backup, sha256: record.sha256 } : null;

    return {
      data: { deployed: [destination], backup, built, loader: target.loader, modDir },
      evidence: [
        evidence({
          claim: `Deployed ${path.basename(built)} to ${destination}`,
          confidence: "observed",
          authority: "controlled-replay",
          source: destination,
          detail: { backup: backup ? backup.backupPath : null, loader: target.loader },
        }),
      ],
      authorization: { effect: "gameWrite", source: authorization.source, gate: authorization.gate },
    };
  },
};

if (!getHandler(operation.id)) registerOperation(operation, operation.handler);

export default operation;
