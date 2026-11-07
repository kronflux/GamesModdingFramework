import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  gateFor,
  resolveAuthorization,
  recordAuthorization,
  assertHardGate,
} from "../src/core/authorization.mjs";
import { initWorkspace, readWorkspace } from "../src/core/workspace.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmf-auth-"));
const game = path.join(root, "game");
const ws = path.join(root, "workspace");
fs.mkdirSync(game, { recursive: true });

after(() => fs.rmSync(root, { recursive: true, force: true }));

test("auto effects run, soft effects need an authorization, hard effects do not", () => {
  assert.equal(resolveAuthorization({ effects: ["read"] }).allowed, true);
  assert.equal(resolveAuthorization({ effects: ["toolInstall"] }).allowed, false);
  assert.equal(
    resolveAuthorization({
      effects: ["toolInstall"],
      plan: { authorizations: [{ effect: "toolInstall", source: "user: install" }] },
    }).allowed,
    true,
  );
  assert.equal(
    resolveAuthorization({
      effects: ["credentials"],
      plan: { authorizations: [{ effect: "credentials", source: "model" }] },
    }).allowed,
    false,
  );
});

test("a hard effect stays refused whatever the source, the plan or the override says", () => {
  for (const effect of ["destructive", "credentials", "piracy"]) {
    const fromPlan = resolveAuthorization({ effects: [effect], plan: { authorizations: [{ effect, source: "user: do it" }] } });
    assert.equal(fromPlan.allowed, false, `${effect} from a user-sourced plan`);
    assert.equal(fromPlan.gate, "hard");
    const fromOverride = resolveAuthorization({ effects: [effect], overrides: [{ effect, source: "user: do it" }] });
    assert.equal(fromOverride.allowed, false, `${effect} from an override`);
    assert.equal(fromOverride.gate, "hard");
  }
});

test("gateFor maps anti-cheat to soft and credentials to hard", () => {
  assert.equal(gateFor(["antiCheat"]), "soft");
  assert.equal(gateFor(["credentials"]), "hard");
});

test("assertHardGate refuses credentials and allows anti-cheat", () => {
  assert.throws(() => assertHardGate("credentials", "model"), /GMF-E-POLICY-001/);
  assert.doesNotThrow(() => assertHardGate("antiCheat", "model"));
});

test("recordAuthorization writes an append-only record", () => {
  initWorkspace({ gameDir: game, workspaceDir: ws, author: "Tester" });
  const workspace = readWorkspace(ws);
  recordAuthorization(workspace, { effect: "toolInstall", source: "test" });
  const file = path.join(ws, "gmf.plan.json");
  assert.ok(fs.existsSync(file));
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(data.authorizations.length, 1);
  assert.equal(data.authorizations[0].effect, "toolInstall");

  recordAuthorization(workspace, { effect: "gameWrite", source: "user: deploy" });
  const appended = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(
    appended.authorizations.map((entry) => `${entry.effect}:${entry.source}`),
    ["toolInstall:test", "gameWrite:user: deploy"],
    "the first record is kept and the second follows it",
  );
  assert.equal(typeof appended.authorizations[1].recordedAt, "string");
});

test("the executor refuses a soft-gated operation without an authorization and never calls its handler", async () => {
  const { registerOperation, executeOperation } = await import("../src/core/operations.mjs");
  let calls = 0;
  const descriptor = {
    id: "test.gated_write",
    title: "Gated write",
    summary: "Test operation with a gameWrite effect.",
    engine: "core",
    inputs: { type: "object", properties: {}, required: [] },
    outputs: { type: "object", properties: {} },
    effects: ["read", "gameWrite"],
    requires: [],
    gates: ["soft"],
    skill: "gmf-safety",
    docs: [],
  };
  registerOperation(descriptor, async () => {
    calls += 1;
    return { data: { wrote: true } };
  });
  const refused = await executeOperation("test.gated_write", {}, {});
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "GMF-E-GATE-001");
  assert.equal(calls, 0);

  const installOnly = await executeOperation("test.gated_write", {}, { authorizations: [{ effect: "toolInstall", source: "user: install" }] });
  assert.equal(installOnly.ok, false, "toolInstall does not cover gameWrite");
  assert.equal(installOnly.error.code, "GMF-E-GATE-001");
  assert.equal(calls, 0);

  const listed = await executeOperation("test.gated_write", {}, { flags: { authorized: "toolInstall,gameWrite", source: "user: go" } });
  assert.equal(listed.ok, true, listed.error?.message);
  assert.equal(listed.data.wrote, true);
  assert.equal(listed.authorization.source, "user: go");

  const planned = await executeOperation("test.gated_write", {}, { plan: { authorizations: [{ effect: "gameWrite", source: "plan step 2" }] } });
  assert.equal(planned.ok, true, planned.error?.message);
  assert.equal(calls, 2);
});

