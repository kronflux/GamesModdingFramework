// unreal.setup_ue4ss: install UE4SS into the game folder behind a soft gate.

import fs from "node:fs";
import path from "node:path";
import { activePlan, authorizationOverrides, resolveAuthorization } from "../../../core/authorization.mjs";
import { installTool } from "../../../core/tools.mjs";
import { evidence } from "../../../core/evidence.mjs";
import { detectUe4ss, findBinariesDir } from "../detect.mjs";
import { applyUe4ssProfile } from "./settings.mjs";
import { mergeIniKeys, parseIniEntries } from "./dump.mjs";
import {
  copyTreeWithBackup,
  gmfError,
  isDirectory,
  resolveGameDirInput,
  toolCacheFrom,
  walkFiles,
} from "./shared.mjs";

export const EFFECTS = ["read", "network", "toolInstall", "gameWrite"];

// The catalog pins the ue4ss tool to this release tag, so it is the only channel that can be installed.
const UE4SS_CHANNEL = "experimental-latest";

const INSTALL_RECORD = "gmf-install.json";
const SETTINGS_FILE = "UE4SS-settings.ini";
const INSTALL_SCHEMA = "gmf.ue4ss_install/1";

// The record of the release installed into a UE4SS folder, or null when it is missing, unreadable or not ours.
export function readUe4ssInstall(ue4ssDir) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(ue4ssDir, INSTALL_RECORD), "utf8"));
    return record && record.schema === INSTALL_SCHEMA ? record : null;
  } catch {
    return null;
  }
}

