// unreal.ue4ss_settings: apply a development or release profile to UE4SS-settings.ini.
//
// During development the UE4SS debug console and its GUI should be on and
// visible, so script errors and dumps are seen as they happen. The development
// profile sets ConsoleEnabled, GuiConsoleEnabled and GuiConsoleVisible to 1; the
// release profile turns them off.

import fs from "node:fs";
import path from "node:path";
import { resolveAuthorization } from "../../../core/authorization.mjs";
import { backupFile } from "../../../core/workspace.mjs";
import { evidence } from "../../../core/evidence.mjs";
import { detectUe4ss } from "../detect.mjs";
import { gmfError, resolveGameDirInput } from "./shared.mjs";
import { mergeIniKeys } from "./dump.mjs";
import { authorizationContext } from "./setup_ue4ss.mjs";

export const UE4SS_PROFILES = Object.freeze({
  development: Object.freeze({ Debug: Object.freeze({ ConsoleEnabled: 1, GuiConsoleEnabled: 1, GuiConsoleVisible: 1 }) }),
  release: Object.freeze({ Debug: Object.freeze({ ConsoleEnabled: 0, GuiConsoleEnabled: 0, GuiConsoleVisible: 0 }) }),
});

export const SETTINGS_FILE = "UE4SS-settings.ini";

// Only the profiles defined above count; inherited object keys such as "constructor" do not.
function assertProfile(profile) {
  if (typeof profile !== "string" || !Object.hasOwn(UE4SS_PROFILES, profile)) {
    throw gmfError("GMF-E-PLAN-001", `Unknown UE4SS settings profile: ${profile}`, "Use development or release.");
  }
}

function fragmentFor(profile) {
  const lines = [];
  for (const [section, keys] of Object.entries(UE4SS_PROFILES[profile])) {
    lines.push(`[${section}]`);
    for (const [key, value] of Object.entries(keys)) lines.push(`${key} = ${value}`);
  }
  return `${lines.join("\n")}\n`;
}

// Merge a profile into the ini under ue4ssDir, backing the original up first.
// The caller owns the authorization check. Returns the backup path or null.
export function applyUe4ssProfile(context, ue4ssDir, profile) {
  assertProfile(profile);
  const settingsPath = path.join(ue4ssDir, SETTINGS_FILE);
  const existed = fs.existsSync(settingsPath);
  const before = existed ? fs.readFileSync(settingsPath, "utf8") : "";
  const merged = mergeIniKeys(before, fragmentFor(profile));
  let backup = null;
  if (merged !== before) {
    if (existed) {
      if (!context?.workspace?.root) {
        throw gmfError(
          "GMF-E-GATE-001",
          `GMF-E-GATE-001: refusing to change ${settingsPath} without a workspace backup.`,
          "Run gmf init first so the original can be backed up.",
        );
      }
      backup = backupFile(context.workspace, settingsPath).backupPath;
    }
    fs.writeFileSync(settingsPath, merged);
  }
  return { settingsPath, backup, changed: merged !== before };
}

export const ue4ssSettingsOperation = {
  id: "unreal.ue4ss_settings",
  title: "Apply a UE4SS settings profile",
  summary:
    "Set the UE4SS debug console keys in UE4SS-settings.ini: the development profile turns ConsoleEnabled, GuiConsoleEnabled and GuiConsoleVisible on, the release profile turns them off. Backs up the ini first.",
  engine: "unreal",
  inputs: {
    type: "object",
    properties: {
      gameDir: { type: "string" },
      profile: { type: "string", description: "development or release. Default: development." },
    },
    required: [],
  },
  outputs: {
    type: "object",
    properties: {
      profile: { type: "string" },
      settings: { type: "string" },
      backup: { type: ["string", "null"] },
      changed: { type: "boolean" },
    },
  },
  effects: ["read", "workspaceWrite", "gameWrite"],
  requires: ["ue4ss"],
  gates: ["soft"],
  skill: "unreal-debugging",
  docs: ["knowledge/unreal/ue4ss-install-config.md"],
  async handler(inputs, context = {}) {
    const profile = inputs.profile || "development";
    assertProfile(profile);
    const gameDir = resolveGameDirInput(inputs, context);
    const { plan, overrides } = authorizationContext(context);
    const authorization = resolveAuthorization({ effects: ["gameWrite"], plan, overrides });
    if (!authorization.allowed) {
      throw gmfError(
        "GMF-E-GATE-001",
        "GMF-E-GATE-001: changing UE4SS-settings.ini writes into the game folder and needs a gameWrite authorization.",
        'Add a gameWrite authorization to the plan, or pass --authorized gameWrite --source "<user instruction>".',
      );
    }
    const loader = detectUe4ss(gameDir);
    if (!loader.installed || !loader.path) {
      throw gmfError("GMF-E-TOOL-001", "GMF-E-TOOL-001: UE4SS is not installed in this game.", "Run unreal.setup_ue4ss first.");
    }
    const result = applyUe4ssProfile(context, loader.path, profile);
    return {
      data: { profile, settings: result.settingsPath, backup: result.backup, changed: result.changed },
      evidence: [
        evidence({
          claim: `UE4SS-settings.ini uses the ${profile} debug console profile.`,
          confidence: "observed",
          authority: "controlled-replay",
          source: result.settingsPath,
          detail: { profile, keys: UE4SS_PROFILES[profile] },
        }),
      ],
      authorization: { effect: "gameWrite", source: authorization.source },
    };
  },
};

export default ue4ssSettingsOperation;
