import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { registerOperation, getHandler } from "../../core/operations.mjs";
import { engineHints } from "./hints.mjs";

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function looksLikeGame(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  const hasDataDir = entries.some((entry) => entry.isDirectory() && /_data$/i.test(entry.name));
  const hasExecutable = entries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".exe"));
  const hasUnityAssembly = entries.some((entry) => entry.isFile() && /^GameAssembly\.(dll|so|dylib)$/i.test(entry.name));
  return hasDataDir || hasExecutable || hasUnityAssembly;
}

function engineHint(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return "unknown";
  }
  if (entries.some((entry) => entry.isDirectory() && /_data$/i.test(entry.name))) return "unity";
  // One generic folder name proves nothing: Unreal needs Engine/ with a
  // .uproject file, or two of its usual folders.
  const directories = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  const markers = ["Content", "Binaries", "Saved", "Config"].filter((name) => directories.has(name));
  const hasProject = entries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".uproject"));
  if ((directories.has("Engine") && hasProject) || markers.length >= 2) return "unreal";
  if (entries.some((entry) => entry.isFile() && /^GameAssembly\.(dll|so|dylib)$/i.test(entry.name))) {
    return "unity";
  }
  return "unknown";
}

// Steam library discovery: libraryfolders.vdf lists every library root, and
// each root holds steamapps/common/<game>. Read-only file lookups, no registry
// or process calls.
export function steamVdfFiles() {
  const home = os.homedir();
  return [
    "C:\\Program Files (x86)\\Steam\\steamapps\\libraryfolders.vdf",
    path.join(home, ".steam", "steam", "steamapps", "libraryfolders.vdf"),
    path.join(home, ".local", "share", "Steam", "steamapps", "libraryfolders.vdf"),
    "/mnt/c/Program Files (x86)/Steam/steamapps/libraryfolders.vdf",
  ];
}

export function parseLibraryFolders(vdfText) {
  return [...String(vdfText).matchAll(/"path"\s+"([^"]+)"/g)].map((match) => match[1].replace(/\\\\/g, "\\"));
}

function toLocalPath(p) {
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (drive && process.platform !== "win32") return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, "/")}`;
  return p;
}

// Steam installs its own tools beside the games.
const STEAM_TOOL_RE = /^(Proton\b|Steamworks Shared$|SteamLinuxRuntime)/i;

function isSteamGame(dir, name) {
  return !STEAM_TOOL_RE.test(name) && (looksLikeGame(dir) || engineHints(dir).length > 0);
}

function steamGameDirs(vdfFiles) {
  const dirs = [];
  for (const vdf of vdfFiles) {
    let text;
    try {
      text = fs.readFileSync(vdf, "utf8");
    } catch {
      continue;
    }
    for (const library of parseLibraryFolders(text)) {
      const common = path.join(toLocalPath(library), "steamapps", "common");
      let entries;
      try {
        entries = fs.readdirSync(common, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && isSteamGame(path.join(common, entry.name), entry.name)) dirs.push(path.join(common, entry.name));
      }
    }
  }
  return dirs;
}

export function listGames(roots = [], options = {}) {
  const games = [];
  const seen = new Set();
  const add = (dir, store = null) => {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    const engine = engineHint(resolved);
    const game = { name: path.basename(resolved), path: resolved, engine };
    if (store) game.store = store;
    game.hints = engine === "unknown" ? engineHints(resolved) : [];
    games.push(game);
  };

  if (!Array.isArray(roots) || roots.length === 0 || options.includeSteam === true) {
    const vdfFiles = Array.isArray(options.steamRoots) ? options.steamRoots : steamVdfFiles();
    for (const dir of steamGameDirs(vdfFiles)) add(dir, "steam");
  }

  for (const root of roots) {
    if (!root || !isDirectory(root)) continue;
    if (looksLikeGame(root)) {
      add(root);
      continue;
    }
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name);
      if (looksLikeGame(candidate)) add(candidate);
    }
  }
  return games;
}

function rootsFor(context = {}) {
  const roots = [];
  const envRoots = context.env?.GMF_GAME_ROOTS;
  if (typeof envRoots === "string" && envRoots.trim()) {
    roots.push(...envRoots.split(path.delimiter).filter(Boolean));
  }
  const localGame = context.workspace?.local?.gameDir;
  if (typeof localGame === "string" && localGame.trim()) roots.push(localGame);
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

const operation = {
  id: "game.games",
  title: "List game installs",
  summary: "List game folders under GMF_GAME_ROOTS and the workspace game path; Steam libraries are included when no root is configured or includeSteam is true.",
  engine: "core",
  inputs: {
    type: "object",
    properties: {
      steamRoots: { type: "array", items: { type: "string" } },
      includeSteam: { type: "boolean" },
    },
    required: [],
  },
  outputs: {
    type: "object",
    properties: {
      games: { type: "array" },
    },
  },
  effects: ["read"],
  requires: [],
  gates: ["auto"],
  skill: "gmf-investigate",
  docs: [],
  handler: async (inputs = {}, context) => {
    const options = { includeSteam: inputs.includeSteam === true };
    if (Array.isArray(inputs.steamRoots)) options.steamRoots = inputs.steamRoots.filter((root) => typeof root === "string");
    const games = listGames(rootsFor(context), options);
    return { data: { games }, evidence: [] };
  },
};

if (!getHandler(operation.id)) registerOperation(operation, operation.handler);

export default operation;
