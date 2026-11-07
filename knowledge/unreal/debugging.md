---
name: unreal.debugging
title: Debugging UE4SS mods, triage
description: Read the UE4SS log and crash dumps first, then classify a failing mod as not loading, bad require path, hook not firing, wrong thread, stale object or a PatternSleuth scan failure, and find the owning fix.
engine: unreal
tags: [ue4ss, debugging, triage, log, crash, hooks, patternsleuth]
confidence: observed
sources: [earlier Unreal modding framework notes]
---

# Debugging UE4SS mods

Triage for a mod that will not load, a hook that never fires, a nil reference, or a crash with UE4SS attached. Read the evidence (the log, a pasted error, a crash), classify it below, then give the fix or point to the note that owns it: install and enable mechanics `unreal.ue4ss.install`, API and thread problems `unreal.ue4ss.lua.hooking`, scan failures `unreal.aob.targets`. Further reading: RE-UE4SS `debugging-a-c++-mod.md` and `fixing-compatibility-problems.md`, https://github.com/UE4SS-RE/RE-UE4SS/tree/main/docs/guides.

## Read the UE4SS log first

- **Location:** `UE4SS.log` beside `ue4ss.dll`, here `<GameInternalName>/Binaries/Win64/UE4SS.log`. A dev build's GUI console mirrors the same lines live.
- **Healthy startup:** fresh timestamps for the current launch (stale ones mean UE4SS never re-injected, an install problem), no `[PS] ... Scan failed` lines, then one block per loaded mod. A mod that logs a boot line (`[<ModName>] Config: ...`, `[<ModName>] Loaded. Console commands: ...`) should show it, with no line containing `FATAL`.
- **Grep for:** `FATAL`, `error`, `Scan failed`, and the mod's own bracketed tag.

**`UE4SS.log` is rewritten on every launch**; if the user relaunched, the evidence is gone. Ask whether the mod keeps its own session log in its folder (`unreal.field-notes` 15) and read that first.

## Crashes: read the dump, not the log

The log stops at the last thing that succeeded, so it cannot name a crash's cause. UE4SS writes `crash_<date>.dmp` beside `UE4SS.log`. Print the top frames of every dump with `cdbX64.exe` (shipped by Microsoft Store WinDbg; never install a debugger without asking), as in `unreal.field-notes` 14. Classify on the top `UE4SS!` frame with a small offset:

- `UE4SS!RC::LuaType::push_softobjectproperty`: a Lua string was passed to a soft object or soft class pointer parameter, typically `KismetSystemLibrary:LoadClassAsset_Blocking(path)`. Fix: `LoadAsset` then `StaticFindObject` (note 13). It looks like "certain items crash" because only classes not yet in memory reach that branch.
- Frames under `Lua::call_function`: the crash was inside a Lua callback; the frames just below name what UE4SS was converting or calling.
- No `UE4SS!` frame: the game crashed itself, possibly on state a mod left behind.

The same top frame in several dumps is one bug. Do not remove a feature as "crashing" until a dump has been read; a class that appears to crash is often a loader problem in the mod (note 13).

## Not a crash, but wrong

- **Frame rate dropped after enabling a feature:** `FindAllOf` or `FindFirstOf` on a tick or loop (note 16). Cache through `NotifyOnNewObject`.
- **Stuck on a loading screen after a "faster start" change:** a delay or minimum duration set to 0 (note 17). Turn the speed-ups off one at a time, newest first, and give the user an off switch that works before the menu.
- **"It says it worked but nothing happened":** the function may not exist in this build (note 20: grep the header dump), the state may have changed with no visible effect (21), or a protection blocks one consequence of a hit but not the others (18). A hook-probe helper (hook every candidate, log which fire) shows which functions really fire.
- **A saved setting "does nothing" after a level change:** it was re-applied before the component existed (note 23).

## Failure classes

### 1. Mod not loading at all

No `[<ModName>]` lines in the log, or the mod is absent from the loaded list.

- **`enabled.txt` missing:** `Mods/<ModName>/enabled.txt` must exist (an empty file; presence, not contents, is checked), unless `mods.txt` enables it.
- **Wrong `Mods/` folder:** copied to the wrong working directory, or to a `Mods/` that `[Overrides] ModsFolderPath` or `ControllingModsTxt` does not point at.
- **Wrong working directory:** UE4SS never injected into the right place (root, working and game executable directory coincide for this install method; `unreal.ue4ss.install`).
- **`mods.txt` disables it:** with `[Overrides] ControllingModsTxt` set, only that `mods.txt` counts; a `ModName : 0` line or a missing line overrides everything else.
- **Fix:** install and enable mechanics, not a code bug (`unreal.ue4ss.install`).

