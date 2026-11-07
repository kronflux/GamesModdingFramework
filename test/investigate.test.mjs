import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli/main.mjs";
import { executeOperation } from "../src/core/operations.mjs";
import { readWorkspace } from "../src/core/workspace.mjs";
import "../src/engines/unity/index.mjs";
import { repoRoot, fixture as fixturePath } from "./helpers/paths.mjs";

const fixture = fixturePath("unity-mono");
const tempRoots = [];

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function snapshot(dir, base = dir, out = new Map()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(base, full);
    const stat = fs.lstatSync(full);
    out.set(relative, `${entry.isDirectory() ? "dir" : stat.isSymbolicLink() ? "link" : "file"}:${stat.size}:${stat.mtimeMs}`);
    if (entry.isDirectory()) snapshot(full, base, out);
  }
  return out;
}

after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

test("investigate writes a profile and no game files", async () => {
  const root = tempDir("gmf-investigate-");
  const workspaceDir = path.join(root, "workspace");
  fs.mkdirSync(workspaceDir);
  const before = snapshot(fixture);

  const result = await runCli(
    ["investigate", "--game", fixture, "--workspace", workspaceDir, "--json"],
    {},
  );
  assert.equal(result.exitCode, 0, result.stdout);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true, body.error?.message);

  for (const file of ["gmf.json", "gmf.local.json", "gmf.profile.json"]) {
    assert.ok(fs.existsSync(path.join(workspaceDir, file)), `${file} exists`);
  }

  const committedText = fs.readFileSync(path.join(workspaceDir, "gmf.json"), "utf8");
  const escapedFixture = JSON.stringify(fixture).slice(1, -1);
  assert.ok(!committedText.includes(fixture), "committed identity has no absolute path");
  assert.ok(!committedText.includes(escapedFixture), "committed identity has no JSON-escaped absolute path");
  assert.equal(JSON.parse(committedText).game.engine, "unity");

  const local = JSON.parse(fs.readFileSync(path.join(workspaceDir, "gmf.local.json"), "utf8"));
  assert.equal(local.gameDir, path.resolve(fixture));

  const profile = JSON.parse(fs.readFileSync(path.join(workspaceDir, "gmf.profile.json"), "utf8"));
  assert.equal(profile.version, 1);
  assert.equal(profile.engine.id, "unity");
  assert.ok(profile.evidence.length > 0);
  assert.ok(Array.isArray(profile.unknowns));

  assert.ok(!fs.existsSync(path.join(workspaceDir, "decompiled")), "no decompiled output yet");
  assert.deepEqual(snapshot(fixture), before, "investigate must not write into the game directory");
  assert.deepEqual(fs.readdirSync(root), ["workspace"], "no files are created outside the workspace");
});

test("investigate refreshes an existing workspace profile", async () => {
  const workspaceDir = tempDir("gmf-investigate-refresh-");
  const first = await runCli(["investigate", "--game", fixture, "--workspace", workspaceDir, "--json"], {});
  assert.equal(first.exitCode, 0, first.stdout);
  const configAfterFirst = fs.readFileSync(path.join(workspaceDir, "gmf.json"), "utf8");
  const second = await runCli(["investigate", "--game", fixture, "--workspace", workspaceDir, "--json"], {});
  assert.equal(second.exitCode, 0, second.stdout);
  const body = JSON.parse(second.stdout);
  assert.equal(body.ok, true);
  const workspace = readWorkspace(workspaceDir);
  assert.equal(workspace.local.gameDir, path.resolve(fixture));
  assert.equal(fs.readFileSync(path.join(workspaceDir, "gmf.json"), "utf8"), configAfterFirst, "the committed identity is not rewritten");
  const profile = JSON.parse(fs.readFileSync(path.join(workspaceDir, "gmf.profile.json"), "utf8"));
  assert.equal(profile.version, 1);
  assert.equal(profile.engine.id, "unity");
  assert.equal(profile.engine.version, "2021.3.45f1");
  assert.equal(profile.runtime.backend, "mono");
});

test("workspace.init detects the engine and is safe to run twice", async () => {
  const workspaceDir = tempDir("gmf-init-");
  fs.mkdirSync(path.join(workspaceDir, "mods"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "mods", "keep.txt"), "keep");
  fs.writeFileSync(
    path.join(workspaceDir, "gmf.json"),
    `${JSON.stringify({ version: 1, game: { name: "Kept", engine: "unknown", author: "Original" } }, null, 2)}\n`,
  );

  const first = await executeOperation(
    "workspace.init",
    { gameDir: fixture, workspaceDir, author: "Tester" },
    { root: repoRoot },
  );
  assert.equal(first.ok, true, first.error?.message);
  assert.equal(first.data.workspace.config.game.author, "Tester");
  assert.equal(first.data.workspace.config.game.engine, "unity");
  assert.equal(first.data.workspace.config.game.name, "Fixture Product");
  assert.equal(first.data.workspace.local.gameDir, path.resolve(fixture));

  const second = await executeOperation(
    "workspace.init",
    { gameDir: fixture, workspaceDir, author: "" },
    { root: repoRoot },
  );
  assert.equal(second.ok, true, second.error?.message);
  assert.equal(second.data.workspace.config.game.author, "Tester", "an existing author is preserved");
  assert.ok(fs.existsSync(path.join(workspaceDir, "mods", "keep.txt")));
});

