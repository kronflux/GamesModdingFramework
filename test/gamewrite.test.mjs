// Multi-file game writes either land completely or leave the game folder as it
// was: every overwritten file is backed up first, and a failure part-way
// restores the files already written.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyFilesWithBackup } from "../src/core/gamewrite.mjs";

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmf-gamewrite-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup(t) {
  const dir = tempDir(t);
  const workspace = { root: path.join(dir, "ws") };
  const game = path.join(dir, "game");
  const src = path.join(dir, "src");
  fs.mkdirSync(workspace.root, { recursive: true });
  fs.mkdirSync(game, { recursive: true });
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "a.dll"), "new-a");
  fs.writeFileSync(path.join(src, "b.dll"), "new-b");
  fs.writeFileSync(path.join(game, "a.dll"), "old-a");
  return { workspace, game, src };
}

test("copies every file, backs up the ones it overwrites and reports both lists", (t) => {
  const { workspace, game, src } = setup(t);
  const result = copyFilesWithBackup(workspace, [
    { source: path.join(src, "a.dll"), target: path.join(game, "a.dll") },
    { source: path.join(src, "b.dll"), target: path.join(game, "sub", "b.dll") },
  ]);
  assert.equal(fs.readFileSync(path.join(game, "a.dll"), "utf8"), "new-a");
  assert.equal(fs.readFileSync(path.join(game, "sub", "b.dll"), "utf8"), "new-b");
  assert.equal(result.deployed.length, 2);
  assert.equal(result.backups.length, 1);
  assert.equal(fs.readFileSync(result.backups[0], "utf8"), "old-a");
  assert.equal(result.deployed[0].backup, result.backups[0]);
  assert.equal(result.deployed[1].backup, null);
});

test("a failure part-way restores overwritten files, removes new ones and names the backups", (t) => {
  const { workspace, game, src } = setup(t);
  fs.writeFileSync(path.join(game, "blocker"), "a file where a folder must be created");
  let error = null;
  try {
    copyFilesWithBackup(workspace, [
      { source: path.join(src, "a.dll"), target: path.join(game, "a.dll") },
      { source: path.join(src, "b.dll"), target: path.join(game, "blocker", "b.dll") },
    ]);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, "the file in the way makes the second copy fail");
  assert.equal(error.code, "GMF-E-EXEC-001");
  assert.equal(fs.readFileSync(path.join(game, "a.dll"), "utf8"), "old-a", "the overwritten file is back");
  assert.equal(error.backups.length, 1);
  assert.equal(error.deployed.length, 0, "nothing is reported as deployed after the rollback");
});

test("a directory in the way is refused before anything is written", (t) => {
  const { workspace, game, src } = setup(t);
  fs.mkdirSync(path.join(game, "c.dll"));
  assert.throws(
    () =>
      copyFilesWithBackup(workspace, [
        { source: path.join(src, "b.dll"), target: path.join(game, "fresh", "b.dll") },
        { source: path.join(src, "b.dll"), target: path.join(game, "c.dll") },
      ]),
    (error) => error.code === "GMF-E-GAME-001",
  );
  assert.equal(fs.existsSync(path.join(game, "fresh", "b.dll")), false);
});

test("overwriting without a workspace is refused before anything is written", (t) => {
  const { game, src } = setup(t);
  assert.throws(
    () => copyFilesWithBackup(null, [{ source: path.join(src, "a.dll"), target: path.join(game, "a.dll") }]),
    (error) => error.code === "GMF-E-GATE-001",
  );
  assert.equal(fs.readFileSync(path.join(game, "a.dll"), "utf8"), "old-a");
});
