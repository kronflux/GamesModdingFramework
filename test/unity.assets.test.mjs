import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { executeOperation } from "../src/core/operations.mjs";
import "../src/engines/unity/index.mjs";
import { repoRoot, fixture as fixturePath } from "./helpers/paths.mjs";
import { tempRoot } from "./helpers/tmp.mjs";
import { snapshotTree } from "./helpers/tree.mjs";

const fixture = fixturePath("unity-assets");

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function snapshot(dir, base = dir, out = new Map()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(base, full);
    if (entry.isDirectory()) snapshot(full, base, out);
    else out.set(relative, sha256File(full));
  }
  return out;
}

function makeToolCache(ids) {
  const cacheDir = tempRoot("gmf-assets-tools-");
  const manifest = {};
  for (const id of ids) {
    const file = path.join(cacheDir, id, `${id}.cmd`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "SYNTHETIC TOOL");
    manifest[id] = {
      id,
      version: "test",
      path: file,
      args: [],
      verification: { kind: "none", value: null, ok: true },
      installedAt: new Date().toISOString(),
      source: { type: "local" },
    };
  }
  fs.writeFileSync(path.join(cacheDir, "tools.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return cacheDir;
}

function extractRunner(calls) {
  return async (cmd, args) => {
    calls.push({ cmd, args });
    // AssetStudioModCLI takes -o <dir>.
    const index = Math.max(args.lastIndexOf("-o"), args.lastIndexOf("--output"));
    const outputDir = index >= 0 ? args[index + 1] : null;
    if (outputDir) {
      fs.mkdirSync(path.join(outputDir, "Assets"), { recursive: true });
      fs.writeFileSync(path.join(outputDir, "Assets", "FixtureAsset.asset"), "SYNTHETIC EXTRACTED ASSET");
      fs.writeFileSync(path.join(outputDir, "Assets", "FixtureTexture.png"), "SYNTHETIC PNG");
    }
    return { code: 0, stdout: "extracted", stderr: "" };
  };
}

function inspectRunner(calls, metadata = { objects: [{ name: "FixtureAsset", class: "Texture2D", pathId: 1 }] }) {
  return async (cmd, args) => {
    calls.push({ cmd, args });
    const index = args.lastIndexOf("--output");
    const target = index >= 0 ? args[index + 1] : null;
    if (target) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(metadata));
    }
    return { code: 0, stdout: "inspected", stderr: "" };
  };
}

// Stands in for "python gmf_unitypy.py replace ... --output <staged file>".
const REPLACEMENT = path.join(tempRoot("gmf-assets-replacement-"), "texture.png");
fs.writeFileSync(REPLACEMENT, "SYNTHETIC PNG");

function replaceRunner(calls) {
  return async (cmd, args) => {
    calls.push({ cmd, args });
    const index = args.lastIndexOf("--output");
    if (index >= 0) {
      fs.mkdirSync(path.dirname(args[index + 1]), { recursive: true });
      fs.writeFileSync(args[index + 1], "SYNTHETIC REPLACED ASSET FILE");
    }
    return { code: 0, stdout: "replaced", stderr: "" };
  };
}

// AssetStudioModCLI is the extraction tool.
test("extract_assets runs AssetStudioModCLI into extracted/ and never touches the game", async () => {
  const before = snapshot(fixture);
  const workspace = { root: tempRoot("gmf-assets-ws-") };
  const cacheDir = makeToolCache(["assetstudio"]);
  const calls = [];

  const result = await executeOperation(
    "unity.extract_assets",
    { gameDir: fixture },
    { workspace, toolCacheDir: cacheDir, runProcess: extractRunner(calls) },
  );
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(calls.length, 1);
  assert.match(calls[0].cmd, /assetstudio\.cmd$/);
  const args = calls[0].args;
  assert.equal(args[0], path.join(fixture, "Game_Data"), "the input is the game's data folder by default");
  assert.equal(args[args.indexOf("-m") + 1], "export");
  assert.equal(args[args.indexOf("-o") + 1], result.data.outputDir);
  assert.equal(args.includes("--input"), false, "AssetStudioModCLI takes the input as its first argument");
  assert.match(result.data.outputDir, /extracted[\\/]unity[\\/]assets$/);
  assert.ok(result.data.files.length >= 2);
  for (const file of result.data.files) {
    assert.ok(path.resolve(file).startsWith(path.resolve(workspace.root)));
    assert.ok(fs.existsSync(file));
  }
  assert.deepEqual(snapshot(fixture), before, "extract must not modify the game install");
});

