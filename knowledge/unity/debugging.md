---
name: unity.debugging
title: Debugging and triage for Unity mods
description: First checks by symptom, common error patterns (NullReferenceException, patch not applying, conflicts, leaks), diagnostic logging, a Harmony binding and transpiler debugging guide, defensive coding, and IL2CPP-specific failure modes.
engine: unity
tags: [debugging, triage, harmony, bepinex, nullreference, il2cpp, wascollected, __instance, logging]
confidence: observed
sources: [earlier Unity modding framework notes]
---

# Debugging and triage for Unity mods

Diagnosing runtime errors, crashes, patch failures and mod conflicts for BepInEx and Harmony mods. Log locations and signatures: `unity.debugging.logs`. Measuring cost: `unity.debugging.performance`.

## First checks

Read the evidence before changing code: the loader log (`BepInEx/LogOutput.log` or `MelonLoader/Latest.log`; `unity.debugging.logs`), and the workspace, game path and toolchain (`gmf run game.detect`, `gmf run game.profile`).

| Symptom | Likely cause | Check |
| --- | --- | --- |
| Plugin never appears in the log | DLL not in the loader's folder, wrong `[BepInProcess]`, or loader not installed | `gmf run unity.deploy` output names the copied file; `gmf run game.detect` shows the loader |
| Build fails: BepInEx or UnityEngine types not found | Wrong game path on this machine (Windows and WSL differ) | Fix the game path in `gmf.local.json`, rebuild |
| Patch applies but never fires | Wrong overload, method inlined (common in IL2CPP), or the code path never runs | `gmf run unity.validate`; patch a caller; log in a Postfix |
| `Patching exception` naming your class | Parameter names or types do not match the target | Compare with the decompiled signature; use `__0` positional names |
| Awake logs, Update never runs (BepInEx 5) | Game destroys the manager object | `HideManagerGameObject = true` in `BepInEx.cfg` |
| `ObjectCollectedException` (IL2CPP) | Kept a reference to a collected object | Check `WasCollected`; fetch the object again |
| Worked before a game update | Renamed or removed target | `gmf run unity.decompile`, then `gmf run unity.validate` |

Common agent mistakes: inferring the loader from the backend, treating an IL2CPP dump as compilable source, writing transpilers for IL2CPP, and reporting a mod as working from a successful build alone.

## Essential debug helper

```csharp
public static class ModDebugger
{
    internal static ManualLogSource Logger { get; set; }

    public static void LogMethodEntry(string methodName, params object[] parameters)
        => Logger.LogDebug($"[ENTRY] {methodName}({string.Join(", ", parameters.Select(p => p?.ToString() ?? "null"))})");
    public static void LogMethodExit(string methodName, object result = null)
        => Logger.LogDebug($"[EXIT] {methodName}{(result != null ? $" -> {result}" : "")}");
    public static void Assert(bool condition, string message, params object[] args)
    {
        if (condition) return;
        var text = string.Format(message, args);
        Logger.LogError($"[ASSERTION FAILED] {text}");
        throw new System.Exception($"Assertion failed: {text}");
    }
}
```

## Common error patterns

**NullReferenceException**, the most common Unity mod error. Check `__instance == null` (log a warning and return) before use in a patch.

**Harmony patch not applying.** Causes: wrong signature, wrong target type, method does not exist, load order. Steps: enable HarmonyX patch logging, check the loader log for patch messages, verify the signature in dnSpyEx (the maintained fork; the original dnSpy was archived in 2020), check conflicts.

```csharp
// HarmonyX logging. NOT Harmony.DEBUG: a no-op under HarmonyX (BepInEx 5, MelonLoader).
HarmonyLib.Tools.HarmonyFileLog.Enabled = true;
HarmonyLib.Tools.Logger.ChannelFilter = HarmonyLib.Tools.Logger.LogChannel.All;

var harmony = new Harmony("your.mod.id");
harmony.PatchAll();
foreach (var method in harmony.GetPatchedMethods())
    Logger.LogInfo($"Patched: {method.DeclaringType}.{method.Name}");
```

**Mod conflicts.** List existing patches on a method:

```csharp
var patches = Harmony.GetPatchInfo(AccessTools.Method(typeof(Player), "Update"));
if (patches != null)
{
    foreach (var p in patches.Prefixes)  Logger.LogInfo($"  Prefix: {p.owner}");
    foreach (var p in patches.Postfixes) Logger.LogInfo($"  Postfix: {p.owner}");
}
```

Fix with `[HarmonyPriority(Priority.High)]`, `[HarmonyBefore("other.mod.id")]` or `[HarmonyAfter(...)]`.

**Memory leaks.** Causes: assets never unloaded, over-caching, event handler leaks, static accumulation. Log `GC.GetTotalMemory(false) / 1024 / 1024` on a periodic coroutine (every 10 s).

