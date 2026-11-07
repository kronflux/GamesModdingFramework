import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { detectUnreal, detectPakLayout, detectUe4ss, findProjectDir, findShippingExe, listExecutables } from "../src/engines/unreal/detect.mjs";
import unreal from "../src/engines/unreal/index.mjs";
import { fixture as fixturePath } from "./helpers/paths.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const fixtures = fixturePath("unreal");

function snapshot(dir) {
  const entries = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const stat = fs.statSync(full);
      entries.push(`${path.relative(dir, full)}:${stat.size}:${stat.mtimeMs}`);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return entries.sort();
}

function profileFrom(detection) {
  return {
    version: 1,
    engine: detection.engine,
    runtime: detection.runtime,
    loader: detection.loader,
    markers: detection.markers,
    paths: detection.paths,
    tools: [],
    capabilities: [],
    unknowns: detection.unknowns,
    evidence: [],
  };
}

test("a UE4SS fixture returns unreal, the shipping executable, the pak folder and an unknown UE version", async () => {
  const fixture = path.join(fixtures, "ue4ss-game");
  const before = snapshot(fixture);
  const detection = await detectUnreal(fixture);
  assert.deepEqual(snapshot(fixture), before, "detection must not write into the game folder");
  assert.equal(detection.engine.id, "unreal");
  assert.equal(detection.engine.version, null);
  assert.equal(detection.engine.confidence, "observed");
  assert.equal(detection.paths.binaries, path.join(fixture, "Binaries", "Win64"));
  assert.equal(detection.paths.content, path.join(fixture, "Content"));
  assert.equal(detection.paths.executable, path.join(fixture, "Binaries", "Win64", "Game-Win64-Shipping.exe"));
  assert.equal(detection.loader.id, "ue4ss");
  assert.equal(detection.loader.installed, true);
  assert.equal(detection.loader.path, path.join(fixture, "ue4ss"));
  assert.ok(detection.unknowns.some((entry) => /Unreal Engine version/i.test(entry.question)));
  assert.ok(detection.unknowns.every((entry) => typeof entry.nextProbe === "string" && entry.nextProbe.length > 0));
  assert.ok(detection.engine.evidence.some((entry) => entry.source.includes("Game-Win64-Shipping.exe")));
});

test("multiple executables prefer the -Shipping build", async () => {
  const fixture = path.join(fixtures, "multiple-exes");
  assert.equal(path.basename(findShippingExe(fixture)), "Game-Win64-Shipping.exe");
  const detection = await detectUnreal(fixture);
  assert.equal(path.basename(detection.paths.executable), "Game-Win64-Shipping.exe");
});

test("UE4SS is detected in the binaries folder", async () => {
  const fixture = path.join(fixtures, "ue4ss-binaries");
  const loader = detectUe4ss(fixture);
  assert.equal(loader.id, "ue4ss");
  assert.equal(loader.installed, true);
  assert.equal(loader.path, path.join(fixture, "Binaries", "Win64", "ue4ss"));
  const detection = await detectUnreal(fixture);
  assert.equal(detection.loader.id, "ue4ss");
});

test("an Unreal game without UE4SS reports a needs-tool code capability", async () => {
  const fixture = path.join(fixtures, "no-ue4ss");
  const detection = await detectUnreal(fixture);
  assert.equal(detection.loader.id, "none");
  assert.equal(detection.loader.installed, false);
  const capabilities = unreal.capabilities(profileFrom(detection));
  const code = capabilities.find((capability) => capability.id === "code");
  assert.equal(code.support, "needs-tool");
  assert.deepEqual(code.requires, ["ue4ss"]);
});

test("a .uproject EngineAssociation supplies the UE version", async (t) => {
  const root = tempDir(t, "gmf-unreal-uproject-");
  const fixture = path.join(root, "UprojectGame");
  fs.cpSync(path.join(fixtures, "ue4ss-game"), fixture, { recursive: true });
  fs.writeFileSync(path.join(fixture, "UprojectGame.uproject"), JSON.stringify({ EngineAssociation: "5.3" }));
  const detection = await detectUnreal(fixture);
  assert.equal(detection.engine.version, "5.3");
  assert.equal(detection.unknowns.some((entry) => /Unreal Engine version/i.test(entry.question)), false);
});

