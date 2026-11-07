import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PROFILE_VERSION } from "./contracts.mjs";
import { evidence, mergeEvidence, unknown } from "./evidence.mjs";
import { selectEngine } from "../engines/index.mjs";

const RANK = { observed: 3, derived: 2, inferred: 1, unknown: 0 };

const CAPABILITY_ORDER = ["code", "decompile", "assets", "replace", "translate"];

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
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

export function findGameExecutable(gameDir) {
  const root = path.resolve(gameDir);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const executables = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.toLowerCase().endsWith(".exe") &&
        !/^UnityCrashHandler/i.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (executables.length === 0) return null;
  const preferred = `${path.basename(root)}.exe`.toLowerCase();
  return executables.find((name) => name.toLowerCase() === preferred) || executables[0];
}

export function readAppInfo(gameDir) {
  const root = path.resolve(gameDir);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { company: null, product: null, source: null };
  }
  const dataDir = entries.find((entry) => entry.isDirectory() && /_data$/i.test(entry.name));
  if (!dataDir) return { company: null, product: null, source: null };
  const file = path.join(root, dataDir.name, "app.info");
  if (!isFile(file)) return { company: null, product: null, source: null };
  const lines = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return { company: lines[0] || null, product: lines[1] || null, source: file };
}

// A Steam install lives at <library>/steamapps/common/<installdir>, and
// <library>/steamapps/appmanifest_<appid>.acf names that installdir.
function steamManifestAppId(root) {
  const common = path.dirname(root);
  if (path.basename(common).toLowerCase() !== "common") return null;
  const steamapps = path.dirname(common);
  if (path.basename(steamapps).toLowerCase() !== "steamapps") return null;
  let names = [];
  try {
    names = fs.readdirSync(steamapps).filter((name) => /^appmanifest_\d+\.acf$/i.test(name));
  } catch {
    return null;
  }
  const installdir = path.basename(root).toLowerCase();
  for (const name of names) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(steamapps, name), "utf8");
    } catch {
      continue;
    }
    const dir = text.match(/"installdir"\s+"([^"]*)"/i);
    if (dir && dir[1].toLowerCase() === installdir) {
      const id = text.match(/"appid"\s+"(\d+)"/i);
      return id ? id[1] : name.match(/\d+/)[0];
    }
  }
  return null;
}

export function detectStore(gameDir) {
  const root = path.resolve(gameDir);
  const manifestAppId = steamManifestAppId(root);
  if (manifestAppId) return { id: "steam", appId: manifestAppId };
  const appIdFile = path.join(root, "steam_appid.txt");
  if (isFile(appIdFile)) {
    return { id: "steam", appId: fs.readFileSync(appIdFile, "utf8").trim() || null };
  }
  const steamMarkers = ["steam_api64.dll", "steam_api.dll", "steam_api64.so", "libsteam_api.so"];
  if (steamMarkers.some((name) => isFile(path.join(root, name)))) return { id: "steam", appId: null };
  let entries = [];
  try {
    entries = fs.readdirSync(root);
  } catch {
    entries = [];
  }
  if (entries.some((name) => /^goggame-.*\.info$/i.test(name))) return { id: "gog", appId: null };
  if (isFile(path.join(root, "EOSSDK-Win64-Shipping.dll"))) return { id: "epic", appId: null };
  return { id: "manual", appId: null };
}

function normalizeTools(tools) {
  const records = Array.isArray(tools) ? tools : tools && typeof tools === "object" ? Object.values(tools) : [];
  return records
    .filter((tool) => tool && typeof tool.id === "string")
    .map((tool) => ({
      id: tool.id,
      installed: Boolean(tool.installed),
      version: tool.version ?? null,
      path: tool.path ?? null,
      license: typeof tool.license === "string" ? tool.license : "",
    }));
}

function summarizeEngine(engine) {
  return {
    id: engine?.id || "unknown",
    version: engine?.version ?? null,
    confidence: engine?.confidence || "unknown",
    evidence: Array.isArray(engine?.evidence) ? engine.evidence : [],
  };
}

