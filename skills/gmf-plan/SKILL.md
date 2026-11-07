---
name: gmf-plan
description: Draft, review and validate a plan whose steps, effects and gates match the user's goal.
operations: [plan.draft, plan.validate, knowledge.search]
---

# Plan a mod job

Use this after a profile exists and before any operation that writes into the
game folder or installs a tool.

## Steps

1. Read the profile and the catalog:
   `gmf profile --json` and `gmf catalog --json`.
2. Draft the plan:
   `gmf run plan.draft --input goal="<goal>" --input profile=gmf.profile.json --json`.
   The draft lists the steps, their effects and gates, the missing tools and any
   anti-cheat risk. It never executes a step.
3. Edit the draft for the real goal. Keep the operation IDs from the catalog.
   Remove a step the goal does not need. Add inputs the profile could not fill.
4. Add an authorization for every soft effect the user's instruction or an
   approved earlier plan contains. Quote or point to that source. Never invent
   a source.
5. Validate:
   `gmf run plan.validate --input plan=gmf.plan.json --json`.
   Validation reports every problem: unknown operations, missing inputs, tools
   without an install step, effects without an authorization, and hard effects.
6. Fix every reported problem and validate again.

Engine skill next: to pick operations and note ids for a step, read
unity-bepinex, unity-melonloader or unreal-ue4ss-lua, and unreal-reference-patterns
for Unreal feature ideas.

## Evidence

The plan is the authorization record. Each step carries `why`, `expect` and
`verify`, and the run records the operation, effects, gate and authorization
source in `gmf.plan.json`.

## Pitfalls

- A tool named in `requires` is not installed by the operation. Add a
  `tool.install` step with its own `toolInstall` and `network` authorization.
- A hard effect, such as a destructive delete, cannot be authorized by a plan.
  The user must approve that exact operation and target outside the plan.
- Do not mark a step optional to hide a failure. Optional means the plan can
  continue without that result.
- A plan with no steps is not a plan. If the catalog lacks the operations you
  need, report that instead.
