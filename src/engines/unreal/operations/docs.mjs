// unreal.build_docs: turn one collected GmfDumper run, plus the text read from the paks, into
// Markdown under <workspace>/gamedocs.
//
// Replacing a folder is destructive, so the output is confined: it must be a folder below the
// workspace, and an existing folder is replaced only when it carries the marker file of an
// earlier build. The new docs are built beside the target and moved into place by renaming, so
// a failed build or a failed move leaves the previous docs in place.

import fs from "node:fs";
import path from "node:path";
import { evidence } from "../../../core/evidence.mjs";
import { isInside } from "../../../core/fsutil.mjs";
import { buildDocs, DISTILLED } from "../docs/build.mjs";
import { gmfError, workspaceRoot } from "./shared.mjs";
import { PRUNED_FILE, PRUNED_SCHEMA, resolveRun, verifyRun } from "./verify_dump.mjs";

const MARKER = ".gmfdocs";
const MARKER_SCHEMA = "gmf.docs/1";
const BUILDING_SUFFIX = ".building";
const OLD_SUFFIX = ".old";
const MAX_LISTED_LINKS = 50;

// The docs folder for `outputDir`: a folder below the workspace root, never the root itself.
export function resolveDocsDir(root, outputDir) {
  const base = path.resolve(root);
  const target = path.resolve(base, String(outputDir ?? ""));
  if (target === base || !isInside(base, target)) {
    throw gmfError(
      "GMF-E-PLAN-001",
      `The docs folder must be a folder inside the workspace: ${target}`,
      "Pass an outputDir below the workspace, such as gamedocs.",
    );
  }
  return target;
}

// What is at `dir`: nothing, an empty folder, an earlier docs build, someone else's folder, or a file.
function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// The game executable for the console section: the input, then the executable the run recorded,
// then the profile's. Null when none of them is a file; the section then reports it missing.
export function findGameExe(inputs, runDir, context) {
  let recorded = null;
  try {
    recorded = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"))?.game_exe ?? null;
  } catch {
    // An unreadable manifest fails the build elsewhere.
  }
  const candidates = [
    inputs.gameExe,
    recorded,
    context?.workspace?.profile?.paths?.executable,
    context?.profile?.paths?.executable,
  ];
  return candidates.find((file) => typeof file === "string" && file && isFile(file)) ?? null;
}

function sizeOf(target) {
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of fs.readdirSync(target)) total += sizeOf(path.join(target, entry));
  return total;
}

// Removes the files the docs distilled from a collected run, and records them in pruned.json.
// Only a run under the workspace runs folder is pruned, only when it passed verification before
// the build, and only when no section was missing, so nothing a page needed is lost.
export function pruneRun(runDir, runsRoot, { verified, missing, docs }) {
  if (!isInside(path.resolve(runsRoot), path.resolve(runDir))) return { done: false, reason: "the run is not in dumps/unreal/runs" };
  if (!verified.pass) return { done: false, reason: `the run did not pass verification: ${verified.problems[0]}` };
  if (missing.length) return { done: false, reason: `sections are missing: ${missing.map((entry) => entry.name).join(", ")}` };
  const removed = [];
  let bytes = 0;
  for (const entry of DISTILLED) {
    const target = path.join(runDir, ...entry.split("/").filter(Boolean));
    if (!fs.existsSync(target)) continue;
    bytes += sizeOf(target);
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(entry);
    // A folder the removal left empty goes too, up to the run folder.
    for (let parent = path.dirname(target); parent !== runDir && isInside(runDir, parent); parent = path.dirname(parent)) {
      if (fs.readdirSync(parent).length > 0) break;
      fs.rmdirSync(parent);
    }
  }
  fs.writeFileSync(
    path.join(runDir, PRUNED_FILE),
    `${JSON.stringify({ schema: PRUNED_SCHEMA, pruned_at: new Date().toISOString(), docs, bytes, removed }, null, 2)}\n`,
  );
  return { done: true, removed, bytes };
}

function stateOf(dir, fsx) {
  let stat;
  try {
    stat = fsx.statSync(dir);
  } catch {
    return "absent";
  }
  if (!stat.isDirectory()) return "file";
  const names = fsx.readdirSync(dir);
  if (names.length === 0) return "empty";
  return names.includes(MARKER) ? "ours" : "foreign";
}

// A path may be replaced when it is absent, an empty folder, or an earlier docs build.
function assertReplaceable(dir, fsx) {
  const state = stateOf(dir, fsx);
  if (state === "file") {
    throw gmfError("GMF-E-PLAN-001", `${dir} is not a folder, so it is not replaced.`, "Choose another outputDir.");
  }
  if (state === "foreign") {
    throw gmfError(
      "GMF-E-PLAN-001",
      `${dir} is not a docs build: it has files and no ${MARKER} marker, so it is not replaced.`,
      "Choose another outputDir, or empty the folder yourself.",
    );
  }
}

