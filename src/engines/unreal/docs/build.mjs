// Turns a dumper run folder into a set of small markdown files.
//
// The dump holds a few very large JSON files. This builder splits the part that describes the
// game itself into one markdown file per class, struct, enum, data table, data asset, config
// object and widget, laid out like the game's own content folders, with an index file in
// every folder. Engine types appear only as one-line stubs, and only those the game refers to.
//
// Every file starts with YAML front matter. `index.jsonl` in the output folder holds one JSON
// record per document (id, kind, title, file, summary, keywords) for a search index.
//
// The output is game content and must not be committed or published.
//
// The output is byte-compatible with the Python builder of OmniDumper (tools/make_docs.py and
// tools/docs_more.py): ordering, number formatting and link paths follow what that builder
// produced on Windows.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { splitLarge, MAX_BYTES } from "./split.mjs";
import {
  basename, countInto, dirname, eachLine, get, getOr, joinNormal, leaf, or, parseJson, pyDumps, pyRstrip, pyStr, pyStrip,
  relpath, sortedPy, sortedStrings, truthy,
} from "./text.mjs";
import * as defaults from "./sections/defaults.mjs";
import * as scripts from "./sections/scripts.mjs";
import * as reflection from "./sections/reflection.mjs";
import * as data from "./sections/data.mjs";
import * as world from "./sections/world.mjs";
import * as levels from "./sections/levels.mjs";
import * as tags from "./sections/tags.mjs";
import * as assets from "./sections/assets.mjs";
import * as overview from "./sections/overview.mjs";
import * as assetValues from "./sections/asset_values.mjs";
import { containerPages } from "./sections/containers.mjs";

