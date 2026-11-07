---
name: unity.harmony.advanced
title: Harmony patching in depth
description: Harmony 2.x and HarmonyX patch types, special arguments such as __instance and __result, reverse patches, constructors, iterators, transpilers, priorities, conflicts, pitfalls and the IL2CPP limits.
engine: unity
tags: [harmony, harmonyx, patching, prefix, postfix, transpiler, __instance, il2cpp, bepinex]
confidence: observed
sources: [earlier Unity modding framework notes]
---

# Harmony patching in depth

Harmony 2.x runtime patching for Unity: Prefix, Postfix, Transpiler, `__instance` and `__args` handling, priorities and method interception. Overview: `unity.harmony`. IL2CPP specifics: `unity.il2cpp.patching`.

## Quick start

```csharp
using HarmonyLib;
using BepInEx;

[HarmonyPatch(typeof(TargetClass), "TargetMethod")]
public class TargetClassPatch
{
    [HarmonyPrefix]
    static bool Prefix(TargetClass __instance, ref float parameter)
    {
        if (parameter > 100f) { parameter = 100f; return true; } // clamp, continue
        return false;                                            // skip original
    }

    [HarmonyPostfix]
    static void Postfix(TargetClass __instance, float parameter, ref float __result)
    {
        __result *= 1.1f; // modify output or guarantee execution
    }
}
```

## Patch types

**1. Prefix**: modify inputs, validate conditions or prevent the original.

```csharp
[HarmonyPatch(typeof(PlayerHealth), "TakeDamage")]
public class PlayerHealthPatch
{
    [HarmonyPrefix]
    static bool Prefix(PlayerHealth __instance, ref float damage, DamageType damageType)
    {
        if (damage < 0) { damage = 0; return true; }       // input validation
        if (GodMode.Enabled) return false;                  // skip original
        if (damageType == DamageType.Fire && FireResistance.Active) damage *= 0.5f;
        return true;
    }
}
```

**2. Postfix**: modify outputs, add side effects or guarantee execution.

```csharp
[HarmonyPatch(typeof(Inventory), "AddItem")]
public class InventoryPatch
{
    [HarmonyPostfix]
    static void Postfix(Inventory __instance, Item item, bool __result)
    {
        if (__result) { Logger.LogInfo($"Item {item.Name} added"); ItemEvents.OnItemAdded?.Invoke(item); }
        UIManager.UpdateInventoryDisplay();
    }
}
```

**3. Transpiler**: modify IL for complex logic changes.

```csharp
[HarmonyPatch(typeof(Calculator), "ComplexCalculation")]
public class CalculatorPatch
{
    [HarmonyTranspiler]
    static IEnumerable<CodeInstruction> Transpiler(IEnumerable<CodeInstruction> instructions)
    {
        var codes = new List<CodeInstruction>(instructions);
        for (int i = 0; i < codes.Count; i++)
            if (codes[i].opcode == OpCodes.Mul) codes[i] = new CodeInstruction(OpCodes.Add);
        return codes;
    }
}
```

**4. Reverse patch**: call private methods of the original. It must be a **static method stub** mirroring the original's signature, with the instance as first parameter for instance methods. Harmony replaces the stub's body with the original's IL, so the body you write never runs and throwing is the conventional placeholder. A delegate or auto-property will not work: nothing assigns it. If the original returns a value, the stub returns that type; for a static original drop the instance parameter.

```csharp
[HarmonyPatch(typeof(PrivateClass))]
public static class PrivateMethodPatch
{
    [HarmonyReversePatch]
    [HarmonyPatch("PrivateMethod", new Type[] { typeof(int), typeof(string) })]
    public static void PrivateMethodProxy(PrivateClass instance, int number, string text)
        => throw new NotImplementedException("Harmony reverse patch stub");
}
// PrivateMethodPatch.PrivateMethodProxy(instance, 42, "test");
```

## Special arguments

Name matters, order does not. Declare only what you use.

| Parameter | Type | Notes |
|---|---|---|
| `__instance` | the declaring type | The instance. Omit for static targets. |
| `__result` | the method's **return type** | Read in Postfix; `ref` to change it. Not available on `void`. In a Prefix, set it with `return false` to substitute a return value. |
| `__state` | anything | Passes data Prefix to Postfix. Must be `ref` (or `out` in the Prefix). |
| `__args` | `object[]` | All arguments, boxed; `ref` to write back. |
| `__originalMethod` | `MethodBase` | The method being patched. |
| `__runOriginal` | `bool` | HarmonyX: whether the original will run or did run. |
| `__exception` | `Exception` | Finalizer only. Set to `null` to suppress the exception. |
| `___fieldName` | the field's type | Three underscores; any field of the declaring class, instance **or** static; `ref` to write. |
| `__0`, `__1`, ... | the parameter's type | Positional argument, 0-based. |
| `<argName>` | the parameter's type | Match the original's parameter name exactly. |

