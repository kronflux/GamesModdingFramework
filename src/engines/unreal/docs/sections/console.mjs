// Console variable names, found as text in the game executable, with the values the game's own
// ini files give them.
//
// A shipping build has no command that lists its console variables, and the engine's registry
// cannot be read without memory layouts for each engine version. Every console variable name is
// a UTF-16 string literal in the executable, so the names are read from there. Help text is not
// stored next to its name, so it is not shown. Strings that look like a console variable but are
// a property path ("KismetMathLibrary.Abs") are removed when their first part is a type the
// reflection dump names.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { decodeText, parseIni } from "../ini.mjs";
import { get, sortedStrings } from "../text.mjs";

// UTF-16LE runs of printable ASCII, at least four characters.
const UTF16_RUN = /(?:[\x20-\x7e]\x00){4,}/g;
const NAME = /^[A-Za-z][A-Za-z0-9]{0,24}(?:\.[A-Za-z0-9_]+){1,5}$/;
const DIGITS_LAST = /\.[0-9]+$/;
const MIN_GROUP = 5;
const OTHER_FILE = "_other.md";
const FILE_LIKE =/\.(?:ini|uasset|umap|json|png|jpg|dll|exe|txt|log|cpp|h|hpp|inl|usf|ush|pak|utoc|ucas|com|org|net|io|html|xml|csv|bin|dat|wav|ogg|ttf|otf)$/i;

/** The sorted, unique strings in `buffer` that have the shape of a console variable name. */
export function scanConsoleNames(buffer) {
  const text = buffer.toString("latin1");
  const names = new Set();
  for (const match of text.matchAll(UTF16_RUN)) {
    const value = match[0].replaceAll("\x00", "");
    if (NAME.test(value) && !FILE_LIKE.test(value) && !DIGITS_LAST.test(value)) names.add(value);
  }
  return sortedStrings(names);
}

function iniFiles(dir, found = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) iniFiles(full, found);
    else if (/\.ini$/i.test(entry.name)) found.push(full);
  }
  return found;
}

// Sections whose keys are console variables: [SystemSettings], [ConsoleVariables], and the
// scalability groups such as [ShadowQuality@2].
function isConsoleSection(name) {
  return name === "SystemSettings" || name === "ConsoleVariables" || /^[A-Za-z]+@[0-9A-Za-z]+$/.test(name);
}

/**
 * Console variable values set by the ini files under `textDir`: name -> [{ value, file, section }].
 * Device profiles give theirs as `CVars=name=value` lines.
 */
export function iniConsoleValues(textDir) {
  const values = new Map();
  const push = (name, entry) => {
    if (!values.has(name)) values.set(name, []);
    values.get(name).push(entry);
  };
  for (const file of iniFiles(textDir)) {
    let parsed;
    try {
      parsed = parseIni(decodeText(readFileSync(file)));
    } catch {
      continue;
    }
    const relative = file.slice(textDir.length + 1).replaceAll("\\", "/");
    for (const section of parsed.sections) {
      for (const { key, value, op } of section.entries) {
        if (op === "-" || op === "!") continue;
        if (isConsoleSection(section.name) && NAME.test(key)) {
          push(key, { value, file: relative, section: section.name });
        } else if (key === "CVars") {
          const eq = value.indexOf("=");
          const name = eq < 0 ? "" : value.slice(0, eq).trim();
          if (NAME.test(name)) push(name, { value: value.slice(eq + 1).trim(), file: relative, section: section.name });
        }
      }
    }
  }
  return values;
}

function reflectedNames(docs) {
  const names = new Set();
  for (const item of [...docs.classes, ...docs.structs, ...docs.enums]) {
    const name = get(item, "name");
    if (typeof name === "string" && name) names.add(name);
  }
  return names;
}

function cell(text) {
  return String(text).replaceAll("|", "\\|").replaceAll("`", "'");
}

