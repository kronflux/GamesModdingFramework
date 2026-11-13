// unreal.read_containers: lists each pak with repak and extracts only .ini, .locres, .uplugin
// and .uproject entries. The fake runner imitates repak's `list` and `unpack -o -f -i` command
// lines (checked against repak's own help).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readContainersOperation } from "../src/engines/unreal/operations/containers.mjs";
import { executeOperation, registerOperation } from "../src/core/operations.mjs";
import { snapshotTree } from "./helpers/tree.mjs";

// Registering twice only replaces the entry, so this is safe next to index.mjs registering it.
registerOperation(readContainersOperation, readContainersOperation.handler);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmf-unreal-containers-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function toolCache(name) {
  const cacheDir = path.join(root, `${name}-tools`);
  fs.mkdirSync(cacheDir, { recursive: true });
  const manifest = { repak: { id: "repak", version: "fake", path: process.execPath, args: ["--repak"], verification: { kind: "none", ok: true } } };
  fs.writeFileSync(path.join(cacheDir, "tools.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return cacheDir;
}

function workspaceAt(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return { root: dir, config: { version: 1 }, local: { version: 1 }, profile: { engine: { id: "unreal", version: "5.6" } } };
}

function gameWith(name, paks) {
  const gameDir = path.join(root, name);
  const paksDir = path.join(gameDir, "Content", "Paks");
  fs.mkdirSync(paksDir, { recursive: true });
  for (const pakName of paks) write(path.join(paksDir, pakName), "SYNTHETIC PAK");
  return gameDir;
}

// entriesByPak: pak file name -> entry paths that `repak list` prints.
function fakeRepak(entriesByPak, calls) {
  return async (cmd, argv) => {
    const [tool, ...args] = argv;
    calls.push({ tool: tool.slice(2), args });
    if (args[0] === "list") {
      const pak = path.basename(args[args.length - 1]);
      return { code: 0, stdout: `${(entriesByPak[pak] || []).join("\n")}\n`, stderr: "" };
    }
    if (args[0] === "unpack") {
      const out = args[args.indexOf("-o") + 1];
      for (let i = 0; i < args.length; i++) {
        if (args[i] !== "-i") continue;
        // A real unpack writes whatever the pak says; a hostile pak entry would land outside `out`.
        write(path.resolve(out, args[i + 1]), `EXTRACTED ${args[i + 1]}`);
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected call ${args.join(" ")}` };
  };
}

const FULL = [
  "Engine/Plugins/2D/Paper2D/Config/BasePaper2D.ini",
  "Engine/Content/Localization/Engine/en/Engine.locres",
  "Engine/Plugins/2D/Paper2D/Paper2D.uplugin",
  "StormEscape/StormEscape.uproject",
  "StormEscape/Content/Maps/Level.umap",
  "StormEscape/Content/Maps/Level.uasset",
  "StormEscape/Content/Data/readme.txt",
  "StormEscape/Content/Weird.INI.bak",
];

test("only the four kinds are extracted", async () => {
  const gameDir = gameWith("game-kinds", ["Game-Windows.pak"]);
  const gameBefore = snapshotTree(gameDir);
  const workspace = workspaceAt("ws-kinds");
  const calls = [];
  const result = await executeOperation(
    "unreal.read_containers",
    { gameDir },
    { workspace, toolCacheDir: toolCache("kinds"), runProcess: fakeRepak({ "Game-Windows.pak": FULL }, calls) },
  );
  assert.equal(result.ok, true, result.error?.message);
  const textDir = path.join(workspace.root, "extracted", "unreal", "text");
  assert.equal(result.data.textDir, textDir);
  assert.deepEqual(result.data.paks, [{ name: "Game-Windows", kept: { ini: 1, locres: 1, uplugin: 1, uproject: 1 } }]);
  assert.deepEqual(result.data.none, []);

  const unpack = calls.find((call) => call.args[0] === "unpack").args;
  const included = unpack.flatMap((arg, i) => (arg === "-i" ? [unpack[i + 1]] : []));
  assert.deepEqual(included.sort(), FULL.slice(0, 4).sort());
  assert.equal(unpack[unpack.indexOf("-o") + 1], path.join(textDir, "Game-Windows"));
  assert.ok(fs.existsSync(path.join(textDir, "Game-Windows", "StormEscape", "StormEscape.uproject")));
  assert.equal(fs.existsSync(path.join(textDir, "Game-Windows", "StormEscape", "Content", "Maps", "Level.umap")), false);
  assert.deepEqual(snapshotTree(gameDir), gameBefore);
});

test("an absent kind is reported in none, and ~mods paks are skipped", async () => {
  const gameDir = gameWith("game-none", ["A.pak"]);
  write(path.join(gameDir, "Content", "Paks", "~mods", "Mod_P.pak"), "SYNTHETIC PAK");
  const workspace = workspaceAt("ws-none");
  const calls = [];
  const result = await executeOperation(
    "unreal.read_containers",
    { gameDir },
    { workspace, toolCacheDir: toolCache("none"), runProcess: fakeRepak({ "A.pak": ["X/a.ini", "X/B.INI", "X/c.locres"], "Mod_P.pak": ["X/m.uplugin"] }, calls) },
  );
  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual(result.data.paks, [{ name: "A", kept: { ini: 2, locres: 1, uplugin: 0, uproject: 0 } }]);
  assert.deepEqual(result.data.none, ["uplugin", "uproject"]);
  assert.equal(calls.filter((call) => call.args[0] === "list").length, 1);
});

test("an entry escaping the output folder is refused", async () => {
  const gameDir = gameWith("game-escape", ["A.pak"]);
  const workspace = workspaceAt("ws-escape");
  const calls = [];
  const entries = ["../../../outside.ini", "Good/ok.ini", "/abs/root.ini", "C:/drive/x.ini", "Good/../../up.locres"];
  const result = await executeOperation(
    "unreal.read_containers",
    { gameDir },
    { workspace, toolCacheDir: toolCache("escape"), runProcess: fakeRepak({ "A.pak": entries }, calls) },
  );
  assert.equal(result.ok, true, result.error?.message);
  const unpack = calls.find((call) => call.args[0] === "unpack").args;
  const included = unpack.flatMap((arg, i) => (arg === "-i" ? [unpack[i + 1]] : []));
  assert.deepEqual(included, ["Good/ok.ini"]);
  assert.deepEqual(result.data.paks, [{ name: "A", kept: { ini: 1, locres: 0, uplugin: 0, uproject: 0 } }]);
  assert.equal(result.data.refused.length, 4);
  assert.equal(fs.existsSync(path.join(workspace.root, "extracted", "unreal", "outside.ini")), false);
});

test("many entries are unpacked in several calls", async () => {
  const gameDir = gameWith("game-many", ["A.pak"]);
  const workspace = workspaceAt("ws-many");
  const calls = [];
  const entries = Array.from({ length: 600 }, (_, i) => `Engine/Plugins/Some/Long/Plugin/Folder/Config/Base${i}.ini`);
  const result = await executeOperation(
    "unreal.read_containers",
    { gameDir },
    { workspace, toolCacheDir: toolCache("many"), runProcess: fakeRepak({ "A.pak": entries }, calls) },
  );
  assert.equal(result.ok, true, result.error?.message);
  const unpacks = calls.filter((call) => call.args[0] === "unpack");
  assert.ok(unpacks.length > 1);
  assert.equal(unpacks.reduce((sum, call) => sum + call.args.filter((arg) => arg === "-i").length, 0), 600);
  assert.equal(result.data.paks[0].kept.ini, 600);
});

test("a game with no pak names the folder", async () => {
  const gameDir = gameWith("game-nopak", []);
  const workspace = workspaceAt("ws-nopak");
  const result = await executeOperation(
    "unreal.read_containers",
    { gameDir },
    { workspace, toolCacheDir: toolCache("nopak"), runProcess: fakeRepak({}, []) },
  );
  assert.equal(result.ok, false);
  assert.ok(String(result.error?.message).includes(path.join(gameDir, "Content", "Paks")), result.error?.message);
});
