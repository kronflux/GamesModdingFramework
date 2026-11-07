// unreal.package: package a mod locally as a zip, rebuilding a pak with repak when available.

import fs from "node:fs";
import path from "node:path";
import {
  ensureInsideWorkspace,
  isDirectory,
  PAK_TOOL_ID,
  resolveModDirInput,
  resolveToolFrom,
  runResolvedTool,
  slugify,
  walkFiles,
  workspaceRoot,
} from "./shared.mjs";
import { createZip } from "./zip.mjs";

function readPackManifest(modDir) {
  const manifestPath = path.join(modDir, "pack.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

function destinationFor(context, inputs, name, version) {
  const workspace = path.resolve(workspaceRoot(context));
  let candidate;
  if (inputs.out) {
    const out = path.isAbsolute(inputs.out) ? path.resolve(inputs.out) : path.resolve(workspace, inputs.out);
    candidate = /\.zip$/i.test(out) ? out : path.join(out, `${name}-${version}.zip`);
  } else {
    candidate = path.join(workspace, "dist", `${name}-${version}.zip`);
  }
  return ensureInsideWorkspace(context, candidate, "package destination");
}

export const packageOperation = {
  id: "unreal.package",
  title: "Package an Unreal mod",
  summary:
    "Build a pak with repak when the project requests one, then package the mod folder into a local zip under dist/.",
  engine: "unreal",
  inputs: {
    type: "object",
    properties: {
      modDir: { type: "string" },
      out: { type: "string" },
    },
    required: [],
  },
  outputs: {
    type: "object",
    properties: {
      zip: { type: "string" },
      entries: { type: "integer" },
      warnings: { type: "array" },
    },
  },
  effects: ["read", "workspaceWrite"],
  requires: [],
  gates: ["auto"],
  skill: "unreal-pak-blueprint",
  docs: [],

  async handler(inputs, context = {}) {
    const modDir = resolveModDirInput(inputs, context);
    const name = slugify(path.basename(modDir));
    const manifest = readPackManifest(modDir);
    const version = slugify(String(manifest?.version || "0.1.0"));
    const warnings = [];
    const destination = destinationFor(context, inputs, name, version);
    let pak = null;

    if (manifest && manifest.container === "pak") {
      const repak = resolveToolFrom(context, PAK_TOOL_ID);
      if (!repak) {
        warnings.push("repak is not installed; the project was zipped without rebuilding the pak.");
      } else {
        const sourceDir = isDirectory(path.join(modDir, "Content")) ? path.join(modDir, "Content") : modDir;
        // The pak is written to the workspace build folder, outside the folder it packs, so a repeat run
        // does not pack the previous pak.
        const pakPath = ensureInsideWorkspace(context, path.join(workspaceRoot(context), "build", "unreal", name, `${name}.pak`), "pak output");
        fs.mkdirSync(path.dirname(pakPath), { recursive: true });
        const result = await runResolvedTool(context, repak, ["pack", sourceDir, pakPath], {
          cwd: modDir,
          timeoutMs: 600000,
        });
        if (result.code !== 0) {
          warnings.push(`repak exited ${result.code}; the existing files were zipped instead.`);
        } else {
          pak = { file: pakPath, name: `${name}.pak` };
        }
      }
    }

    // Archives and the destination are never packed, so an output folder inside the mod does not feed itself.
    const files = walkFiles(modDir)
      .filter((file) => path.resolve(file) !== destination && !/\.zip$/i.test(file))
      .filter((file) => !(pak && path.relative(modDir, file) === pak.name))
      .sort()
      .map((file) => ({ file, name: path.relative(modDir, file).split(path.sep).join("/") }));
    if (pak) files.push(pak);
    if (files.length === 0) {
      warnings.push("The mod folder is empty; the zip contains no entries.");
    }
    const written = createZip(destination, files, { baseDir: modDir });

    return {
      data: { zip: written.zip, entries: written.entries, warnings, modDir, name, version },
    };
  },
};

export default packageOperation;