test("authorizationOverrides reads every context form, including comma lists", async () => {
  const { authorizationOverrides } = await import("../src/core/authorization.mjs");
  const overrides = authorizationOverrides({
    authorizations: [{ effect: "gameWrite", source: "a" }],
    overrides: [{ effect: "network", source: "b" }],
    authorization: { effect: "launchGame", source: "c" },
    flags: { authorized: "toolInstall, gameWrite", source: "d" },
  });
  assert.deepEqual(
    overrides.map((entry) => `${entry.effect}:${entry.source}`),
    ["gameWrite:a", "network:b", "launchGame:c", "toolInstall:d", "gameWrite:d"],
  );
  assert.deepEqual(authorizationOverrides({ authorization: { allowed: true, gate: "soft", source: "x" } }), []);
});

test("the executor accepts an authorization recorded in the workspace's active plan", async (t) => {
  const { registerOperation, executeOperation, getHandler } = await import("../src/core/operations.mjs");
  if (!getHandler("test.gated_write2")) {
    registerOperation(
      {
        id: "test.gated_write2",
        title: "Gated write 2",
        summary: "Test operation with a gameWrite effect.",
        engine: "core",
        inputs: { type: "object", properties: {}, required: [] },
        outputs: { type: "object", properties: {} },
        effects: ["gameWrite"],
        requires: [],
        gates: ["soft"],
        skill: "gmf-safety",
        docs: [],
      },
      async () => ({ data: { wrote: true } }),
    );
  }
  const ws = tempDir(t, "gmf-active-plan-");
  const workspace = { root: ws };
  assert.equal((await executeOperation("test.gated_write2", {}, { workspace })).ok, false);
  fs.writeFileSync(path.join(ws, "gmf.plan.json"), JSON.stringify({ authorizations: [{ effect: "gameWrite", source: "plan: user said deploy" }] }));
  const allowed = await executeOperation("test.gated_write2", {}, { workspace });
  assert.equal(allowed.ok, true, allowed.error?.message);
  assert.equal(allowed.authorization.source, "plan: user said deploy");
});

test("recordAuthorization refuses to replace a corrupt plan file", (t) => {
  const broken = tempDir(t, "gmf-auth-broken-");
  fs.writeFileSync(path.join(broken, "gmf.json"), '{"version":1,"game":{}}');
  const planPath = path.join(broken, "gmf.plan.json");
  fs.writeFileSync(planPath, "{ not json");
  assert.throws(() => recordAuthorization({ root: broken }, { effect: "gameWrite", source: "user" }), (error) => error.code === "GMF-E-FILE-002");
  assert.equal(fs.readFileSync(planPath, "utf8"), "{ not json");
});

test("every soft effect needs its own authorization; toolInstall covers network", async () => {
  const twoEffects = { effects: ["gameWrite", "network"] };
  const gameWriteOnly = { authorizations: [{ effect: "gameWrite", source: "user: deploy" }] };
  assert.equal(resolveAuthorization({ ...twoEffects, plan: gameWriteOnly }).allowed, false);
  const both = { authorizations: [{ effect: "gameWrite", source: "user: deploy" }, { effect: "network", source: "user: download" }] };
  const allowed = resolveAuthorization({ ...twoEffects, plan: both });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.source, "user: deploy; user: download");
  assert.equal(
    resolveAuthorization({ effects: ["toolInstall", "network"], plan: { authorizations: [{ effect: "toolInstall", source: "user: install" }] } }).allowed,
    true,
    "a tool install is a download",
  );
  assert.equal(
    resolveAuthorization({ effects: ["toolInstall", "gameWrite"], plan: { authorizations: [{ effect: "toolInstall", source: "user: install" }] } }).allowed,
    false,
    "a tool install never covers a game write",
  );
  const { registerOperation, executeOperation, getHandler } = await import("../src/core/operations.mjs");
  if (!getHandler("test.two_effects")) {
    registerOperation(
      {
        id: "test.two_effects",
        title: "Two effects",
        summary: "Test operation with two soft effects.",
        engine: "core",
        inputs: { type: "object", properties: {}, required: [] },
        outputs: { type: "object", properties: {} },
        effects: ["gameWrite", "network"],
        requires: [],
        gates: ["soft"],
        skill: "gmf-safety",
        docs: [],
      },
      async () => ({ data: { ran: true } }),
    );
  }
  const refused = await executeOperation("test.two_effects", {}, { flags: { authorized: "gameWrite", source: "user: deploy" } });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "GMF-E-GATE-001");
  assert.match(refused.error.message, /network/);
  const ran = await executeOperation("test.two_effects", {}, { flags: { authorized: "gameWrite,network", source: "user: deploy and download" } });
  assert.equal(ran.ok, true, ran.error?.message);
});

test("authorizeEffects reads the workspace's active plan like the executor does", async (t) => {
  const { authorizeEffects } = await import("../src/core/authorization.mjs");
  const ws = tempDir(t, "gmf-active-plan2-");
  assert.equal(authorizeEffects(["gameWrite"], { workspace: { root: ws } }).allowed, false);
  fs.writeFileSync(path.join(ws, "gmf.plan.json"), JSON.stringify({ authorizations: [{ effect: "gameWrite", source: "plan: user said deploy" }] }));
  const allowed = authorizeEffects(["gameWrite"], { workspace: { root: ws } });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.source, "plan: user said deploy");
});
