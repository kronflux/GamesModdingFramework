import test from "node:test";
import assert from "node:assert/strict";
import { evidence, unknown, mergeEvidence } from "../src/core/evidence.mjs";

test("evidence returns a stable record", () => {
  const record = evidence({
    claim: "engine is unity",
    confidence: "observed",
    authority: "shipped-artifact",
    source: "Game_Data",
    detail: { file: "globalgamemanagers" },
  });
  assert.match(record.id, /^ev_[a-f0-9]+$/);
  assert.equal(record.claim, "engine is unity");
  assert.equal(record.confidence, "observed");
  assert.equal(record.authority, "shipped-artifact");
  assert.equal(record.source, "Game_Data");
  assert.deepEqual(record.detail, { file: "globalgamemanagers" });
  const again = evidence({
    claim: "engine is unity",
    confidence: "observed",
    authority: "shipped-artifact",
    source: "Game_Data",
    detail: { file: "globalgamemanagers" },
  });
  assert.deepEqual(again, record, "the same inputs give the same record and id");
  const other = evidence({ claim: "engine is unity", confidence: "observed", authority: "shipped-artifact", source: "Game_Data", detail: { file: "level0" } });
  assert.notEqual(other.id, record.id, "a different detail gives a different id");
  assert.deepEqual(evidence({ claim: "c", confidence: "derived", authority: "external", source: "s" }).detail, {});
  assert.throws(
    () => evidence({ claim: "x", confidence: "certain", authority: "shipped-artifact", source: "x" }),
    /confidence/,
  );
});

test("unknown records carry severity and a next probe", () => {
  const record = unknown({ question: "UE version", severity: "medium", nextProbe: "run the game once" });
  assert.match(record.id, /^unk_[a-f0-9]+$/);
  assert.equal(record.severity, "medium");
  assert.throws(() => unknown({ question: "x", severity: "urgent", nextProbe: "y" }), /severity/);
});

test("mergeEvidence de-duplicates by id", () => {
  const one = evidence({ claim: "a", confidence: "observed", authority: "shipped-artifact", source: "s" });
  const two = evidence({ claim: "b", confidence: "inferred", authority: "analyst-inference", source: "s" });
  const copy = evidence({ claim: "a", confidence: "observed", authority: "shipped-artifact", source: "s" });
  assert.notEqual(copy, one);
  assert.deepEqual(mergeEvidence([one], [copy, two]), [one, two], "a separately built equal record is merged away and the order is kept");
  assert.deepEqual(mergeEvidence([], []), []);
});
