import path from "node:path";
import { readJson } from "./fsutil.mjs";

export function loadCatalog(root = process.cwd()) {
  const dir = path.join(root, "catalog");
  const operations = readJson(path.join(dir, "operations.json"), { version: 1, operations: [] });
  const tools = readJson(path.join(dir, "tools.json"), { version: 1, tools: [] });
  const knowledge = readJson(path.join(dir, "knowledge.json"), { version: 1, knowledge: [] });
  const templates = readJson(path.join(dir, "templates.json"), { version: 1, templates: [] });
  const skills = readJson(path.join(dir, "skills.json"), { version: 1, skills: [] });
  return {
    version: operations.version || 1,
    operations: operations.operations || [],
    tools: tools.tools || [],
    knowledge: knowledge.knowledge || [],
    templates: templates.templates || [],
    skills: skills.skills || [],
  };
}

export function getOperation(catalog, id) {
  return (catalog.operations || []).find((operation) => operation.id === id) || null;
}

export function listOperations(catalog, filter = {}) {
  return (catalog.operations || []).filter(
    (operation) => (!filter.engine || operation.engine === filter.engine) && (!filter.kind || operation.kind === filter.kind),
  );
}

export function assertCatalogComplete(catalog) {
  const seen = new Set();
  for (const operation of catalog.operations || []) {
    if (seen.has(operation.id)) throw new Error(`Duplicate operation id: ${operation.id}`);
    seen.add(operation.id);
  }
  for (const skill of catalog.skills || []) {
    for (const id of skill.operations || []) {
      if (!seen.has(id)) throw new Error(`Skill ${skill.id} references missing operation ${id}`);
    }
  }
  return true;
}
