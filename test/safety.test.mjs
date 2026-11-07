import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectAntiCheat,
  assertPolicy,
  antiCheatWarning,
  acknowledgeAntiCheat,
  createBackup,
  restoreBackup,
} from "../src/core/safety.mjs";
import { executeOperation, getHandler, getOperationDescriptor } from "../src/core/operations.mjs";
import { validateOperation } from "../src/core/contracts.mjs";
import { initWorkspace, readWorkspace } from "../src/core/workspace.mjs";
import { scanPaths } from "../scripts/pre-commit.mjs";
import "../src/operations/generic/backup.mjs";
import "../src/operations/generic/restore.mjs";
import { fixture as fixturePath } from "./helpers/paths.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const fixture = fixturePath("anticheat");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmf-safety-"));
const game = path.join(root, "game");
const ws = path.join(root, "workspace");
fs.mkdirSync(path.join(game, "Data"), { recursive: true });
fs.writeFileSync(path.join(game, "Game.exe"), "synthetic-game-executable");
fs.writeFileSync(path.join(game, "Data", "file.bin"), "payload-original");

after(() => fs.rmSync(root, { recursive: true, force: true }));

test("an EasyAntiCheat marker in a subfolder is detected once", () => {
  const markers = detectAntiCheat(fixture);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].id, "easyanticheat");
  assert.equal(markers[0].name, "Easy Anti-Cheat");
  assert.match(markers[0].path, /EasyAntiCheat/);
  assert.deepEqual(detectAntiCheat(game), []);
});

test("credentials and piracy are refused, destructive needs user approval and anti-cheat only warns", () => {
  assert.throws(() => assertPolicy("credentials", { source: "model" }), /GMF-E-POLICY-001/);
  assert.throws(() => assertPolicy("piracy", { source: "user" }), /GMF-E-POLICY-001/);
  assert.throws(() => assertPolicy("destructive", { source: "model", target: "Game.exe" }), /GMF-E-GATE-001/);
  assert.equal(
    assertPolicy("destructive", { approved: true, approvedBy: "user", source: "user approved deletion" }).ok,
    true,
  );
  for (const approval of [{ approved: true, approvedBy: "model" }, { approved: true }, { approvedBy: "user" }, { approved: "true", approvedBy: "user" }]) {
    assert.throws(() => assertPolicy("destructive", { ...approval, target: "Game.exe" }), /GMF-E-GATE-001/, JSON.stringify(approval));
  }
  const warning = assertPolicy("antiCheat", { markers: [{ id: "easyanticheat" }], source: "plan" });
  assert.equal(warning.warning.code, "GMF-W-ANTICHEAT-001");
  assert.deepEqual(warning.warning.markers, ["easyanticheat"]);
  assert.equal(assertPolicy("gameWrite", {}).ok, true);
  assert.equal(antiCheatWarning([]).code, "GMF-W-ANTICHEAT-001");
});

before(() => {
  initWorkspace({ gameDir: game, workspaceDir: ws, author: "Tester" });
});

test("an anti-cheat acknowledgment is recorded in gmf.plan.json", () => {
  const workspace = readWorkspace(ws);
  const markers = detectAntiCheat(fixture);
  const record = acknowledgeAntiCheat(workspace, {
    markers,
    source: "user: deploy the mod",
    operation: "unity.deploy",
    step: "3",
  });
  assert.equal(record.effect, "antiCheat");
  assert.equal(record.warning, "GMF-W-ANTICHEAT-001");
  const plan = JSON.parse(fs.readFileSync(path.join(ws, "gmf.plan.json"), "utf8"));
  assert.ok(
    plan.authorizations.some(
      (entry) => entry.effect === "antiCheat" && entry.warning === "GMF-W-ANTICHEAT-001" && entry.source.includes("deploy"),
    ),
  );
});

test("backup and restore round-trip the original hash", () => {
  const workspace = readWorkspace(ws);
  const target = path.join(game, "Game.exe");
  const original = fs.readFileSync(target);
  const created = createBackup(workspace, target);
  assert.match(created.sha256, /^[a-f0-9]{64}$/);
  assert.ok(fs.existsSync(created.backupPath));
  assert.equal(created.source, target);

  fs.writeFileSync(target, "synthetic-game-executable-changed");
  const restored = restoreBackup(workspace, target);
  assert.equal(restored.sha256, created.sha256);
  assert.equal(restored.restored, true);
  assert.deepEqual(fs.readFileSync(target), original);
});

