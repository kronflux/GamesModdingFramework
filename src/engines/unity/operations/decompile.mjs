import fs from "node:fs";
import path from "node:path";
import { registerOperation, getHandler } from "../../../core/operations.mjs";
import { evidence } from "../../../core/evidence.mjs";
import { runProcess } from "../../../core/processes.mjs";
import { resolveTool, toolCacheDir } from "../../../core/tools.mjs";
import { assertInside } from "../../../core/workspace.mjs";
import { assertGameDir, findDataDir } from "../detect.mjs";
import { backendFor, gameDirFor } from "./defaults.mjs";
import { normalizeUnityDump } from "./normalize.mjs";
import { writeNormalizedDump } from "../../../operations/analyze/normalize.mjs";

const DECOMPILERS = {
  mono: ["ilspycmd"],
  il2cpp: ["cpp2il", "il2cppdumper"],
};

function toolError(backend, ids) {
  const error = new Error(
    `GMF-E-TOOL-001: no ${backend} decompiler is installed (tried ${ids.join(", ")}).`,
  );
  error.code = "GMF-E-TOOL-001";
  error.remediation = `Install one with: gmf tool install ${ids[0]} (requires toolInstall authorization), or set GMF_TOOLS_DIR to an existing tool cache.`;
  return error;
}

function cacheFor(context) {
  return context.toolCacheDir || toolCacheDir(context.env || process.env);
}

function listFiles(dir, found = []) {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, found);
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

function managedAssemblies(gameDir) {
  const dataDir = findDataDir(gameDir);
  if (!dataDir) return [];
  const managedDir = path.join(dataDir, "Managed");
  if (!fs.existsSync(managedDir)) return [];
  return fs
    .readdirSync(managedDir)
    .filter((name) => name.toLowerCase().endsWith(".dll"))
    .sort()
    .map((name) => path.join(managedDir, name));
}

// Cpp2IL 2022.1 output formats: diffable-cs (C# text the normalizer reads)
// and dummydll / dll_* (assemblies to build against or open in ILSpy).
const CPP2IL_FORMATS = new Set(["diffable-cs", "dummydll", "dll_default", "dll_empty", "dll_throw_null", "dll_il_recovery", "isil"]);

// Cpp2IL makes its own DiffableCs/ folder for diffable-cs but writes the other
// formats straight into --output-to, so each of those gets a folder of its own.
const CPP2IL_FOLDERS = { dummydll: "DummyDll", dll_default: "Dll", dll_empty: "DllEmpty", dll_throw_null: "DllThrowNull", dll_il_recovery: "DllIlRecovery", isil: "Isil" };

// A folder gmf made for one assembly carries this file, so a later run can
// tell its own folders from files the user keeps beside them.
const OWNED_MARKER = ".gmf-decompiled";

// Il2CppDumper writes DummyDll/ and dump.cs straight into its output folder.
const DUMPER_FOLDER = "Il2CppDumper";

function assemblyFolder(outputDir, assembly) {
  return path.join(outputDir, path.basename(assembly, path.extname(assembly)));
}

// Removes the folders an earlier run left directly under outputDir.
function removeOwnedFolders(outputDir) {
  if (!fs.existsSync(outputDir)) return;
  for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
    const folder = path.join(outputDir, entry.name);
    if (entry.isDirectory() && fs.existsSync(path.join(folder, OWNED_MARKER))) {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }
}

function il2cppInputs(gameDir) {
  const dataDir = findDataDir(gameDir);
  const metadata = dataDir ? path.join(dataDir, "il2cpp_data", "Metadata", "global-metadata.dat") : null;
  const executable = path.join(gameDir, "GameAssembly.dll");
  if (!metadata || !fs.existsSync(metadata) || !fs.existsSync(executable)) {
    const error = new Error(`Il2CppDumper needs GameAssembly.dll and global-metadata.dat under ${gameDir}`);
    error.code = "GMF-E-EXEC-001";
    error.remediation = "Check that the game is an IL2CPP Windows build with an il2cpp_data/Metadata folder.";
    throw error;
  }
  return { executable, metadata };
}

function commandsFor(toolId, tool, { gameDir, outputDir, assemblies, format = "diffable-cs" }) {
  if (toolId === "ilspycmd") {
    return assemblies.map((assembly) => ({
      cmd: tool.cmd,
      args: [...tool.args, "-p", "-o", assemblyFolder(outputDir, assembly), assembly],
    }));
  }
  if (toolId === "cpp2il") {
    return [
      {
        cmd: tool.cmd,
        args: [...tool.args, "--game-path", gameDir, "--output-as", format, "--output-to", outputDir],
      },
    ];
  }
  // Il2CppDumper: <executable> <global-metadata.dat> <output-dir>.
  const { executable, metadata } = il2cppInputs(gameDir);
  return [{ cmd: tool.cmd, args: [...tool.args, executable, metadata, outputDir] }];
}

