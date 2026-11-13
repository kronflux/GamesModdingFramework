#!/usr/bin/env node
// Compares two generated docs folders file by file.
//
// Usage: node scripts/dev/compare-docs.mjs <dirA> <dirB>
//
// Every number token on both sides is replaced with String(Number(token)) before the bytes are
// compared, so "1.0" against "1" or "1e-05" against "0.00001" is not a difference; anything
// else is. A file present on one side only is a difference. Prints up to 20 differing files,
// each with its first differing line from both sides, then `<n> differing files`. Exit code 1
// when n is not 0. The marker file `.gmfdocs` is ignored.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const NUMBER = /-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g;
const IGNORED = new Set([".gmfdocs"]);
const SHOWN = 20;

/** Relative paths ("/"-separated) of every file under `root`. */
export function listFiles(root) {
  const out = [];
  const walk = (folder, prefix) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(folder, entry.name), relative);
      else if (entry.isFile() && !IGNORED.has(relative)) out.push(relative);
    }
  };
  walk(root, "");
  return out.sort();
}

export function normalize(text) {
  return text.replace(NUMBER, (token) => String(Number(token)));
}

function firstDifference(a, b) {
  const left = a.split("\n");
  const right = b.split("\n");
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i += 1) {
    if (normalize(left[i] ?? "") !== normalize(right[i] ?? "") || (left[i] === undefined) !== (right[i] === undefined)) {
      return { line: i + 1, a: left[i] ?? "<no line>", b: right[i] ?? "<no line>" };
    }
  }
  return { line: n, a: "<same lines>", b: "<same lines>" };
}

/** Compares two folders; returns { differing: [{ file, detail }], filesA, filesB }. */
export function compareDocs(dirA, dirB) {
  const filesA = listFiles(dirA);
  const filesB = listFiles(dirB);
  const inB = new Set(filesB);
  const inA = new Set(filesA);
  const differing = [];
  for (const file of filesA) {
    if (!inB.has(file)) {
      differing.push({ file, detail: `only in ${dirA}` });
      continue;
    }
    const a = readFileSync(join(dirA, ...file.split("/")));
    const b = readFileSync(join(dirB, ...file.split("/")));
    if (a.equals(b)) continue;
    const textA = a.toString("utf8");
    const textB = b.toString("utf8");
    if (normalize(textA) === normalize(textB)) continue;
    const diff = firstDifference(textA, textB);
    differing.push({ file, detail: `line ${diff.line}\n    A: ${diff.a}\n    B: ${diff.b}` });
  }
  for (const file of filesB) if (!inA.has(file)) differing.push({ file, detail: `only in ${dirB}` });
  return { differing, filesA: filesA.length, filesB: filesB.length };
}

function main(argv) {
  if (argv.length !== 2) {
    process.stderr.write("usage: node scripts/dev/compare-docs.mjs <dirA> <dirB>\n");
    return 2;
  }
  const { differing, filesA, filesB } = compareDocs(argv[0], argv[1]);
  process.stdout.write(`${filesA} files in A, ${filesB} files in B\n`);
  for (const { file, detail } of differing.slice(0, SHOWN)) process.stdout.write(`${file}: ${detail}\n`);
  process.stdout.write(`${differing.length} differing files\n`);
  return differing.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
