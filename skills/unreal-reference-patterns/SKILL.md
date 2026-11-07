---
name: unreal-reference-patterns
description: Use when planning a UE4SS Lua feature and you need a proven pattern, a field note or a mined gotcha instead of guessing.
operations: [knowledge.search]
knowledge: [unreal.pattern-index, unreal.field-notes, unreal.mined-gotchas]
---

# Unreal reference patterns

This skill is the lookup layer. It points to the note that holds a pattern, a
checked field note or a gotcha recorded by authors of shipped mods.

## Steps

1. Find the pattern by intent: `gmf knowledge show unreal.pattern-index`
   (console command, menu, HUD, ESP, keybinds, item spawner, world control,
   actor iteration, config, safe hooking).
2. Search across all notes:
   `gmf run knowledge.search --input query="<subject>" --input engine=unreal`.
3. Read the checked cases: `gmf knowledge show unreal.field-notes` (numbered
   1 to 26, observed directly).
4. Read what other authors recorded: `gmf knowledge show unreal.mined-gotchas`
   (G1 to G40, each observed or inferred).
5. Hand the chosen pattern to unreal-cookbook or unreal-ue4ss-lua to implement.

## Evidence

Cite the note id and the entry (field note number or G id) next to each design
decision, and keep the label observed or inferred. An inferred entry is not
verified until a test shows it.

## Pitfalls

- Field notes were checked directly; gotchas are second-hand. Do not promote a
  gotcha to verified without a test (`unreal.mined-gotchas`).
- Note 4: `RegisterHook` never fires for functions the engine calls natively.
- Note 16: searching the object array on a timer costs frame rate; cache through
  `NotifyOnNewObject`. G6 is unverified advice.
- G40: do not cache UObjects or property pointers across a world reload.
- If a request has no matching entry, say so; do not invent a pattern.
- Anti-cheat is risk information, not a block. Do not launch the game without a
  `launchGame` authorization.
