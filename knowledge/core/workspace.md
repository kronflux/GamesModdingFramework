---
name: core.workspace
title: Workspace files and path containment
description: Keep committed identity, machine paths and generated evidence separate and never write outside the workspace by accident.
engine: core
tags: [workspace, paths, git, profile]
confidence: verified
sources: [GMF design documentation (docs/architecture.md, docs/catalog.md, docs/authorization.md)]
---

# Workspace files and path containment

The workspace is separate from the game install.

## Files

- `gmf.json` is committed. It holds the schema version, game name, engine ID,
  author and package metadata. No absolute paths.
- `gmf.local.json` is ignored. It holds the game install path, the tools
  directory and other machine-specific paths.
- `gmf.profile.json` is generated and ignored. It holds evidence and unknowns.
- `gmf.plan.json` is the active plan and its authorization records.
- `decompiled/`, `extracted/`, `dumps/`, `logs/` and `backups/` are ignored.

## Rules

1. Resolve every output path against the workspace root with
   `assertInside(workspace, target)`.
2. Keep generated evidence out of `gmf.json`. The committed file must move to a
   new machine without edits.
3. Never write into the game folder for an investigation. Detection reads only.
4. A game write needs a backup under `backups/` and a recorded SHA-256.

## Pitfalls

- A path that starts with the workspace root as a string but escapes with `..`
  is outside the workspace. Use the resolved relative path.
- Two workspaces that share a game folder do not share backups. Restore from the
  workspace that recorded the backup.
- Do not commit `gmf.local.json`, a profile, a plan, a backup or a dump.
