import fs from "node:fs";
import path from "node:path";
import { registerOperation, getHandler } from "../../../core/operations.mjs";
import { evidence } from "../../../core/evidence.mjs";
import { runProcess } from "../../../core/processes.mjs";
import { modDirFor } from "./defaults.mjs";

function projectFiles(modDir) {
  return fs.readdirSync(modDir).filter((name) => name.toLowerCase().endsWith(".csproj"));
}

const operation = {
  id: "unity.build",
  title: "Build a Unity mod",
  summary: "Run dotnet build on a scaffolded Unity mod project and return the exact command, exit code and output.",
  engine: "unity",
  inputs: {
    type: "object",
    properties: {
      modDir: { type: "string" },
    },
    required: [],
  },
  outputs: {
    type: "object",
    properties: {
      code: { type: "integer" },
      stdout: { type: "string" },
      stderr: { type: "string" },
    },
  },
  effects: ["read", "workspaceWrite"],
  requires: ["dotnet"],
  gates: ["auto"],
  skill: "unity-testing",
  docs: [],
  handler: async (inputs, context) => {
    const modDir = modDirFor(inputs, context);
    if (!modDir) {
      const error = new Error("unity.build needs a mod project folder");
      error.code = "GMF-E-EXEC-001";
      error.remediation =
        "Pass --input modDir=<dir>, or scaffold exactly one mod so the workspace mods folder has one project.";
      throw error;
    }
    if (!fs.existsSync(modDir) || !fs.statSync(modDir).isDirectory()) {
      const error = new Error(`Mod project folder does not exist: ${modDir}`);
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Run unity.scaffold first or pass the folder that contains the .csproj.";
      throw error;
    }
    if (projectFiles(modDir).length === 0) {
      const error = new Error(`No .csproj project file was found in ${modDir}`);
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Run unity.scaffold to create a project, or pass the mod project folder.";
      throw error;
    }

    const command = context.dotnetCommand || "dotnet";
    const args = ["build", modDir, "-c", "Release", "--nologo"];
    const commandText = `${command} ${args.join(" ")}`;
    const run = typeof context.runProcess === "function" ? context.runProcess : runProcess;

    let result;
    try {
      result = await run(command, args, { cwd: modDir, timeoutMs: context.timeoutMs ?? 900000 });
    } catch (error) {
      if (error.code === "ENOENT") {
        return {
          data: {
            code: null,
            stdout: "",
            stderr: "dotnet was not found on PATH; the build was not run. Install the .NET SDK to build mods.",
            command: commandText,
            dryRun: true,
          },
          evidence: [],
        };
      }
      throw error;
    }

    if (result.code !== 0) {
      const tail = `${result.stderr || ""}\n${result.stdout || ""}`
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-10)
        .join(" ");
      const error = new Error(`Build failed: ${commandText} (exit ${result.code})`);
      error.code = "GMF-E-EXEC-001";
      error.remediation = `Inspect the build log. Last output: ${tail || "none"}`;
      throw error;
    }

    return {
      data: {
        code: result.code,
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        command: commandText,
        dryRun: false,
      },
      evidence: [
        evidence({
          claim: `dotnet build succeeded for ${path.basename(modDir)}`,
          confidence: "observed",
          authority: "controlled-replay",
          source: modDir,
          detail: { command: commandText, code: result.code },
        }),
      ],
    };
  },
};

if (!getHandler(operation.id)) registerOperation(operation, operation.handler);

export default operation;
