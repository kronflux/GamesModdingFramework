import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getHandler, registerOperation } from "../../core/operations.mjs";
import { evidence } from "../../core/evidence.mjs";

export const hashOperation = {
  id: "generic.hash",
  title: "Hash a file",
  summary: "Return the SHA-256 and size of a file so a deployed or packaged artifact can be compared with its build output.",
  engine: "core",
  inputs: {
    type: "object",
    properties: {
      file: { type: "string" },
    },
    required: ["file"],
  },
  outputs: {
    type: "object",
    properties: {
      file: { type: "string" },
      sha256: { type: "string" },
      size: { type: "integer" },
    },
  },
  effects: ["read"],
  requires: [],
  gates: ["auto"],
  skill: "gmf-verify",
  docs: ["knowledge/core/evidence.md"],
  handler: async (inputs) => {
    const file = path.resolve(String(inputs.file || ""));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      const error = new Error(`GMF-E-FILE-001: ${file} is not a file`);
      error.code = "GMF-E-FILE-001";
      error.remediation = "Pass the path of an existing file.";
      throw error;
    }
    const data = fs.readFileSync(file);
    const sha256 = crypto.createHash("sha256").update(data).digest("hex");
    return {
      data: { file, sha256, size: data.length },
      evidence: [
        evidence({
          claim: `${path.basename(file)} hashes to ${sha256.slice(0, 12)}`,
          confidence: "observed",
          authority: "shipped-artifact",
          source: file,
          detail: { sha256, size: data.length },
        }),
      ],
    };
  },
};

export default hashOperation;

if (!getHandler(hashOperation.id)) registerOperation(hashOperation, hashOperation.handler);