There is **no** `__method` parameter; use `__originalMethod`. `static` is not a valid parameter modifier; a static field uses the same `___fieldName` form. Upstream Harmony 2.3 and later also provide `__runOriginal`; **inferred**, check the Harmony version your loader bundles.

```csharp
[HarmonyPatch(typeof(TargetClass), nameof(TargetClass.TargetMethod))]
public class SpecialArgumentsPatch
{
    [HarmonyPrefix]
    static bool Prefix(TargetClass __instance, ref float __result, out int __state,
                       object[] __args, MethodBase __originalMethod, ref int ___privateField)
    {
        __state = 0;
        return true; // false skips the original
    }

    [HarmonyPostfix]
    static void Postfix(ref float __result, ref int __state) { }
}
```

State between Prefix and Postfix:

```csharp
[HarmonyPatch(typeof(PlayerController), "Update")]
public class PlayerStatePatch
{
    [HarmonyPrefix]  static void Prefix(PlayerController __instance, ref int __state) => __state = __instance.currentHealth;
    [HarmonyPostfix] static void Postfix(PlayerController __instance, int __state)
    {
        if (__instance.currentHealth != __state)
            Logger.LogInfo($"Health changed from {__state} to {__instance.currentHealth}");
    }
}
```

## Advanced techniques

**Conditional patching**: return a condition from the Prefix (`Config.EnableMod.Value && GameVersion.IsCompatible && !IsInMainMenu()`).

**Dynamic patching**: create the `Harmony` instance with the plugin GUID and `PatchAll(typeof(X))` only for features the config enables; `UnpatchSelf()` removes them (see HarmonyX notes below).

```csharp
_harmony = new Harmony(PluginInfo.PLUGIN_GUID);
if (Config.EnableHealthMod.Value) _harmony.PatchAll(typeof(HealthPatch));
if (Config.EnableInventoryMod.Value) _harmony.PatchAll(typeof(InventoryPatch));
```

**Complex transpilers**: use `CodeMatcher` to locate an instruction pattern and edit only there, and fail loudly when the game changes.

```csharp
return new CodeMatcher(instructions)
    .MatchForward(false,
        new CodeMatch(OpCodes.Ldfld, AccessTools.Field(typeof(Player), nameof(Player.maxHealth))),
        new CodeMatch(OpCodes.Ldc_R4, 0.5f))
    .ThrowIfInvalid("maxHealth * 0.5f pattern not found, game version may have changed")
    .Advance(1)
    .SetOperandAndAdvance(0.75f)
    .InstructionEnumeration();
```

## Specific scenarios

**Property accessors**: `[HarmonyPatch(typeof(PlayerStats), "Health", MethodType.Getter)]` with `ref float __result`, or `MethodType.Setter` with `ref float value` (for example `Mathf.Clamp(value, 0, 100)`).

**Constructors**: Harmony's name lookup does **not** resolve constructors; `[HarmonyPatch(typeof(X), ".ctor")]` silently never binds. Use `MethodType.Constructor` (with `argumentTypes` when overloaded, `MethodType.StaticConstructor` for a static one):

```csharp
[HarmonyPatch(typeof(PlayerController), MethodType.Constructor)]
public class ConstructorPatch
{
    [HarmonyPostfix]
    static void Postfix(PlayerController __instance)
        => __instance.gameObject.AddComponent<CustomModComponent>().Initialize();
}
```

On IL2CPP, `AddComponent<T>()` needs the custom type registered first: `ClassInjector.RegisterTypeInIl2Cpp<T>()` (or `[RegisterTypeInIl2Cpp]`) plus an `IntPtr` constructor. On Mono it works as written.

**Iterators**: to *replace* a coroutine, the Prefix must return `bool` and return `false`; a `void` Prefix lets the original run and overwrite `__result`.

```csharp
[HarmonyPatch(typeof(EnemySpawner), "SpawnEnemies")]
public class IteratorPatch
{
    [HarmonyPrefix]
    static bool Prefix(ref IEnumerator __result) { __result = ModifiedSpawnSequence(); return false; }

    static IEnumerator ModifiedSpawnSequence()
    {
        for (int i = 0; i < 10; i++) { SpawnCustomEnemy(); yield return new WaitForSeconds(1f); }
    }
}
```

