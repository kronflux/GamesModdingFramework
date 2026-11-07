import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { draftPlan, validatePlan, applyPlan } from "../src/core/plan.mjs";
import { gateFor, validateOperation } from "../src/core/contracts.mjs";
import { registerOperation, executeOperation, getHandler, getOperationDescriptor } from "../src/core/operations.mjs";
import { initWorkspace, readWorkspace } from "../src/core/workspace.mjs";
import "../src/operations/plan/index.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmf-plan-"));
const game = path.join(root, "game");
const ws = path.join(root, "workspace");
fs.mkdirSync(game, { recursive: true });
fs.writeFileSync(path.join(game, "Game.exe"), "synthetic");
initWorkspace({ gameDir: game, workspaceDir: ws, author: "Tester" });
const workspace = readWorkspace(ws);

after(() => fs.rmSync(root, { recursive: true, force: true }));

const calls = [];

function registerFake(id, effects, handler, requires = []) {
  const operation = {
    id,
    title: id,
    summary: `${id} test operation`,
    engine: "test",
    inputs: { type: "object", properties: {}, required: [] },
    outputs: { type: "object", properties: {} },
    effects,
    requires,
    gates: [gateFor(effects)],
    skill: "gmf-implement",
    docs: [],
  };
  registerOperation(operation, handler);
  return operation;
}

const autoOperation = registerFake("test.auto", ["read"], async () => {
  calls.push("auto");
  return { data: { ran: true } };
});
const boomOperation = registerFake("test.boom", ["read"], async () => {
  calls.push("boom");
  throw new Error("boom");
});
const softOperation = registerFake("test.soft", ["gameWrite", "workspaceWrite"], async () => {
  calls.push("soft");
  return { data: { written: true } };
});

function operationDescriptor(id, effects, required = [], requires = []) {
  return {
    id,
    title: id,
    summary: `${id} operation`,
    engine: "core",
    inputs: {
      type: "object",
      properties: Object.fromEntries(required.map((key) => [key, { type: "string" }])),
      required,
    },
    outputs: { type: "object", properties: {} },
    effects,
    requires,
    gates: [gateFor(effects)],
    skill: "gmf-implement",
    docs: [],
  };
}

const draftCatalog = {
  version: 1,
  operations: [
    operationDescriptor("unity.decompile", ["read", "workspaceWrite"], ["gameDir", "backend"], ["fake-decompiler"]),
    operationDescriptor("unity.scaffold", ["workspaceWrite"], ["name", "author", "loader", "backend"]),
    operationDescriptor("unity.build", ["read", "workspaceWrite"], ["modDir"], ["dotnet"]),
    operationDescriptor("unity.deploy", ["gameWrite", "workspaceWrite"], ["modDir", "gameDir"]),
    operationDescriptor("unity.validate", ["read"], ["modDir", "gameDir"]),
    operationDescriptor("unity.package", ["workspaceWrite"], ["modDir"]),
    operationDescriptor("tool.install", ["toolInstall", "network"], ["id"]),
  ],
};

const profile = {
  version: 1,
  game: {
    name: "Fixture Game",
    installDir: game,
    executable: path.join(game, "Game.exe"),
    sha256: null,
    product: null,
    company: null,
    store: { id: "manual", appId: null },
  },
  engine: { id: "unity", version: "2021.3.45f1", confidence: "observed", selected: true, alternatives: [] },
  runtime: { backend: "mono", architecture: "x86_64" },
  loader: { id: "bepinex5", installed: true, version: "5.4.23", path: path.join(game, "BepInEx"), notes: [] },
  tools: [],
  capabilities: [],
  markers: { antiCheat: [], online: false, launcher: null },
  paths: { data: null, managed: null, interop: null, deploy: null, content: null, binaries: null },
  unknowns: [],
  evidence: [],
};

function step(id, operation, effects, gate, inputs = {}) {
  return { id, operation, inputs, why: "test", effects, gate, expect: "test", verify: "test" };
}

