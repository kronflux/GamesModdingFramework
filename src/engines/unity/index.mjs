import { capabilityList } from "../../core/profile.mjs";
import { detectUnity } from "./detect.mjs";
import gameDetect from "../../operations/game/detect.mjs";
import gameProfile from "../../operations/game/profile.mjs";
import gameInventory from "../../operations/game/inventory.mjs";
import gameIdentity from "../../operations/game/identity.mjs";
import gameGames from "../../operations/game/games.mjs";
import gameHints from "../../operations/game/hints.mjs";
import workspaceInit from "../../operations/workspace/init.mjs";
import decompile from "./operations/decompile.mjs";
import setupLoader from "./operations/setup_loader.mjs";
import normalizeDump from "./operations/normalize.mjs";
import scaffold from "./operations/scaffold.mjs";
import build from "./operations/build.mjs";
import deploy from "./operations/deploy.mjs";
import removeMod from "./operations/remove.mjs";
import validate from "./operations/validate.mjs";
import packageOperation from "./operations/package.mjs";
import assetOperations from "./operations/assets.mjs";

const operations = [
  gameDetect,
  gameProfile,
  gameInventory,
  gameIdentity,
  gameGames,
  gameHints,
  workspaceInit,
  setupLoader,
  decompile,
  normalizeDump,
  scaffold,
  build,
  deploy,
  removeMod,
  validate,
  packageOperation,
  ...assetOperations,
];

export default {
  id: "unity",
  name: "Unity",
  version: "0.3.0",
  detect: detectUnity,
  capabilities: capabilityList,
  operations,
  templatesDir: "templates/unity",
  knowledgeDir: "knowledge/unity",
  tools: ["ilspycmd", "cpp2il", "il2cppdumper", "assetstudio", "assetripper", "unitypy"],
};
