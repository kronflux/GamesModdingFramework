---
name: unreal-dumping
description: Use to produce one dump artifact or to dump an Unreal game again after an update, such as an object dump, usmap, header dump or one GmfDumper step.
operations: [unreal.dump, unreal.deploy_dumper, unreal.normalize_dump, analyze.objects]
knowledge: [unreal.dumps, unreal.dumps.artifacts]
---

# Unreal dumps

This skill routes a single artifact or a re-dump. Every dump is evidence tied
to one game build and stays in the workspace.

## Steps

1. If the workspace has no `gamedocs/overview.md`, load `unreal-first-dump`
   instead. It runs the complete dump and builds the docs.
2. Decide which artifact the goal needs:
   `gmf knowledge show unreal.dumps.artifacts` (what each artifact is, which
   GmfDumper step or UE4SS key produces it, and what it costs).
3. Read how dumps are treated as evidence: `gmf knowledge show unreal.dumps`.
4. If the dumper is not deployed, deploy it:
   `gmf run unreal.deploy_dumper --input gameDir=<game folder>`. This is a game
   write and needs `gameWrite` authorization.
5. The game must run with the dumper. Either `unreal-first-dump` runs it with a
   `launchGame` authorization, or the user starts the game and types
   `gmfdump <step>` in the UE4SS console (`gmfdump list` prints the step ids).
   Do not launch the game without a `launchGame` authorization.
6. Collect the result:
   `gmf run unreal.dump --input gameDir=<game folder> --input collect=true`.
7. Normalize: `gmf run unreal.normalize_dump`.
8. Spot-check with `gmf run analyze.objects --input query=<name>`.

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
