// unreal.run_dump: start the game once with GmfDumper deployed, wait for the run to end, and report how.
// The operation never stops, kills or signals a process; it only starts the game and watches.

import fs from "node:fs";
import path from "node:path";
import { evidence } from "../../../core/evidence.mjs";
import { backupFile } from "../../../core/workspace.mjs";
import * as coreProcesses from "../../../core/processes.mjs";
import { safeReaddir } from "../../../core/fsutil.mjs";
import { detectStore } from "../../../core/profile.mjs";
import { detectUe4ss, findBinariesDir, findShippingExe } from "../detect.mjs";
import { gmfError, resolveGameDirInput, workspaceRoot } from "./shared.mjs";
import { collectRun, listRuns } from "./dump.mjs";

const POLL_MS = 2000;
const LOG_TAIL_LINES = 40;
const PROFILES = ["full", "quick"];

const defaultClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// The text of Mods/GmfDumper/config.lua: automatic run on, the chosen profile, input frozen, the level
// dump on and the map tour off. Only keys that the mod's config loader knows are written.
export function renderConfig({ profile = "full", quitWhenDone = true } = {}) {
  const chosen = PROFILES.includes(profile) ? profile : "full";
  return [
    "-- Written by unreal.run_dump. Delete this file to get the defaults back.",
    "return {",
    `    auto_run = { mode = "once", freeze_input = true, quit_when_done = ${quitWhenDone === false ? "false" : "true"} },`,
    `    default_profile = "${chosen}",`,
    "    levels = { enabled = true },",
    "    map_tour = { enabled = false },",
    "}",
    "",
  ].join("\n");
}

function readJsonObject(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function lastLines(file, count) {
  try {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-count).join("\n");
  } catch {
    return null;
  }
}

