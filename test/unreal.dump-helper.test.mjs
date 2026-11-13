import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import unreal from "../src/engines/unreal/index.mjs";
import { executeOperation, registerOperation } from "../src/core/operations.mjs";
import crypto from "node:crypto";
import { mergeIniKeys, collectDumpArtifacts, deployNativePart, listRuns, collectRun } from "../src/engines/unreal/operations/dump.mjs";
import { createZip } from "../src/engines/unreal/operations/zip.mjs";
import { loadCatalog } from "../src/core/catalog.mjs";
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
  assert.ok(fs.existsSync(path.join(ue4ss, "Mods", "GmfDumper", "Scripts", "gmfdumper", "app.lua")));
  assert.ok(fs.existsSync(path.join(ue4ss, "Mods", "GmfDumper", "config.lua")));
  assert.equal(fs.existsSync(path.join(ue4ss, "Mods", "shared", "UEHelpers")), false);
  const ini = fs.readFileSync(path.join(ue4ss, "UE4SS-settings.ini"), "utf8");
  assert.match(ini, /bUseUObjectArrayCache = 1/);
  assert.match(ini, /UseModuleOffsets = 1/);
  assert.doesNotMatch(ini, /UseModuleOffsets = 0/);
  const helper = result.data.helper;
  const settingsBackup = helper.backup.find((entry) => entry.target.endsWith("UE4SS-settings.ini"));
  assert.ok(settingsBackup && fs.existsSync(settingsBackup.path), "the settings file must be backed up");
  assert.match(fs.readFileSync(settingsBackup.path, "utf8"), /UseModuleOffsets = 0/);
});

