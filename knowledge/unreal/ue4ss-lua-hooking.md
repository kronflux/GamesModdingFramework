---
name: unreal.ue4ss.lua.hooking
title: UE4SS Lua API map and safe hooking
description: Task-oriented map of the UE4SS Lua API (lifecycle, finders, calling UFunctions, RegisterHook, keybinds, console commands, game-thread and delayed execution, UEHelpers) and a five-point safe-hooking checklist.
engine: unreal
tags: [ue4ss, lua, api, hooks, registerhook, findfirstof, executeingamethread, delayed-actions, keybinds]
confidence: observed
sources: [earlier Unreal modding framework notes]
---

# UE4SS Lua API map and safe hooking

A task-oriented map of the RE-UE4SS Lua API. For the object model behind it see `unreal.object-model` and `unreal.reflection`. Upstream docs: https://github.com/UE4SS-RE/RE-UE4SS/tree/main/docs/lua-api (page names below are `global-functions/<name>.md`). Do not invent a name or signature; check the upstream page when unsure.

## Mod lifecycle and layout

A Lua mod is a folder under `Mods/` with `scripts/main.lua`, enabled in `Mods/mods.txt` (`MyLuaMod : 1`). Newer builds also honour an `enabled.txt` in the mod folder (`unreal.ue4ss.lua`). `main.lua` runs once at load; register hooks, keybinds and console commands there. Mods reload without restarting the game (GUI console "Restart All Mods", or the hot-reload hotkey, default `Ctrl+R`), so write mods that re-register cleanly.

Every mod has a global `ModRef` (the `Mod` class instance):

- `ModRef:SetSharedVariable(name, value)` / `GetSharedVariable(name)`: cross-mod state, only nil, string, number, bool, UObject and derivatives, lightuserdata; survives hot reload. Do not share transient objects such as actors.
- `ModRef.OnUnload = function() ... end`: cleanup right before unload; you supply it.

## Object discovery

