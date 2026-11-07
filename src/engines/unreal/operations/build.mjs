// unreal.build: build a C++ mod with xmake; Lua and pak mods need no compile step.

import { gmfError, inferModType, requireTool, resolveModDirInput, runResolvedTool } from "./shared.mjs";

export const buildOperation = {
  id: "unreal.build",
  title: "Build an Unreal mod",
  summary:
    "Build a UE4SS C++ mod with xmake and return the exact command, exit code and log tail. Lua and pak mods return a no-op build result.",
  engine: "unreal",
  inputs: {
    type: "object",
    properties: {
      modDir: { type: "string" },
      type: { type: "string" },
    },
    required: [],
  },
  outputs: {
    type: "object",
    properties: {
      code: { type: ["integer", "null"] },
      stdout: { type: "string" },
      stderr: { type: "string" },
      command: { type: ["string", "null"] },
    },
  },
  effects: ["read", "workspaceWrite"],
  requires: [],
  gates: ["auto"],
  skill: "unreal-ue4ss-cpp",
  docs: [],

  async handler(inputs, context = {}) {
    const modDir = resolveModDirInput(inputs, context);
    const type = String(inputs.type || inferModType(modDir)).toLowerCase();

    if (type === "lua" || type === "pak") {
      return {
        data: {
          code: 0,
          stdout: "",
          stderr: "",
          command: null,
          type,
          note:
            type === "lua"
              ? "Lua mods need no compile step; deploy copies Scripts/ into the UE4SS Mods folder."
              : "Pak mods are cooked and packaged outside this build step; run unreal.package after cooking.",
        },
      };
    }

    if (type !== "cpp") {
      throw gmfError("GMF-E-PLAN-001", `Unknown Unreal mod type for build: ${type}`, "Use lua, cpp or pak.");
    }

    const tool = requireTool(context, "xmake");
    const command = [tool.cmd || tool.path, ...(tool.args || []), "build"].join(" ");
    let result;
    try {
      result = await runResolvedTool(context, tool, ["build"], { cwd: modDir, timeoutMs: 600000 });
    } catch (error) {
      throw gmfError(
        "GMF-E-EXEC-001",
        `xmake failed to start: ${error.message}`,
        `Run the build yourself: ${command}`,
      );
    }

    return {
      data: {
        code: result.code,
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        command,
        type,
        // stdout first, stderr last: the compiler's errors come at the end of the tail.
        logTail: [result.stdout, result.stderr]
          .map((part) => String(part || "").replace(/\s+$/, ""))
          .filter(Boolean)
          .join("\n")
          .split(/\r?\n/)
          .slice(-40)
          .join("\n"),
      },
    };
  },
};

export default buildOperation;
