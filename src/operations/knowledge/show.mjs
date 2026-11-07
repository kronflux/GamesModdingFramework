import fs from "node:fs";
import path from "node:path";
import { getHandler, registerOperation } from "../../core/operations.mjs";
import { loadCatalog } from "../../core/catalog.mjs";

function plainError(code, message, remediation) {
  const error = new Error(message);
  error.code = code;
  error.remediation = remediation;
  return error;
}

// The catalog entry plus the file body, for a knowledge note or a skill.
export function readCatalogText(context, kind, match) {
  const root = context.root || process.cwd();
  const catalog = context.catalog || loadCatalog(root);
  const entry = (catalog[kind] || []).find(match);
  if (!entry) return null;
  return { ...entry, body: fs.readFileSync(path.join(root, ...entry.path.split("/")), "utf8") };
}

export const knowledgeShowOperation = {
  id: "knowledge.show",
  title: "Show a knowledge note",
  summary: "Return one knowledge note's metadata and full text by id. Find ids with knowledge.search.",
  engine: "core",
  inputs: {
    type: "object",
    properties: { id: { type: "string", description: "A note id such as unity.asset-tools." } },
    required: ["id"],
  },
  outputs: { type: "object", properties: { id: { type: "string" }, body: { type: "string" } } },
  effects: ["read"],
  requires: [],
  gates: ["auto"],
  skill: "gmf-investigate",
  docs: ["knowledge/core/catalog.md"],
  handler: async (inputs, context = {}) => {
    const note = readCatalogText(context, "knowledge", (entry) => entry.id === inputs.id);
    if (!note) throw plainError("GMF-E-PLAN-001", `Unknown knowledge id: ${inputs.id}`, "Run knowledge.search with a few words to find an id.");
    return { data: note };
  },
};

export const skillListOperation = {
  id: "skill.list",
  title: "List skills",
  summary: "List every gmf skill with its summary, the operations it routes to and the knowledge it loads.",
  engine: "core",
  inputs: { type: "object", properties: {}, required: [] },
  outputs: { type: "object", properties: { skills: { type: "array" } } },
  effects: ["read"],
  requires: [],
  gates: ["auto"],
  skill: "gmf-investigate",
  docs: ["knowledge/core/catalog.md"],
  handler: async (inputs, context = {}) => {
    const catalog = context.catalog || loadCatalog(context.root || process.cwd());
    const skills = (catalog.skills || []).map(({ id, name, summary, path: file, operations, knowledge }) => ({ id, name, summary, path: file, operations, knowledge }));
    return { data: { skills } };
  },
};

export const skillShowOperation = {
  id: "skill.show",
  title: "Show a skill",
  summary: "Return one skill's full text: the steps, evidence and pitfalls for a kind of modding job. Hosts without plugin skills read skills this way.",
  engine: "core",
  inputs: {
    type: "object",
    properties: { name: { type: "string", description: "A skill name such as unity-assets." } },
    required: ["name"],
  },
  outputs: { type: "object", properties: { name: { type: "string" }, body: { type: "string" } } },
  effects: ["read"],
  requires: [],
  gates: ["auto"],
  skill: "gmf-investigate",
  docs: ["knowledge/core/catalog.md"],
  handler: async (inputs, context = {}) => {
    const skill = readCatalogText(context, "skills", (entry) => entry.name === inputs.name || entry.id === inputs.name);
    if (!skill) throw plainError("GMF-E-PLAN-001", `Unknown skill: ${inputs.name}`, "Run skill.list.");
    return { data: skill };
  },
};

for (const operation of [knowledgeShowOperation, skillListOperation, skillShowOperation]) {
  if (!getHandler(operation.id)) registerOperation(operation, operation.handler);
}

export default [knowledgeShowOperation, skillListOperation, skillShowOperation];
