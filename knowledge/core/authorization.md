---
name: core.authorization
title: Effects, gates and authorization records
description: Map operation effects to auto, soft and hard gates and record the source that authorized each risky step.
engine: core
tags: [authorization, gates, effects, safety, plan]
confidence: verified
sources: [GMF design documentation (docs/architecture.md, docs/catalog.md, docs/authorization.md), GMF authorization documentation]
---

# Effects, gates and authorization records

Every operation declares at least one effect. The highest effect decides the
gate.

## Gate classes

- `auto`: `read`, `workspaceWrite`. Run without asking.
- `soft`: `gameWrite`, `toolInstall`, `network`, `launchGame`, `antiCheat`, `execute`.
  Run when the active plan or the user's current instruction authorizes the
  effect. Record the quoted instruction or the plan step as the source.
- `hard`: `destructive`, `credentials`, `piracy`. A model-supplied source never
  satisfies a hard gate. Credential access and piracy are refused with
  `GMF-E-POLICY-001`.

## Plan authorizations

```json
{
  "authorizations": [
    { "effect": "gameWrite", "source": "user: deploy the mod", "scope": "step:3" }
  ]
}
```

A missing scope applies to the whole plan. `step:<id>` applies to one step.
`gmf plan validate` reports every effect that lacks an authorization and every
hard effect that a plan tries to authorize.

## Recording

`gmf.plan.json` keeps the active plan and an append-only authorization log. Each
run records the operation, effects, gate and authorization source. Anti-cheat
acknowledgments are recorded too, but they do not authorize a game write by
themselves.

## Pitfalls

- A plan authorization for one effect does not cover another effect.
- A step whose declared effects omit an operation effect fails validation.
- Do not pass a source that does not exist in the user's instruction or the
  approved plan. The source is evidence, not a formality.