### 2. `require` path wrong or `shared` dependency missing

The log shows `FATAL: could not load module '<name>'` (a structured scaffold's `Need()` helper emits this) or a raw `module '<x>' not found`.

- **Dotted versus slash path:** `require("core.util")` must resolve to `Scripts/core/util.lua` relative to the mod; `require("core/util")` or a wrong base does not resolve the same way on every build.
- **Missing `shared` dependency:** `require("UEHelpers")` fails when `Mods/shared/UEHelpers/UEHelpers.lua` is not deployed beside the mod; vendor it in, do not hand-edit it.
- **Fix:** confirm the module's real path under `Scripts/` and that `shared/` is deployed. Usually a layout bug, not an API bug. `gmf run unreal.validate` checks Lua structure and require references.

### 3. Hook target not found or not firing

`RegisterHook` silently does nothing, or the callback never runs.

- **Wrong function name:** the full UFunction path (`/Script/Engine.PlayerController:ClientRestart` style) must match exactly; a typo fails silently. Cross-check against the object or header dump (`unreal.mined-gotchas` G16).
- **Object or function not in memory yet:** per the docs, "Any UFunction that you attempt to register with RegisterHook must already exist in memory when you register it." Registering at mod load, before the class has spawned an instance or the module loaded, can silently fail; register from `NotifyOnNewObject` or a later point, but not so late that a once-at-startup function has already fired (G14).
- **Delegate functions are unsupported.**
- **Natively invoked functions never fire** (note 4).
- **Fix:** hook signature, `NotifyOnNewObject` timing and alternatives are in `unreal.ue4ss.lua.hooking`.

### 4. Calling on the wrong thread

Crashes or corrupted state when a callback mutates engine state or calls a UFunction from an unsafe context. **Inferred:** current UE4SS documentation describes hooks as running on the game thread; the failures it lists are real for timer, async and delayed contexts (`unreal.mined-gotchas` G8).

- **Symptom:** intermittent crashes, state that only sometimes updates, especially around UI and async callbacks.
- **Fix:** wrap the mutation in `ExecuteInGameThread(function() ... end)`, which runs it "as soon as the game has time", through the `ProcessEvent` or `EngineTick` hook; see `unreal.ue4ss.lua.hooking` for the call shape and the `EngineTickAvailable`/`ProcessEventAvailable` guards.

### 5. Nil UObject or stale reference

`attempt to index a nil value` on something that used to be valid.

- **Never cache a raw UObject across frames without revalidating**: the engine object can be destroyed (level transition, despawn, GC) while the Lua reference lives.
- **`:IsValid()` before every use of a stored reference**; `FindFirstOf`, `FindAllOf` and `FindObject` results are not guaranteed valid later (`unreal.reflection`).
- **Fix:** add the missing guard; if the object must survive a boundary where it might be destroyed, re-fetch it (G40).

### 6. PatternSleuth scan failed (`[PS] ... Scan failed`)

Log lines like `[PS] ... Scan failed` and `You can supply your own AOB in 'UE4SS_Signatures/<Stem>.lua'`. The built-in binary scan could not find a required symbol (`GUObjectArray`, `FName_Constructor`, `StaticConstructObject`, `GMalloc`, ...) in this binary; no Lua-side fix applies. **Fix:** derive and verify a custom signature with `unreal.aob.targets`, through its verification gate; never hand-wave one.

## Triage flow

1. Read the log, or the mod's own session log if the game was relaunched. Grep `FATAL`, `error`, `Scan failed` and the mod's tag. For a crash, read the dump folder before anything else.
2. Match the evidence to classes 1 to 6, in order; most log output maps to exactly one.
3. For classes 1 and 6 hand off to the owning note rather than proposing a fix; for 2 to 5 the fix is usually local enough to state directly, still citing `unreal.ue4ss.lua.hooking` for the API shape.
4. Never launch the game to reproduce or confirm a fix; that is always a human step. Say what the human should do next (relaunch, rerun a self-test, check the log again).
