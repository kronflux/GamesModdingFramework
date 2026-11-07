---
name: unreal.cookbook.advanced
title: Cookbook, advanced UE4SS Lua patterns
description: Safe hooking with clean unregister, cancellable loops, actor iteration and filtering, cached context with checkpoint saves, and struct and array property access in UE4SS Lua.
engine: unreal
tags: [ue4ss, lua, cookbook, hooks, unregister, findallof, struct, array, reflection]
confidence: observed
sources: [earlier Unreal modding framework notes]
---

# Cookbook: advanced patterns

Supporting patterns for `unreal.cookbook.basic`. API names are real; upstream docs are at https://github.com/UE4SS-RE/RE-UE4SS/tree/main/docs/lua-api. Like the basic recipes, nothing here routes through `UCheatManager`; modern builds often strip it.

## Safe hooking: pcall, game thread, clean unregister

`RegisterHook(fullFunctionName, pre, post?)` returns `PreId, PostId`; pass both to `UnregisterHook(fullFunctionName, PreId, PostId)` to remove it. **Inferred:** current UE4SS documentation describes `RegisterHook` as hooking `ProcessEvent`-invoked functions, whose callbacks run on the game thread. Keep the wrapper anyway: `pcall` protects the hook path from a bad name, and `ExecuteInGameThread` is harmless there and required from `LoopAsync` or `ExecuteAsync` (`unreal.mined-gotchas` G8).

```lua
local ActiveHooks = {} -- [key] = { fullName, preId, postId }

local function RegisterSafeHook(key, fullFunctionName, callback)
    local preId, postId = RegisterHook(fullFunctionName, function(Context, ...)
        local ok, err = pcall(function() callback(Context, ...) end)
        if not ok then print(string.format("[mod] hook '%s' callback error: %s\n", fullFunctionName, tostring(err))) end
    end)
    ActiveHooks[key] = { fullName = fullFunctionName, preId = preId, postId = postId }
    return preId, postId
end

local function UnregisterSafeHook(key)
    local hook = ActiveHooks[key]
    if not hook then return false end
    pcall(function() UnregisterHook(hook.fullName, hook.preId, hook.postId) end)
    ActiveHooks[key] = nil
    return true
end

-- Hook, work on the game thread, then unregister (mirrors the docs' fire-once example).
RegisterSafeHook("restart-once", "/Script/Engine.PlayerController:ClientRestart", function(Context, NewPawn)
    local Pawn = NewPawn:get()                           -- params arrive wrapped (G17); valid only inside the hook, so unwrap before deferring
    ExecuteInGameThread(function()
        if Pawn and Pawn:IsValid() then print("restarted with pawn " .. Pawn:GetFullName() .. "\n") end
    end)
    UnregisterSafeHook("restart-once")
end)

-- On unload, drop every hook this mod owns (e.g. before a hot reload re-registers).
ModRef.OnUnload = function() for key in pairs(ActiveHooks) do UnregisterSafeHook(key) end end
```

Repeating loops use `LoopInGameThreadWithDelay(delayMs, callback)`, the current timer API (docs: `delayedactions.md`; `LoopAsync` is deprecated in its favour). It runs on the game thread and returns a handle for `CancelDelayedAction(handle)`. Keep the handle for any loop tied to a toggle:

```lua
local handle = nil
local function SetInfiniteHealthEnabled(enabled)
    if enabled and not handle then
        handle = LoopInGameThreadWithDelay(200, function() --[[ enforcement body ]] end)
    elseif not enabled and handle then
        CancelDelayedAction(handle); handle = nil
    end
end
```

## Actor iteration and filtering

`FindAllOf(shortClassName)` returns every non-default instance, or `nil` when none exist; guard the `nil`. It also returns actors from inactive worlds and walks the whole object array (`unreal.field-notes` 5 and 16).

```lua
local function FindAllMatching(shortClassName, predicate)
    local matches = {}
    local ok, instances = pcall(FindAllOf, shortClassName)
    if not ok or not instances then return matches end
    for _, actor in ipairs(instances) do
        if actor and actor:IsValid() then
            local okName, fullName = pcall(function() return actor:GetFullName() end)
            if okName and not string.find(fullName, "Default__") then
                local okPred, isMatch = pcall(predicate, actor)
                if okPred and isMatch then table.insert(matches, actor) end
            end
        end
    end
    return matches
end

local function FindNearestByName(shortClassName, nameFilter, originLoc)
    local candidates = FindAllMatching(shortClassName, function(actor)
        local okName, name = pcall(function() return actor:GetFName():ToString() end)
        return okName and string.find(name, nameFilter) ~= nil
    end)
    local nearest, nearestDist = nil, math.huge
    for _, actor in ipairs(candidates) do
        local ok, loc = pcall(function() return actor:K2_GetActorLocation() end)
        if ok then
            local dx, dy, dz = loc.X - originLoc.X, loc.Y - originLoc.Y, loc.Z - originLoc.Z
            local dist = math.sqrt(dx * dx + dy * dy + dz * dz)
            if dist < nearestDist then nearest, nearestDist = actor, dist end
        end
    end
    return nearest, nearestDist
end
```

To react the moment an instance is constructed instead of polling, use `NotifyOnNewObject(fullClassName, callback)`: it fires on every construction of the class (subclasses included), the class need not exist when you register, and returning `true` unregisters after that call.

## Save and checkpoint manipulation

