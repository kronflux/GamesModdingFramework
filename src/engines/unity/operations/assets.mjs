import fs from "node:fs";
import path from "node:path";
import { registerOperation, getHandler } from "../../../core/operations.mjs";
import { authorizeEffects } from "../../../core/authorization.mjs";
import { evidence } from "../../../core/evidence.mjs";
import { runProcess } from "../../../core/processes.mjs";
import { resolveTool, toolCacheDir } from "../../../core/tools.mjs";
import { assertInside, backupFile } from "../../../core/workspace.mjs";
import { isInside } from "../../../core/fsutil.mjs";
import { assertGameDir, findDataDir } from "../detect.mjs";
import { gameDirFor } from "./defaults.mjs";
import { fileURLToPath } from "node:url";

// UnityPy is a library with no inspect or replace command, so gmf ships a
// helper script and runs it with the Python that has UnityPy installed.
export const UNITYPY_HELPER = fileURLToPath(new URL("../helpers/gmf_unitypy.py", import.meta.url));

function cacheFor(context) {
  return context.toolCacheDir || toolCacheDir(context.env || process.env);
}

function runnerFor(context) {
  return typeof context.runProcess === "function" ? context.runProcess : runProcess;
}

function toolError(id, purpose) {
  const error = new Error(`GMF-E-TOOL-001: the ${id} tool is not installed; ${purpose} needs it.`);
  error.code = "GMF-E-TOOL-001";
  error.remediation = `Install it with: gmf tool install ${id} (requires toolInstall authorization). GPL tools are downloaded at runtime, never vendored.`;
  return error;
}

function requireWorkspace(context, operation) {
  if (!context.workspace?.root) {
    const error = new Error(`${operation} needs a workspace so outputs stay under the workspace folder.`);
    error.code = "GMF-E-EXEC-001";
    error.remediation = "Run gmf init and gmf investigate first.";
    throw error;
  }
  return context.workspace;
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

function fileStamp(file) {
  const stat = fs.statSync(file);
  return `${stat.size}:${stat.mtimeMs}`;
}

// Size and modification time of every file already in a folder, so a later
// listing can tell this run's files from earlier ones.
function snapshotFiles(dir) {
  return new Map(listFiles(dir).map((file) => [file, fileStamp(file)]));
}

function resolveAssetPath(gameDir, assetPath) {
  if (typeof assetPath !== "string" || assetPath.trim() === "") {
    const dataDir = findDataDir(gameDir);
    const candidates = dataDir
      ? fs.readdirSync(dataDir).filter((name) => name.toLowerCase().endsWith(".assets"))
      : [];
    if (candidates.length === 0) {
      const error = new Error(`No Unity asset file was found under ${gameDir}`);
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Pass assetPath to a .assets or bundle file inside the game folder.";
      throw error;
    }
    const first = candidates.sort()[0];
    return { relative: path.join(path.basename(dataDir), first), absolute: path.join(dataDir, first) };
  }
  const absolute = path.resolve(gameDir, assetPath);
  if (!isInside(gameDir, absolute)) {
    const error = new Error(`Asset path is outside the game directory: ${assetPath}`);
    error.code = "GMF-E-EXEC-001";
    error.remediation = "Pass a path inside the game install.";
    throw error;
  }
  const relative = path.relative(path.resolve(gameDir), absolute).split(path.sep).join("/");
  return { relative, absolute };
}

async function runTool(context, tool, args, cwd) {
  const result = await runnerFor(context)(tool.cmd, [...(tool.args || []), ...args], {
    cwd,
    timeoutMs: context.timeoutMs ?? 900000,
  });
  if (result.code !== 0) {
    const tail = `${result.stderr || ""}\n${result.stdout || ""}`
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-5)
      .join(" ");
    const error = new Error(
      `Asset tool failed: ${tool.cmd} ${args.join(" ")} (exit ${result.code})`,
    );
    error.code = "GMF-E-EXEC-001";
    error.remediation = `Inspect the tool log. Last output: ${tail || "none"}`;
    throw error;
  }
  return result;
}

// AssetStudioModCLI export: <input> -m export -t <types> -o <dir>. The input is
// one .assets or bundle file, or a folder (the game's data folder by default).
// IL2CPP MonoBehaviours need Cpp2IL dummy assemblies (--assembly-folder).
const EXPORT_MODES = new Set(["export", "exportRaw", "dump", "jsonDump", "info"]);

function dataFolderFor(gameDir) {
  const dataDir = findDataDir(gameDir);
  return dataDir || gameDir;
}

