import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { registerOperation, getHandler } from "../../core/operations.mjs";
import {
  detectStore,
  findGameExecutable,
  readAppInfo,
} from "../../core/profile.mjs";
import { assertGameDir } from "../../engines/unity/detect.mjs";
import { isInside } from "../../core/fsutil.mjs";

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function identifyGame(gameDir, { executable = null } = {}) {
  const root = assertGameDir(gameDir);
  const name = executable || findGameExecutable(root);
  const executablePath = name ? path.resolve(root, name) : null;
  if (executablePath && !isInside(root, executablePath)) {
    const error = new Error(`Executable is outside the game directory: ${executablePath}`);
    error.code = "GMF-E-GAME-001";
    error.remediation = "Pass an executable path that exists inside the game directory.";
    throw error;
  }
  if (executablePath && !fs.existsSync(executablePath)) {
    const error = new Error(`Executable not found: ${executablePath}`);
    error.code = "GMF-E-GAME-001";
    error.remediation = "Pass an executable path that exists inside the game directory.";
    throw error;
  }
  const appInfo = readAppInfo(root);
  return {
    executable: executablePath,
    sha256: executablePath ? sha256File(executablePath) : null,
    size: executablePath ? fs.statSync(executablePath).size : null,
    product: appInfo.product,
    company: appInfo.company,
    appInfo: appInfo.source,
    store: detectStore(root),
  };
}

const operation = {
  id: "game.identity",
  title: "Identify a game",
  summary: "Hash the game executable and read the product, company and store identity hints.",
  engine: "core",
  inputs: {
    type: "object",
    properties: {
      gameDir: { type: "string" },
      executable: { type: "string" },
    },
    required: ["gameDir"],
  },
  outputs: {
    type: "object",
    properties: {
      sha256: { type: "string" },
      product: { type: "string" },
      company: { type: "string" },
      store: { type: "object" },
    },
  },
  effects: ["read"],
  requires: [],
  gates: ["auto"],
  skill: "gmf-investigate",
  docs: [],
  handler: async (inputs) => {
    const identity = identifyGame(inputs.gameDir, { executable: inputs.executable || null });
    return { data: identity, evidence: [] };
  },
};

if (!getHandler(operation.id)) registerOperation(operation, operation.handler);

export default operation;
