import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gateFor } from "./contracts.mjs";
import { recordAuthorization } from "./authorization.mjs";
import { backupFile, readJson, writeJson } from "./workspace.mjs";
import { isInside } from "./fsutil.mjs";

const ANTI_CHEAT_KNOWLEDGE = "knowledge/core/anti-cheat.md";
const MANIFEST_FILE = "manifest.json";

const MARKERS = [
  {
    id: "easyanticheat",
    name: "Easy Anti-Cheat",
    names: ["easyanticheat", "easyanticheat_x64", "easyanticheat_x86", "easyanticheat_launcher", "start_protected_game"],
  },
  { id: "battleye", name: "BattlEye", names: ["battleye", "beservice", "battleye_launcher"] },
  { id: "vanguard", name: "Riot Vanguard", names: ["vgc", "vgk", "vanguard"] },
  { id: "gameguard", name: "nProtect GameGuard", names: ["gameguard", "npggnt", "gamemon", "npgg"] },
  { id: "xigncode", name: "XignCode3", names: ["xigncode", "xigncode3", "xmag"] },
  { id: "punkbuster", name: "PunkBuster", names: ["punkbuster", "pnkbstr", "pnkbstra", "pnkbstrb"] },
  { id: "denuvo", name: "Denuvo Anti-Tamper", names: ["denuvo"] },
  { id: "ricochet", name: "Ricochet", names: ["ricochet"] },
  { id: "fairfight", name: "FairFight", names: ["fairfight"] },
];

function codedError(code, message, remediation = "") {
  const error = new Error(message);
  error.code = code;
  error.remediation = remediation;
  return error;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function stemOf(name) {
  return path.basename(name).toLowerCase().replace(/\.[^.]+$/, "");
}

function markerFor(name) {
  const stem = stemOf(name);
  return MARKERS.find((marker) => marker.id === stem || marker.names.includes(stem)) || null;
}

// Walk the game folder and return one record per anti-cheat product found.
// A directory name counts as a marker as well as a file name so a service
// folder in a subfolder is detected without reading a binary.
export function detectAntiCheat(gameDir, { maxDepth = 6, maxEntries = 20000 } = {}) {
  if (!gameDir || !fs.existsSync(gameDir) || !fs.statSync(gameDir).isDirectory()) {
    throw codedError("GMF-E-GAME-001", `GMF-E-GAME-001: not a game directory: ${gameDir}`, "Pass the game install folder.");
  }

  const matches = new Map();
  let visited = 0;

  const inspect = (name, full) => {
    const marker = markerFor(name);
    if (!marker || matches.has(marker.id)) return;
    matches.set(marker.id, {
      id: marker.id,
      name: marker.name,
      path: full,
      relative: toPosix(path.relative(gameDir, full)),
    });
  };

  const walk = (dir, depth) => {
    if (depth > maxDepth || visited > maxEntries) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      visited += 1;
      if (visited > maxEntries) return;
      const full = path.join(dir, entry.name);
      inspect(entry.name, full);
      if (entry.isDirectory()) walk(full, depth + 1);
    }
  };

  walk(path.resolve(gameDir), 0);
  return [...matches.values()];
}

export function antiCheatWarning(markers = [], { source = null } = {}) {
  const ids = markers
    .map((marker) => (marker && typeof marker === "object" ? marker.id : marker))
    .filter((id) => typeof id === "string" && id.length > 0);
  return {
    code: "GMF-W-ANTICHEAT-001",
    message:
      ids.length > 0
        ? `GMF-W-ANTICHEAT-001: anti-cheat markers present (${ids.join(", ")}). Modding this game can lead to a flag or a ban, especially in online modes.`
        : "GMF-W-ANTICHEAT-001: anti-cheat interaction is a risk, not a block. Review the anti-cheat knowledge before deploying.",
    markers: ids,
    source: source || null,
    knowledge: ANTI_CHEAT_KNOWLEDGE,
  };
}

// Hard policy that no model-supplied source can satisfy. Credential access and
// piracy are always refused; destructive actions need explicit user approval;
// anti-cheat interactions only return a warning.
export function assertPolicy(effect, target = {}) {
  const info = typeof target === "string" ? { target } : target || {};

  if (effect === "piracy" || effect === "credentials") {
    throw codedError(
      "GMF-E-POLICY-001",
      `GMF-E-POLICY-001: ${effect} is always refused, regardless of authorization`,
      "The framework does not perform credential access, DRM circumvention or piracy.",
    );
  }

  if (effect === "destructive") {
    if (info.approved === true && info.approvedBy === "user") {
      return { ok: true, gate: "hard", approved: true };
    }
    throw codedError(
      "GMF-E-GATE-001",
      `GMF-E-GATE-001: destructive action requires explicit user approval for ${info.target || info.path || "this target"}`,
      "Ask the user to approve this exact operation and target; a model-supplied source cannot satisfy the gate.",
    );
  }

  if (effect === "antiCheat") {
    return {
      ok: true,
      gate: "soft",
      warning: antiCheatWarning(info.markers || [], { source: info.source || null }),
    };
  }

  return { ok: true, gate: gateFor([effect]) };
}

