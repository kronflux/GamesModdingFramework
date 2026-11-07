// unreal.pe_analyze, unreal.aob_emit, unreal.aob_verify: read-only signature tooling over a PE32+ executable.

import fs from "node:fs";
import path from "node:path";
import { registerOperation, getHandler } from "../../../core/operations.mjs";
import { evidence } from "../../../core/evidence.mjs";
import { gmfError, isFile, resolveGameDirInput } from "./shared.mjs";
import { parsePe } from "../sig/pe.mjs";
import { emitSignature, findPattern } from "../sig/emit.mjs";

// The exe is an absolute path, a path relative to the working directory, or a path inside the game folder.
function resolveExe(inputs, context) {
  const value = inputs.exe;
  if (typeof value !== "string" || !value.trim()) {
    throw gmfError("GMF-E-PLAN-001", "exe is required.", "Pass the game executable, for example --input exe=<path>.");
  }
  const candidates = [path.resolve(context?.cwd || process.cwd(), value)];
  try {
    candidates.push(path.resolve(resolveGameDirInput(inputs, context), value));
  } catch {
    // No game directory known; the direct path is the only candidate.
  }
  const found = candidates.find((candidate) => isFile(candidate));
  if (!found) {
    throw gmfError("GMF-E-GAME-001", `Executable not found: ${candidates[0]}`, "Pass an existing executable path, or a path relative to the game folder.");
  }
  return found;
}

function readImage(inputs, context) {
  const file = resolveExe(inputs, context);
  return { file, buffer: fs.readFileSync(file) };
}

function describeError(error) {
  return gmfError("GMF-E-PLAN-001", error.message, "Pass a 64-bit PE executable and a valid byte pattern such as '48 8B ?? 05'.");
}

const readEffects = {
  effects: ["read"],
  requires: [],
  gates: ["auto"],
  skill: "unreal-aob",
  docs: [],
};

export const peAnalyzeOperation = {
  id: "unreal.pe_analyze",
  title: "Analyze a PE executable",
  summary: "Read the sections, imports, exports, timestamp and executable range of a 64-bit PE file without running it.",
  engine: "unreal",
  inputs: {
    type: "object",
    properties: { exe: { type: "string", description: "Path to the executable." } },
    required: ["exe"],
  },
  outputs: {
    type: "object",
    properties: {
      sections: { type: "array" },
      imports: { type: "array" },
      exports: { type: "array" },
      timestamp: { type: "integer" },
      textRange: { type: "object" },
    },
  },
  ...readEffects,

  async handler(inputs, context = {}) {
    const { file, buffer } = readImage(inputs, context);
    let pe;
    try {
      pe = parsePe(buffer);
    } catch (error) {
      throw describeError(error);
    }
    return {
      data: { file, ...pe },
      evidence: [
        evidence({
          claim: `Parsed ${pe.sections.length} sections, ${pe.imports.length} imported modules and ${pe.exports.length} exports.`,
          confidence: "observed",
          authority: "shipped-artifact",
          source: file,
        }),
      ],
    };
  },
};

export const aobEmitOperation = {
  id: "unreal.aob_emit",
  title: "Emit a wildcarded signature",
  summary:
    "Build a byte pattern from the instructions at a file offset, wildcard RIP-relative displacements, count its matches in the executable and resolve the first RIP-relative target. A pattern that does not match exactly once is an error with the count.",
  engine: "unreal",
  inputs: {
    type: "object",
    properties: {
      exe: { type: "string", description: "Path to the executable." },
      offset: { type: "integer", description: "File offset of the function start." },
      maxBytes: { type: "integer", description: "Pattern length limit in bytes. Default 32." },
    },
    required: ["exe", "offset"],
  },
  outputs: {
    type: "object",
    properties: { pattern: { type: "string" }, mask: { type: "string" }, matches: { type: "array" }, target: { type: "integer" } },
  },
  ...readEffects,

  async handler(inputs, context = {}) {
    const { file, buffer } = readImage(inputs, context);
    const maxBytes = inputs.maxBytes === undefined ? 32 : inputs.maxBytes;
    if (inputs.offset < 0 || inputs.offset >= buffer.length || maxBytes < 1) {
      throw gmfError("GMF-E-PLAN-001", `offset or maxBytes is out of range for ${buffer.length} bytes.`, "Pass a file offset inside the executable and maxBytes of at least 1.");
    }
    let result;
    try {
      result = emitSignature(buffer, inputs.offset, { maxBytes });
    } catch (error) {
      throw describeError(error);
    }
    if (result.matches.length !== 1) {
      throw gmfError(
        "GMF-E-SIG-001",
        `Pattern "${result.pattern}" matched ${result.matches.length} times; a signature must match exactly once.`,
        result.matches.length === 0
          ? "Check that the offset is a file offset inside a section, then retry."
          : "Raise maxBytes or choose an offset whose first instructions are more distinctive.",
      );
    }
    return {
      data: { file, offset: inputs.offset, ...result },
      evidence: [
        evidence({
          claim: `Pattern "${result.pattern}" matches once, at file offset 0x${result.matches[0].toString(16)}.`,
          confidence: "observed",
          authority: "shipped-artifact",
          source: file,
        }),
      ],
    };
  },
};

export const aobVerifyOperation = {
  id: "unreal.aob_verify",
  title: "Verify a signature",
  summary: "Count the matches of a byte pattern (with ?? and ? wildcards) in the executable and list their file offsets.",
  engine: "unreal",
  inputs: {
    type: "object",
    properties: {
      exe: { type: "string", description: "Path to the executable." },
      pattern: { type: "string", description: "Byte pattern, for example '48 8B ?? 05'." },
    },
    required: ["exe", "pattern"],
  },
  outputs: { type: "object", properties: { count: { type: "integer" }, offsets: { type: "array" } } },
  ...readEffects,

  async handler(inputs, context = {}) {
    const { file, buffer } = readImage(inputs, context);
    let offsets;
    try {
      offsets = findPattern(buffer, inputs.pattern);
    } catch (error) {
      throw describeError(error);
    }
    return {
      data: { file, pattern: inputs.pattern, count: offsets.length, offsets },
      evidence: [
        evidence({
          claim: `Pattern "${inputs.pattern}" matches ${offsets.length} time(s).`,
          confidence: "observed",
          authority: "shipped-artifact",
          source: file,
        }),
      ],
    };
  },
};

export const sigOperations = [peAnalyzeOperation, aobEmitOperation, aobVerifyOperation];

for (const operation of sigOperations) {
  if (!getHandler(operation.id)) registerOperation(operation, operation.handler);
}
