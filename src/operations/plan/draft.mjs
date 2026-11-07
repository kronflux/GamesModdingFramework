import { getHandler, registerOperation } from "../../core/operations.mjs";
import { draftPlan, resolveProfileInput } from "../../core/plan.mjs";

export const planDraftOperation = {
  id: "plan.draft",
  title: "Draft a plan",
  summary:
    "Turn a goal and a profile into a draft plan with effects, gates, missing tools and risks. It never executes a step.",
  engine: "core",
  inputs: {
    type: "object",
    properties: {
      goal: { type: "string" },
      profile: {},
    },
    required: ["goal"],
  },
  outputs: {
    type: "object",
    properties: {
      plan: { type: "object" },
    },
  },
  effects: ["read"],
  requires: [],
  gates: ["auto"],
  skill: "gmf-plan",
  docs: ["knowledge/core/catalog.md", "knowledge/core/authorization.md"],
  handler: async (inputs, context = {}) => {
    const profile = resolveProfileInput(inputs.profile, context);
    const plan = draftPlan({
      goal: inputs.goal,
      profile,
      catalog: context.catalog || { version: 1, operations: [] },
    });
    return { data: { plan } };
  },
};

export default planDraftOperation;

if (!getHandler(planDraftOperation.id)) {
  registerOperation(planDraftOperation, planDraftOperation.handler);
}