test("the deployed mod is the full dumper: entry script, modules, vendored JSON and default config", () => {
  const mod = path.join(repoRoot, "templates/unreal/dumper/Mods/GmfDumper");
  const main = fs.readFileSync(path.join(mod, "Scripts", "main.lua"), "utf8");
  assert.match(main, /require\("gmfdumper\.app"\)/);
  for (const name of ["app", "collect", "config", "fs", "levels", "manifest", "runner", "steps", "tour"]) {
    assert.ok(fs.existsSync(path.join(mod, "Scripts", "gmfdumper", `${name}.lua`)), name);
  }
  assert.ok(fs.existsSync(path.join(mod, "Scripts", "vendor", "dkjson.lua")));
  assert.ok(fs.existsSync(path.join(mod, "config.lua")));
  assert.equal(fs.existsSync(path.join(repoRoot, "templates/unreal/dumper/Mods/shared")), false, "UEHelpers is no longer part of the payload");
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
  for (const expected of ["UE4SS_ObjectDump.txt", "Mappings.usmap", "Fixture.hpp"]) {
    assert.ok(names.includes(expected), `${expected} missing from ${names.join(",")}`);
  }
  const direct = collectDumpArtifacts(path.join(gameDir, "ue4ss"), path.join(workspace.root, "dumps"));
  assert.ok(direct.copied.length >= 3);
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

// ---- native part -------------------------------------------------------------------------------

const INSTALL_ASSET = "UE4SS_v3.0.1-100-gaaaaaaa.zip";
const OTHER_ASSET = "UE4SS_v3.0.1-200-gbbbbbbb.zip";

function nativeZip(name, { builtFor }) {
  const dir = path.join(root, `zip-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  // Created at run time: the content gate refuses a committed .dll.
  fs.writeFileSync(path.join(dir, "main.dll"), Buffer.from("NEW!"));
  fs.writeFileSync(
    path.join(dir, "build.json"),
    JSON.stringify({ schema: "gmfdumper.build/1", ue4ss_asset: builtFor, ue4ss_digest: null, source_hash: "abc", built_at: "2026-11-12T00:00:00Z" }),
  );
  const zip = path.join(dir, "GmfDumper-native.zip");
  createZip(zip, [
    { file: path.join(dir, "main.dll"), name: "dlls/main.dll" },
    { file: path.join(dir, "build.json"), name: "build.json" },
  ]);
  return fs.readFileSync(zip);
}

function releaseFetch(zipBytes, calls = []) {
  const digest = `sha256:${crypto.createHash("sha256").update(zipBytes).digest("hex")}`;
  return async (url) => {
    calls.push(url);
    if (url.includes("/releases/tags/gmfdumper-latest")) {
      return {
        ok: true,
        json: async () => ({
          tag_name: "gmfdumper-latest",
          draft: false,
          prerelease: true,
          assets: [{ name: "GmfDumper-native.zip", browser_download_url: "https://dl/native", digest }],
        }),
      };
    }
    if (url === "https://dl/native") return { ok: true, arrayBuffer: async () => zipBytes };
    return { ok: false, status: 404 };
  };
}

function nativeGame(name, { installedAsset = INSTALL_ASSET, stale = false } = {}) {
  const gameDir = copyFixture("ue4ss-dumps", path.join(root, name));
  const ue4ss = path.join(gameDir, "ue4ss");
  if (installedAsset) {
    fs.writeFileSync(
      path.join(ue4ss, "gmf-install.json"),
      JSON.stringify({ schema: "gmf.ue4ss_install/1", asset: installedAsset, digest: null, installed_at: "2026-11-12T00:00:00Z" }),
    );
  }
  fs.mkdirSync(path.join(ue4ss, "Mods", "GmfDumper", "Scripts"), { recursive: true });
  fs.writeFileSync(path.join(ue4ss, "Mods", "GmfDumper", "Scripts", "main.lua"), "-- old main\n");
  if (stale) {
    fs.mkdirSync(path.join(ue4ss, "Mods", "GmfDumper", "dlls"), { recursive: true });
    fs.writeFileSync(path.join(ue4ss, "Mods", "GmfDumper", "dlls", "main.dll"), Buffer.from("OLD!"));
  }
  return { gameDir, ue4ss, dll: path.join(ue4ss, "Mods", "GmfDumper", "dlls", "main.dll"), lua: path.join(ue4ss, "Mods", "GmfDumper", "Scripts", "main.lua") };
}

function nativeContext(name, { fetchImpl, toolInstall = true } = {}) {
  const tool = loadCatalog(repoRoot).tools.find((entry) => entry.id === "gmfdumper-native");
  assert.ok(tool, "the catalog registers gmfdumper-native");
  const authorizations = [{ effect: "gameWrite", source: "test: deploy" }];
  if (toolInstall) authorizations.push({ effect: "toolInstall", source: "test: native part" });
  return {
    workspace: workspaceAt(`ws-${name}`),
    catalog: { version: 1, tools: [tool] },
    toolCacheDir: path.join(root, `toolcache-${name}`),
    fetchImpl,
    authorizations,
  };
}

const outsideUe4ss = (gameDir) => ({ binaries: snapshotTree(path.join(gameDir, "Binaries")), content: snapshotTree(path.join(gameDir, "Content")) });

test("AC-1 deploy installs the mod, its config and a matching native part", async () => {
  const game = nativeGame("native-ok");
  const context = nativeContext("native-ok", { fetchImpl: releaseFetch(nativeZip("ok", { builtFor: INSTALL_ASSET })) });
  const before = outsideUe4ss(game.gameDir);
  const result = await executeOperation("unreal.deploy_dumper", { gameDir: game.gameDir }, context);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.data.native.native, "installed");
  assert.ok(fs.existsSync(game.lua));
  assert.ok(fs.existsSync(path.join(game.ue4ss, "Mods", "GmfDumper", "config.lua")));
  assert.equal(fs.readFileSync(game.dll, "utf8"), "NEW!");
  assert.notEqual(fs.readFileSync(game.lua, "utf8"), "-- old main\n");
  for (const target of ["main.lua", "UE4SS-settings.ini"]) {
    const entry = result.data.backup.find((item) => item.target.endsWith(target));
    assert.ok(entry && fs.existsSync(entry.path), `${target} is backed up`);
  }
  assert.match(fs.readFileSync(path.join(game.ue4ss, "UE4SS-settings.ini"), "utf8"), /UseModuleOffsets = 1/);
  assert.deepEqual(outsideUe4ss(game.gameDir), before, "nothing is written outside the UE4SS folder");
  assert.ok(fs.existsSync(path.join(context.toolCacheDir, "gmfdumper-native")), "the download went to the tool cache");
});

test("AC-2 a native part that does not match, or cannot be checked, is not installed", async () => {
  const mismatched = nativeGame("native-mismatch");
  const mismatch = await executeOperation(
    "unreal.deploy_dumper",
    { gameDir: mismatched.gameDir },
    nativeContext("native-mismatch", { fetchImpl: releaseFetch(nativeZip("other", { builtFor: OTHER_ASSET })) }),
  );
  assert.equal(mismatch.ok, true, mismatch.error?.message);
  assert.equal(mismatch.data.native.native, "mismatch");
  assert.equal(mismatch.data.native.installedAsset, INSTALL_ASSET);
  assert.equal(mismatch.data.native.builtFor, OTHER_ASSET);
  assert.ok(mismatch.data.native.advice);
  assert.equal(fs.existsSync(mismatched.dll), false);
  assert.notEqual(fs.readFileSync(mismatched.lua, "utf8"), "-- old main\n");

  const unknownGame = nativeGame("native-unknown", { installedAsset: null });
  const unknownCalls = [];
  const unknown = await executeOperation(
    "unreal.deploy_dumper",
    { gameDir: unknownGame.gameDir },
    nativeContext("native-unknown", { fetchImpl: releaseFetch(nativeZip("unk", { builtFor: INSTALL_ASSET }), unknownCalls) }),
  );
  assert.equal(unknown.data.native.native, "unknown");
  assert.equal(fs.existsSync(unknownGame.dll), false);
  assert.notEqual(fs.readFileSync(unknownGame.lua, "utf8"), "-- old main\n");
  assert.deepEqual(unknownCalls, [], "without an install record nothing is downloaded");

  const unauthorizedGame = nativeGame("native-unauth");
  const unauthorizedCalls = [];
  const unauthorized = await executeOperation(
    "unreal.deploy_dumper",
    { gameDir: unauthorizedGame.gameDir },
    nativeContext("native-unauth", { toolInstall: false, fetchImpl: releaseFetch(nativeZip("una", { builtFor: INSTALL_ASSET }), unauthorizedCalls) }),
  );
  assert.equal(unauthorized.ok, true, unauthorized.error?.message);
  assert.equal(unauthorized.data.native.native, "not_authorized");
  assert.equal(fs.existsSync(unauthorizedGame.dll), false);
  assert.notEqual(fs.readFileSync(unauthorizedGame.lua, "utf8"), "-- old main\n");
  assert.deepEqual(unauthorizedCalls, [], "without toolInstall nothing is downloaded");
});

test("a failed download reports unavailable with the message", async () => {
  const game = nativeGame("native-unavailable");
  const context = nativeContext("native-unavailable", { fetchImpl: async () => ({ ok: false, status: 503 }) });
  const result = await deployNativePart(context, { path: game.ue4ss });
  assert.equal(result.native, "unavailable");
  assert.match(result.error, /503/);
});

test("a stale dll is removed on mismatch and appears in backup", async () => {
  const game = nativeGame("native-stale", { stale: true });
  const context = nativeContext("native-stale", { fetchImpl: releaseFetch(nativeZip("stale", { builtFor: OTHER_ASSET })) });
  const result = await executeOperation("unreal.deploy_dumper", { gameDir: game.gameDir }, context);
  assert.equal(result.data.native.native, "mismatch");
  assert.equal(fs.existsSync(game.dll), false, "the stale dll is gone");
  const entry = result.data.backup.find((item) => item.target.endsWith("main.dll"));
  assert.ok(entry && fs.existsSync(entry.path), "the stale dll is in the backup list");
  assert.equal(fs.readFileSync(entry.path, "utf8"), "OLD!");
});

test("deployHelper in unreal.dump reports the native part under helper.native", async () => {
  const game = nativeGame("native-via-dump");
  const context = nativeContext("native-via-dump", { fetchImpl: releaseFetch(nativeZip("via", { builtFor: INSTALL_ASSET })) });
  const result = await executeOperation("unreal.dump", { gameDir: game.gameDir, deployHelper: true }, context);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.data.helper.native.native, "installed");
  assert.equal(fs.readFileSync(game.dll, "utf8"), "NEW!");
});

// ---- collected runs ----------------------------------------------------------------------------

function gameWithRuns(name) {
  const gameDir = copyFixture("ue4ss-dumps", path.join(root, name));
  const dumps = path.join(gameDir, "ue4ss", "Dumps");
  const runFixture = fixturePath("unreal-run");
  const place = (run, finished) => {
    const target = path.join(dumps, run);
    fs.cpSync(runFixture, target, { recursive: true });
    const complete = JSON.parse(fs.readFileSync(path.join(target, "run_complete.json"), "utf8"));
    complete.finished = finished;
    fs.writeFileSync(path.join(target, "run_complete.json"), JSON.stringify(complete));
  };
  place("run-old", "2026-11-10T10:00:00Z");
  place("run-new", "2026-11-12T10:00:00Z");
  fs.cpSync(runFixture, path.join(dumps, "run-partial"), { recursive: true });
  fs.rmSync(path.join(dumps, "run-partial", "run_complete.json"));
  return { gameDir, ue4ss: path.join(gameDir, "ue4ss") };
}

test("listRuns returns runs newest first and marks the incomplete one", () => {
  const { ue4ss } = gameWithRuns("runs-list");
  const runs = listRuns(ue4ss);
  assert.deepEqual(runs.filter((run) => run.complete).map((run) => run.name), ["run-new", "run-old"]);
  const partial = runs.find((run) => run.name === "run-partial");
  assert.equal(partial.complete, false);
  assert.equal(partial.finished, null);
  assert.equal(runs.find((run) => run.name === "run-new").finished, "2026-11-12T10:00:00Z");
  assert.deepEqual(listRuns(path.join(root, "no-such-ue4ss")), []);
});

test("collect copies the newest complete run and writes unreal-objects.json", async () => {
  const { gameDir, ue4ss } = gameWithRuns("runs-collect");
  const workspace = workspaceAt("ws-runs-collect");
  const direct = collectRun(ue4ss, workspace.root, {});
  assert.equal(direct.run, "run-new");
  assert.equal(direct.path, path.join(workspace.root, "dumps", "unreal", "runs", "run-new"));
  assert.ok(direct.copied >= 5);
  assert.ok(fs.existsSync(path.join(direct.path, "Reflection", "classes.json")));
  assert.ok(fs.existsSync(path.join(direct.path, "run_complete.json")));
  assert.equal(fs.existsSync(path.join(workspace.root, "dumps", "unreal", "runs", "run-old")), false);
  const normalized = JSON.parse(fs.readFileSync(path.join(workspace.root, "dumps", "unreal-objects.json"), "utf8"));
  assert.ok(normalized.classes.some((entry) => entry.name === "RunGameMode"));

  const viaOperation = workspaceAt("ws-runs-collect-op");
  const result = await executeOperation("unreal.dump", { gameDir, collect: true }, { workspace: viaOperation });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.data.collected.run, "run-new");
  assert.ok(fs.existsSync(path.join(viaOperation.root, "dumps", "unreal", "runs", "run-new", "manifest.json")));
  assert.ok(fs.existsSync(path.join(viaOperation.root, "dumps", "UE4SS_ObjectDump.txt")), "loose files are still collected");
  const viaNormalized = JSON.parse(fs.readFileSync(path.join(viaOperation.root, "dumps", "unreal-objects.json"), "utf8"));
  assert.ok(viaNormalized.classes.some((entry) => entry.name === "RunGameMode"));

  const skip = collectRun(ue4ss, workspaceAt("ws-runs-nonormalize").root, { normalize: false });
  assert.equal(skip.dump, null);
});

test("an incomplete run is refused", () => {
  const { ue4ss } = gameWithRuns("runs-incomplete");
  const workspace = workspaceAt("ws-runs-incomplete");
  assert.throws(() => collectRun(ue4ss, workspace.root, { run: "run-partial" }), (error) => error.code === "GMF-E-PLAN-001" && /incomplete/.test(error.message));
  assert.equal(fs.existsSync(path.join(workspace.root, "dumps")), false, "nothing is written");
  assert.throws(() => collectRun(ue4ss, workspace.root, { run: "no-such-run" }), (error) => error.code === "GMF-E-PLAN-001");
});
