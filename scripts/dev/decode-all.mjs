#!/usr/bin/env node
// Decodes every Blueprint function of a dumper run and prints one line:
// `<n> decoded, <f> failed, <u> unresolved`.
//
// Usage: node scripts/dev/decode-all.mjs <run folder> [--structure]
//
// The run folder holds Scripts/bytecode.jsonl, Objects/UE4SS_ObjectDump.txt and
// Names/fnames.csv. A function that does not decode is counted as failed; the rest still
// decode. `--structure` also structures every decoded function and prints
// `structured <s> of <n>, <m> statement count mismatches` and the reasons functions stayed flat,
// most frequent first.

import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { disassemble, KismetError, loadNames, loadPointers } from "../../src/engines/unreal/docs/kismet.mjs";
import { structure } from "../../src/engines/unreal/docs/structure.mjs";

/** Reads bytecode.jsonl: the Function records that carry a script, and every Names record. */
export async function readBytecode(path) {
  const functions = [];
  const namesRecords = [];
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const record = JSON.parse(line);
    if (record.type === "Names") namesRecords.push(record);
    else if (record.type === "Function" && record.script) functions.push({ path: record.path, script: record.script });
  }
  return { functions, namesRecords };
}

/** Loads the lookups of a run the way the docs builder does. */
export async function loadRun(run) {
  const bytecode = join(run, "Scripts", "bytecode.jsonl");
  if (!existsSync(bytecode)) throw new Error(`no Scripts/bytecode.jsonl in ${run}`);
  const dump = join(run, "Objects", "UE4SS_ObjectDump.txt");
  const csv = join(run, "Names", "fnames.csv");
  const { functions, namesRecords } = await readBytecode(bytecode);
  const pointers = existsSync(dump) ? loadPointers(dump) : new Map();
  const names = loadNames(existsSync(csv) ? csv : null, namesRecords);
  return { functions, pointers, names };
}

async function main(argv) {
  const structureAll = argv.includes("--structure");
  const args = argv.filter((arg) => arg !== "--structure");
  if (args.length !== 1) {
    process.stderr.write("usage: node scripts/dev/decode-all.mjs <run folder> [--structure]\n");
    return 2;
  }
  const { functions, pointers, names } = await loadRun(args[0]);
  let decoded = 0;
  let failed = 0;
  let unresolved = 0;
  let structured = 0;
  const flatReasons = new Map();
  for (const fn of functions) {
    try {
      const result = disassemble(Buffer.from(fn.script, "base64"), pointers, names, new Set(), new Set());
      decoded += 1;
      unresolved += result.unresolved;
      if (structureAll) {
        const shape = structure(result.statements);
        if (shape.kind === "structured") structured += 1;
        else flatReasons.set(shape.reason, (flatReasons.get(shape.reason) ?? 0) + 1);
      }
    } catch (error) {
      if (!(error instanceof KismetError)) throw error;
      failed += 1;
      process.stderr.write(`${fn.path}: ${error.message}\n`);
    }
  }
  process.stdout.write(`${decoded} decoded, ${failed} failed, ${unresolved} unresolved\n`);
  if (structureAll) {
    const mismatches = flatReasons.get("statement count mismatch") ?? 0;
    process.stdout.write(`structured ${structured} of ${decoded}, ${mismatches} statement count mismatches\n`);
    const reasons = [...flatReasons].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    process.stdout.write(`flat: ${reasons.map(([reason, count]) => `${count} ${reason}`).join("; ") || "none"}\n`);
  }
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
