import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectUnity,
  findDataDir,
  detectBackend,
  detectUnityVersion,
  detectLoader,
  targetFramework,
  templateFor,
} from "../src/engines/unity/detect.mjs";
import { executeOperation } from "../src/core/operations.mjs";
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

test("a Mono fixture returns unity, mono, BepInEx 5 and the Unity version", async () => {
  const before = snapshot(fixture);
  const detection = await detectUnity(fixture);
  const after = snapshot(fixture);

  assert.equal(detection.engine.id, "unity");
  assert.equal(detection.engine.version, "2021.3.45f1");
  assert.equal(detection.engine.confidence, "observed");
  assert.equal(detection.runtime.backend, "mono");
  assert.equal(detection.loader.id, "bepinex5");
  assert.equal(detection.loader.installed, true);
  assert.match(detection.paths.data, /FixtureGame_Data$/);
  assert.match(detection.paths.managed, /Managed$/);
  assert.match(detection.paths.deploy, /BepInEx[\\/]plugins$/);
  assert.ok(Array.isArray(detection.notes));
  assert.ok(Array.isArray(detection.unknowns));

  const sources = detection.engine.evidence.map((record) => record.source).join("\n");
  assert.match(sources, /globalgamemanagers/);
  assert.match(sources, /BepInEx\.dll/);
  assert.deepEqual(after, before, "detection must not write into the game directory");
});

test("game.detect runs through the operation registry and reports capabilities", async () => {
  const before = snapshot(fixture);
  const result = await executeOperation("game.detect", { gameDir: fixture }, { root: repoRoot });
  const after = snapshot(fixture);

  assert.equal(result.ok, true, result.error?.message);
  const profile = result.data.profile;
  assert.equal(profile.engine.id, "unity");
  assert.equal(profile.engine.selected, true);
  assert.equal(profile.runtime.backend, "mono");
  assert.equal(profile.loader.id, "bepinex5");
  const code = profile.capabilities.find((capability) => capability.id === "code");
  assert.ok(code, "a Mono game with BepInEx reports the code capability");
  assert.equal(code.support, "full");
  assert.deepEqual(after, before, "game.detect must not write into the game directory");
});

test("a trailing separator and a junction resolve to the same game", async (t) => {
  const trailing = await detectUnity(`${fixture}${path.sep}`);
  assert.equal(trailing.engine.id, "unity");

  const root = tempDir("gmf-unity-link-");
  const link = path.join(root, "linked-game");
  try {
    fs.symlinkSync(fixture, link, "junction");
  } catch (error) {
    t.skip(`junction creation unavailable: ${error.code || error.message}`);
    return;
  }
  const linked = await detectUnity(link);
  assert.equal(linked.engine.id, "unity");
  assert.equal(linked.engine.version, "2021.3.45f1");
});

test("multiple *_Data folders prefer the one matching the executable", () => {
  const root = tempDir("gmf-unity-multi-");
  fs.mkdirSync(path.join(root, "FixtureGame_Data"), { recursive: true });
  fs.mkdirSync(path.join(root, "Old_Data"), { recursive: true });
  fs.writeFileSync(path.join(root, "FixtureGame.exe"), "SYNTHETIC");
  fs.writeFileSync(path.join(root, "FixtureGame_Data", "globalgamemanagers"), "2020.1.1f1");
  fs.writeFileSync(path.join(root, "Old_Data", "globalgamemanagers"), "2019.1.1f1");

  assert.equal(findDataDir(root), path.join(root, "FixtureGame_Data"));
  assert.equal(detectUnityVersion(path.join(root, "FixtureGame_Data")).version, "2020.1.1f1");
});

test("a game path that is a file fails with GMF-E-GAME-001 and names the path", async () => {
  const target = path.join(fixture, "FixtureGame.exe");
  const result = await executeOperation("game.detect", { gameDir: target }, { root: repoRoot });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GMF-E-GAME-001");
  assert.ok(result.error.message.includes(target), "the error names the path it tried");
});

test("a BepInEx folder without core reports an incomplete loader and a remediation", async () => {
  const game = tempDir("gmf-unity-bepinex-incomplete-");
  fs.cpSync(fixture, game, { recursive: true });
  fs.rmSync(path.join(game, "BepInEx", "core"), { recursive: true, force: true });

  const { loader, notes } = detectLoader(game, "mono");
  assert.equal(loader.id, "bepinex5");
  assert.equal(loader.installed, false);
  const text = [...loader.notes, ...notes].join("\n");
  assert.match(text, /core/i);

  const detection = await detectUnity(game);
  assert.equal(detection.loader.installed, false);
  assert.ok(
    detection.unknowns.some((record) => /BepInEx|loader/i.test(record.question)),
    "an incomplete loader is recorded as an unknown",
  );
});