test("restore refuses a target with no recorded backup", () => {
  const workspace = readWorkspace(ws);
  assert.throws(() => restoreBackup(workspace, path.join(game, "Data", "other.bin")), /GMF-E-BACKUP-001/);
});

test("generic.backup and generic.restore are registered and return the original hash", async () => {
  const workspace = readWorkspace(ws);
  for (const id of ["generic.backup", "generic.restore"]) {
    assert.ok(getHandler(id), `${id} is not registered`);
    assert.deepEqual(validateOperation(getOperationDescriptor(id)), { ok: true, errors: [] });
  }

  const target = path.join(game, "Data", "file.bin");
  const backup = await executeOperation("generic.backup", { gamePath: target }, { workspace });
  assert.equal(backup.ok, true, backup.error?.message);
  assert.match(backup.data.sha256, /^[a-f0-9]{64}$/);

  fs.writeFileSync(target, "payload-new");
  const restore = await executeOperation("generic.restore", { gamePath: target }, { workspace, authorizations: [{ effect: "gameWrite", source: "test: game write" }] });
  assert.equal(restore.ok, true, restore.error?.message);
  assert.equal(restore.data.sha256, backup.data.sha256);
  assert.equal(fs.readFileSync(target, "utf8"), "payload-original");
});

test("the pre-commit gate rejects a game DLL and a secret but passes a clean file", (t) => {
  const repo = tempDir(t, "gmf-precommit-");
  fs.mkdirSync(path.join(repo, "lib"), { recursive: true });
  fs.mkdirSync(path.join(repo, "config"), { recursive: true });
  fs.writeFileSync(path.join(repo, "lib", "Assembly-CSharp.dll"), "MZ synthetic managed assembly");
  fs.writeFileSync(
    path.join(repo, "config", "secrets.mjs"),
    'export const apiKey = "sk-' + 'live-' + 'abcdefghijklmnopqrstuvwxyz";\n',
  );
  fs.writeFileSync(path.join(repo, "clean.mjs"), "export const ok = true;\n");

  const result = scanPaths(repo);
  assert.equal(result.ok, false);
  assert.ok(
    result.violations.some((violation) => violation.path === "lib/Assembly-CSharp.dll" && violation.kind === "game-content"),
    JSON.stringify(result.violations),
  );
  assert.ok(
    result.violations.some((violation) => violation.path === "config/secrets.mjs" && violation.kind === "secret"),
    JSON.stringify(result.violations),
  );
  assert.ok(!result.violations.some((violation) => violation.path === "clean.mjs"));

  assert.deepEqual(scanPaths(repo, ["clean.mjs"]), { ok: true, violations: [], scanned: 1 });
});

test("the pre-commit gate ignores synthetic fixture placeholders", (t) => {
  const repo = tempDir(t, "gmf-fixtures-");
  const fixtureDir = path.join(repo, "test", "fixtures", "unity-mono");
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, "FixtureGame.dll"), "synthetic placeholder");
  const result = scanPaths(repo);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  assert.equal(result.violations.length, 0);
});

test("restoreBackup takes only recorded backups, and only onto their own source", () => {
  const workspace = readWorkspace(ws);
  const target = path.join(game, "Data", "file.bin");
  const other = path.join(game, "Data", "other.bin");
  fs.writeFileSync(other, "other-original");
  const recorded = createBackup(workspace, target);
  const otherRecord = createBackup(workspace, other);
  const stray = path.join(root, "stray.bin");
  fs.writeFileSync(stray, "not a backup");
  fs.writeFileSync(target, "payload-changed");

  assert.throws(() => restoreBackup(workspace, target, { backupPath: stray }), (error) => error.code === "GMF-E-BACKUP-001");
  assert.throws(() => restoreBackup(workspace, target, { backupPath: otherRecord.backupPath }), (error) => error.code === "GMF-E-BACKUP-003");
  assert.equal(fs.readFileSync(target, "utf8"), "payload-changed", "a refused restore writes nothing");

  const restored = restoreBackup(workspace, target, { backupPath: recorded.backupPath });
  assert.equal(restored.restored, true);
  assert.equal(fs.readFileSync(target, "utf8"), fs.readFileSync(recorded.backupPath, "utf8"));
});