- **`FindFirstOf(shortClassName)`**: first non-default instance by short name (`"Character"`, not `/Script/Engine.Character`). Always `:IsValid()`-check; cannot find CDOs.
- **`FindAllOf(shortClassName)`**: every non-default instance; `nil` or a numerically-indexed table.
- **`FindObject(class, name, excludeFlags?, requireFlags?)`** or **`FindObject(UClass, outer, path, exactMatch)`** (mirrors UE's own).
- **`FindObjects(count, class, name, excludeFlags?, requireFlags?, exactMatch?)`**: up to `count` matches as a table; `0` or `nil` returns all.
- **`StaticFindObject(fullName)`** (for example `"/Script/Engine.Default__GameplayStatics"`) or **`StaticFindObject(UClass, outer, name, exactMatch)`**: the way to retrieve non-instance objects such as a `UClass` or `UFunction`.
- **`ForEachUObject(callback)`**: raw `GUObjectArray` walk; use only when the finders cannot express the query.
- **`NotifyOnNewObject(fullClassName, callback)`**: a construction hook, not a lookup. Fires whenever `StaticConstructObject_Internal` builds an instance of the class or a subclass; callback receives the object; return `true` to unregister; the class need not exist yet. Combine all work for one class into one callback.

What the finder pages do not warn about (`unreal.field-notes`):

- `FindAllOf` and `FindFirstOf` see every loaded world. Scope to the local controller's world, or use a world-scoped singleton or a static finder (notes 5, 11, 24).
- They walk the whole object array per call; never on a tick. Seed once, then follow `NotifyOnNewObject` (note 16).
- `FindFirstOf` returns an invalid object rather than nil on recent builds: test `:IsValid()`, never `not obj` (`unreal.mined-gotchas` G21).
- The class default object is `StaticFindObject("/Script/Module.Default__Class")`; a static UFunction is called on it with the local controller as world context (note 24).
- The `NotifyOnNewObject` callback receives the object although `Types.lua` declares no parameters: `function(...) local obj = ... end` (note 16).

## Loading a class or asset that is not in memory

`StaticFindObject` finds only what is loaded. Use `LoadAsset("<pkg>.BP_X")` (game thread only), then `StaticFindObject("<pkg>.BP_X_C")`. Never pass a path string to a UFunction whose parameter is a soft pointer (`TSoftObjectPtr`, `TSoftClassPtr`, `FSoftObjectPath`, `FSoftClassPath`), for example `KismetSystemLibrary:LoadClassAsset_Blocking`: it crashes in `UE4SS!RC::LuaType::push_softobjectproperty` with no Lua error (note 13, verified). The scaffold helper `load-class` wraps this. There is no `LoadClass` global in UE4SS (https://docs.ue4ss.com/lua-api/global-functions/loadasset.html). A UFunction reached through an object is userdata, so `type(obj.SomeFunction) == "function"` is false even when it exists: call it under `pcall` instead of testing its type.

## Containers: TArray and TMap

Iterate with `:ForEach(function(a, b) ... end)`; elements arrive wrapped, so unwrap with `:get()` under `pcall` and fall back to the raw value. A TMap passes key and value, a TArray index and element. Verified in play (note 25; helper `container-iter`). A struct may be a copy: write it back and read it back (note 12, G26).

## Calling a UFunction

- **`UObject:CallFunction(UFunction, ...)`** calls a UFunction on an instance.
- **`SomeUFunction(args...)`**: `UFunction` has `__call`. If obtained without an owning object (via `StaticFindObject`), pass a `UObject` context first.

Usually neither is explicit: a UFunction member resolves through `UObject.__index`, so `Character:CanJump()` looks up `CanJump` on the class and calls it with `Character` as context.

Find the function in this build's header dump first (`grep -n "Name" CXXHeaderDump/*.hpp`): a name from another mod or version fails silently behind `pcall` (note 20). Count parameters from the header; a missing argument raises nothing useful (G37). Out-struct parameters take `{}`; the reflected actor functions are the `K2_` ones (G29, G30). A call that does not raise did not necessarily work; read state back, and a state change can still have no visible effect (note 21).

## Hooking (RegisterHook)

**`RegisterHook(fullFunctionName, preOrPostCallback, postCallback?)`**:

- Param 1 is the UFunction full name, e.g. `"/Script/Engine.PlayerController:ClientRestart"` (the type prefix has no effect).
- The UFunction must already exist in memory at registration; delegate functions are unsupported.
- For `/Script/` (native) paths, param 2 is the pre-callback and param 3 the optional post-callback. Otherwise (Blueprint functions) param 2 is a post-callback only and param 3 does nothing.
- Returns `PreId, PostId`; both are needed for `UnregisterHook(fullFunctionName, preId, postId)`.

Callback: `function(Context, Param1, Param2, ...)`. `Context` is the `self` pointer and every parameter is a `RemoteUnrealParam`; call `:get()` to unwrap. A `RemoteUnrealParam` points into the hook's call frame and is valid only while the callback runs, so call `:get()` inside the callback and hand the resulting UObject, not the parameter, to any deferred closure such as `ExecuteInGameThread` (https://docs.ue4ss.com/lua-api/classes/remoteunrealparam.html). A callback may `return` a value to override the function's return value; nil leaves it unchanged. `RegisterHook` never fires for functions the engine calls natively (note 4).

Purpose-built lifecycle hooks, each with a single callback and no target name: `RegisterBeginPlayPreHook`/`PostHook` (`AActor::BeginPlay`), `RegisterInitGameStatePreHook`/`PostHook`, `RegisterProcessConsoleExecPreHook`/`PostHook`, `RegisterULocalPlayerExecPreHook`/`PostHook`, `RegisterCallFunctionByNameWithArgumentsPreHook`/`PostHook`. Params need `:Get()` as with `RegisterHook`; check the matching page for the parameter list. (EndPlay hooks: G18.)

## Keybinds

`RegisterKeyBind(key, callback)` or `RegisterKeyBind(key, {ModifierKey...}, callback)`:

```lua
RegisterKeyBind(Key.O, function() print("Key 'O' hit.\n") end)
RegisterKeyBind(Key.O, {ModifierKey.CONTROL, ModifierKey.ALT}, function() print("CTRL+ALT+O hit.\n") end)
```

`Key` and `ModifierKey` are lookup tables (`table-definitions/key.md`, `modifierkey.md`). Callbacks fire only while the game or the debug console has focus. `IsKeyBindRegistered(...)` checks state; read its page for the signature. Keybind callbacks run on the UE4SS event-loop thread, not the game thread, so any UObject work in one must be deferred through `ExecuteInGameThread` (the structured scaffold's `register_keybind` adapter does this and wraps the handler in a guarded call).

## Console commands

- `RegisterConsoleCommandHandler(commandName, callback)`: runs `callback` when the command is entered in the UE console, for the current context. It silently needs `HookProcessConsoleExec = 1` (note 2).
- `RegisterConsoleCommandGlobalHandler(commandName, callback)`: same for all contexts.

Callback `function(FullCommand, Parameters, OutputDevice)`: `Parameters` excludes the command name; `OutputDevice:Log(...)` writes to the console. Return a boolean: `true` means the command was handled and the engine must not process it further; `false` lets the engine carry on, which for a mod-only command usually ends in an "unknown command" message after the handler already ran. Every handler in the scaffold returns `true` (https://docs.ue4ss.com/lua-api/global-functions/registerconsolecommandhandler.html). Command names collide between mods (note 9).

## Thread safety and delayed execution

Callbacks (hooks, keybinds, console commands, timers) are not guaranteed to run on the game thread; touching UObjects off it is unsafe. Use:

- `IsInGameThread()`: whether the current context is the game thread.
- `ExecuteInGameThread(callback, method?)`: runs `callback` on the game thread via the `ProcessEvent` or `EngineTick` hook (optional `EGameThreadMethod.ProcessEvent` or `EngineTick`, otherwise the configured default `DefaultExecuteInGameThreadMethod`, note 1). The standard way to touch UObjects from a keybind or hook.

`ExecuteAsync` and `LoopAsync` are deprecated in favour of the Delayed Actions API (`delayedactions.md`) and run off the game thread (G8):

- `ExecuteInGameThreadWithDelay(delayMs, callback)` returns a `handle`; overload `(handle, delayMs, callback)` with a handle from `MakeActionHandle()` creates the action only if that handle is not already active (like UE's `Delay` node).
- `LoopInGameThreadWithDelay(delayMs, callback)` returns a handle; repeats until `CancelDelayedAction(handle)`. The callback's return value is ignored, so `return true` does not stop the loop; keep the handle and cancel it (https://docs.ue4ss.com/lua-api/global-functions/delayedactions.html).
- `RetriggerableExecuteInGameThreadWithDelay(handle, delayMs, callback)`: debounce; each call resets the timer.
- `ExecuteInGameThreadAfterFrames(frames, callback)` / `LoopInGameThreadAfterFrames(frames, callback)`: frame-based; require `EngineTickAvailable`.
- Control: `CancelDelayedAction`, `PauseDelayedAction`, `UnpauseDelayedAction`, `ResetDelayedActionTimer`, `SetDelayedActionTimer(handle, ms)`, `ClearAllDelayedActions()`, `IsValidDelayedActionHandle`, `IsDelayedActionActive`, `IsDelayedActionPaused`, `GetDelayedActionRate/TimeRemaining/TimeElapsed`.
- Actions belong to the mod that made them; one mod cannot cancel another's handle.
- `ExecuteWithDelay(delayMs, callback)` (fire-and-forget, no handle) still exists; prefer the handle versions.

## UEHelpers

`local UEHelpers = require("UEHelpers")` is the shared module shipped in UE4SS `Mods/shared/UEHelpers/`. It wraps well-known singleton lookups with `ModRef`-backed caching: `GetEngine()`, `GetGameInstance()`, `GetGameViewportClient()`, `GetPlayerController()`, `GetPlayer()`, `GetWorld()`, `GetGameplayStatics()` and more. It is a plain Lua module, not a global, and can change independently of the core API: read the installed file for the exact list.

## Gameplay cheats: no native CheatManager

Build cheats on hooking, finders and property reads and writes, not `CheatManager`, `EnableCheats` or console-exec of cheat commands, which are often stripped or gated on modern builds. See `unreal.cookbook.basic`.

## Safe hooking checklist

`RegisterHook` runs your callback inside the engine's own call stack. A careless hook can crash, corrupt state or hang.

1. **`pcall` the registration.** The UFunction must exist in memory; a wrong name or an unloaded class makes registration fail (G14).

```lua
local function SafeRegisterHook(FunctionName, PreCallback, PostCallback)
    local Ok, PreId, PostId = pcall(RegisterHook, FunctionName, PreCallback, PostCallback)
    if not Ok then
        print(string.format("[MyMod] Failed to hook '%s': %s\n", FunctionName, tostring(PreId)))
        return nil, nil
    end
    return PreId, PostId
end
```

2. **Marshal UObject work onto the game thread.** A callback fires synchronously inside the hooked function; for native functions the thread is not confirmed, so check `IsInGameThread()` and defer reads and writes with `ExecuteInGameThread`. **Inferred:** current UE4SS documentation describes hooks as running on the game thread; the deferral is still needed for anything started from a timer or `LoopAsync`.

```lua
RegisterHook("/Script/Engine.PlayerController:ClientRestart", function(Context, NewPawn)
    -- Unwrap here: Context and NewPawn are valid only while this callback runs.
    local PlayerController = Context:get()
    local Pawn = NewPawn:get()
    ExecuteInGameThread(function()
        if Pawn:IsValid() then print(string.format("NewPawn FullName: %s\n", Pawn:GetFullName())) end
    end)
end)
```

3. **`pcall` the callback body.** An unguarded Lua error inside a hook is worse than one in top-level code, and can escape as a fatal callback exception (G7). Also guard keybind, console, loop and `NotifyOnNewObject` callbacks.

```lua
RegisterHook("/Script/Engine.PlayerController:ClientRestart", function(Context, NewPawn)
    local Ok, Err = pcall(function() local PlayerController = Context:get() --[[ logic ]] end)
    if not Ok then print(string.format("[MyMod] Hook callback error: %s\n", tostring(Err))) end
end)
```

4. **Guard re-entrancy.** If a hook on `/Script/Foo.Bar:Baz` calls `Baz` (directly via `CallFunction` or `__call`, or through engine logic it triggers), the hook fires again before the first call finishes and can recurse to a stack overflow. Use a flag scoped to the hook and reset it even on error (so `pcall` wraps the guarded body, not the flag). See also G11: queue engine calls rather than making them inside a hook.

```lua
local InsideHook = false
RegisterHook("/Script/Foo.Bar:Baz", function(Context, ...)
    if InsideHook then return end
    InsideHook = true
    local Ok, Err = pcall(function() --[[ logic that may trigger Baz ]] end)
    InsideHook = false
    if not Ok then print(string.format("[MyMod] Hook error: %s\n", tostring(Err))) end
end)
```

5. **Unregister when done.** Keep `PreId` and `PostId` for one-shot hooks, `ModRef.OnUnload` cleanup and runtime toggles (G15). The docs' own example unregisters from inside the callback:

```lua
local PreId, PostId
PreId, PostId = RegisterHook("/Script/Engine.PlayerController:ClientRestart", function(Context, NewPawn)
    -- handle the event once
    if PreId then UnregisterHook("/Script/Engine.PlayerController:ClientRestart", PreId, PostId) end
end)
```

`NotifyOnNewObject` unregisters differently: return `true` from its callback; it does not use `UnregisterHook`.
