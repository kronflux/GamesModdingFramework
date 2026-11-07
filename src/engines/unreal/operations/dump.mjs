// unreal.dump: orchestrate UE4SS object, usmap and C++ header dumps without launching the game.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evidence } from "../../../core/evidence.mjs";
import { resolveAuthorization } from "../../../core/authorization.mjs";
import { backupFile } from "../../../core/workspace.mjs";
import { safeReaddir } from "../../../core/fsutil.mjs";
import { detectUe4ss, findBinariesDir } from "../detect.mjs";
import {
  copyTreeWithBackup,
  ensureInsideWorkspace,
  gmfError,
  isFile,
  resolveGameDirInput,
  slugify,
  walkFiles,
  workspaceRoot,
} from "./shared.mjs";
import { authorizationContext } from "./setup_ue4ss.mjs";
import { normalizeObjectDump } from "./normalize.mjs";
import { writeNormalizedDump } from "../../../operations/analyze/normalize.mjs";

const PLAIN_OBJECT_DUMP = "ue4ss_objectdump.txt";

// fileName is where unreal.dump collect writes the artifact under <workspace>/dumps.
const DUMP_SPECS = {
  objects: {
    fileName: "UE4SS_ObjectDump.txt",
    expected: /^UE4SS_ObjectDump.*\.txt$/i,
    command: "DumpAllObjects",
    instructions:
      "Run the game with UE4SS, open the UE4SS console and run DumpAllObjects. UE4SS writes the object dump beside the executable or in the configured dump directory.",
  },
  usmap: {
    fileName: "Mappings.usmap",
    expected: /\.usmap$/i,
    command: "DumpUSMAP",
    instructions:
      "Run the game with UE4SS, open the UE4SS console and run DumpUSMAP. Copy the generated .usmap into the workspace dumps folder.",
  },
  headers: {
    fileName: "CXXHeaderDump",
    expected: /^(CXXHeaderDump|Headers)$/i,
    command: "CXXHeaderGenerator",
    instructions:
      "Enable the UE4SS CXX header generator in UE4SS-settings.ini, set its dump directory, and start the game once. The generated headers stay under the workspace dumps folder.",
  },
};

const KIND_ALIASES = {
  object: "objects",
  objects: "objects",
  "object-dump": "objects",
  usmap: "usmap",
  mappings: "usmap",
  headers: "headers",
  header: "headers",
  cpp: "headers",
};

function normalizeKinds(kinds) {
  const source = Array.isArray(kinds) && kinds.length > 0 ? kinds : ["objects", "usmap", "headers"];
  const normalized = [];
  for (const kind of source) {
    const canonical = KIND_ALIASES[String(kind).toLowerCase()];
    if (!canonical) {
      throw gmfError(
        "GMF-E-PLAN-001",
        `Unknown dump kind: ${kind}`,
        "Use objects, usmap or headers.",
      );
    }
    if (!normalized.includes(canonical)) normalized.push(canonical);
  }
  return normalized;
}

// Where UE4SS writes dumps: its own folder, the folder of the executable, or the game folder.
function rootsFor(gameDir, loader) {
  return [...new Set([loader.path, findBinariesDir(gameDir), gameDir].filter(Boolean))];
}

