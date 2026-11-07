---
name: unity.il2cpp.patching
title: IL2CPP patching with Il2CppInterop
description: Patch and extend an IL2CPP game with BepInEx 6 or MelonLoader through Il2CppInterop, Prefix and Postfix only, interop types and collections, injected MonoBehaviours, coroutines, delegates, WasCollected, inlined or folded methods and triage order.
engine: unity
tags: [il2cpp, il2cppinterop, harmony, bepinex6, melonloader, interop, patching, wascollected]
confidence: observed
sources: [earlier Unity modding framework notes]
---

# IL2CPP patching

An IL2CPP game has no managed game code. The loader generates **interop assemblies** (`BepInEx/interop/` or `MelonLoader/Il2CppAssemblies/`) whose methods call into native `GameAssembly`. Mods compile against them and patch them with Harmony (`unity.il2cpp.interop`, `unity.csharp.patterns`).

## Sources of truth

| Artifact | Use for | Not for |
| --- | --- | --- |
| Loader interop assemblies | Compiling, patch target types, real member names | Reading game logic (bodies are trampolines) |
| Il2CppDumper or Cpp2IL `DummyDll` (`gmf run unity.decompile`) | Names, signatures, offsets, `[Address]` RVAs | Compiling: access modifiers and some types are unreliable |
| `stringliteral.json`, `script.json` | Literals and method addresses | Guessing; never invent strings |
| Ghidra or IDA on `GameAssembly` | Real method logic | |

An empty interop folder after a launch means the loader failed to generate it (check its log) or the metadata is encrypted.

## Plugin shape

BepInEx 6:
```csharp
[BepInPlugin(Guid, Name, Version)]
public class Plugin : BasePlugin
{
    public override void Load()
    {
        new Harmony(Guid).PatchAll(typeof(Plugin).Assembly);
        AddComponent<ModBehaviour>();       // registers the type with Il2CppInterop and creates it
    }
}
public class ModBehaviour : MonoBehaviour
{
    public ModBehaviour(System.IntPtr ptr) : base(ptr) { }   // required for every injected type
}
```

MelonLoader's `MelonMod` already receives `OnUpdate`, `OnGUI` and scene callbacks, so most mods need no injected type; if you inject one, call `ClassInjector.RegisterTypeInIl2Cpp<T>()` before `AddComponent<T>()`.

Older BepInEx 6 builds (before be.577) use Il2CppAssemblyUnhollower: namespaces `BepInEx.IL2CPP` and `UnhollowerBaseLib`, assemblies in `BepInEx/unhollowed/`. `gmf run game.detect` reports this. Do not mix the two APIs.

## Patching rules

- **Prefix and Postfix only.** Transpilers and other IL rewriting do not work: the interop body is a native call, not the game's IL.
- Injection works: `__instance`, `__result`, `__args`, `__0`/`__1`. Use positional `__N` when interop parameter names differ from the original.
- **Fields are properties** in interop types. `AccessTools.Field` and `___field` injection do not find them; use the property (`__instance.health`).
- **Short methods may be inlined** by the IL2CPP compiler. A patch on an inlined getter or tiny helper applies without error and never fires. Patch the caller.
- **Identical code folding** can merge methods with identical machine code (empty methods, trivial getters), so patching one patches every folded copy. Equal `[Address]` RVAs in the dump mean folded.
- Obfuscated games expose names like `Method_Public_Void_0` that change between updates. Locate them by signature in a `TargetMethod()` and log what was found.
- Patch exactly the overload: `[HarmonyPatch(typeof(T), nameof(T.M), new[] { typeof(int) })]`.

## Interop types

- Collections are `Il2CppSystem.Collections.Generic.List<T>` and `Dictionary<K,V>`. Convert to managed collections for LINQ, convert back at the game API boundary. Avoid `TryAdd` and LINQ directly on interop dictionaries.
- Cast with `obj.Cast<T>()` (throws on mismatch) or `obj.TryCast<T>()` (null). C# `as` and `is` do not work across interop types.
- `__instance != null && !__instance.WasCollected`: `WasCollected` means the native object was collected; Unity's overloaded `== null` catches destroyed objects. Check both for objects kept across frames.
- Delegates and events: `DelegateSupport.ConvertDelegate<Il2CppSystem.Action>(...)` when no implicit conversion exists.
- Coroutines: BepInEx 6 `StartCoroutine(Routine().WrapToIl2Cpp())` (`using BepInEx.Unity.IL2CPP.Utils.Collections;`); MelonLoader `MelonCoroutines.Start(Routine())`.
- Call game APIs on the main thread; interop calls from worker threads can crash the game.

## Triage order for IL2CPP failures

Rule out ordinary causes before blaming Il2CppInterop:

1. Loader and interop versions match the game (after a game update delete `BepInEx/interop` and relaunch to regenerate).
2. Correct type and overload, taken from the interop assembly rather than the dump.
3. Timing: the object exists when touched (scene loaded, not collected).
4. Only then suspect interop limits: `out`/`ref` in delegates, boxed value types, `Nullable<T>`, generic method instantiations, `ByReference<T>`. Search the Il2CppInterop issue tracker for the exact exception (logs: `unity.debugging`).