test("a draft plan lists steps, the missing tools and the anti-cheat risk", () => {
  const markedProfile = {
    ...profile,
    markers: { antiCheat: [{ id: "easyanticheat", name: "Easy Anti-Cheat", path: path.join(game, "EasyAntiCheat") }], online: false, launcher: null },
  };
  const plan = draftPlan({ goal: "Add a training menu", profile: markedProfile, catalog: draftCatalog });

  assert.equal(plan.version, 1);
  assert.equal(plan.goal, "Add a training menu");
  assert.equal(plan.profile, "gmf.profile.json");
  assert.deepEqual(plan.authorizations, []);

  const deployed = plan.steps.find((entry) => entry.operation === "unity.deploy");
  assert.ok(deployed, "the draft has no deploy step");
  assert.equal(deployed.gate, "soft");
  assert.ok(deployed.effects.includes("gameWrite"));

  const installs = plan.steps.filter((entry) => entry.operation === "tool.install");
  assert.deepEqual(
    installs.map((entry) => entry.inputs.id),
    ["fake-decompiler", "dotnet"],
  );
  assert.ok(installs.every((entry) => entry.gate === "soft"));

  const decompileIndex = plan.steps.findIndex((entry) => entry.operation === "unity.decompile");
  const decompilerInstallIndex = plan.steps.findIndex(
    (entry) => entry.operation === "tool.install" && entry.inputs.id === "fake-decompiler",
  );
  assert.ok(decompilerInstallIndex >= 0 && decompilerInstallIndex < decompileIndex);

  assert.ok(plan.missingTools.some((entry) => entry.tool === "fake-decompiler" && entry.installStep));
  assert.ok(plan.missingTools.some((entry) => entry.tool === "dotnet" && entry.installStep));
  assert.equal(plan.risks[0].code, "GMF-W-ANTICHEAT-001");
  assert.deepEqual(plan.risks[0].markers, ["easyanticheat"]);
});

test("validation reports every problem, not only the first", () => {
  const invalid = {
    version: 1,
    goal: "broken plan",
    profile: "gmf.profile.json",
    steps: [
      step("1", "unity.missing", ["read"], "auto"),
      step("2", "unity.deploy", ["gameWrite", "workspaceWrite"], "soft"),
      step("3", "unity.build", ["read", "workspaceWrite", "credentials"], "hard", { modDir: "mods/X" }),
    ],
    authorizations: [],
  };

  const result = validatePlan(invalid, draftCatalog, { profile });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 5, JSON.stringify(result.errors));
  assert.ok(result.errors.some((error) => error.includes("unknown operation") && error.includes("unity.missing")));
  assert.ok(result.errors.some((error) => error.includes("missing required input") && error.includes("modDir")));
  assert.ok(result.errors.some((error) => error.includes("gameWrite") && error.includes("authorization")));
  assert.ok(result.errors.some((error) => error.includes("credentials") && error.includes("GMF-E-POLICY-001")));
  assert.ok(result.errors.some((error) => error.includes("required tool dotnet") && error.includes("GMF-E-TOOL-001")));
});

test("a plan cannot authorize a destructive effect with a model source", () => {
  const destroyOperation = operationDescriptor("test.destroy", ["destructive"]);
  const hardPlan = {
    version: 1,
    goal: "delete",
    profile: "gmf.profile.json",
    steps: [step("1", "test.destroy", ["destructive"], "hard")],
    authorizations: [{ effect: "destructive", source: "model: the user probably wants this" }],
  };
  const result = validatePlan(hardPlan, { version: 1, operations: [destroyOperation] });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) => error.includes("destructive") && error.includes("cannot be authorized by a plan")),
    JSON.stringify(result.errors),
  );

  const userPlan = { ...hardPlan, authorizations: [{ effect: "destructive", source: "user: yes, delete it" }] };
  const userResult = validatePlan(userPlan, { version: 1, operations: [destroyOperation] });
  assert.equal(userResult.ok, false, "a user-sourced plan entry does not authorize a destructive effect either");
  assert.ok(userResult.errors.some((error) => error.includes("destructive requires explicit user approval")), JSON.stringify(userResult.errors));
});

