// Unreal Engine detection: game layout, shipping executable, pak content, UE4SS and UE version.
// Detection is read-only. It never installs, launches or writes into the game folder.

import fs from "node:fs";
import path from "node:path";
import { evidence, unknown } from "../../core/evidence.mjs";
import { safeReaddir } from "../../core/fsutil.mjs";
import { parseUeBuildVersion, readVersionStrings } from "./sig/pe.mjs";

const UE_VERSION_PROBE =
  "Read the shipping executable version resource, run the game once with UE4SS, or read a PatternSleuth log.";
const EXECUTABLE_UNKNOWN_PROBE =
  "List Binaries/<platform> and pass the shipping executable path to the profile.";

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

// Windows paths are case-insensitive; Linux is not. Match exact first, then fold case.
function entryIn(dir, name) {
  if (!dir || !isDirectory(dir)) return null;
  const direct = path.join(dir, name);
  if (fs.existsSync(direct)) return direct;
  const folded = name.toLowerCase();
  for (const entry of safeReaddir(dir)) {
    if (entry.toLowerCase() === folded) return path.join(dir, entry);
  }
  return null;
}

function hasProjectMarkers(dir) {
  const binaries = entryIn(dir, "Binaries");
  const hasPlatform = binaries && ["Win64", "Win32", "Linux", "Mac"].some((platform) => entryIn(binaries, platform));
  const content = entryIn(dir, "Content");
  return Boolean(hasPlatform || (content && entryIn(content, "Paks")));
}

// A shipped Unreal build puts a launcher exe and Engine/ at the install root and
// the game itself in a project folder beside them (<Root>/<Project>/Binaries,
// <Root>/<Project>/Content/Paks). The project name often differs from the
// launcher name. Return that project folder, or gameDir when gameDir already is
// one or no project folder is found.
export function findProjectDir(gameDir) {
  const resolved = path.resolve(gameDir || "");
  if (!isDirectory(resolved) || hasProjectMarkers(resolved)) return resolved;
  const candidates = safeReaddir(resolved, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.toLowerCase() !== "engine")
    .map((entry) => path.join(resolved, entry.name))
    .filter(hasProjectMarkers)
    .sort((left, right) => left.localeCompare(right));
  if (candidates.length === 0) return resolved;
  // Prefer the folder whose Binaries hold a <Project>-<Platform>-Shipping executable.
  const shipping = candidates.find((dir) => {
    const binaries = findBinariesDir(dir);
    return binaries && safeReaddir(binaries).some((name) => name.toLowerCase().startsWith(`${path.basename(dir).toLowerCase()}-`));
  });
  return shipping || candidates[0];
}

export function findUproject(gameDir) {
  if (!isDirectory(gameDir)) return null;
  const entry = safeReaddir(gameDir, { withFileTypes: true })
    .filter((candidate) => candidate.isFile() && candidate.name.toLowerCase().endsWith(".uproject"))
    .sort((left, right) => left.name.localeCompare(right.name))[0];
  return entry ? path.join(gameDir, entry.name) : null;
}

export function findBinariesDir(gameDir) {
  const binaries = entryIn(gameDir, "Binaries");
  if (!binaries) return null;
  for (const platform of ["Win64", "Win32", "Linux", "Mac"]) {
    const candidate = entryIn(binaries, platform);
    if (candidate && isDirectory(candidate)) return candidate;
  }
  return null;
}

function isExecutableName(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".dll") || lower.endsWith(".so") || lower.endsWith(".dylib")) return false;
  if (/\.(ini|txt|json|log|pak|sig|ucas|utoc|pdb|lib)$/.test(lower)) return false;
  if (lower === "ue4ss.dll" || lower.startsWith("ue4ss")) return false;
  if (lower.endsWith(".exe")) return true;
  return path.extname(name) === "";
}

export function listExecutables(gameDir) {
  const binariesDir = findBinariesDir(gameDir);
  if (!binariesDir) return [];
  return safeReaddir(binariesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isExecutableName(entry.name))
    .map((entry) => path.join(binariesDir, entry.name))
    .sort((left, right) => path.basename(left).localeCompare(path.basename(right)));
}

function executableRank(file) {
  const name = path.basename(file).toLowerCase();
  let rank = 0;
  if (name.includes("-shipping")) rank -= 8;
  if (name.includes("shipping")) rank -= 4;
  if (name.includes("win64")) rank -= 2;
  if (name.includes("-game")) rank -= 1;
  return rank;
}

export function findShippingExe(gameDir) {
  const executables = listExecutables(gameDir);
  if (executables.length === 0) return null;
  const ranked = [...executables].sort((left, right) => {
    const difference = executableRank(left) - executableRank(right);
    return difference !== 0 ? difference : path.basename(left).localeCompare(path.basename(right));
  });
  return ranked[0];
}

