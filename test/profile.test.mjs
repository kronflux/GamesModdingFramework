import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildProfile, mergeDetection, capabilityList, unknownList } from "../src/core/profile.mjs";
import { validateProfile } from "../src/core/contracts.mjs";
import { detectUnity } from "../src/engines/unity/detect.mjs";
import { executeOperation } from "../src/core/operations.mjs";
import { initWorkspace, readWorkspace, readProfile } from "../src/core/workspace.mjs";
import "../src/engines/unity/index.mjs";
import { repoRoot, fixture as fixturePath } from "./helpers/paths.mjs";
import { tempDir, tempRoot } from "./helpers/tmp.mjs";

const fixture = fixturePath("unity-mono");

async function monoDetection() {
  return detectUnity(fixture);
}

function unknownDetection() {
  return {
    engine: { id: "unity", version: null, confidence: "unknown", evidence: [] },
    markers: { antiCheat: [], online: false, launcher: null },
    paths: {},
    notes: [],
    unknowns: [],
  };
}

test("buildProfile returns the profile schema with identity, runtime, loader and capabilities", async () => {
  const detection = await monoDetection();
  const profile = buildProfile({ gameDir: fixture, detections: [detection], tools: [], markers: null });

  assert.deepEqual(validateProfile(profile), { ok: true, errors: [] });
  assert.equal(profile.version, 1);
  assert.equal(profile.game.name, "Fixture Product");
  assert.equal(profile.game.product, "Fixture Product");
  assert.equal(profile.game.company, "Fixture Company");
  assert.match(profile.game.executable, /FixtureGame\.exe$/);
  assert.match(profile.game.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(profile.game.store, { id: "manual", appId: null });

  assert.equal(profile.engine.id, "unity");
  assert.equal(profile.engine.version, "2021.3.45f1");
  assert.equal(profile.engine.selected, true);
  assert.equal(profile.runtime.backend, "mono");
  assert.equal(profile.loader.id, "bepinex5");

  const code = profile.capabilities.find((capability) => capability.id === "code");
  const decompile = profile.capabilities.find((capability) => capability.id === "decompile");
  const assets = profile.capabilities.find((capability) => capability.id === "assets");
  assert.equal(code.support, "full");
  assert.equal(decompile.support, "needs-tool");
  assert.deepEqual(decompile.requires, ["ilspycmd"]);
  assert.equal(assets.support, "needs-tool");

  assert.ok(profile.evidence.length >= 3);
  for (const record of profile.evidence) {
    assert.ok(record.id);
    assert.ok(record.claim);
    assert.ok(record.confidence);
    assert.ok(record.authority);
    assert.ok(record.source);
  }
});

test("installed tools turn a needs-tool capability into full", async () => {
  const detection = await monoDetection();
  const profile = buildProfile({
    gameDir: fixture,
    detections: [detection],
    tools: [
      { id: "ilspycmd", installed: true, version: "9.0", path: "C:/tools/ilspycmd.exe", license: "MIT" },
      { id: "assetripper", installed: false, version: null, path: null, license: "GPL-3.0" },
    ],
    markers: null,
  });

  assert.equal(profile.capabilities.find((capability) => capability.id === "decompile").support, "full");
  assert.equal(profile.capabilities.find((capability) => capability.id === "assets").support, "needs-tool");
  assert.equal(profile.tools.find((tool) => tool.id === "ilspycmd").installed, true);
});

test("an unknown engine is recorded as unknown with a next probe, not guessed", async () => {
  const empty = tempRoot("gmf-profile-empty-");
  const profile = buildProfile({ gameDir: empty, detections: [unknownDetection()] });

  assert.equal(profile.engine.id, "unknown");
  assert.equal(profile.engine.selected, false);
  assert.equal(profile.runtime.backend, "unknown");
  assert.equal(profile.game.executable, null);
  assert.equal(profile.game.sha256, null);
  assert.ok(profile.unknowns.some((record) => record.id && record.nextProbe));
  assert.ok(profile.engine.alternatives.some((alternative) => alternative.id === "unity"));
});

test("mergeDetection keeps alternatives and merges evidence and unknowns", async () => {
  const detection = await monoDetection();
  const base = buildProfile({ gameDir: fixture, detections: [unknownDetection()] });
  const merged = mergeDetection(base, detection);

  assert.equal(merged.engine.id, "unity");
  assert.equal(merged.engine.selected, true);
  assert.equal(merged.engine.confidence, "observed");
  assert.ok(merged.engine.alternatives.some((alternative) => alternative.id === "unity"));
  assert.ok(merged.evidence.length > base.evidence.length);
  assert.equal(merged.unknowns.length, unknownList(base).length + detection.unknowns.length);
  assert.deepEqual(merged.capabilities, capabilityList(merged));
});

test("a changed executable refreshes the hash and marks the previous profile", async () => {
  const game = tempRoot("gmf-profile-refresh-game-");
  fs.cpSync(fixture, game, { recursive: true });
  const workspaceDir = tempRoot("gmf-profile-refresh-ws-");
  initWorkspace({ gameDir: game, workspaceDir });

  const first = await executeOperation(
    "game.profile",
    { gameDir: game },
    { workspace: readWorkspace(workspaceDir), root: repoRoot },
  );
  assert.equal(first.ok, true, first.error?.message);
  const firstProfile = first.data.profile;
  const firstSha = firstProfile.game.sha256;

  fs.appendFileSync(path.join(game, "FixtureGame.exe"), "\nfixture update\n");

  const second = await executeOperation(
    "game.profile",
    { gameDir: game },
    { workspace: readWorkspace(workspaceDir), root: repoRoot },
  );
  assert.equal(second.ok, true, second.error?.message);
  const secondProfile = second.data.profile;

  assert.notEqual(secondProfile.game.sha256, firstSha);
  assert.equal(secondProfile.previous.sha256, firstSha);
  assert.ok(secondProfile.evidence.some((record) => /changed/i.test(record.claim)));
  assert.deepEqual(readProfile(readWorkspace(workspaceDir)), secondProfile);
});

test("an Unreal profile carries no Unity unknowns and one engine version unknown", async () => {
  const { detectGameProfile } = await import("../src/operations/game/detect.mjs");
  const { profile } = await detectGameProfile(fixturePath("unreal", "installed-layout"), { root: repoRoot });
  assert.equal(profile.engine.id, "unreal");
  const questions = profile.unknowns.map((entry) => entry.question);
  assert.deepEqual(questions.filter((q) => /unity/i.test(q)), [], "no Unity unknowns in an Unreal profile");
  assert.equal(questions.filter((q) => /version/i.test(q)).length, 1, `one version unknown, got: ${questions.join(" | ")}`);
});

test("a game under steamapps/common is a Steam game with the app id from its appmanifest", async (t) => {
  const { detectStore } = await import("../src/core/profile.mjs");
  const library = tempDir(t, "gmf-steamlib-");
  const gameDir = path.join(library, "steamapps", "common", "Some Game");
  fs.mkdirSync(gameDir, { recursive: true });
  fs.writeFileSync(
    path.join(library, "steamapps", "appmanifest_3712080.acf"),
    '"AppState"\n{\n\t"appid"\t\t"3712080"\n\t"name"\t\t"Some Game"\n\t"installdir"\t\t"Some Game"\n}\n',
  );
  fs.writeFileSync(path.join(library, "steamapps", "appmanifest_1.acf"), '"AppState"\n{\n\t"appid"\t\t"1"\n\t"installdir"\t\t"Other"\n}\n');
  assert.deepEqual(detectStore(gameDir), { id: "steam", appId: "3712080" });
});

test("the profile lists registered tools with their install state from the tool cache", async (t) => {
  const { detectGameProfile } = await import("../src/operations/game/detect.mjs");
  const cacheDir = tempDir(t, "gmf-profile-tools-");
  const exe = path.join(cacheDir, "cpp2il", "Cpp2IL.exe");
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, "synthetic");
  fs.writeFileSync(path.join(cacheDir, "tools.json"), JSON.stringify({ cpp2il: { id: "cpp2il", version: "test", path: exe, args: [] } }));
  const catalog = {
    tools: [
      { id: "cpp2il", engine: "unity", license: "MIT" },
      { id: "il2cppdumper", engine: "unity", license: "MIT" },
    ],
  };
  const { profile } = await detectGameProfile(fixturePath("unity-il2cpp"), { root: repoRoot, catalog, toolCacheDir: cacheDir });
  const cpp2il = profile.tools.find((tool) => tool.id === "cpp2il");
  assert.equal(cpp2il.installed, true);
  assert.equal(cpp2il.path, exe);
  assert.equal(profile.tools.find((tool) => tool.id === "il2cppdumper").installed, false);
  assert.equal(profile.capabilities.find((cap) => cap.id === "decompile").support, "full");
});

test("a launcher named in the marker override replaces the detected one", async () => {
  const detection = unknownDetection();
  detection.markers.launcher = "steam";
  const profile = buildProfile({ gameDir: fixture, detections: [detection], tools: [], markers: { antiCheat: [], online: false, launcher: "epic" } });
  assert.equal(profile.markers.launcher, "epic");
  const kept = buildProfile({ gameDir: fixture, detections: [detection], tools: [], markers: { antiCheat: [], online: false, launcher: null } });
  assert.equal(kept.markers.launcher, "steam");
});
