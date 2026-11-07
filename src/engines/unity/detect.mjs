import fs from "node:fs";
import path from "node:path";
import { evidence, unknown } from "../../core/evidence.mjs";

// Unity 4 and 5 use 4.x.y and 5.x.y, Unity 2017 to 2023 use 20xx, and Unity 6
// numbers itself 6000.x. A version inside a longer dotted number does not count.
const VERSION_RE = /(?<![\d.])((?:20\d{2}|[6-9]\d{3}|[45])\.\d+\.\d+[abfpx]\d+)/;
const DATA_VERSION_FILES = ["globalgamemanagers", "mainData", "data.unity3d"];

const IL2CPP_METADATA_MAGIC = 0xfab11baf;

// global-metadata.dat starts with the magic 0xFAB11BAF and a uint32 version.
// The version decides which dumpers can read the game (Unity 6000.3 uses 39).
export function readMetadataVersion(file) {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const header = Buffer.alloc(8);
      if (fs.readSync(fd, header, 0, 8, 0) < 8) return null;
      return header.readUInt32LE(0) === IL2CPP_METADATA_MAGIC ? header.readUInt32LE(4) : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

// BepInEx writes "[Message: Preloader] BepInEx 6.0.0-be.793 - <Game> (...)"
// as the first line of BepInEx/LogOutput.log on every launch.
export function bepinexLogVersion(bepinDir) {
  try {
    const head = fs.readFileSync(path.join(bepinDir, "LogOutput.log"), "utf8").slice(0, 400);
    const match = head.match(/BepInEx\s+(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.+-]+)?)\s+-/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function assertGameDir(gameDir) {
  if (typeof gameDir !== "string" || gameDir.trim() === "") {
    const error = new Error("GMF-E-GAME-001: a game directory is required");
    error.code = "GMF-E-GAME-001";
    error.remediation = "Pass the game install folder that contains the game executable and data folder.";
    throw error;
  }
  const resolved = path.resolve(gameDir);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) {
    const error = new Error(
      `GMF-E-GAME-001: game directory does not exist or is not a directory: ${resolved}`,
    );
    error.code = "GMF-E-GAME-001";
    error.remediation = "Pass the game install folder that contains the game executable and data folder.";
    throw error;
  }
  return resolved;
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function readHead(file, maxBytes = 2 * 1024 * 1024) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString("latin1");
  } finally {
    fs.closeSync(fd);
  }
}

// The game's executables, the one named after the install folder first, then
// the rest by name. The crash handler is not the game.
function orderedExecutables(root, entries) {
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".exe") && !/^UnityCrashHandler/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const preferred = `${path.basename(root)}.exe`.toLowerCase();
  const match = names.find((name) => name.toLowerCase() === preferred);
  return match ? [match, ...names.filter((name) => name !== match)] : names;
}

export function findDataDir(gameDir) {
  const root = path.resolve(gameDir);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const dataDirs = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        (/_data$/i.test(entry.name) ||
          entry.name === "Data" ||
          entry.name.toLowerCase() === "data"),
    )
    .map((entry) => path.join(root, entry.name))
    .sort();
  if (dataDirs.length === 0) return null;

  for (const name of orderedExecutables(root, entries)) {
    const base = name.replace(/\.exe$/i, "").toLowerCase();
    const matching = dataDirs.find((dir) => path.basename(dir).toLowerCase() === `${base}_data`);
    if (matching) return matching;
  }
  const withManagers = dataDirs.find((dir) => DATA_VERSION_FILES.some((name) => isFile(path.join(dir, name))));
  return withManagers || dataDirs[0];
}

export function detectUnityVersion(dataDir) {
  if (!dataDir || !isDirectory(dataDir)) return { version: null, source: null, checked: [] };
  const checked = [];
  for (const name of DATA_VERSION_FILES) {
    const file = path.join(dataDir, name);
    if (!isFile(file)) continue;
    checked.push(file);
    const match = readHead(file).match(VERSION_RE);
    if (match) return { version: match[1], source: file, checked };
  }
  return { version: null, source: null, checked };
}

