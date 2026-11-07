---
name: unreal-debugging
description: Use when a UE4SS mod does not load, a hook does not fire, the game crashes with UE4SS attached, or a log or crash stack needs reading.
operations: [unreal.crash_stack, unreal.ue4ss_settings, unreal.lua_check, unreal.validate, generic.run_tool, knowledge.search]
knowledge: [unreal.debugging, unreal.field-notes]
---

# Unreal and UE4SS debugging

This skill routes triage: read the log and the crash first, classify the
failure, then change one thing.

## Steps

1. Restate the failure: command, exit code, first error line.
2. Read the triage table: `gmf knowledge show unreal.debugging`. If the UE4SS
   console is not visible, turn it on first:
   `gmf run unreal.ue4ss_settings --input profile=development` (a game write).
3. Check the mod: `gmf run unreal.validate --input modDir=<mod folder>` and
   `gmf run unreal.lua_check --input modDir=<mod folder>` (balance, require paths
   and the language server when installed).
4. For a crash, parse the stack:
   `gmf run unreal.crash_stack --input file=<crash text file>`. It names the
   faulting module and the nearest mod frame.
5. Search for the error text: `gmf run knowledge.search --input query="<error text>" --input engine=unreal`.
6. Read the numbered cases in `gmf knowledge show unreal.field-notes`.
7. For a debugger tool run it through the catalog:
   `gmf run generic.run_tool --input tool=<tool id> --input args="<args>"`.
8. Name one cause, test it with one change, and rerun the same step.

## Evidence

Record the log path and the first error, the crash stack summary, the single
cause tested and the result. Say what you could not observe.

## Pitfalls

- `UE4SS.log` is rewritten on every launch; copy it before relaunching (field
  note 15).
- The game-thread setting key in the docs is wrong (field note 1), and the
  console handler depends on an ini switch (field note 2).
- A call that does not raise did not necessarily work (G36); the game's own flag
  can report success without a visible result (field note 21).
- A hook before its class loads silently never fires (G14).
- Do not launch the game without a `launchGame` authorization. Anti-cheat is
  risk information, not a block; record it and continue.