test("a drafted plan without authorizations reports the soft gates", () => {
  const plan = draftPlan({ goal: "Add a menu", profile, catalog: draftCatalog });
  const result = validatePlan(plan, draftCatalog, { profile });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("toolInstall") && error.includes("authorization")));
  assert.ok(result.errors.some((error) => error.includes("gameWrite") && error.includes("authorization")));
});

test("apply stops at the first failure unless the step is optional", async () => {
  const catalog = { version: 1, operations: [autoOperation, boomOperation] };
  const plan = {
    version: 1,
    goal: "run",
    profile: "gmf.profile.json",
    steps: [step("1", "test.auto", ["read"], "auto"), step("2", "test.boom", ["read"], "auto"), step("3", "test.auto", ["read"], "auto")],
    authorizations: [],
  };

  calls.length = 0;
  const result = await applyPlan(plan, { catalog, workspace, profile });
  assert.equal(result.ok, false);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[1].ok, false);
  assert.deepEqual(calls, ["auto", "boom"]);
  assert.match(result.error.message, /boom/);

  calls.length = 0;
  const optionalPlan = {
    ...plan,
    steps: [plan.steps[0], { ...plan.steps[1], optional: true }, plan.steps[2]],
  };
  const optionalResult = await applyPlan(optionalPlan, { catalog, workspace, profile });
  assert.equal(optionalResult.ok, true);
  assert.equal(optionalResult.results.length, 3);
  assert.equal(optionalResult.results[1].ok, false);
  assert.deepEqual(calls, ["auto", "boom", "auto"]);
});

test("a soft-gated step is refused without an authorization and runs with one", async () => {
  const catalog = { version: 1, operations: [softOperation] };
  const plan = {
    version: 1,
    goal: "deploy",
    profile: "gmf.profile.json",
    steps: [step("1", "test.soft", ["gameWrite", "workspaceWrite"], "soft")],
    authorizations: [],
  };

  calls.length = 0;
  const refused = await applyPlan(plan, { catalog, workspace, profile });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "GMF-E-GATE-001");
  assert.deepEqual(calls, []);

  const authorized = { ...plan, authorizations: [{ effect: "gameWrite", source: "user: deploy the mod" }] };
  const result = await applyPlan(authorized, { catalog, workspace, profile });
  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual(calls, ["soft"]);
  assert.equal(result.results[0].authorizationSource, "user: deploy the mod");

  const planFile = JSON.parse(fs.readFileSync(path.join(ws, "gmf.plan.json"), "utf8"));
  const lastRun = planFile.runs.at(-1);
  assert.equal(lastRun.step, "1");
  assert.equal(lastRun.operation, "test.soft");
  assert.equal(lastRun.authorizationSource, "user: deploy the mod");
  assert.equal(lastRun.ok, true);
});

test("an anti-cheat marker on a game write records a warning and proceeds", async () => {
  const markedProfile = {
    ...profile,
    markers: { antiCheat: [{ id: "easyanticheat", name: "Easy Anti-Cheat", path: path.join(game, "EasyAntiCheat") }], online: false, launcher: null },
  };
  const catalog = { version: 1, operations: [softOperation] };
  const plan = {
    version: 1,
    goal: "deploy",
    profile: "gmf.profile.json",
    steps: [step("1", "test.soft", ["gameWrite", "workspaceWrite"], "soft")],
    authorizations: [{ effect: "gameWrite", source: "user: deploy the mod" }],
  };

  calls.length = 0;
  const result = await applyPlan(plan, { catalog, workspace, profile: markedProfile });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.results[0].warnings[0].code, "GMF-W-ANTICHEAT-001");
  assert.deepEqual(calls, ["soft"]);

  const planFile = JSON.parse(fs.readFileSync(path.join(ws, "gmf.plan.json"), "utf8"));
  assert.ok(
    planFile.authorizations.some(
      (entry) => entry.effect === "antiCheat" && entry.warning === "GMF-W-ANTICHEAT-001",
    ),
  );
});