// Dumps of one kind directly inside a root: files for objects and usmap, non-empty folders for headers.
// Detection and collection both read through this, so they agree on roots, names and the choice.
function dumpsIn(root, kind) {
  const spec = DUMP_SPECS[kind];
  const found = [];
  for (const entry of safeReaddir(root, { withFileTypes: true })) {
    if (!spec.expected.test(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (kind === "headers" ? !entry.isDirectory() || safeReaddir(full).length === 0 : !entry.isFile()) continue;
    let mtime = 0;
    try {
      mtime = fs.statSync(full).mtimeMs;
    } catch {
      // A dump that vanished is ranked last.
    }
    found.push({ name: entry.name, path: full, mtime });
  }
  return found;
}

// The plain UE4SS_ObjectDump.txt when present, otherwise the newest.
function chooseDump(candidates) {
  const plain = candidates.find((candidate) => candidate.name.toLowerCase() === PLAIN_OBJECT_DUMP);
  if (plain) return plain;
  return candidates.reduce((best, candidate) => (best && best.mtime >= candidate.mtime ? best : candidate), null);
}

// The first root that holds a dump of the kind decides, and the choice rule picks within it.
function findExistingDump(roots, kind) {
  for (const root of roots) {
    const chosen = chooseDump(dumpsIn(root, kind));
    if (chosen) return chosen.path;
  }
  return null;
}

const DUMPER_TEMPLATE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../templates/unreal/dumper",
);
const SETTINGS_FILE = "UE4SS-settings.ini";
const FRAGMENT_FILE = "UE4SS-settings.dumpers.ini";

function detectEol(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function parseFragment(fragment) {
  const entries = [];
  let section = null;
  for (const raw of fragment.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      section = header[1];
      continue;
    }
    const pair = line.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (pair && section) entries.push({ section, key: pair[1], value: pair[2] });
  }
  return entries;
}

// Merge the keys of an ini fragment into an existing ini. Only keys present in the fragment
// change. A key that is missing is appended at the end of its section, and a missing section
// is appended at the end of the file. Comments, order and the file's line endings are kept.
export function mergeIniKeys(existing, fragment) {
  const eol = detectEol(existing);
  const lines = existing.length === 0 ? [] : existing.replace(/(\r?\n)$/, "").split(/\r?\n/);
  for (const { section, key, value } of parseFragment(fragment)) {
    const wanted = `${key} = ${value}`;
    let start = -1;
    let end = lines.length;
    for (let i = 0; i < lines.length; i += 1) {
      const header = lines[i].trim().match(/^\[(.+)\]$/);
      if (!header) continue;
      if (start >= 0) {
        end = i;
        break;
      }
      if (header[1].toLowerCase() === section.toLowerCase()) start = i;
    }
    if (start < 0) {
      if (lines.length > 0 && lines[lines.length - 1].trim() !== "") lines.push("");
      lines.push(`[${section}]`, wanted);
      continue;
    }
    let found = -1;
    for (let i = start + 1; i < end; i += 1) {
      const pair = lines[i].match(/^\s*([^=;#\s][^=]*?)\s*=/);
      if (pair && pair[1].toLowerCase() === key.toLowerCase()) {
        found = i;
        break;
      }
    }
    if (found >= 0) {
      lines[found] = wanted;
      continue;
    }
    let at = end;
    while (at > start + 1 && lines[at - 1].trim() === "") at -= 1;
    lines.splice(at, 0, wanted);
  }
  return lines.length === 0 ? "" : lines.join(eol) + eol;
}

// Copy the GmfDumper mod and merge the settings fragment into UE4SS-settings.ini. The gameWrite
// gate runs first. Every overwritten file, the settings file included, is backed up into the
// workspace before it changes.
export function deployDumperHelper(context, loader) {
  const { plan, overrides } = authorizationContext(context);
  const authorization = resolveAuthorization({ effects: ["gameWrite"], plan, overrides });
  if (!authorization.allowed) {
    throw gmfError(
      "GMF-E-GATE-001",
      `GMF-E-GATE-001: deploying the dump helper writes into the game folder and needs a gameWrite authorization (${authorization.reason}).`,
      'Add a gameWrite authorization to the plan, or pass --authorized gameWrite --source "<user instruction>".',
    );
  }
  if (!context?.workspace?.root) {
    throw gmfError(
      "GMF-E-GATE-001",
      "GMF-E-GATE-001: deploying the dump helper needs a workspace so overwritten files can be backed up.",
      "Run gmf init first, or pass --workspace.",
    );
  }

  const pairs = walkFiles(DUMPER_TEMPLATE_DIR)
    .map((source) => ({ source, relative: path.relative(DUMPER_TEMPLATE_DIR, source) }))
    .filter((entry) => entry.relative !== "template.json" && entry.relative !== FRAGMENT_FILE)
    .map((entry) => ({ source: entry.source, target: path.join(loader.path, entry.relative) }));
  const deployed = copyTreeWithBackup(context, pairs);

  const settingsPath = path.join(loader.path, SETTINGS_FILE);
  const fragmentPath = path.join(DUMPER_TEMPLATE_DIR, FRAGMENT_FILE);
  const existed = fs.existsSync(settingsPath);
  const before = existed ? fs.readFileSync(settingsPath, "utf8") : "";
  const merged = mergeIniKeys(before, fs.readFileSync(fragmentPath, "utf8"));
  const settings = { source: fragmentPath, target: settingsPath, backup: null, sha256: null };
  if (merged !== before) {
    if (existed) {
      const backup = backupFile(context.workspace, settingsPath);
      settings.backup = backup.backupPath;
      settings.sha256 = backup.sha256;
    }
    fs.writeFileSync(settingsPath, merged);
  }
  deployed.push(settings);

  const backup = deployed
    .filter((entry) => entry.backup)
    .map((entry) => ({ target: entry.target, path: entry.backup, sha256: entry.sha256 }));
  return {
    deployed,
    backup,
    mod: path.join(loader.path, "Mods", "GmfDumper"),
    settings: settingsPath,
    authorization: { effect: "gameWrite", source: authorization.source },
  };
}

const HELPER_REPORT = "GmfDumper_report.txt";

// Copy the dumps UE4SS and GmfDumper wrote into the workspace dumps folder, then (unless normalize is
// false) normalize the chosen object dump to unreal-objects.json. roots are searched in order, like
// detection does, and the first root that has a file name wins; it defaults to the UE4SS folder.
// dumpsDir must be <workspace>/dumps.
export function collectDumpArtifacts(ue4ssDir, dumpsDir, { roots = [ue4ssDir], normalize = true } = {}) {
  if (path.basename(dumpsDir) !== "dumps") {
    throw gmfError("GMF-E-PLAN-001", `dumpsDir must be a folder named dumps: ${dumpsDir}`, "Pass <workspace>/dumps.");
  }
  fs.mkdirSync(dumpsDir, { recursive: true });
  const copied = [];
  const copyOne = (source, target) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    copied.push(target);
  };
  const taken = new Set();
  let headersCopied = false;
  for (const root of roots) {
    for (const kind of ["objects", "usmap"]) {
      for (const candidate of dumpsIn(root, kind)) {
        if (taken.has(candidate.name.toLowerCase())) continue;
        taken.add(candidate.name.toLowerCase());
        copyOne(candidate.path, path.join(dumpsDir, candidate.name));
      }
    }
    const report = path.join(root, HELPER_REPORT);
    if (!taken.has(HELPER_REPORT.toLowerCase()) && isFile(report)) {
      taken.add(HELPER_REPORT.toLowerCase());
      copyOne(report, path.join(dumpsDir, HELPER_REPORT));
    }
    const headers = headersCopied ? null : chooseDump(dumpsIn(root, "headers"));
    if (headers) {
      headersCopied = true;
      for (const file of walkFiles(headers.path)) copyOne(file, path.join(dumpsDir, DUMP_SPECS.headers.fileName, path.relative(headers.path, file)));
    }
  }
  let dump = null;
  const objectDump = findExistingDump(roots, "objects");
  if (normalize && objectDump) {
    const normalized = normalizeObjectDump(fs.readFileSync(path.join(dumpsDir, path.basename(objectDump)), "utf8"));
    dump = writeNormalizedDump(path.dirname(dumpsDir), "unreal-objects.json", normalized);
  }
  return { copied, dump };
}

export const dumpOperation = {
  id: "unreal.dump",
  title: "Dump Unreal objects, usmap and headers",
  summary:
    "Prepare the UE4SS dump layout in the workspace, detect existing object, usmap and header dumps, and return the exact console commands or settings for the missing ones. collect copies the dumps into dumps/ and normalizes the object dump unless normalize is false. With deployHelper set it also writes the GmfDumper mod into the game folder and then needs a gameWrite authorization; that gate is checked in the handler because the effect depends on the input.",
  engine: "unreal",
  inputs: {
    type: "object",
    properties: {
      gameDir: { type: "string" },
      kinds: { type: "array" },
      normalize: {
        type: "boolean",
        description: "When an object dump is found, write dumps/unreal-objects.json for the analyze operations. Default true.",
      },
      deployHelper: {
        type: "boolean",
        description: "Deploy the GmfDumper UE4SS mod and merge its settings keys. Needs a gameWrite authorization.",
      },
      collect: {
        type: "boolean",
        description: "Copy the object dump, usmap, header dump and GmfDumper report from the UE4SS folder into dumps/ and normalize the object dump.",
      },
    },
    required: [],
  },
  outputs: {
    type: "object",
    properties: {
      artifacts: { type: "array" },
      plan: { type: "string" },
      outputDir: { type: "string" },
      dump: { type: "string" },
      helper: { type: "object" },
      collected: { type: "object" },
    },
  },
  effects: ["read", "workspaceWrite"],
  requires: [],
  gates: ["auto"],
  skill: "unreal-dumping",
  docs: [],

  async handler(inputs, context = {}) {
    const gameDir = resolveGameDirInput(inputs, context);
    const kinds = normalizeKinds(inputs.kinds);

    const loader = detectUe4ss(gameDir);
    if (!loader.installed) {
      throw gmfError(
        "GMF-E-TOOL-001",
        "GMF-E-TOOL-001: UE4SS is required to dump Unreal objects, usmap data and headers.",
        "Run unreal.setup_ue4ss with an authorization for toolInstall first.",
      );
    }

    // The gate runs before any write, so a refused deploy leaves the workspace untouched too.
    const helper = inputs.deployHelper === true ? deployDumperHelper(context, loader) : null;

    const outputDir = ensureInsideWorkspace(
      context,
      path.join(workspaceRoot(context), "dumps", "unreal", slugify(path.basename(gameDir))),
      "dump output directory",
    );
    fs.mkdirSync(outputDir, { recursive: true });
    const dumpsDir = path.join(workspaceRoot(context), "dumps");
    const roots = rootsFor(gameDir, loader);

    const artifacts = kinds.map((kind) => {
      const spec = DUMP_SPECS[kind];
      const expectedPath = path.join(dumpsDir, spec.fileName);
      const found = findExistingDump(roots, kind);
      if (found) {
        return {
          kind,
          status: "found",
          path: found,
          expectedPath,
          command: spec.command,
        };
      }
      return {
        kind,
        status: "planned",
        path: null,
        expectedPath,
        command: spec.command,
        instructions: spec.instructions,
      };
    });

    const planPath = path.join(outputDir, "dump-plan.json");
    const plan = {
      version: 1,
      gameDir,
      ue4ss: loader.path,
      createdAt: new Date().toISOString(),
      kinds,
      artifacts,
      notes:
        kinds.includes("usmap") || kinds.includes("headers")
          ? ["The game is not launched by this operation; run UE4SS yourself and repeat unreal.dump to collect the artifacts."]
          : [],
    };
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);

    let dump = null;
    let collected = null;
    const normalize = inputs.normalize !== false && inputs.normalize !== "false";
    if (inputs.collect === true) {
      collected = collectDumpArtifacts(loader.path, dumpsDir, { roots, normalize });
      dump = collected.dump;
    }
    const objects = artifacts.find((artifact) => artifact.kind === "objects" && artifact.status === "found");
    if (!dump && objects && normalize) {
      const normalized = normalizeObjectDump(fs.readFileSync(objects.path, "utf8"));
      dump = writeNormalizedDump(workspaceRoot(context), "unreal-objects.json", normalized);
    }

    return {
      data: { artifacts, plan: planPath, outputDir, kinds, dump, helper, collected },
      authorization: helper ? helper.authorization : null,
      evidence: [
        evidence({
          claim: `UE4SS dump layout prepared at ${outputDir}.`,
          confidence: "observed",
          authority: "controlled-replay",
          source: planPath,
          detail: { kinds, ue4ss: loader.path },
        }),
      ],
    };
  },
};

// Gate mechanism: executeOperation does not read per-call effects, so each operation checks its own
// authorization. deployHelper is the one gameWrite path of unreal.dump, and it is also registered
// as its own operation so the catalog, plans and the CLI can declare and authorize gameWrite.
export const deployDumperOperation = {
  id: "unreal.deploy_dumper",
  title: "Deploy the GmfDumper UE4SS helper",
  summary:
    "Copy the GmfDumper mod and the shared UEHelpers module into the UE4SS Mods folder and merge the dumper keys into UE4SS-settings.ini. Every overwritten file is backed up first.",
  engine: "unreal",
  inputs: {
    type: "object",
    properties: {
      gameDir: { type: "string" },
    },
    required: [],
  },
  outputs: {
    type: "object",
    properties: {
      deployed: { type: "array" },
      backup: { type: "array" },
      mod: { type: "string" },
      settings: { type: "string" },
    },
  },
  effects: ["read", "workspaceWrite", "gameWrite"],
  requires: [],
  gates: ["soft"],
  skill: "unreal-dumping",
  docs: [],

  async handler(inputs, context = {}) {
    const gameDir = resolveGameDirInput(inputs, context);
    const loader = detectUe4ss(gameDir);
    if (!loader.installed) {
      throw gmfError(
        "GMF-E-TOOL-001",
        "GMF-E-TOOL-001: UE4SS is required to deploy the dump helper.",
        "Run unreal.setup_ue4ss with an authorization for toolInstall first.",
      );
    }
    const helper = deployDumperHelper(context, loader);
    return {
      data: { deployed: helper.deployed, backup: helper.backup, mod: helper.mod, settings: helper.settings },
      authorization: helper.authorization,
      evidence: [
        evidence({
          claim: `GmfDumper deployed to ${helper.mod}.`,
          confidence: "observed",
          authority: "controlled-replay",
          source: helper.mod,
          detail: { backups: helper.backup.length },
        }),
      ],
    };
  },
};

export default dumpOperation;