// Crash dumps appear in the UE4SS folder and may appear beside the executable.
function crashDumps(dirs) {
  const found = [];
  for (const dir of dirs) {
    for (const entry of safeReaddir(dir, { withFileTypes: true })) {
      if (entry.isFile() && /^crash_.*\.dmp$/i.test(entry.name)) found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

// Failed and skipped steps of one run's manifest.json, with the reason the mod recorded.
function manifestReasons(runDir) {
  const manifest = readJsonObject(path.join(runDir, "manifest.json"));
  const steps = Array.isArray(manifest?.steps) ? manifest.steps : [];
  return steps
    .filter((step) => step && (step.status === "failed" || step.status === "skipped"))
    .map((step) => ({ id: step.id, status: step.status, reason: step.reason ?? step.error ?? null }));
}

export const runDumpOperation = {
  id: "unreal.run_dump",
  title: "Start the game once and dump it with GmfDumper",
  summary:
    "Write Mods/GmfDumper/config.lua for an automatic run, remove the once-only marker, start the game (through Steam when the app id is known, otherwise the executable) and wait for the run. status is complete (the run is collected into dumps/unreal/runs/), empty (the mod produced nothing; manifestReasons says why), crashed (a new crash dump), exited (the game closed without finishing; logTail holds the log), or running (waitMinutes passed; call unreal.dump with collect=true later). It never stops the game. It refuses when the dumper is not deployed or the game is already running.",
  engine: "unreal",
  inputs: {
    type: "object",
    properties: {
      gameDir: { type: "string" },
      profile: { type: "string", description: "full (default) or quick." },
      quitWhenDone: { type: "boolean", description: "Close the game when the run has finished. Default true." },
      waitMinutes: { type: "number", description: "How long to wait for the run before returning status running. Default 10." },
    },
    required: [],
  },
  outputs: {
    type: "object",
    properties: {
      status: { type: "string" },
      run: { type: "string" },
      collected: { type: "object" },
      manifestReasons: { type: "array" },
      crashDump: { type: "string" },
      logTail: { type: "string" },
      advice: { type: "string" },
      launch: { type: "object" },
    },
  },
  effects: ["read", "workspaceWrite", "gameWrite", "launchGame"],
  requires: [],
  gates: ["soft"],
  skill: "unreal-first-dump",
  docs: [],

  async handler(inputs = {}, context = {}) {
    const gameDir = resolveGameDirInput(inputs, context);
    const profileName = inputs.profile === undefined ? "full" : inputs.profile;
    if (!PROFILES.includes(profileName)) {
      throw gmfError("GMF-E-PLAN-001", `Unknown profile: ${profileName}`, "Use full or quick.");
    }
    const quitWhenDone = inputs.quitWhenDone !== false && inputs.quitWhenDone !== "false";
    const waitMinutes = Number.isFinite(Number(inputs.waitMinutes)) && Number(inputs.waitMinutes) >= 0 ? Number(inputs.waitMinutes) : 10;
    const processes = context.processes || coreProcesses;
    const clock = context.clock || defaultClock;

    const loader = detectUe4ss(gameDir);
    const modDir = loader.installed ? path.join(loader.path, "Mods", "GmfDumper") : null;
    if (!modDir || !fs.existsSync(path.join(modDir, "Scripts", "main.lua"))) {
      throw gmfError(
        "GMF-E-TOOL-001",
        "GMF-E-TOOL-001: UE4SS with the GmfDumper mod is required to run a dump.",
        "Run unreal.deploy_dumper first (after unreal.setup_ue4ss if UE4SS is missing).",
      );
    }
    if (!context?.workspace?.root) {
      throw gmfError(
        "GMF-E-GATE-001",
        "GMF-E-GATE-001: running the dump needs a workspace so the old config.lua can be backed up.",
        "Run gmf init first, or pass --workspace.",
      );
    }
    const exe = findShippingExe(gameDir);
    if (!exe) {
      throw gmfError("GMF-E-PLAN-001", `No game executable found under ${gameDir}.`, "Pass the game folder that holds Binaries/<platform>.");
    }
    if (await processes.isExecutableRunning(exe)) {
      throw gmfError(
        "GMF-E-PLAN-001",
        `GMF-E-PLAN-001: the game is already running (${path.basename(exe)}); close the game first.`,
        "Close the game yourself, then call unreal.run_dump again. This operation never stops the game.",
      );
    }

    // Configuration and marker, then the snapshot the new run is measured against.
    const configPath = path.join(modDir, "config.lua");
    if (fs.existsSync(configPath)) backupFile(context.workspace, configPath);
    fs.writeFileSync(configPath, renderConfig({ profile: profileName, quitWhenDone }));
    fs.rmSync(path.join(modDir, "auto_run_done.txt"), { force: true });
    const crashDirs = [...new Set([loader.path, findBinariesDir(gameDir)].filter(Boolean))];
    const knownRuns = new Set(listRuns(loader.path).map((run) => run.name));
    const knownCrashes = new Set(crashDumps(crashDirs));

    // The app id comes from files in the game folder, so only a plain number is sent to Steam.
    const found = context.profile?.store?.appId || context.workspace?.profile?.store?.appId || detectStore(gameDir).appId || null;
    const appId = /^[0-9]{1,12}$/.test(String(found ?? "")) ? String(found) : null;
    let launch;
    try {
      if (appId) {
        launch = { method: "steam", target: `steam://rungameid/${appId}` };
        await processes.openUrl(launch.target);
      } else {
        launch = { method: "exe", target: exe };
        await processes.launchDetached(exe, [], { cwd: path.dirname(exe) });
      }
    } catch (error) {
      throw gmfError(
        "GMF-E-EXEC-001",
        `GMF-E-EXEC-001: the game could not be started (${launch.method}: ${launch.target}): ${error.message}`,
        "Start the game yourself; GmfDumper runs by itself. Then call unreal.dump with collect=true.",
      );
    }

    const deadline = clock.now() + waitMinutes * 60_000;
    let seenRunning = false;
    let missing = 0;
    for (;;) {
      const fresh = listRuns(loader.path).filter((run) => !knownRuns.has(run.name));
      const done = fresh.find((run) => run.complete);
      if (done) {
        const summary = readJsonObject(path.join(done.path, "run_complete.json"));
        if (summary.produced === true) {
          const collected = collectRun(loader.path, workspaceRoot(context), { run: done.name });
          return finish("complete", launch, { run: done.name, collected });
        }
        return finish("empty", launch, { run: done.name, manifestReasons: manifestReasons(done.path) });
      }

      const crash = crashDumps(crashDirs).find((file) => !knownCrashes.has(file));
      if (crash) return finish("crashed", launch, { crashDump: crash });

      if (await processes.isExecutableRunning(exe)) {
        seenRunning = true;
        missing = 0;
      } else if (seenRunning) {
        missing += 1;
        if (missing >= 2) {
          const newest = fresh[0];
          const tail =
            (newest && lastLines(path.join(newest.path, "gmfdumper.log"), LOG_TAIL_LINES)) ??
            lastLines(path.join(loader.path, "UE4SS.log"), LOG_TAIL_LINES);
          return finish("exited", launch, { logTail: tail ?? "" });
        }
      }

      if (clock.now() >= deadline) {
        return finish("running", launch, {
          advice: "The run has not finished yet. Call unreal.dump with collect=true later to collect it when it is complete.",
        });
      }
      await clock.sleep(POLL_MS);
    }

    function finish(status, launchInfo, fields) {
      return {
        data: { status, ...fields, launch: launchInfo },
        evidence: [
          evidence({
            claim: `unreal.run_dump ended with status ${status}.`,
            confidence: "observed",
            authority: "controlled-replay",
            source: modDir,
            detail: { status, launch: launchInfo.method },
          }),
        ],
      };
    }
  },
};

export default runDumpOperation;
