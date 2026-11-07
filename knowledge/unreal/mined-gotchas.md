---
name: unreal.mined-gotchas
title: Mined gotchas, what shipped UE4SS mods learned
description: Forty numbered gotchas (G1 to G40) recorded by authors of shipped UE4SS mods on paths, threads, hooks, objects, spawning and UI, each labelled observed or inferred.
engine: unreal
tags: [ue4ss, lua, gotchas, hooks, threads, paths, structs, spawning]
confidence: observed
sources: [earlier Unreal modding framework notes]
---

# Mined gotchas: what shipped UE4SS mods learned the hard way

Distilled from shipped UE4SS mods. `unreal.field-notes` holds what was checked directly; this note holds what other authors recorded, so entries are **observed** (read in working code or its comments) or **inferred** (reasoned from it). Never promote either to verified without a test. Ids (G1, G2, ...) are stable for cross-reference.

## Files, paths and settings

**G1. Relative `io.open` paths resolve against `Binaries/Win64`, not the mod folder.** Observed: a keybinds file beside the mod was "silently never read" until the path was absolute. Build paths from the mod's own location:

```lua
local function modDir()
    local src = debug.getinfo(1, "S").source:gsub("^@", "")
    -- <mod>/Scripts/x.lua -> <mod>/ ; the folder may be "Scripts" or "scripts"
    return (src:gsub("[/\\][Ss]cripts[/\\][^/\\]*$", "\\"))
end
```

The `Scripts` case varies; a pattern matching only `Scripts` leaves a lowercase `scripts` path unchanged (a mod never found its config).

**G2. `IterateGameDirectories()` key names vary; search for the entry with `Binaries.Win64`.** Observed: one mod uses the literal key `Game`; the two doc pages disagree. Layouts also vary: `Binaries/WinGDK` versus `Binaries/Win64`, with or without a `ue4ss/` subfolder, sometimes uppercase. Tolerate all.

**G3. Write shared files atomically.** Observed in a mod whose files another process polls: write `<name>.tmp`, `os.rename` over the target, remove-and-retry on failure.

**G4. Merge loaded config over defaults, and keep unknown keys.** Observed: robust mods load JSON or a Lua table, merge recursively over defaults, clamp out-of-range numbers with a logged warning, write a default file when none exists, and fall back to defaults (never raise) on a parse error. ue4ss-ModMenu's store also refuses to overwrite a file it failed to parse (`unreal.modmenu`).

**G5. `ModRef:GetSharedVariable` values survive hot reload.** From the API docs, used by a settings-suite mod: variables "do not get reset when hot-reloading"; legal types are nil, string, number, bool, UObject, lightuserdata.

**G6. `bUseUObjectArrayCache = false` is recommended "for stability" by one author, no reason given.** Unverified. With the cache off every `FindAllOf` walks the real object array, which makes field note 16 matter more.

## Threads, callbacks and errors

**G7. An error escaping a callback can kill the process.** Observed comment: `pcall(nil)` "raises LUA_ERRRUN and escapes UE4SS as a STATUS_FATAL_USER_CALLBACK_EXCEPTION". Wrap every callback body (hook, keybind, loop, delay, console handler) in `pcall`, and look up globals such as `ExecuteInGameThread` inside the `pcall`: they can be transiently nil during UE4SS start and shutdown. `pcall` catching UE errors at all needs UE4SS #833 or later.

**G8. `LoopAsync` and `ExecuteAsync` run on a separate thread.** From the docs, plus races observed in a large mod. Most small mods call UFunctions straight from `LoopAsync` and `ExecuteWithDelay`; treat those as unsafe examples. Use `LoopInGameThreadWithDelay`, or `ExecuteInGameThread` before touching any UObject.

**G9. `ExecuteInGameThread` can accept a closure and never run it on some builds.** Observed on one dedicated-server build: the mod built a starvation detector (a queued closure still pending after 10 s, twice, means degraded mode). `UE4SS-settings.ini` predicts it: `HookEngineTick=0` and `HookUObjectProcessEvent=0` mean the game-thread bridge is unavailable.

