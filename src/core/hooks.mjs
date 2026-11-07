import fs from "node:fs";
import path from "node:path";
import { readJson, readWorkspace, writeJson } from "./workspace.mjs";
import { isInside } from "./fsutil.mjs";

const GUARDED_DIRS = ["decompiled", "extracted", "dumps"];
const GUARDED_NAMES = /^(BepInEx|MelonLoader|UE4SS|GameAssembly|global-metadata|Assembly-CSharp)/i;
const GUARDED_EXTENSIONS = /\.(dll|pak|usmap)$/i;
const VALIDATE_RECORD = path.join(".gmf", "last-validate.json");
const MAX_SCANNED_FILES = 5000;

const EMPTY = { stdout: "" };

function resolveWorkspace(payload, context) {
  if (context && "workspace" in context) return context.workspace || null;
  const start = context?.cwd || payload?.cwd || process.cwd();
  return readWorkspace(start);
}

function isUnder(parent, child) {
  return isInside(parent, child);
}

function describeEngine(workspace) {
  const id = workspace.profile?.engine?.id;
  if (id && id !== "unknown") return id;
  return workspace.config?.game?.engine || "unknown";
}

function sessionStart(workspace, context) {
  if (!workspace) {
    const dir = path.resolve(context?.cwd || process.cwd());
    const hasLocal = fs.existsSync(path.join(dir, "gmf.local.json"));
    const hasMods = fs.existsSync(path.join(dir, "mods")) && fs.statSync(path.join(dir, "mods")).isDirectory();
    if (hasLocal || hasMods) return { stdout: "GMF workspace is not configured; run gmf init --game <dir>\n" };
    return EMPTY;
  }
  const profile = workspace.profile || {};
  const lines = [
    "GMF workspace",
    `game: ${workspace.config?.game?.name || "unknown"}`,
    `engine: ${describeEngine(workspace)}`,
    `backend: ${profile.runtime?.backend || "unknown"}`,
    `loader: ${profile.loader?.id || "unknown"}`,
    `workspace: ${workspace.root}`,
    `unknowns: ${Array.isArray(profile.unknowns) ? profile.unknowns.length : 0}`,
  ];
  return { stdout: `${lines.join("\n")}\n` };
}

function preWrite(workspace, payload) {
  if (!workspace) return EMPTY;
  const input = payload?.tool_input || {};
  const target = input.file_path || input.path;
  if (typeof target !== "string" || !target) return EMPTY;
  const resolved = path.resolve(workspace.root, target);
  const base = path.basename(resolved);

  const block = (reason) => ({ stdout: "", decision: "block", reason });

  const gameDir = workspace.local?.gameDir;
  if (gameDir && isUnder(gameDir, resolved)) {
    return block(`${resolved} is inside the game install folder. Write mod output under the workspace mods/ folder and deploy it with a gated operation.`);
  }
  for (const dir of GUARDED_DIRS) {
    if (isUnder(path.join(workspace.root, dir), resolved)) {
      return block(`${resolved} is under ${dir}/, which holds game-derived content. Keep edits in mods/ and regenerate ${dir}/ with its operation.`);
    }
  }
  if (GUARDED_NAMES.test(base) || GUARDED_EXTENSIONS.test(base)) {
    return block(`${base} looks like a game or loader binary. Do not write it by hand; build or deploy it through a catalog operation.`);
  }
  return EMPTY;
}

// A real validate run: gmf (or node .../gmf.mjs) run unity.validate or unreal.validate.
const VALIDATE_COMMAND = /(?:^|[\s;&|(])(?:gmf|node\s+\S*gmf\.mjs)(?:\s+--\S+)*\s+run\s+(?:unity|unreal)\.validate\b/;

function postBash(workspace, payload) {
  if (!workspace) return EMPTY;
  const command = payload?.tool_input?.command;
  if (typeof command !== "string" || !VALIDATE_COMMAND.test(command)) return EMPTY;
  writeJson(path.join(workspace.root, VALIDATE_RECORD), { at: new Date().toISOString(), command });
  return EMPTY;
}

// Newest mtime under mods/ in milliseconds, or null when there are no files.
function newestModTime(modsDir) {
  let newest = null;
  let scanned = 0;
  const pending = [modsDir];
  while (pending.length > 0 && scanned < MAX_SCANNED_FILES) {
    const dir = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      scanned += 1;
      try {
        const mtime = fs.statSync(full).mtimeMs;
        if (newest === null || mtime > newest) newest = mtime;
      } catch {
        // A file that vanished mid-scan is not an edit.
      }
    }
  }
  return newest;
}

function stop(workspace) {
  if (!workspace) return EMPTY;
  const modsDir = path.join(workspace.root, "mods");
  const newest = newestModTime(modsDir);
  if (newest === null) return EMPTY;
  const record = readJson(path.join(workspace.root, VALIDATE_RECORD), null);
  const recorded = record?.at ? Date.parse(record.at) : NaN;
  if (Number.isFinite(recorded) && newest <= recorded) return EMPTY;
  const engine = describeEngine(workspace);
  const operation = engine === "unity" || engine === "unreal" ? `${engine}.validate` : "unity.validate or unreal.validate";
  return { stdout: `Files under mods/ changed since the last validation; run ${operation} before finishing.\n` };
}

export function handleHook(event, payload = {}, context = {}) {
  const workspace = resolveWorkspace(payload || {}, context);
  switch (event) {
    case "session-start":
      return sessionStart(workspace, { cwd: context?.cwd || payload?.cwd });
    case "pre-write":
      return preWrite(workspace, payload);
    case "post-bash":
      return postBash(workspace, payload);
    case "stop":
      return stop(workspace);
    default:
      return EMPTY;
  }
}
