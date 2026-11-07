import fs from "node:fs";
import path from "node:path";
import { validateKnowledge } from "./contracts.mjs";

function stripQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1);
  }
  return value;
}

export function parseKnowledgeFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { data: {}, body: text.trim() };
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
            .map((value) => stripQuotes(value.trim()))
            .filter(Boolean)
        : stripQuotes(raw);
  }
  return { data, body: text.slice(match[0].length).trim() };
}

function walkMarkdown(dir, found = []) {
  if (!fs.existsSync(dir)) return found;
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(full, found);
    else if (entry.isFile() && entry.name.endsWith(".md")) found.push(full);
  }
  return found;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

// Load every knowledge note under <root>/knowledge as one entry per Markdown
// file. The body stays on the entry for search; search results drop it.
export function loadKnowledge(root = process.cwd()) {
  const knowledgeDir = path.join(root, "knowledge");
  const entries = [];
  for (const file of walkMarkdown(knowledgeDir)) {
    const text = fs.readFileSync(file, "utf8");
    const { data, body } = parseKnowledgeFrontmatter(text);
    const relative = toPosix(path.relative(root, file));
    const entry = {
      id: data.name || relative.replace(/^knowledge\//, "").replace(/\.md$/, ""),
      title: data.title || data.name || path.basename(file, ".md"),
      engine: data.engine || "core",
      tags: Array.isArray(data.tags) ? data.tags : [],
      summary: data.description || "",
      path: relative,
      confidence: data.confidence || "observed",
      sources: Array.isArray(data.sources) ? data.sources : [],
      body,
    };
    const result = validateKnowledge(entry);
    if (!result.ok) throw new Error(`Invalid knowledge entry ${relative}: ${result.errors.join("; ")}`);
    const previous = entries.find((existing) => existing.id === entry.id);
    if (previous) throw new Error(`Duplicate knowledge id ${entry.id} in ${previous.path} and ${relative}`);
    entries.push(entry);
  }
  return entries;
}

function metadata(entry, score) {
  return {
    id: entry.id,
    title: entry.title,
    engine: entry.engine,
    tags: entry.tags,
    summary: entry.summary,
    path: entry.path,
    confidence: entry.confidence,
    sources: entry.sources,
    score,
  };
}

// Search IDs, titles, tags and body text. Every whitespace-separated token in
// the query must appear somewhere in the entry. A blank query returns nothing.
export function searchKnowledge(query, filters = {}) {
  const { root = process.cwd(), engine = null, tag = null, entries = null, limit = 50 } = filters;
  const text = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (!text) return [];

  const tokens = text.split(/\s+/).filter(Boolean);
  const matches = [];
  for (const entry of entries || loadKnowledge(root)) {
    if (engine && String(entry.engine).toLowerCase() !== String(engine).toLowerCase()) continue;
    if (tag && !(entry.tags || []).some((value) => String(value).toLowerCase() === String(tag).toLowerCase())) continue;

    const identity = [entry.id, entry.title, ...(entry.tags || [])].join(" ").toLowerCase();
    const prose = `${entry.summary || ""} ${entry.body || ""}`.toLowerCase();
    const haystack = `${identity} ${prose}`;
    if (!tokens.every((token) => haystack.includes(token))) continue;

    let score = 0;
    for (const token of tokens) {
      if (entry.id.toLowerCase().includes(token)) score += 5;
      if ((entry.title || "").toLowerCase().includes(token)) score += 4;
      if ((entry.tags || []).some((value) => String(value).toLowerCase().includes(token))) score += 3;
      if (prose.includes(token)) score += 1;
    }
    matches.push({ score, entry });
  }

  matches.sort((left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id));
  return matches.slice(0, limit).map(({ score, entry }) => metadata(entry, score));
}
