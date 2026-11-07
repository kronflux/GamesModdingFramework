import path from "node:path";
import { getHandler, registerOperation } from "../../core/operations.mjs";
import { createBackup } from "../../core/safety.mjs";
import { evidence } from "../../core/evidence.mjs";

export const backupOperation = {
  id: "generic.backup",
  title: "Back up a game file",
  summary: "Copy a game file into the workspace backups folder and record its SHA-256 before a game write.",
  engine: "core",
  inputs: {
    type: "object",
    properties: {
      gamePath: { type: "string" },
    },
    required: ["gamePath"],
  },
  outputs: {
    type: "object",
    properties: {
      source: { type: "string" },
      backupPath: { type: "string" },
      sha256: { type: "string" },
    },
  },
  effects: ["read", "workspaceWrite"],
  requires: [],
  gates: ["auto"],
  skill: "gmf-safety",
  docs: ["knowledge/core/safety.md"],
  handler: async (inputs, context = {}) => {
    if (!context.workspace) {
      const error = new Error("GMF-E-WORKSPACE-001: no workspace for the backup");
      error.code = "GMF-E-WORKSPACE-001";
      error.remediation = "Run gmf init first.";
      throw error;
    }
    const result = createBackup(context.workspace, inputs.gamePath);
    return {
      data: result,
      evidence: [
        evidence({
          claim: `The original ${path.basename(result.source)} was copied before a game write`,
          confidence: "observed",
          authority: "shipped-artifact",
          source: result.source,
          detail: { backupPath: result.backupPath, sha256: result.sha256 },
        }),
      ],
    };
  },
};

export default backupOperation;

if (!getHandler(backupOperation.id)) {
  registerOperation(backupOperation, backupOperation.handler);
}
