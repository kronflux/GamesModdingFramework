import fs from "node:fs";
import path from "node:path";
import { registerOperation, getHandler } from "../../core/operations.mjs";
import {
  AGENTS_FILE,
  CONFIG_FILE,
  initWorkspace,
  readJson,
  renderWorkspaceTemplate,
  writeJson,
} from "../../core/workspace.mjs";
import { assertGameDir, detectGameProfile } from "../game/detect.mjs";
import { isInside } from "../../core/fsutil.mjs";

const operation = {
  id: "workspace.init",
  title: "Initialize a workspace",
  summary:
    "Create the committed identity and machine path files for a game, and record the detected engine when one is identified.",
  engine: "core",
  inputs: {
    type: "object",
    properties: {
      gameDir: { type: "string" },
      workspaceDir: { type: "string" },
      author: { type: "string" },
    },
    required: ["gameDir"],
  },
  outputs: {
    type: "object",
    properties: {
      workspace: { type: "object" },
      written: { type: "array", items: { type: "string" } },
      skipped: { type: "array", items: { type: "string" } },
    },
  },
  effects: ["read", "workspaceWrite"],
  requires: [],
  gates: ["auto"],
  skill: "gmf-investigate",
  docs: [],
  handler: async (inputs, context) => {
    const gameDir = assertGameDir(inputs.gameDir);
    const base = context.cwd || process.cwd();
    const workspaceDir = path.resolve(base, inputs.workspaceDir || base);
    // A caller that names its working folder (an MCP client, a hook) creates
    // the workspace there or below it, never in an unrelated folder, because
    // every later containment check is relative to the folder holding gmf.json.
    // The CLI's --workspace flag is the user's own choice and is not confined.
    const confined = Boolean(context.cwd) && !context.flags?.workspace;
    if (confined && !isInside(base, workspaceDir) && !(context.workspace?.root && isInside(context.workspace.root, workspaceDir))) {
      const error = new Error(`GMF-E-PLAN-001: the workspace folder must be inside the working folder: ${workspaceDir}`);
      error.code = "GMF-E-PLAN-001";
      error.remediation = "Run gmf init from the folder that should hold the workspace, or pass a sub-folder of it.";
      throw error;
    }
    const workspace = initWorkspace({
      gameDir,
      workspaceDir,
      author: inputs.author || "",
    });

    let profile = null;
    try {
      const detected = await detectGameProfile(gameDir, context);
      profile = detected.profile;
    } catch {
      profile = null;
    }

    if (profile) {
      const configPath = path.join(workspace.root, CONFIG_FILE);
      const config = readJson(configPath, { version: 1, game: {}, package: {} });
      config.game = {
        ...(config.game || {}),
        name: profile.game.name || config.game?.name,
        engine: profile.engine.id,
      };
      writeJson(configPath, config);
      workspace.config = config;
    }

    if (workspace.written.includes(AGENTS_FILE)) {
      fs.writeFileSync(
        path.join(workspace.root, AGENTS_FILE),
        renderWorkspaceTemplate("AGENTS.md.tpl", {
          gameName: workspace.config.game?.name,
          engine: workspace.config.game?.engine,
          author: workspace.config.game?.author,
        }),
      );
    }

    return {
      data: {
        workspace: {
          root: workspace.root,
          config: workspace.config,
          local: workspace.local,
        },
        written: workspace.written,
        skipped: workspace.skipped,
      },
      evidence: profile?.evidence || [],
    };
  },
};

if (!getHandler(operation.id)) registerOperation(operation, operation.handler);

export default operation;
