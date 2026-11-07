import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeOperation } from "../src/core/operations.mjs";
import { detectUnity } from "../src/engines/unity/detect.mjs";
import { buildProfile } from "../src/core/profile.mjs";
import { initWorkspace, readWorkspace, writeProfile } from "../src/core/workspace.mjs";
import "../src/engines/unity/index.mjs";
import { fixture as fixturePath } from "./helpers/paths.mjs";
import { snapshotTree } from "./helpers/tree.mjs";

const fixture = fixturePath("unity-mono");
const tempRoots = [];

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function setupProject(name = "DeployMod") {
  const game = tempDir("gmf-build-game-");
  fs.cpSync(fixture, game, { recursive: true });
  const workspaceDir = tempDir("gmf-build-ws-");
  initWorkspace({ gameDir: game, workspaceDir });
  const detection = await detectUnity(game);
  const profile = buildProfile({ gameDir: game, detections: [detection] });
  const workspace = readWorkspace(workspaceDir);
  writeProfile(workspace, profile);

  const scaffold = await executeOperation(
    "unity.scaffold",
    { name, author: "Fixture Author", loader: "bepinex5", backend: "mono" },
    { workspace: readWorkspace(workspaceDir) },
  );
  assert.equal(scaffold.ok, true, scaffold.error?.message);
  const modDir = path.join(workspaceDir, "mods", name);
  const builtDll = path.join(modDir, "bin", "Release", "net472", `${name}.dll`);
  fs.mkdirSync(path.dirname(builtDll), { recursive: true });
  fs.writeFileSync(builtDll, "SYNTHETIC BUILT ASSEMBLY v1");
  return { game, workspaceDir, workspace: readWorkspace(workspaceDir), modDir, builtDll, name };
}

after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

test("build runs the exact dotnet command and reports its output", async () => {
  const { modDir } = await setupProject("BuildMod");
  const calls = [];
  const runProcess = async (cmd, args) => {
    calls.push({ cmd, args });
    return { code: 0, stdout: "Build succeeded", stderr: "" };
  };

  const result = await executeOperation("unity.build", { modDir }, { runProcess });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.data.code, 0);
  assert.equal(result.data.dryRun, false);
  assert.ok(result.data.command.includes("dotnet build"));
  assert.ok(result.data.command.includes(modDir));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "dotnet");
  assert.deepEqual(calls[0].args.slice(0, 2), ["build", modDir]);
  assert.ok(calls[0].args.includes("Release"));
});

test("build falls back to a dry-run when dotnet is absent", async () => {
  const { modDir } = await setupProject("DryRunMod");
  const runProcess = async () => {
    const error = new Error("spawn dotnet ENOENT");
    error.code = "ENOENT";
    throw error;
  };

  const result = await executeOperation("unity.build", { modDir }, { runProcess });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.data.dryRun, true);
  assert.equal(result.data.code, null);
  assert.match(result.data.command, /dotnet build/);
  assert.match(result.data.stderr, /dotnet/i);
});

test("build rejects a folder without a project file", async () => {
  const empty = tempDir("gmf-build-empty-");
  const result = await executeOperation("unity.build", { modDir: empty }, {});
  assert.equal(result.ok, false);
  assert.match(result.error.message, /project/i);
});

test("deploy refuses without a gameWrite authorization", async () => {
  const { game, workspace, modDir } = await setupProject("AuthMod");
  const result = await executeOperation(
    "unity.deploy",
    { modDir, gameDir: game },
    { workspace },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GMF-E-GATE-001");
  assert.ok(!fs.existsSync(path.join(game, "BepInEx", "plugins", "AuthMod", "AuthMod.dll")));
});

test("deploy copies the built DLL and a second deploy backs up the first", async () => {
  const { game, workspace, modDir, builtDll } = await setupProject("DeployMod");
  const gameAssembly = path.join(game, "FixtureGame_Data", "Managed", "Assembly-CSharp.dll");
  const gameAssemblyHash = sha256File(gameAssembly);
  const authorization = [{ effect: "gameWrite", source: "test: deploy" }];

  const first = await executeOperation(
    "unity.deploy",
    { modDir, gameDir: game },
    { workspace, authorization },
  );
  assert.equal(first.ok, true, first.error?.message);
  const deployed = path.join(game, "BepInEx", "plugins", "DeployMod", "DeployMod.dll");
  assert.deepEqual(first.data.deployed, [deployed]);
  assert.equal(first.data.backup, null);
  assert.equal(fs.readFileSync(deployed, "utf8"), "SYNTHETIC BUILT ASSEMBLY v1");

  fs.writeFileSync(builtDll, "SYNTHETIC BUILT ASSEMBLY v2");
  const second = await executeOperation(
    "unity.deploy",
    { modDir, gameDir: game },
    { workspace, authorization },
  );
  assert.equal(second.ok, true, second.error?.message);
  assert.ok(second.data.backup, "the overwritten file is backed up");
  assert.ok(fs.existsSync(second.data.backup.backupPath));
  assert.equal(fs.readFileSync(second.data.backup.backupPath, "utf8"), "SYNTHETIC BUILT ASSEMBLY v1");
  assert.equal(fs.readFileSync(deployed, "utf8"), "SYNTHETIC BUILT ASSEMBLY v2");
  assert.equal(sha256File(gameAssembly), gameAssemblyHash, "game assemblies are never modified");
});

test("deploy through the CLI flag carries the authorization source", async () => {
  const { game, workspace, modDir } = await setupProject("FlagMod");
  const result = await executeOperation(
    "unity.deploy",
    { modDir, gameDir: game },
    { workspace, flags: { authorized: "gameWrite", source: "user: deploy the mod" } },
  );
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.authorization.source, "user: deploy the mod");
  assert.equal(result.authorization.effect, "gameWrite");
});

