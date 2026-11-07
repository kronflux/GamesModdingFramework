import path from "node:path";
import { registerOperation, getHandler } from "../../core/operations.mjs";
import { evidence, mergeEvidence } from "../../core/evidence.mjs";
import {
  CONFIG_FILE,
  initWorkspace,
  readJson,
  readProfile,
  writeJson,
  writeProfile,
} from "../../core/workspace.mjs";
import { detectGameProfile } from "./detect.mjs";
import { inventoryGame } from "./inventory.mjs";

function workspaceFor(gameDir, context = {}) {
  if (context.workspace) return context.workspace;
  const workspaceDir =
    context.flags?.workspace || context.workspaceDir || context.cwd || process.cwd();
  return initWorkspace({
    gameDir,
    workspaceDir,
    author: context.flags?.author || context.author || "",
  });
}

function updateCommittedIdentity(workspace, profile) {
  const configPath = path.join(workspace.root, CONFIG_FILE);
  const config = readJson(configPath, { version: 1, game: {}, package: {} });
  config.game = {
    ...(config.game || {}),
    name: profile.game.name,
    engine: profile.engine.id,
  };
  writeJson(configPath, config);
  workspace.config = config;
}

const operation = {
  id: "game.profile",
  title: "Profile a game",
  summary:
    "Detect the engine, read identity, runtime, loader and paths, assemble a profile with evidence and unknowns, and write it into the workspace.",
  engine: "core",
  inputs: {
    type: "object",
    properties: {
      gameDir: { type: "string" },
    },
    required: ["gameDir"],
  },
  outputs: {
    type: "object",
    properties: {
      profile: { type: "object" },
      evidence: { type: "array" },
      unknowns: { type: "array" },
    },
  },
  effects: ["read", "workspaceWrite"],
  requires: [],
  gates: ["auto"],
  skill: "gmf-investigate",
  docs: [],
  handler: async (inputs, context) => {
    const { profile } = await detectGameProfile(inputs.gameDir, context);
    const inventory = inventoryGame(inputs.gameDir);
    const workspace = workspaceFor(inputs.gameDir, context);
    const previous = readProfile(workspace);

    if (
      previous?.game?.sha256 &&
      profile.game?.sha256 &&
      previous.game.sha256 !== profile.game.sha256
    ) {
      profile.previous = {
        sha256: previous.game.sha256,
        generatedAt: previous.generatedAt || null,
      };
      profile.evidence = mergeEvidence(profile.evidence, [
        evidence({
          claim: `The game executable changed since the previous profile (${previous.game.sha256.slice(0, 12)} to ${profile.game.sha256.slice(0, 12)})`,
          confidence: "observed",
          authority: "shipped-artifact",
          source: profile.game.executable || inputs.gameDir,
        }),
      ]);
    }

    writeProfile(workspace, profile);
    updateCommittedIdentity(workspace, profile);

    return {
      data: {
        profile,
        evidence: profile.evidence,
        unknowns: profile.unknowns,
        inventory: {
          files: inventory.counts.files,
          dirs: inventory.counts.dirs,
        },
      },
      evidence: profile.evidence,
    };
  },
};

if (!getHandler(operation.id)) registerOperation(operation, operation.handler);

export default operation;