function normalizePaths(paths = {}) {
  return {
    data: paths.data ?? null,
    managed: paths.managed ?? null,
    interop: paths.interop ?? null,
    deploy: paths.deploy ?? null,
    content: paths.content ?? null,
    binaries: paths.binaries ?? null,
    executable: paths.executable ?? null,
    paks: paths.paks ?? null,
    uproject: paths.uproject ?? null,
  };
}

function normalizeLoader(loader = {}) {
  if (!loader || typeof loader !== "object") {
    return { id: "none", installed: false, version: null, path: null, notes: [] };
  }
  return {
    id: typeof loader.id === "string" ? loader.id : "none",
    installed: Boolean(loader.installed),
    version: loader.version ?? null,
    path: loader.path ?? null,
    notes: Array.isArray(loader.notes) ? [...loader.notes] : [],
  };
}

function mergeMarkers(primaryMarkers, overrideMarkers) {
  const markers = { antiCheat: [], online: false, launcher: null };
  for (const source of [primaryMarkers, overrideMarkers]) {
    if (!source || typeof source !== "object") continue;
    if (Array.isArray(source.antiCheat)) {
      for (const marker of source.antiCheat) {
        if (!markers.antiCheat.some((existing) => JSON.stringify(existing) === JSON.stringify(marker))) {
          markers.antiCheat.push(marker);
        }
      }
    }
    if (source.online === true) markers.online = true;
    if (source.launcher) markers.launcher = source.launcher;
  }
  return markers;
}

function dedupeById(records) {
  const seen = new Map();
  for (const record of records) {
    if (!record) continue;
    seen.set(record.id || JSON.stringify(record), record);
  }
  return [...seen.values()];
}

function dedupeStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function toolInstalled(profile, id) {
  return (profile.tools || []).some((tool) => tool.id === id && tool.installed);
}

function loaderRequirement(profile) {
  if (profile.loader?.id && profile.loader.id !== "none" && profile.loader.id !== "unknown") {
    return profile.loader.id;
  }
  return profile.runtime?.backend === "il2cpp" ? "bepinex6" : "bepinex5";
}

export function capabilityList(profile = {}) {
  const backend = profile.runtime?.backend || "unknown";
  const loader = normalizeLoader(profile.loader);
  const loaderUsable = loader.installed && loader.id !== "none" && loader.id !== "unknown";
  const capabilities = [];

  if (backend === "unknown") {
    capabilities.push({
      id: "code",
      support: "unsupported",
      requires: [],
      reason: "The runtime backend is unknown; identify the engine and backend before scaffolding code mods.",
    });
  } else if (loaderUsable) {
    capabilities.push({ id: "code", support: "full", requires: [], reason: `${loader.id} is installed for the ${backend} backend.` });
  } else {
    const requirement = loaderRequirement(profile);
    const missing = loader.id !== "none" && loader.id !== "unknown"
      ? `The ${loader.id} installation is incomplete.`
      : `No loader is installed for the ${backend} backend.`;
    capabilities.push({
      id: "code",
      support: "needs-tool",
      requires: [requirement],
      reason: `${missing} Install ${requirement} to load a code mod.`,
    });
  }

  if (backend === "mono") {
    capabilities.push({
      id: "decompile",
      support: toolInstalled(profile, "ilspycmd") ? "full" : "needs-tool",
      requires: ["ilspycmd"],
      reason: "Mono assemblies decompile with ilspycmd.",
    });
  } else if (backend === "il2cpp") {
    const available = toolInstalled(profile, "cpp2il") || toolInstalled(profile, "il2cppdumper");
    capabilities.push({
      id: "decompile",
      support: available ? "full" : "needs-tool",
      requires: ["cpp2il", "il2cppdumper"],
      reason: "IL2CPP dumps use Cpp2IL or Il2CppDumper.",
    });
  } else {
    capabilities.push({ id: "decompile", support: "unsupported", requires: [], reason: "The backend is unknown." });
  }

  if (backend === "unknown") {
    capabilities.push({ id: "assets", support: "unsupported", requires: [], reason: "The backend is unknown." });
  } else {
    capabilities.push({
      id: "assets",
      support: toolInstalled(profile, "assetripper") ? "full" : "needs-tool",
      requires: ["assetripper"],
      reason: "AssetRipper extracts Unity assets into the workspace.",
    });
  }

  if (backend === "unknown") {
    capabilities.push({ id: "replace", support: "unsupported", requires: [], reason: "The backend is unknown." });
    capabilities.push({ id: "translate", support: "unsupported", requires: [], reason: "The backend is unknown." });
  } else {
    capabilities.push({
      id: "replace",
      support: toolInstalled(profile, "unitypy") ? "full" : "needs-tool",
      requires: ["unitypy"],
      reason: "UnityPy replaces asset fields and writes the modified bundle.",
    });
    capabilities.push({
      id: "translate",
      support: toolInstalled(profile, "unitypy") ? "full" : "needs-tool",
      requires: ["unitypy"],
      reason: "Translation extracts strings, replaces them, and repacks the assets.",
    });
  }

  return capabilities.sort(
    (left, right) => CAPABILITY_ORDER.indexOf(left.id) - CAPABILITY_ORDER.indexOf(right.id),
  );
}