test("detectPakLayout finds Content/Paks and the pak files", () => {
  const fixture = path.join(fixtures, "ue4ss-game");
  const layout = detectPakLayout(fixture);
  assert.equal(layout.paksDir, path.join(fixture, "Content", "Paks"));
  assert.deepEqual(layout.pakFiles, [path.join(fixture, "Content", "Paks", "Game.pak")]);
});

test("an unrelated folder is not observed as Unreal", async (t) => {
  const root = tempDir(t, "gmf-not-unreal-");
  fs.writeFileSync(path.join(root, "readme.txt"), "not a game\n");
  const detection = await detectUnreal(root);
  assert.equal(detection.engine.confidence, "unknown");
  assert.equal(detection.engine.version, null);
  assert.equal(detection.unknowns.length, 0);
});

test("a missing game directory raises GMF-E-GAME-001", async () => {
  await assert.rejects(
    () => detectUnreal(path.join(fixtures, "does-not-exist")),
    (error) => error.code === "GMF-E-GAME-001",
  );
});

test("a shipped install with Engine/ and a project folder beside a launcher is detected through the project folder", async () => {
  const { findProjectDir } = await import("../src/engines/unreal/detect.mjs");
  const { ensureGameDir } = await import("../src/engines/unreal/operations/shared.mjs");
  const root = path.join(fixtures, "installed-layout");
  const project = path.join(root, "FixtureProj");
  const before = snapshot(root);
  assert.equal(findProjectDir(root), project);
  assert.equal(findProjectDir(project), project, "a project folder resolves to itself");
  assert.equal(ensureGameDir(root), project, "operations work on the project folder");
  const detection = await detectUnreal(root);
  assert.equal(detection.engine.confidence, "observed");
  assert.equal(path.basename(detection.paths.executable), "FixtureProj-Win64-Shipping.exe");
  assert.equal(detection.paths.paks, path.join(project, "Content", "Paks"));
  assert.deepEqual(snapshot(root), before, "detection writes nothing");
});

test("a folder with no project beside Engine resolves to itself", async () => {
  const { findProjectDir } = await import("../src/engines/unreal/detect.mjs");
  const noEngine = fixturePath("no-engine");
  assert.equal(findProjectDir(noEngine), noEngine);
});

test("the UE4SS version is read from UE4SS.log when no version file ships", async (t) => {
  const gameDir = tempDir(t, "gmf-ue4ss-ver-");
  fs.cpSync(path.join(fixtures, "ue4ss-game"), gameDir, { recursive: true });
  fs.writeFileSync(
    path.join(gameDir, "ue4ss", "UE4SS.log"),
    "[2026-11-07 01:37:49.2] Console created\n[2026-11-07 01:37:49.3] UE4SS - v3.0.1 Experimental - Git SHA #4fb9b615\n",
  );
  assert.equal(detectUe4ss(gameDir).version, "v3.0.1 Experimental (4fb9b615)");
});

test("a directory listing that fails is treated as empty instead of throwing", (t) => {
  const gameDir = path.join(fixtures, "ue4ss-binaries");
  const original = fs.readdirSync;
  const denied = new Set();
  t.mock.method(fs, "readdirSync", (dir, ...rest) => {
    if (denied.has(path.resolve(String(dir)))) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return original(dir, ...rest);
  });

  denied.add(path.resolve(gameDir, "Binaries", "Win64"));
  assert.deepEqual(listExecutables(gameDir), []);
  assert.equal(findShippingExe(gameDir), null);

  denied.clear();
  denied.add(path.resolve(gameDir, "Content", "Paks"));
  assert.deepEqual(detectPakLayout(gameDir).pakFiles, []);

  denied.clear();
  denied.add(path.resolve(fixtures, "installed-layout"));
  assert.equal(findProjectDir(path.join(fixtures, "installed-layout")), path.resolve(fixtures, "installed-layout"));
});
