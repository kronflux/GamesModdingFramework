import fs from "node:fs";
import path from "node:path";
import { registerOperation, getHandler } from "../../core/operations.mjs";
import { assertGameDir } from "../../engines/unity/detect.mjs";

export function inventoryGame(gameDir, { maxEntries = 10000 } = {}) {
  const root = assertGameDir(gameDir);
  const files = [];
  const dirs = [];

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length + dirs.length >= maxEntries) return;
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        dirs.push(relative);
        walk(full);
      } else if (entry.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          size = 0;
        }
        files.push({ path: relative, size });
      }
    }
  };

  walk(root);
  return { files, dirs, counts: { files: files.length, dirs: dirs.length }, truncated: files.length + dirs.length >= maxEntries };
}

const operation = {
  id: "game.inventory",
  title: "Inventory a game install",
  summary: "List the files and folders of a game install with sizes and counts, without reading file content.",
  engine: "core",
  inputs: {
    type: "object",
    properties: {
      gameDir: { type: "string" },
    },
    required: ["gameDir"],
  },
  outputs: {
    type: "object",
    properties: {
      files: { type: "array" },
      dirs: { type: "array" },
      counts: { type: "object" },
    },
  },
  effects: ["read"],
  requires: [],
  gates: ["auto"],
  skill: "gmf-investigate",
  docs: [],
  handler: async (inputs) => {
    const inventory = inventoryGame(inputs.gameDir);
    return { data: inventory, evidence: [] };
  },
};

if (!getHandler(operation.id)) registerOperation(operation, operation.handler);

export default operation;
