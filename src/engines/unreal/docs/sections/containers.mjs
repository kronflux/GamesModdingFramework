// Pages for the text files read from the paks: settings (.ini), localization (.locres) and
// plugins (.uplugin, .uproject). `containerPages` reads the extracted folder and writes nothing.
//
// Layout of the input: <textDir>/<pak name>/<path inside the pak>.

import fs from "node:fs";
import path from "node:path";
import { decodeText, parseIni } from "../ini.mjs";
import { parseLocres } from "../locres.mjs";

function walk(dir, found = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

// One table cell. A backslash is doubled first, so the escapes added after it stay escapes; a
// line break is shown as the two characters \n; "](" is broken up so game text that looks like a
// markdown link is not one.
function cell(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\n|\r/g, "\\n")
    .replace(/\|/g, "\\|")
    .replace(/\]\(/g, "]\\(");
}

// Gives each page its own file: a name already used in a folder, compared without regard to
// case because Windows does not tell them apart, gets ~2, ~3 and so on.
function uniqueNames() {
  const taken = new Set();
  return (folder, base) => {
    let name = base;
    for (let n = 2; taken.has(`${folder}/${name}`.toLowerCase()); n += 1) name = `${base}~${n}`;
    taken.add(`${folder}/${name}`.toLowerCase());
    return name;
  };
}

function frontMatter(kind, name, source) {
  return `---\nkind: ${JSON.stringify(kind)}\nname: ${JSON.stringify(name)}\nsource: ${JSON.stringify(source)}\n---\n\n`;
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, "_");
}

function byLowerName(a, b) {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
}

