---
name: unreal-dumping
description: Use when a mod needs game-derived data first, such as an object dump, usmap, header dump or static mesh dump.
operations: [unreal.dump, unreal.deploy_dumper, unreal.normalize_dump, analyze.objects]
knowledge: [unreal.dumps, unreal.dumps.artifacts]
---

# Unreal dumps

This skill routes dump production. Every dump is evidence tied to one game
build and stays in the workspace.

## Steps

1. Decide which artifact the goal needs:
   `gmf knowledge show unreal.dumps.artifacts` (object dump, headers, usmap,
   jmap, static actors and meshes) and what each costs to produce.
2. Read how dumps are produced and treated as evidence:
   `gmf knowledge show unreal.dumps`.
3. If UE4SS must write the dump in-game, deploy the dumper helper:
   `gmf run unreal.deploy_dumper --input gameDir=<game folder>`. This is a game
   write and needs `gameWrite` authorization.
4. The user runs the game and the helper writes the files. Do not launch the
   game without a `launchGame` authorization.
5. Collect them: `gmf run unreal.dump --input gameDir=<game folder>`.
6. Normalize: `gmf run unreal.normalize_dump`.
7. Spot-check with `gmf run analyze.objects --input query=<name>`.

## Evidence

Record the artifact types, file paths and sizes, the game build and UE4SS
version, the time of the dump and the level loaded when it ran.

## Pitfalls

- Objects not loaded at dump time are missing; dump again in the level you
  target (`unreal.dumps`).
- `FindAllOf` can return actors from worlds nobody is playing in (field note 5),
  so a runtime count may not match the dump.
- Use hook paths from the dump, not memory (G16, `unreal.mined-gotchas`).
- Never commit dump output. Anti-cheat is risk information, not a block; note
  that injected helpers can be detected, then continue.