test("game.inventory returns relative paths and counts, not content", async () => {
  const result = await executeOperation("game.inventory", { gameDir: fixture }, {});
  assert.equal(result.ok, true, result.error?.message);

  const { files, dirs, counts } = result.data;
  assert.ok(counts.files >= 5);
  assert.ok(counts.dirs >= 3);
  assert.equal(counts.files, files.length);
  assert.equal(counts.dirs, dirs.length);
  for (const file of files) {
    assert.ok(!path.isAbsolute(file.path));
    assert.ok(!file.path.split(/[\\/]/).includes(".."));
    assert.equal(file.content, undefined);
    assert.equal(typeof file.size, "number");
  }
});

test("game.identity hashes the executable and reads store hints", async () => {
  const result = await executeOperation("game.identity", { gameDir: fixture }, {});
  assert.equal(result.ok, true, result.error?.message);

  const data = result.data;
  assert.match(data.sha256, /^[a-f0-9]{64}$/);
  assert.match(data.executable, /FixtureGame\.exe$/);
  assert.equal(data.product, "Fixture Product");
  assert.equal(data.company, "Fixture Company");
  assert.deepEqual(data.store, { id: "manual", appId: null });
});

test("game.games lists the game folders under the configured roots", async () => {
  const root = tempDir("gmf-games-");
  const gameOne = path.join(root, "GameOne");
  fs.mkdirSync(path.join(gameOne, "GameOne_Data"), { recursive: true });
  fs.writeFileSync(path.join(gameOne, "GameOne.exe"), "SYNTHETIC");
  fs.mkdirSync(path.join(root, "Empty"), { recursive: true });

  const result = await executeOperation("game.games", {}, { env: { GMF_GAME_ROOTS: root } });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.data.games.length, 1);
  assert.equal(result.data.games[0].name, "GameOne");
  assert.equal(result.data.games[0].path, path.resolve(gameOne));
});

test("game.profile rejects a game path that is a file", async () => {
  const result = await executeOperation(
    "game.profile",
    { gameDir: path.join(fixture, "FixtureGame.exe") },
    {},
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GMF-E-GAME-001");
});

test("game.games needs more than one generic folder to call a game Unreal", async () => {
  const root = tempDir("gmf-unreal-markers-");
  const make = (name, directories, files = []) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.exe`), "SYNTHETIC");
    for (const directory of directories) fs.mkdirSync(path.join(dir, directory), { recursive: true });
    for (const file of files) fs.writeFileSync(path.join(dir, file), "{}");
  };
  make("OnlyConfig", ["Config"]);
  make("ContentBinaries", ["Content", "Binaries"]);
  make("EngineProject", ["Engine"], ["Game.uproject"]);
  make("EngineAlone", ["Engine"]);
  const result = await executeOperation("game.games", {}, { env: { GMF_GAME_ROOTS: root } });
  const engines = Object.fromEntries(result.data.games.map((game) => [game.name, game.engine]));
  assert.deepEqual(engines, { OnlyConfig: "unknown", ContentBinaries: "unreal", EngineProject: "unreal", EngineAlone: "unknown" });
});

test("Steam libraries list games, not Proton, runtimes or empty folders", async () => {
  const root = tempDir("gmf-steam-filter-");
  const common = path.join(root, "library", "steamapps", "common");
  fs.mkdirSync(path.join(common, "Real Game", "Real Game_Data"), { recursive: true });
  fs.writeFileSync(path.join(common, "Real Game", "Real Game.exe"), "SYNTHETIC");
  fs.mkdirSync(path.join(common, "Proton 9.0", "files"), { recursive: true });
  fs.writeFileSync(path.join(common, "Proton 9.0", "proton.exe"), "SYNTHETIC");
  fs.mkdirSync(path.join(common, "Steamworks Shared"), { recursive: true });
  fs.mkdirSync(path.join(common, "SteamLinuxRuntime_sniper"), { recursive: true });
  fs.mkdirSync(path.join(common, "Empty Folder"), { recursive: true });
  const vdf = path.join(root, "libraryfolders.vdf");
  fs.writeFileSync(vdf, `"libraryfolders" { "0" { "path" "${path.join(root, "library").replaceAll("\\", "/")}" } }`);
  const result = await executeOperation("game.games", { steamRoots: [vdf] }, { env: {} });
  assert.deepEqual(result.data.games.map((game) => game.name), ["Real Game"]);
});

test("game.identity refuses an executable outside the game folder", async () => {
  const outside = path.join(tempDir("gmf-identity-outside-"), "other.exe");
  fs.writeFileSync(outside, "SYNTHETIC");
  for (const executable of [outside, path.join("..", "other.exe")]) {
    const result = await executeOperation("game.identity", { gameDir: fixture, executable }, {});
    assert.equal(result.ok, false, executable);
    assert.equal(result.error.code, "GMF-E-GAME-001");
  }
  const inside = await executeOperation("game.identity", { gameDir: fixture, executable: "FixtureGame.exe" }, {});
  assert.equal(inside.ok, true, inside.error?.message);
});