**G10. A self-rescheduling `ExecuteWithDelay` loop dies on its first error.** Observed: the reschedule sits after the work. Put the work in `pcall` and reschedule outside it, or use `LoopInGameThreadWithDelay`.

**G11. Do not call back into the engine from inside a hook body; queue it.** Observed in a C++ and a Lua mod: re-entering `ProcessEvent` from a hook is a reentrancy hazard. Record in the hook, act next tick.

**G12. A Lua hook costs every call of the hooked function, even if the body returns at once.** Observed: hooking a per-movement RPC caused rubber-banding on constrained hosts. Hook rare events; poll hot state modestly. C++ side: more than about 10 `ProcessEvent` callbacks a second on a hot path "can silently break UI input".

**G13. Closures can go stale after Lua GC or `RestartMod`.** Claimed, no repro seen, by a large mod that resolves module functions at call time instead of capturing them. Field note 8 covers the related case of anchoring loop closures (inferred).

## Hooks

**G14. A Blueprint function cannot be hooked before its class is loaded.** Docs ("must already exist in memory") and observed: registration at mod load failed with `UFunction::Func: 0x0` and succeeded after a delayed retry. `pcall(RegisterHook, ...)` always; retry on a game-thread timer or `NotifyOnNewObject` of the class, with an attempt cap. `/Script/...` engine and game-module functions are always loaded.

**G15. Unregister before re-registering.** Observed: a mod re-registering on return to the main menu stores `{preId, postId}` and calls `UnregisterHook(path, preId, postId)` first, so hooks do not stack.

**G16. Take hook paths from the dump, not memory.** Observed: four of 51 hand-written Blueprint hook paths omitted directories. Copy `/Game/.../BP_X.BP_X_C:FunctionName` from the object dump's `Function` lines.

**G17. `RegisterBeginPlayPreHook` and similar pass a wrapped parameter: call `:get()`.** The doc's parameter table says `AActor`; its prose and every shipped mod unwrap with `:get()`. Wrapped params have no `IsValid()` or `GetAddress()` until unwrapped.