function readJson(file) {
  try {
    const parsed = JSON.parse(decodeText(fs.readFileSync(file)));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function iniPage(name, rel, pak, parsed) {
  const lines = [`# ${rel}`, "", `Pak: \`${pak}\`.`, ""];
  for (const section of parsed.sections) {
    lines.push(`## [${section.name}]`, "", "| Key | Op | Value |", "|---|---|---|");
    for (const entry of section.entries) lines.push(`| ${cell(entry.key)} | ${cell(entry.op)} | ${cell(entry.value)} |`);
    lines.push("");
  }
  return `${frontMatter("settings", name, rel)}${lines.join("\n")}`;
}

function localePage(culture, namespace, sources, entries) {
  const lines = [
    `# ${namespace} (${culture})`,
    "",
    `Sources: ${sources.map((source) => `\`${source}\``).join(", ")}.`,
    "",
    "| Key | Text |",
    "|---|---|",
  ];
  for (const [key, text] of entries) lines.push(`| ${cell(key)} | ${cell(text)} |`);
  lines.push("");
  return `${frontMatter("localization", `${culture}/${namespace}`, sources[0])}${lines.join("\n")}`;
}

function pluginRow(plugin) {
  const cells = [plugin.name, plugin.version, plugin.category, plugin.enabled, plugin.modules, plugin.description, plugin.rel];
  return `| ${cells.map(cell).join(" | ")} |`;
}

function pluginsPage(plugins, projects) {
  const lines = ["# Plugins", ""];
  for (const project of projects) {
    lines.push(`## Project \`${project.rel}\``, "", `- EngineAssociation: ${project.engine ? `\`${project.engine}\`` : "(none)"}`);
    lines.push(`- Enabled plugins: ${project.enabled.length > 0 ? project.enabled.map((name) => `\`${name}\``).join(", ") : "(none)"}`, "");
  }
  const header = ["| Name | Version | Category | Enabled by default | Modules | Description | Path |", "|---|---|---|---|---|---|---|"];
  const sorted = [...plugins].sort((a, b) => byLowerName(a.name, b.name));
  const game = sorted.filter((plugin) => !plugin.rel.startsWith("Engine/"));
  const engine = sorted.filter((plugin) => plugin.rel.startsWith("Engine/"));
  if (game.length > 0) lines.push("## Game plugins", "", ...header, ...game.map(pluginRow), "");
  if (engine.length > 0) lines.push("## Engine plugins", "", ...header, ...engine.map(pluginRow), "");
  const source = projects.length > 0 ? projects[0].rel : "*.uplugin";
  return `${frontMatter("plugins", "plugins", source)}${lines.join("\n")}`;
}

/**
 * Build the settings, localization and plugin pages from `textDir`.
 * Returns the pages and how many .ini, .locres and .uplugin files were read.
 * The engine's own localization (entries under Engine/) is left out unless
 * `engineLocalization` is true: it is thousands of namespaces of editor and engine text
 * per language and says nothing about the game. `counts.engineLocres` counts those files.
 */
export function containerPages(textDir, { engineLocalization = false } = {}) {
  const counts = { ini: 0, locres: 0, uplugin: 0, engineLocres: 0 };
  const pages = [];
  const skipped = [];
  const iniByName = new Map();
  const locales = new Map();
  const pluginsByRel = new Map();
  const projectsByRel = new Map();

  let paks = [];
  try {
    paks = fs.readdirSync(textDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    paks = [];
  }
  paks.sort();

  for (const pak of paks) {
    const pakDir = path.join(textDir, pak);
    for (const file of walk(pakDir)) {
      const rel = path.relative(pakDir, file).split(path.sep).join("/");
      const lower = rel.toLowerCase();
      if (lower.endsWith(".ini")) {
        counts.ini += 1;
        // A later pak, in name order, replaces an earlier pak's file of the same path.
        iniByName.set(rel.toLowerCase(), { rel, pak, file });
      } else if (lower.endsWith(".locres")) {
        if (!engineLocalization && lower.startsWith("engine/")) {
          counts.engineLocres += 1;
          continue;
        }
        counts.locres += 1;
        let parsed;
        try {
          parsed = parseLocres(fs.readFileSync(file));
        } catch (error) {
          skipped.push({ source: rel, error: error.message });
          continue;
        }
        const culture = rel.includes("/") ? rel.split("/").slice(-2, -1)[0] : "_";
        for (const namespace of parsed.namespaces) {
          // Keyed by the real names; file names are made safe and unique when the pages are written.
          const id = `${culture}\0${namespace.name}`;
          if (!locales.has(id)) locales.set(id, { culture, namespace: namespace.name, sources: [], entries: new Map() });
          const target = locales.get(id);
          if (!target.sources.includes(rel)) target.sources.push(rel);
          for (const entry of namespace.entries) target.entries.set(entry.key, entry.text);
        }
      } else if (lower.endsWith(".uplugin")) {
        counts.uplugin += 1;
        const json = readJson(file);
        const base = path.posix.basename(rel).replace(/\.uplugin$/i, "");
        const modules = Array.isArray(json?.Modules) ? json.Modules.map((module) => module?.Name).filter(Boolean).join(", ") : "";
        pluginsByRel.set(rel, {
          rel,
          name: json?.FriendlyName || base,
          version: json?.VersionName ?? "",
          category: json?.Category ?? "",
          enabled: typeof json?.EnabledByDefault === "boolean" ? String(json.EnabledByDefault) : "",
          modules,
          description: json?.Description ?? "",
        });
      } else if (lower.endsWith(".uproject")) {
        const json = readJson(file);
        const list = Array.isArray(json?.Plugins) ? json.Plugins : [];
        projectsByRel.set(rel, {
          rel,
          engine: json?.EngineAssociation ?? "",
          enabled: list.filter((plugin) => plugin && plugin.Enabled !== false && plugin.Name).map((plugin) => plugin.Name),
        });
      }
    }
  }

  const unique = uniqueNames();
  for (const key of [...iniByName.keys()].sort(byLowerName)) {
    const { rel, pak, file } = iniByName.get(key);
    const name = unique("settings", rel.slice(0, -4).split("/").join("__").replace(/[^A-Za-z0-9._ -]/g, "_"));
    const parsed = parseIni(decodeText(fs.readFileSync(file)));
    pages.push({ file: `settings/${name}.md`, text: iniPage(name, rel, pak, parsed), kind: "settings", name });
  }
  const cultureFolder = new Map();
  for (const target of [...locales.values()].sort((a, b) => byLowerName(a.culture, b.culture) || byLowerName(a.namespace, b.namespace))) {
    if (!cultureFolder.has(target.culture)) cultureFolder.set(target.culture, unique("localization", safeName(target.culture)));
    const folder = `localization/${cultureFolder.get(target.culture)}`;
    const shown = target.namespace === "" ? "(no namespace)" : target.namespace;
    pages.push({
      file: `${folder}/${unique(folder, target.namespace === "" ? "_default" : safeName(target.namespace))}.md`,
      text: localePage(target.culture, shown, target.sources, target.entries),
      kind: "localization",
      name: `${target.culture}/${shown}`,
    });
  }
  if (pluginsByRel.size > 0 || projectsByRel.size > 0) {
    const projects = [...projectsByRel.values()].sort((a, b) => byLowerName(a.rel, b.rel));
    pages.push({ file: "plugins.md", text: pluginsPage([...pluginsByRel.values()], projects), kind: "plugins", name: "plugins" });
  }
  return { pages, counts, skipped };
}
