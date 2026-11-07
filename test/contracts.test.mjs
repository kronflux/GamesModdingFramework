import test from "node:test";
import assert from "node:assert/strict";
import { gateFor, validateOperation, validatePlan, validateProfile } from "../src/core/contracts.mjs";

const op = {
  id: "dummy.ping",
  title: "Ping",
  summary: "Return pong.",
  engine: "dummy",
  inputs: { type: "object", properties: {}, required: [] },
  outputs: { type: "object", properties: { pong: { type: "boolean" } } },
  effects: ["read"],
  requires: [],
  gates: ["auto"],
  skill: "gmf-investigate",
  docs: [],
};

test("gateFor maps effects to the highest gate", () => {
  assert.equal(gateFor(["read"]), "auto");
  assert.equal(gateFor(["workspaceWrite"]), "auto");
  assert.equal(gateFor(["gameWrite"]), "soft");
  assert.equal(gateFor(["antiCheat"]), "soft");
  assert.equal(gateFor(["read", "credentials"]), "hard");
});

test("gateFor treats no effects and unknown effects as automatic, and a hard effect outranks a soft one", () => {
  assert.equal(gateFor([]), "auto");
  assert.equal(gateFor(), "auto");
  assert.equal(gateFor(["not-an-effect"]), "auto");
  assert.equal(gateFor("gameWrite"), "auto");
  assert.equal(gateFor(["gameWrite", "credentials"]), "hard");
  assert.equal(gateFor(["destructive", "gameWrite"]), "hard");
  assert.equal(gateFor(["piracy"]), "hard");
});

test("validateOperation accepts a complete descriptor", () => {
  assert.deepEqual(validateOperation(op), { ok: true, errors: [] });
});

test("validateOperation rejects a missing effect and a wrong gate", () => {
  const bad = { ...op, effects: [], gates: ["soft"] };
  const result = validateOperation(bad);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ["effects must be a non-empty array", "gates must include auto for the declared effects"]);
});

test("validateOperation requires the gate that matches the declared effects", () => {
  const soft = validateOperation({ ...op, effects: ["gameWrite"], gates: ["auto"] });
  assert.equal(soft.ok, false);
  assert.deepEqual(soft.errors, ["gates must include soft for the declared effects"]);
  const hard = validateOperation({ ...op, effects: ["read", "credentials"], gates: ["soft"] });
  assert.deepEqual(hard.errors, ["gates must include hard for the declared effects"]);
  const unknownGate = validateOperation({ ...op, gates: ["auto", "sometimes"] });
  assert.deepEqual(unknownGate.errors, ["unknown gate: sometimes"]);
  const noGates = validateOperation({ ...op, gates: [] });
  assert.deepEqual(noGates.errors, ["gates must be a non-empty array"]);
});

test("validatePlan rejects an unknown gate", () => {
  const plan = {
    version: 1,
    goal: "test",
    profile: "gmf.profile.json",
    steps: [{ id: "1", operation: "dummy.ping", inputs: {}, why: "test", effects: ["read"], gate: "auto", expect: "pong", verify: "test" }],
    authorizations: [],
  };
  assert.equal(validatePlan(plan).ok, true);
  plan.steps[0].gate = "sometimes";
  assert.equal(validatePlan(plan).ok, false);
});

test("validateProfile accepts a minimal profile", () => {
  const profile = {
    version: 1,
    game: { name: "Game", installDir: "C:/game", executable: null, sha256: null, product: null, company: null, store: { id: "manual", appId: null } },
    engine: { id: "unknown", version: null, confidence: "unknown", selected: false, alternatives: [] },
    runtime: { backend: "unknown", architecture: "unknown" },
    loader: { id: "none", installed: false, version: null, path: null, notes: [] },
    tools: [],
    capabilities: [],
    markers: { antiCheat: [], online: false, launcher: null },
    paths: { data: null, managed: null, interop: null, deploy: null, content: null, binaries: null },
    unknowns: [],
    evidence: [],
  };
  assert.equal(validateProfile(profile).ok, true);

  assert.deepEqual(validateProfile(null), { ok: false, errors: ["profile must be an object"] });
  assert.deepEqual(validateProfile({ ...profile, version: 2 }).errors, ["version must be 1"]);
  assert.deepEqual(validateProfile({ ...profile, tools: {} }).errors, ["tools must be an array"]);
  assert.deepEqual(validateProfile({ ...profile, markers: null }).errors, ["markers must be an object"]);
  assert.deepEqual(validateProfile({ ...profile, engine: { ...profile.engine, id: "" } }).errors, ["engine.id must be a non-empty string"]);
  assert.deepEqual(validateProfile({ ...profile, engine: { ...profile.engine, hints: "godot" } }).errors, ["engine.hints must be an array"]);
});

test("TEMPLATE_KINDS and engine hints are part of the contract", async () => {
  const { TEMPLATE_KINDS, validateEngineHint, SKILL_FRONTMATTER } = await import("../src/core/contracts.mjs");
  assert.deepEqual(TEMPLATE_KINDS, ["scaffold", "feature", "helper", "payload"]);
  assert.deepEqual(SKILL_FRONTMATTER, ["name", "description", "operations", "knowledge"]);
  assert.equal(validateEngineHint({ family: "godot", confidence: "observed", evidence: [{ path: "game.pck", claim: "pck" }] }).ok, true);
  assert.equal(validateEngineHint({ family: "", confidence: "observed", evidence: [] }).ok, false);
  assert.equal(validateEngineHint({ family: "godot", confidence: "guessed", evidence: [] }).ok, false);
});