test("deploy accepts a comma-separated --authorized list", async () => {
  const { game, workspace, modDir } = await setupProject("ListMod");
  const result = await executeOperation(
    "unity.deploy",
    { modDir, gameDir: game },
    { workspace, flags: { authorized: "toolInstall,gameWrite", source: "user: install and deploy" } },
  );
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.authorization.source, "user: install and deploy");
});

test("deploy refuses an authorization for the wrong effect and writes nothing", async () => {
  const { game, workspace, modDir } = await setupProject("WrongEffectMod");
  const before = { game: snapshotTree(game), workspace: snapshotTree(workspace.root) };
  const result = await executeOperation(
    "unity.deploy",
    { modDir, gameDir: game },
    { workspace, flags: { authorized: "toolInstall", source: "user: install only" } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GMF-E-GATE-001");
  assert.deepEqual(snapshotTree(game), before.game, "the game folder is unchanged");
  assert.deepEqual(snapshotTree(workspace.root), before.workspace, "no backup is written");
});

test("deploy needs a workspace so it can back up overwritten files", async () => {
  const { game, modDir } = await setupProject("NoWorkspaceMod");
  const before = snapshotTree(game);
  const result = await executeOperation(
    "unity.deploy",
    { modDir, gameDir: game },
    { authorization: [{ effect: "gameWrite", source: "test" }] },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GMF-E-GATE-001");
  assert.deepEqual(snapshotTree(game), before, "the game folder is unchanged");
});

test("validate resolves Harmony targets and reports missing ones", async () => {
  const { game, workspace, modDir } = await setupProject("ValidateMod");
  const patches = path.join(modDir, "Patches.cs");
  fs.writeFileSync(
    patches,
    [
      "using HarmonyLib;",
      '[HarmonyPatch(typeof(FixtureTarget), "FixtureMethod")]',
      "public static class FixtureTargetPatch { }",
    ].join("\n"),
  );

  const ok = await executeOperation("unity.validate", { modDir, gameDir: game }, { workspace });
  assert.equal(ok.ok, true, ok.error?.message);
  assert.equal(ok.data.ok, true, JSON.stringify(ok.data.errors));
  assert.ok(ok.data.targets.some((target) => target.type === "FixtureTarget" && target.method === "FixtureMethod"));
  assert.ok(ok.data.targets.every((target) => target.found === true));

  fs.writeFileSync(
    patches,
    ['[HarmonyPatch(typeof(MissingTarget), "MissingMethod")]', "public static class MissingPatch { }"].join("\n"),
  );
  const missing = await executeOperation("unity.validate", { modDir, gameDir: game }, { workspace });
  assert.equal(missing.ok, true, missing.error?.message);
  assert.equal(missing.data.ok, false);
  assert.ok(missing.data.errors.some((error) => /MissingTarget/.test(error)));
});

test("package writes a Thunderstore zip inside the workspace", async () => {
  const { workspace, modDir } = await setupProject("PackageMod");
  const result = await executeOperation("unity.package", { modDir }, { workspace });
  assert.equal(result.ok, true, result.error?.message);

  assert.ok(fs.existsSync(result.data.zip));
  const buffer = fs.readFileSync(result.data.zip);
  assert.equal(buffer.toString("latin1", 0, 2), "PK");
  assert.ok(buffer.includes("BepInEx/plugins/PackageMod/PackageMod.dll"));
  assert.ok(buffer.includes("manifest.json"));
  assert.ok(buffer.includes("README.md"));

  const custom = path.join(workspace.root, "package", "CustomMod.zip");
  const customResult = await executeOperation("unity.package", { modDir, out: custom }, { workspace });
  assert.equal(customResult.ok, true, customResult.error?.message);
  assert.equal(customResult.data.zip, custom);
});

test("package names the zip Team-Mod-Version from gmf.json and the project version", async () => {
  const { workspace, modDir } = await setupProject("TeamMod");
  const csproj = path.join(modDir, "TeamMod.csproj");
  fs.writeFileSync(csproj, fs.readFileSync(csproj, "utf8").replace(/<Version>[^<]*<\/Version>/, "<Version>1.4.2</Version>"));
  const configured = { ...workspace, config: { ...workspace.config, package: { team: "ExampleTeam" } } };
  const result = await executeOperation("unity.package", { modDir }, { workspace: configured });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(path.basename(result.data.zip), "ExampleTeam-TeamMod-1.4.2.zip");
  assert.equal(result.data.manifest.version_number, "1.4.2");
  assert.equal(result.data.manifest.name, "TeamMod");

  const noTeam = await executeOperation("unity.package", { modDir }, { workspace });
  assert.equal(path.basename(noTeam.data.zip), "TeamMod-1.4.2.zip");
});

test("package refuses an output outside the workspace", async () => {
  const { workspace, modDir } = await setupProject("EscapePackageMod");
  const outside = path.join(tempDir("gmf-package-outside-"), "mod.zip");
  const result = await executeOperation("unity.package", { modDir, out: outside }, { workspace });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /outside the workspace/i);
});

test("package needs a built assembly", async () => {
  const { workspace, modDir } = await setupProject("UnbuiltMod");
  fs.rmSync(path.join(modDir, "bin"), { recursive: true, force: true });
  const result = await executeOperation("unity.package", { modDir }, { workspace });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /built|assembly|bin/i);
});

test("deploy picks the newest Release assembly of the mod, not a Debug copy", async () => {
  const { game, workspace, modDir, builtDll } = await setupProject("ReleaseMod");
  const debugDll = path.join(modDir, "bin", "Debug", "net472", "ReleaseMod.dll");
  fs.mkdirSync(path.dirname(debugDll), { recursive: true });
  fs.writeFileSync(debugDll, "SYNTHETIC DEBUG ASSEMBLY");
  const future = new Date(Date.now() + 60000);
  fs.utimesSync(debugDll, future, future);
  const result = await executeOperation(
    "unity.deploy",
    { modDir, gameDir: game },
    { workspace, authorization: [{ effect: "gameWrite", source: "test: deploy" }] },
  );
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.data.built, builtDll);
  assert.equal(fs.readFileSync(path.join(game, "BepInEx", "plugins", "ReleaseMod", "ReleaseMod.dll"), "utf8"), "SYNTHETIC BUILT ASSEMBLY v1");
});

