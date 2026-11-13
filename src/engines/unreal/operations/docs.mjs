// unreal.build_docs: turn one collected GmfDumper run, plus the text read from the paks, into
// Markdown under <workspace>/gamedocs.
//
// Replacing a folder is destructive, so the output is confined: it must be a folder below the
// workspace, and an existing folder is replaced only when it carries the marker file of an
// earlier build. The new docs are built beside the target and swapped in, so a failed build
// leaves the previous docs in place.

import fs from "node:fs";
import path from "node:path";
import { evidence } from "../../../core/evidence.mjs";
import { isInside } from "../../../core/fsutil.mjs";
import { buildDocs } from "../docs/build.mjs";
import { gmfError, workspaceRoot } from "./shared.mjs";
import { resolveRun } from "./verify_dump.mjs";

const MARKER = ".gmfdocs";
const MARKER_SCHEMA = "gmf.docs/1";
const BUILDING_SUFFIX = ".building";
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

function entriesOf(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return null;
  }
}

// A folder may be replaced when it is absent, empty, or an earlier docs build.
function assertReplaceable(dir) {
  const names = entriesOf(dir);
  if (names === null || names.length === 0 || names.includes(MARKER)) return;
  throw gmfError(
    "GMF-E-PLAN-001",
    `${dir} is not a docs build: it has files and no ${MARKER} marker, so it is not replaced.`,
    "Choose another outputDir, or empty the folder yourself.",
  );
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
    assertReplaceable(target);
    const building = `${target}${BUILDING_SUFFIX}`;
    assertReplaceable(building);
    const { name, dir } = resolveRun(inputs.run, context);
    const textDir = path.join(root, "extracted", "unreal", "text");

    fs.rmSync(building, { recursive: true, force: true });
    let built;
    try {
      // The marker goes in first, so an interrupted build is still recognized as ours.
      fs.mkdirSync(building, { recursive: true });
      fs.writeFileSync(path.join(building, MARKER), `${JSON.stringify({ schema: MARKER_SCHEMA, run: name, built_at: new Date().toISOString() }, null, 2)}\n`);
      built = await buildDocs(dir, building, { textDir: fs.existsSync(textDir) ? textDir : null });
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
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(building, target);

    const missing = built.sections.filter((section) => section.missing).map((section) => ({ name: section.name, reason: section.missing }));
    return {
      data: { outputDir: target, run: name, files: built.files, bytes: built.bytes, sections: built.sections, missing },
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
