---
name: unity-harmony
description: Use when you must patch a Unity game method with Harmony, reach private members by reflection, or confirm a patch target still exists.
operations: [unity.decompile, unity.normalize_dump, analyze.classes, analyze.entrypoints, unity.validate]
knowledge: [unity.harmony, unity.harmony.advanced, unity.reflection]
---

# Unity Harmony patches and reflection

This skill routes patch work: find the target in decompiled output, choose the
patch type, write it, and verify that every target resolves.

## Steps

1. Get game code to read: `gmf run unity.decompile --input gameDir=<game folder>`.
   Output goes under the workspace `decompiled/` folder and is never committed.
2. Normalize a dump for querying: `gmf run unity.normalize_dump`. Then
   `gmf run analyze.classes --input query=<name>` and
   `gmf run analyze.entrypoints` to find the type and method.
3. Choose the patch type: `gmf knowledge show unity.harmony`.
4. For special arguments, transpilers, constructors, iterators or reverse
   patches read `gmf knowledge show unity.harmony.advanced`.
5. For private fields, nested or generic types read
   `gmf knowledge show unity.reflection`.
6. Write the smallest patch that changes the named behavior.
7. After a build or a game update run `gmf run unity.validate` to resolve every
   Harmony target against the decompiled source.
8. IL2CPP games restrict you to prefix and postfix; load unity-il2cpp.

## Evidence

Record assembly, type, method signature (with parameter types), the patch kind
and the validation result for each target. Quote source text only when exact
text matters.

## Pitfalls

- Never guess a target from memory; verify it in the decompiled source
  (`unity.harmony`).
- `__instance` can be null in static or early-called methods
  (`unity.harmony.advanced`).
- Reflection on a hot path needs cached delegates (`unity.reflection`).
- Do not commit decompiled code. Anti-cheat markers are risk information, not a
  block; record them and continue.
