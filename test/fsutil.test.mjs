// Shared file helpers: a JSON read that tells a missing file from a broken one,
// an atomic JSON write, path containment and a readdir that never throws.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJson, writeJsonAtomic, isInside, safeReaddir } from "../src/core/fsutil.mjs";

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmf-fsutil-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("readJson returns the fallback for a missing file and throws GMF-E-FILE-002 for a broken one", (t) => {
  const dir = tempDir(t);
  assert.deepEqual(readJson(path.join(dir, "missing.json"), { a: 1 }), { a: 1 });
  const broken = path.join(dir, "broken.json");
  fs.writeFileSync(broken, "{");
  assert.throws(() => readJson(broken, null), (error) => error.code === "GMF-E-FILE-002" && error.message.includes("broken.json"));
  assert.equal(fs.readFileSync(broken, "utf8"), "{", "the broken file is untouched");
  const good = path.join(dir, "good.json");
  fs.writeFileSync(good, '{"b":2}');
  assert.deepEqual(readJson(good, null), { b: 2 });
});

test("writeJsonAtomic leaves no temp file and replaces the content", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "nested", "data.json");
  writeJsonAtomic(file, { x: 1 });
  writeJsonAtomic(file, { x: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { x: 2 });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["data.json"]);
  assert.ok(fs.readFileSync(file, "utf8").endsWith("\n"));
});

test("isInside accepts the root, children and ..foo, and rejects .., parents and other drives", (t) => {
  const dir = tempDir(t);
  assert.equal(isInside(dir, dir), true);
  assert.equal(isInside(dir, path.join(dir, "a", "b")), true);
  assert.equal(isInside(dir, path.join(dir, "..foo")), true);
  assert.equal(isInside(dir, path.join(dir, "..")), false);
  assert.equal(isInside(dir, path.join(dir, "..", "x")), false);
  assert.equal(isInside(dir, path.join(dir, "a", "..", "..", "x")), false);
  assert.equal(isInside(dir, path.resolve(os.tmpdir())), false);
  if (process.platform === "win32") assert.equal(isInside("C:/root", "D:/root/x"), false);
});

test("isInside follows an existing symlink that points outside", (t) => {
  const dir = tempDir(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "gmf-fsutil-out-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const link = path.join(dir, "link");
  try {
    fs.symlinkSync(outside, link, "junction");
  } catch {
    t.skip("symlinks are not permitted here");
    return;
  }
  assert.equal(isInside(dir, path.join(link, "file.txt")), false);
});

test("safeReaddir returns [] for a missing or unreadable folder and entries otherwise", (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "b.txt"), "");
  fs.writeFileSync(path.join(dir, "a.txt"), "");
  assert.deepEqual(safeReaddir(path.join(dir, "nope")), []);
  assert.deepEqual(safeReaddir(path.join(dir, "a.txt")), []);
  assert.deepEqual(safeReaddir(dir), ["a.txt", "b.txt"]);
  assert.deepEqual(
    safeReaddir(dir, { withFileTypes: true }).map((entry) => entry.name),
    ["a.txt", "b.txt"],
  );
});
