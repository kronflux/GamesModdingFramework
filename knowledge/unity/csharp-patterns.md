---
name: unity.csharp.patterns
title: C# modding patterns and IL2CPP compatibility
description: C# patterns for Unity mods on .NET Framework 4.7.2 (safe reflection, caching, pooling, thread safety, errors, Unity null checks), writing code that works on IL2CPP, and MonoMod RuntimeDetour essentials.
engine: unity
tags: [csharp, il2cpp, reflection, memory, threads, monomod, interop, performance]
confidence: observed
sources: [earlier Unity modding framework notes]
---

# C# modding patterns

Patterns for Unity mod code on .NET Framework 4.7.2: reflection, performance, thread safety, IL2CPP compatibility. Reflection detail: `unity.reflection`. IL2CPP patching rules: `unity.il2cpp.patching`.

## Essential patterns

Safe reflection with error handling:

```csharp
public static bool TryGetPrivateField<T>(object instance, string fieldName, out T result)
{
    result = default;
    try
    {
        var field = AccessTools.Field(instance.GetType(), fieldName);
        if (field == null) { Logger.LogWarning($"Field not found: {fieldName}"); return false; }
        result = (T)field.GetValue(instance);
        return true;
    }
    catch (Exception ex) { Logger.LogError($"Reflection error: {ex.Message}"); return false; }
}
```

`Traverse.Create(instance).Field(name).GetValue<T>()` (also `.SetValue`, `.Method(name, args).GetValue<T>()`, and `Traverse.Create(type)` for statics) is the short form for one-off private access.

Cache reflection results: `Dictionary<string, FieldInfo>` keyed `"{type.FullName}.{fieldName}"`, filled on first miss from `AccessTools.Field`.

Reflection without a compile-time reference (IL2CPP stripping may remove members, so log a miss rather than assuming):

```csharp
var field = instance.GetType().GetField(fieldName, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
if (field == null) { Logger.LogWarning($"Field {fieldName} not found (IL2CPP may have stripped it)"); return null; }
return field.GetValue(instance);
```

## Performance

- **Object pooling**: a generic `ObjectPool<T>` over a `Stack<T>` with a max size; `Get()` pops or creates, `Return()` pushes while under the cap. Use `try/finally` to `Clear()` and return pooled lists.
- **Delegate caching**: cache `Delegate.CreateDelegate(typeof(Func<TResult>), method)` per `MethodInfo` in a dictionary instead of rebuilding it.
- **Strings**: `StringBuilder` for loops; interpolation over `+` concatenation.
- **LINQ**: enumerate once (`ToList()` then use `.Count` and indexing, not `list.Count()` and `First()` on a lazy query); `Any(predicate)` instead of `Count(predicate) > 0`.

## Thread safety

Protect shared state with `lock (_lock)` around dictionary reads and writes, or use `ConcurrentDictionary` (`AddOrUpdate` is atomic, `TryGetValue` is thread-safe). Unity APIs still belong on the main thread; for IL2CPP interop calls this is mandatory.

## Error handling

Catch specific exceptions first (`ArgumentNullException`, `InvalidOperationException`) and a final `Exception` that logs the whole exception. Prefer `TryX(..., out result)` methods that return false after logging over throwing across a patch boundary.

## Best practices

- Null safety: `?.`, `??`, and pattern matching (`obj is Player p && p.IsAlive`). On `UnityEngine.Object` these operators bypass Unity's overloaded `==`; see below.
- Implement `IDisposable` with the standard `Dispose(bool)` pattern and `GC.SuppressFinalize` for resource owners.
- Coroutines: start only when `gameObject.activeInHierarchy`, and `StopAllCoroutines()` in `OnDisable`.
- **Unity null check**: `player == null` is true for C# null and for a destroyed object; `ReferenceEquals(player, null)` tests C# null only. `?.` and `??` use C# null semantics.

## What changes on IL2CPP

IL2CPP compiles the game's C# to C++ ahead of time. No managed game assemblies exist at runtime (`<Game>_Data/Managed/Assembly-CSharp.dll` is absent); the loader generates **interop proxy assemblies** that marshal into the native runtime.

| | Mono | IL2CPP |
|---|---|---|
| Game assemblies | Real managed DLLs | Native `GameAssembly.dll` plus generated proxies |
| Target framework | `net472` / `netstandard2.1` | `net6.0` |
| Transpilers | Work | **Do not work**, no IL body |
| Collections | `System.Collections.Generic.*` | `Il2CppSystem.Collections.Generic.*` |
| Custom MonoBehaviour | `AddComponent<T>()` | Requires registration first |
| Object lifetime | GC and Unity fake-null | GC handle, IL2CPP collection and Unity fake-null |

Detect the backend with `gmf run game.detect`; it reports the backend, while the loader (BepInEx or MelonLoader) is a separate question. Other IL2CPP challenges: no reflection for generic methods, limited dynamic code generation, a stricter type system.

