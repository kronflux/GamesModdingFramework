import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeOperation, registerOperation } from "../src/core/operations.mjs";
import { resolveBepInExArtifact } from "../src/core/tools.mjs";
import { detectLoader } from "../src/engines/unity/detect.mjs";
import { draftPlan } from "../src/core/plan.mjs";
import { loadCatalog } from "../src/core/catalog.mjs";
import unity from "../src/engines/unity/index.mjs";
import { repoRoot, fixture as fixturePath } from "./helpers/paths.mjs";
import { snapshotTree } from "./helpers/tree.mjs";

for (const operation of unity.operations) registerOperation(operation, operation.handler);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmf-setup-loader-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const PAGE = `<html><body>
<a href="/projects/bepinex_be/793/BepInEx-Unity.Mono-win-x64-6.0.0-be.793%2Bdbc82f0.zip">mono</a>
<a href="/projects/bepinex_be/793/BepInEx-Unity.IL2CPP-win-x64-6.0.0-be.793%2Bdbc82f0.zip">il2cpp 793</a>
<a href="/projects/bepinex_be/792/BepInEx-Unity.IL2CPP-win-x64-6.0.0-be.792%2B3448ef7.zip">il2cpp 792</a>
</body></html>`;

test("a bepinex-be tool resolves the newest matching artifact from the build page", () => {
  const tool = {
    id: "bepinex6-il2cpp",
    source: { type: "bepinex-be", url: "https://builds.bepinex.dev/projects/bepinex_be" },
    asset: "^BepInEx-Unity\\.IL2CPP-win-x64-6\\.0\\.0-be\\.\\d+\\+[0-9a-f]+\\.zip$",
  };
  const artifact = resolveBepInExArtifact(PAGE, tool);
  assert.equal(artifact.name, "BepInEx-Unity.IL2CPP-win-x64-6.0.0-be.793+dbc82f0.zip");
  assert.equal(artifact.build, "793");
  assert.equal(artifact.url, "https://builds.bepinex.dev/projects/bepinex_be/793/BepInEx-Unity.IL2CPP-win-x64-6.0.0-be.793%2Bdbc82f0.zip");
  assert.equal(resolveBepInExArtifact("<html></html>", tool), null);
});

function gameCopy(name) {
  const gameDir = path.join(root, name, "game");
  fs.cpSync(fixturePath("unity-il2cpp"), gameDir, { recursive: true });
  fs.rmSync(path.join(gameDir, "BepInEx"), { recursive: true, force: true });
  fs.rmSync(path.join(gameDir, "winhttp.dll"), { force: true });
  const workspace = { root: path.join(root, name, "ws"), config: { version: 1 }, local: { version: 1 }, profile: null };
  fs.mkdirSync(workspace.root, { recursive: true });
  return { gameDir, workspace };
}

function localCatalog() {
  return {
    version: 1,
    tools: [
      {
        id: "bepinex6-il2cpp",
        name: "BepInEx 6 IL2CPP",
        purpose: "test",
        engine: "unity",
        license: "LGPL-2.1",
        source: { type: "local", path: fixturePath("unity-loader-bepinex6"), version: "be.test" },
        versionPolicy: "local",
        entry: "winhttp.dll",
        verify: { kind: "none", value: null },
        effects: ["toolInstall", "network", "gameWrite"],
        capabilities: [],
      },
    ],
  };
}

test("unity.setup_loader refuses without toolInstall and gameWrite authorizations and writes nothing", async () => {
  const { gameDir, workspace } = gameCopy("refused");
  const cacheDir = path.join(root, "cache-refused");
  const before = { game: snapshotTree(gameDir), workspace: snapshotTree(workspace.root) };
  const result = await executeOperation(
    "unity.setup_loader",
    { gameDir, loader: "bepinex6-il2cpp" },
    { workspace, catalog: localCatalog(), toolCacheDir: cacheDir },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GMF-E-GATE-001");
  assert.equal(fs.existsSync(path.join(gameDir, "winhttp.dll")), false);
  assert.deepEqual(snapshotTree(gameDir), before.game, "the game folder is unchanged");
  assert.deepEqual(snapshotTree(workspace.root), before.workspace, "the workspace is unchanged");
  assert.equal(fs.existsSync(cacheDir), false, "the tool cache is not created");
});

test("unity.setup_loader refuses when only one of toolInstall and gameWrite is authorized", async () => {
  for (const effect of ["toolInstall", "gameWrite"]) {
    const { gameDir, workspace } = gameCopy(`one-effect-${effect}`);
    const before = { game: snapshotTree(gameDir), workspace: snapshotTree(workspace.root) };
    const result = await executeOperation(
      "unity.setup_loader",
      { gameDir, loader: "bepinex6-il2cpp" },
      {
        workspace,
        catalog: localCatalog(),
        toolCacheDir: path.join(root, `cache-one-effect-${effect}`),
        authorizations: [{ effect, source: "user: only this one" }],
      },
    );
    assert.equal(result.ok, false, `${effect} alone is refused`);
    assert.equal(result.error.code, "GMF-E-GATE-001");
    assert.equal(fs.existsSync(path.join(gameDir, "winhttp.dll")), false);
    assert.deepEqual(snapshotTree(gameDir), before.game, `${effect} alone leaves the game folder unchanged`);
    assert.deepEqual(snapshotTree(workspace.root), before.workspace, `${effect} alone leaves the workspace unchanged`);
  }
});

test("unity.setup_loader installs BepInEx 6 beside the game exe and detection then reports it", async () => {
  const { gameDir, workspace } = gameCopy("installed");
  const context = {
    workspace,
    catalog: localCatalog(),
    toolCacheDir: path.join(root, "cache-installed"),
    authorizations: [
      { effect: "toolInstall", source: "test: install BepInEx" },
      { effect: "gameWrite", source: "test: install BepInEx" },
    ],
  };
  const result = await executeOperation("unity.setup_loader", { gameDir, loader: "bepinex6-il2cpp" }, context);
  assert.equal(result.ok, true, result.error?.message);
  for (const file of ["winhttp.dll", "doorstop_config.ini", ".doorstop_version", "BepInEx/core/BepInEx.Unity.IL2CPP.dll", "dotnet/coreclr.dll"]) {
    assert.ok(fs.existsSync(path.join(gameDir, file)), `${file} is next to the exe`);
  }
  assert.equal(result.data.loader, "bepinex6-il2cpp");
  const loader = detectLoader(gameDir, "il2cpp");
  assert.equal(loader.loader.id, "bepinex6");
  assert.equal(loader.loader.installed, true);
  const unknown = await executeOperation("unity.setup_loader", { gameDir, loader: "nope" }, context);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "GMF-E-PLAN-001");
});

