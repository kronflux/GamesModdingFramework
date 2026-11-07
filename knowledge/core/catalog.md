---
name: core.catalog
title: Catalog-first operation selection
description: Choose capabilities from the catalog by ID, effects and gates instead of guessing a fixed workflow.
engine: core
tags: [catalog, operations, effects, gates, discovery]
confidence: verified
sources: [GMF design documentation (docs/architecture.md, docs/catalog.md, docs/authorization.md)]
---

# Catalog-first operation selection

The catalog is the contract between the framework and an agent. Every capability
is an operation with a stable ID such as `game.profile`, `unity.decompile` or
`unreal.scaffold`.

## Read the catalog first

1. Run `gmf catalog --json`.
2. Filter by `engine` and by the capability you need.
3. Read the operation `inputs`, `outputs`, `effects`, `requires`, `gates` and
   `skill` fields before calling it.
4. Run the operation through `gmf run <operation-id> --input key=value`.

Do not invent an operation ID. Do not infer input names from a similar tool.
The catalog is generated from source descriptors, so a name that is not in the
catalog has no handler and fails with `GMF-E-PLAN-001`.

## Effects decide the gate

- `read` and `workspaceWrite` are automatic.
- `gameWrite`, `toolInstall`, `network`, `launchGame`, `antiCheat` and `execute` are soft
  gated. The plan or the user's instruction must authorize the effect and the
  source is recorded.
- `destructive`, `credentials` and `piracy` are hard gated. Credential access and
  piracy are refused.

A tool requirement in `requires` is not installed by the operation. The plan
must contain a `tool.install` step with its own authorization.

## Pitfalls

- A stale catalog hides new operations. Regenerate it with
  `npm run build-catalog` after changing a descriptor.
- An operation that reads a game folder still declares its effects. Never assume
  an operation is safe because its name sounds read-only.
- The catalog returns metadata, never operation output. Run the operation to get
  evidence.
