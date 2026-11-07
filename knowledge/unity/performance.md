---
name: unity.debugging.performance
title: Performance profiling for Unity mods
description: What a mod can actually measure (startup, per-frame cost, Harmony patch overhead, allocations and GC), with Stopwatch snippets and the ranked list of common mod performance mistakes.
engine: unity
tags: [performance, profiling, gc, allocation, harmony, startup, frame-time]
confidence: observed
sources: [earlier Unity modding framework notes]
---

# Performance profiling for mods

Measure, do not estimate: a mod's overhead is almost never where it feels like it is. Triage: `unity.debugging`.

## What you can actually measure

| Metric | How | Reliability |
|---|---|---|
| Plugin load time | StartupProfiler (BepInEx.Debug) | Good, direct |
| Method call counts and times | Simple Mono Profiler (BepInEx.Debug) | Good, Mono only |
| Allocation sources | CtorShotgun (BepInEx.Debug) | Rough, counts constructor hits |
| Your own code's timing | `Stopwatch` around it | Good |
| Frame time | `Time.deltaTime` sampled over N frames | Noisy; needs many samples and a controlled scene |
| Total memory | `GC.GetTotalMemory(false)` | Managed heap only; misses native and IL2CPP allocations |

Unity's Profiler window does not attach to a shipped build without a development build and profiler-enabled player, so for a retail game you are limited to in-process measurement. A mod cannot reliably attribute an FPS delta to one patch. Report frame timings as before and after in a controlled scene, naming the scene, never as a single "-0.2 FPS" figure.

## Startup cost

StartupProfiler (install into `BepInEx/patchers/`) reports time in each plugin's `.ctor`, `Awake` and `Start` plus the chainloader total. For your own plugin wrap `Awake` in a `Stopwatch` and log `Init took {ms}ms`. Typical culprits: filesystem scans, eager AssetBundle loads, `Resources.FindObjectsOfTypeAll`, reflection over every loaded assembly.

## Per-frame cost

Sample over many frames; one tells you nothing.

```csharp
private readonly System.Diagnostics.Stopwatch _sw = new();
private double _totalMs; private int _frames;

private void Update()
{
    _sw.Restart();
    // ... your per-frame work ...
    _sw.Stop();
    _totalMs += _sw.Elapsed.TotalMilliseconds;
    if (++_frames >= 600) // ~10 s at 60 fps
    {
        Logger.LogInfo($"Avg {_totalMs / _frames:F4}ms/frame over {_frames} frames");
        _totalMs = 0; _frames = 0;
    }
}
```

A 60 fps frame budget is 16.7 ms for the whole game: 0.1 ms per frame is 0.6 percent, usually irrelevant; 2 ms is 12 percent and will be felt.

## Harmony patch overhead

A patch adds a delegate call plus argument marshalling: small alone, irrelevant on a method called a few times a second. It matters when the target runs thousands of times per frame (per-entity updates, physics callbacks, `OnGUI`), the patch does real work (allocations, `Find*`, LINQ, string formatting), or you patch a property getter in hot loops. Measure with a counter (`if (++_calls % 10000 == 0) Logger.LogInfo($"Patch hit {_calls} times")`); if it climbs by thousands per second, move the work elsewhere or cache.

## Allocation and GC

Unity's GC is non-generational and non-compacting on Mono, so allocation spikes cause visible stutter and per-frame allocation is the usual cause of "my mod makes the game stutter". **Inferred:** Unity 2019 and later offer an incremental GC option that spreads the cost; the spike behaviour above still applies to builds without it.

Estimate allocation with `GC.GetTotalMemory(false)` before and after (approximate, other threads allocate concurrently, but enough to catch a per-frame allocation). Easy-to-miss sources:

- String concatenation and interpolation, including inside a log call filtered out later: the string is built before the level check discards it. Guard with `if (Logger.LogLevel >= LogLevel.Debug)`.
- LINQ in `Update`: every `Where` and `Select` allocates an iterator.
- `foreach` over some collection types boxes the enumerator.
- Lambdas capturing locals allocate a closure per call.
- `GetComponent<T>()` in a loop.

## Common mod performance mistakes

Ranked by how often they cause reported stutter:

1. `FindObjectOfType` or `GameObject.Find` in `Update`: scans the hierarchy each call. Cache; refresh on scene load.
2. `GetComponent` in `Update`: cache in `Awake` or on first use.
3. Per-frame string building, especially for `OnGUI` labels.
4. `OnGUI` itself: called several times per frame (layout and repaint). Draw only; compute in `Update` and cache.
5. Unbounded collections: appended per frame, never cleared.
6. Reflection in a hot path: cache `MethodInfo` and `FieldInfo` in statics; better, `AccessTools.FieldRefAccess` (`unity.reflection`).
7. Eager AssetBundle loading at startup instead of on first use.

Practice, not measurement: fix items 1 to 4 before profiling; they are so consistently the cause that checking them first is faster than instrumenting.
