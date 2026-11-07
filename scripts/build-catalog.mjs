import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadEngineModules } from "../src/engines/index.mjs";
import { TEMPLATE_KINDS, validateKnowledge, validateOperation, validateTool } from "../src/core/contracts.mjs";
import { validateSkillReferences } from "../src/core/hosts.mjs";
import { readJson } from "../src/core/fsutil.mjs";

const CATALOG_FILES = [
  ["operations.json", "operations"],
  ["tools.json", "tools"],
  ["knowledge.json", "knowledge"],
  ["templates.json", "templates"],
  ["skills.json", "skills"],
];


function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const entry = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!entry) continue;
    const raw = entry[2].trim();
    data[entry[1]] =
      raw.startsWith("[") && raw.endsWith("]")
        ? raw
            .slice(1, -1)
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : raw;
  }
  return data;
}

function walk(dir, filter, found = []) {
  if (!fs.existsSync(dir)) return found;
  // Sort so the generated catalog is identical on every filesystem.
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, found);
    else if (filter(entry.name)) found.push(full);
  }
  return found;
}

function relative(root, file) {
  return path.relative(root, file).replace(/\\/g, "/");
}

function scanKnowledge(root) {
  const dir = path.join(root, "knowledge");
  return walk(dir, (name) => name.endsWith(".md")).map((file) => {
    const frontmatter = parseFrontmatter(fs.readFileSync(file, "utf8"));
    return {
      id: frontmatter.name || relative(dir, file).replace(/\.md$/, ""),
      title: frontmatter.title || frontmatter.name || path.basename(file, ".md"),
      engine: frontmatter.engine || "core",
      tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
      summary: frontmatter.description || "",
      path: relative(root, file),
      confidence: frontmatter.confidence || "observed",
      sources: Array.isArray(frontmatter.sources) ? frontmatter.sources : [],
    };
  });
}

function scanTemplates(root) {
  const dir = path.join(root, "templates");
  return walk(dir, (name) => name === "template.json").map((file) => {
    const data = readJson(file, {});
    const id = data.id || path.basename(path.dirname(file));
    const kind = data.kind || "scaffold";
    if (!TEMPLATE_KINDS.includes(kind)) {
      throw new Error(`Invalid template ${id}: kind must be one of ${TEMPLATE_KINDS.join(", ")}`);
    }
    return {
      id,
      engine: data.engine || "core",
      type: data.type || "mod",
      kind,
      path: relative(root, path.dirname(file)),
      description: data.description || "",
    };
  });
}

function scanSkills(root) {
  const dir = path.join(root, "skills");
  return walk(dir, (name) => name === "SKILL.md").map((file) => {
    const frontmatter = parseFrontmatter(fs.readFileSync(file, "utf8"));
    const name = frontmatter.name || path.basename(path.dirname(file));
    return {
      id: name,
      name,
      summary: frontmatter.description || "",
      path: relative(root, file),
      operations: Array.isArray(frontmatter.operations) ? frontmatter.operations : [],
      knowledge: Array.isArray(frontmatter.knowledge) ? frontmatter.knowledge : [],
    };
  });
}

async function loadSharedOperations(root) {
  const dir = path.join(root, "src", "operations");
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name, "index.mjs"))
    .filter((file) => fs.existsSync(file));

  const operations = [];
  for (const file of files) {
    const imported = await import(`${pathToFileURL(file).href}?v=${Date.now()}-${operations.length}`);
    const exported = imported.operations || imported.default;
    if (Array.isArray(exported)) operations.push(...exported);
  }
  return operations;
}

export async function buildCatalog({ root = process.cwd(), moduleDirs = null, outDir = null, check = false } = {}) {
  const engines = await loadEngineModules(root, moduleDirs);
  const operations = [];

  const collect = (operation) => {
    if (!operation || typeof operation.handler !== "function") {
      throw new Error(`Operation ${operation?.id || "?"} has no handler`);
    }
    const { handler, ...descriptor } = operation;
    const result = validateOperation(descriptor);
    if (!result.ok) throw new Error(`Invalid operation ${descriptor.id || "?"}: ${result.errors.join("; ")}`);
    operations.push(descriptor);
  };

  for (const engine of engines) {
    const engineOperations = typeof engine.operations === "function" ? await engine.operations() : engine.operations || [];
    for (const operation of engineOperations) collect(operation);
  }
  if (moduleDirs === null) {
    for (const operation of await loadSharedOperations(root)) collect(operation);
  }

  const seen = new Map();
  for (const operation of operations) {
    const previous = seen.get(operation.id);
    if (previous) {
      throw new Error(`Duplicate operation id ${operation.id} in engines ${previous.engine} and ${operation.engine}`);
    }
    seen.set(operation.id, operation);
  }
  operations.sort((left, right) => left.id.localeCompare(right.id, "en"));

  const catalogDir = outDir || path.join(root, "catalog");
  const existing = (file, key) => readJson(path.join(catalogDir, file), { [key]: [] })[key] || [];
  const tools = existing("tools.json", "tools");
  for (const tool of tools) {
    const result = validateTool(tool);
    if (!result.ok) throw new Error(`Invalid tool ${tool.id || "?"}: ${result.errors.join("; ")}`);
  }

  const knowledge = scanKnowledge(root);
  for (const entry of knowledge) {
    const result = validateKnowledge(entry);
    if (!result.ok) throw new Error(`Invalid knowledge ${entry.id || "?"}: ${result.errors.join("; ")}`);
    // Engine notes are adapted from references or tools and must name their origin.
    if (entry.engine !== "core" && entry.sources.length === 0) {
      throw new Error(`Invalid knowledge ${entry.id}: sources must name the origin of an engine note`);
    }
  }

  const data = {
    version: 1,
    operations,
    tools,
    knowledge,
    templates: scanTemplates(root),
    skills: scanSkills(root),
  };
  validateSkillReferences(data.skills, data);

  if (check) {
    for (const [file, key] of CATALOG_FILES) {
      const target = path.join(catalogDir, file);
      const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
      const expected = `${JSON.stringify({ version: 1, [key]: data[key] }, null, 2)}\n`;
      if (current !== expected) throw new Error(`Catalog drift: ${file}`);
    }
    return data;
  }

  fs.mkdirSync(catalogDir, { recursive: true });
  for (const [file, key] of CATALOG_FILES) {
    fs.writeFileSync(path.join(catalogDir, file), `${JSON.stringify({ version: 1, [key]: data[key] }, null, 2)}\n`);
  }
  return data;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const engineIndex = args.indexOf("--engines");
  const moduleDirs = engineIndex >= 0 ? [args[engineIndex + 1]] : null;
  buildCatalog({ check, moduleDirs })
    .then(() => console.log(check ? "catalog is current" : "catalog written"))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