// The registry reports a published digest as "sha256:<hex>" and a pinned or recorded one as bare hex.
function digestOf(verification) {
  const value = typeof verification?.value === "string" ? verification.value : "";
  if (/^sha256:[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  if (["sha256", "recorded-sha256"].includes(verification?.kind) && /^[0-9a-f]{64}$/i.test(value)) {
    return `sha256:${value.toLowerCase()}`;
  }
  return null;
}

export function authorizationContext(context) {
  return { plan: context?.plan || activePlan(context || {}), overrides: authorizationOverrides(context || {}) };
}

// The user's UE4SS-settings.ini values that an update would reset: every key of the old file
// that the new file also has, with a different value, is written back. Keys the new release
// dropped are not brought back. Returns the text to write and the "Section.Key" names kept.
export function keepUserSettings(newText, oldText) {
  const fresh = new Map(parseIniEntries(newText).map((e) => [`${e.section}.${e.key}`.toLowerCase(), e.value]));
  const kept = parseIniEntries(oldText).filter((e) => {
    const value = fresh.get(`${e.section}.${e.key}`.toLowerCase());
    return value !== undefined && value !== e.value;
  });
  const fragment = kept.map((e) => `[${e.section}]\n${e.key} = ${e.value}\n`).join("");
  return { text: kept.length ? mergeIniKeys(newText, fragment) : newText, kept: kept.map((e) => `${e.section}.${e.key}`) };
}

const MOD_LINE = /^\s*([^:;#\s][^:]*?)\s*:\s*([01])\s*$/;

// The user's mods.txt choices that an update would reset: a mod the new file lists keeps the old
// 0 or 1, and a mod only the old file lists is added above the built-in Keybinds line.
export function keepModStates(newText, oldText) {
  const eol = newText.includes("\r\n") ? "\r\n" : "\n";
  const lines = newText.replace(/(\r?\n)$/, "").split(/\r?\n/);
  const old = new Map();
  for (const line of oldText.split(/\r?\n/)) {
    const match = MOD_LINE.exec(line);
    if (match) old.set(match[1].toLowerCase(), { name: match[1], state: match[2] });
  }
  const seen = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    const match = MOD_LINE.exec(lines[i]);
    if (!match) continue;
    const key = match[1].toLowerCase();
    seen.add(key);
    if (old.has(key) && old.get(key).state !== match[2]) lines[i] = `${match[1]} : ${old.get(key).state}`;
  }
  const added = [...old.entries()].filter(([key]) => !seen.has(key)).map(([, mod]) => `${mod.name} : ${mod.state}`);
  if (added.length) {
    let at = lines.findIndex((line) => /^\s*;\s*Built-in keybinds/i.test(line) || /^\s*Keybinds\s*:/i.test(line));
    if (at < 0) at = lines.length;
    lines.splice(at, 0, ...added);
  }
  return lines.join(eol) + eol;
}

// Reads the files an update must not reset, before the new release is copied over them.
function readUserFiles(targetRoot) {
  const read = (name) => {
    try {
      return fs.readFileSync(path.join(targetRoot, name), "utf8");
    } catch {
      return null;
    }
  };
  return { settings: read(SETTINGS_FILE), mods: read(path.join("Mods", "mods.txt")) };
}

// Writes the user's values back over the files the new release brought. The release files were
// backed up by the copy, so the backups hold the user's own versions.
function restoreUserFiles(targetRoot, saved) {
  const result = { keptSettings: [], keptMods: false };
  const settingsPath = path.join(targetRoot, SETTINGS_FILE);
  if (saved.settings !== null && fs.existsSync(settingsPath)) {
    const { text, kept } = keepUserSettings(fs.readFileSync(settingsPath, "utf8"), saved.settings);
    if (kept.length) fs.writeFileSync(settingsPath, text);
    result.keptSettings = kept;
  }
  const modsPath = path.join(targetRoot, "Mods", "mods.txt");
  if (saved.mods !== null && fs.existsSync(modsPath)) {
    const current = fs.readFileSync(modsPath, "utf8");
    const text = keepModStates(current, saved.mods);
    if (text !== current) {
      fs.writeFileSync(modsPath, text);
      result.keptMods = true;
    }
  }
  return result;
}

function installTree(context, sourceDir, targetDir) {
  const pairs = walkFiles(sourceDir)
    .map((source) => ({ source, relative: path.relative(sourceDir, source) }))
    .filter((entry) => entry.relative)
    .map((entry) => ({ source: entry.source, target: path.join(targetDir, entry.relative) }));
  return copyTreeWithBackup(context, pairs);
}

export const setupUe4ssOperation = {
  id: "unreal.setup_ue4ss",
  title: "Set up UE4SS",
  summary:
    "Install UE4SS from the tool registry into the game folder with a soft gate, record its version and verify the loader layout.",
  engine: "unreal",
  inputs: {
    type: "object",
    properties: {
      gameDir: { type: "string" },
      channel: { type: "string", description: "Only experimental-latest, the release the catalog pins, can be installed. Default experimental-latest." },
      development: {
        type: "boolean",
        description: "Apply the development settings profile (UE4SS debug console and GUI on and visible). Default true.",
      },
    },
    required: [],
  },
  outputs: {
    type: "object",
    properties: {
      version: { type: ["string", "null"] },
      path: { type: "string" },
      channel: { type: "string" },
    },
  },
  effects: EFFECTS,
  requires: [],
  gates: ["soft"],
  skill: "unreal-ue4ss-lua",
  docs: [],

  async handler(inputs, context = {}) {
    const gameDir = resolveGameDirInput(inputs, context);
    const channel = inputs.channel || UE4SS_CHANNEL;
    if (channel !== UE4SS_CHANNEL) {
      throw gmfError(
        "GMF-E-PLAN-001",
        `Unsupported UE4SS channel: ${channel}. The catalog installs ${UE4SS_CHANNEL} only.`,
        `Omit the channel input or pass channel=${UE4SS_CHANNEL}.`,
      );
    }

    const { plan, overrides } = authorizationContext(context);
    const authorization = resolveAuthorization({ effects: EFFECTS, plan, overrides });
    if (!authorization.allowed) {
      const missing = (authorization.missing || ["toolInstall", "gameWrite"]).join(",");
      throw gmfError(
        "GMF-E-GATE-001",
        `GMF-E-GATE-001: unreal.setup_ue4ss downloads UE4SS and writes into the game folder; it needs an authorization for ${missing}.`,
        `Add the authorizations to the plan, or pass --authorized ${missing} --source "<user instruction>".`,
      );
    }

    const catalog = context.catalog || { version: 1, tools: [] };
    if (!(catalog.tools || []).some((tool) => tool.id === "ue4ss")) {
      throw gmfError(
        "GMF-E-TOOL-001",
        "GMF-E-TOOL-001: the ue4ss tool is not registered in the catalog.",
        "Add a ue4ss entry to catalog/tools.json.",
      );
    }
    const installed = await installTool("ue4ss", {
      authorized: true,
      source: authorization.source || "unreal.setup_ue4ss",
      catalog,
      cacheDir: toolCacheFrom(context),
      fetchImpl: context.fetchImpl || globalThis.fetch,
    });

    const existing = detectUe4ss(gameDir);
    const binaries = findBinariesDir(gameDir) || gameDir;
    const sourceRoot = path.dirname(installed.path);
    if (!isDirectory(sourceRoot)) {
      throw gmfError("GMF-E-TOOL-001", `UE4SS installation is not a directory: ${sourceRoot}`, "Reinstall ue4ss.");
    }

    // UE4SS 3.x archives hold dwmapi.dll (the proxy the game loads) beside a
    // ue4ss/ folder; both must sit next to the shipping executable. Older
    // archives hold UE4SS.dll at their root and install into <Binaries>/ue4ss.
    const layout = isDirectory(path.join(sourceRoot, "ue4ss")) ? "v3" : "flat";
    const targetRoot = layout === "v3" ? path.join(binaries, "ue4ss") : existing.path || path.join(binaries, "ue4ss");
    const saved = readUserFiles(targetRoot);
    const copied = installTree(context, sourceRoot, layout === "v3" ? binaries : targetRoot);
    fs.mkdirSync(path.join(targetRoot, "Mods"), { recursive: true });
    // An update keeps the user's settings and mod choices; the release only adds what is new.
    const userFiles = restoreUserFiles(targetRoot, saved);

    // During mod development the UE4SS console and GUI should be visible.
    let settingsProfile = null;
    if (inputs.development !== false) {
      applyUe4ssProfile(context, targetRoot, "development");
      settingsProfile = "development";
    }

    fs.writeFileSync(
      path.join(targetRoot, INSTALL_RECORD),
      `${JSON.stringify(
        {
          schema: INSTALL_SCHEMA,
          asset: `${installed.version}.zip`,
          digest: digestOf(installed.verification),
          installed_at: new Date().toISOString(),
        },
        null,
        2,
      )}
`,
    );

    const dllTarget = layout === "v3" ? path.join(binaries, path.basename(installed.path)) : path.join(targetRoot, path.basename(installed.path));
    if (!fs.existsSync(dllTarget) && fs.existsSync(installed.path)) {
      fs.copyFileSync(installed.path, dllTarget);
    }

    return {
      data: {
        version: installed.version,
        path: targetRoot,
        channel,
        verification: installed.verification,
        mode: existing.installed ? "updated" : "installed",
        layout,
        settingsProfile,
        keptSettings: userFiles.keptSettings,
        keptModStates: userFiles.keptMods,
        release: installed.release || null,
        backups: copied.filter((record) => record && record.backup).map((record) => record.backup),
        files: copied.length,
      },
      evidence: [
        evidence({
          claim: `UE4SS ${installed.version} is installed at ${targetRoot}.`,
          confidence: "observed",
          authority: "controlled-replay",
          source: dllTarget,
          detail: { operation: "unreal.setup_ue4ss", channel, verification: installed.verification },
        }),
      ],
      authorization: { effect: "toolInstall", source: authorization.source || "unreal.setup_ue4ss" },
    };
  },
};

export default setupUe4ssOperation;
