---
name: unity.harmony
title: Harmony patching and target resolution
description: Patch Unity methods at runtime with Harmony prefixes, postfixes and transpilers and verify that every target resolves.
engine: unity
tags: [harmony, patching, csharp, entrypoints, verification]
confidence: verified
sources: [Harmony documentation, Harmony GitHub repository, earlier Unity modding framework notes]
---

# Harmony patching and target resolution

Special arguments (`__instance`, `__result`, `__state`), reverse patches, iterators, priorities and pitfalls are in `unity.harmony.advanced`.

Harmony patches a method at runtime. The game assembly on disk is not modified,
but a wrong target fails at patch time or silently changes behavior.

## Patch shape

- A patch class carries `HarmonyPatch` attributes for the type and method.
- `Prefix` runs before the original and can skip it with a false return.
- `Postfix` runs after the original and can read or replace the result.
- `Transpiler` rewrites the IL and is the most fragile patch kind.
- `PatchAll` patches every class in the assembly; it is convenient for a small
  plugin and dangerous for a large one because one bad target aborts the rest.

## Finding a target

1. Decompile the assembly with `unity.decompile`.
2. Search classes and methods with `analyze.classes` and
   `analyze.entrypoints`.
3. Confirm the method name, parameter list and return type in the decompiled
   source, not from memory.
4. Prefer a method with a stable signature over an obfuscated one.

## Verifying

`unity.validate` resolves every declared Harmony target against the game
assemblies. A missing target is a failure, not a warning. The operation reports
the resolution result and the exact assembly it checked.

## Pitfalls

- An overload with the same name but a different signature does not resolve.
- A generic method needs a closed generic type in the patch attribute.
- IL2CPP methods are not ordinary managed methods. Use the generated interop
  assemblies and expect a different patching path.
- A prefix that returns false for a method with side effects can break the game
  state. Prefer a postfix when the original must run.
