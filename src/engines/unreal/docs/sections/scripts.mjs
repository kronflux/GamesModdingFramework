// Blueprint bytecode as statements: one page per game class that has Blueprint functions,
// beside the class page. Also records which classes' scripts use which members, for the
// "Used by" part of the class pages.

import { statSync } from "node:fs";
import { join } from "node:path";

import { disassemble, KismetError, loadNames, loadPointers } from "../kismet.mjs";
import { basename, eachLine, get, getOr, leaf, pyStrip, sortedBy, sortedStrings } from "../text.mjs";

const UBERGRAPH_CALL = /ExecuteUbergraph[\p{L}\p{N}_]*\(0x([0-9A-F]{4})\)/gu;

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function nested(map, first, second) {
  if (!map.has(first)) map.set(first, new Map());
  const inner = map.get(first);
  if (!inner.has(second)) inner.set(second, new Set());
  return inner.get(second);
}

/**
 * Disassembles Scripts/bytecode.jsonl and writes one page per game class that has Blueprint
 * functions, beside the class page. Fills docs.classNotes, docs.usedBy, docs.nameCalls and
 * docs.scriptStats.
 */
export function write(docs) {
  const path = join(docs.run, "Scripts", "bytecode.jsonl");
  if (!isFile(path)) return;
  const dump = join(docs.run, "Objects", "UE4SS_ObjectDump.txt");
  const namesFile = join(docs.run, "Names", "fnames.csv");
  const pointers = isFile(dump) ? loadPointers(dump) : new Map();
  const namesRecords = [];
  const byClass = new Map();
  eachLine(path, (raw) => {
    const line = pyStrip(raw);
    if (!line) return;
    const record = JSON.parse(line);
    if (record.type === "Names") namesRecords.push(record);
    else if (record.type === "Function" && record.script) {
      const at = record.path.lastIndexOf(":");
      const owner = at < 0 ? "" : record.path.slice(0, at);
      const fn = at < 0 ? record.path : record.path.slice(at + 1);
      if (docs.docOf.has(owner)) {
        if (!byClass.has(owner)) byClass.set(owner, []);
        byClass.get(owner).push([fn, record.script]);
      }
    }
  });
  const names = loadNames(isFile(namesFile) ? namesFile : null, namesRecords);

  for (const [classPath, functions] of byClass) {
    const classFile = docs.docOf.get(classPath);
    const file = classFile.slice(0, -3) + ".script.md";
    const decoded = [];
    const entries = new Map();
    let unresolved = 0;
    for (const [fn, script] of sortedBy(functions, (f) => [f[0].startsWith("ExecuteUbergraph"), f[0]])) {
      const refs = new Set();
      const called = new Set();
      let result;
      try {
        result = disassemble(Buffer.from(script, "base64"), pointers, names, refs, called);
        unresolved += result.unresolved;
      } catch (error) {
        if (!(error instanceof KismetError)) throw error;
        decoded.push([fn, null, error.message]);
        continue;
      }
      // What this function uses of other classes: a member is Class:Name; a path with a
      // second colon is a local variable or parameter of a function.
      for (const ref of refs) {
        const colon = ref.indexOf(":");
        if (colon < 0) continue;
        const owner = ref.slice(0, colon);
        const member = ref.slice(colon + 1);
        if (!member.includes(":") && owner !== classPath) nested(docs.usedBy, ref, classPath).add(fn);
      }
      for (const calledName of called) nested(docs.nameCalls, calledName, classPath).add(fn);
      for (const statement of result.statements) {
        for (const match of statement.text.matchAll(UBERGRAPH_CALL)) {
          const offset = Number.parseInt(match[1], 16);
          if (!entries.has(offset)) entries.set(offset, []);
          entries.get(offset).push(fn);
        }
      }
      decoded.push([fn, result.statements, null]);
    }
    const name = leaf(classPath);
    const body = [`# Script of ${name}\n`,
      `The Blueprint functions of [${name}](${basename(classFile)}) as statements, decoded from the bytecode the game `
      + "runs. Each line starts with its offset in the function. `goto 0x0040` jumps to that offset; `push` and `pop` keep "
      + "the offsets a sequence returns to. An event is a short function that calls the class's `ExecuteUbergraph` function "
      + "with the offset where its logic starts; those offsets are marked `; entry of <event>`.\n"];
    if (unresolved) body.push(`${unresolved} references could not be resolved and are shown as \`<0x...>\` or \`<name N>\`.\n`);
    for (const [fn, statements, error] of decoded) {
      body.push(`## ${fn}\n`);
      if (statements === null) {
        body.push(`This function could not be decoded: ${error}.\n`);
        continue;
      }
      const lines = statements.map(({ offset, text }) => {
        const mark = fn.startsWith("ExecuteUbergraph") && entries.has(offset) ? `    ; entry of ${entries.get(offset).join(", ")}` : "";
        return `${offset.toString(16).toUpperCase().padStart(4, "0")}: ${text}${mark}`;
      });
      body.push("```text\n" + lines.join("\n") + "\n```\n");
    }
    docs.add(file, "script", `Script of ${name}`, null, `${decoded.length} Blueprint functions of ${name} as statements`,
      body.join("\n"), decoded.map(([fn]) => fn));
    if (!docs.classNotes.has(classPath)) docs.classNotes.set(classPath, []);
    docs.classNotes.get(classPath).push(`**Script:** [${decoded.length} functions as statements](${basename(file)})\n`);
    const statementCount = decoded.reduce((sum, [, statements]) => sum + (statements ?? []).length, 0);
    docs.scriptStats.set(classPath, [file, statementCount, decoded.length]);
  }
}