export function unknownList(profile = {}) {
  return Array.isArray(profile.unknowns) ? profile.unknowns : [];
}

export function buildProfile({ gameDir, detections = [], tools = [], markers = null } = {}) {
  const records = Array.isArray(detections) ? detections.filter(Boolean) : [];
  const installDir = gameDir ? path.resolve(gameDir) : null;
  const { selected, alternatives } = selectEngine(records);
  const primary = selected || records.find((record) => record.engine?.confidence !== "unknown") || records[0] || null;

  const executableName = installDir ? findGameExecutable(installDir) : null;
  let executable = executableName && installDir ? path.join(installDir, executableName) : null;
  if (!executable && primary?.paths?.executable) executable = primary.paths.executable;
  const appInfo = installDir ? readAppInfo(installDir) : { company: null, product: null, source: null };
  const sha256 = executable && isFile(executable) ? sha256File(executable) : null;

  const evidenceRecords = [];
  for (const record of records) {
    if (Array.isArray(record.engine?.evidence)) evidenceRecords.push(...record.engine.evidence);
    if (Array.isArray(record.evidence)) evidenceRecords.push(...record.evidence);
  }
  if (executable && sha256) {
    evidenceRecords.push(
      evidence({
        claim: `Game executable ${path.basename(executable)} has sha256 ${sha256}`,
        confidence: "observed",
        authority: "shipped-artifact",
        source: executable,
        detail: { size: fs.statSync(executable).size },
      }),
    );
  }
  if (appInfo.source) {
    evidenceRecords.push(
      evidence({
        claim: `app.info reports product "${appInfo.product}" and company "${appInfo.company}"`,
        confidence: "observed",
        authority: "shipped-artifact",
        source: appInfo.source,
      }),
    );
  }

  const engine = selected
    ? {
        id: selected.engine.id,
        version: selected.engine.version ?? null,
        confidence: selected.engine.confidence || "observed",
        selected: true,
        alternatives: alternatives.map((record) => summarizeEngine(record.engine)),
      }
    : {
        id: "unknown",
        version: null,
        confidence: "unknown",
        selected: false,
        alternatives: records.map((record) => summarizeEngine(record.engine)),
      };

  const runtime = selected?.runtime || primary?.runtime || { backend: "unknown", architecture: "unknown" };
  const loader = normalizeLoader(selected?.loader || primary?.loader);
  const paths = normalizePaths(selected?.paths || primary?.paths);
  const notes = dedupeStrings([
    ...(Array.isArray(primary?.notes) ? primary.notes : []),
    ...(Array.isArray(loader.notes) ? loader.notes : []),
  ]);

  // Once an engine is selected, only its detector's questions apply; the other
  // detectors' unknowns (such as a missing Unity data folder) are noise.
  const unknowns = [];
  for (const record of selected ? [selected] : records) {
    if (Array.isArray(record.unknowns)) unknowns.push(...record.unknowns);
  }
  const asksVersion = unknowns.some((entry) => /version/i.test(entry?.question || ""));
  if (!selected) {
    unknowns.push(
      unknown({
        question: "Which engine is this game built with?",
        severity: "high",
        nextProbe:
          "Inspect the game executable and top-level folders, add a detection signature, or select the engine manually.",
      }),
    );
  } else if (!engine.version && !asksVersion) {
    unknowns.push(
      unknown({
        question: `Which ${engine.id} version does this game use?`,
        severity: "medium",
        nextProbe:
          "Read the engine version from the shipped data files or the executable version resource, or run the game once and inspect the log.",
      }),
    );
  }

  const profile = {
    version: PROFILE_VERSION,
    generatedAt: new Date().toISOString(),
    game: {
      name: appInfo.product || (installDir ? path.basename(installDir) : "Game"),
      installDir,
      executable,
      sha256,
      product: appInfo.product,
      company: appInfo.company,
      store: installDir ? detectStore(installDir) : { id: "manual", appId: null },
    },
    engine,
    runtime: {
      backend: runtime.backend || "unknown",
      architecture: runtime.architecture || "unknown",
      ...(runtime.confidence ? { confidence: runtime.confidence } : {}),
      ...(runtime.metadataVersion ? { metadataVersion: runtime.metadataVersion } : {}),
    },
    loader,
    tools: normalizeTools(tools),
    capabilities: [],
    markers: mergeMarkers(primary?.markers, markers),
    paths,
    notes,
    unknowns: dedupeById(unknowns),
    evidence: mergeEvidence([], evidenceRecords),
  };
  profile.capabilities =
    typeof selected?.engineCapabilities === "function" ? selected.engineCapabilities(profile) : capabilityList(profile);
  return profile;
}

