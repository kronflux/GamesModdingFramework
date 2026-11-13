// Unreal Engine module: detection, capabilities and the unreal.* operation set.

import { detectUnreal } from "./detect.mjs";
import { setupUe4ssOperation } from "./operations/setup_ue4ss.mjs";
import { ue4ssSettingsOperation } from "./operations/settings.mjs";
import { dumpOperation, deployDumperOperation } from "./operations/dump.mjs";
import { normalizeOperation } from "./operations/normalize.mjs";
import { verifyDumpOperation } from "./operations/verify_dump.mjs";
import { scaffoldOperation } from "./operations/scaffold.mjs";
import { buildOperation } from "./operations/build.mjs";
import { deployOperation } from "./operations/deploy.mjs";
import { removeModOperation } from "./operations/remove.mjs";
import { validateOperation } from "./operations/validate.mjs";
import { packageOperation } from "./operations/package.mjs";
import { assetOperations } from "./operations/assets.mjs";
import { toolOperations } from "./operations/tools.mjs";
import { sigOperations } from "./operations/sig.mjs";

function toolInstalled(profile, id) {
  return (profile?.tools || []).some((tool) => tool.id === id && tool.installed === true);
}

export function capabilities(profile = {}) {
  const ue4ssInstalled = profile?.loader?.id === "ue4ss" && profile.loader.installed === true;
  return [
    {
      id: "code",
      support: ue4ssInstalled ? "full" : "needs-tool",
      requires: ue4ssInstalled ? [] : ["ue4ss"],
      reason: ue4ssInstalled
        ? "UE4SS hosts Lua and C++ mods in this game."
        : "UE4SS is required to host Lua and C++ mods.",
    },
    {
      id: "assets",
      support: toolInstalled(profile, "retoc") && toolInstalled(profile, "repak") ? "full" : "needs-tool",
      requires: ["retoc", "repak"],
      reason: "retoc (IoStore) and repak (pak) extract cooked assets into the workspace and pack asset mods.",
    },
    {
      id: "replace",
      support: toolInstalled(profile, "uassetgui") ? "full" : "needs-tool",
      requires: ["uassetgui"],
      reason: "UAssetGUI converts assets to JSON and back so they can be edited before packing.",
    },
    {
      id: "pak",
      support: toolInstalled(profile, "repak") ? "full" : "needs-tool",
      requires: ["repak"],
      reason: "repak, or the UnrealPak that matches the game's engine version, packages pak mods.",
    },
    {
      id: "decompile",
      support: "unsupported",
      requires: [],
      reason: "Unreal games ship native code; use object, usmap and header dumps instead.",
    },
  ];
}

export const operations = [
  setupUe4ssOperation,
  ue4ssSettingsOperation,
  dumpOperation,
  deployDumperOperation,
  normalizeOperation,
  verifyDumpOperation,
  scaffoldOperation,
  buildOperation,
  deployOperation,
  removeModOperation,
  validateOperation,
  packageOperation,
  ...assetOperations,
  ...toolOperations,
  ...sigOperations,
];

export default {
  id: "unreal",
  name: "Unreal Engine",
  version: "0.3.0",
  detect: detectUnreal,
  capabilities,
  operations,
  templatesDir: "templates/unreal",
  knowledgeDir: "knowledge/unreal",
  tools: ["ue4ss", "retoc", "repak", "uassetgui", "xmake"],
};

export { detectUnreal };
