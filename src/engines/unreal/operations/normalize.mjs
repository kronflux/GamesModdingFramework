// unreal.normalize_dump: build a normalized dump from a UE4SS object dump.
//
// UE4SS_ObjectDump.txt lines look like
//   [00007FF451CD0070] Class /Script/CoreUObject.Object [n: 20B] [c: ...] [or: ...]
//   [000001EC47692F80] ObjectProperty /Game/X.X_C:Throbber [o: 348] [n: ...] ...
// The address carries no 0x prefix in current builds (older notes show one).
// Class, Blueprint class and struct lines become class records; Function lines
// become methods of their owner; Property lines directly on a class become
// fields with their type and offset (function parameters are skipped). Only
// instances placed in a level become objects: packages, types, Default__
// objects and loose assets are left out to keep the dump small. Raw lines
// never enter the dump.

import fs from "node:fs";
import path from "node:path";
import { registerOperation, getHandler } from "../../../core/operations.mjs";
import { evidence } from "../../../core/evidence.mjs";
import { emptyDump, writeNormalizedDump } from "../../../operations/analyze/normalize.mjs";
import { ensureInsideWorkspace, gmfError, workspaceRoot } from "./shared.mjs";

const LINE_RE = /^\[(?:0x)?([0-9A-Fa-f]+)\]\s+(\S+)\s+(\S+)(.*)$/;
const OFFSET_RE = /\[o:\s*([0-9A-Fa-f]+)\]/;
const CLASS_KINDS = new Set([
  "Class",
  "BlueprintGeneratedClass",
  "WidgetBlueprintGeneratedClass",
  "AnimBlueprintGeneratedClass",
  "ScriptStruct",
  "UserDefinedStruct",
]);
const FUNCTION_KINDS = new Set(["Function", "DelegateFunction", "SparseDelegateFunction"]);
const ENTRY_OWNERS = /GameMode|PlayerController|GameInstance|GameState|PlayerState/;
export const OBJECT_DUMP_FILE = "UE4SS_ObjectDump.txt";

function lastSegment(objectPath) {
  const afterColon = objectPath.includes(":") ? objectPath.slice(objectPath.lastIndexOf(":") + 1) : objectPath;
  const dot = afterColon.lastIndexOf(".");
  return dot >= 0 ? afterColon.slice(dot + 1) : afterColon;
}

// "/Script/Engine.PlayerController:ClientRestart" -> owner path and member name.
// Returns null for a path without a member, and depth > 1 for nested members
// such as function parameters ("Owner:Function:Param").
function splitMember(objectPath) {
  const parts = objectPath.split(":");
  if (parts.length < 2) return null;
  // A level path such as "/Game/M.M:PersistentLevel.Actor_0" has a colon but
  // names a sub-object, not a member; members never contain a dot.
  const member = parts[parts.length - 1];
  if (member.includes(".")) return null;
  return { owner: parts.slice(0, -1).join(":"), member, depth: parts.length - 1 };
}

function isLevelInstance(kind, objectPath) {
  if (CLASS_KINDS.has(kind) || FUNCTION_KINDS.has(kind) || kind === "Package" || kind.endsWith("Property")) return false;
  if (objectPath.includes("Default__")) return false;
  return objectPath.includes(":PersistentLevel.");
}

