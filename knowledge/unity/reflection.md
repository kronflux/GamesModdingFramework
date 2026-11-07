---
name: unity.reflection
title: Reflection patterns for Unity mods
description: Reach private game internals with Harmony AccessTools, FieldRefAccess and MethodDelegate, __field injection, generics and nested types, runtime type lookup and caching.
engine: unity
tags: [reflection, accesstools, harmony, fieldrefaccess, private-members, caching, il2cpp]
confidence: observed
sources: [earlier Unity modding framework notes]
---

# Reflection patterns for mods

Prefer Harmony's `AccessTools` over raw `System.Reflection`: it searches public and non-public, instance and static members and walks the inheritance chain, the three things raw reflection gets wrong. General C# patterns: `unity.csharp.patterns`.

## AccessTools basics

```csharp
using HarmonyLib;

FieldInfo   health = AccessTools.Field(typeof(Player), "currentHealth");
PropertyInfo score = AccessTools.Property(typeof(Player), "Score");
MethodInfo    die  = AccessTools.Method(typeof(Player), "Die");
Type      nested   = AccessTools.Inner(typeof(Player), "State");

var value = (float)health.GetValue(playerInstance);
health.SetValue(playerInstance, 100f);

// overloaded method
MethodInfo m = AccessTools.Method(typeof(Player), "TakeDamage", new[] { typeof(float), typeof(DamageType) });
```

`AccessTools.Method` returns `null` rather than throwing when nothing matches. **Null-check during development**: a null is the reflection equivalent of a Harmony binding failure and the reason "my reflection code silently does nothing".

## Fast repeated access

`FieldInfo.GetValue` and `SetValue` box values and are slow in hot paths. Build a ref-accessor once:

```csharp
static readonly AccessTools.FieldRef<Player, float> HealthRef =
    AccessTools.FieldRefAccess<Player, float>("currentHealth");
HealthRef(playerInstance) = 100f;              // direct write, no boxing

static readonly AccessTools.FieldRef<int> CounterRef =
    AccessTools.StaticFieldRefAccess<int>(typeof(GameManager), "counter");
CounterRef() = 0;
```

Much faster than `GetValue`/`SetValue`; the right choice for anything per frame.

## Harmony injection instead of reflection

Inside a patch, inject the field with the triple-underscore form. It is compiled access: faster, and it fails at patch time instead of silently returning null.

```csharp
[HarmonyPatch(typeof(Player), nameof(Player.TakeDamage))]
static class TakeDamagePatch
{
    static void Prefix(Player __instance, ref float ___currentHealth)
        => ___currentHealth = Mathf.Max(___currentHealth, 1f);
}
```

## Calling private methods

```csharp
MethodInfo die = AccessTools.Method(typeof(Player), "Die");
die.Invoke(playerInstance, null);
die.Invoke(playerInstance, new object[] { true, 3 });

static readonly Func<Player, float, bool> CanTakeDamage =
    AccessTools.MethodDelegate<Func<Player, float, bool>>(AccessTools.Method(typeof(Player), "CanTakeDamage"));
```

For repeated calls with the original's exact behaviour, a Harmony reverse patch is the alternative (`unity.harmony.advanced`). `Invoke` wraps any exception from the target in `TargetInvocationException`; log `.InnerException`.

## Generics and nested types

```csharp
Type stateType = AccessTools.Inner(typeof(Player), "State");     // compiler names use +, "Player+State"
Type listOfPlayer = typeof(List<>).MakeGenericType(stateType);
object list = Activator.CreateInstance(listOfPlayer);

MethodInfo concrete = AccessTools.Method(typeof(Manager), "Register").MakeGenericMethod(stateType);
concrete.Invoke(managerInstance, new[] { thing });
```

Compiler-generated closure and iterator classes (`<SpawnEnemies>d__12`) are addressable but **not stable across game updates**; use them as a last resort.

## Finding types at runtime

Never assume the assembly-qualified name: game code may live in `Assembly-CSharp`, `Assembly-CSharp-firstpass`, a plugin assembly or a renamed or merged one.

```csharp
public static Type FindType(string fullName)
{
    foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
    {
        Type t = null;
        try { t = asm.GetType(fullName, throwOnError: false); }
        catch { /* dynamic or unloadable assembly */ }
        if (t != null) return t;
    }
    return null;
}
```

`AccessTools.TypeByName("Namespace.Type")` is the shorter route. When enumerating types guard against `ReflectionTypeLoadException`:

```csharp
try { types = asm.GetTypes(); }
catch (ReflectionTypeLoadException ex) { types = ex.Types.Where(t => t != null).ToArray(); }
```

## Costs and caching

Lookups are expensive; the resulting `MethodInfo` and `FieldInfo` are cheap to keep. Resolve once into a `static readonly` field (`static readonly MethodInfo DieMethod = AccessTools.Method(typeof(Player), "Die");`).

- Resolve in a static constructor or `Awake`, not `Update`.
- Prefer `FieldRefAccess` and `MethodDelegate` over `GetValue` and `Invoke` for anything repeated.
- Inside a patch prefer `___field` injection over any reflection.
- Log loudly on a null lookup: it is a game-version mismatch, and silent failure is the hardest class of mod bug to diagnose.

**IL2CPP:** reflection works on interop proxy types through `AccessTools`, but the proxies are generated wrappers and private *native* members may not be exposed. **Inferred for fields:** interop types expose fields as properties, so `AccessTools.Field` and `___field` injection do not find them (`unity.il2cpp.patching`); use `AccessTools.Property` or direct typed access. See `unity.csharp.patterns`.
