// unreal.setup_ue4ss: install UE4SS into the game folder behind a soft gate.

import fs from "node:fs";
import path from "node:path";
import { activePlan, authorizationOverrides, resolveAuthorization } from "../../../core/authorization.mjs";
import { installTool } from "../../../core/tools.mjs";
import { evidence } from "../../../core/evidence.mjs";
import { detectUe4ss, findBinariesDir } from "../detect.mjs";
import { applyUe4ssProfile } from "./settings.mjs";
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
    let targetRoot;
    let copied;
    if (layout === "v3") {
      targetRoot = path.join(binaries, "ue4ss");
      copied = installTree(context, sourceRoot, binaries);
    } else {
      targetRoot = existing.path || path.join(binaries, "ue4ss");
      copied = installTree(context, sourceRoot, targetRoot);
    }
    fs.mkdirSync(path.join(targetRoot, "Mods"), { recursive: true });

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
