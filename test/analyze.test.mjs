import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeOperation, getHandler, getOperationDescriptor } from "../src/core/operations.mjs";
import { validateOperation } from "../src/core/contracts.mjs";
import "../src/operations/analyze/index.mjs";
import { repoRoot, fixture as fixturePath } from "./helpers/paths.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const fixtureRoot = fixturePath("analysis");
const profile = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "profile.json"), "utf8"));
const context = { root: fixtureRoot };

const ids = [
  "analyze.entrypoints",
  "analyze.classes",
  "analyze.objects",
  "analyze.references",
  "analyze.assets",
  "analyze.strings",
];

async function analyze(operation, input = {}) {
  const result = await executeOperation(operation, { profile, ...input }, context);
  assert.equal(result.ok, true, result.error?.message);
  return result;
}

test("analyze.classes is registered", () => {
  assert.ok(getHandler("analyze.classes"), "analyze.classes is not registered");
});

test("the six analysis operations have valid read-only descriptors", () => {
  for (const id of ids) {
    const descriptor = getOperationDescriptor(id);
    assert.ok(descriptor, `${id} has no descriptor`);
    assert.deepEqual(validateOperation(descriptor), { ok: true, errors: [] });
    assert.deepEqual(descriptor.effects, ["read"]);
    assert.deepEqual(descriptor.gates, ["auto"]);
    assert.equal(descriptor.engine, "core");
    assert.deepEqual(descriptor.inputs.required, ["profile"]);
    assert.equal(descriptor.outputs.properties.results.type, "array");
  }
});

test("a fixture object dump yields classes, objects and references", async () => {
  const classes = await analyze("analyze.classes");
  assert.equal(classes.data.results.length, 3);
  assert.ok(!classes.data.results.some((entry) => entry.name === "WrongEngineFixtureClass"));

  const actor = classes.data.results.find((entry) => entry.name === "AFixtureGameMode");
  assert.ok(actor);
  assert.equal(actor.namespace, "Gmf.Fixture");
  assert.deepEqual(actor.methods, ["BeginPlay", "Tick"]);
  assert.equal(typeof actor.source, "string");
  assert.ok(path.isAbsolute(actor.source));
  assert.match(actor.source, /object-dump\.json$/);
  assert.equal(actor.evidence.confidence, "observed");
  assert.equal(actor.evidence.authority, "shipped-artifact");
  assert.equal(actor.evidence.source, actor.source);
  assert.ok(classes.evidence.length >= 1);
  assert.ok(classes.evidence.every((record) => record.source.endsWith(".json")));

  const objects = await analyze("analyze.objects");
  assert.equal(objects.data.results.length, 2);
  const object = objects.data.results.find((entry) => entry.name === "AFixtureGameMode_C_0");
  assert.ok(object);
  assert.equal(object.class, "AFixtureGameMode");
  assert.ok(object.evidence);

  const references = await analyze("analyze.references");
  assert.equal(references.data.results.length, 2);
  assert.ok(
    references.data.results.some(
      (entry) => entry.from === "AFixtureGameMode::BeginPlay" && entry.to === "UFictionSubsystem::Initialize",
    ),
  );
});

test("an empty query returns every entry", async () => {
  const expectations = {
    "analyze.entrypoints": 2,
    "analyze.classes": 3,
    "analyze.objects": 2,
    "analyze.references": 2,
    "analyze.assets": 2,
    "analyze.strings": 2,
  };
  for (const [id, count] of Object.entries(expectations)) {
    const absent = await analyze(id);
    const empty = await analyze(id, { query: "" });
    const blank = await analyze(id, { query: "   " });
    assert.equal(absent.data.results.length, count, `${id} without a query`);
    assert.equal(empty.data.results.length, count, `${id} with an empty query`);
    assert.equal(blank.data.results.length, count, `${id} with a blank query`);
  }
});

test("a query narrows results and an unknown class returns an empty list", async () => {
  const filtered = await analyze("analyze.classes", { query: "UFICTION" });
  assert.equal(filtered.data.results.length, 1);
  assert.equal(filtered.data.results[0].name, "UFictionSubsystem");

  const unknown = await analyze("analyze.classes", { query: "UNoSuchClass" });
  assert.deepEqual(unknown.data.results, []);

  const objectByClass = await analyze("analyze.objects", { query: "gamemode_c" });
  assert.equal(objectByClass.data.results.length, 1);
});

test("entrypoints, assets and strings read from the same dump", async () => {
  const entrypoints = await analyze("analyze.entrypoints", { query: "beginplay" });
  assert.equal(entrypoints.data.results.length, 1);
  assert.equal(entrypoints.data.results[0].kind, "method");

  const assets = await analyze("analyze.assets", { query: "FixtureMap" });
  assert.equal(assets.data.results.length, 1);
  assert.equal(assets.data.results[0].type, "Map");

  const strings = await analyze("analyze.strings", { query: "ENTRYPOINT" });
  assert.equal(strings.data.results.length, 1);
  assert.equal(strings.data.results[0].value, "GMF_SYNTHETIC_ENTRYPOINT_MARKER");
  assert.equal(strings.data.results[0].offset, 4096);
});

