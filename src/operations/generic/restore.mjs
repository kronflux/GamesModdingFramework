import path from "node:path";
import { getHandler, registerOperation } from "../../core/operations.mjs";
import { restoreBackup } from "../../core/safety.mjs";
import { evidence } from "../../core/evidence.mjs";

export const restoreOperation = {
  id: "generic.restore",
  title: "Restore a backed-up game file",
  summary:
    "Restore a game file from a recorded backup after verifying the backup hash. Writing into the game folder is a soft-gated gameWrite.",
  engine: "core",
  inputs: {
    type: "object",
    properties: {
      gamePath: { type: "string" },
      backupPath: { type: "string" },
    },
    required: ["gamePath"],
  },
  outputs: {
    type: "object",
    properties: {
      path: { type: "string" },
      backupPath: { type: "string" },
      sha256: { type: "string" },
      restored: { type: "boolean" },
    },
  },
  effects: ["read", "gameWrite", "workspaceWrite"],
  requires: [],
  gates: ["soft"],
  skill: "gmf-safety",
  docs: ["knowledge/core/safety.md"],
  handler: async (inputs, context = {}) => {
    if (!context.workspace) {
      const error = new Error("GMF-E-WORKSPACE-001: no workspace for the restore");
      error.code = "GMF-E-WORKSPACE-001";
      error.remediation = "Run gmf init first.";
      throw error;
    }
    const result = restoreBackup(context.workspace, inputs.gamePath, { backupPath: inputs.backupPath || null });
    return {
      data: result,
      evidence: [
        evidence({
          claim: `The original ${path.basename(result.path)} was restored from a recorded backup`,
          confidence: "observed",
          authority: "shipped-artifact",
          source: result.backupPath,
          detail: { path: result.path, sha256: result.sha256 },
        }),
      ],
    };
  },
};

export default restoreOperation;

if (!getHandler(restoreOperation.id)) {
  registerOperation(restoreOperation, restoreOperation.handler);
}