test("plan.draft adds a loader install step for a Unity game with no loader", () => {
  const catalog = loadCatalog(repoRoot);
  const profile = {
    version: 1,
    game: { name: "Fixture", installDir: "C:/Games/Fixture" },
    engine: { id: "unity", version: "6000.3.14f1" },
    runtime: { backend: "il2cpp", architecture: "x86_64" },
    loader: { id: "none", installed: false },
    tools: [],
    capabilities: [],
    markers: { antiCheat: [] },
    paths: {},
    unknowns: [],
    evidence: [],
  };
  const plan = draftPlan({ goal: "Make a mod", profile, catalog });
  const first = plan.steps[0];
  assert.equal(first.operation, "unity.setup_loader", plan.steps.map((step) => step.operation).join(", "));
  assert.equal(first.inputs.loader, "bepinex6-il2cpp");
  const mono = draftPlan({ goal: "Make a mod", profile: { ...profile, runtime: { backend: "mono" } }, catalog });
  assert.equal(mono.steps[0].inputs.loader, "bepinex5");
});

test("unity.setup_loader detects the backend from the game when there is no profile", async () => {
  const { gameDir, workspace } = gameCopy("mono-no-profile");
  fs.rmSync(gameDir, { recursive: true, force: true });
  fs.cpSync(fixturePath("unity-mono"), gameDir, { recursive: true });
  fs.rmSync(path.join(gameDir, "BepInEx"), { recursive: true, force: true });
  fs.rmSync(path.join(gameDir, "winhttp.dll"), { force: true });
  const result = await executeOperation(
    "unity.setup_loader",
    { gameDir },
    {
      workspace,
      catalog: localCatalog(),
      toolCacheDir: path.join(root, "cache-mono-no-profile"),
      authorizations: [
        { effect: "toolInstall", source: "test: install" },
        { effect: "gameWrite", source: "test: install" },
      ],
    },
  );
  assert.equal(result.ok, false, "a Mono game is not given the IL2CPP loader");
  assert.equal(result.error.code, "GMF-E-PLAN-001");
  assert.equal(fs.existsSync(path.join(gameDir, "winhttp.dll")), false);
});

test("unity.setup_loader records each effect's own authorization source", async () => {
  const { gameDir, workspace } = gameCopy("sources");
  const result = await executeOperation(
    "unity.setup_loader",
    { gameDir, loader: "bepinex6-il2cpp" },
    {
      workspace,
      catalog: localCatalog(),
      toolCacheDir: path.join(root, "cache-sources"),
      authorizations: [
        { effect: "toolInstall", source: "user: download the loader" },
        { effect: "gameWrite", source: "plan step 3: copy into the game" },
      ],
    },
  );
  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual(result.authorization.sources, {
    toolInstall: "user: download the loader",
    gameWrite: "plan step 3: copy into the game",
  });
});

test("unity.setup_loader takes the toolInstall source from the plan file when only the plan authorizes it", async () => {
  const { gameDir, workspace } = gameCopy("plan-source");
  fs.writeFileSync(
    path.join(workspace.root, "gmf.plan.json"),
    JSON.stringify({ authorizations: [{ effect: "toolInstall", source: "plan: download" }] }),
  );
  const result = await executeOperation(
    "unity.setup_loader",
    { gameDir, loader: "bepinex6-il2cpp" },
    {
      workspace,
      catalog: localCatalog(),
      toolCacheDir: path.join(root, "cache-plan-source"),
      authorizations: [{ effect: "gameWrite", source: "user: copy" }],
    },
  );
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.authorization.sources.toolInstall, "plan: download");
  assert.equal(result.authorization.sources.gameWrite, "user: copy");
});
