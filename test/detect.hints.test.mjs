import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeOperation } from "../src/core/operations.mjs";
import { validateEngineHint } from "../src/core/contracts.mjs";
import { engineHints } from "../src/operations/game/hints.mjs";
import { listGames } from "../src/operations/game/games.mjs";
import "../src/engines/unity/index.mjs";
import { repoRoot, fixture as fixturePath } from "./helpers/paths.mjs";
import { tempDir } from "./helpers/tmp.mjs";
import { snapshotTree } from "./helpers/tree.mjs";

const hintsRoot = fixturePath("hints");

async function detect(gameDir) {
  const result = await executeOperation("game.detect", { gameDir }, { root: repoRoot });
  assert.equal(result.ok, true, result.error?.message);
  return result.data.profile;
}

for (const [family, dir, suffix] of [
  ["godot", "godot", "game.pck"],
  ["gamemaker", "gamemaker", "data.win"],
  ["source", "source", "engine.dll"],
  ["renpy", "renpy", "renpy"],
  ["rpgmaker", "rpgmaker", "rpg_core.js"],
]) {
  test(`${family} fixture yields unknown engine with a ${family} hint`, async () => {
    const profile = await detect(path.join(hintsRoot, dir));
    assert.equal(profile.engine.id, "unknown");
    assert.ok(Array.isArray(profile.engine.hints));
    assert.equal(profile.engine.hints[0].family, family);
    assert.equal(profile.engine.hints[0].confidence, "observed");
    assert.ok(profile.engine.hints[0].evidence[0].path.endsWith(suffix), profile.engine.hints[0].evidence[0].path);
    assert.equal(validateEngineHint(profile.engine.hints[0]).ok, true);
  });
}

test("a fixture with no markers yields an empty hints array", async () => {
  const gameDir = fixturePath("no-engine");
  assert.deepEqual(engineHints(gameDir), []);
  const profile = await detect(gameDir);
  assert.equal(profile.engine.id, "unknown");
  assert.deepEqual(profile.engine.hints, []);
});

test("game.hints returns the hints without writing", async () => {
  const gameDir = path.join(hintsRoot, "godot");
  const before = snapshotTree(gameDir);
  const result = await executeOperation("game.hints", { gameDir }, { root: repoRoot });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.data.hints[0].family, "godot");
  assert.deepEqual(snapshotTree(gameDir), before, "the game folder is unchanged");
});

test("marker rules for the remaining families", (t) => {
  const root = tempDir(t, "gmf-hints-");
  const make = (name, files) => {
    const dir = path.join(root, name);
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), "synthetic placeholder");
    }
    return dir;
  };
  assert.equal(engineHints(make("cry", ["Bin64/CrySystem.dll"]))[0].family, "cryengine");
  assert.equal(engineHints(make("frost", ["Data/Win32/game.toc"]))[0].family, "frostbite");
  assert.equal(engineHints(make("construct", ["data.js", "c3runtime.js"]))[0].family, "construct");
  assert.equal(engineHints(make("webgl", ["Build/game.wasm", "Build/game.loader.js"]))[0].family, "unity-webgl");
  assert.equal(engineHints(make("nw", ["nw.dll", "package.json"]))[0].family, "rpgmaker");
  assert.equal(engineHints(make("vpk", ["pak01_dir.vpk"]))[0].family, "source");
  assert.equal(engineHints(make("rpa", ["game/scripts.rpa"]))[0].family, "renpy");
  assert.equal(engineHints(make("partial", ["data.js"])).length, 0);
});

test("steam library folders are listed and a missing library is skipped", (t) => {
  const root = tempDir(t, "gmf-steam-");
  fs.cpSync(fixturePath("steam", "library-a"), path.join(root, "library-a"), { recursive: true });
  const template = fs.readFileSync(fixturePath("steam", "libraryfolders.vdf.tpl"), "utf8");
  const vdf = path.join(root, "libraryfolders.vdf");
  fs.writeFileSync(vdf, template.replaceAll("{{root}}", root.replaceAll("\\", "/")));

  const games = listGames([], { steamRoots: [vdf, path.join(root, "absent.vdf")] });
  const godot = games.find((game) => game.path === path.resolve(root, "library-a", "steamapps", "common", "GodotGame"));
  assert.ok(godot, JSON.stringify(games));
  assert.equal(godot.store, "steam");
  assert.equal(godot.engine, "unknown");
  assert.equal(godot.hints[0].family, "godot");
  assert.equal(games.length, 1);
});

test("game.games accepts steamRoots", async () => {
  const result = await executeOperation("game.games", { steamRoots: [path.join(os.tmpdir(), "no-such.vdf")] }, { env: {} });
  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual(result.data.games, []);
});

test("weak markers give an inferred hint and strong markers an observed one", (t) => {
  const root = tempDir(t, "gmf-hints-confidence-");
  const make = (name, files) => {
    const dir = path.join(root, name);
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), "synthetic placeholder");
    }
    return dir;
  };
  const confidence = (dir) => engineHints(dir)[0].confidence;
  assert.equal(confidence(make("nw-only", ["nw.dll", "package.json"])), "inferred", "any NW.js app is not an RPG Maker game");
  assert.equal(confidence(make("nw-rpg", ["nw.dll", "package.json", "www/js/rpg_core.js"])), "observed");
  assert.equal(confidence(make("toc-only", ["Data/game.toc"])), "inferred");
  assert.equal(confidence(make("sb", ["Data/Win32/game.sb"])), "observed");
  for (const dir of ["nw-only", "toc-only"]) assert.equal(validateEngineHint(engineHints(path.join(root, dir))[0]).ok, true);
});