export function normalizeObjectDump(text) {
  const dump = emptyDump("unreal");
  const classesByPath = new Map();
  const pendingMembers = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(LINE_RE);
    if (!match) continue;
    const [, rawAddress, kind, objectPath, rest] = match;
    const address = `0x${rawAddress}`;
    if (CLASS_KINDS.has(kind)) {
      const record = { name: lastSegment(objectPath), kind, path: objectPath, address, methods: [], fields: [] };
      dump.classes.push(record);
      classesByPath.set(objectPath, record);
      continue;
    }
    if (FUNCTION_KINDS.has(kind) || kind.endsWith("Property")) {
      const member = splitMember(objectPath);
      if (member) pendingMembers.push({ kind, objectPath, address, rest, ...member });
      continue;
    }
    if (isLevelInstance(kind, objectPath)) {
      dump.objects.push({ name: lastSegment(objectPath), class: kind, path: objectPath, address });
    }
  }
  // Members can precede their owner in a dump, so attach them after the pass.
  for (const entry of pendingMembers) {
    const owner = classesByPath.get(entry.owner);
    if (FUNCTION_KINDS.has(entry.kind)) {
      if (entry.depth !== 1) continue;
      if (owner && !owner.methods.includes(entry.member)) owner.methods.push(entry.member);
      const ownerName = owner ? owner.name : lastSegment(entry.owner);
      if (ENTRY_OWNERS.test(ownerName)) {
        dump.entrypoints.push({ name: entry.member, kind: "function", class: ownerName, path: entry.objectPath, address: entry.address });
      }
    } else if (entry.depth === 1 && owner) {
      const offset = entry.rest.match(OFFSET_RE);
      owner.fields.push({ name: entry.member, type: entry.kind, offset: offset ? `0x${offset[1].toUpperCase()}` : null });
    }
  }
  return dump;
}

export function normalizeUnrealDump({ dumpsDir }) {
  const file = path.join(dumpsDir, OBJECT_DUMP_FILE);
  if (!fs.existsSync(file)) {
    throw gmfError(
      "GMF-E-EXEC-001",
      `No ${OBJECT_DUMP_FILE} under ${dumpsDir}`,
      "Run unreal.dump with collect=true, or copy the UE4SS object dump into the workspace dumps folder.",
    );
  }
  return normalizeObjectDump(fs.readFileSync(file, "utf8"));
}

export const normalizeOperation = {
  id: "unreal.normalize_dump",
  title: "Normalize a UE4SS object dump",
  summary:
    "Build the normalized dump JSON the analyze operations read from UE4SS_ObjectDump.txt. Keeps object names, classes, paths and addresses only.",
  engine: "unreal",
  inputs: {
    type: "object",
    properties: {
      dumpsDir: { type: "string" },
    },
    required: [],
  },
  outputs: {
    type: "object",
    properties: {
      file: { type: "string" },
      objects: { type: "integer" },
      classes: { type: "integer" },
      entrypoints: { type: "integer" },
    },
  },
  effects: ["read", "workspaceWrite"],
  requires: [],
  gates: ["auto"],
  skill: "gmf-investigate",
  docs: [],
  async handler(inputs, context = {}) {
    const root = workspaceRoot(context);
    const dumpsDir = inputs.dumpsDir
      ? ensureInsideWorkspace(context, inputs.dumpsDir, "dumps directory")
      : path.join(root, "dumps");
    const dump = normalizeUnrealDump({ dumpsDir: findDumpDir(dumpsDir) });
    const file = writeNormalizedDump(root, "unreal-objects.json", dump);
    return {
      data: { file, objects: dump.objects.length, classes: dump.classes.length, entrypoints: dump.entrypoints.length },
      evidence: [
        evidence({
          claim: `Normalized ${dump.objects.length} Unreal objects for analysis`,
          confidence: "derived",
          authority: "shipped-artifact",
          source: file,
          detail: { objects: dump.objects.length, classes: dump.classes.length },
        }),
      ],
    };
  },
};

// The object dump may sit directly under dumps/ or under dumps/unreal/<game>/.
function findDumpDir(start) {
  if (fs.existsSync(path.join(start, OBJECT_DUMP_FILE))) return start;
  const queue = [start];
  while (queue.length > 0) {
    const dir = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (fs.existsSync(path.join(full, OBJECT_DUMP_FILE))) return full;
      queue.push(full);
    }
  }
  return start;
}

if (!getHandler(normalizeOperation.id)) registerOperation(normalizeOperation, normalizeOperation.handler);

export default normalizeOperation;