/** The console section: console/overview.md and one page per name prefix; the builder writes _index.md. */
export function write(docs) {
  if (!docs.gameExe) return;
  let buffer;
  try {
    buffer = readFileSync(docs.gameExe);
  } catch (error) {
    docs.log(`console: cannot read ${docs.gameExe}: ${error.message}`);
    return;
  }
  const types = reflectedNames(docs);
  const scanned = scanConsoleNames(buffer);
  const names = scanned.filter((name) => !types.has(name.split(".")[0]));
  const values = docs.textDir ? iniConsoleValues(docs.textDir) : new Map();
  // A name an ini file sets is a console variable even when the executable scan missed it.
  const all = sortedStrings(new Set([...names, ...values.keys()]));
  if (!all.length) return;

  // One page per prefix that has at least MIN_GROUP names; the rest share one page.
  const byPrefix = new Map();
  for (const name of all) {
    const prefix = name.split(".")[0];
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(name);
  }
  const groups = new Map();
  const rest = [];
  for (const prefix of sortedStrings(byPrefix.keys())) {
    if (byPrefix.get(prefix).length >= MIN_GROUP) groups.set(prefix, byPrefix.get(prefix));
    else rest.push(...byPrefix.get(prefix));
  }
  // File names are compared without case, because "net" and "Net" are one file on Windows.
  const files = new Map();
  const taken = new Set([OTHER_FILE]);
  for (const prefix of groups.keys()) {
    const base = prefix.toLowerCase();
    let file = `${base}.md`;
    for (let n = 2; taken.has(file); n += 1) file = `${base}-${n}.md`;
    taken.add(file);
    files.set(prefix, `console/${file}`);
  }
  const pages = [...groups.entries()].map(([prefix, list]) => ({ title: prefix, file: files.get(prefix), list }));
  if (rest.length) pages.push({ title: "other prefixes", file: `console/${OTHER_FILE}`, list: sortedStrings(rest) });

  const set = all.filter((name) => values.has(name));
  const index = [
    "# Console variables\n",
    `${all.length} names that have the shape of a console variable: ${names.length} found as text in the game executable `
    + `and ${set.length} set by the game's ini files. The executable scan also finds some names that are not console `
    + "variables, such as stat names; a name an ini file sets is a real console variable. Help text and current values "
    + "are not shown: a shipping build has no command that lists them.\n",
    "To change a console variable, add `name=value` under `[SystemSettings]` in the game's `Engine.ini` in the user "
    + "settings folder, or set it from a mod.\n",
  ];
  if (set.length) {
    index.push("## Set by the game's ini files\n");
    index.push("| Name | Value | File | Section |\n|---|---|---|---|");
    for (const name of set) {
      for (const entry of values.get(name)) {
        index.push(`| \`${cell(name)}\` | \`${cell(entry.value)}\` | ${cell(entry.file)} | ${cell(entry.section)} |`);
      }
    }
    index.push("");
  }
  index.push("The names, one page per prefix, are listed in [the folder index](_index.md).\n");
  docs.add("console/overview.md", "console_overview", "Console variables", null,
    `${all.length} console variable names, ${set.length} set by ini files`, index.join("\n") + "\n", ["console", "cvar"]);

  for (const { title, file, list } of pages) {
    const body = [`# Console variables: ${title}\n`, `${list.length} names. [Overview](overview.md), [all pages](_index.md)\n`];
    for (const name of list) {
      const entries = values.get(name);
      body.push(entries
        ? `- \`${name}\`: ${entries.map((entry) => `\`${cell(entry.value)}\` in ${cell(entry.file)} [${cell(entry.section)}]`).join("; ")}`
        : `- \`${name}\``);
    }
    docs.add(file, "console", `Console variables: ${title}`, null, `${list.length} console variable names`,
      body.join("\n") + "\n", [title]);
  }
  docs.log(`console: ${scanned.length} names in the executable, ${scanned.length - names.length} removed as type paths, `
    + `${set.length} set by ini files`);
}
