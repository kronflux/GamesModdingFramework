---
name: unity-il2cpp
description: Use when the Unity game is IL2CPP and a mod needs interop assemblies, Il2CppInterop patching, or IL2CPP-safe C# patterns.
operations: [unity.decompile, unity.normalize_dump, analyze.classes]
knowledge: [unity.il2cpp.interop, unity.il2cpp.patching, unity.csharp.patterns]
---

# Unity IL2CPP modding

This skill routes work on IL2CPP games with BepInEx 6 or MelonLoader. The
shipped binary is native, so you work through generated interop assemblies.

## Steps

1. Confirm `runtime` is IL2CPP in `gmf.profile.json`. If it is Mono, stop and
   load unity-harmony instead.
2. Read how interop assemblies are generated and used:
   `gmf knowledge show unity.il2cpp.interop`.
3. Produce readable game types:
   `gmf run unity.decompile --input gameDir=<game folder>`, then
   `gmf run unity.normalize_dump`.
4. Look up the interop type and member:
   `gmf run analyze.classes --input query=<name>`.
5. Read the patching limits and the interop type rules:
   `gmf knowledge show unity.il2cpp.patching`.
6. Read the safe C# idioms for these builds:
   `gmf knowledge show unity.csharp.patterns`.
7. Write the patch. Load unity-bepinex or unity-melonloader for build and
   deploy, and unity-harmony for patch structure.

## Evidence

Record the interop assembly version, the type and member names as the interop
exposes them, and whether the method was found in the dump. State if a method
may be inlined or folded.

## Pitfalls

- Prefix and postfix only; transpilers do not work on IL2CPP
  (`unity.il2cpp.patching`).
- Use interop collection and string types, and check `WasCollected` before
  touching a game object (`unity.il2cpp.patching`).
- Injected MonoBehaviours must be registered before use
  (`unity.il2cpp.interop`).
- Never commit interop assemblies or dump output. Anti-cheat is risk
  information, not a block; record it and continue.