const operation = {
  id: "unity.decompile",
  title: "Decompile Unity assemblies",
  summary:
    "Decompile Mono managed assemblies with ilspycmd, or an IL2CPP game with Cpp2IL or Il2CppDumper, into the workspace decompiled folder.",
  engine: "unity",
  inputs: {
    type: "object",
    properties: {
      gameDir: { type: "string" },
      backend: { type: "string" },
      outputDir: { type: "string" },
      normalize: { type: "boolean", description: "Write dumps/unity-<backend>.json for the analyze operations. Default true." },
      format: {
        type: "string",
        description: "IL2CPP only: the Cpp2IL output format, diffable-cs (default, normalizable C#) or dummydll for assemblies.",
      },
    },
    required: [],
  },
  outputs: {
    type: "object",
    properties: {
      count: { type: "integer" },
      outputDir: { type: "string" },
      report: { type: "string" },
      dump: { type: "string" },
    },
  },
  effects: ["read", "workspaceWrite"],
  requires: ["ilspycmd", "cpp2il", "il2cppdumper"],
  gates: ["auto"],
  skill: "unity-harmony",
  docs: [],
  handler: async (inputs, context) => {
    const gameDirInput = gameDirFor(inputs, context);
    if (!gameDirInput) {
      const error = new Error("unity.decompile needs a game directory");
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Pass --input gameDir=<dir>, or run gmf investigate first so the workspace records it.";
      throw error;
    }
    const gameDir = assertGameDir(gameDirInput);
    const backend = backendFor(inputs, context);
    const candidates = DECOMPILERS[backend];
    if (!candidates) {
      const error = new Error(`Unsupported Unity backend: ${backend}`);
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Use backend mono or il2cpp.";
      throw error;
    }
    if (!context.workspace?.root) {
      const error = new Error("unity.decompile needs a workspace for decompiled output");
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Run gmf init and gmf investigate first so the workspace exists.";
      throw error;
    }

    const outputDir = assertInside(
      context.workspace,
      inputs.outputDir || path.join(context.workspace.root, "decompiled", "unity", backend),
    );

    const cacheDir = cacheFor(context);
    let toolId = null;
    let tool = null;
    for (const id of candidates) {
      const resolved = resolveTool(id, { cacheDir });
      if (resolved) {
        toolId = id;
        tool = resolved;
        break;
      }
    }
    if (!tool) throw toolError(backend, candidates);

    const assemblies = backend === "mono" ? managedAssemblies(gameDir) : [];
    if (backend === "mono" && assemblies.length === 0) {
      const error = new Error(`No managed assemblies were found under ${gameDir}`);
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Check that the game data folder contains a Managed folder with DLLs.";
      throw error;
    }

    const run = typeof context.runProcess === "function" ? context.runProcess : runProcess;
    const format = inputs.format || "diffable-cs";
    if (toolId === "cpp2il" && !CPP2IL_FORMATS.has(format)) {
      const error = new Error(`Unknown Cpp2IL output format: ${format}`);
      error.code = "GMF-E-PLAN-001";
      error.remediation = `Use one of ${[...CPP2IL_FORMATS].join(", ")}.`;
      throw error;
    }
    let formatDir = outputDir;
    if (toolId === "cpp2il" && CPP2IL_FOLDERS[format]) formatDir = path.join(outputDir, CPP2IL_FOLDERS[format]);
    if (toolId === "il2cppdumper") formatDir = path.join(outputDir, DUMPER_FOLDER);
    const commands = commandsFor(toolId, tool, { gameDir, outputDir: formatDir, assemblies, format });

    // Each run starts from empty folders of its own, so files from an older
    // game build never mix into this run's output or dump.
    fs.mkdirSync(outputDir, { recursive: true });
    if (toolId === "ilspycmd") {
      removeOwnedFolders(outputDir);
      for (const assembly of assemblies) {
        const folder = assemblyFolder(outputDir, assembly);
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, OWNED_MARKER), "");
      }
    } else {
      const owned = toolId === "cpp2il" && format === "diffable-cs" ? path.join(outputDir, "DiffableCs") : formatDir;
      if (owned !== outputDir) fs.rmSync(owned, { recursive: true, force: true });
      fs.mkdirSync(formatDir, { recursive: true });
    }
    for (const command of commands) {
      const result = await run(command.cmd, command.args, {
        cwd: gameDir,
        timeoutMs: context.timeoutMs ?? 900000,
      });
      if (result.code !== 0) {
        const tail = `${result.stderr || ""}\n${result.stdout || ""}`
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-5)
          .join(" ");
        const error = new Error(
          `Decompilation failed: ${command.cmd} ${command.args.join(" ")} (exit ${result.code})`,
        );
        error.code = "GMF-E-EXEC-001";
        error.remediation = `Inspect the tool log. Last output: ${tail || "none"}`;
        throw error;
      }
    }

    const roots = toolId === "ilspycmd" ? assemblies.map((assembly) => assemblyFolder(outputDir, assembly)) : [formatDir];
    const files = roots.flatMap((root) => listFiles(root)).filter((file) => path.basename(file) !== OWNED_MARKER);
    const report = `Decompiled ${files.length} files with ${toolId} into ${formatDir}`;
    let dump = null;
    // Only C# output can be normalized; assemblies would replace the dump with nothing.
    const isSource = toolId !== "cpp2il" || format === "diffable-cs";
    if (isSource && inputs.normalize !== false && inputs.normalize !== "false") {
      // Normalize the whole output tree in a single pass, so each class is counted once.
      const normalized = normalizeUnityDump({ decompiledDir: outputDir, backend });
      dump = writeNormalizedDump(context.workspace.root, `unity-${backend}.json`, normalized);
    }
    return {
      data: { count: files.length, outputDir: formatDir, report, dump },
      evidence: [
        evidence({
          claim: `Decompiled the ${backend} game with ${toolId}`,
          confidence: "observed",
          authority: "shipped-artifact",
          source: outputDir,
          detail: { count: files.length, tool: toolId },
        }),
      ],
    };
  },
};

if (!getHandler(operation.id)) registerOperation(operation, operation.handler);

export default operation;