test("a missing asset tool raises GMF-E-TOOL-001 and no GPL tool is vendored", async () => {
  const workspace = { root: tempRoot("gmf-assets-missing-ws-") };
  const cacheDir = makeToolCache([]);

  const missing = await executeOperation(
    "unity.extract_assets",
    { gameDir: fixture },
    { workspace, toolCacheDir: cacheDir },
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "GMF-E-TOOL-001");
  assert.match(missing.error.message, /assetstudio/i);

  const source = fs.readFileSync(path.join(repoRoot, "src/engines/unity/operations/assets.mjs"), "utf8");
  assert.ok(!/AssetRipper\.(exe|zip)/i.test(source), "no AssetRipper binary is referenced from the repo");
  assert.ok(!fs.existsSync(path.join(repoRoot, "src/engines/unity/operations/AssetRipper.CLI.exe")));
});

test("the resolved GPL tool lives in the tool cache, not in the repository", async () => {
  const workspace = { root: tempRoot("gmf-assets-cache-ws-") };
  const cacheDir = makeToolCache(["assetstudio"]);
  const result = await executeOperation(
    "unity.extract_assets",
    { gameDir: fixture },
    { workspace, toolCacheDir: cacheDir, runProcess: extractRunner([]) },
  );
  assert.equal(result.ok, true, result.error?.message);
  assert.ok(result.data.tool.path.startsWith(cacheDir));
  assert.ok(!result.data.tool.path.startsWith(repoRoot));
});

test("inspect_asset returns UnityPy object metadata from the workspace", async () => {
  const workspace = { root: tempRoot("gmf-assets-inspect-ws-") };
  const cacheDir = makeToolCache(["unitypy"]);
  const calls = [];

  const result = await executeOperation(
    "unity.inspect_asset",
    { gameDir: fixture, assetPath: "Game_Data/resources.assets" },
    { workspace, toolCacheDir: cacheDir, runProcess: inspectRunner(calls) },
  );
  assert.equal(result.ok, true, result.error?.message);
  assert.match(calls[0].cmd, /unitypy\.cmd$/);
  assert.match(calls[0].args[0], /gmf_unitypy\.py$/, "UnityPy has no inspect command; gmf's helper does it");
  assert.equal(calls[0].args[1], "inspect");
  assert.equal(calls[0].args[2], path.join(fixture, "Game_Data", "resources.assets"));
  assert.deepEqual(result.data.metadata.objects, [
    { name: "FixtureAsset", class: "Texture2D", pathId: 1 },
  ]);
  assert.ok(result.data.metadataPath.startsWith(path.resolve(workspace.root)));
});

test("replace_asset refuses without authorization or a workspace backup", async () => {
  const cacheDir = makeToolCache(["unitypy"]);
  const game = tempRoot("gmf-assets-replace-game-");
  fs.cpSync(fixture, game, { recursive: true });
  const workspace = { root: tempRoot("gmf-assets-replace-ws-") };
  const before = { game: snapshotTree(game), workspace: snapshotTree(workspace.root), cache: snapshotTree(cacheDir) };
  const calls = [];

  const noAuthorization = await executeOperation(
    "unity.replace_asset",
    { gameDir: game, assetPath: "Game_Data/resources.assets", object: "1", replacementPath: REPLACEMENT },
    { workspace, toolCacheDir: cacheDir, runProcess: replaceRunner(calls) },
  );
  assert.equal(noAuthorization.ok, false);
  assert.equal(noAuthorization.error.code, "GMF-E-GATE-001");

  const noWorkspace = await executeOperation(
    "unity.replace_asset",
    { gameDir: game, assetPath: "Game_Data/resources.assets", object: "1", replacementPath: REPLACEMENT },
    {
      toolCacheDir: cacheDir,
      runProcess: replaceRunner(calls),
      authorization: [{ effect: "gameWrite", source: "test: replace" }],
    },
  );
  assert.equal(noWorkspace.ok, false);
  assert.equal(noWorkspace.error.code, "GMF-E-GATE-001");

  assert.equal(calls.length, 0, "a refused call never starts the tool");
  assert.deepEqual(snapshotTree(game), before.game, "the game folder is unchanged");
  assert.deepEqual(snapshotTree(workspace.root), before.workspace, "nothing is written to the workspace");
  assert.deepEqual(snapshotTree(cacheDir), before.cache, "the tool cache is unchanged");
});

