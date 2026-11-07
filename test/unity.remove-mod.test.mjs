import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeOperation } from "../src/core/operations.mjs";
import "../src/engines/unity/index.mjs";
import { fixture as fixturePath } from "./helpers/paths.mjs";
import { snapshotTree } from "./helpers/tree.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmf-unity-remove-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function setup(name, loader = "bepinex") {
  const gameDir = path.join(root, name, "game");
  fs.cpSync(fixturePath("unity-mono"), gameDir, { recursive: true });
  let modPath;
  if (loader === "bepinex") {
    modPath = path.join(gameDir, "BepInEx", "plugins", "DemoMod");
    fs.mkdirSync(modPath, { recursive: true });
    fs.writeFileSync(path.join(modPath, "DemoMod.dll"), "SYNTHETIC");
    fs.writeFileSync(path.join(modPath, "DemoMod.cfg"), "x=1");
    fs.mkdirSync(path.join(gameDir, "BepInEx", "core"), { recursive: true });
    fs.writeFileSync(path.join(gameDir, "BepInEx", "core", "BepInEx.Core.dll"), "SYNTHETIC LOADER");
  } else {
    fs.mkdirSync(path.join(gameDir, "MelonLoader"), { recursive: true });
    fs.mkdirSync(path.join(gameDir, "Mods"), { recursive: true });
    modPath = path.join(gameDir, "Mods", "DemoMod.dll");
    fs.writeFileSync(modPath, "SYNTHETIC");
    fs.writeFileSync(path.join(gameDir, "Mods", "Other.dll"), "OTHER");
  }
  const workspace = { root: path.join(root, name, "ws"), config: { version: 1 }, local: { version: 1 }, profile: null };
  fs.mkdirSync(workspace.root, { recursive: true });
  return { gameDir, modPath, workspace };
}

const allowed = (workspace) => ({ workspace, authorizations: [{ effect: "gameWrite", source: "test: remove the demo mod" }] });

test("unity.remove_mod refuses without a gameWrite authorization and keeps the mod", async () => {
  const { gameDir, modPath, workspace } = setup("refused");
  const before = { game: snapshotTree(gameDir), workspace: snapshotTree(workspace.root) };
  const result = await executeOperation("unity.remove_mod", { gameDir, name: "DemoMod" }, { workspace });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GMF-E-GATE-001");
  assert.ok(fs.existsSync(path.join(modPath, "DemoMod.dll")));
  assert.deepEqual(snapshotTree(gameDir), before.game, "the game folder is unchanged");
  assert.deepEqual(snapshotTree(workspace.root), before.workspace, "no backup is written");
});

test("unity.remove_mod backs up and removes a BepInEx plugin folder", async () => {
  const { gameDir, modPath, workspace } = setup("bepinex");
  const result = await executeOperation("unity.remove_mod", { gameDir, name: "DemoMod" }, allowed(workspace));
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(fs.existsSync(modPath), false);
  assert.equal(result.data.removed.length, 2);
  const expectedBytes = { "DemoMod.dll": "SYNTHETIC", "DemoMod.cfg": "x=1" };
  assert.deepEqual(result.data.removed.map((entry) => path.basename(entry.target)).sort(), ["DemoMod.cfg", "DemoMod.dll"]);
  for (const entry of result.data.removed) {
    assert.equal(path.dirname(entry.backup), path.join(workspace.root, "backups"), "the backup lives under the workspace");
    assert.equal(fs.readFileSync(entry.backup, "utf8"), expectedBytes[path.basename(entry.target)], `backup bytes for ${entry.target}`);
  }
  assert.ok(fs.existsSync(path.join(gameDir, "BepInEx", "core", "BepInEx.Core.dll")), "the loader is untouched");
});

test("unity.remove_mod removes only the named MelonLoader mod assembly", async () => {
  const { gameDir, modPath, workspace } = setup("melon", "melonloader");
  const result = await executeOperation("unity.remove_mod", { gameDir, name: "DemoMod" }, allowed(workspace));
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(fs.existsSync(modPath), false);
  assert.equal(result.data.removed.length, 1);
  assert.ok(fs.existsSync(path.join(gameDir, "Mods", "Other.dll")), "other mods stay");
});

test("unity.remove_mod refuses escaping names and reports a missing mod", async () => {
  const { gameDir, workspace } = setup("guards");
  const before = { game: snapshotTree(gameDir), workspace: snapshotTree(workspace.root) };
  const escape = await executeOperation("unity.remove_mod", { gameDir, name: "../core" }, allowed(workspace));
  assert.equal(escape.ok, false);
  assert.equal(escape.error.code, "GMF-E-PLAN-001");
  const missing = await executeOperation("unity.remove_mod", { gameDir, name: "NoSuchMod" }, allowed(workspace));
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "GMF-E-PLAN-001");
  assert.deepEqual(snapshotTree(gameDir), before.game, "the game folder is unchanged");
  assert.deepEqual(snapshotTree(workspace.root), before.workspace, "no backup is written");
});

test("unity.remove_mod runs on an authorization recorded only in the workspace's plan file", async () => {
  const { gameDir, modPath, workspace } = setup("plan-file");
  fs.writeFileSync(path.join(workspace.root, "gmf.plan.json"), JSON.stringify({ authorizations: [{ effect: "gameWrite", source: "plan: user said remove the demo mod" }] }));
  const result = await executeOperation("unity.remove_mod", { gameDir, name: "DemoMod" }, { workspace });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(fs.existsSync(modPath), false);
});

test("unity.remove_mod refuses before deleting anything when the mod folder holds a link", async (t) => {
  const { gameDir, modPath, workspace } = setup("symlink");
  const outside = path.join(root, "symlink", "outside.txt");
  fs.writeFileSync(outside, "KEEP");
  try {
    fs.symlinkSync(outside, path.join(modPath, "link.txt"));
  } catch (error) {
    t.skip(`symlinks are not available here: ${error.code}`);
    return;
  }
  const before = { game: snapshotTree(gameDir), workspace: snapshotTree(workspace.root) };
  const result = await executeOperation("unity.remove_mod", { gameDir, name: "DemoMod" }, allowed(workspace));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GMF-E-EXEC-001");
  assert.ok(fs.existsSync(path.join(modPath, "DemoMod.dll")), "nothing was deleted");
  assert.equal(fs.readFileSync(outside, "utf8"), "KEEP");
  assert.equal(fs.existsSync(path.join(workspace.root, "backups")), false, "nothing was backed up");
  assert.deepEqual(snapshotTree(gameDir), before.game, "the game folder is unchanged");
  assert.deepEqual(snapshotTree(workspace.root), before.workspace, "the workspace is unchanged");
});
