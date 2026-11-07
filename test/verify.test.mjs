import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { verifyPlanOperation, splitCommand } from "../src/operations/verify/plan.mjs";
import { repoRoot } from "./helpers/paths.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const root = repoRoot;

function plan(steps) {
  return { version: 1, goal: "test", profile: "gmf.profile.json", steps, authorizations: [] };
}

function step(id, verify) {
  return { id, operation: "game.detect", inputs: {}, why: "w", effects: ["read"], gate: "auto", expect: "e", verify };
}

test("splitCommand honours quotes", () => {
  assert.deepEqual(splitCommand('gmf detect --game "C:/Games/Some Game" --json'), ["gmf", "detect", "--game", "C:/Games/Some Game", "--json"]);
  assert.deepEqual(splitCommand("a 'b c' d"), ["a", "b c", "d"]);
});

test("verify.plan runs gmf verify commands, records manual checks and writes the plan file", async (t) => {
  const workspace = tempDir(t, "gmf-verify-");
  const file = path.join(workspace, "gmf.plan.json");
  fs.writeFileSync(file, JSON.stringify(plan([step("1", "gmf version --json"), step("2", "launch the game and open the menu"), step("3", "gmf nope")])));
  const result = await verifyPlanOperation.handler({ plan: file }, { root, workspace: { root: workspace } });
  const [one, two, three] = result.data.verification;
  assert.equal(one.status, "passed");
  assert.equal(one.exitCode, 0);
  assert.match(one.logTail, /"version"/);
  assert.equal(two.status, "manual");
  assert.equal(two.command, "launch the game and open the menu");
  assert.equal(three.status, "failed");
  assert.equal(three.exitCode, 2);
  assert.equal(result.data.ok, false);
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(written.verification.length, 3);
});

test("verify.plan records a step as failed when the runner rejects and still writes the plan", async (t) => {
  const workspace = tempDir(t, "gmf-verify-reject-");
  const file = path.join(workspace, "gmf.plan.json");
  fs.writeFileSync(file, JSON.stringify(plan([step("1", "gmf version --json"), step("2", "gmf version --json")])));
  let calls = 0;
  const runProcess = async () => {
    calls += 1;
    if (calls === 1) {
      const error = new Error("GMF-E-TIMEOUT-001: node timed out after 5 ms");
      error.code = "GMF-E-TIMEOUT-001";
      throw error;
    }
    return { code: 0, stdout: "ok", stderr: "" };
  };
  const result = await verifyPlanOperation.handler({ plan: file }, { root, workspace: { root: workspace }, runProcess });
  const [one, two] = result.data.verification;
  assert.equal(one.status, "failed");
  assert.equal(one.exitCode, null);
  assert.match(one.logTail, /GMF-E-TIMEOUT-001/);
  assert.equal(two.status, "passed", "later steps still run");
  assert.equal(result.data.ok, false);
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(written.verification.length, 2);
});