test("no decompiled content is returned", async () => {
  for (const id of ids) {
    const result = await analyze(id);
    const serialized = JSON.stringify(result.data.results);
    assert.ok(!serialized.includes("SYNTHETIC_DECOMPILED_BODY"), `${id} leaked a body`);
    for (const entry of result.data.results) {
      assert.equal(entry.body, undefined);
      assert.equal(entry.content, undefined);
      assert.ok(entry.source);
      assert.ok(entry.evidence);
    }
  }
});

test("a profile path is accepted", async () => {
  const profilePath = path.join(fixtureRoot, "profile.json");
  const result = await executeOperation("analyze.classes", { profile: profilePath }, context);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.data.results.length, 3);
});

test("a missing dump directory returns a remediated error", async (t) => {
  const emptyRoot = tempDir(t, "gmf-analyze-");
  const noDumpProfile = { ...profile, paths: { ...profile.paths, dumps: null } };
  const result = await executeOperation(
    "analyze.classes",
    { profile: noDumpProfile },
    { workspace: { root: emptyRoot } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GMF-E-EXEC-001");
  assert.match(result.error.message, /dump/i);
  assert.match(result.error.remediation, /decompile|dump/i);
});

test("a relative profile path resolves in the workspace, not the framework root", async (t) => {
  const workspaceRoot = tempDir(t, "gmf-analyze-ws-");
  fs.mkdirSync(path.join(workspaceRoot, "dumps"));
  fs.copyFileSync(path.join(fixtureRoot, "dump-data", "object-dump.json"), path.join(workspaceRoot, "dumps", "object-dump.json"));
  fs.writeFileSync(path.join(workspaceRoot, "gmf.profile.json"), JSON.stringify({ ...profile, paths: {} }));
  const result = await executeOperation(
    "analyze.classes",
    { profile: "gmf.profile.json" },
    { root: repoRoot, workspace: { root: workspaceRoot } },
  );
  assert.equal(result.ok, true, result.error?.message);
  assert.ok(result.data.results.length >= 1);
});

test("analyze.classes matches method and field names and reports which member matched", async () => {
  const byMethod = await analyze("analyze.classes", { query: "Tick" });
  const gameMode = byMethod.data.results.find((entry) => entry.name === "AFixtureGameMode");
  assert.ok(gameMode, "a method name finds its class");
  assert.deepEqual(gameMode.matches, ["method:Tick"]);
  const byField = await analyze("analyze.classes", { query: "health" });
  const viaField = byField.data.results.find((entry) => entry.name === "AFixtureGameMode");
  assert.ok(viaField, "a field name finds its class, case-insensitively");
  assert.deepEqual(viaField.matches, ["field:Health"]);
  const byName = await analyze("analyze.classes", { query: "AFixtureGameMode" });
  assert.deepEqual(byName.data.results.find((entry) => entry.name === "AFixtureGameMode").matches, ["name"]);
});

test("analyze operations ignore collected runs under dumps/unreal/runs", async (t) => {
  const workspaceRoot = tempDir(t, "gmf-analyze-runs-");
  const dumps = path.join(workspaceRoot, "dumps");
  fs.mkdirSync(path.join(dumps, "unreal", "runs", "r1", "Reflection"), { recursive: true });
  fs.writeFileSync(path.join(dumps, "unreal-objects.json"), JSON.stringify({ version: 1, engine: "unreal", classes: [{ name: "Kept" }] }));
  fs.writeFileSync(path.join(dumps, "unreal", "runs", "r1", "Reflection", "classes.json"), JSON.stringify({ version: 1, engine: "unreal", classes: [{ name: "OnlyInRun" }] }));
  fs.writeFileSync(path.join(dumps, "unreal", "runs", "r1", "Reflection", "broken.json"), "{ not json");
  const context = { root: repoRoot, workspace: { root: workspaceRoot } };
  const profile = { engine: { id: "unreal" }, paths: {} };
  const missing = await executeOperation("analyze.classes", { profile, query: "OnlyInRun" }, context);
  assert.equal(missing.ok, true, missing.error?.message);
  assert.deepEqual(missing.data.results, []);
  assert.deepEqual(missing.data.skipped ?? [], [], "run files are not listed as skipped");
  const kept = await executeOperation("analyze.classes", { profile, query: "Kept" }, context);
  assert.deepEqual(kept.data.results.map((entry) => entry.name), ["Kept"]);
});

test("a dump file that cannot be read is reported as skipped", async (t) => {
  const dumps = tempDir(t, "gmf-analyze-skipped-");
  fs.writeFileSync(path.join(dumps, "good.json"), JSON.stringify({ version: 1, engine: "unity", classes: [{ name: "Kept" }] }));
  fs.writeFileSync(path.join(dumps, "broken.json"), "{ not json");
  const result = await executeOperation(
    "analyze.classes",
    { profile: { engine: { id: "unity" }, paths: { dumps } } },
    { root: dumps },
  );
  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual(result.data.results.map((entry) => entry.name), ["Kept"]);
  assert.deepEqual(result.data.skipped, [path.join(dumps, "broken.json")]);
});
