import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import unreal from "../src/engines/unreal/index.mjs";
import { executeOperation, registerOperation } from "../src/core/operations.mjs";
import { mergeIniKeys, collectDumpArtifacts } from "../src/engines/unreal/operations/dump.mjs";
import { repoRoot, fixture as fixturePath } from "./helpers/paths.mjs";
import { snapshotTree } from "./helpers/tree.mjs";

for (const operation of unreal.operations) registerOperation(operation, operation.handler);

const fixtures = fixturePath("unreal");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmf-unreal-dumper-"));

after(() => fs.rmSync(root, { recursive: true, force: true }));

function workspaceAt(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return { root: dir, config: { version: 1 }, local: { version: 1 }, profile: null };
}

function copyFixture(name, target) {
  fs.cpSync(path.join(fixtures, name), target, { recursive: true });
  return target;
}

test("deployHelper without gameWrite is refused", async () => {
  const gameDir = copyFixture("ue4ss-dumps", path.join(root, "game-refused"));
  const workspace = workspaceAt("ws-refused");
  const before = { game: snapshotTree(gameDir), workspace: snapshotTree(workspace.root) };
  const result = await executeOperation("unreal.dump", { gameDir, deployHelper: true }, { workspace });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GMF-E-GATE-001");
  assert.equal(fs.existsSync(path.join(gameDir, "ue4ss", "Mods", "GmfDumper")), false);
  assert.match(fs.readFileSync(path.join(gameDir, "ue4ss", "UE4SS-settings.ini"), "utf8"), /UseModuleOffsets = 0/);
  assert.deepEqual(snapshotTree(gameDir), before.game, "the game folder is unchanged");
  assert.deepEqual(snapshotTree(workspace.root), before.workspace, "the workspace is unchanged");
});

test("deployHelper with authorization writes the mod, backs up and merges only fragment keys", async () => {
  const gameDir = copyFixture("ue4ss-dumps", path.join(root, "game-deploy"));
  const workspace = workspaceAt("ws-deploy");
  const context = { workspace, authorizations: [{ effect: "gameWrite", source: "test: user asked for the dump helper" }] };
  const result = await executeOperation("unreal.dump", { gameDir, deployHelper: true }, context);
  assert.equal(result.ok, true, result.error?.message);
  const ue4ss = path.join(gameDir, "ue4ss");
  assert.ok(fs.existsSync(path.join(ue4ss, "Mods", "GmfDumper", "Scripts", "main.lua")));
  assert.ok(fs.existsSync(path.join(ue4ss, "Mods", "GmfDumper", "enabled.txt")));
  assert.ok(fs.existsSync(path.join(ue4ss, "Mods", "shared", "UEHelpers", "UEHelpers.lua")));
  const ini = fs.readFileSync(path.join(ue4ss, "UE4SS-settings.ini"), "utf8");
  assert.match(ini, /bUseUObjectArrayCache = 1/);
  assert.match(ini, /UseModuleOffsets = 1/);
  assert.doesNotMatch(ini, /UseModuleOffsets = 0/);
  const helper = result.data.helper;
  const settingsBackup = helper.backup.find((entry) => entry.target.endsWith("UE4SS-settings.ini"));
  assert.ok(settingsBackup && fs.existsSync(settingsBackup.path), "the settings file must be backed up");
  assert.match(fs.readFileSync(settingsBackup.path, "utf8"), /UseModuleOffsets = 0/);
});