test("plan.draft, plan.validate and plan.apply are registered operations", async () => {
  for (const id of ["plan.draft", "plan.validate", "plan.apply"]) {
    assert.ok(getHandler(id), `${id} is not registered`);
    assert.deepEqual(validateOperation(getOperationDescriptor(id)), { ok: true, errors: [] }, id);
  }

  const drafted = await executeOperation("plan.draft", { goal: "Add a menu", profile }, { catalog: draftCatalog });
  assert.equal(drafted.ok, true, drafted.error?.message);
  assert.ok(drafted.data.plan.steps.length > 0);

  const valid = {
    version: 1,
    goal: "run",
    profile: "gmf.profile.json",
    steps: [step("1", "test.auto", ["read"], "auto")],
    authorizations: [],
  };
  const catalog = { version: 1, operations: [autoOperation] };
  const validated = await executeOperation("plan.validate", { plan: valid }, { catalog });
  assert.equal(validated.ok, true, validated.error?.message);

  const invalid = { ...valid, steps: [{ ...valid.steps[0], operation: "test.missing" }] };
  const rejected = await executeOperation("plan.validate", { plan: invalid }, { catalog });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "GMF-E-PLAN-001");
  assert.match(rejected.error.message, /unknown operation/);

  calls.length = 0;
  const applied = await executeOperation("plan.apply", { plan: valid, authorizations: [] }, { catalog, workspace, profile });
  assert.equal(applied.ok, true, applied.error?.message);
  assert.equal(applied.data.ok, true);
  assert.deepEqual(calls, ["auto"]);
});

test("an optional game-write step whose backup fails is skipped and its operation never runs", async () => {
  const brokenRoot = path.join(root, "ws-broken-backups");
  fs.mkdirSync(brokenRoot, { recursive: true });
  fs.writeFileSync(path.join(brokenRoot, "gmf.json"), JSON.stringify({ version: 1, game: {} }));
  fs.writeFileSync(path.join(brokenRoot, "backups"), "a file where the backups folder should be");
  const brokenWorkspace = readWorkspace(brokenRoot);
  const target = path.join(game, "Game.exe");
  const catalog = { version: 1, operations: [autoOperation, softOperation] };
  const plan = {
    version: 1,
    goal: "write",
    profile: "gmf.profile.json",
    steps: [
      { ...step("1", "test.soft", ["gameWrite", "workspaceWrite"], "soft"), inputs: { gamePath: target }, optional: true },
      step("2", "test.auto", ["read"], "auto"),
    ],
    authorizations: [{ effect: "gameWrite", source: "user: write it" }],
  };
  calls.length = 0;
  const result = await applyPlan(plan, { catalog, workspace: brokenWorkspace, profile });
  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual(calls, ["auto"], "the game write did not run without its backup");
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].ok, false);
  assert.match(result.results[0].error.message, /cannot be backed up/);
  assert.equal(result.results[1].ok, true);
});

test("plan.apply accepts authorizations passed through the context flags, as the CLI and MCP server pass them", async () => {
  const catalog = { version: 1, operations: [softOperation] };
  const plan = {
    version: 1,
    goal: "deploy via flags",
    profile: "gmf.profile.json",
    steps: [step("1", "test.soft", ["gameWrite", "workspaceWrite"], "soft")],
    authorizations: [],
  };
  calls.length = 0;
  const refused = await executeOperation("plan.apply", { plan }, { catalog, workspace, profile });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "GMF-E-GATE-001");
  assert.deepEqual(calls, []);
  const applied = await executeOperation("plan.apply", { plan }, { catalog, workspace, profile, flags: { authorized: "gameWrite", source: "user: deploy it" } });
  assert.equal(applied.ok, true, applied.error?.message);
  assert.deepEqual(calls, ["soft"]);
  assert.equal(applied.data.results[0].authorizationSource, "user: deploy it");
});