**G18. `RegisterEndPlayPreHook` and `RegisterEndPlayPostHook` exist but were documented only in the changelog** (UE4SS #769), not in the API pages or `Types.lua`.

**G19. Name suffixes and parameter names do not tell you how a function behaves.** Observed: a team guessed networking from `_S`, `_MC`, `_OC` and was wrong; JMap or UHT flags (`NetMulticast`, `Server`, `Client`) are the truth. A parameter named `NumHours` took degrees. Read the header.

**G20. Engine and game code silently revert one-shot writes.** Observed in a noclip that failed three times: movement mode reset to walking with no notification. Re-assert state on a loop (field note 4's 20 Hz tier) and expect server correction on a client.

## Objects and properties

**G21. `FindFirstOf` returns an invalid object, not nil, on recent builds.** The docs disagree with each other. Test `obj ~= nil and obj:IsValid()`; a `not obj` fallback is dead code. `FindAllOf` returns nil, not an empty table, when nothing matches.

**G22. `FindFirstOf` takes a short class name, never a full object name.** Observed bug: `actor:GetFullName()` passed to test liveness never matches. Keep the object and test `:IsValid()`.

**G23. Compare objects by address.** `a:GetAddress() == b:GetAddress()` avoids two invalid objects comparing equal; shipped mods use it though `__eq` is documented.

**G24. The class default object is `StaticFindObject("/Script/Mod.Default__Class")`; `FindAllOf` skips it.** Writing a CDO only affects objects constructed afterwards, so it suits settings and calculation classes read at use time, not live actors.

**G25. A value often needs its sibling override flag.** Observed: `Cloud Coverage` held only with `Cloud Coverage - Manual Override = true`. When a written value resets, look for a paired `bOverride_*` or `... Override` bool.

**G26. Nested struct writes may land on a copy: read, modify, write back.** Observed in two mods, each with a fallback: try `obj.Struct.Field = v`; if it does not hold, `local s = obj.Struct; s.Field = v; obj.Struct = s`. `ForEach` elements may also be copies; commit with `elem:set(value)`. Log only on change so a repeating line shows the write is being reverted. Field note 12 says which values are copies.

**G27. Structs with unreflected fields cannot be passed as arguments** (UE4SS #777, cited by a mod that abandoned the call). Pass fields individually or avoid the function.

**G28. Blueprint names contain spaces and GUID suffixes.** Index as strings: `obj['Time Of Day']`, `obj['Add input mapping']()`; copy suffixed names such as `Model_3_3D9A95FE4BCD11CBACB1538C41B7403F` exactly from the dump.

**G29. The reflected actor-location functions are the `K2_` ones:** `K2_GetActorLocation`, `K2_GetActorRotation`, `K2_SetActorLocation`. `GetActorLocation` is plain C++ and not callable from Lua (inferred from a mod whose `pcall` swallowed that call).

**G30. Out-struct parameters are passed as `{}`.** `K2_SetActorLocation(loc, false, {}, true)`: the third argument receives the `FHitResult`. Pass `true` for the teleport flag to suppress interpolation, then stop momentum (`StopMovementImmediately()`, or zero physics velocity on the root primitive).

**G31. Enums: never a bare literal, and 0 is truthy.** Observed: a bare `4` for a movement mode "silently drops the player into Swimming"; `saved or DEFAULT` did not fall back when the saved enum was 0, since only nil and false are falsy in Lua. That restore turned collision off and dropped the player through the map.

**G32. Disconnected players leave zombie controllers.** Observed: they stay in `FindAllOf("PlayerController")`. Filter "all players" loops on a valid `Pawn` or a non-zero `PlayerState.CompressedPing`.

**G33. When local identity is ambiguous, return nil.** Resolve the local controller by `IsLocalPlayerController() == true`; if more than one matches, act on none.

**G34. What looks like the wallet may be a statistic.** Observed: writing a controller's `TotalAccumulated...` changed lifetime statistics, not spendable currency. Confirm a currency write by spending it in game.

## Spawning and side effects

**G35. Spawning an arbitrary Blueprint class can crash in its construction script.** Observed: a mod keeps a deny-list of classes "proven crash-prone by a live spawn attempt", since construction scripts can dereference level-only actors. Before listing a class, read the crash dump (field note 14): a class that appears to crash is often a loader problem in the mod (field note 13).

**G36. A call that does not raise did not necessarily work.** Observed rule recorded by a mod author: "Do not interpret a 'called', 'requested', or 'forced output' message as a successful gameplay effect." Read state back or ask the user. Field note 20 covers the silent no-op.

**G37. Missing RPC arguments raise nothing useful.** Observed: `TeleportToLobby(float delay)` called with no argument. Count parameters from the header for every call.

## UI (mostly from a C++ mod; the hazards carry over)

**G38. Modify the live widget; do not spawn a duplicate.** Observed: a standalone-spawned copy of a game widget "has no MainMenu wiring" and its buttons silently broke.

**G39. Remove widgets in two phases.** Hide now, `RemoveFromParent` next frame; removing during the paint pass crashed Slate. Let show/hide animations settle (about 350 ms) before acting on a menu again.

**G40. Do not cache property pointers or UObjects across a world reload.** Re-resolve per use or `IsValid()` first. Clear caches on `RegisterLoadMapPreHook`.

## Version notes

- Some mods require a custom UE4SS build without saying why; check the README before debugging.
- C++ mods are built with configuration `Game__Shipping__Win64` against a UE4SS build matching the installed one.
- IoStore assets (`.ucas`/`.utoc`) could not be mounted by one game's UE4SS mod; treat pak mounting from a mod as game-specific.
- On a dedicated server, `HookProcessConsoleExec = 1` (needed for console commands, field note 2) crashed one game; that mod moved its commands to a file-based remote console.
