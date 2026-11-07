---
name: unreal-object-model
description: Use when you must reason about UObject, UClass, UFunction, FName and properties, or locate a target in an object dump.
operations: [unreal.dump, unreal.normalize_dump, analyze.objects, analyze.classes, analyze.entrypoints, unreal.inspect_asset]
knowledge: [unreal.object-model, unreal.reflection]
---

# Unreal object model

This skill routes questions about how Unreal represents objects at runtime and
how to find a class, function or property in a dump.

## Steps

1. Read the model: `gmf knowledge show unreal.object-model`, then how reflection
   exposes properties and functions: `gmf knowledge show unreal.reflection`.
2. Get a dump if none exists (load unreal-dumping):
   `gmf run unreal.dump --input gameDir=<game folder>`.
3. Normalize it: `gmf run unreal.normalize_dump`.
4. Find the target: `gmf run analyze.objects --input query=<name>`,
   `gmf run analyze.classes --input query=<name>` and
   `gmf run analyze.entrypoints`.
5. For an asset-level view: `gmf run unreal.inspect_asset --input assetPath=<asset>`.
6. Record the full object path, class and function signature with parameter
   types before writing mod code (unreal-ue4ss-lua or unreal-ue4ss-cpp).

## Evidence

Record the dump path and the game build it came from, the object path, class,
function and property names, and what the dump did not cover (classes not
loaded when it ran).

## Pitfalls

- Never guess a memory layout; use reflection (`unreal.object-model`).
- `FindFirstOf` takes a short class name, not a full object name (G22), and
  returns an invalid object rather than nil on recent builds (G21).
- Compare objects by address (G23); the class default object is found with
  `StaticFindObject`, not `FindAllOf` (G24).
- A struct from a UFunction call is a copy (field note 12); nested struct writes
  may land on a copy (G26).
- Name suffixes do not tell you how a function behaves (G19). Ids G and field
  notes are in `unreal.mined-gotchas` and `unreal.field-notes`.
- Dumps are evidence tied to one build and are never committed. Anti-cheat is
  risk information, not a block.
