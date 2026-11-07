import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadKnowledge, searchKnowledge } from "../src/core/knowledge.mjs";
import { executeOperation, getHandler, getOperationDescriptor } from "../src/core/operations.mjs";
import { validateKnowledge, validateOperation } from "../src/core/contracts.mjs";
import "../src/operations/knowledge/index.mjs";
import { repoRoot } from "./helpers/paths.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const root = repoRoot;

test("the repository knowledge loads with confidence and sources", () => {
  const entries = loadKnowledge(root);
  assert.ok(entries.length >= 12, `expected at least 12 notes, got ${entries.length}`);
  for (const entry of entries) {
    assert.deepEqual(validateKnowledge(entry), { ok: true, errors: [] }, entry.path);
  }
  const interop = entries.find((entry) => entry.id === "unity.il2cpp.interop");
  assert.ok(interop, "the IL2CPP interop note is missing");
  assert.equal(interop.confidence, "verified");
  assert.ok(interop.sources.length >= 1);
});

test("search returns metadata and confidence, not the body", () => {
  const results = searchKnowledge("il2cpp interop", { root });
  assert.ok(results.length >= 1);
  const entry = results[0];
  assert.equal(entry.id, "unity.il2cpp.interop");
  for (const key of ["id", "title", "summary", "path", "confidence"]) {
    assert.ok(entry[key], `missing ${key}`);
  }
  assert.equal(entry.body, undefined);
  assert.equal(entry.content, undefined);
  assert.equal(entry.path, "knowledge/unity/il2cpp-interop.md");
  assert.ok(!JSON.stringify(results).includes("regenerated on first launch"));
});

test("an anti-cheat query returns the anti-cheat entry", () => {
  const results = searchKnowledge("anti-cheat", { root });
  assert.ok(results.some((entry) => entry.id === "core.anti-cheat"));
  const byTag = searchKnowledge("risk", { root, tag: "anti-cheat" });
  assert.ok(byTag.length >= 1);
  assert.ok(byTag.every((entry) => entry.tags.includes("anti-cheat")));
});

test("an empty query returns no entries", () => {
  assert.deepEqual(searchKnowledge("", { root }), []);
  assert.deepEqual(searchKnowledge("   ", { root }), []);
});

test("engine and tag filters narrow the results", () => {
  const unity = searchKnowledge("loader", { root, engine: "unity" });
  assert.ok(unity.length >= 1);
  assert.ok(unity.every((entry) => entry.engine === "unity"));
  assert.deepEqual(searchKnowledge("loader", { root, engine: "unreal", tag: "no-such-tag" }), []);
});

test("every engine note names an origin in sources", () => {
  const engineNotes = loadKnowledge(root).filter((entry) => /^knowledge\/(unity|unreal)\//.test(entry.path));
  assert.ok(engineNotes.length >= 12);
  for (const entry of engineNotes) {
    assert.ok(entry.sources.length >= 1, `${entry.path} has no sources`);
  }
});

test("known ids are searchable", () => {
  assert.ok(searchKnowledge("DefaultExecuteInGameThreadMethod", { root }).length >= 1);
  assert.ok(searchKnowledge("G1", { root, engine: "unreal" }).length >= 1);
  assert.ok(searchKnowledge("__instance", { root, engine: "unity" }).length >= 1);
});

test("no note contains a host-only term", () => {
  for (const entry of loadKnowledge(root)) {
    assert.equal(/\bumf\b|\/mod-init|\.claude\//.test(entry.body), false, entry.path);
  }
});

test("knowledge.search is registered and returns metadata", async () => {
  assert.ok(getHandler("knowledge.search"), "knowledge.search is not registered");
  const descriptor = getOperationDescriptor("knowledge.search");
  assert.deepEqual(validateOperation(descriptor), { ok: true, errors: [] });
  assert.deepEqual(descriptor.effects, ["read"]);
  assert.deepEqual(descriptor.gates, ["auto"]);

  const result = await executeOperation("knowledge.search", { query: "il2cpp interop" }, { root });
  assert.equal(result.ok, true, result.error?.message);
  assert.ok(result.data.entries.length >= 1);
  assert.ok(result.evidence.length >= 1);
  assert.ok(!JSON.stringify(result.data).includes("regenerated on first launch"));
});

test("two notes with the same name fail to load, naming both files", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const dupRoot = tempDir(t, "gmf-knowledge-dup-");
  const dir = path.join(dupRoot, "knowledge", "core");
  fs.mkdirSync(dir, { recursive: true });
  const note = "---\nname: core.same\ntitle: Same\ndescription: D\nengine: core\ntags: [a]\nconfidence: observed\nsources: [x]\n---\n\nBody.\n";
  fs.writeFileSync(path.join(dir, "one.md"), note);
  fs.writeFileSync(path.join(dir, "two.md"), note);
  assert.throws(() => loadKnowledge(dupRoot), /Duplicate knowledge id core\.same in knowledge\/core\/one\.md and knowledge\/core\/two\.md/);
});