export function acknowledgeAntiCheat(workspace, { markers = [], source = "plan", operation = null, step = null } = {}) {
  const warning = antiCheatWarning(markers, { source });
  const record = {
    effect: "antiCheat",
    source: source || "plan",
    scope: step ? `step:${step}` : null,
    warning: warning.code,
    markers: warning.markers,
    operation: operation || null,
  };
  recordAuthorization(workspace, record);
  return record;
}

function manifestPath(workspace) {
  return path.join(workspace.root, "backups", MANIFEST_FILE);
}

function readManifest(workspace) {
  const data = readJson(manifestPath(workspace), null);
  if (!data || !Array.isArray(data.records)) return { version: 1, records: [] };
  return data;
}

export function createBackup(workspace, gamePath) {
  if (!workspace || !workspace.root) {
    throw codedError("GMF-E-WORKSPACE-001", "GMF-E-WORKSPACE-001: no workspace for the backup", "Run gmf init first.");
  }
  const source = path.resolve(gamePath);
  const copy = backupFile(workspace, source);
  const manifest = readManifest(workspace);
  const records = manifest.records.filter(
    (record) => !(path.resolve(record.source) === source && record.sha256 === copy.sha256),
  );
  records.push({
    source,
    backupPath: copy.backupPath,
    sha256: copy.sha256,
    size: fs.statSync(copy.backupPath).size,
    createdAt: new Date().toISOString(),
  });
  writeJson(manifestPath(workspace), { version: 1, records });
  return { source, backupPath: copy.backupPath, sha256: copy.sha256 };
}

export function restoreBackup(workspace, gamePath, { backupPath = null } = {}) {
  if (!workspace || !workspace.root) {
    throw codedError("GMF-E-WORKSPACE-001", "GMF-E-WORKSPACE-001: no workspace for the restore", "Run gmf init first.");
  }
  const source = path.resolve(gamePath);
  const manifest = readManifest(workspace);
  let record = null;

  if (backupPath) {
    const target = path.resolve(backupPath);
    record = manifest.records.find((entry) => path.resolve(entry.backupPath) === target) || null;
    if (!record) {
      throw codedError(
        "GMF-E-BACKUP-001",
        `GMF-E-BACKUP-001: backup not recorded in the manifest: ${target}`,
        "Pass a backup path listed in backups/manifest.json, or omit backupPath to use the latest recorded backup.",
      );
    }
    if (path.resolve(record.source) !== source) {
      throw codedError(
        "GMF-E-BACKUP-003",
        `GMF-E-BACKUP-003: backup ${target} belongs to ${record.source}, not ${source}`,
        "Restore a backup onto the file it was taken from.",
      );
    }
  } else {
    const matches = manifest.records.filter((entry) => path.resolve(entry.source) === source);
    record = matches[matches.length - 1] || null;
    if (!record) {
      throw codedError(
        "GMF-E-BACKUP-001",
        `GMF-E-BACKUP-001: no backup recorded for ${source}`,
        "Run generic.backup before overwriting a game file.",
      );
    }
  }

  if (!fs.existsSync(record.backupPath)) {
    throw codedError(
      "GMF-E-BACKUP-001",
      `GMF-E-BACKUP-001: the backup file is missing: ${record.backupPath}`,
      "The backup was moved or deleted. Do not overwrite the game file.",
    );
  }
  const backupsDir = path.join(workspace.root, "backups");
  if (!isInside(backupsDir, record.backupPath) || !/^[a-f0-9]{64}$/i.test(String(record.sha256 || ""))) {
    throw codedError(
      "GMF-E-BACKUP-001",
      `GMF-E-BACKUP-001: the manifest record for ${record.backupPath} is not a backup gmf took (no hash, or outside backups/)`,
      "Restore only backups recorded by gmf under the workspace backups folder.",
    );
  }

  const actual = sha256File(record.backupPath);
  if (actual !== record.sha256) {
    throw codedError(
      "GMF-E-BACKUP-002",
      `GMF-E-BACKUP-002: backup hash mismatch for ${record.backupPath}`,
      "The backup changed after it was recorded. Restore another backup.",
    );
  }

  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.copyFileSync(record.backupPath, source);
  return { path: source, backupPath: record.backupPath, sha256: actual, restored: true };
}

export { ANTI_CHEAT_KNOWLEDGE, MARKERS };