### Referencing interop assemblies

| Loader | Path |
|---|---|
| MelonLoader 0.6.0 and later | `<game-dir>/MelonLoader/Il2CppAssemblies/` |
| MelonLoader 0.5.x | `<game-dir>/MelonLoader/Managed/` |
| BepInEx 6 (IL2CPP) | `<game-dir>/BepInEx/interop/` |

Under MelonLoader 0.6.0 and later game proxies are **prefixed**: `Assembly-CSharp.dll` becomes `Il2CppAssembly-CSharp.dll` with an `Il2Cpp`-prefixed namespace. At minimum reference `Il2Cppmscorlib`, `Il2CppInterop.Common`, `Il2CppInterop.Runtime` and the game proxy (for example `Il2CppAssembly-CSharp`), each by `HintPath` into that folder. The interop assemblies are generated on **first launch after installing the loader**; if the folder is missing or empty, launch once before building. **Never** reference or ship `UnhollowerBaseLib.dll`: `knah/Il2CppAssemblyUnhollower` was superseded by `BepInEx/Il2CppInterop`, which the loaders bundle, and a stray copy gives `Could not load file or assembly 'UnhollowerBaseLib'`.

### Types, casts and null states

Game collections are IL2CPP types. `System.Collections.Generic.List<Item> items = player.inventory;` throws at runtime; use `Il2CppSystem.Collections.Generic.List<Item>`. For LINQ copy into a BCL list by index. Strings marshal automatically; `Il2CppSystem.Object` is the IL2CPP root, distinct from `System.Object`. Cast with `obj.TryCast<T>()` (null on mismatch, preferred) or `obj.Cast<T>()` (throws), not C# casts.

Three distinct null states:

```csharp
if (obj == null) { }            // C# null OR Unity fake-null (destroyed UnityEngine.Object)
if (obj.WasCollected) { }       // the IL2CPP object was garbage-collected
var p = obj.Pointer;            // throws ObjectCollectedException if collected
```

A destroyed `UnityEngine.Object` still has a live IL2CPP object, so `WasCollected` is false while it is unusable; a collected object is gone regardless of Unity's view. Guard with `obj != null && !obj.WasCollected`. Do not cache `.Pointer`; it resolves through the GC handle on each access, which makes the check meaningful (`Il2CppObjectBase.cs` in BepInEx/Il2CppInterop).

### Custom MonoBehaviours

`AddComponent<MyComponent>()` fails on IL2CPP unless the type is registered (`... does not have a corresponding IL2CPP class pointer`). Call `ClassInjector.RegisterTypeInIl2Cpp<MyComponent>()` (`Il2CppInterop.Runtime.Injection`) once at startup, before any `AddComponent`, and give the component an `IntPtr` constructor (`public MyComponent(IntPtr ptr) : base(ptr) { }`). MelonLoader registers types marked `[RegisterTypeInIl2Cpp]` automatically. Registration at `OnInitializeMelon` or `Awake` is the norm.

### Delegates, coroutines, threads

- Coroutines need `MelonCoroutines.Start(...)` under MelonLoader or an injected MonoBehaviour's `StartCoroutine`; a plain `IEnumerator` handed to game code may not marshal.
- Delegates passed to game code must be IL2CPP-compatible; assigning a C# lambda to a game event sometimes needs the generated type (`new Il2CppSystem.Action(MyMethod)`).
- Interop calls generally must run on a thread attached to the IL2CPP runtime; a raw `Thread` or `Task` continuation can crash the process. Marshal back to the main thread.

### One codebase for both backends

1. Two build configurations with `#if IL2CPP` and separate `TargetFramework`s: most robust, most maintenance.
2. Two projects sharing linked source files, each referencing its own assemblies.
3. Reflection-only access to game types, no compile-time references: slow and loses type safety, but backend-agnostic.

Practice, not a documented pattern: most mods target one backend because a game is one or the other. Dual-targeting pays mainly for library mods other mods depend on. Decide before writing code; retrofitting is much more work than starting with option 1.

## MonoMod RuntimeDetour essentials

MonoMod powers HarmonyX's detour engine; use it directly for programmatic hooks or IL editing:

- `MonoMod.RuntimeDetour.Hook` redirects a method to a delegate; `ILHook` edits IL (like a Harmony transpiler, through `ILContext`). Both are `IDisposable` (undone on Dispose or GC).
- `DetourConfig` gives a hook an ID plus `before`, `after` and `priority` for deterministic ordering across mods.
- All hooks on a method form a chain; each receives a continuation delegate for the next hook or the original. Invoke the continuation only while the hook is on the stack (off-stack invocation is not thread-safe).
- Use Harmony for declarative attribute patches; MonoMod RuntimeDetour for programmatic or conditional hooks, native-method patching or low-level IL edits (HarmonyX `ILManipulator` bridges the two).