test("the dumper script writes its report into the UE4SS folder and runs key binds on the game thread", () => {
  const source = fs.readFileSync(path.join(repoRoot, "templates/unreal/dumper/Mods/GmfDumper/Scripts/main.lua"), "utf8");
  assert.doesNotMatch(source, /io\.open, REPORT_FILE_NAME/, "a bare report name resolves against Binaries/Win64");
  assert.match(source, /Ue4ssDir \.\. "\/" \.\. REPORT_FILE_NAME/);
  assert.match(source, /RegisterKeyBind\(KeyValue, function\(\)\s+ExecuteInGameThread/);
  assert.doesNotMatch(source, /^local UEHelpers = require/m, "the unused UEHelpers require is gone");
});

test("mergeIniKeys changes only keys in the fragment and appends missing ones", () => {
  const existing = "[General]\nbUseUObjectArrayCache = 1\n\n[ObjectDumper]\nUseModuleOffsets = 0\nOther = 5\n";
  const fragment = "; comment\n[ObjectDumper]\nUseModuleOffsets = 1\nLoadAllAssetsBeforeDumpingObjects = 0\n[Debug]\nConsoleEnabled = 1\n";
  const merged = mergeIniKeys(existing, fragment);
  assert.match(merged, /bUseUObjectArrayCache = 1/);
  assert.match(merged, /Other = 5/);
  assert.match(merged, /UseModuleOffsets = 1/);
  assert.doesNotMatch(merged, /UseModuleOffsets = 0/);
  assert.match(merged, /\[ObjectDumper\][^[]*LoadAllAssetsBeforeDumpingObjects = 0/);
  assert.match(merged, /\[Debug\]\r?\nConsoleEnabled = 1/);
  assert.equal(mergeIniKeys(merged, fragment), merged, "merging twice is stable");
});

test("collect copies artifacts and normalizes", async () => {
  const gameDir = copyFixture("ue4ss-dumps", path.join(root, "game-collect"));
  const workspace = workspaceAt("ws-collect");
  const result = await executeOperation("unreal.dump", { gameDir, collect: true }, { workspace });
  assert.equal(result.ok, true, result.error?.message);
  const normalized = JSON.parse(fs.readFileSync(path.join(workspace.root, "dumps", "unreal-objects.json"), "utf8"));
  assert.equal(normalized.version, 1);
  assert.equal(normalized.engine, "unreal");
  const gameMode = normalized.classes.find((entry) => entry.name === "GameModeBase");
  assert.equal(gameMode.path, "/Script/Engine.GameModeBase");
  assert.equal(gameMode.address, "0x0000000000000010");
  assert.deepEqual(gameMode.methods, ["BeginPlay"]);
  const blueprint = normalized.classes.find((entry) => entry.name === "BP_FixtureGameMode_C");
  assert.deepEqual(blueprint.methods, ["ReceiveBeginPlay"]);
  assert.ok(normalized.entrypoints.some((entry) => entry.name === "BeginPlay" && entry.class === "GameModeBase"));
  const names = result.data.collected.copied.map((file) => path.basename(file));
  for (const expected of ["UE4SS_ObjectDump.txt", "Mappings.usmap", "GmfDumper_report.txt", "Fixture.hpp"]) {
    assert.ok(names.includes(expected), `${expected} missing from ${names.join(",")}`);
  }
  const direct = collectDumpArtifacts(path.join(gameDir, "ue4ss"), path.join(workspace.root, "dumps"));
  assert.ok(direct.copied.length >= 4);
});

function dumpGame(name, mutate) {
  const gameDir = copyFixture("ue4ss-dumps", path.join(root, name));
  mutate?.({ ue4ss: path.join(gameDir, "ue4ss"), binaries: path.join(gameDir, "Binaries", "Win64"), gameDir });
  return gameDir;
}

const artifactOf = (result, kind) => result.data.artifacts.find((artifact) => artifact.kind === kind);

test("found and collect share one name rule: an ObjectDump file without the UE4SS_ prefix is neither", async () => {
  const gameDir = dumpGame("game-dump-prefix", ({ ue4ss }) => {
    fs.renameSync(path.join(ue4ss, "UE4SS_ObjectDump.txt"), path.join(ue4ss, "ObjectDump.txt"));
  });
  const workspace = workspaceAt("ws-dump-prefix");
  const result = await executeOperation("unreal.dump", { gameDir, kinds: ["objects"], collect: true }, { workspace });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(artifactOf(result, "objects").status, "planned");
  assert.equal(result.data.dump, null);
  assert.equal(fs.existsSync(path.join(workspace.root, "dumps", "ObjectDump.txt")), false);
});

test("found and collect pick the plain object dump, otherwise the newest numbered one", async () => {
  const stamp = (file, seconds) => fs.utimesSync(file, seconds, seconds);
  const numbered = dumpGame("game-dump-newest", ({ ue4ss }) => {
    fs.rmSync(path.join(ue4ss, "UE4SS_ObjectDump.txt"));
    for (const [name, seconds, tag] of [["UE4SS_ObjectDump_a.txt", 1_000_000, "OldDump"], ["UE4SS_ObjectDump_z.txt", 2_000_000, "NewDump"]]) {
      fs.writeFileSync(path.join(ue4ss, name), `[0x0000000000000010] Class /Script/Engine.${tag}\n`);
      stamp(path.join(ue4ss, name), seconds);
    }
  });
  const workspace = workspaceAt("ws-dump-newest");
  const newest = await executeOperation("unreal.dump", { gameDir: numbered, kinds: ["objects"], collect: true }, { workspace });
  assert.equal(path.basename(artifactOf(newest, "objects").path), "UE4SS_ObjectDump_z.txt");
  const normalized = fs.readFileSync(path.join(workspace.root, "dumps", "unreal-objects.json"), "utf8");
  assert.match(normalized, /NewDump/);
  assert.doesNotMatch(normalized, /OldDump/);

  const plain = dumpGame("game-dump-plain", ({ ue4ss }) => {
    fs.writeFileSync(path.join(ue4ss, "UE4SS_ObjectDump_z.txt"), "[0x1] Package /Script/Newer\n");
    stamp(path.join(ue4ss, "UE4SS_ObjectDump_z.txt"), 3_000_000);
    stamp(path.join(ue4ss, "UE4SS_ObjectDump.txt"), 1_000_000);
  });
  const plainResult = await executeOperation("unreal.dump", { gameDir: plain, kinds: ["objects"] }, { workspace: workspaceAt("ws-dump-plain") });
  assert.equal(path.basename(artifactOf(plainResult, "objects").path), "UE4SS_ObjectDump.txt");
});

test("collect searches the same roots as found: a dump beside the executable is collected", async () => {
  const gameDir = dumpGame("game-dump-roots", ({ ue4ss, binaries }) => {
    for (const name of ["UE4SS_ObjectDump.txt", "Mappings.usmap"]) fs.renameSync(path.join(ue4ss, name), path.join(binaries, name));
  });
  const workspace = workspaceAt("ws-dump-roots");
  const result = await executeOperation("unreal.dump", { gameDir, collect: true }, { workspace });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(artifactOf(result, "objects").status, "found");
  assert.equal(artifactOf(result, "usmap").status, "found");
  for (const name of ["UE4SS_ObjectDump.txt", "Mappings.usmap"]) {
    assert.ok(fs.existsSync(path.join(workspace.root, "dumps", name)), name);
  }
  assert.ok(fs.existsSync(path.join(workspace.root, "dumps", "unreal-objects.json")));
});

test("collect honours normalize:false, and expectedPath is where collect writes", async () => {
  const gameDir = dumpGame("game-dump-nonormalize");
  const workspace = workspaceAt("ws-dump-nonormalize");
  const plannedWorkspace = workspaceAt("ws-dump-expected");
  const planned = await executeOperation("unreal.dump", { gameDir }, { workspace: plannedWorkspace });
  const dumps = path.join(workspace.root, "dumps");
  assert.equal(artifactOf(planned, "objects").expectedPath, path.join(plannedWorkspace.root, "dumps", "UE4SS_ObjectDump.txt"));

  const result = await executeOperation("unreal.dump", { gameDir, collect: true, normalize: false }, { workspace });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.data.dump, null);
  assert.equal(fs.existsSync(path.join(dumps, "unreal-objects.json")), false);
  assert.equal(result.data.collected.dump, null);
  for (const artifact of result.data.artifacts) {
    assert.equal(artifact.expectedPath, path.join(dumps, artifact.kind === "headers" ? "CXXHeaderDump" : path.basename(artifact.expectedPath)));
    assert.ok(fs.existsSync(artifact.expectedPath), artifact.expectedPath);
  }
  const string = await executeOperation("unreal.dump", { gameDir, collect: true, normalize: "false" }, { workspace: workspaceAt("ws-dump-nonormalize-string") });
  assert.equal(string.data.dump, null);
});

test("the dump operation says its gameWrite gate depends on deployHelper", () => {
  const dump = unreal.operations.find((operation) => operation.id === "unreal.dump");
  assert.match(dump.summary, /deployHelper/);
  assert.match(dump.summary, /gameWrite/);
  assert.equal(dump.effects.includes("gameWrite"), false, "the effect depends on an input, so the handler gates it");
});