**Method signature mismatch.** Print `AccessTools.Method(typeof(Player), "Update")` to see the real signature, or patch manually: `harmony.Patch(original, new HarmonyMethod(prefix))` from `GetMethod` lookups with explicit `BindingFlags`.

## Debugging tools

- **BepInEx console**: `[Logging.Console] Enabled = true`, `LogLevels = Fatal, Error, Warning, Info`; real-time color-coded stream.
- **dnSpyEx**: verify signatures, inspect game code, set breakpoints (enable Mono debugging in the game, attach, step through mod code).
- **Unity Profiler**: CPU, allocations, GC pressure, rendering; see `unity.debugging.performance` for its limits on retail builds.
- **Preloader and loader log** (`BepInEx/LogOutput.log`): plugin load order, dependency resolution, initialization errors, patcher execution.
- **BepInEx.Debug** (https://github.com/BepInEx/BepInEx.Debug): `ScriptEngine` (hot-reload plugins from `BepInEx/scripts`, F6), `StartupProfiler` (per-plugin load timings, goes in `BepInEx/patchers`), `DemystifyExceptions` (readable stack traces), `MirrorInternalLogs`, `CtorShotgun` and Simple Mono Profiler.

## Diagnostic logging

Structured pattern: a `DiagnosticLogger` over `BepInEx.Logging.Logger.CreateLogSource("Diagnostics")` with `[PATCH] Attempting`, `[PATCH] Successfully patched` and `[PATCH] Failed ... : {ex.Message}` plus the stack trace, and `[STATE] name = value` at debug level. Time sections with an `IDisposable` stopwatch (`[PERF] X took Nms`). Log the exception **object**, with type, message, stack trace and inner exception.

Log levels: Debug for verbose detail (hidden in production), Info for milestones (`Mod initialized successfully`), Warning for recoverable issues, Error for actual errors, Fatal for unrecoverable ones. Add a `DebugMode` config switch for extra detail.

## Troubleshooting checklists

- **Mod not loading**: the DLL is under `BepInEx/plugins/`, the log has no error, `BepInPlugin` is correct, dependencies installed.
- **Patches not working**: `HarmonyFileLog.Enabled = true`, log `GetPatchedMethods()` (shows whether it bound at all), signature matches exactly, target type exists, no name typos, check conflict messages.
- **Crash on load**: NullReferenceExceptions, missing dependencies, patch signatures, initialization errors, test with the mod disabled.
- **Performance issues**: profile, GC allocations, expensive patch work, memory, infinite loops.
- **Mod conflicts**: patch conflict messages, list loaded plugins, test with others disabled, load order, duplicate patches.

## Defensive coding

Validate inputs (`if (__instance == null) return;`, `string.IsNullOrEmpty`), wrap risky operations in `try/catch` that logs and returns, and check game state (`Player.LocalPlayer == null` means not initialized yet). Fixes: `__instance` null means check and return early; patch order means priority or `[HarmonyBefore]`.

## Harmony patch debugging guide

**Did it bind?** Almost every "my patch does nothing" report is a binding failure. Harmony does not throw when a target cannot be resolved by name; the patch just never attaches. Log `GetPatchedMethods()` on every development run; an empty list or one missing your target is the answer.

**Logging.** BepInEx 5 and MelonLoader ship **HarmonyX**, where `FileLog` and `Harmony.DEBUG` exist but "do nothing reasonable in code". Use `HarmonyFileLog.Enabled` and `Logger.ChannelFilter` (writes patch application detail and generated IL; turn off for release, it is verbose and slows startup).

**Binding failures**, in rough order of frequency:

| Symptom | Cause | Fix |
|---|---|---|
| Patch absent from `GetPatchedMethods()` | Typo'd method name in a string-based `[HarmonyPatch]` | `nameof(Type.Method)` so a rename is a compile error |
| Same | Overload ambiguity | `argumentTypes`: `[HarmonyPatch(typeof(X), nameof(X.M), new Type[] { typeof(int) })]` |
| Same | Constructor targeted as `".ctor"` | `MethodType.Constructor` (`StaticConstructor` for `.cctor`); name lookup never resolves constructors |
| Same | Property targeted directly | `MethodType.Getter` or `Setter` |
| Same | Coroutine body targeted | `MethodType.Enumerator` |
| `AmbiguousMatchException` | Overloads | `argumentTypes` |
| Wrong overload patched | Harmony picked the first match | `argumentTypes` |
| Nothing binds, no errors | `PatchAll()` never called or called on the wrong assembly | Confirm it runs; on **MelonLoader do not call it**, the loader patches your assembly automatically |

Verify the real signature against the decompiled source, not memory; `AccessTools.Method(typeof(X), "M")` returning null is a fast check.

**Bound but not running.**

- The method is **inlined** (common for one-line getters on Mono, and on IL2CPP). Patch the caller.
- **A prior prefix skipped the original.** **Inferred** from current upstream Harmony 2 documentation: every remaining prefix runs and `bool __runOriginal` reports a skip, so rely on `__runOriginal` rather than on which prefix ran.
- **Wrong instance**: the patch runs on a different object than the one you watch.
- **Patched too late**: the method already ran during startup.

**Runs but breaks the game.**

- An unhandled exception in a prefix propagates into game code and can abort the caller mid-way. `try/catch`, log the full stack, fail open (`return true`).
- `__result` must match the target's return type exactly; a `void` method has none.
- `__state` must be `out` in the prefix and `ref` in the postfix or the postfix sees the default.
- Mutating a collection the game is iterating gives `InvalidOperationException` far from the patch.

A **Finalizer** observes exceptions from the original without changing behaviour:

```csharp
static Exception Finalizer(Exception __exception)
{
    if (__exception != null) Logger.LogError($"Original threw: {__exception}");
    return __exception; // return null to suppress
}
```

**Conflicts.** `Harmony.GetPatchInfo` lists `Prefixes`, `Postfixes` and `Transpilers` with `owner` and `priority`; warn on transpilers. Two transpilers on one method is the highest-risk combination: the second sees IL the first already rewrote, so its pattern match may silently fail. Order with `[HarmonyPriority]`, `[HarmonyBefore]`, `[HarmonyAfter]`.

**Transpiler debugging.** Always use `CodeMatcher` with `ThrowIfInvalid` so a non-matching pattern fails loudly at patch time. `InvalidProgramException` means malformed IL, usually an unbalanced stack: every value pushed must be consumed; do not blanket-`Pop` after calls without checking the callee returns a value. Log before and after IL with `HarmonyFileLog` and diff. Prefer a prefix or postfix when they suffice; transpilers are the most update-fragile patch type. Helpers: HarmonyX `Transpiler-helpers` and `ILManipulators` docs.

**IL2CPP differences.** Transpilers do not work (interop proxies have no real IL). `ObjectCollectedException` from `.Pointer` means the object was collected; probe `WasCollected` first. Unity fake-null is a separate condition `WasCollected` does not detect; check `== null` too. Generic method patching is restricted; patch a concrete instantiation. See `unity.il2cpp.patching`.

## Common pitfalls

- **BepInEx plugin lifecycle.** Wrap `Awake`/`Start` in `try/catch` (an unhandled exception during initialization aborts the load silently). Always `Logger.LogInfo("Mod initialized successfully")` so users can confirm the load. Use the right log level and include message and stack trace. Validate `ConfigEntry` values before use.
- **Unity API usage.** Destroyed objects compare unequal to a true `null` (fake null); null-check `GameObject` and `Component` references. `FindObjectOfType` scans the scene on every call; cache it, never in `Update`. `Destroy()` created objects in `OnDestroy()` and remove event subscriptions.
- **General patterns.** NullReferenceException from missing checks is the most common crash; unhandled exceptions inside patches crash the game (`unity.harmony.advanced`); forgetting to check `__instance`.
- **Framework baseline.** BepInEx 5.x plus HarmonyX for Unity Mono modding (BepInEx 5 ships HarmonyX, not stock Harmony).

## IL2CPP-specific failure modes

- **`Could not load file or assembly UnhollowerBaseLib`**: a stray old unhollower DLL is referenced; remove it and let the loader supply Il2CppInterop.
- **NullReferenceException or ObjectCollectedException on a "non-null" object** is two distinct failures:
  - **IL2CPP object garbage-collected.** `Il2CppObjectBase.Pointer` resolves through the IL2CPP GC handle and throws `ObjectCollectedException` when the target is zero. Probe with `WasCollected`, which does the same lookup without throwing. Do not cache raw pointers; go through `Pointer` so validity is rechecked.
  - **Unity fake null.** A destroyed `UnityEngine.Object` has a live IL2CPP object whose native backing is gone, so `WasCollected` is `false` while it is unusable. Unity's overloaded `== null` catches it; `WasCollected` does not.

  Use both: `obj != null && !obj.WasCollected`, and `TryCast<T>()` rather than `Cast<T>()` when the type is uncertain.
- **Crash on off-thread call**: interop calls may need the IL2CPP thread context.
- **Interop generation failure** ("Failed to generate Il2Cpp interop assemblies"): version skew between loader and the game's Unity IL2CPP version; check the loader matches.
- **DummyDll shows `throw null;` bodies**: expected; DummyDlls carry names and signatures only. Real bodies are native in `GameAssembly` (Ghidra or IDA).
