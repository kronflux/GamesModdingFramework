import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { detectUnity, detectLoader } from "../src/engines/unity/detect.mjs";
import { runCli } from "../src/cli/main.mjs";
import "../src/engines/unity/index.mjs";
import { repoRoot, fixture as fixturePath } from "./helpers/paths.mjs";
import { tempDir, tempRoot } from "./helpers/tmp.mjs";

const fixture = fixturePath("unity-il2cpp");

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

test("an IL2CPP fixture returns il2cpp, BepInEx 6 and the interop remediation", async () => {
  const before = snapshot(fixture);
  const detection = await detectUnity(fixture);
  const after = snapshot(fixture);

  assert.equal(detection.engine.id, "unity");
  assert.equal(detection.engine.version, "2022.3.10f1");
  assert.equal(detection.runtime.backend, "il2cpp");
  assert.equal(detection.loader.id, "bepinex6");
  assert.equal(detection.loader.installed, true);
  assert.match(detection.paths.interop, /BepInEx[\\/]interop$/);
  assert.match(detection.paths.deploy, /BepInEx[\\/]plugins$/);

  const notes = [...detection.notes, ...detection.loader.notes].join("\n");
  assert.match(notes, /launch the game once/i);
  assert.match(notes, /interop/i);

  const interopFiles = fs
    .readdirSync(detection.paths.interop)
    .filter((name) => name.toLowerCase().endsWith(".dll"));
  assert.equal(interopFiles.length, 0, "the framework does not create interop assemblies");
  assert.deepEqual(after, before, "detection must not write into the game directory");
});

test("IL2CPP metadata without GameAssembly is derived and records the missing file", async () => {
  const game = tempRoot("gmf-unity-no-gameassembly-");
  fs.cpSync(fixture, game, { recursive: true });
  fs.rmSync(path.join(game, "GameAssembly.dll"), { force: true });

  const detection = await detectUnity(game);
  assert.equal(detection.runtime.backend, "il2cpp");
  assert.equal(detection.engine.confidence, "observed");
  assert.equal(detection.runtime.confidence, "derived");
  assert.ok(
    detection.unknowns.some((record) => /GameAssembly/.test(record.question)),
    "the missing GameAssembly file is an unknown with a next probe",
  );
});

test("a BepInEx 6 install without the IL2CPP assembly is incomplete", () => {
  const game = tempRoot("gmf-unity-bepinex6-incomplete-");
  fs.cpSync(fixture, game, { recursive: true });
  fs.rmSync(path.join(game, "BepInEx", "core", "BepInEx.Unity.IL2CPP.dll"), { force: true });

  const { loader } = detectLoader(game, "il2cpp");
  assert.equal(loader.id, "bepinex6");
  assert.equal(loader.installed, false);
  assert.match(loader.notes.join("\n"), /BepInEx\.Unity\.IL2CPP\.dll/);
});

test("the detect CLI alias dispatches to game.detect", async () => {
  const result = await runCli(["detect", "--game", fixture, "--json"], {});
  assert.equal(result.exitCode, 0, result.stdout);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.data.profile.engine.id, "unity");
  assert.equal(body.data.profile.runtime.backend, "il2cpp");
  assert.equal(body.data.profile.loader.id, "bepinex6");
});

test("a Unity 6 version string such as 6000.3.14f1 is read from globalgamemanagers", async (t) => {
  const { detectUnityVersion } = await import("../src/engines/unity/detect.mjs");
  const dataDir = tempDir(t, "gmf-unity6-");
  const header = Buffer.concat([Buffer.alloc(48), Buffer.from("6000.3.14f1\0", "latin1"), Buffer.alloc(16)]);
  fs.writeFileSync(path.join(dataDir, "globalgamemanagers"), header);
  assert.equal(detectUnityVersion(dataDir).version, "6000.3.14f1");
});

test("the profile records the IL2CPP metadata version from global-metadata.dat", async (t) => {
  const { detectGameProfile } = await import("../src/operations/game/detect.mjs");
  const gameDir = tempDir(t, "gmf-il2cpp-meta-");
  fs.cpSync(fixturePath("unity-il2cpp"), gameDir, { recursive: true });
  const header = Buffer.alloc(16);
  header.writeUInt32LE(0xfab11baf, 0);
  header.writeUInt32LE(39, 4);
  fs.writeFileSync(path.join(gameDir, "FixtureIl2Cpp_Data", "il2cpp_data", "Metadata", "global-metadata.dat"), header);
  const { profile } = await detectGameProfile(gameDir, { root: repoRoot });
  assert.equal(profile.runtime.backend, "il2cpp");
  assert.equal(profile.runtime.metadataVersion, 39);
  assert.ok(profile.evidence.some((entry) => /metadata version 39/.test(entry.claim)));
});

test("the BepInEx version is read from LogOutput.log after the first launch", (t) => {
  const gameDir = tempDir(t, "gmf-bepinex-ver-");
  fs.cpSync(fixturePath("unity-il2cpp"), gameDir, { recursive: true });
  fs.writeFileSync(path.join(gameDir, "BepInEx", "LogOutput.log"), "[Message: Preloader] BepInEx 6.0.0-be.793 - Fixture (2026-11-07 1:42:42 AM)\n");
  assert.equal(detectLoader(gameDir, "il2cpp").loader.version, "6.0.0-be.793");
});

test("the metadata version is kept when GameAssembly is missing", async () => {
  const game = tempRoot("gmf-unity-meta-no-assembly-");
  fs.cpSync(fixture, game, { recursive: true });
  fs.rmSync(path.join(game, "GameAssembly.dll"), { force: true });
  const header = Buffer.alloc(16);
  header.writeUInt32LE(0xfab11baf, 0);
  header.writeUInt32LE(31, 4);
  fs.writeFileSync(path.join(game, "FixtureIl2Cpp_Data", "il2cpp_data", "Metadata", "global-metadata.dat"), header);
  const detection = await detectUnity(game);
  assert.equal(detection.runtime.backend, "il2cpp");
  assert.equal(detection.runtime.metadataVersion, 31);
});
