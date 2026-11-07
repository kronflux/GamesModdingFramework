import { getHandler, registerOperation } from "../../core/operations.mjs";
import { readPlanInput, validatePlan } from "../../core/plan.mjs";

export const planValidateOperation = {
  id: "plan.validate",
  title: "Validate a plan",
  summary:
    "Check operation IDs, required inputs, tool requirements, effect coverage and gates; report every problem, not only the first.",
  engine: "core",
  inputs: {
    type: "object",
    properties: {
      plan: {},
      requireAuthorizations: { type: "boolean" },
    },
    required: ["plan"],
  },
  outputs: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      errors: { type: "array" },
    },
  },
  effects: ["read"],
  requires: [],
  gates: ["auto"],
  skill: "gmf-plan",
  docs: ["knowledge/core/authorization.md", "knowledge/core/catalog.md"],
  handler: async (inputs, context = {}) => {
    const plan = readPlanInput(inputs.plan, context);
    const profile = context.profile || (context.workspace && context.workspace.profile) || null;
    const result = validatePlan(plan, context.catalog || { version: 1, operations: [] }, {
      profile,
      requireAuthorizations: inputs.requireAuthorizations !== false,
    });

    if (!result.ok) {
      const error = new Error(`GMF-E-PLAN-001: ${result.errors.join(" | ")}`);
      error.code = "GMF-E-PLAN-001";
      error.remediation = "Fix every listed problem in the plan and validate again.";
      error.errors = result.errors;
      throw error;
    }
    return { data: { ok: true, errors: [] } };
  },
};

export default planValidateOperation;

if (!getHandler(planValidateOperation.id)) {
  registerOperation(planValidateOperation, planValidateOperation.handler);
}
