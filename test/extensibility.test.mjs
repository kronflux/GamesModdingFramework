import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadEngineModules, detectAll, selectEngine } from "../src/engines/index.mjs";
import { registerOperation, executeOperation } from "../src/core/operations.mjs";
import { repoRoot, fixture as fixturePath } from "./helpers/paths.mjs";

const fixture = fixturePath("dummy-engine");

test("a new engine module is discovered, detected and selected without core edits", async () => {
  const modules = await loadEngineModules(repoRoot, [fixture]);
  const detections = await detectAll("ignored", modules);
  assert.equal(detections.length, 1);
  assert.equal(detections[0].engine.id, "dummy");
  assert.equal(detections[0].error, undefined, "a detection that did not throw carries no error");
  assert.equal(selectEngine(detections).selected.engine.id, "dummy");
});

test("an engine whose detect throws is reported as unknown with the error, and does not hide the others", async () => {
  const modules = await loadEngineModules(repoRoot, [fixture]);
  const broken = { id: "broken", detect: async () => { throw new Error("detect failed"); } };
  const detections = await detectAll("ignored", [broken, ...modules]);
  assert.equal(detections.length, 2);
  assert.deepEqual(detections[0].engine, { id: "broken", version: null, confidence: "unknown", evidence: [] });
  assert.equal(detections[0].error, "detect failed");
  assert.equal(detections[1].engine.id, "dummy");
  assert.equal(selectEngine(detections).selected.engine.id, "dummy");
});

test("the dummy operation is registered and executes", async () => {
  const modules = await loadEngineModules(repoRoot, [fixture]);
  const op = modules[0].operations[0];
  registerOperation(op, op.handler);
  const result = await executeOperation("dummy.ping", {}, {});
  assert.equal(result.ok, true);
  assert.equal(result.data.pong, true);
});

test("an unknown operation returns the plan error code", async () => {
  const result = await executeOperation("dummy.missing", {}, {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GMF-E-PLAN-001");
});