To change logic *inside* a coroutine, patch the compiler-generated state machine: `[HarmonyPatch(typeof(EnemySpawner), nameof(EnemySpawner.SpawnEnemies), MethodType.Enumerator)]`. HarmonyX redirects to the generated `MoveNext`, where the body lives; patching the outer method only intercepts the moment the iterator is created.

## Error handling and debugging

Never let exceptions escape a patch. Wrap Prefix logic in `try/catch` and `return true` from the catch so the original still runs; log with `Logger.LogError` (message and stack trace). In a Postfix, catch and log.

```csharp
[HarmonyPrefix]
static bool Prefix()
{
    try { return ValidateConditions(); }
    catch (Exception ex) { Logger.LogError($"Prefix patch failed: {ex.Message}"); return true; }
}
```

Debug-only logging patch (`#if DEBUG`): a Prefix taking `object[] __args` logs `string.Join(", ", __args.Select(a => a?.ToString() ?? "null"))`, a Postfix takes `object __result`.

## Performance

Cache expensive per-type decisions in a `Dictionary<Type, bool>` so the Prefix does a lookup after the first call. For transpilers, change only the specific instruction and `yield return` the rest unchanged (for example swap one `Ldc_R4 1.0f` for `2.0f`). Avoid allocations in hot paths and profile critical patches.

## Compatibility and conflicts

- **Detect conflicts**: `harmony.GetPatchedMethods()` and `harmony.GetPatchInfo(method)`; warn when `Prefixes.Count > 1` or `Postfixes.Count > 1`.
- **Priority**: `[HarmonyPriority(Priority.First)]` or `Priority.Last` on a patch method; `[HarmonyBefore("other.mod.id")]` / `[HarmonyAfter(...)]` for ordering against known mods. Unmanaged ordering is nondeterministic.

## Best practices

- Prefix for input validation and early exit; Postfix for output changes and side effects; Transpiler only when those are insufficient. Keep patches small and focused.
- Never let exceptions escape; degrade gracefully; log with context.
- Cache, minimize IL work, avoid hot-path allocations.
- Check for existing patches, use priority for order, expose config options, test with common mod combinations.

## Common pitfalls

- **Null checks.** Check `__instance == null` before use (Unity can destroy the instance between binding and call). In a Postfix also check `__result` for null, and check `__args` entries.
- **`try/catch`.** An unhandled exception in a patch propagates into the game method and typically crashes the process.
- **Signature and binding.** The signature must match exactly: wrong parameter types, wrong static or instance modifier or a typo'd name fail to bind silently (the patch appears to do nothing). Verify the target's signature and visibility in dnSpyEx (the maintained fork; the original dnSpy was archived in 2020), or use `gmf run unity.validate`, which checks that each patch names a type and method that exist in the game's assemblies.
- **Patch logging.** Use `HarmonyFileLog.Enabled = true` (and `Logger.ChannelFilter` to widen channels) during development. Do not use `Harmony.DEBUG` or `FileLog`: BepInEx 5 and MelonLoader ship HarmonyX, where they exist but do nothing. **Inferred:** upstream Harmony 2 documents `Harmony.DEBUG` and `FileLog` as working; the claim holds only for HarmonyX builds.
- **Testing.** Test in isolation first, then with common mod combinations.

## IL2CPP constraints (MelonLoader and BepInEx 6)

For an IL2CPP game (detect with `gmf run game.detect`):

- **Prefix and Postfix work; Transpilers do not**, because interop proxy assemblies have no real IL bodies. Do not write `[HarmonyTranspiler]` there.
- Types come from Il2CppInterop proxies: null-check `__instance` and `__args`, and use `Il2CppSystem.*` collections, not `System.Collections.Generic.*`.
- Full details: `unity.il2cpp.patching`.

## HarmonyX essentials

HarmonyX (bundled by BepInEx and MelonLoader) extends Harmony 2. Injection parameters are as in the table above.

- **All prefixes run even if a prior one skips the original** (upstream Harmony skips the subsequent ones). Use `__runOriginal` to detect a skip. **Inferred:** current upstream Harmony 2 documentation also runs remaining prefixes and exposes `__runOriginal`; verify on the loader's bundled version.
- HarmonyX can patch `extern` and native methods (Harmony throws "method has no body").
- Logging is event-based (`Logger.ChannelFilter`, `HarmonyFileLog.Enabled`).
- `instance.UnpatchAll(string)` is obsolete; use `UnpatchSelf()`, `Harmony.UnpatchID(id)`, or static `Harmony.UnpatchAll()` (unpatches everything, use with care).
