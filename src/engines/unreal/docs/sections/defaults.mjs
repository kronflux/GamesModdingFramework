// Default values: Reflection/class_defaults.jsonl gives the default object and the component
// templates of each class. The class pages show what a class changes against its parent, and
// one page per actor class of a level shows what the placed actors change against their class.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  cpLen, cpSlice, eachLine, entries, get, isDict, isList, leaf, or, parseJson, pyDumps, pyDumpsAscii, size, sortedPy,
  sortedStrings,
} from "../text.mjs";

export const MAX_VALUE = 300;
export const MAX_ROWS = 400;
export const WIDE_COLUMNS = 6;
export const LINE_HEAD =
  /^\{"path":\s*"((?:[^"\\]|\\.)*)"\s*,\s*"class":\s*"((?:[^"\\]|\\.)*)"(?:\s*,\s*"owner_class":\s*"((?:[^"\\]|\\.)*)")?/;

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function safe(name) {
  return name.replace(/[<>:"|?*\\/]/g, "_");
}

export function scalar(value) {
  return typeof value === "string" ? value : pyDumps(value);
}

export function cut(text) {
  return cpLen(text) <= MAX_VALUE ? text : cpSlice(text, MAX_VALUE) + " ...";
}

/** A value as a table cell: code, with the characters a table cannot hold replaced. */
export function cell(text) {
  return "`" + cut(text).replaceAll("|", "\\|").replaceAll("`", "'").replaceAll("\n", " ") + "`";
}

/**
 * Nested values as a Map of dotted name to text. A small struct of plain values, such as a
 * vector, stays one entry: X=1 Y=2 Z=3.
 */
export function flat(values, prefix = "", out = new Map()) {
  for (const [key, value] of entries(values)) {
    const name = prefix + key;
    if (isDict(value) && size(value)) {
      const items = entries(value);
      if (items.length <= 4 && !items.some(([, v]) => isDict(v) || isList(v))) {
        out.set(name, items.map(([k, v]) => `${k}=${scalar(v)}`).join(" "));
      } else {
        flat(value, name + ".", out);
      }
    } else if (isDict(value) || isList(value)) {
      out.set(name, pyDumps(value));
    } else {
      out.set(name, scalar(value));
    }
  }
  return out;
}

/** rows: [[key, value]]. */
export function table(rows, head = ["Property", "Value"]) {
  const lines = [`| ${head[0]} | ${head[1]} |`, "|---|---|"];
  for (const [key, value] of rows.slice(0, MAX_ROWS)) lines.push(`| ${key} | ${cell(value)} |`);
  if (rows.length > MAX_ROWS) lines.push(`\nThe first ${MAX_ROWS} of ${rows.length} are shown; the rest are in the dump.`);
  return lines.join("\n");
}

function unescape(part) {
  return part ? JSON.parse(`"${part}"`) : null;
}

function nameLeaf(path) {
  const text = path.replaceAll(":", ".");
  return text.slice(text.lastIndexOf(".") + 1);
}

/**
 * Reflection/class_defaults.jsonl: the default object of each class and the component
 * templates of each class. The file is large, so it is indexed once and a line is parsed only
 * when a class is asked for.
 */
export class Defaults {
  constructor(docs) {
    this.docs = docs;
    this.path = join(docs.run, "Reflection", "class_defaults.jsonl");
    this.holderAt = new Map();       // file offset -> path that is "self" for that line
    this.cdoAt = new Map();          // class path -> file offset
    this.templatesAt = new Map();    // owner class -> component name -> [class path, offset]
    this.cache = new Map();
    this.available = isFile(this.path);
    if (!this.available) return;
    const data = readFileSync(this.path);
    this.data = data;
    const defaultObjects = new Map();  // default object path -> class path
    const templates = (owner) => {
      if (!this.templatesAt.has(owner)) this.templatesAt.set(owner, new Map());
      return this.templatesAt.get(owner);
    };
    let offset = 0;
    while (offset < data.length) {
      const newline = data.indexOf(10, offset);
      const end = newline < 0 ? data.length : newline + 1;
      const head = LINE_HEAD.exec(data.toString("utf8", offset, Math.min(end, offset + 4000)));
      if (head) {
        const path = unescape(head[1]);
        const classPath = unescape(head[2]);
        let owner = unescape(head[3]);
        let skip = false;
        if (!owner && path.includes(":")) {
          // A template without owner_class: the part of its path before the colon is the
          // class it belongs to, or that class's default object.
          const colon = path.indexOf(":");
          const holder = path.slice(0, colon);
          if (path.slice(colon + 1).includes(":")) skip = true;
          else {
            owner = defaultObjects.has(holder) ? defaultObjects.get(holder) : holder;
            this.holderAt.set(offset, holder);
          }
        } else if (!owner) {
          defaultObjects.set(path, classPath);
          this.holderAt.set(offset, path);
        } else {
          this.holderAt.set(offset, path.split(":")[0]);
        }
        if (!skip) {
          if (owner) {
            let name = nameLeaf(path);
            if (name.endsWith("_GEN_VARIABLE")) name = name.slice(0, -"_GEN_VARIABLE".length);
            const map = templates(owner);
            if (!map.has(name)) map.set(name, [classPath, offset]);
          } else if (!this.cdoAt.has(classPath)) {
            this.cdoAt.set(classPath, offset);
          }
        }
      }
      offset = end;
    }
    // A template that came before the line of its default object was filed under the default
    // object's path; move it to the class.
    for (const [holder, classPath] of defaultObjects) {
      if (this.templatesAt.has(holder)) {
        const moved = this.templatesAt.get(holder);
        this.templatesAt.delete(holder);
        const map = templates(classPath);
        for (const [name, found] of moved) if (!map.has(name)) map.set(name, found);
      }
    }
  }

  valuesAt(offset) {
    if (!this.cache.has(offset)) {
      const newline = this.data.indexOf(10, offset);
      let line = this.data.toString("utf8", offset, newline < 0 ? this.data.length : newline + 1);
      // A default object points at its own components by its own path. With that path written
      // as <self>, a class and its parent, and an actor and its class, compare equal where
      // they point at the same component.
      const holder = this.holderAt.get(offset);
      if (holder) {
        const at = line.indexOf('"values"');
        if (at >= 0) {
          const cutAt = at + '"values"'.length;
          line = line.slice(0, cutAt) + line.slice(cutAt).replaceAll(pyDumpsAscii(holder).slice(1, -1), "<self>");
        }
      }
      this.cache.set(offset, flat(or(get(parseJson(line), "values"), {})));
    }
    return this.cache.get(offset);
  }

  /** The default values of exactly this class, or null when the dump has none. */
  own(classPath) {
    const offset = this.cdoAt.get(classPath);
    return offset === undefined ? null : this.valuesAt(offset);
  }

  /** The default values of this class, or of its nearest parent that has some. */
  of(classPath) {
    for (const candidate of [classPath, ...this.docs.chain(classPath)]) {
      const values = this.own(candidate);
      if (values !== null) return values;
    }
    return new Map();
  }

  /**
   * [component class, values] of the component template `name` that an actor of this class
   * starts from, looked up through the parents; null when there is none.
   */
  template(classPath, name, includeOwn = true) {
    const candidates = [...(includeOwn ? [classPath] : []), ...this.docs.chain(classPath)];
    for (const candidate of candidates) {
      const found = this.templatesAt.get(candidate)?.get(name);
      if (found) return [found[0], this.valuesAt(found[1])];
    }
    return null;
  }

  /** The '## Default values' part of a class page, or null. */
  classSection(item, file) {
    const path = get(item, "path");
    const own = this.own(path);
    const templates = this.templatesAt.get(path) ?? new Map();
    if (own === null && !templates.size) return null;
    const docs = this.docs;
    const parents = docs.chain(path);
    const out = ["## Default values\n"];
    if (own !== null) {
      const base = parents.length ? this.of(parents[0]) : new Map();
      const rows = [...own].filter(([key, value]) => base.get(key) !== value);
      const against = parents.length ? `its parent ${docs.link(parents[0], file)}` : "nothing, as it has no parent";
      if (rows.length) out.push(`The values of the default object that differ from ${against}: ${rows.length} of ${own.size}.\n\n${table(rows)}\n`);
      else out.push(`No value of the default object differs from ${against}.\n`);
    }
    for (const name of sortedStrings(templates.keys())) {
      const [classPath, offset] = templates.get(name);
      const values = this.valuesAt(offset);
      const inherited = this.template(path, name, false);
      const base = inherited ? inherited[1] : this.of(classPath);
      const rows = [...values].filter(([key, value]) => base.get(key) !== value);
      const against = inherited ? "the same component of the parent class" : "the defaults of its class";
      out.push(`### ${name}\n\n${docs.link(classPath, file)}, a component of this class. `
        + (rows.length ? `Values that differ from ${against}:\n\n${table(rows)}\n` : `No value differs from ${against}.\n`));
    }
    return out.join("\n");
  }
}

/** The defaults section: indexes the class defaults for the sections that follow. */
export function write(docs) {
  docs.defaults = new Defaults(docs);
}

/**
 * One page per actor class of a level, with the values that differ from what the class starts
 * out with. Returns a sentence for the actor page, or "" when nothing was written.
 */
export function writeLevelValues(docs, source, section, mapName) {
  const defaults = docs.defaults;
  const path = join(docs.run, ...source.split("/"), "actor_values.jsonl");
  if (!isFile(path)) return "";
  const byClass = new Map();   // class path -> [[actor name, Map of name -> text]]
  eachLine(path, (line, number) => {
    const head = LINE_HEAD.exec(line.slice(0, 4000));
    if (!number || !head) return;
    const actorPath = JSON.parse(`"${head[1]}"`);
    // A value that points at the actor itself or at one of its components differs for every
    // actor only by that path; with the path replaced it compares equal.
    const record = parseJson(line.replaceAll(head[1], "<self>"));
    const classPath = or(get(record, "class"), "");
    if (leaf(classPath) === "WorldSettings" && !docs.gameModeOf.has(section)) {
      // The game mode the map asks for; the overview lists it per map.
      docs.gameModeOf.set(section, get(or(get(record, "values"), {}), "DefaultGameMode") ?? null);
    }
    if (!defaults.available) return;
    let base = defaults.of(classPath);
    // A pointer to one of the actor's own components is wiring every actor of the class has; a
    // Blueprint class sets it when the actor is built, so it is not in the class defaults and
    // would show on every actor.
    const components = or(get(record, "components"), []);
    const ownParts = new Set(components.map((component) => "<self>:" + or(get(component, "name"), "")));
    const differing = new Map();
    for (const [key, value] of flat(or(get(record, "values"), {}))) {
      if (base.get(key) !== value && !ownParts.has(value)) differing.set(key, value);
    }
    for (const component of components) {
      const name = or(get(component, "name"), "?");
      const template = defaults.template(classPath, name);
      base = template ? template[1] : defaults.of(or(get(component, "class"), ""));
      for (const [key, value] of flat(or(get(component, "values"), {}))) {
        if (base.get(key) !== value && !ownParts.has(value)) differing.set(`${name}.${key}`, value);
      }
    }
    if (!byClass.has(classPath)) byClass.set(classPath, []);
    byClass.get(classPath).push([leaf(actorPath), differing]);
  });

  const used = new Map();
  for (const classPath of sortedStrings(byClass.keys())) {
    const actors = byClass.get(classPath);
    const stem = safe(leaf(classPath)) || "unnamed";
    const lower = stem.toLowerCase();
    const count = (used.get(lower) ?? 0) + 1;
    used.set(lower, count);
    const file = `${section}/values/${count === 1 ? stem : `${stem}_${count}`}.md`;
    const word = actors.length === 1 ? "actor" : "actors";
    const body = [`# ${leaf(classPath)} in ${mapName}\n`,
      `${actors.length} ${word} of class ${docs.link(classPath, file)} placed in this level. A value is shown only where it `
      + "differs from what the class starts out with: its default object, and for a component the component template of "
      + "the class. `<self>` stands for the actor's own path.\n"];
    const keys = new Set();
    if (actors.length === 1) {
      const rows = sortedPy([...actors[0][1]]);
      for (const [key] of rows) keys.add(key);
      body.push(`## Values that differ from the class defaults\n\nActor \`${actors[0][0]}\`.\n\n` + (rows.length ? table(rows) : "None.") + "\n");
    } else {
      const first = actors[0][1];
      const shared = new Map([...first].filter(([key, value]) => actors.every(([, other]) => other.get(key) === value)));
      for (const key of shared.keys()) keys.add(key);
      body.push("## Same on every actor\n\n" + (shared.size ? table(sortedPy([...shared])) : "Nothing.") + "\n");
      const varyingSet = new Set();
      for (const [, values] of actors) for (const key of values.keys()) if (!shared.has(key)) varyingSet.add(key);
      const varying = sortedStrings(varyingSet);
      for (const key of varying) keys.add(key);
      if (varying.length) {
        body.push("## Per actor\n");
        const shown = actors.slice(0, MAX_ROWS);
        if (varying.length <= WIDE_COLUMNS) {
          body.push("| Actor | " + varying.join(" | ") + " |\n|---|" + "---|".repeat(varying.length));
          for (const [name, values] of shown) {
            body.push(`| \`${name}\` | ` + varying.map((key) => (values.has(key) ? cell(values.get(key)) : "")).join(" | ") + " |");
          }
          body.push("");
        } else {
          for (const [name, values] of shown) {
            const rows = sortedPy([...values].filter(([key]) => !shared.has(key)));
            body.push(`### \`${name}\`\n\n` + (rows.length ? table(rows) : "Nothing beyond the shared values.") + "\n");
          }
        }
        if (actors.length > MAX_ROWS) body.push(`The first ${MAX_ROWS} of ${actors.length} actors are shown; the rest are in the dump.\n`);
      }
    }
    docs.withSection("defaults", () => docs.add(file, "level_values", `${leaf(classPath)} in ${mapName}`, null,
      `${actors.length} ${word}, values that differ from the class defaults`, body.join("\n"), sortedStrings(keys)));
  }
  if (!byClass.size) return "";
  return "\nThe values of these actors that differ from their class defaults are in [values/](values/_index.md), "
    + "one page per class.\n";
}
