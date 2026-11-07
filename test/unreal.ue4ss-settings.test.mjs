import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import unreal from "../src/engines/unreal/index.mjs";
import { executeOperation, registerOperation } from "../src/core/operations.mjs";
import { UE4SS_PROFILES, applyUe4ssProfile } from "../src/engines/unreal/operations/settings.mjs";
import { fixture as fixturePath } from "./helpers/paths.mjs";
import { snapshotTree } from "./helpers/tree.mjs";

for (const operation of unreal.operations) registerOperation(operation, operation.handler);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmf-ue4ss-settings-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function setup(name) {
  const gameDir = path.join(root, name, "game");
  fs.cpSync(fixturePath("unreal", "ue4ss-dumps"), gameDir, { recursive: true });
  const workspace = { root: path.join(root, name, "ws"), config: { version: 1 }, local: { version: 1 }, profile: null };
  fs.mkdirSync(workspace.root, { recursive: true });
  const ini = path.join(gameDir, "ue4ss", "UE4SS-settings.ini");
  return { gameDir, workspace, ini };
}

test("the development profile turns on the three UE4SS debug console keys and release turns them off", () => {
  assert.deepEqual(UE4SS_PROFILES.development.Debug, { ConsoleEnabled: 1, GuiConsoleEnabled: 1, GuiConsoleVisible: 1 });
  assert.deepEqual(UE4SS_PROFILES.release.Debug, { ConsoleEnabled: 0, GuiConsoleEnabled: 0, GuiConsoleVisible: 0 });
});

test("inherited object keys are not profiles", async () => {
  const { gameDir, workspace, ini } = setup("inherited");
  const before = fs.readFileSync(ini, "utf8");
  const context = { workspace, authorizations: [{ effect: "gameWrite", source: "test: inherited profile" }] };
  for (const profile of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const result = await executeOperation("unreal.ue4ss_settings", { gameDir, profile }, context);
    assert.equal(result.ok, false, profile);
    assert.equal(result.error.code, "GMF-E-PLAN-001", profile);
    assert.throws(() => applyUe4ssProfile(context, path.dirname(ini), profile), /Unknown UE4SS settings profile/, profile);
  }
  assert.equal(fs.readFileSync(ini, "utf8"), before);
});

test("unreal.ue4ss_settings refuses without a gameWrite authorization and changes nothing", async () => {
  const { gameDir, workspace, ini } = setup("refused");
  const before = fs.readFileSync(ini, "utf8");
  const result = await executeOperation("unreal.ue4ss_settings", { gameDir, profile: "development" }, { workspace });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GMF-E-GATE-001");
  assert.equal(fs.readFileSync(ini, "utf8"), before);
});

test("unreal.ue4ss_settings applies a profile, keeps unrelated keys and backs up the ini", async () => {
  const { gameDir, workspace, ini } = setup("applied");
  const context = { workspace, authorizations: [{ effect: "gameWrite", source: "test: development console" }] };
  const result = await executeOperation("unreal.ue4ss_settings", { gameDir, profile: "development" }, context);
  assert.equal(result.ok, true, result.error?.message);
  const text = fs.readFileSync(ini, "utf8");
  assert.match(text, /^\[Debug\]$/m);
  assert.match(text, /^ConsoleEnabled = 1$/m);
  assert.match(text, /^GuiConsoleEnabled = 1$/m);
  assert.match(text, /^GuiConsoleVisible = 1$/m);
  assert.match(text, /bUseUObjectArrayCache = 1/, "unrelated keys stay");
  assert.ok(result.data.backup && fs.existsSync(result.data.backup), "the original ini is backed up");
  assert.equal(result.data.profile, "development");

  const release = await executeOperation("unreal.ue4ss_settings", { gameDir, profile: "release" }, context);
  assert.equal(release.ok, true);
  const releaseText = fs.readFileSync(ini, "utf8");
  assert.match(releaseText, /^ConsoleEnabled = 0$/m);
  assert.match(releaseText, /^GuiConsoleEnabled = 0$/m);
  assert.match(releaseText, /^GuiConsoleVisible = 0$/m);

  const unknown = await executeOperation("unreal.ue4ss_settings", { gameDir, profile: "loud" }, context);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "GMF-E-PLAN-001");
  assert.equal(fs.readFileSync(ini, "utf8"), releaseText, "an unknown profile leaves the ini unchanged");
});

test("unreal.ue4ss_settings refuses a toolInstall-only authorization and leaves the ini alone", async () => {
  const { gameDir, workspace, ini } = setup("install-only");
  const before = { ini: fs.readFileSync(ini, "utf8"), workspace: snapshotTree(workspace.root) };
  const context = { workspace, authorizations: [{ effect: "toolInstall", source: "test: install only" }] };
  const result = await executeOperation("unreal.ue4ss_settings", { gameDir, profile: "development" }, context);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GMF-E-GATE-001");
  assert.equal(fs.readFileSync(ini, "utf8"), before.ini);
  assert.deepEqual(snapshotTree(workspace.root), before.workspace, "no backup is written");
});

test("a comma-separated --authorized list satisfies each effect it names", async () => {
  const { gameDir, workspace, ini } = setup("comma");
  const context = { workspace, flags: { authorized: "toolInstall,gameWrite", source: "test: both effects" } };
  const result = await executeOperation("unreal.ue4ss_settings", { gameDir, profile: "development" }, context);
  assert.equal(result.ok, true, result.error?.message);
  const text = fs.readFileSync(ini, "utf8");
  assert.match(text, /^ConsoleEnabled = 1$/m);
  assert.match(text, /^GuiConsoleEnabled = 1$/m);
  assert.match(text, /^GuiConsoleVisible = 1$/m);
});
