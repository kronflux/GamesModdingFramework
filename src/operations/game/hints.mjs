import fs from "node:fs";
import path from "node:path";
import { registerOperation, getHandler } from "../../core/operations.mjs";
import { assertGameDir } from "../../engines/unity/detect.mjs";

function list(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Case-insensitive lookup of a relative path (forward slashes); returns the real path or null.
function find(root, relative) {
  let current = root;
  for (const part of relative.split("/")) {
    const match = list(current).find((entry) => entry.name.toLowerCase() === part.toLowerCase());
    if (!match) return null;
    current = path.join(current, match.name);
  }
  return current;
}

function filesMatching(dir, pattern) {
  return list(dir)
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

// confidence is "observed" for a marker only that engine ships, "inferred" for
// one that other software shares.
function hint(family, items, confidence = "observed") {
  return {
    family,
    confidence,
    evidence: items.map(([file, claim]) => ({ path: file, claim })),
  };
}

// Each rule returns a hint or null. Detection only reads directory listings.
const RULES = [
  function godot(root) {
    const pck = filesMatching(root, /\.pck$/i)[0];
    if (pck) return hint("godot", [[pck, "A .pck resource pack sits beside the executable, which Godot exports use."]]);
    const binary = find(root, "project.binary");
    if (binary) return hint("godot", [[binary, "project.binary is the Godot compiled project settings file."]]);
    return null;
  },
  function gamemaker(root) {
    for (const name of ["data.win", "game.unx", "game.ios"]) {
      const file = find(root, name);
      if (file) return hint("gamemaker", [[file, `${name} is the GameMaker data file.`]]);
    }
    return null;
  },
  function source(root) {
    const engine = find(root, "bin/engine.dll");
    const launcher = find(root, "hl2.exe") || find(root, "srcds.exe");
    if (engine && launcher) {
      return hint("source", [
        [engine, "bin/engine.dll is the Source engine library."],
        [launcher, "The Source launcher or dedicated server executable is present."],
      ]);
    }
    const vpk = filesMatching(root, /_dir\.vpk$/i)[0];
    if (vpk) return hint("source", [[vpk, "A *_dir.vpk archive index is the Source package format."]]);
    return null;
  },
  function renpy(root) {
    const folder = find(root, "renpy");
    if (folder && fs.statSync(folder).isDirectory()) return hint("renpy", [[folder, "A renpy/ folder holds the Ren'Py runtime."]]);
    const gameDir = find(root, "game");
    const rpa = gameDir ? filesMatching(gameDir, /\.rpa$/i)[0] : null;
    if (rpa) return hint("renpy", [[rpa, "A .rpa archive under game/ is the Ren'Py archive format."]]);
    return null;
  },
  function rpgmaker(root) {
    for (const name of ["www/js/rpg_core.js", "js/rmmz_core.js"]) {
      const file = find(root, name);
      if (file) return hint("rpgmaker", [[file, `${name} is the RPG Maker core script.`]]);
    }
    const nw = find(root, "nw.dll");
    const pkg = find(root, "package.json");
    if (nw && pkg) {
      return hint("rpgmaker", [
        [nw, "nw.dll is the NW.js runtime that RPG Maker deployments use."],
        [pkg, "package.json beside nw.dll is the NW.js app manifest."],
      ], "inferred");
    }
    return null;
  },
  function cryengine(root) {
    for (const name of ["CrySystem.dll", "Bin64/CrySystem.dll"]) {
      const file = find(root, name);
      if (file) return hint("cryengine", [[file, "CrySystem.dll is the CryEngine system library."]]);
    }
    return null;
  },
  function frostbite(root) {
    const data = find(root, "Data");
    if (!data) return null;
    const win32 = find(root, "Data/Win32");
    const sb = win32 ? filesMatching(win32, /\.sb$/i)[0] : null;
    if (sb) return hint("frostbite", [[sb, "A .sb superbundle under Data/Win32 is the Frostbite bundle format."]]);
    const toc =
      filesMatching(root, /\.toc$/i)[0] ||
      filesMatching(data, /\.toc$/i)[0] ||
      (win32 ? filesMatching(win32, /\.toc$/i)[0] : null);
    if (toc) return hint("frostbite", [[toc, "A .toc table of contents beside a Data folder is the Frostbite layout."]], "inferred");
    return null;
  },
  function construct(root) {
    const data = find(root, "data.js");
    const runtime = find(root, "c2runtime.js") || find(root, "c3runtime.js");
    if (data && runtime) {
      return hint("construct", [
        [data, "data.js is the Construct project data."],
        [runtime, "The Construct runtime script is present."],
      ]);
    }
    return null;
  },
  function unityWebgl(root) {
    const build = find(root, "Build");
    if (!build) return null;
    const wasm = filesMatching(build, /\.wasm$/i)[0];
    const loader = filesMatching(build, /\.loader\.js$/i)[0];
    if (wasm && loader) {
      return hint("unity-webgl", [
        [wasm, "A .wasm module under Build/ is the Unity WebGL player."],
        [loader, "A .loader.js under Build/ is the Unity WebGL loader."],
      ]);
    }
    return null;
  },
];

export function engineHints(gameDir) {
  const root = path.resolve(gameDir);
  const hints = [];
  for (const rule of RULES) {
    try {
      const found = rule(root);
      if (found) hints.push(found);
    } catch {
      // An unreadable marker never fails detection.
    }
  }
  return hints;
}

const operation = {
  id: "game.hints",
  title: "Engine family hints",
  summary: "Report engine family markers (Godot, GameMaker, Source, Ren'Py, RPG Maker, CryEngine, Frostbite, Construct, Unity WebGL) found in a game folder.",
  engine: "core",
  inputs: {
    type: "object",
    properties: {
      gameDir: { type: "string" },
    },
    required: ["gameDir"],
  },
  outputs: {
    type: "object",
    properties: {
      hints: { type: "array" },
    },
  },
  effects: ["read"],
  requires: [],
  gates: ["auto"],
  skill: "gmf-investigate",
  docs: [],
  handler: async (inputs) => {
    const resolved = assertGameDir(inputs.gameDir);
    const hints = engineHints(resolved);
    return { data: { hints }, evidence: [] };
  },
};

if (!getHandler(operation.id)) registerOperation(operation, operation.handler);

export default operation;