export function mergeDetection(profile, detection) {
  if (!profile || !profile.engine) {
    return buildProfile({ gameDir: detection?.gameDir || "", detections: [detection] });
  }
  const next = structuredClone(profile);
  const incoming = detection || {};
  const currentRank = RANK[next.engine.confidence] ?? 0;
  const incomingRank = RANK[incoming.engine?.confidence] ?? 0;
  const alternatives = Array.isArray(next.engine.alternatives) ? [...next.engine.alternatives] : [];
  const previous = summarizeEngine(next.engine);

  if (incomingRank > currentRank && incoming.engine?.id && incoming.engine.id !== "unknown") {
    if (previous.id !== "unknown" && !alternatives.some((alternative) => alternative.id === previous.id)) {
      alternatives.push(previous);
    }
    next.engine = {
      id: incoming.engine.id,
      version: incoming.engine.version ?? null,
      confidence: incoming.engine.confidence,
      selected: true,
      alternatives,
    };
    if (incoming.runtime) next.runtime = { ...next.runtime, ...incoming.runtime };
    if (incoming.loader) next.loader = normalizeLoader(incoming.loader);
    next.paths = { ...next.paths, ...normalizePaths(incoming.paths) };
  } else {
    if (
      incoming.engine?.id &&
      !alternatives.some((alternative) => alternative.id === incoming.engine.id)
    ) {
      alternatives.push(summarizeEngine(incoming.engine));
    }
    next.engine = { ...next.engine, alternatives };
  }

  next.notes = dedupeStrings([
    ...(Array.isArray(next.notes) ? next.notes : []),
    ...(Array.isArray(incoming.notes) ? incoming.notes : []),
  ]);
  next.evidence = mergeEvidence(next.evidence, [
    ...(incoming.engine?.evidence || []),
    ...(incoming.evidence || []),
  ]);
  next.unknowns = dedupeById([...(next.unknowns || []), ...(incoming.unknowns || [])]);
  next.capabilities = capabilityList(next);
  return next;
}