test("replace_asset backs up the original asset before the tool writes", async () => {
  const cacheDir = makeToolCache(["unitypy"]);
  const game = tempRoot("gmf-assets-replace-game2-");
  fs.cpSync(fixture, game, { recursive: true });
  const workspace = { root: tempRoot("gmf-assets-replace-ws2-") };
  const target = path.join(game, "Game_Data", "resources.assets");
  const original = sha256File(target);
  const calls = [];

  const result = await executeOperation(
    "unity.replace_asset",
    { gameDir: game, assetPath: "Game_Data/resources.assets", object: "1", replacementPath: REPLACEMENT },
    {
      workspace,
      toolCacheDir: cacheDir,
      runProcess: replaceRunner(calls),
      authorization: [{ effect: "gameWrite", source: "user: replace the texture" }],
    },
  );
  assert.equal(result.ok, true, result.error?.message);
  assert.ok(result.data.backup);
  assert.equal(result.data.backup.sha256, original);
  assert.equal(sha256File(result.data.backup.backupPath), original);
  assert.deepEqual(result.data.files, [target]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].args[0], /gmf_unitypy\.py$/);
  assert.deepEqual(calls[0].args.slice(1, 8), ["replace", target, "--object", "1", "--from", REPLACEMENT, "--output"]);
  assert.ok(result.data.staged.startsWith(path.resolve(workspace.root)), "the helper writes into the workspace, never the game");
  assert.equal(fs.readFileSync(target, "utf8"), "SYNTHETIC REPLACED ASSET FILE", "the staged file is copied into the game");
  assert.equal(result.authorization.source, "user: replace the texture");
});