const extractOperation = {
  id: "unity.extract_assets",
  title: "Extract Unity assets",
  summary:
    "Export Unity assets (textures, sprites, audio, text, MonoBehaviours, meshes, fonts, shaders) with AssetStudioModCLI into the workspace extracted folder. Reads the game only.",
  engine: "unity",
  inputs: {
    type: "object",
    properties: {
      gameDir: { type: "string" },
      assetPath: { type: "string", description: "A .assets or bundle file or a folder, relative to the game folder. Default: the data folder." },
      types: { type: "string", description: "AssetStudio asset types, comma-separated: tex2d, sprite, textAsset, monoBehaviour, font, shader, audio, video, mesh, or all (default)." },
      filter: { type: "string", description: "Only assets whose name matches (AssetStudio --filter-by-name; comma-separated)." },
      mode: { type: "string", description: "export (default), exportRaw, dump, jsonDump or info." },
      outputDir: { type: "string" },
    },
    required: [],
  },
  outputs: {
    type: "object",
    properties: {
      files: { type: "array" },
      outputDir: { type: "string" },
    },
  },
  effects: ["read", "workspaceWrite"],
  requires: ["assetstudio"],
  gates: ["auto"],
  skill: "unity-assets",
  docs: ["knowledge/unity/asset-tools.md"],
  handler: async (inputs, context) => {
    const gameDirInput = gameDirFor(inputs, context);
    if (!gameDirInput) {
      const error = new Error("unity.extract_assets needs a game directory");
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Pass --input gameDir=<dir>, or run gmf investigate first.";
      throw error;
    }
    const gameDir = assertGameDir(gameDirInput);
    const workspace = requireWorkspace(context, "unity.extract_assets");
    const tool = resolveTool("assetstudio", { cacheDir: cacheFor(context) });
    if (!tool) throw toolError("assetstudio", "asset extraction");

    const mode = inputs.mode || "export";
    if (!EXPORT_MODES.has(mode)) {
      const error = new Error(`Unknown AssetStudio mode: ${mode}`);
      error.code = "GMF-E-PLAN-001";
      error.remediation = `Use one of ${[...EXPORT_MODES].join(", ")}.`;
      throw error;
    }
    const input = inputs.assetPath ? resolveAssetPath(gameDir, inputs.assetPath).absolute : dataFolderFor(gameDir);
    if (!fs.existsSync(input)) {
      const error = new Error(`Asset path does not exist: ${input}`);
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Pass assetPath to a .assets file, a bundle or a folder inside the game.";
      throw error;
    }
    const outputDir = assertInside(workspace, inputs.outputDir || path.join(workspace.root, "extracted", "unity", "assets"));
    fs.mkdirSync(outputDir, { recursive: true });

    const args = [input, "-m", mode, "-t", inputs.types || "all", "-o", outputDir, "-r"];
    if (inputs.filter) args.push("--filter-by-name", String(inputs.filter));
    const profile = workspace.profile || null;
    const unityVersion = profile?.engine?.id === "unity" ? profile.engine.version : null;
    if (unityVersion) args.push("--unity-version", unityVersion);
    const notes = [];
    let assemblyFolder = null;
    if (profile?.runtime?.backend === "il2cpp") {
      const dummy = path.join(workspace.root, "decompiled", "unity", "il2cpp", "DummyDll");
      if (fs.existsSync(dummy) && fs.readdirSync(dummy).some((name) => name.toLowerCase().endsWith(".dll"))) {
        assemblyFolder = dummy;
        args.push("--assembly-folder", dummy);
      } else {
        notes.push(
          "IL2CPP game without dummy assemblies: MonoBehaviour fields will be missing. Run unity.decompile --input backend=il2cpp --input format=dummydll, then extract again.",
        );
      }
    }
    // A MonoBehaviour's script usually lives in another file; loaded alone, the
    // file gives AssetStudio no class for it and only base fields come out
    // (seen on a Unity 6 game: ContentSizeFitter lost m_HorizontalFit).
    const types = String(inputs.types || "all").toLowerCase();
    if (fs.statSync(input).isFile() && (types.includes("all") || types.includes("monobehaviour"))) {
      notes.push(
        "Single-file input: MonoBehaviours whose script is in another file lose their own fields. For full fields, export the data folder (omit assetPath) with types=monoBehaviour and a filter.",
      );
    }
    const before = snapshotFiles(outputDir);
    const result = await runTool(context, tool, args, gameDir);

    // AssetStudio colours its output and rewrites one progress line with \r.
    const lines = String(result?.stdout || "")
      .replace(/\u001b\[[0-9;]*m/g, "")
      .split(/[\r\n]+/)
      .map((line) => line.trim())
      .filter((line) => line && !/^Exported \[\d+\/\d+\]$/.test(line));
    const errors = lines.filter((line) => line.startsWith("[Error]")).map((line) => line.replace(/^\[Error\]\s*/, ""));

    const files = listFiles(outputDir).filter((file) => before.get(file) !== fileStamp(file));
    return {
      data: {
        files,
        outputDir,
        count: files.length,
        input,
        assemblyFolder,
        notes,
        errors,
        log: lines.filter((line) => !line.startsWith("[Error]")).slice(-5),
        tool: { id: "assetstudio", path: tool.path, version: tool.version },
      },
      evidence: [
        evidence({
          claim: `Exported ${files.length} files with AssetStudioModCLI into the workspace`,
          confidence: "observed",
          authority: "shipped-artifact",
          source: outputDir,
          detail: { count: files.length, tool: "assetstudio", input, mode },
        }),
      ],
    };
  },
};

const inspectOperation = {
  id: "unity.inspect_asset",
  title: "Inspect a Unity asset",
  summary: "Read object metadata from a Unity asset file with UnityPy and write the metadata into the workspace.",
  engine: "unity",
  inputs: {
    type: "object",
    properties: {
      gameDir: { type: "string" },
      assetPath: { type: "string" },
      outputDir: { type: "string" },
    },
    required: [],
  },
  outputs: {
    type: "object",
    properties: {
      metadata: { type: "object" },
      metadataPath: { type: "string" },
    },
  },
  effects: ["read", "workspaceWrite"],
  requires: ["unitypy"],
  gates: ["auto"],
  skill: "unity-assets",
  docs: [],
  handler: async (inputs, context) => {
    const gameDirInput = gameDirFor(inputs, context);
    if (!gameDirInput) {
      const error = new Error("unity.inspect_asset needs a game directory");
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Pass --input gameDir=<dir>, or run gmf investigate first.";
      throw error;
    }
    const gameDir = assertGameDir(gameDirInput);
    const workspace = requireWorkspace(context, "unity.inspect_asset");
    const tool = resolveTool("unitypy", { cacheDir: cacheFor(context) });
    if (!tool) throw toolError("unitypy", "asset inspection");

    const asset = resolveAssetPath(gameDir, inputs.assetPath);
    if (!fs.existsSync(asset.absolute)) {
      const error = new Error(`Asset file does not exist: ${asset.absolute}`);
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Pass an existing .assets or bundle path inside the game folder.";
      throw error;
    }

    const outputDir = assertInside(
      workspace,
      inputs.outputDir || path.join(workspace.root, "extracted", "unity", "inspect"),
    );
    fs.mkdirSync(outputDir, { recursive: true });
    const metadataPath = path.join(outputDir, `${path.basename(asset.absolute)}.metadata.json`);
    fs.rmSync(metadataPath, { force: true });
    await runTool(context, tool, [UNITYPY_HELPER, "inspect", asset.absolute, "--output", metadataPath], gameDir);

    if (!fs.existsSync(metadataPath)) {
      const error = new Error(`unitypy did not write metadata to ${metadataPath}`);
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Check the unitypy version and its output flags.";
      throw error;
    }
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));

    return {
      data: { metadata, metadataPath, asset: asset.absolute, tool: { id: "unitypy", path: tool.path } },
      evidence: [
        evidence({
          claim: `Read asset metadata with unitypy from ${asset.relative}`,
          confidence: "observed",
          authority: "shipped-artifact",
          source: metadataPath,
          detail: { asset: asset.relative },
        }),
      ],
    };
  },
};