// Puts the finished build at `target` by renaming, so the previous docs are never deleted before
// the new ones are in place. When the move fails, the previous docs are put back.
function swapIn(target, building, old, fsx) {
  const had = stateOf(target, fsx) !== "absent";
  try {
    if (had) fsx.renameSync(target, old);
    try {
      fsx.renameSync(building, target);
    } catch (error) {
      if (had) fsx.renameSync(old, target);
      throw error;
    }
  } catch (error) {
    fsx.rmSync(building, { recursive: true, force: true });
    throw gmfError(
      "GMF-E-EXEC-001",
      `The new docs could not be moved into place (${error.message}). The previous docs are unchanged.`,
      "Close programs that have the docs folder open, then run unreal.build_docs again.",
    );
  }
  try {
    fsx.rmSync(old, { recursive: true, force: true });
  } catch {
    // The old build carries its marker, so the next call removes it.
  }
}

export const buildDocsOperation = {
  id: "unreal.build_docs",
  title: "Build the game docs from a dump run",
  summary:
    "Write Markdown docs for a collected GmfDumper run into gamedocs/ inside the workspace: classes, structs, enums, data, Blueprint scripts, class defaults, levels, assets, and the settings, localization and plugin pages when unreal.read_containers was run. Start reading at gamedocs/overview.md. An existing folder is replaced only when it is an earlier docs build; a failed build keeps the previous docs. Sections without input are listed in README.md and in missing.",
  engine: "unreal",
  inputs: {
    type: "object",
    properties: {
      run: { type: "string", description: "Run folder name under dumps/unreal/runs, or an absolute path. Default: the newest run by name." },
      outputDir: { type: "string", description: "Folder inside the workspace. Default: gamedocs." },
      gameExe: {
        type: "string",
        description: "The game executable the console variable names are read from. Default: the run's game_exe, then the profile's executable.",
      },
      prune: {
        type: "boolean",
        description: "After a build with no missing section, from a run that passes unreal.verify_dump, remove the run files the docs distilled (tool inputs such as usmap, jmap, headers, Lua types, SDK and the object dump stay). Default true.",
      },
    },
    required: [],
  },
  outputs: {
    type: "object",
    properties: {
      outputDir: { type: "string" },
      run: { type: "string" },
      files: { type: "integer" },
      bytes: { type: "integer" },
      sections: { type: "array" },
      missing: { type: "array" },
    },
  },
  effects: ["read", "workspaceWrite"],
  requires: [],
  gates: ["auto"],
  skill: "unreal-first-dump",
  docs: [],

  async handler(inputs = {}, context = {}) {
    const root = workspaceRoot(context);
    const target = resolveDocsDir(root, inputs.outputDir || "gamedocs");
    const fsx = context.fsImpl || fs;
    const building = `${target}${BUILDING_SUFFIX}`;
    const old = `${target}${OLD_SUFFIX}`;
    for (const dir of [target, building, old]) assertReplaceable(dir, fsx);
    const { name, dir } = resolveRun(inputs.run, context);
    if (fs.existsSync(path.join(dir, PRUNED_FILE))) {
      throw gmfError(
        "GMF-E-PLAN-001",
        `The run ${name} was pruned after its docs were built, so it can no longer build docs.`,
        "Dump again with unreal.run_dump, then build the docs from the new run.",
      );
    }
    const verified = verifyRun(dir);
    const textDir = path.join(root, "extracted", "unreal", "text");

    // Leftovers of an interrupted build; both were checked to be ours or empty.
    fs.rmSync(building, { recursive: true, force: true });
    fs.rmSync(old, { recursive: true, force: true });
    let built;
    try {
      // The marker goes in first, so an interrupted build is still recognized as ours.
      fs.mkdirSync(building, { recursive: true });
      fs.writeFileSync(path.join(building, MARKER), `${JSON.stringify({ schema: MARKER_SCHEMA, run: name, built_at: new Date().toISOString() }, null, 2)}\n`);
      built = await buildDocs(dir, building, {
        textDir: fs.existsSync(textDir) ? textDir : null,
        gameExe: findGameExe(inputs, dir, context),
      });
    } catch (error) {
      fs.rmSync(building, { recursive: true, force: true });
      throw gmfError("GMF-E-EXEC-001", `The docs build failed: ${error.message}`, "Check the run with unreal.verify_dump.");
    }
    if (built.brokenLinks.length > 0) {
      fs.rmSync(building, { recursive: true, force: true });
      const listed = built.brokenLinks.slice(0, MAX_LISTED_LINKS).join("\n");
      throw gmfError(
        "GMF-E-EXEC-001",
        `The docs have ${built.brokenLinks.length} broken links, so they were not installed:\n${listed}`,
        "This is a defect of the builder; report the run and the first broken link.",
      );
    }
    swapIn(target, building, old, fsx);

    const missing = built.sections.filter((section) => section.missing).map((section) => ({ name: section.name, reason: section.missing }));
    const pruned = inputs.prune === false
      ? { done: false, reason: "prune is false" }
      : pruneRun(dir, path.join(root, "dumps", "unreal", "runs"), { verified, missing, docs: target });
    return {
      data: { outputDir: target, run: name, files: built.files, bytes: built.bytes, sections: built.sections, missing, pruned },
      evidence: [
        evidence({
          claim: `Docs for run ${name}: ${built.files} files in ${target}.`,
          confidence: "derived",
          authority: "shipped-artifact",
          source: target,
          detail: { files: built.files, bytes: built.bytes, missing: missing.map((entry) => entry.name) },
        }),
      ],
    };
  },
};

export default buildDocsOperation;
