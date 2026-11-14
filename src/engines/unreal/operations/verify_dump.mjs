// unreal.verify_dump: check a collected dump run against its own manifest.
//
// A run passes when manifest.json parses and has a finished time, no step failed,
// every skipped step gives a reason, every file the manifest lists exists with the
// recorded size, run_complete.json exists, and a full-profile run dumped every level.
// Folder entries (dir: true, or a count with no bytes) are checked for existence only.

import fs from "node:fs";
import path from "node:path";
import { gmfError, workspaceRoot } from "./shared.mjs";

// Written by unreal.build_docs when it removes the files its docs distilled.
export const PRUNED_FILE = "pruned.json";
export const PRUNED_SCHEMA = "gmf.pruned_run/1";

// The entries of pruned.json: run paths the docs build removed, folders ending in "/".
function prunedPaths(runDir) {
  try {
    const record = readJson(path.join(runDir, PRUNED_FILE));
    return record?.schema === PRUNED_SCHEMA && Array.isArray(record.removed) ? record.removed.map(String) : [];
  } catch {
    return [];
  }
}

function isPruned(relative, pruned) {
  return pruned.some((entry) => (entry.endsWith("/") ? relative === entry.slice(0, -1) || relative.startsWith(entry) : relative === entry));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function checkFile(stepId, entry, runDir, problems) {
  const relative = String(entry?.path ?? "");
  const target = path.join(runDir, ...relative.split("/"));
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    problems.push(`step ${stepId}: missing ${entry?.dir ? "folder" : "file"} ${relative}`);
    return;
  }
  const folderEntry = entry.dir === true || (entry.count !== undefined && entry.bytes === undefined);
  if (folderEntry) return;
  if (stat.isFile() && typeof entry.bytes === "number" && stat.size !== entry.bytes) {
    problems.push(`step ${stepId}: file ${relative} is ${stat.size} bytes; manifest says ${entry.bytes}`);
  }
}

export function verifyRun(runDir) {
  const problems = [];
  let manifest;
  try {
    manifest = readJson(path.join(runDir, "manifest.json"));
  } catch (error) {
    return { pass: false, problems: [`cannot read manifest.json: ${error.message}`] };
  }
  if (!manifest || typeof manifest !== "object") {
    return { pass: false, problems: ["cannot read manifest.json: not a JSON object"] };
  }
  const pruned = prunedPaths(runDir);
  if (!manifest.finished) problems.push("the run did not finish: manifest.json has no 'finished' time");

  for (const step of Array.isArray(manifest.steps) ? manifest.steps : []) {
    if (step.status === "failed") {
      problems.push(`step ${step.id}: failed: ${step.error ?? "no error recorded"}`);
      continue;
    }
    if (step.status === "pending") {
      problems.push(`step ${step.id}: did not run (pending)`);
      continue;
    }
    if (step.status === "running") {
      problems.push(`step ${step.id}: did not finish (running)`);
      continue;
    }
    if (step.status === "skipped" && !step.reason) {
      problems.push(`step ${step.id}: skipped with no reason`);
    }
    for (const entry of Array.isArray(step.files) ? step.files : []) {
      if (isPruned(String(entry?.path ?? ""), pruned)) continue;
      checkFile(step.id, entry, runDir, problems);
    }
  }

  let complete = null;
  try {
    complete = readJson(path.join(runDir, "run_complete.json"));
  } catch {
    problems.push("run_complete.json is missing or unreadable: the run did not end cleanly");
  }
  if (complete && complete.profile === "full" && complete.levels_ok !== complete.levels_total) {
    problems.push(`levels_ok is ${complete.levels_ok}, levels_total is ${complete.levels_total}`);
  }
  return { pass: problems.length === 0, problems };
}

function runsDir(context) {
  return path.join(workspaceRoot(context), "dumps", "unreal", "runs");
}

export function resolveRun(input, context) {
  const base = runsDir(context);
  if (input) {
    const dir = path.isAbsolute(input) ? input : path.join(base, input);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw gmfError("GMF-E-EXEC-001", `Run folder not found: ${dir}`, "Pass a run name under dumps/unreal/runs or an absolute path.");
    }
    return { name: path.basename(dir), dir };
  }
  let names = [];
  try {
    names = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // No runs folder: reported below.
  }
  if (names.length === 0) {
    throw gmfError("GMF-E-EXEC-001", `No collected runs under ${base}`, "Run unreal.dump with collect=true first, or pass an absolute run path.");
  }
  names.sort();
  const name = names[names.length - 1];
  return { name, dir: path.join(base, name) };
}

export const verifyDumpOperation = {
  id: "unreal.verify_dump",
  title: "Verify a dump run against its manifest",
  summary:
    "Check a collected dump run: finished manifest, no failed steps, skipped steps explained, every listed file present with its recorded size, run_complete.json present, all levels dumped for the full profile. Prints PASS or one line per problem.",
  engine: "unreal",
  inputs: {
    type: "object",
    properties: {
      run: { type: "string", description: "Run folder name under dumps/unreal/runs, or an absolute path. Default: the newest run by name." },
    },
    required: [],
  },
  outputs: {
    type: "object",
    properties: {
      run: { type: "string" },
      pass: { type: "boolean" },
      problems: { type: "array", items: { type: "string" } },
      text: { type: "string" },
    },
  },
  effects: ["read"],
  requires: [],
  gates: ["auto"],
  skill: "unreal-first-dump",
  docs: [],
  async handler(inputs = {}, context = {}) {
    const { name, dir } = resolveRun(inputs.run, context);
    const { pass, problems } = verifyRun(dir);
    return { data: { run: name, pass, problems, text: pass ? "PASS" : problems.join("\n") }, evidence: [] };
  },
};

export default verifyDumpOperation;
