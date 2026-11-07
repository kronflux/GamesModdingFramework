import path from "node:path";
import { getHandler, registerOperation } from "../../core/operations.mjs";
import { resolveTool, toolCacheDir } from "../../core/tools.mjs";
import { runProcess } from "../../core/processes.mjs";
import { isInside } from "../../core/fsutil.mjs";

function resolveFrom(context, id) {
  const tools = context?.tools;
  if (tools) {
    if (typeof tools.resolveTool === "function") {
      const resolved = tools.resolveTool(id);
      if (resolved) return resolved;
    }
    if (tools[id]) return tools[id];
  }
  try {
    return resolveTool(id, { cacheDir: context?.toolCacheDir || toolCacheDir(context?.env || process.env) });
  } catch {
    return null;
  }
}

export const runToolOperation = {
  id: "generic.run_tool",
  title: "Run a registered tool",
  summary:
    "Run a registered tool with explicit arguments under the owned-process layer and return the exit code and the log tail. Use it to reproduce a failing command exactly.",
  engine: "core",
  inputs: {
    type: "object",
    properties: {
      tool: { type: "string" },
      args: { type: "array", items: { type: "string" } },
      cwd: { type: "string" },
      timeoutMs: { type: "integer" },
      tailLines: { type: "integer" },
    },
    required: ["tool"],
  },
  outputs: {
    type: "object",
    properties: {
      command: { type: "string" },
      exitCode: { type: "integer" },
      stdoutTail: { type: "string" },
      stderrTail: { type: "string" },
    },
  },
  effects: ["read", "workspaceWrite", "execute"],
  requires: [],
  gates: ["soft"],
  skill: "gmf-debug",
  docs: ["knowledge/core/toolchain.md"],
  handler: async (inputs, context = {}) => {
    const tool = resolveFrom(context, String(inputs.tool || ""));
    if (!tool) {
      const error = new Error(`GMF-E-TOOL-001: required tool ${inputs.tool} is not installed.`);
      error.code = "GMF-E-TOOL-001";
      error.remediation = `Run gmf tool install ${inputs.tool} with an authorization for toolInstall.`;
      throw error;
    }
    const args = Array.isArray(inputs.args) ? inputs.args.map(String) : [];
    const tailLines = Number(inputs.tailLines) || 40;
    // A trailing newline is not a line of its own, so it is dropped before counting.
    const tail = (text) => String(text).replace(/\r?\n$/, "").split(/\r?\n/).slice(-tailLines).join("\n");
    // The tool runs in the workspace, or in a folder under it.
    const workspaceRoot = context?.workspace?.root || null;
    let cwd = workspaceRoot || process.cwd();
    if (inputs.cwd) {
      const requested = workspaceRoot ? path.resolve(workspaceRoot, String(inputs.cwd)) : null;
      if (!requested || !isInside(workspaceRoot, requested)) {
        const error = new Error(`GMF-E-PLAN-001: cwd must be inside the workspace: ${inputs.cwd}`);
        error.code = "GMF-E-PLAN-001";
        error.remediation = "Pass a folder under the workspace root, or omit cwd to run in the workspace root.";
        throw error;
      }
      cwd = requested;
    }
    const runner = context?.processes?.runProcess || context?.runProcess || runProcess;
    const cmd = tool.cmd || tool.path;
    const argv = [...(tool.args || []), ...args];
    const result = await runner(cmd, argv, {
      cwd,
      timeoutMs: Number(inputs.timeoutMs) || 600000,
    });
    return {
      data: {
        command: [cmd, ...argv].join(" "),
        exitCode: result.code,
        stdoutTail: tail(result.stdout || ""),
        stderrTail: tail(result.stderr || ""),
      },
    };
  },
};

export default runToolOperation;

if (!getHandler(runToolOperation.id)) registerOperation(runToolOperation, runToolOperation.handler);
