import { registerOperation, getHandler } from "../../core/operations.mjs";
import { detectAll, loadEngineModules } from "../../engines/index.mjs";
import { buildProfile } from "../../core/profile.mjs";
import { assertGameDir } from "../../engines/unity/detect.mjs";
import { engineHints } from "./hints.mjs";
import { resolveTool, toolCacheDir } from "../../core/tools.mjs";
import { loadCatalog } from "../../core/catalog.mjs";

// Resolve every registered tool against the tool cache and PATH so the profile
// records what is installed; capabilities and plans depend on it.
function registeredTools(context) {
  if (Array.isArray(context.tools)) return context.tools;
  let catalog = context.catalog;
  if (!catalog || !Array.isArray(catalog.tools)) {
    try {
      catalog = loadCatalog(context.root || process.cwd());
    } catch {
      return [];
    }
  }
  const cacheDir = context.toolCacheDir || toolCacheDir(context.env || process.env);
  return (catalog.tools || []).map((tool) => {
    let resolved = null;
    try {
      resolved = resolveTool(tool.id, { cacheDir });
    } catch {
      resolved = null;
    }
    return {
      id: tool.id,
      installed: Boolean(resolved),
      version: resolved?.version || null,
      path: resolved?.path || null,
      license: tool.license || "",
    };
  });
}

export { assertGameDir };

export async function detectGameProfile(gameDir, context = {}) {
  const resolved = assertGameDir(gameDir);
  let modules = context.engineModules;
  if (!Array.isArray(modules)) {
    modules = await loadEngineModules(context.root || process.cwd(), context.moduleDirs || null);
  }
  if (modules.length === 0) {
    const error = new Error("No engine modules were found; cannot detect the game engine");
    error.code = "GMF-E-DETECT-001";
    error.remediation = "Check that src/engines contains an engine module with a detect() function.";
    throw error;
  }
  const detections = await detectAll(resolved, modules, { generic: true });
  const profile = buildProfile({
    gameDir: resolved,
    detections,
    tools: registeredTools(context),
    markers: context.markers || null,
  });
  if (profile.engine.id === "unknown") profile.engine.hints = engineHints(resolved);
  return { profile, detections, gameDir: resolved };
}

const operation = {
  id: "game.detect",
  title: "Detect a game",
  summary: "Identify a game's engine, version, runtime, loader and paths without writing into the game folder.",
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
    },
  },
  effects: ["read"],
  requires: [],
  gates: ["auto"],
  skill: "gmf-investigate",
  docs: [],
  handler: async (inputs, context) => {
    const { profile } = await detectGameProfile(inputs.gameDir, context);
    return { data: { profile }, evidence: profile.evidence };
  },
};

if (!getHandler(operation.id)) registerOperation(operation, operation.handler);

export default operation;