export function detectPakLayout(gameDir) {
  const content = entryIn(gameDir, "Content");
  const paksDir = content ? entryIn(content, "Paks") : null;
  const pakFiles = [];
  if (paksDir && isDirectory(paksDir)) {
    for (const entry of safeReaddir(paksDir, { withFileTypes: true })) {
      if (entry.isFile() && /\.(pak|ucas|utoc|sig)$/i.test(entry.name)) pakFiles.push(path.join(paksDir, entry.name));
    }
    pakFiles.sort((left, right) => path.basename(left).localeCompare(path.basename(right)));
  }
  const logicModsDir = paksDir ? entryIn(paksDir, "LogicMods") : null;
  return {
    content,
    paksDir,
    pakFiles,
    logicModsDir,
    hasPakContainer: pakFiles.some((file) => /\.pak$/i.test(file)),
  };
}

function readTextIfPresent(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
}

function loaderVersion(root) {
  for (const name of ["version.txt", "UE4SS.version", "VERSION"]) {
    const file = entryIn(root, name);
    if (file && isFile(file)) {
      const value = readTextIfPresent(file);
      if (value) return value.split(/\r?\n/)[0].trim();
    }
  }
  // UE4SS 3.x ships no version file; its log names the build on every launch:
  // "UE4SS - v3.0.1 Experimental - Git SHA #4fb9b615".
  const log = entryIn(root, "UE4SS.log");
  if (log && isFile(log)) {
    const match = (readTextIfPresent(log) || "").slice(0, 2000).match(/UE4SS - (v[^\r\n]*?) - Git SHA #([0-9a-f]+)/i);
    if (match) return `${match[1].trim()} (${match[2]})`;
  }
  return null;
}

export function detectUe4ss(gameDir, { binariesDir = findBinariesDir(gameDir) } = {}) {
  const candidates = [];
  const seen = new Set();
  const addCandidate = (candidate) => {
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    candidates.push(candidate);
  };

  addCandidate(entryIn(gameDir, "ue4ss"));
  if (binariesDir) addCandidate(entryIn(binariesDir, "ue4ss"));

  for (const root of [...candidates]) {
    for (const dllName of ["UE4SS.dll", "libUE4SS.so", "UE4SS.so"]) {
      const dll = entryIn(root, dllName);
      if (dll && isFile(dll)) {
        return {
          id: "ue4ss",
          installed: true,
          version: loaderVersion(root),
          path: root,
          dll,
          notes: [],
        };
      }
    }
  }

  // Some installs place UE4SS.dll and the Mods folder directly beside the executable.
  const looseRoots = [binariesDir, gameDir].filter(Boolean);
  for (const root of looseRoots) {
    for (const dllName of ["UE4SS.dll", "libUE4SS.so", "UE4SS.so"]) {
      const dll = entryIn(root, dllName);
      if (dll && isFile(dll)) {
        return {
          id: "ue4ss",
          installed: true,
          version: loaderVersion(root),
          path: root,
          dll,
          notes: [],
        };
      }
    }
  }

  if (candidates.length > 0) {
    const root = candidates[0];
    return {
      id: "ue4ss",
      installed: false,
      version: null,
      path: root,
      dll: null,
      notes: [`UE4SS folder at ${root} is incomplete: UE4SS.dll is missing.`],
    };
  }

  return { id: "none", installed: false, version: null, path: null, dll: null, notes: [] };
}

export function findUe4ssRoot(gameDir) {
  const loader = detectUe4ss(gameDir);
  if (loader.installed && loader.path) return loader.path;
  return null;
}

export function detectUeVersion(gameDir, exePath = null) {
  const uproject = findUproject(gameDir);
  if (uproject) {
    try {
      const raw = fs.readFileSync(uproject, "utf8");
      const data = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
      const association = data?.EngineAssociation;
      if (typeof association === "string" && /^\d+(\.\d+)+$/.test(association.trim())) {
        return {
          version: association.trim(),
          confidence: "derived",
          evidence: [
            evidence({
              claim: `The .uproject EngineAssociation declares Unreal Engine ${association.trim()}.`,
              confidence: "derived",
              authority: "shipped-artifact",
              source: uproject,
              detail: { engineAssociation: association.trim() },
            }),
          ],
        };
      }
    } catch {
      // A malformed .uproject is not a detection failure; the version stays unknown.
    }
  }
  // A shipped build carries no .uproject; its shipping executable's version
  // resource holds the engine build string, such as ++UE5+Release-5.6-CL-44394996.
  if (exePath && isFile(exePath)) {
    try {
      const strings = readVersionStrings(fs.readFileSync(exePath));
      const build = parseUeBuildVersion(strings.ProductVersion) || parseUeBuildVersion(strings.FileVersion);
      if (build) {
        return {
          version: build.version,
          confidence: "observed",
          productName: strings.ProductName || null,
          evidence: [
            evidence({
              claim: `The shipping executable's version resource declares Unreal Engine ${build.version} (${build.branch}, changelist ${build.changelist || "unknown"}).`,
              confidence: "observed",
              authority: "shipped-artifact",
              source: exePath,
              detail: { ...build, productName: strings.ProductName || null },
            }),
          ],
        };
      }
    } catch {
      // An unreadable executable leaves the version unknown.
    }
  }
  return { version: null, confidence: "unknown", evidence: [] };
}

function architectureFor(binariesDir) {
  if (!binariesDir) return "unknown";
  const platform = path.basename(binariesDir).toLowerCase();
  if (platform === "win64" || platform === "linux") return "x86_64";
  if (platform === "win32") return "x86";
  return "unknown";
}

function displayPath(gameDir, target) {
  if (!target) return null;
  const relative = path.relative(gameDir, target);
  return relative && !relative.startsWith("..") ? relative.replace(/\\/g, "/") : target;
}

export async function detectUnreal(gameDir) {
  const resolved = path.resolve(gameDir || "");
  if (!gameDir || !isDirectory(resolved)) {
    const error = new Error(`GMF-E-GAME-001: game directory does not exist or is not a directory: ${resolved}`);
    error.code = "GMF-E-GAME-001";
    error.remediation = "Pass the game install folder, for example gmf detect --game <dir>.";
    throw error;
  }

  // The game itself may sit in a project folder beside Engine/ (shipped layout).
  const project = findProjectDir(resolved);
  const binariesDir = findBinariesDir(project);
  const executable = findShippingExe(project);
  const pakLayout = detectPakLayout(project);
  const uproject = findUproject(project);
  const loader = detectUe4ss(project, { binariesDir });
  const versionInfo = detectUeVersion(project, executable);

  const found = [];
  if (executable) {
    found.push(
      evidence({
        claim: `A shipping executable ships at ${displayPath(resolved, executable)}.`,
        confidence: "observed",
        authority: "shipped-artifact",
        source: executable,
        detail: { kind: "executable" },
      }),
    );
  }
  if (pakLayout.paksDir) {
    found.push(
      evidence({
        claim: `Cooked pak content ships at ${displayPath(resolved, pakLayout.paksDir)}.`,
        confidence: "observed",
        authority: "shipped-artifact",
        source: pakLayout.paksDir,
        detail: { kind: "pak-layout", pakFiles: pakLayout.pakFiles.length },
      }),
    );
  }
  if (uproject) {
    found.push(
      evidence({
        claim: `A .uproject descriptor ships at ${displayPath(resolved, uproject)}.`,
        confidence: "observed",
        authority: "shipped-artifact",
        source: uproject,
        detail: { kind: "uproject" },
      }),
    );
  }
  if (loader.installed && loader.dll) {
    found.push(
      evidence({
        claim: "UE4SS is installed in the game folder.",
        confidence: "observed",
        authority: "shipped-artifact",
        source: loader.dll,
        detail: { kind: "loader", loader: "ue4ss", version: loader.version },
      }),
    );
  }

  let confidence = "unknown";
  if (executable && (pakLayout.paksDir || uproject)) confidence = "observed";
  else if (uproject && pakLayout.paksDir) confidence = "observed";
  else if (executable || uproject || pakLayout.paksDir) confidence = "derived";

  // Unknowns and notes describe this engine only when at least one Unreal marker was found,
  // so an unrelated game does not inherit Unreal probes in the assembled profile.
  const unknowns = [];
  const notes = [];
  if (confidence === "unknown") {
    notes.push("No Unreal markers were found; checked Binaries/<platform>, Content/Paks, *.uproject and UE4SS.");
  } else {
    if (versionInfo.version === null) {
      unknowns.push(
        unknown({
          question: "Which Unreal Engine version does this game use?",
          severity: "medium",
          nextProbe: UE_VERSION_PROBE,
        }),
      );
    }
    if (!executable) {
      unknowns.push(
        unknown({
          question: "Which executable ships this Unreal game?",
          severity: "medium",
          nextProbe: EXECUTABLE_UNKNOWN_PROBE,
        }),
      );
    }
    if (loader.id === "none") {
      notes.push("UE4SS is not installed; Unreal Lua and C++ capabilities are needs-tool.");
    } else if (!loader.installed) {
      notes.push(...loader.notes);
      notes.push("UE4SS is present but incomplete; install or repair it before deploying mods.");
    }
  }

  const modsDir = loader.installed ? entryIn(loader.path, "Mods") : null;

  return {
    engine: {
      id: "unreal",
      version: versionInfo.version,
      confidence,
      selected: confidence === "observed",
      alternatives: [],
      evidence: [...found, ...versionInfo.evidence],
    },
    runtime: {
      backend: "native",
      architecture: architectureFor(binariesDir),
    },
    loader,
    markers: { antiCheat: [], online: false, launcher: null },
    paths: {
      data: null,
      managed: null,
      interop: null,
      deploy: modsDir || (loader.installed ? path.join(loader.path, "Mods") : null),
      content: pakLayout.content,
      binaries: binariesDir,
      paks: pakLayout.paksDir,
      executable,
      uproject,
      logicMods: pakLayout.logicModsDir,
    },
    notes,
    unknowns,
  };
}