export function readAppInfo(dataDir) {
  if (!dataDir) return { company: null, product: null, source: null };
  const file = path.join(dataDir, "app.info");
  if (!isFile(file)) return { company: null, product: null, source: null };
  const lines = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return { company: lines[0] || null, product: lines[1] || null, source: file };
}

export function detectArchitecture(file) {
  if (!file || !isFile(file)) return "unknown";
  try {
    const fd = fs.openSync(file, "r");
    try {
      const header = Buffer.alloc(64);
      const read = fs.readSync(fd, header, 0, header.length, 0);
      if (read < 64 || header.toString("latin1", 0, 2) !== "MZ") return "unknown";
      const peOffset = header.readUInt32LE(0x3c);
      if (peOffset <= 0 || peOffset > 4096) return "unknown";
      const pe = Buffer.alloc(6);
      fs.readSync(fd, pe, 0, pe.length, peOffset);
      if (pe.toString("latin1", 0, 4) !== "PE\0\0") return "unknown";
      const machine = pe.readUInt16LE(4);
      if (machine === 0x8664) return "x86_64";
      if (machine === 0x14c) return "x86";
      if (machine === 0xaa64) return "arm64";
      return "unknown";
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "unknown";
  }
}

export function detectBackend(gameDir, dataDir) {
  const root = path.resolve(gameDir);
  const gameAssembly = ["GameAssembly.dll", "GameAssembly.so", "GameAssembly.dylib"]
    .map((name) => path.join(root, name))
    .find(isFile) || null;
  const metadata = dataDir
    ? path.join(dataDir, "il2cpp_data", "Metadata", "global-metadata.dat")
    : null;
  const hasMetadata = metadata ? isFile(metadata) : false;
  const managedDir = dataDir ? path.join(dataDir, "Managed") : null;
  const managedDlls = managedDir && isDirectory(managedDir)
    ? fs.readdirSync(managedDir).filter((name) => name.toLowerCase().endsWith(".dll"))
    : [];

  const evidenceRecords = [];
  const unknowns = [];

  if (gameAssembly) {
    evidenceRecords.push(
      evidence({
        claim: `IL2CPP runtime marker ${path.basename(gameAssembly)} is present`,
        confidence: "observed",
        authority: "shipped-artifact",
        source: gameAssembly,
      }),
    );
  }
  const metadataVersion = hasMetadata ? readMetadataVersion(metadata) : null;
  if (hasMetadata) {
    evidenceRecords.push(
      evidence({
        claim: metadataVersion
          ? `IL2CPP global metadata is present, metadata version ${metadataVersion}`
          : "IL2CPP global metadata is present",
        confidence: "observed",
        authority: "shipped-artifact",
        source: metadata,
      }),
    );
  }
  if (managedDlls.length > 0) {
    evidenceRecords.push(
      evidence({
        claim: `Mono managed assemblies are present (${managedDlls.length} DLLs)`,
        confidence: "observed",
        authority: "shipped-artifact",
        source: managedDir,
      }),
    );
  }

  if (gameAssembly && hasMetadata) {
    return { backend: "il2cpp", confidence: "observed", gameAssembly, metadata, metadataVersion, managedDir: null, managedDlls, evidence: evidenceRecords, unknowns };
  }
  if (gameAssembly && !hasMetadata) {
    unknowns.push(
      unknown({
        question: "Where is the IL2CPP global-metadata.dat for this game?",
        severity: "medium",
        nextProbe: `Check ${path.join(dataDir || "<data folder>", "il2cpp_data", "Metadata")} and the game install layout.`,
      }),
    );
    return { backend: "il2cpp", confidence: "derived", gameAssembly, metadata, managedDir: null, managedDlls, evidence: evidenceRecords, unknowns };
  }
  if (!gameAssembly && hasMetadata) {
    unknowns.push(
      unknown({
        question: "GameAssembly is missing although IL2CPP metadata is present",
        severity: "high",
        nextProbe: `Verify that GameAssembly.dll (or GameAssembly.so) exists in ${root}; the game install may be incomplete.`,
      }),
    );
    return { backend: "il2cpp", confidence: "derived", gameAssembly, metadata, metadataVersion, managedDir: null, managedDlls, evidence: evidenceRecords, unknowns };
  }
  if (managedDlls.length > 0) {
    return { backend: "mono", confidence: "observed", gameAssembly: null, metadata: null, managedDir, managedDlls, evidence: evidenceRecords, unknowns };
  }
  if (managedDir && isDirectory(managedDir)) {
    unknowns.push(
      unknown({
        question: "The Managed folder contains no assemblies",
        severity: "medium",
        nextProbe: `Check that ${managedDir} contains the game's managed DLLs; reinstall or verify the game files.`,
      }),
    );
    return { backend: "mono", confidence: "derived", gameAssembly: null, metadata: null, managedDir, managedDlls, evidence: evidenceRecords, unknowns };
  }
  unknowns.push(
    unknown({
      question: "Which Unity scripting backend does this game use?",
      severity: "high",
      nextProbe: "Look for GameAssembly.dll or a Managed folder with DLLs in the game data directory.",
    }),
  );
  return { backend: "unknown", confidence: "unknown", gameAssembly: null, metadata: null, managedDir, managedDlls, evidence: evidenceRecords, unknowns };
}

export function detectLoader(gameDir, backend = "unknown") {
  const root = path.resolve(gameDir);
  const bepin = path.join(root, "BepInEx");
  const core = path.join(bepin, "core");
  const notes = [];
  const has = (file) => isFile(file);
  const bepinPresent = isDirectory(bepin) || isFile(path.join(bepin, "winhttp.dll"));
  const corePresent = isDirectory(core);

  const bepin6Il2cpp =
    has(path.join(core, "BepInEx.Unity.IL2CPP.dll")) ||
    has(path.join(core, "BepInEx.Unity.IL2CPP.CoreCLR.dll")) ||
    has(path.join(core, "BepInEx.Unity.IL2CPP.Preloader.dll"));
  const bepin6Mono =
    has(path.join(core, "BepInEx.Unity.Mono.dll")) ||
    has(path.join(core, "BepInEx.Unity.Mono.Preloader.dll"));
  const bepin5 = has(path.join(core, "BepInEx.dll")) || has(path.join(core, "BepInEx.Preloader.dll"));
  const doorstop = has(path.join(root, "winhttp.dll")) || has(path.join(root, "libdoorstop.so"));

  const melonDir = path.join(root, "MelonLoader");
  // 0.5 kept MelonLoader.dll in MelonLoader/; 0.6 and later keep it in
  // MelonLoader/net6 (IL2CPP) or MelonLoader/net35 and net472 (Mono).
  const melonInstalled = ["", "MelonLoader", "net6", "net35", "net472"].some((sub) =>
    has(path.join(melonDir, sub, "MelonLoader.dll")),
  );
  const melonBootstrap = has(path.join(root, "MelonLoader.dll")) || has(path.join(root, "version.dll"));

  if (bepinPresent || corePresent) {
    let id = "bepinex5";
    let installed = false;
    if (bepin6Il2cpp) {
      id = "bepinex6";
      installed = true;
    } else if (bepin6Mono) {
      id = "bepinex6";
      installed = true;
    } else if (bepin5) {
      id = "bepinex5";
      installed = true;
    } else if (backend === "il2cpp" || has(path.join(core, "BepInEx.Core.dll"))) {
      id = "bepinex6";
    }

    if (!installed) {
      const missing =
        id === "bepinex6" && backend === "il2cpp"
          ? "BepInEx/core/BepInEx.Unity.IL2CPP.dll"
          : id === "bepinex6"
            ? "BepInEx/core/BepInEx.Unity.Mono.dll"
            : "BepInEx/core/BepInEx.dll";
      notes.push(
        `BepInEx is present but incomplete: ${missing} is missing. Install the matching ${id} build; GMF does not repair a loader.`,
      );
    }
    if (installed && !doorstop) {
      notes.push(
        "BepInEx core assemblies are installed but the doorstop entry (winhttp.dll) was not found; the loader may not start. Reinstall BepInEx and verify winhttp.dll.",
      );
    }
    if (melonInstalled || melonBootstrap) {
      notes.push("Both BepInEx and MelonLoader are present; GMF prefers BepInEx and does not install or remove either.");
    }
    let entry = null;
    if (bepin6Il2cpp) {
      entry = ["BepInEx.Unity.IL2CPP.dll", "BepInEx.Unity.IL2CPP.CoreCLR.dll", "BepInEx.Unity.IL2CPP.Preloader.dll"]
        .map((name) => path.join(core, name))
        .find(isFile);
    } else if (bepin6Mono) {
      entry = ["BepInEx.Unity.Mono.dll", "BepInEx.Unity.Mono.Preloader.dll"]
        .map((name) => path.join(core, name))
        .find(isFile);
    } else if (bepin5) {
      entry = ["BepInEx.dll", "BepInEx.Preloader.dll"]
        .map((name) => path.join(core, name))
        .find(isFile);
    }
    return {
      loader: { id, installed, version: bepinexLogVersion(bepin), path: bepin, notes },
      deployDir: path.join(bepin, "plugins"),
      interopDir: path.join(bepin, "interop"),
      entry,
      notes,
    };
  }

  if (melonInstalled) {
    // IL2CPP games load MelonLoader/net6; Mono games net472, net35 or the 0.5 layout.
    const subfolders = backend === "il2cpp" ? ["net6", "", "net472", "net35"] : ["net472", "net35", "", "net6"];
    const entry = subfolders.map((sub) => path.join(melonDir, sub, "MelonLoader.dll")).find(has) || null;
    return {
      loader: { id: "melonloader", installed: true, version: null, path: melonDir, notes },
      deployDir: path.join(root, "Mods"),
      interopDir: null,
      entry,
      notes,
    };
  }
  if (melonBootstrap) {
    notes.push(
      "MelonLoader bootstrap is present but no MelonLoader.dll was found under MelonLoader/ (net6, net35 or net472). Install MelonLoader; GMF does not repair a loader.",
    );
    return {
      loader: { id: "melonloader", installed: false, version: null, path: melonDir, notes },
      deployDir: path.join(root, "Mods"),
      interopDir: null,
      notes,
    };
  }

  return {
    loader: { id: "none", installed: false, version: null, path: null, notes: [] },
    deployDir: null,
    interopDir: null,
    notes: [],
  };
}

const FRAMEWORKS = {
  "bepinex5|mono": "net472",
  "bepinex6|mono": "netstandard2.1",
  "bepinex6|il2cpp": "net6.0",
  // MelonLoader 0.7 ships MelonLoader/net35 and net472 for Mono games and
  // MelonLoader/net6 for IL2CPP games. net472 suits Unity 2018 and later.
  "melonloader|mono": "net472",
  "melonloader|il2cpp": "net6.0",
};

export function targetFramework(loaderId, backend) {
  const framework = FRAMEWORKS[`${loaderId}|${backend}`];
  if (!framework) {
    throw new Error(
      `No target framework for loader ${loaderId} and backend ${backend}. BepInEx 5 supports Mono only; BepInEx 6 and MelonLoader support Mono and IL2CPP.`,
    );
  }
  return framework;
}

const TEMPLATES = {
  "bepinex5|mono": "bepinex5",
  "bepinex6|mono": "bepinex6-mono",
  "bepinex6|il2cpp": "bepinex6-il2cpp",
  "melonloader|mono": "melonloader",
  "melonloader|il2cpp": "melonloader",
};

export function templateFor(loaderId, backend) {
  const template = TEMPLATES[`${loaderId}|${backend}`];
  if (!template) {
    throw new Error(
      `No Unity mod template for loader ${loaderId} and backend ${backend}. Use BepInEx 5, BepInEx 6 Mono, BepInEx 6 IL2CPP or MelonLoader.`,
    );
  }
  return template;
}

function findExecutable(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const [first] = orderedExecutables(root, entries);
  return first ? path.join(root, first) : null;
}

export async function detectUnity(gameDir) {
  const root = assertGameDir(gameDir);
  const notes = [];
  const unknowns = [];
  const evidenceRecords = [];

  const dataDir = findDataDir(root);
  const executable = findExecutable(root);
  const runtime = { backend: "unknown", architecture: "unknown", confidence: "unknown" };
  const paths = {
    data: dataDir,
    managed: null,
    interop: null,
    deploy: null,
    content: null,
    binaries: null,
  };
  const markers = { antiCheat: [], online: false, launcher: null };

  if (!dataDir) {
    unknowns.push(
      unknown({
        question: "Where is the Unity data folder for this game?",
        severity: "high",
        nextProbe:
          "Look for a folder named <GameName>_Data next to the executable, or select the engine manually when it is a repackaged build.",
      }),
    );
  } else {
    evidenceRecords.push(
      evidence({
        claim: "A Unity data folder is present",
        confidence: "observed",
        authority: "shipped-artifact",
        source: dataDir,
      }),
    );
    notes.push(`Unity data folder: ${dataDir}`);
  }

  const versionInfo = detectUnityVersion(dataDir);
  if (versionInfo.version) {
    evidenceRecords.push(
      evidence({
        claim: `Unity version ${versionInfo.version} was read from ${path.basename(versionInfo.source)}`,
        confidence: "observed",
        authority: "shipped-artifact",
        source: versionInfo.source,
      }),
    );
  } else if (dataDir) {
    unknowns.push(
      unknown({
        question: "Which Unity version does this game use?",
        severity: "medium",
        nextProbe:
          "Read globalgamemanagers, mainData or data.unity3d, or run the game once and inspect the Player.log for the Unity version.",
      }),
    );
  }

  const backend = detectBackend(root, dataDir);
  runtime.backend = backend.backend;
  runtime.confidence = backend.confidence;
  runtime.architecture = detectArchitecture(executable || backend.gameAssembly);
  if (backend.metadataVersion) runtime.metadataVersion = backend.metadataVersion;
  evidenceRecords.push(...backend.evidence);
  unknowns.push(...backend.unknowns);
  if (backend.managedDir) paths.managed = backend.managedDir;

  const loaderInfo = detectLoader(root, backend.backend);
  notes.push(...loaderInfo.notes);
  paths.deploy = loaderInfo.deployDir;
  if (backend.backend === "il2cpp" && loaderInfo.loader.id === "bepinex6") {
    paths.interop = loaderInfo.interopDir;
  }

  if (loaderInfo.loader.id !== "none") {
    const loaderSource =
      loaderInfo.entry ||
      (loaderInfo.loader.path ? path.join(loaderInfo.loader.path, "core") : root);
    evidenceRecords.push(
      evidence({
        claim: `${loaderInfo.loader.id} is ${loaderInfo.loader.installed ? "installed" : "present but incomplete"}`,
        confidence: "observed",
        authority: "shipped-artifact",
        source: loaderSource,
      }),
    );
  }
  if (loaderInfo.loader.id !== "none" && !loaderInfo.loader.installed) {
    unknowns.push(
      unknown({
        question: `Is the ${loaderInfo.loader.id} installation complete?`,
        severity: "medium",
        nextProbe: `Reinstall ${loaderInfo.loader.id} and verify the files named in the loader notes: ${loaderInfo.loader.notes.join(" ") || "core assemblies and doorstop entry"}.`,
      }),
    );
  }

  if (paths.interop) {
    const interopDlls = isDirectory(paths.interop)
      ? fs.readdirSync(paths.interop).filter((name) => name.toLowerCase().endsWith(".dll"))
      : [];
    if (interopDlls.length === 0) {
      notes.push(
        `Launch the game once with BepInEx 6 IL2CPP installed to generate interop assemblies in ${paths.interop}; GMF does not create them.`,
      );
      unknowns.push(
        unknown({
          question: "Have the IL2CPP interop assemblies been generated?",
          severity: "medium",
          nextProbe: `Launch the game once with BepInEx 6 IL2CPP installed, then confirm ${paths.interop} contains Il2Cpp*.dll files.`,
        }),
      );
    }
  }

  if (executable) {
    evidenceRecords.push(
      evidence({
        claim: `Game executable ${path.basename(executable)} is present`,
        confidence: "observed",
        authority: "shipped-artifact",
        source: executable,
      }),
    );
  }

  const confidence = dataDir || backend.backend !== "unknown" ? "observed" : "unknown";

  return {
    engine: {
      id: "unity",
      version: versionInfo.version,
      confidence,
      evidence: evidenceRecords,
    },
    runtime,
    loader: loaderInfo.loader,
    markers,
    paths,
    notes,
    unknowns,
    evidence: evidenceRecords,
  };
}
