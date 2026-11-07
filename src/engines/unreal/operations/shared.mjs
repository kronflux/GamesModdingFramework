// Shared helpers for Unreal operations: game paths, tool resolution, backups and file copies.

import fs from "node:fs";
import path from "node:path";
import { isInside } from "../../../core/fsutil.mjs";
import { copyFilesWithBackup } from "../../../core/gamewrite.mjs";
import { resolveTool, toolCacheDir } from "../../../core/tools.mjs";
import { runProcess } from "../../../core/processes.mjs";
import { findProjectDir } from "../detect.mjs";

// Tool registry ID for pak packaging. Shared so packaging and asset operations agree.
export const PAK_TOOL_ID = "repak";

export function gmfError(code, message, remediation = "") {
  const error = new Error(message);
  error.code = code;
  error.remediation = remediation;
  return error;
}

export function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

export function ensureGameDir(gameDir) {
  const resolved = path.resolve(gameDir || "");
  if (!gameDir || !isDirectory(resolved)) {
    throw gmfError(
      "GMF-E-GAME-001",
      `GMF-E-GAME-001: game directory does not exist or is not a directory: ${resolved}`,
      "Pass the game install folder, for example --input gameDir=<dir>.",
    );
  }
  // Operations work on the project folder (Binaries, Content/Paks), which a
  // shipped build nests beside Engine/ under the install root.
  return findProjectDir(resolved);
}

// Resolve gameDir from the input, then the workspace's machine paths or profile.
export function resolveGameDirInput(inputs = {}, context = {}) {
  const value =
    inputs.gameDir ||
    context?.workspace?.local?.gameDir ||
    context?.workspace?.profile?.game?.installDir ||
    context?.profile?.game?.installDir ||
    null;
  return ensureGameDir(value);
}

// Resolve modDir from the input, then the single mod under the workspace mods folder.
export function resolveModDirInput(inputs = {}, context = {}) {
  let value = inputs.modDir;
  if (!value && context?.workspace?.root) {
    const modsRoot = path.join(context.workspace.root, "mods");
    if (isDirectory(modsRoot)) {
      const mods = fs
        .readdirSync(modsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      if (mods.length === 1) value = path.join(modsRoot, mods[0]);
      else if (mods.length > 1) {
        throw gmfError(
          "GMF-E-PLAN-001",
          "More than one mod exists in the workspace; pass modDir.",
          "Pass --input modDir=mods/<name>.",
        );
      }
    }
  }
  return ensureModDir(value, context);
}

export function ensureModDir(modDir, context = null) {
  const raw = String(modDir || "");
  const resolved = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(context?.workspace?.root || context?.cwd || process.cwd(), raw);
  if (!raw || !isDirectory(resolved)) {
    throw gmfError(
      "GMF-E-GAME-001",
      `GMF-E-GAME-001: mod directory does not exist or is not a directory: ${resolved}`,
      "Run unreal.scaffold first, or pass the mod folder created by it.",
    );
  }
  return resolved;
}

export function workspaceRoot(context) {
  return context?.workspace?.root || context?.cwd || process.cwd();
}

export function ensureInsideWorkspace(context, target, label = "path") {
  const resolvedTarget = path.resolve(target);
  if (context?.workspace?.root) {
    if (!isInside(context.workspace.root, resolvedTarget)) {
      throw gmfError(
        "GMF-E-PLAN-001",
        `${label} must stay inside the workspace: ${resolvedTarget}`,
        "Choose an output directory under the workspace.",
      );
    }
    return resolvedTarget;
  }
  if (!isInside(workspaceRoot(context), resolvedTarget)) {
    throw gmfError(
      "GMF-E-PLAN-001",
      `${label} must stay inside the working directory: ${resolvedTarget}`,
      "Run the operation from a workspace or pass an output directory under it.",
    );
  }
  return resolvedTarget;
}

export function ensureInsideGame(gameDir, target) {
  const resolved = path.resolve(target);
  if (!isInside(gameDir, resolved)) {
    throw gmfError(
      "GMF-E-GAME-001",
      `Asset path escapes the game directory: ${resolved}`,
      "Pass an asset path inside the game install folder.",
    );
  }
  return resolved;
}

export function toolCacheFrom(context) {
  return context?.toolCacheDir || toolCacheDir(context?.env || process.env);
}

export function resolveToolFrom(context, id) {
  const tools = context?.tools;
  if (tools) {
    if (typeof tools.resolveTool === "function") {
      const resolved = tools.resolveTool(id);
      if (resolved) return resolved;
    }
    if (typeof tools.resolve === "function") {
      const resolved = tools.resolve(id);
      if (resolved) return resolved;
    }
    if (tools[id]) return tools[id];
  }
  try {
    return resolveTool(id, { cacheDir: toolCacheFrom(context) });
  } catch {
    return null;
  }
}

export function requireTool(context, id) {
  const tool = resolveToolFrom(context, id);
  if (!tool) {
    throw gmfError(
      "GMF-E-TOOL-001",
      `GMF-E-TOOL-001: required tool ${id} is not installed.`,
      `Run gmf tool install ${id} with an authorization for toolInstall.`,
    );
  }
  return tool;
}

export async function runResolvedTool(context, tool, args = [], options = {}) {
  if (tool && typeof tool.run === "function") return tool.run(args, options);
  const runner = context?.processes?.runProcess || context?.runProcess || runProcess;
  const cmd = tool.cmd || tool.path;
  if (!cmd) throw gmfError("GMF-E-TOOL-001", "GMF-E-TOOL-001: resolved tool has no executable path.", "Reinstall the tool.");
  const argv = [...(tool.args || []), ...args];
  return runner(cmd, argv, { timeoutMs: options.timeoutMs, cwd: options.cwd });
}

export function copyTree(sourceDir, targetDir) {
  if (!isDirectory(sourceDir)) throw gmfError("GMF-E-TOOL-001", `Not a directory: ${sourceDir}`, "Reinstall the tool.");
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) copyTree(source, target);
    else if (entry.isFile()) fs.copyFileSync(source, target);
  }
}

export function walkFiles(dir, found = []) {
  if (!isDirectory(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, found);
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

// Copies source files into the game folder as one unit: every overwritten file
// is backed up first and a failure part-way puts the written files back.
export function copyTreeWithBackup(context, pairs) {
  return copyFilesWithBackup(context?.workspace || null, pairs).deployed;
}

export function copyFileWithBackup(context, source, target) {
  return copyTreeWithBackup(context, [{ source, target }])[0];
}

export function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "game";
}

export function inferModType(modDir) {
  if (isDirectory(path.join(modDir, "Scripts"))) return "lua";
  if (isDirectory(path.join(modDir, "dlls")) || isDirectory(path.join(modDir, "Source"))) return "cpp";
  if (walkFiles(modDir).some((file) => file.toLowerCase().endsWith(".pak"))) return "pak";
  return "unknown";
}

export function findPakFiles(dir) {
  return walkFiles(dir).filter((file) => /\.(pak|ucas|utoc|sig)$/i.test(file));
}