const SCHEMA_PREFIXES = ["omnidumper.", "gmfdumper."];
const LINK = /\]\(([^)#]+)(?:#[^)]*)?\)/g;

/**
 * The sections, in the order they run. Each `write(docs)` reads the run through `docs` and adds
 * documents with `docs.add`. `inputs` are the run files a section reads (it is reported missing
 * when none exists) and `steps` the manifest steps that produce them.
 */
export const SECTIONS = [
  { name: "defaults", write: defaults.write, inputs: ["Reflection/class_defaults.jsonl"], steps: ["class_defaults"] },
  { name: "scripts", write: scripts.write, inputs: ["Scripts/bytecode.jsonl"], steps: ["scripts"] },
  {
    name: "reflection", write: reflection.write,
    inputs: ["Reflection/classes.json", "Reflection/structs.json", "Reflection/enums.json"], steps: ["reflection"],
  },
  {
    name: "data", write: data.write,
    inputs: ["DataTables/_index.json", "DataAssets/data_assets.jsonl", "DataAssets/curves.jsonl", "Config/config_objects.jsonl",
      "UI/widget_trees.json"],
    steps: ["datatables", "data_assets", "config_objects", "widgets"],
  },
  {
    name: "world", write: world.write, inputs: ["World/actors.json", "World/runtime.json", "World/map_tour.json"],
    steps: ["world_json", "runtime", "world_values", "map_tour"],
  },
  { name: "asset_values", write: assetValues.write, inputs: ["Assets/asset_values.jsonl"], steps: ["asset_values"] },
  { name: "levels", write: levels.write, inputs: ["Levels/levels.json"], steps: ["levels_loaded"] },
  { name: "tags", write: tags.write, inputs: ["Names/gameplay_tags.txt"], steps: ["gameplay_tags"] },
  { name: "assets", write: assets.write, inputs: ["Assets/asset_registry.json"], steps: ["assets"] },
  // Text read from the paks, not from the run: `missing` answers for it instead of `inputs`.
  {
    name: "containers", write: writeContainers, inputs: [], steps: [],
    missing: (docs) => (docs.textDir && existsSync(docs.textDir) ? null : "containers not read; run unreal.read_containers"),
  },
  { name: "overview", write: overview.write, inputs: [], steps: [] },
];

const CONTAINER_SUMMARY = {
  settings: (source) => `settings file ${source}`,
  localization: (source) => `localized text from ${source}`,
  plugins: () => "plugins of the game and the engine, and the project file",
};

/** The containers section: settings/, localization/ and plugins.md from the extracted pak text. */
function writeContainers(docs) {
  if (!docs.textDir || !existsSync(docs.textDir)) return;
  const { pages, counts, skipped } = containerPages(docs.textDir);
  for (const page of pages) {
    // The page writer gives a whole page; its front matter is replaced by the builder's own.
    const end = page.text.indexOf("\n---\n\n");
    const source = /^source: (.*)$/m.exec(page.text.slice(0, end))?.[1];
    const shown = source ? JSON.parse(source) : page.name;
    docs.add(page.file, page.kind, page.name, null, CONTAINER_SUMMARY[page.kind]?.(shown) ?? page.kind, page.text.slice(end + 6),
      [page.name], { source: shown });
  }
  docs.log(`containers: ${counts.ini} ini, ${counts.locres} locres (${counts.engineLocres} engine locres left out), `
    + `${counts.uplugin} uplugin; ${skipped.length} unreadable`);
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function pushTo(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Whether a schema id (or a missing one) is a dumper schema this builder reads. */
export function schemaAccepted(id) {
  if (id === undefined || id === null) return true;
  return typeof id === "string" && SCHEMA_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/**
 * The state shared by the sections: the run reader (`load`, `lines`, `exists`), the output
 * (`files`, `records`, `add`), the link index (`docOf`, `link`, `typeName`) and the class
 * defaults helper (`defaults`, set by the defaults section).
 */
export class Docs {
  constructor(runDir, outDir, options = {}) {
    this.run = runDir;
    this.out = outDir;
    this.log = options.log ?? (() => {});
    this.textDir = options.textDir ?? null;  // extracted pak text, for the containers section
    this.missing = [];                       // [{ name, reason }] of sections without input
    this.files = new Map();      // relative file -> text
    this.records = [];           // search records
    this.docOf = new Map();      // object path -> relative file
    this.folders = new Map();    // folder -> [[title, file, summary]]
    this.section = null;         // the section whose documents are being added
    this.pages = new Map();      // section -> documents added
    // Each part of a split document links to the next. `linkNext: false` gives the parts the
    // Python builder wrote, for comparisons against its output.
    this.splitOptions = { linkNext: options.linkNext ?? true };
    // Script pages show recovered control flow. `structure: false` gives the flat listings the
    // Python builder wrote.
    this.structureScripts = options.structure ?? true;
    this.scriptCounts = { functions: 0, structured: 0 };
    this.manifest = or(this.load("manifest.json"), {});
    if (!schemaAccepted(get(this.manifest, "schema"))) {
      throw new Error(`manifest.json has schema ${pyStr(get(this.manifest, "schema"))}, not a dumper schema`);
    }
    const modules = options.gameModules?.length ? options.gameModules : [or(get(this.manifest, "game"), "")];
    this.gameScriptRoots = modules.filter((m) => truthy(m)).map((m) => "/Script/" + m);
    this.classes = this.entries("Reflection/classes.json", "classes");
    this.structs = this.entries("Reflection/structs.json", "structs");
    this.enums = this.entries("Reflection/enums.json", "enums");
    this.functions = this.entries("Reflection/functions.json", "functions");
    this.kindOf = new Map();
    this.byPath = new Map();
    for (const [kind, items] of [["class", this.classes], ["struct", this.structs], ["enum", this.enums]]) {
      for (const item of items) {
        this.kindOf.set(item, kind);
        this.byPath.set(get(item, "path"), item);
      }
    }
    this.functionsOf = new Map();
    for (const fn of this.functions) pushTo(this.functionsOf, get(fn, "owner") ?? null, fn);
    const hooks = or(this.load("Hooks/hookable_functions.json"), {});
    this.hookKind = new Map();
    for (const hook of getOr(hooks, "functions", [])) this.hookKind.set(get(hook, "hook"), get(hook, "kind"));
    this.children = new Map();
    for (const item of this.classes) {
      if (truthy(get(item, "super"))) pushTo(this.children, get(item, "super"), get(item, "path"));
    }
    this.engineRefs = new Set();
    this.referencedBy = new Map();   // target -> Set of owners
    this.classNotes = new Map();     // class path -> lines for the top of its page
    this.usedBy = new Map();         // member path -> class -> Set of functions
    this.nameCalls = new Map();      // function name -> class -> Set of functions
    this.functionOwners = new Map();
    for (const fn of this.functions) countInto(this.functionOwners, get(fn, "name") ?? null);
    this.scriptStats = new Map();    // class path -> [script file, statements, functions]
    this.gameModeOf = new Map();     // level section -> the game mode its world settings name
    this.maxBytes = MAX_BYTES;
    this.defaults = null;
  }

  // ------------------------------------------------------------------ input
  path(relative) {
    return join(this.run, ...relative.split("/"));
  }

  exists(relative) {
    return isFile(this.path(relative));
  }

  /** A JSON file of the run, or null when it is absent. */
  load(relative) {
    const path = this.path(relative);
    if (!isFile(path)) return null;
    return parseJson(readFileSync(path, "utf8"));
  }

  entries(relative, key) {
    return getOr(or(this.load(relative), {}), key, []);
  }

  /** Calls `onRecord` for the objects of a .jsonl file, without its header line. */
  lines(relative, onRecord) {
    const path = this.path(relative);
    if (!isFile(path)) return;
    let accepted = true;
    eachLine(path, (line, number) => {
      if (!accepted) return;
      const text = pyStrip(line);
      if (!text) return;
      if (number === 0) {
        // The header line names the schema; a file of another program is not read.
        let schema;
        try {
          schema = get(parseJson(text), "schema");
        } catch {
          schema = undefined;
        }
        if (!schemaAccepted(schema)) {
          accepted = false;
          this.log(`${relative}: schema ${pyStr(schema)} is not a dumper schema; skipped`);
        }
        return;
      }
      onRecord(parseJson(text));
    });
  }

  // ------------------------------------------------------------------ naming
  kind(item) {
    return this.kindOf.get(item);
  }

  /** Game content: the game's own code modules and everything outside /Script and /Engine. */
  isGame(path) {
    if (!truthy(path)) return false;
    if (path.startsWith("/Script/")) {
      return this.gameScriptRoots.some((root) => path.startsWith(root)) && [".", ""].includes(path.slice(this.rootOf(path).length).slice(0, 1));
    }
    return !path.startsWith("/Engine/");
  }

  rootOf(path) {
    for (const root of this.gameScriptRoots) if (path.startsWith(root)) return root;
    return "";
  }

  /** classes + /Game/A/B/BP_X.BP_X_C gives classes/Game/A/B/BP_X_C.md. */
  fileFor(section, path) {
    const dot = path.indexOf(".");
    const pkg = dot < 0 ? path : path.slice(0, dot);
    const name = dot < 0 ? "" : path.slice(dot + 1);
    let parts = pkg.split("/").filter((p) => p);
    if (!path.startsWith("/Script/") && parts.length) parts = parts.slice(0, -1);
    let shown = name.replaceAll(":", ".");
    if (!shown) shown = parts.length ? parts.pop() : "unnamed";
    const safe = [...parts, shown].map((p) => p.replace(/[<>:"|?*\\]/g, "_"));
    return [section, ...safe].join("/") + ".md";
  }

  /** A markdown link to the document of `path`, or plain code when it has none. */
  link(path, fromFile, text = null) {
    text = truthy(text) ? text : leaf(path);
    const target = this.docOf.get(path);
    if (fromFile === null) {
      // Plain text, for places where a link cannot be shown, such as inside code.
      if (truthy(path) && !target && !this.isGame(path)) this.engineRefs.add(path);
      return text;
    }
    if (!target) {
      if (truthy(path) && !this.isGame(path)) this.engineRefs.add(path);
      return `\`${text}\``;
    }
    return `[${text}](${relpath(target, dirname(fromFile))})`;
  }

  /** The C++-like type of a property, linking the types it names. */
  typeName(prop, fromFile, owner = null) {
    return reflection.typeName(this, prop, fromFile, owner);
  }

  /** A path relative to the folder of `fromFile`, as os.path.relpath gives it on Windows. */
  relative(target, fromFile) {
    return relpath(target, dirname(fromFile));
  }

  // ------------------------------------------------------------------ output
  add(file, kind, title, objectPath, summary, body, keywords = [], extra = null) {
    const front = [["kind", kind], ["title", title]];
    if (truthy(objectPath)) front.push(["path", objectPath]);
    for (const [k, v] of Object.entries(extra ?? {})) {
      const at = front.findIndex(([name]) => name === k);
      if (at >= 0) front[at][1] = v;
      else front.push([k, v]);
    }
    const header = "---\n" + front.map(([k, v]) => `${k}: ${pyDumps(v)}\n`).join("") + "---\n\n";
    this.files.set(file, header + pyRstrip(body) + "\n");
    this.records.push({
      id: truthy(objectPath) ? objectPath : file, kind, title, file, summary,
      keywords: sortedStrings(new Set(keywords.filter((k) => truthy(k)))).slice(0, 200),
    });
    this.addToFolder(dirname(file).replaceAll("\\", "/"), [title, file, summary]);
    if (this.section) this.pages.set(this.section, (this.pages.get(this.section) ?? 0) + 1);
  }

  addToFolder(folder, entry) {
    pushTo(this.folders, folder, entry);
  }

  /** Runs `fn` with the documents it adds counted for section `name`. */
  withSection(name, fn) {
    const previous = this.section;
    this.section = name;
    try {
      return fn();
    } finally {
      this.section = previous;
    }
  }

  /** The parents of a class or struct, nearest first. */
  chain(path) {
    const out = [];
    const seen = new Set();
    let current = get(this.byPath.get(path), "super");
    while (truthy(current) && !seen.has(current)) {
      seen.add(current);
      out.push(current);
      current = get(this.byPath.get(current), "super");
    }
    return out;
  }

  /** Decides the file of every document first, so links can point forward. */
  plan() {
    const section = { class: "classes", struct: "structs", enum: "enums" };
    for (const item of [...this.classes, ...this.structs, ...this.enums]) {
      const path = get(item, "path");
      if (this.isGame(path)) this.docOf.set(path, this.fileFor(section[this.kind(item)], path));
    }
  }

  // ------------------------------------------------------------------ finishing
  writeIndexes() {
    const folders = new Set(this.folders.keys());
    for (let folder of [...folders]) {
      while (folder) {
        folder = dirname(folder);
        folders.add(folder);
      }
    }
    const subfolders = new Map();
    for (const folder of folders) {
      if (!folder) continue;
      const parent = dirname(folder);
      if (!subfolders.has(parent)) subfolders.set(parent, new Set());
      subfolders.get(parent).add(folder);
    }
    const counts = new Map();
    const count = (folder) => {
      if (counts.has(folder)) return counts.get(folder);
      let n = (this.folders.get(folder) ?? []).length;
      for (const sub of subfolders.get(folder) ?? []) n += count(sub);
      counts.set(folder, n);
      return n;
    };

    for (const folder of sortedStrings(folders)) {
      if (!folder) continue;
      const lines = [`# ${folder}\n`];
      if (subfolders.get(folder)?.size) {
        lines.push("## Folders\n");
        for (const sub of sortedStrings(subfolders.get(folder))) {
          lines.push(`- [${basename(sub)}/](${basename(sub)}/_index.md): ${count(sub)} documents`);
        }
        lines.push("");
      }
      if (this.folders.get(folder)?.length) {
        lines.push("## Documents\n");
        for (const [title, file, summary] of sortedPy(this.folders.get(folder))) {
          lines.push(`- [${pyStr(title)}](${basename(file)}): ${pyStr(summary)}`);
        }
      }
      this.files.set(folder + "/_index.md", lines.join("\n") + "\n");
    }

    const top = sortedStrings(subfolders.get("") ?? []);
    const sections = top.map((t) => `- [${t}/](${t}/_index.md): ${count(t)} documents`).join("\n");
    const kinds = new Map();
    for (const record of this.records) countInto(kinds, record.kind);
    const m = this.manifest;
    const v = (key) => pyStr(get(m, key));
    this.files.set("README.md",
      `# ${pyStr(getOr(m, "game", "Game"))} modding reference\n\n`
      + `Generated from a GmfDumper run. Game executable ${v("game_exe_bytes")} bytes, link time `
      + `${v("game_exe_link_time")}; engine ${v("engine_version")}; UE4SS ${v("ue4ss_version")}; `
      + `dumped on map \`${v("map")}\` at ${v("started")}.\n\n`
      + "This is game content. Do not commit or publish it.\n\n"
      + `## Sections\n\n${sections}\n\n`
      + (this.missing.length
        ? "## Missing sections\n\nThese parts have no input in this run, so their pages are absent.\n\n"
          + this.missing.map((entry) => `- ${entry.name}: ${entry.reason}`).join("\n") + "\n\n"
        : "")
      + "## How to find something\n\n"
      + "- [overview.md](overview.md) names the classes that run the game by role, the game mode of each map and the "
      + "classes with the most Blueprint logic. Start there.\n"
      + "- Start at a section's `_index.md` and follow folders down. Folders mirror the game's content paths.\n"
      + "- `index.jsonl` has one JSON record per document (`id`, `kind`, `title`, `file`, `summary`, `keywords`) for a search index.\n"
      + "- Every document starts with YAML front matter: `kind`, `title` and, where it applies, `path`, `parent`, `class`.\n\n"
      + "## Conventions\n\n"
      + "- A `path` is the object path UE4SS uses: `/Game/Folder/Asset.Name` or `/Script/Module.Name`; a function is `Class:Function`.\n"
      + "- Members made in Blueprint carry a generated suffix. Tables show the readable name and give the raw name, which Lua needs.\n"
      + "- Offsets are hexadecimal, sizes are bytes.\n"
      + "- A function is hooked from a UE4SS Lua mod with `RegisterHook(\"<class path>:<FunctionName>\", callback)`. "
      + "The Hookable column says whether UE4SS accepts it: a native function runs the callback before and after, "
      + "a Blueprint function after.\n"
      + "- Engine types are stubs under `engine/`, listed only when the game refers to them.\n"
      + "- A Blueprint class with logic has a second page beside its own, `<Class>.script.md`: its functions as statements, "
      + "decoded from the bytecode.\n"
      + "- `Default values` on a class page lists what the class changes against its parent. Pages under `levels/<Map>/values/` "
      + "list what each placed actor changes against its class.\n"
      + "- `assets/` lists every asset of the game by content folder, with the object path a mod refers to.\n"
      + "- `Used by` on a class page lists the scripts of other classes that call its functions or touch its properties.\n"
      + "- A document over 100 KB is written in parts: `<name>.md`, `<name>.part2.md` and so on. The first part lists them.\n\n"
      + "## Contents\n\n" + sortedPy([...kinds.entries()]).map(([kind, n]) => `- ${kind}: ${n}`).join("\n") + "\n");
  }

  build() {
    const sections = [];
    this.plan();
    for (const section of SECTIONS) {
      const started = Date.now();
      this.withSection(section.name, () => section.write(this));
      const entry = { name: section.name, pages: this.pages.get(section.name) ?? 0 };
      if (section.missing) {
        const reason = section.missing(this);
        if (reason) entry.missing = reason;
      } else if (section.inputs.length && !section.inputs.some((input) => this.exists(input))) {
        entry.missing = this.missingReason(section);
      }
      if (entry.missing) this.missing.push({ name: entry.name, reason: entry.missing });
      sections.push(entry);
      this.log(`${section.name}: done in ${((Date.now() - started) / 1000).toFixed(1)} s${entry.missing ? ` (missing: ${entry.missing})` : ""}`);
    }
    this.withSection("reflection", () => {
      reflection.writeEngineStubs(this);
      reflection.writeReferencedBy(this);
    });
    // Level value pages are counted for the defaults section and engine stubs for reflection,
    // after those sections ran.
    for (const entry of sections) entry.pages = this.pages.get(entry.name) ?? 0;
    splitLarge(this);
    this.writeIndexes();
    return sections;
  }

  missingReason(section) {
    for (const step of getOr(this.manifest, "steps", [])) {
      if (!section.steps.includes(get(step, "id"))) continue;
      if (get(step, "status") === "skipped") {
        const reason = truthy(get(step, "reason")) ? pyStr(get(step, "reason")) : "skipped";
        // The mod's own words for a missing DLL, said so a reader knows what to repair.
        return reason === "native unavailable" ? "the native part did not load" : reason;
      }
      if (get(step, "status") === "failed") {
        const error = truthy(get(step, "error")) ? pyStr(get(step, "error")).split(/\r?\n/)[0].slice(0, 200) : "no error recorded";
        return `failed: ${error}`;
      }
    }
    return "not collected";
  }

  /** Writes every file and index.jsonl; returns { files, bytes }. */
  save() {
    const made = new Set();
    let bytes = 0;
    const write = (relative, text) => {
      const path = join(this.out, ...relative.split("/"));
      const folder = dirname(relative);
      if (!made.has(folder)) {
        mkdirSync(join(this.out, ...folder.split("/").filter(Boolean)), { recursive: true });
        made.add(folder);
      }
      const buffer = Buffer.from(text, "utf8");
      writeFileSync(path, buffer);
      bytes += buffer.length;
    };
    mkdirSync(this.out, { recursive: true });
    for (const [relative, text] of this.files) write(relative, text);
    write("index.jsonl", this.records.map((record) => pyDumps(record) + "\n").join(""));
    return { files: this.files.size + 1, bytes };
  }

  /** Every relative link in the output that does not lead to a file: "<file> -> <target>". */
  brokenLinks() {
    const broken = [];
    for (const [relative, text] of this.files) {
      const folder = dirname(relative);
      for (const match of text.matchAll(LINK)) {
        const target = match[1];
        if (target.includes("://")) continue;
        if (!this.files.has(joinNormal(folder, target))) broken.push(`${relative} -> ${target}`);
      }
    }
    return broken;
  }
}

/**
 * Builds the docs of the run folder `runDir` into `outDir` (created when absent). It writes
 * into `outDir` only and checks nothing about it. `options.log` receives progress lines;
 * `options.textDir` is the folder unreal.read_containers extracted pak text into
 * (`<workspace>/extracted/unreal/text`); without it the containers section is reported missing.
 */
export async function buildDocs(runDir, outDir, options = {}) {
  if (!existsSync(join(runDir, "manifest.json"))) throw new Error(`no manifest.json in ${runDir}`);
  const docs = new Docs(runDir, outDir, options);
  const sections = docs.build();
  const { files, bytes } = docs.save();
  const brokenLinks = docs.brokenLinks();
  const { functions, structured } = docs.scriptCounts;
  if (docs.structureScripts && functions) {
    docs.log(`scripts: ${structured} of ${functions} functions structured (${Math.round((structured / functions) * 100)}%)`);
  }
  docs.log(`wrote ${files} files, ${(bytes / 1e6).toFixed(1)} MB, to ${outDir}; ${brokenLinks.length} broken links`);
  return { files, bytes, brokenLinks, sections };
}

