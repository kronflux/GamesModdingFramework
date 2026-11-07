// Unreal asset pipeline: retoc/repak extract, UAssetGUI JSON round trip, retoc/repak
// mod packing and deploy to Content/Paks/~mods. The fake runner imitates each tool's
// real command line (checked against the installed tools on 2026-11-07).
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

const fixtures = fixturePath("unreal-assets");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmf-unreal-assets-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const MOUNT = "Game/Content/Data/DT_Tips";

function workspaceAt(name, profile = { engine: { id: "unreal", version: "5.6" } }) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "dumps"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dumps", "Game-5.6.usmap"), "SYNTHETIC USMAP");
  return { root: dir, config: { version: 1 }, local: { version: 1 }, profile };
}

function copyGame(name, { iostore = false } = {}) {
  const target = path.join(root, name);
  fs.cpSync(path.join(fixtures, "Game"), target, { recursive: true });
  if (iostore) {
    fs.writeFileSync(path.join(target, "Content", "Paks", "Game-Windows.utoc"), "SYNTHETIC UTOC");
    fs.writeFileSync(path.join(target, "Content", "Paks", "Game-Windows.ucas"), "SYNTHETIC UCAS");
  }
  return target;
}

function toolCache(name) {
  const cacheDir = path.join(root, `${name}-tools`);
  fs.mkdirSync(cacheDir, { recursive: true });
  const manifest = {};
  for (const id of ["retoc", "repak", "uassetgui"]) {
    manifest[id] = { id, version: "fake", path: process.execPath, args: [`--${id}`], verification: { kind: "none", ok: true } };
  }
  fs.writeFileSync(path.join(cacheDir, "tools.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return cacheDir;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// Behaves like retoc, repak and UAssetGUI for the arguments gmf passes.
function fakeTools(calls) {
  return async (cmd, argv) => {
    const [tool, ...args] = argv;
    calls.push({ tool: tool.slice(2), args });
    if (tool === "--retoc" && args[0] === "to-legacy") {
      const out = args[args.length - 1];
      write(path.join(out, `${MOUNT}.uasset`), "LEGACY");
      write(path.join(out, `${MOUNT}.uexp`), "LEGACY");
      return { code: 0, stdout: 'info: : Extracted 1 (0 failed) legacy assets to "out"', stderr: "" };
    }
    if (tool === "--retoc" && args[0] === "to-zen") {
      const utoc = args[args.length - 1];
      for (const ext of [".utoc", ".ucas", ".pak"]) write(utoc.replace(/\.utoc$/, ext), "ZEN");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (tool === "--repak" && args[0] === "list") {
      return { code: 0, stdout: `${MOUNT}.uasset\n${MOUNT}.uexp\nGame/Content/Other/BP_Other.uasset\n`, stderr: "" };
    }
    if (tool === "--repak" && args[0] === "unpack") {
      const out = args[args.indexOf("-o") + 1];
      write(path.join(out, `${MOUNT}.uasset`), "LEGACY");
      write(path.join(out, `${MOUNT}.uexp`), "LEGACY");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (tool === "--repak" && args[0] === "pack") {
      write(args[args.length - 1], "PAK");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (tool === "--uassetgui" && args[0] === "tojson") {
      write(args[2], JSON.stringify({ Exports: [{ ObjectName: "DT_Tips", $type: "UAssetAPI.ExportTypes.DataTableExport, UAssetAPI" }] }));
      return { code: 0, stdout: "", stderr: "" };
    }
    if (tool === "--uassetgui" && args[0] === "fromjson") {
      write(args[2], "EDITED");
      write(args[2].replace(/\.uasset$/, ".uexp"), "EDITED");
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected call ${tool} ${args.join(" ")}` };
  };
}

test("extract converts only the filtered IoStore assets with retoc and never touches the game", async () => {
  const gameDir = copyGame("game-iostore", { iostore: true });
  const before = snapshotTree(gameDir);
  const workspace = workspaceAt("ws-extract");
  const calls = [];
  const result = await executeOperation(
    "unreal.extract_assets",
    { gameDir, filter: "DT_Tips" },
    { workspace, toolCacheDir: toolCache("extract"), runProcess: fakeTools(calls) },
  );
  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual(calls[0].args, ["to-legacy", "--filter", "DT_Tips", path.join(gameDir, "Content", "Paks"), path.join(workspace.root, "extracted", "unreal", "legacy")]);
  assert.equal(result.data.container, "iostore");
  assert.ok(result.data.assets.includes(`${MOUNT}.uasset`));
  assert.deepEqual(snapshotTree(gameDir), before);
});

test("extract on a pak game lists with repak and unpacks only the matching entries", async () => {
  const gameDir = copyGame("game-pak");
  const workspace = workspaceAt("ws-extract-pak");
  const calls = [];
  const result = await executeOperation(
    "unreal.extract_assets",
    { gameDir, filter: "DT_Tips" },
    { workspace, toolCacheDir: toolCache("extract-pak"), runProcess: fakeTools(calls) },
  );
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.data.container, "pak");
  assert.equal(calls[0].args[0], "list");
  const unpack = calls.find((call) => call.args[0] === "unpack").args;
  assert.ok(unpack.includes("-i") && unpack.includes(`${MOUNT}.uasset`) && unpack.includes(`${MOUNT}.uexp`));
  assert.equal(unpack.includes("Game/Content/Other/BP_Other.uasset"), false);
});

test("inspect writes UAssetGUI JSON with the profile's engine version and the workspace usmap", async () => {
  const workspace = workspaceAt("ws-inspect");
  write(path.join(workspace.root, "extracted", "unreal", "legacy", `${MOUNT}.uasset`), "LEGACY");
  const calls = [];
  const result = await executeOperation(
    "unreal.inspect_asset",
    { assetPath: `${MOUNT}.uasset` },
    { workspace, toolCacheDir: toolCache("inspect"), runProcess: fakeTools(calls) },
  );
  assert.equal(result.ok, true, result.error?.message);
  const json = path.join(workspace.root, "extracted", "unreal", "json", `${MOUNT}.json`);
  assert.deepEqual(calls[0].args, [
    "tojson",
    path.join(workspace.root, "extracted", "unreal", "legacy", `${MOUNT}.uasset`),
    json,
    "5.6",
    path.join(workspace.root, "dumps", "Game-5.6.usmap"),
  ]);
  assert.equal(result.data.jsonPath, json);
  assert.equal(result.data.mountPath, `${MOUNT}.uasset`);
  assert.deepEqual(result.data.exports, [{ name: "DT_Tips", type: "DataTableExport" }]);
});

test("inspect refuses an asset outside the legacy root unless a mountPath is given", async () => {
  const workspace = workspaceAt("ws-inspect-outside");
  const outside = path.join(workspace.root, "scratch", "DT_Tips.uasset");
  write(outside, "LEGACY");
  const calls = [];
  const context = { workspace, toolCacheDir: toolCache("inspect-outside"), runProcess: fakeTools(calls) };
  const before = snapshotTree(workspace.root);
  const refused = await executeOperation("unreal.inspect_asset", { assetPath: outside }, context);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "GMF-E-PLAN-001");
  assert.match(refused.error.message, /mountPath/);
  assert.equal(calls.length, 0, "no tool runs for a refused asset");
  assert.deepEqual(snapshotTree(workspace.root), before, "the workspace is unchanged");
  const accepted = await executeOperation("unreal.inspect_asset", { assetPath: outside, mountPath: `${MOUNT}.uasset` }, context);
  assert.equal(accepted.ok, true, accepted.error?.message);
  assert.equal(accepted.data.mountPath, `${MOUNT}.uasset`);
  assert.equal(accepted.data.jsonPath, path.join(workspace.root, "extracted", "unreal", "json", `${MOUNT}.json`));
  const escaping = await executeOperation("unreal.inspect_asset", { assetPath: outside, mountPath: "../x.uasset" }, context);
  assert.equal(escaping.ok, false);
  assert.equal(escaping.error.code, "GMF-E-PLAN-001");
});

test("extract reports GMF-E-GAME-001 when the game has no Content/Paks folder", async () => {
  const gameDir = path.join(root, "game-no-paks");
  write(path.join(gameDir, "Game.exe"), "SYNTHETIC");
  const workspace = workspaceAt("ws-no-paks");
  const before = { game: snapshotTree(gameDir), workspace: snapshotTree(workspace.root) };
  const calls = [];
  const result = await executeOperation(
    "unreal.extract_assets",
    { gameDir },
    { workspace, toolCacheDir: toolCache("no-paks"), runProcess: fakeTools(calls) },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GMF-E-GAME-001");
  assert.match(result.error.message, /Paks/);
  assert.equal(calls.length, 0, "no tool runs");
  assert.deepEqual(snapshotTree(gameDir), before.game, "the game folder is unchanged");
  assert.deepEqual(snapshotTree(workspace.root), before.workspace, "the workspace is unchanged");
});

test("stage_asset turns edited JSON into the mod's pak folder at the same mount path", async () => {
  const workspace = workspaceAt("ws-stage");
  const json = path.join(workspace.root, "extracted", "unreal", "json", `${MOUNT}.json`);
  write(json, "{}");
  const calls = [];
  const result = await executeOperation(
    "unreal.stage_asset",
    { mod: "TipsMod", jsonPath: json },
    { workspace, toolCacheDir: toolCache("stage"), runProcess: fakeTools(calls) },
  );
  assert.equal(result.ok, true, result.error?.message);
  const target = path.join(workspace.root, "mods", "TipsMod", "pak", `${MOUNT}.uasset`);
  assert.deepEqual(calls[0].args, ["fromjson", json, target, path.join(workspace.root, "dumps", "Game-5.6.usmap")]);
  assert.ok(fs.existsSync(target) && fs.existsSync(target.replace(/\.uasset$/, ".uexp")));
});

test("pack_mod makes a _P IoStore set with retoc on IoStore games and a _P pak with repak otherwise", async () => {
  const workspace = workspaceAt("ws-pack");
  write(path.join(workspace.root, "mods", "TipsMod", "pak", `${MOUNT}.uasset`), "EDITED");
  const calls = [];
  const iostoreGame = copyGame("game-pack-iostore", { iostore: true });
  const zen = await executeOperation(
    "unreal.pack_mod",
    { mod: "TipsMod", gameDir: iostoreGame },
    { workspace, toolCacheDir: toolCache("pack"), runProcess: fakeTools(calls) },
  );
  assert.equal(zen.ok, true, zen.error?.message);
  const dist = path.join(workspace.root, "mods", "TipsMod", "dist");
  assert.deepEqual(calls[0].args, ["to-zen", "--version", "UE5_6", path.join(workspace.root, "mods", "TipsMod", "pak"), path.join(dist, "TipsMod_P.utoc")]);
  assert.deepEqual(zen.data.files.map((file) => path.basename(file)).sort(), ["TipsMod_P.pak", "TipsMod_P.ucas", "TipsMod_P.utoc"]);

  calls.length = 0;
  const pakGame = copyGame("game-pack-pak");
  const pak = await executeOperation(
    "unreal.pack_mod",
    { mod: "TipsMod", gameDir: pakGame },
    { workspace, toolCacheDir: toolCache("pack2"), runProcess: fakeTools(calls) },
  );
  assert.equal(pak.ok, true, pak.error?.message);
  assert.deepEqual(calls[0].args, ["pack", "--version", "V11", path.join(workspace.root, "mods", "TipsMod", "pak"), path.join(dist, "TipsMod_P.pak")]);
  assert.deepEqual(pak.data.files, [path.join(dist, "TipsMod_P.pak")]);
});

test("deploy sends a packed asset mod to Content/Paks/~mods", async () => {
  const workspace = workspaceAt("ws-deploy");
  const modDir = path.join(workspace.root, "mods", "TipsMod");
  write(path.join(modDir, "pak", `${MOUNT}.uasset`), "EDITED");
  for (const ext of ["pak", "utoc", "ucas"]) write(path.join(modDir, "dist", `TipsMod_P.${ext}`), "ZEN");
  const gameDir = copyGame("game-deploy", { iostore: true });
  const result = await executeOperation(
    "unreal.deploy",
    { modDir, gameDir, type: "pak" },
    { workspace, authorizations: [{ effect: "gameWrite", source: "test: deploy" }] },
  );
  assert.equal(result.ok, true, result.error?.message);
  const target = path.join(gameDir, "Content", "Paks", "~mods");
  assert.equal(result.data.target, target);
  assert.deepEqual(fs.readdirSync(target).sort(), ["TipsMod_P.pak", "TipsMod_P.ucas", "TipsMod_P.utoc"]);
});

test("a missing tool reports GMF-E-TOOL-001 and leaves the game, the workspace and the cache unchanged", async (t) => {
  const gameDir = copyGame("game-missing-tool", { iostore: true });
  const workspace = workspaceAt("ws-missing-tool");
  const empty = path.join(root, "no-tools");
  fs.mkdirSync(empty, { recursive: true });
  const calls = [];
  const before = { game: snapshotTree(gameDir), workspace: snapshotTree(workspace.root), empty: snapshotTree(empty) };
  const missing = await executeOperation("unreal.extract_assets", { gameDir }, { workspace, toolCacheDir: empty, runProcess: fakeTools(calls) });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "GMF-E-TOOL-001");
  assert.equal(calls.length, 0, "no tool runs");
  assert.deepEqual(snapshotTree(gameDir), before.game, "the game folder is unchanged");
  assert.deepEqual(snapshotTree(workspace.root), before.workspace, "the workspace is unchanged");
  assert.deepEqual(snapshotTree(empty), before.empty, "the empty tool cache stays empty");
});

test("outputs outside the workspace and escaping mod names are refused without writing", async () => {
  const gameDir = copyGame("game-guards", { iostore: true });
  const workspace = workspaceAt("ws-guards");
  const calls = [];
  const before = { game: snapshotTree(gameDir), workspace: snapshotTree(workspace.root) };
  const outside = await executeOperation(
    "unreal.extract_assets",
    { gameDir, outputDir: path.join(root, "outside") },
    { workspace, toolCacheDir: toolCache("guards"), runProcess: fakeTools(calls) },
  );
  assert.equal(outside.ok, false);
  assert.match(outside.error.message, /workspace/i);
  const escape = await executeOperation(
    "unreal.stage_asset",
    { mod: "../Escape", jsonPath: path.join(workspace.root, "x.json") },
    { workspace, toolCacheDir: toolCache("guards2"), runProcess: fakeTools(calls) },
  );
  assert.equal(escape.ok, false);
  assert.equal(calls.length, 0, "no tool runs for a refused call");
  assert.equal(fs.existsSync(path.join(root, "outside")), false, "the outside folder is not created");
  assert.deepEqual(snapshotTree(gameDir), before.game, "the game folder is unchanged");
  assert.deepEqual(snapshotTree(workspace.root), before.workspace, "the workspace is unchanged");
});