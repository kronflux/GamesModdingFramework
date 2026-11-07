import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import unreal from "../src/engines/unreal/index.mjs";
import { executeOperation, registerOperation } from "../src/core/operations.mjs";
import { fixture as fixturePath } from "./helpers/paths.mjs";
import { snapshotTree } from "./helpers/tree.mjs";

for (const operation of unreal.operations) registerOperation(operation, operation.handler);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmf-remove-mod-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function setup(name) {
  const gameDir = path.join(root, name, "game");
  fs.cpSync(fixturePath("unreal", "ue4ss-game"), gameDir, { recursive: true });
  const modDir = path.join(gameDir, "ue4ss", "Mods", "DemoMod");
  fs.mkdirSync(path.join(modDir, "Scripts"), { recursive: true });
  fs.writeFileSync(path.join(modDir, "enabled.txt"), "");
  fs.writeFileSync(path.join(modDir, "Scripts", "main.lua"), "local MOD_NAME = \"DemoMod\"\n");
  const workspace = { root: path.join(root, name, "ws"), config: { version: 1 }, local: { version: 1 }, profile: null };
  fs.mkdirSync(workspace.root, { recursive: true });
  return { gameDir, modDir, workspace };
}

test("remove_mod refuses without a gameWrite authorization and keeps the mod", async () => {
  const { gameDir, modDir, workspace } = setup("refused");
  const before = { game: snapshotTree(gameDir), workspace: snapshotTree(workspace.root) };
  const result = await executeOperation("unreal.remove_mod", { gameDir, name: "DemoMod" }, { workspace });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GMF-E-GATE-001");
  assert.ok(fs.existsSync(path.join(modDir, "Scripts", "main.lua")));
  assert.deepEqual(snapshotTree(gameDir), before.game, "the game folder is unchanged");
  assert.deepEqual(snapshotTree(workspace.root), before.workspace, "no backup is written");
});

test("remove_mod backs up every file of a Lua mod, then removes its folder", async () => {
  const { gameDir, modDir, workspace } = setup("removed");
  const context = { workspace, authorizations: [{ effect: "gameWrite", source: "test: remove the demo mod" }] };
  const result = await executeOperation("unreal.remove_mod", { gameDir, name: "DemoMod" }, context);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(fs.existsSync(modDir), false);
  assert.equal(result.data.removed.length, 2);
  const expectedBytes = { "enabled.txt": "", "main.lua": 'local MOD_NAME = "DemoMod"\n' };
  assert.deepEqual(result.data.removed.map((entry) => path.basename(entry.target)).sort(), ["enabled.txt", "main.lua"]);
  for (const entry of result.data.removed) {
    assert.equal(path.dirname(entry.backup), path.join(workspace.root, "backups"), "the backup lives under the workspace");
    assert.equal(fs.readFileSync(entry.backup, "utf8"), expectedBytes[path.basename(entry.target)], `backup bytes for ${entry.target}`);
  }
  assert.ok(fs.existsSync(path.join(gameDir, "ue4ss", "UE4SS.dll")), "nothing outside the mod folder is touched");
});

test("remove_mod refuses names that escape the Mods folder and reports a missing mod", async () => {
  const { gameDir, workspace } = setup("guards");
  const context = { workspace, authorizations: [{ effect: "gameWrite", source: "test" }] };
  const before = { game: snapshotTree(gameDir), workspace: snapshotTree(workspace.root) };
  const escape = await executeOperation("unreal.remove_mod", { gameDir, name: "../UE4SS.dll" }, context);
  assert.equal(escape.ok, false);
  assert.equal(escape.error.code, "GMF-E-PLAN-001");
  const shared = await executeOperation("unreal.remove_mod", { gameDir, name: "shared" }, context);
  assert.equal(shared.ok, false, "the shared library folder is not a mod");
  assert.equal(shared.error.code, "GMF-E-PLAN-001");
  const missing = await executeOperation("unreal.remove_mod", { gameDir, name: "NoSuchMod" }, context);
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "GMF-E-PLAN-001");
  assert.deepEqual(snapshotTree(gameDir), before.game, "the game folder is unchanged");
  assert.deepEqual(snapshotTree(workspace.root), before.workspace, "no backup is written");
});

test("remove_mod also removes a packed asset mod's _P files from Content/Paks/~mods", async () => {
  const { gameDir, workspace } = setup("pakmod");
  const modsDir = path.join(gameDir, "Content", "Paks", "~mods");
  fs.mkdirSync(modsDir, { recursive: true });
  for (const ext of ["pak", "utoc", "ucas"]) fs.writeFileSync(path.join(modsDir, `TipsMod_P.${ext}`), "ZEN");
  fs.writeFileSync(path.join(modsDir, "Other_P.pak"), "OTHER");
  fs.writeFileSync(path.join(modsDir, "TipsModExtra_P.pak"), "DECOY");
  const context = { workspace, authorizations: [{ effect: "gameWrite", source: "test: remove the pak mod" }] };
  const result = await executeOperation("unreal.remove_mod", { gameDir, name: "TipsMod" }, context);
  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual(fs.readdirSync(modsDir).sort(), ["Other_P.pak", "TipsModExtra_P.pak"], "a mod whose name only starts with the same prefix stays");
  assert.equal(fs.readFileSync(path.join(modsDir, "TipsModExtra_P.pak"), "utf8"), "DECOY");
  assert.equal(result.data.removed.length, 3);
  assert.deepEqual(result.data.removed.map((entry) => path.basename(entry.target)).sort(), ["TipsMod_P.pak", "TipsMod_P.ucas", "TipsMod_P.utoc"]);
  for (const entry of result.data.removed) {
    assert.equal(path.dirname(entry.backup), path.join(workspace.root, "backups"), "the backup lives under the workspace");
    assert.equal(fs.readFileSync(entry.backup, "utf8"), "ZEN");
  }
});