/** "[BP_A](..): `F1`, `F2`; [BP_B](..): `G`" for a Map of class path to a Set of function names. */
export function usersText(docs, users, ownClass, file) {
  const out = [];
  const classes = sortedStrings([...users.keys()].filter((c) => c !== ownClass));
  for (const classPath of classes.slice(0, 8)) {
    const target = docs.scriptStats.has(classPath) ? docs.scriptStats.get(classPath)[0] : docs.docOf.get(classPath);
    const functions = sortedStrings(users.get(classPath));
    const names = functions.slice(0, 4).map((name) => `\`${name}\``).join(", ") + (functions.length > 4 ? ` and ${functions.length - 4} more` : "");
    const link = target ? `[${leaf(classPath)}](${docs.relative(target, file)})` : `\`${leaf(classPath)}\``;
    out.push(`${link}: ${names}`);
  }
  if (classes.length > 8) out.push(`and ${classes.length - 8} more classes`);
  return out.join("; ");
}

/**
 * The '## Used by' part of a class page: the scripts of other classes that call its functions
 * or touch its properties. null when there are none.
 */
export function usedBySection(docs, item, file) {
  const rows = [];
  const path = get(item, "path");
  const none = new Map();
  for (const prop of getOr(item, "properties", [])) {
    const text = usersText(docs, docs.usedBy.get(`${path}:${get(prop, "name")}`) ?? none, path, file);
    if (text) rows.push(`| \`${get(prop, "name")}\` | ${text} |`);
  }
  for (const fn of docs.functionsOf.get(path) ?? []) {
    const fnName = get(fn, "name");
    const text = usersText(docs, docs.usedBy.get(get(fn, "path")) ?? none, path, file);
    if (text) rows.push(`| \`${fnName}\` | ${text} |`);
    // A call by name says which function name, not which class. It is listed when few classes
    // have a function of that name; a name every class has, such as ReceiveBeginPlay, would be
    // listed everywhere.
    if ((docs.functionOwners.get(fnName) ?? 0) <= 5) {
      const byName = usersText(docs, docs.nameCalls.get(fnName) ?? none, path, file);
      if (byName) rows.push(`| \`${fnName}\` (by name) | ${byName} |`);
    }
  }
  if (!rows.length) return null;
  return "## Used by\n\nThe Blueprint scripts of other classes that call a function of this class or read or write one of its "
    + "properties, each with the functions that do. \"By name\" is a call that names the function only; it may be meant "
    + "for another class that has a function of the same name.\n\n| Member | Used in |\n|---|---|\n" + rows.join("\n") + "\n";
}