test("deploy and package refuse when only a dependency DLL was built", async () => {
  const { game, workspace, modDir, builtDll } = await setupProject("DependencyOnlyMod");
  fs.rmSync(builtDll);
  fs.writeFileSync(path.join(path.dirname(builtDll), "0Harmony.dll"), "SYNTHETIC DEPENDENCY");
  const deploy = await executeOperation(
    "unity.deploy",
    { modDir, gameDir: game },
    { workspace, authorization: [{ effect: "gameWrite", source: "test: deploy" }] },
  );
  assert.equal(deploy.ok, false);
  assert.equal(deploy.error.code, "GMF-E-EXEC-001");
  assert.equal(fs.existsSync(path.join(game, "BepInEx", "plugins", "DependencyOnlyMod")), false);
  const pack = await executeOperation("unity.package", { modDir }, { workspace });
  assert.equal(pack.ok, false);
  assert.equal(pack.error.code, "GMF-E-EXEC-001");
});

test("build passes the caller's timeout, including 0 for no limit, and 15 minutes by default", async () => {
  const { modDir } = await setupProject("TimeoutMod");
  const seen = [];
  const runProcess = async (cmd, args, options) => {
    seen.push(options.timeoutMs);
    return { code: 0, stdout: "Build succeeded", stderr: "" };
  };
  assert.equal((await executeOperation("unity.build", { modDir }, { runProcess })).ok, true);
  assert.equal((await executeOperation("unity.build", { modDir }, { runProcess, timeoutMs: 0 })).ok, true);
  assert.equal((await executeOperation("unity.build", { modDir }, { runProcess, timeoutMs: 5000 })).ok, true);
  assert.deepEqual(seen, [900000, 0, 5000]);
});