const replaceOperation = {
  id: "unity.replace_asset",
  title: "Replace a Unity asset",
  summary:
    "Replace one object in a Unity asset file: UnityPy writes the changed file into the workspace, then gmf backs up the game file and copies the new one in. Textures take an image, TextAssets any file, other types a JSON object of type-tree fields.",
  engine: "unity",
  inputs: {
    type: "object",
    properties: {
      gameDir: { type: "string" },
      assetPath: { type: "string", description: "The .assets or bundle file, relative to the game folder." },
      object: { type: "string", description: "The object's path id or name, from unity.inspect_asset." },
      replacementPath: { type: "string", description: "The new content: an image, a file, or a .json object of type-tree fields." },
      outputDir: { type: "string" },
    },
    required: ["assetPath", "object", "replacementPath"],
  },
  outputs: {
    type: "object",
    properties: {
      files: { type: "array" },
      backup: { type: "object" },
    },
  },
  effects: ["gameWrite", "workspaceWrite"],
  requires: ["unitypy"],
  gates: ["soft"],
  skill: "unity-assets",
  docs: [],
  handler: async (inputs, context) => {
    const gameDirInput = gameDirFor(inputs, context);
    if (!gameDirInput) {
      const error = new Error("unity.replace_asset needs a game directory");
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Pass --input gameDir=<dir>, or run gmf investigate first.";
      throw error;
    }
    const gameDir = assertGameDir(gameDirInput);
    if (!context.workspace?.root) {
      const error = new Error(
        "GMF-E-GATE-001: unity.replace_asset needs a workspace so the original asset can be backed up before the write.",
      );
      error.code = "GMF-E-GATE-001";
      error.remediation = "Run gmf init and gmf investigate first, or pass --workspace.";
      throw error;
    }
    const workspace = context.workspace;
    const authorization = authorizeEffects(["gameWrite"], context);
    if (!authorization.allowed) {
      const error = new Error(
        `GMF-E-GATE-001: unity.replace_asset writes into the game folder and needs a gameWrite authorization (${authorization.reason}).`,
      );
      error.code = "GMF-E-GATE-001";
      error.remediation = "Pass --authorized gameWrite --source \"<quoted user instruction or plan step>\".";
      throw error;
    }

    const tool = resolveTool("unitypy", { cacheDir: cacheFor(context) });
    if (!tool) throw toolError("unitypy", "asset replacement");

    const asset = resolveAssetPath(gameDir, inputs.assetPath);
    if (!fs.existsSync(asset.absolute)) {
      const error = new Error(`Asset file does not exist: ${asset.absolute}`);
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Pass an existing .assets or bundle path inside the game folder.";
      throw error;
    }

    const replacement = path.resolve(String(inputs.replacementPath));
    if (!fs.existsSync(replacement) || !fs.statSync(replacement).isFile()) {
      const error = new Error(`Replacement file does not exist: ${replacement}`);
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Pass replacementPath to an existing image, file or .json object.";
      throw error;
    }

    const outputDir = assertInside(
      workspace,
      inputs.outputDir || path.join(workspace.root, "extracted", "unity", "replaced"),
    );
    const staged = path.join(outputDir, ...asset.relative.split(/[\\/]/));
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.rmSync(staged, { force: true });
    await runTool(
      context,
      tool,
      [UNITYPY_HELPER, "replace", asset.absolute, "--object", String(inputs.object), "--from", replacement, "--output", staged],
      gameDir,
    );
    if (!fs.existsSync(staged)) {
      const error = new Error(`The UnityPy helper did not write ${staged}`);
      error.code = "GMF-E-EXEC-001";
      error.remediation = "Read the helper output; the game file was not changed.";
      throw error;
    }

    const backup = backupFile(workspace, asset.absolute);
    const pending = `${asset.absolute}.gmf-tmp`;
    try {
      fs.copyFileSync(staged, pending);
      fs.renameSync(pending, asset.absolute);
    } catch (cause) {
      try {
        fs.rmSync(pending, { force: true });
      } catch {
        // The temporary name is not a file this operation made; leave it.
      }
      let restored = true;
      try {
        fs.copyFileSync(backup.backupPath, asset.absolute);
      } catch {
        restored = false;
      }
      const error = new Error(`GMF-E-EXEC-001: could not write ${asset.absolute}: ${cause.message}`);
      error.code = "GMF-E-EXEC-001";
      error.remediation = restored
        ? "Close the game and check that the folder is writable. The original file is unchanged."
        : `The original could not be put back; restore it with generic.restore from ${backup.backupPath}.`;
      error.backups = [backup.backupPath];
      throw error;
    }

    return {
      data: {
        files: [asset.absolute],
        staged,
        backup,
        tool: { id: "unitypy", path: tool.path },
      },
      evidence: [
        evidence({
          claim: `Replaced ${asset.relative} with unitypy after backing it up`,
          confidence: "observed",
          authority: "controlled-replay",
          source: asset.absolute,
          detail: { backup: backup.backupPath },
        }),
      ],
      authorization: { effect: "gameWrite", source: authorization.source, gate: authorization.gate },
    };
  },
};

for (const operation of [extractOperation, inspectOperation, replaceOperation]) {
  if (!getHandler(operation.id)) registerOperation(operation, operation.handler);
}

export { extractOperation, inspectOperation, replaceOperation };
export default [extractOperation, inspectOperation, replaceOperation];
