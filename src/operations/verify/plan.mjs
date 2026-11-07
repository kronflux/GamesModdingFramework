// verify.plan: run each plan step's verify command and record the result.
//
// A step's verify string that starts with "gmf " is run through this
// framework's own CLI entry (node bin/gmf.mjs ...). Any other text is a manual
// check: it is recorded as status "manual" with the text, never executed, so a
// plan can carry "launch the game and open the menu" without the framework
// trying to run it as a shell command.

import path from "node:path";
import { getHandler, registerOperation } from "../../core/operations.mjs";
import { readPlanInput } from "../../core/plan.mjs";
import { runProcess } from "../../core/processes.mjs";
import { PLAN_FILE, writeJson } from "../../core/workspace.mjs";
import { isInside } from "../../core/fsutil.mjs";

// Split a command line on spaces, honouring double and single quotes.
export function splitCommand(text) {
  const args = [];
  let current = "";
  let quote = null;
  let has = false;
  for (const ch of String(text || "")) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has || current) args.push(current);
      current = "";
      has = false;
      continue;
    }
    current += ch;
  }
  if (has || current) args.push(current);
  return args;
}

function tail(text, lines = 20) {
  return String(text || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-lines)
    .join("\n");
}

export const verifyPlanOperation = {
  id: "verify.plan",
  title: "Run the plan's verification steps",
  summary:
    "Run every step's verify command that starts with gmf, record manual checks as such, and store the results under verification in the plan file.",
  engine: "core",
  inputs: {
    type: "object",
    properties: {
      plan: { description: "A plan object or path. Default: gmf.plan.json in the workspace." },
      tailLines: { type: "integer" },
    },
    required: [],
  },
  outputs: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      verification: { type: "array" },
      planFile: { type: "string" },
    },
  },
  effects: ["read", "workspaceWrite"],
  requires: [],
  gates: ["auto"],
  skill: "gmf-verify",
  docs: ["knowledge/core/evidence.md"],
  async handler(inputs, context = {}) {
    const planFile =
      typeof inputs.plan === "string" && inputs.plan.trim()
        ? path.isAbsolute(inputs.plan)
          ? inputs.plan
          : path.resolve(context.workspace?.root || context.root || process.cwd(), inputs.plan)
        : context.workspace?.root
          ? path.join(context.workspace.root, PLAN_FILE)
          : null;
    const boundary = context.workspace?.root || context.root || null;
    if (planFile && boundary && !isInside(boundary, planFile)) {
      const error = new Error(`GMF-E-PLAN-001: the plan file must be inside the workspace: ${planFile}`);
      error.code = "GMF-E-PLAN-001";
      error.remediation = "Pass a plan path under the workspace, or run from the workspace that owns the plan.";
      throw error;
    }
    const plan = readPlanInput(inputs.plan || planFile, context);
    const runner = context?.processes?.runProcess || context?.runProcess || runProcess;
    const cli = path.join(context.root || process.cwd(), "bin", "gmf.mjs");
    const verification = [];
    let ok = true;

    for (const step of Array.isArray(plan.steps) ? plan.steps : []) {
      const text = typeof step.verify === "string" ? step.verify.trim() : "";
      if (!text) {
        verification.push({ step: step.id, status: "none", command: null, exitCode: null, logTail: "" });
        continue;
      }
      const args = splitCommand(text);
      if (args[0] !== "gmf") {
        verification.push({ step: step.id, status: "manual", command: text, exitCode: null, logTail: "" });
        continue;
      }
      const argv = [cli, ...args.slice(1)];
      let result;
      try {
        result = await runner(process.execPath, argv, {
          cwd: context.workspace?.root || process.cwd(),
          timeoutMs: Number(inputs.timeoutMs) || 600000,
        });
      } catch (error) {
        // A runner that rejects (a timeout, a missing executable) fails this step only.
        ok = false;
        verification.push({
          step: step.id,
          status: "failed",
          command: text,
          exitCode: null,
          logTail: tail(String(error?.message || error), Number(inputs.tailLines) || 20),
          at: new Date().toISOString(),
        });
        continue;
      }
      const passed = result.code === 0;
      if (!passed) ok = false;
      verification.push({
        step: step.id,
        status: passed ? "passed" : "failed",
        command: text,
        exitCode: result.code,
        logTail: tail(`${result.stdout || ""}\n${result.stderr || ""}`, Number(inputs.tailLines) || 20),
        at: new Date().toISOString(),
      });
    }

    if (planFile && typeof inputs.plan !== "object") {
      plan.verification = verification;
      writeJson(planFile, plan);
    }
    return { data: { ok, verification, planFile } };
  },
};

export default verifyPlanOperation;

if (!getHandler(verifyPlanOperation.id)) registerOperation(verifyPlanOperation, verifyPlanOperation.handler);
