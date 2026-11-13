import test, { after, before } from "node:test";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initWorkspace,
  readWorkspace,
  writeProfile,
  readProfile,
  assertInside,
  backupFile,
} from "../src/core/workspace.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmf-workspace-"));
const game = path.join(root, "game");
const ws = path.join(root, "workspace");
const wsShared = path.join(root, "workspace-shared");
fs.mkdirSync(game, { recursive: true });
fs.writeFileSync(path.join(game, "Game.exe"), "fake");

after(() => fs.rmSync(root, { recursive: true, force: true }));

before(() => {
  initWorkspace({ gameDir: game, workspaceDir: wsShared, author: "Tester" });
});

test("initWorkspace writes committed identity and machine paths separately", () => {
  initWorkspace({ gameDir: game, workspaceDir: ws, author: "Tester" });
  const committedText = fs.readFileSync(path.join(ws, "gmf.json"), "utf8");
  const committed = JSON.parse(committedText);
  const local = JSON.parse(fs.readFileSync(path.join(ws, "gmf.local.json"), "utf8"));

  assert.equal(committed.game.author, "Tester");
  assert.equal(committed.game.name, "game");
  assert.ok(!committedText.includes(game), "committed identity has no absolute path");
  assert.ok(!committedText.includes(JSON.stringify(game).slice(1, -1)), "committed identity has no JSON-escaped absolute path");
  assert.equal(local.gameDir, game);

  const loaded = readWorkspace(ws);
  assert.equal(loaded.config.game.author, "Tester");
  assert.equal(loaded.local.gameDir, game);
});

function listTree(dir) {
  return fs
    .readdirSync(dir, { recursive: true })
    .map((entry) => String(entry).split(path.sep).join("/"))
    .sort();
}

function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("init writes AGENTS.md, CLAUDE.md, .gitignore and mods and skips them on rerun", () => {
  const wsFull = path.join(root, "workspace-full");
  const gameBefore = listTree(game);
  const six = ["gmf.json", "gmf.local.json", "AGENTS.md", "CLAUDE.md", ".gitignore", "mods/.gitkeep"];

  const first = initWorkspace({ gameDir: game, workspaceDir: wsFull, author: "Tester" });
  for (const rel of six) assert.ok(fs.existsSync(path.join(wsFull, rel)), `${rel} exists`);
  assert.deepEqual([...first.written].sort(), [...six].sort());
  assert.deepEqual(first.skipped, []);
  assert.equal(fs.readFileSync(path.join(wsFull, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  const ignore = fs.readFileSync(path.join(wsFull, ".gitignore"), "utf8");
  for (const entry of ["decompiled/", "extracted/", "dumps/", "gamedocs/", "logs/", "backups/", ".gmf/", "gmf.local.json", "gmf.profile.json", "gmf.plan.json"]) {
    assert.ok(ignore.split(/\r?\n/).includes(entry), `.gitignore lists ${entry}`);
  }
  const agents = fs.readFileSync(path.join(wsFull, "AGENTS.md"), "utf8");
  assert.ok(!agents.includes("{{"), "placeholders are rendered");
  assert.ok(agents.includes("Tester"));

  const hashes = Object.fromEntries(six.map((rel) => [rel, hashFile(path.join(wsFull, rel))]));
  const second = initWorkspace({ gameDir: game, workspaceDir: wsFull, author: "Tester" });
  for (const rel of ["AGENTS.md", "CLAUDE.md", ".gitignore", "mods/.gitkeep"]) {
    assert.ok(second.skipped.includes(rel), `${rel} skipped`);
    assert.equal(hashFile(path.join(wsFull, rel)), hashes[rel], `${rel} unchanged`);
  }
  assert.ok(second.skipped.includes("gmf.json"));
  assert.ok(second.skipped.includes("gmf.local.json"));
  assert.equal(second.skipped.length, 6);
  assert.deepEqual(second.written, []);
  assert.deepEqual(listTree(game), gameBefore);
});

test("init on a folder that already has AGENTS.md keeps it", () => {
  const wsKeep = path.join(root, "workspace-keep");
  fs.mkdirSync(wsKeep, { recursive: true });
  fs.writeFileSync(path.join(wsKeep, "AGENTS.md"), "my own guide\n");
  const result = initWorkspace({ gameDir: game, workspaceDir: wsKeep });
  assert.equal(fs.readFileSync(path.join(wsKeep, "AGENTS.md"), "utf8"), "my own guide\n");
  assert.ok(result.skipped.includes("AGENTS.md"));
  assert.ok(!result.written.includes("AGENTS.md"));
  assert.ok(result.written.includes("CLAUDE.md"));
});

test("profile round-trips and assertInside rejects an escape", () => {
  const workspace = readWorkspace(wsShared);
  const profile = { version: 1, engine: { id: "unknown" } };
  writeProfile(workspace, profile);
  assert.deepEqual(readProfile(workspace), profile);

  assert.throws(() => assertInside(workspace, path.join(wsShared, "..", "outside")), /outside the workspace/i);
  assert.equal(assertInside(workspace, path.join(wsShared, "mods", "x")), path.join(wsShared, "mods", "x"));
});

test("backupFile copies a file and returns its hash", () => {
  const workspace = readWorkspace(wsShared);
  const result = backupFile(workspace, path.join(game, "Game.exe"));
  assert.ok(fs.existsSync(result.backupPath));
  assert.equal(result.sha256, crypto.createHash("sha256").update("fake").digest("hex"));
  assert.equal(path.dirname(result.backupPath), path.join(wsShared, "backups"), "the backup lives under the workspace");
  assert.equal(fs.readFileSync(result.backupPath, "utf8"), "fake");
  assert.equal(fs.readFileSync(path.join(game, "Game.exe"), "utf8"), "fake", "the original is untouched");
});

test("initWorkspace refuses to overwrite an unparsable gmf.json and leaves its bytes alone", () => {
  const wsBroken = path.join(root, "workspace-broken");
  fs.mkdirSync(wsBroken, { recursive: true });
  const configPath = path.join(wsBroken, "gmf.json");
  fs.writeFileSync(configPath, '{"version": 1, "game": {');
  assert.throws(() => initWorkspace({ gameDir: game, workspaceDir: wsBroken }), (error) => error.code === "GMF-E-FILE-002");
  assert.equal(fs.readFileSync(configPath, "utf8"), '{"version": 1, "game": {');
  assert.ok(!fs.existsSync(path.join(wsBroken, "gmf.local.json")), "nothing else was written");
});

test("assertInside accepts a workspace entry whose name starts with two dots", () => {
  const workspace = readWorkspace(wsShared);
  assert.equal(assertInside(workspace, path.join(wsShared, "..foo")), path.join(wsShared, "..foo"));
  assert.throws(() => assertInside(workspace, path.join(wsShared, "..")), /outside the workspace/i);
});