test("an output directory outside the workspace is refused", async () => {
  const workspace = { root: tempRoot("gmf-assets-escape-ws-") };
  const cacheDir = makeToolCache(["assetstudio"]);
  const outside = tempRoot("gmf-assets-outside-");

  const result = await executeOperation(
    "unity.extract_assets",
    { gameDir: fixture, outputDir: outside },
    { workspace, toolCacheDir: cacheDir, runProcess: extractRunner([]) },
  );
  assert.equal(result.ok, false);
  assert.match(result.error.message, /outside the workspace/i);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("replace_asset needs the object and the replacement file", async () => {
  const cacheDir = makeToolCache(["unitypy"]);
  const game = tempRoot("gmf-assets-replace-game3-");
  fs.cpSync(fixture, game, { recursive: true });
  const workspace = { root: tempRoot("gmf-assets-replace-ws3-") };
  const context = { workspace, toolCacheDir: cacheDir, runProcess: replaceRunner([]), authorization: [{ effect: "gameWrite", source: "test" }] };
  const missing = await executeOperation("unity.replace_asset", { gameDir: game, assetPath: "Game_Data/resources.assets" }, context);
  assert.equal(missing.ok, false);
  assert.match(missing.error.message, /object|replacementPath/);
  const absent = await executeOperation(
    "unity.replace_asset",
    { gameDir: game, assetPath: "Game_Data/resources.assets", object: "1", replacementPath: path.join(game, "nope.png") },
    context,
  );
  assert.equal(absent.ok, false);
  assert.match(absent.error.message, /nope\.png/);
});

test("extract_assets passes types, a name filter, the Unity version and IL2CPP dummy assemblies", async () => {
  const workspace = { root: tempRoot("gmf-assets-il2cpp-ws-"), profile: { engine: { id: "unity", version: "6000.3.14f1" }, runtime: { backend: "il2cpp" } } };
  const dummy = path.join(workspace.root, "decompiled", "unity", "il2cpp", "DummyDll");
  fs.mkdirSync(dummy, { recursive: true });
  fs.writeFileSync(path.join(dummy, "Assembly-CSharp.dll"), "SYNTHETIC");
  const calls = [];
  const result = await executeOperation(
    "unity.extract_assets",
    { gameDir: fixture, assetPath: "Game_Data/resources.assets", types: "tex2d,textAsset", filter: "Icon" },
    { workspace, toolCacheDir: makeToolCache(["assetstudio"]), runProcess: extractRunner(calls) },
  );
  assert.equal(result.ok, true, result.error?.message);
  const args = calls[0].args;
  assert.equal(args[0], path.join(fixture, "Game_Data", "resources.assets"));
  assert.equal(args[args.indexOf("-t") + 1], "tex2d,textAsset");
  assert.equal(args[args.indexOf("--filter-by-name") + 1], "Icon");
  assert.equal(args[args.indexOf("--unity-version") + 1], "6000.3.14f1");
  assert.equal(args[args.indexOf("--assembly-folder") + 1], dummy);
  assert.equal(result.data.assemblyFolder, dummy);
});

test("extract_assets on IL2CPP without dummy assemblies still runs and says how to get them", async () => {
  const workspace = { root: tempRoot("gmf-assets-il2cpp-nodummy-ws-"), profile: { runtime: { backend: "il2cpp" } } };
  const calls = [];
  const result = await executeOperation(
    "unity.extract_assets",
    { gameDir: fixture },
    { workspace, toolCacheDir: makeToolCache(["assetstudio"]), runProcess: extractRunner(calls) },
  );
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(calls[0].args.includes("--assembly-folder"), false);
  assert.match(result.data.notes.join(" "), /format=dummydll/);
});

test("extract_assets reports AssetStudio errors cleanly and warns about single-file MonoBehaviours", async () => {
  const workspace = { root: tempRoot("gmf-assets-log-ws-") };
  const noisy = "Exported [1/3]\rExported [2/3]\r\u001b[31;1m[Error]\u001b[0m Export error. Failed to convert texture \"Font Texture\" into image\nExported [3/3]\r\n\u001b[36;1m[Info]\u001b[0m Finished exporting 2 asset(s).\n";
  const runner = async (cmd, args) => {
    const out = args[args.indexOf("-o") + 1];
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "a.png"), "x");
    return { code: 0, stdout: noisy, stderr: "" };
  };
  const result = await executeOperation(
    "unity.extract_assets",
    { gameDir: fixture, assetPath: "Game_Data/resources.assets", types: "monoBehaviour" },
    { workspace, toolCacheDir: makeToolCache(["assetstudio"]), runProcess: runner },
  );
  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual(result.data.errors, ['Export error. Failed to convert texture "Font Texture" into image']);
  assert.ok(result.data.log.every((line) => !/\u001b|Exported \[/.test(line)), JSON.stringify(result.data.log));
  assert.ok(result.data.log.some((line) => /Finished exporting/.test(line)));
  assert.match(result.data.notes.join(" "), /data folder/);
});

function gameInsideParent() {
  const parent = tempRoot("gmf-assets-parent-");
  const game = path.join(parent, "game");
  fs.cpSync(fixture, game, { recursive: true });
  return { parent, game };
}

test("a relative asset path that climbs out of the game folder is refused and nothing is written", async () => {
  const { parent, game } = gameInsideParent();
  const outside = path.join(parent, "x.assets");
  fs.writeFileSync(outside, "OUTSIDE ORIGINAL");
  const workspace = { root: tempRoot("gmf-assets-climb-ws-") };
  const calls = [];
  const context = {
    workspace,
    toolCacheDir: makeToolCache(["unitypy"]),
    runProcess: replaceRunner(calls),
    authorization: [{ effect: "gameWrite", source: "test: replace" }],
  };
  const result = await executeOperation(
    "unity.replace_asset",
    { gameDir: game, assetPath: "../x.assets", object: "1", replacementPath: REPLACEMENT },
    context,
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GMF-E-EXEC-001");
  assert.equal(calls.length, 0);
  assert.equal(fs.readFileSync(outside, "utf8"), "OUTSIDE ORIGINAL");
  assert.deepEqual(fs.readdirSync(workspace.root), [], "nothing was staged or backed up");

  const inspect = await executeOperation(
    "unity.inspect_asset",
    { gameDir: game, assetPath: "../x.assets" },
    { workspace, toolCacheDir: context.toolCacheDir, runProcess: inspectRunner([]) },
  );
  assert.equal(inspect.ok, false);
  assert.equal(inspect.error.code, "GMF-E-EXEC-001");
});

test("an asset whose name starts with two dots inside the game folder is accepted", async () => {
  const { game } = gameInsideParent();
  fs.writeFileSync(path.join(game, "..foo.assets"), "DOTS");
  const calls = [];
  const result = await executeOperation(
    "unity.inspect_asset",
    { gameDir: game, assetPath: "..foo.assets" },
    { workspace: { root: tempRoot("gmf-assets-dots-ws-") }, toolCacheDir: makeToolCache(["unitypy"]), runProcess: inspectRunner(calls) },
  );
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(calls[0].args[2], path.join(game, "..foo.assets"));
});

test("replace_asset leaves the original bytes when the staged copy cannot be put in place", async () => {
  const { game } = gameInsideParent();
  const target = path.join(game, "Game_Data", "resources.assets");
  const original = fs.readFileSync(target);
  // A directory where the temporary file must go makes the copy fail.
  fs.mkdirSync(`${target}.gmf-tmp`);
  const result = await executeOperation(
    "unity.replace_asset",
    { gameDir: game, assetPath: "Game_Data/resources.assets", object: "1", replacementPath: REPLACEMENT },
    {
      workspace: { root: tempRoot("gmf-assets-atomic-ws-") },
      toolCacheDir: makeToolCache(["unitypy"]),
      runProcess: replaceRunner([]),
      authorization: [{ effect: "gameWrite", source: "test: replace" }],
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GMF-E-EXEC-001");
  assert.deepEqual(fs.readFileSync(target), original);
});

test("extract_assets counts only the files of this run", async () => {
  const workspace = { root: tempRoot("gmf-assets-count-ws-") };
  const stale = path.join(workspace.root, "extracted", "unity", "assets", "old.png");
  fs.mkdirSync(path.dirname(stale), { recursive: true });
  fs.writeFileSync(stale, "OLD");
  const result = await executeOperation(
    "unity.extract_assets",
    { gameDir: fixture },
    { workspace, toolCacheDir: makeToolCache(["assetstudio"]), runProcess: extractRunner([]) },
  );
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.data.count, 2, "the earlier file is not counted");
  assert.ok(!result.data.files.includes(stale));
});

test("inspect_asset does not pass on metadata left by an earlier run", async () => {
  const workspace = { root: tempRoot("gmf-assets-stale-ws-") };
  const metadata = path.join(workspace.root, "extracted", "unity", "inspect", "resources.assets.metadata.json");
  fs.mkdirSync(path.dirname(metadata), { recursive: true });
  fs.writeFileSync(metadata, JSON.stringify({ objects: [{ name: "STALE" }] }));
  const silent = async () => ({ code: 0, stdout: "", stderr: "" });
  const inspect = await executeOperation(
    "unity.inspect_asset",
    { gameDir: fixture, assetPath: "Game_Data/resources.assets" },
    { workspace, toolCacheDir: makeToolCache(["unitypy"]), runProcess: silent },
  );
  assert.equal(inspect.ok, false, "a helper that wrote nothing must not pass on stale metadata");
});