test("MelonLoader bootstrap-only is reported as incomplete and a full install is not", async () => {
  const bootstrap = tempDir("gmf-unity-melon-bootstrap-");
  fs.writeFileSync(path.join(bootstrap, "version.dll"), "SYNTHETIC");
  const partial = detectLoader(bootstrap, "mono");
  assert.equal(partial.loader.id, "melonloader");
  assert.equal(partial.loader.installed, false);
  assert.match(partial.loader.notes.join("\n"), /MelonLoader\.dll/);

  const full = tempDir("gmf-unity-melon-full-");
  fs.mkdirSync(path.join(full, "MelonLoader"), { recursive: true });
  fs.writeFileSync(path.join(full, "MelonLoader", "MelonLoader.dll"), "SYNTHETIC");
  const installed = detectLoader(full, "mono");
  assert.equal(installed.loader.id, "melonloader");
  assert.equal(installed.loader.installed, true);
  assert.match(installed.deployDir, /Mods$/);

  // MelonLoader 0.6 and later: version.dll plus MelonLoader/net6 (or net35, net472).
  for (const runtime of ["net6", "net35", "net472"]) {
    const modern = tempDir(`gmf-unity-melon-${runtime}-`);
    fs.writeFileSync(path.join(modern, "version.dll"), "SYNTHETIC");
    fs.mkdirSync(path.join(modern, "MelonLoader", runtime), { recursive: true });
    fs.writeFileSync(path.join(modern, "MelonLoader", runtime, "MelonLoader.dll"), "SYNTHETIC");
    const found = detectLoader(modern, runtime === "net6" ? "il2cpp" : "mono");
    assert.equal(found.loader.id, "melonloader", runtime);
    assert.equal(found.loader.installed, true, `${runtime} layout counts as installed`);
  }
});

test("target frameworks and template folders follow the loader and backend", () => {
  assert.equal(targetFramework("bepinex5", "mono"), "net472");
  assert.equal(targetFramework("bepinex6", "mono"), "netstandard2.1");
  assert.equal(targetFramework("bepinex6", "il2cpp"), "net6.0");
  // MelonLoader 0.7.3's zip: net35 and net472 for Mono, net6 for IL2CPP.
  assert.equal(targetFramework("melonloader", "mono"), "net472");
  assert.equal(targetFramework("melonloader", "il2cpp"), "net6.0");
  assert.throws(() => targetFramework("bepinex5", "il2cpp"), /mono/i);

  assert.equal(templateFor("bepinex5", "mono"), "bepinex5");
  assert.equal(templateFor("bepinex6", "mono"), "bepinex6-mono");
  assert.equal(templateFor("bepinex6", "il2cpp"), "bepinex6-il2cpp");
  assert.equal(templateFor("melonloader", "mono"), "melonloader");
  assert.equal(templateFor("melonloader", "il2cpp"), "melonloader");
  assert.throws(() => templateFor("none", "mono"), /template/i);
});

test("game.detect on a folder with no engine markers returns an unknown profile with an engine.hints array", async () => {
  const result = await executeOperation("game.detect", { gameDir: fixturePath("no-engine") }, { root: repoRoot });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.data.profile.engine.id, "unknown");
  assert.ok(Array.isArray(result.data.profile.engine.hints));
});

test("a directory with no Unity markers reports an unknown confidence", async () => {
  const empty = tempDir("gmf-unity-empty-");
  const detection = await detectUnity(empty);
  assert.equal(detection.engine.id, "unity");
  assert.equal(detection.engine.confidence, "unknown");
  assert.equal(detection.runtime.backend, "unknown");
  assert.ok(detection.unknowns.length > 0);
});

test("Unity 4 and 5 version strings are read from globalgamemanagers", () => {
  for (const version of ["5.6.7f1", "4.7.2f1", "5.3.8p2"]) {
    const dataDir = tempDir("gmf-unity-old-version-");
    fs.writeFileSync(path.join(dataDir, "globalgamemanagers"), Buffer.concat([Buffer.alloc(32), Buffer.from(`${version}\0`, "latin1")]));
    assert.equal(detectUnityVersion(dataDir).version, version);
  }
  const noise = tempDir("gmf-unity-noise-version-");
  fs.writeFileSync(path.join(noise, "globalgamemanagers"), "build 1.5.7f1 and 25.3.1f2 only");
  assert.equal(detectUnityVersion(noise).version, null, "a version inside a longer number is not a Unity version");
});

test("the data folder follows the same executable choice as the executable lookup", () => {
  const root = path.join(tempDir("gmf-unity-exe-choice-"), "GameRoot");
  for (const name of ["Aaa", "GameRoot"]) {
    fs.mkdirSync(path.join(root, `${name}_Data`), { recursive: true });
    fs.writeFileSync(path.join(root, `${name}.exe`), "SYNTHETIC");
    fs.writeFileSync(path.join(root, `${name}_Data`, "globalgamemanagers"), "2021.3.1f1");
  }
  assert.equal(findDataDir(root), path.join(root, "GameRoot_Data"));
});

test("an installed MelonLoader reports its MelonLoader.dll as the loader entry", () => {
  const modern = tempDir("gmf-unity-melon-entry-");
  fs.mkdirSync(path.join(modern, "MelonLoader", "net6"), { recursive: true });
  fs.mkdirSync(path.join(modern, "MelonLoader", "net472"), { recursive: true });
  fs.writeFileSync(path.join(modern, "MelonLoader", "net6", "MelonLoader.dll"), "SYNTHETIC");
  fs.writeFileSync(path.join(modern, "MelonLoader", "net472", "MelonLoader.dll"), "SYNTHETIC");
  assert.equal(detectLoader(modern, "il2cpp").entry, path.join(modern, "MelonLoader", "net6", "MelonLoader.dll"));
  assert.equal(detectLoader(modern, "mono").entry, path.join(modern, "MelonLoader", "net472", "MelonLoader.dll"));
});