Cache the PlayerController, Pawn and GameMode and re-resolve only when a handle goes invalid (a `RemoteObject` handle can go stale), and drive a checkpoint save from a hotkey read from an `.ini` beside the mod (resolve the path from the mod folder, `unreal.mined-gotchas` G1).

```lua
local Ctx = { Player = nil, Pawn = nil, GameMode = nil }

local function RefreshContext()
    local okPC, PC = pcall(FindFirstOf, "PlayerController")
    if okPC and PC and PC:IsValid() then Ctx.Player = PC end
    if Ctx.Player and Ctx.Player:IsValid() then
        local okP, pawn = pcall(function() return Ctx.Player.Pawn end)
        if okP and pawn and pawn:IsValid() then Ctx.Pawn = pawn end
    end
    local okGM, GM = pcall(FindFirstOf, "GameModeBase") --[[ GAME-SPECIFIC class name ]]
    if okGM and GM and GM:IsValid() then Ctx.GameMode = GM end
end

local function GetPawn()
    if not (Ctx.Pawn and Ctx.Pawn:IsValid()) then RefreshContext() end
    return (Ctx.Pawn and Ctx.Pawn:IsValid()) and Ctx.Pawn or nil
end

local function GetGameMode()
    if not (Ctx.GameMode and Ctx.GameMode:IsValid()) then RefreshContext() end
    return (Ctx.GameMode and Ctx.GameMode:IsValid()) and Ctx.GameMode or nil
end

-- Save through the GameMode's own checkpoint function, not by writing save-file bytes.
local function SaveCheckpoint()
    local Pawn, GameMode = GetPawn(), GetGameMode()
    if not (Pawn and GameMode) then return false end
    return pcall(function()
        GameMode:CreateCheckpointAtLocation(Pawn:GetActorLocation(), Pawn:GetActorRotation()) --[[ GAME-SPECIFIC UFunction ]]
    end)
end

local function GetConfigKey(config, keyName, defaultKeyName)
    local s = config[keyName]
    if s and type(s) == "string" and Key[s] then return Key[s] end
    return defaultKeyName and Key[defaultKeyName] or nil
end
-- RegisterKeyBind(Key.F6, SaveCheckpoint) once the configured key is resolved.
```

`SaveCheckpoint` must call `K2_GetActorLocation` and `K2_GetActorRotation`, not `GetActorLocation` and `GetActorRotation`. **Inferred** from `unreal.mined-gotchas` G29, which reports the reflected functions are the `K2_` ones (`K2_GetActorLocation`, `K2_GetActorRotation`) and plain `GetActorLocation` is not callable from Lua. Under `pcall` the call would fail silently; prefer `K2_`.

## Reading and writing struct and array properties

Reflected properties are plain Lua field access (`obj.Prop`, `obj.Prop = v`); two kinds need care:

- **`StructProperty`**: `property:GetStruct()` returns the `UScriptStruct` of the embedded type. The instance is reached through the owning object's field and its members are read and written like a `UObject`'s (it is a `LocalObject`, not `GUObjectArray`-resident). A struct read as a property wraps live memory; a struct returned by a UFunction is a copy (`unreal.field-notes` 12). Nested writes may land on a copy (G26).
- **`ArrayProperty`**: `property:GetInner()` returns the element `Property`. Iterating the array value as a numerically-indexed Lua table with `ipairs` is **inferred** to be unreliable. `unreal.field-notes` 25 verified in play that `TArray` and `TMap` properties are iterated with `ForEach` and elements need `:get()`, some builds hand plain values. Treat `ipairs` and `table.insert` on a `TArray` as unconfirmed per game, and write-back by `table.insert` plus assignment as unverified.

```lua
-- Discover game-specific struct and array field names the basic recipes mark GAME-SPECIFIC.
local function DumpStructAndArrayProperties(obj, label)
    return pcall(function()
        local cls = obj:GetClass()
        if not (cls and cls.ForEachProperty) then return end
        cls:ForEachProperty(function(prop)
            local okName, name = pcall(function() return prop:GetFName():ToString() end)
            if not okName then return end
            local okS, structType = pcall(function() return prop:GetStruct() end)
            if okS and structType then
                print(string.format("[%s] %s : struct %s\n", label, name, structType:GetFName():ToString()))
                return
            end
            local okI, inner = pcall(function() return prop:GetInner() end)
            if okI and inner then
                local okN, innerName = pcall(function() return inner:GetFName():ToString() end)
                print(string.format("[%s] %s : array of %s\n", label, name, okN and innerName or "?"))
            end
        end)
    end)
end

-- Write a struct-typed inventory slot in place. Nested names often carry a GUID suffix
-- (G28); confirm them with the dump helper above before writing blind.
local function SetInventorySlotItem(slot, itemRowName, count)
    if not slot then return false end
    return pcall(function()
        --[[ GAME-SPECIFIC: field names, including GUID suffixes ]]
        slot.ItemDataTable.RowName = itemRowName
        slot.ChangeableData.CurrentStack = count
        slot.ChangeableData.CurrentItemDurability = 100
    end)
end

local function ReadArrayProperty(obj, field)          -- see the array caveat above
    local result = {}
    local ok, arr = pcall(function() return obj[field] end)
    if ok and arr then for i, element in ipairs(arr) do result[i] = element end end
    return result
end

local function AppendToArrayProperty(obj, field, value)   -- unverified, see the array caveat
    return pcall(function()
        local arr = obj[field]
        table.insert(arr, value)
        obj[field] = arr
    end)
end
```
