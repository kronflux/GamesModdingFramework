import { getHandler, registerOperation } from "../../core/operations.mjs";
import { applyPlan, normalizeOverrides, readPlanInput } from "../../core/plan.mjs";
import { authorizationOverrides } from "../../core/authorization.mjs";

export const planApplyOperation = {
  id: "plan.apply",
  title: "Apply a plan",
  summary:
    "Run the steps in order. Each step's effects are authorized individually; a step without an authorization stops the plan unless it is optional.",
  engine: "core",
  inputs: {
    type: "object",
    properties: {
      plan: {},
      authorizations: { type: "array" },
      authorized: { type: "string" },
      source: { type: "string" },
    },
    required: ["plan"],
  },
  outputs: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      results: { type: "array" },
    },
  },
  effects: ["read"],
  requires: [],
  gates: ["auto"],
  skill: "gmf-plan",
  docs: ["knowledge/core/authorization.md", "knowledge/core/safety.md"],
  handler: async (inputs, context = {}) => {
    const plan = readPlanInput(inputs.plan, context);
    // Authorizations come from the plan input, the authorizations input, and
    // every context form (--authorized flags, MCP authorized arguments).
    const overrides = [...normalizeOverrides(inputs.authorizations), ...authorizationOverrides(context)];
    if (typeof inputs.authorized === "string" && inputs.authorized.trim()) {
      for (const effect of inputs.authorized.split(",").map((value) => value.trim()).filter(Boolean)) {
        overrides.push({ effect, source: inputs.source || "plan input" });
      }
    }
    const result = await applyPlan(plan, { ...context, overrides });

    if (!result.ok) {
      const error = new Error(result.error?.message || "GMF-E-PLAN-001: the plan failed");
      error.code = result.error?.code || "GMF-E-PLAN-001";
      error.remediation = result.error?.remediation || "Read the step result and fix the plan.";
      error.results = result.results;
      throw error;
    }
    return { data: { ok: true, results: result.results } };
  },
};

export default planApplyOperation;

if (!getHandler(planApplyOperation.id)) {
  registerOperation(planApplyOperation, planApplyOperation.handler);
}
