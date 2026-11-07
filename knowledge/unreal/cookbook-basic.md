---
name: unreal.cookbook.basic
title: Cookbook, basic UE4SS Lua cheats
description: Working UE4SS Lua recipes for noclip and fly, god mode, infinite health and stamina, economy, item spawn and give, and teleport, built on reflection and hooks rather than stock cheat commands.
engine: unreal
tags: [ue4ss, lua, cookbook, noclip, godmode, health, stamina, economy, spawn, teleport]
confidence: observed
sources: [earlier Unreal modding framework notes]
---

# Cookbook: basic cheats in UE4SS Lua

Adapt these recipes; do not search elsewhere for the same patterns. Every game names its pawn class, movement, health, stamina and item systems differently, so snippets mark per-game parts with `--[[ GAME-SPECIFIC: ... ]]`. Confirm real names with a reflection dump (`unreal.reflection`) or the object and header dumps (`unreal.dumps.artifacts`) before wiring a snippet in. Every reflected access is wrapped in `pcall`: a wrong game-specific name must never crash the tick. The structured Lua scaffold (`unreal.scaffold`, type `lua-structured`) can carry matching drop-in feature modules (godmode, noclip, infinite-health, infinite-stamina, economy, spawn-item, teleport) and helpers (load-class, object-cache, container-iter, session-log, hook-probe) when its templates include them; otherwise write them from the recipes here.

## Reliable by construction, not stock cheat commands

Each recipe implements the gameplay effect directly with reflection and hooks (`RegisterHook`, property reads and writes, `K2_SetActorLocation`, movement state), not the stock `UCheatManager` commands (`Fly`, `Ghost`, `God`, `Walk`, `EnableCheats`) or console-exec of a cheat string. Those commands only touch the movement mode of the pawn class `UCheatManager` expects, so they do nothing on a custom pawn or a non-Character pawn, and `PlayerController.CheatManager` is often `nil` on modern builds.

`CheatManager` is not off-limits as infrastructure for one job: noclip Approach B (pawns with no `CharacterMovement`) needs the engine's `DebugCameraController` via `UCheatManager:EnableDebugCamera()`, with no reflection-only substitute. When `CheatManager` is `nil`, create it with `StaticConstructObject`. Anything reaching through it must ship a working, always-reachable OFF path alongside the ON path.

Related recipes (field notes, checked in play):

- **Full immunity** is god mode, damage multipliers at zero and stun immunity with knock-down undone (`unreal.field-notes` 18).
- **Status effects** (fire, poison, buffs): add the game's own effect data asset through its add-effect function (note 19).
- **Teleport to a vehicle or landmark**: the game's static finder on the CDO, not `FindFirstOf` (note 24).
- **Complete objectives**: walk the quest subsystem, complete through the game's own functions, filter the optional flag, treat value-at-target as done (note 22).
- **Gather items**: teleport with `bTeleport = true`, zero the root primitive's physics velocity, group by class (`unreal.mined-gotchas` G30).
- **In-game menu**: `unreal.modmenu`.

Most of these run as a **per-tick enforcement loop** (re-apply so the game cannot quietly revert it) rather than a one-shot write.

## noclip / fly

Two approaches; the wrong one for the pawn's architecture is the most common reason noclip "does nothing". If the pawn uses `CharacterMovement` (or a game movement component reached the same way), use A. If it has none (a vehicle, a custom simulation actor; a class dump shows no movement component), forcing a movement mode does nothing observable, so use B, the engine's `DebugCameraController` free-cam. The scaffold `noclip` feature implements both behind one `NOCLIP_MODE` switch.

### Approach A: character-based fly, tick-enforced

A naive one-shot version gets two things wrong:

1. **`MOVE_Flying` is `5`, not `4`.** `EMovementMode`: `None=0, Walking=1, NavWalking=2, Falling=3, Swimming=4, Flying=5, Custom=6`. Writing `4` drops the player into Swimming, which looks like flying but behaves wrong, and a re-apply guard that also compares against `4` never notices (see `unreal.mined-gotchas` G31).
2. **The engine, the game or a respawn undoes flight.** Re-check the pawn's actual `MovementMode` every tick (not only your `enabled` flag) and re-apply `MOVE_Flying`, `GravityScale = 0` and no-collision when out of sync. A pawn-identity key (`GetFullName()`) tracks which pawn was last applied to, but is not sufficient: the per-class name index resets on level reload, so a replayed map can return a new pawn with an identical key. The `MovementMode` re-check catches that.

Flying outside the play area can trigger the game's own out-of-bounds or kill-Z logic. Push those fields (GAME-SPECIFIC; a game may enforce fields such as `KillZ` limits and `WorldBoundsMargin` on the character) far out on enable and restore on disable.

```lua
local UEHelpers = require("UEHelpers")
local MOVE_WALKING, MOVE_FLYING = 1, 5                       -- EMovementMode, named not bare
local COLLISION_NONE, COLLISION_QUERY_AND_PHYSICS = 0, 3     -- ECollisionEnabled
local BASE_FLY_SPEED, SPRINT_BOOST = 600.0, 2.5              -- cm/s, held LeftShift multiplier

--[[ GAME-SPECIFIC: bounds/kill-Z fields to push out while flying; empty if none. ]]
local WORLD_BOUNDS_FIELDS = {
    -- { field = "KillZHeightOver", far = 1.0e9 }, { field = "KillZHeightUnder", far = -1.0e9 },
}

local state = { enabled = false, appliedTo = nil, hoverLocation = nil, savedGravity = nil,
                savedCollisionCaptured = false, savedCollision = nil, savedBounds = {} }

local function valid(o)
    if o == nil then return false end
    local ok, r = pcall(function() return o:IsValid() end)
    return ok and r == true
end

local function ResolveMovement(Pawn)
    local ok, mv = pcall(function() return Pawn.CharacterMovement end)
    if ok and valid(mv) then return mv end
    local okFn, mvFn = pcall(function() return Pawn:GetMovementComponent() end) --[[ GAME-SPECIFIC fallback getter ]]
    if okFn and valid(mvFn) then return mvFn end
end

local function ResolveCapsule(Pawn)
    local ok, cap = pcall(function() return Pawn.CapsuleComponent end)
    if ok and valid(cap) then return cap end
    local okFn, capFn = pcall(function() return Pawn:GetCapsuleComponent() end)
    if okFn and valid(capFn) then return capFn end
end

local function PawnKey(Pawn)
    local ok, n = pcall(function() return Pawn:GetFullName() end)
    return ok and tostring(n) or tostring(Pawn)
end

local function PushWorldBounds(Pawn)
    for _, e in ipairs(WORLD_BOUNDS_FIELDS) do
        if state.savedBounds[e.field] == nil then
            local ok, orig = pcall(function() return Pawn[e.field] end)
            if ok then state.savedBounds[e.field] = orig end
        end
        pcall(function() Pawn[e.field] = e.far end)
    end
end

local function RestoreWorldBounds(Pawn)
    for field, orig in pairs(state.savedBounds) do
        if orig ~= nil then pcall(function() Pawn[field] = orig end) end
    end
    state.savedBounds = {}
end

-- Per frame (16 ms): noclip polls WASD and writes Velocity, so slower reads as input lag,
-- unlike the 200-250 ms cadence for god mode, health and stamina.
local function NoclipTick()
    if not (state.enabled or state.appliedTo ~= nil) then return end
    local Pawn = UEHelpers.GetPlayer()
    if not valid(Pawn) then return end
    local Move, Capsule = ResolveMovement(Pawn), ResolveCapsule(Pawn)
    -- Retry next tick instead of latching appliedTo before the writes land.
    if not valid(Move) or not valid(Capsule) then return end
    local key = PawnKey(Pawn)

    if state.enabled then
        local okMode, mode = pcall(function() return Move.MovementMode end)
        if state.appliedTo ~= key or not okMode or mode ~= MOVE_FLYING then
            state.hoverLocation = nil
            pcall(function() Move:SetMovementMode(MOVE_FLYING, 0) end)
            if not state.savedCollisionCaptured then
                local ok, cur = pcall(function() return Capsule.CollisionEnabled end)
                state.savedCollision = ok and cur or nil
                state.savedCollisionCaptured = true
            end
            pcall(function() Capsule:SetCollisionEnabled(COLLISION_NONE) end)
            if state.savedGravity == nil then
                local ok, cur = pcall(function() return Move.GravityScale end)
                state.savedGravity = ok and cur or 1.0
            end
            pcall(function() Move.GravityScale = 0.0 end)
            PushWorldBounds(Pawn)
            state.appliedTo = key
        end
        local PC = UEHelpers.GetPlayerController()
        if not valid(PC) then return end
        local bOk, boost = pcall(function()
            return PC:IsInputKeyDown({ KeyName = FName("LeftShift") }) and SPRINT_BOOST or 1.0
        end)
        pcall(function() Move.MaxFlySpeed = BASE_FLY_SPEED * (bOk and boost or 1.0) end)
        -- WASD + Space/Ctrl camera-relative velocity and hover-pin idle handling go here.
    elseif state.appliedTo ~= nil then
        if state.appliedTo == key then       -- only walk back the pawn this module flew
            pcall(function() Move:SetMovementMode(MOVE_WALKING, 0) end)
            pcall(function() Capsule:SetCollisionEnabled(state.savedCollision or COLLISION_QUERY_AND_PHYSICS) end)
            pcall(function() Move.GravityScale = state.savedGravity or 1.0 end)
            RestoreWorldBounds(Pawn)
        end
        state.appliedTo, state.hoverLocation, state.savedGravity = nil, nil, nil
        state.savedCollisionCaptured = false
    end
end

RegisterConsoleCommandHandler("noclip", function(FullCommand, Parameters, OutputDevice)
    state.enabled = not state.enabled
    OutputDevice:Log("noclip: " .. (state.enabled and "ON" or "OFF (restoring...)"))
    return true
end)

LoopInGameThreadWithDelay(16, function() pcall(NoclipTick) end)
```

### Approach B: DebugCameraController free-cam (non-Character pawns)

`EnableDebugCamera()` ends in `UPlayer::SwitchController`, which reassigns the local player's `PlayerController` to the debug controller. The game controller stops owning the viewport: no HUD, pause menu or game input. Without a working `DisableDebugCamera()` the player is stuck in a free camera with a deaf game, so ship the OFF path in the same command or keybind as ON.

```lua
local freeCam = { originalController = nil }

local function EnsureCheatManager(PC)          -- CheatManager is often nil; create on demand
    local ok, existing = pcall(function() return PC.CheatManager end)
    if ok and valid(existing) then return existing end
    local okC, Class = pcall(function() return PC.CheatClass end)
    if not (okC and valid(Class)) then
        okC, Class = pcall(function() return StaticFindObject("/Script/Engine.CheatManager") end)
    end
    if not (okC and valid(Class)) then return nil end
    local madeOk, Created = pcall(function() return StaticConstructObject(Class, PC) end)
    if not (madeOk and valid(Created)) then return nil end
    if not pcall(function() PC.CheatManager = Created end) then return nil end
    local vOk, Attached = pcall(function() return PC.CheatManager end)   -- verify it persisted
    return (vOk and valid(Attached)) and Attached or nil
end

local function EnableFreeCamNoclip()
    local PC = UEHelpers.GetPlayerController()
    if not valid(PC) then return false end
    local CM = EnsureCheatManager(PC)
    if not CM then return false end
    freeCam.originalController = PC
    return pcall(function() CM:EnableDebugCamera() end)
end

local function DisableFreeCamNoclip()          -- the critical path
    -- While the free camera is active the local player's controller is the debug
    -- controller; the exit goes through ITS CheatManager (unverified against engine source).
    local okF, Debug = pcall(FindFirstOf, "DebugCameraController")
    local PC = (okF and valid(Debug)) and Debug or UEHelpers.GetPlayerController()
    if not valid(PC) then return false end
    local CM = EnsureCheatManager(PC)
    if not CM then return false end
    if not pcall(function() CM:DisableDebugCamera() end) then return false end
    freeCam.originalController = nil              -- clear the state only once the exit worked
    return true
end

RegisterConsoleCommandHandler("noclip", function(FullCommand, Parameters, OutputDevice)
    if freeCam.originalController ~= nil then
        DisableFreeCamNoclip()
        OutputDevice:Log("noclip (free-cam): OFF")
    elseif EnableFreeCamNoclip() then
        OutputDevice:Log("noclip (free-cam): ON, game input is dead until toggled off")
    else
        OutputDevice:Log("noclip (free-cam): FAILED, could not reach or create CheatManager")
    end
    return true
end)
```

## god mode / invulnerability

More than one `Invincible` bool flipped once. A single flag is safe to restore with a literal `false` only when nothing else on the game ever flips it (rule 3). Four rules:

1. **Use the game's SETTER, never a raw field write**, for anything replicated. `Attribs.Health = x` skips `OnRep_HealthChanged` and the broadcast delegate, so the HUD and remote clients keep the old value. `Attribs:SetHealth(x)` fires it.
2. **God mode is more than health.** Full health does not stop the next hit, protect from rain or lightning, or stand a downed player up. Set `bCanBeDamaged = false` on the pawn, the game's protection flags, and clear `bIsIncapacitated` explicitly. See also `unreal.field-notes` 18.
3. **Disabling restores from a ledger, never a literal `true`/`false`.** The flags are also driven by the game (an umbrella, a conductor, the downed state), so the only correct restore value is what the field held before the mod touched it. Snapshot on first write, restore from the snapshot, and drop the ledger without writing on a level change, since its objects are destroyed.
4. **Retry, do not latch "applied".** The pawn or attributes component may be invalid (loading, respawn, transition). Mark applied only after writes land on valid objects and clear it on a level change.

```lua
local ledger = {} -- [GetFullName()][fieldName] = originalValue, first write only

local function LedgerSet(obj, field, value)
    local key = obj:GetFullName()
    ledger[key] = ledger[key] or {}
    if ledger[key][field] == nil then
        local ok, current = pcall(function() return obj[field] end)
        if ok and current ~= nil then ledger[key][field] = current end
    end
    pcall(function() obj[field] = value end)
end

local function LedgerRestore(obj, field)
    local key = obj:GetFullName()
    local original = ledger[key] and ledger[key][field]
    if original == nil then return end
    if pcall(function() obj[field] = original end) then ledger[key][field] = nil end
end

local state = { enabled = false, applied = false }

local function EnforceGodMode()
    local Pawn = UEHelpers.GetPlayer()
    if not (Pawn and Pawn:IsValid()) then return end
    local Attribs = Pawn.Attributes --[[ GAME-SPECIFIC ]]
    if not (Attribs and Attribs:IsValid()) then return end      -- rule 4: retry next tick
    local Weather = Pawn.WeatherComponent --[[ GAME-SPECIFIC, optional ]]

    if state.enabled then
        local okMax, maxHealth = pcall(function() return Attribs.MaxHealth end)
        if okMax and type(maxHealth) == "number" then
            pcall(function() Attribs:SetHealth(maxHealth) end)   -- rule 1
        end
        LedgerSet(Attribs, "bRainProtected", true)               --[[ GAME-SPECIFIC ]]
        LedgerSet(Attribs, "bLightningProtected", true)          --[[ GAME-SPECIFIC ]]
        LedgerSet(Attribs, "bIsIncapacitated", false)            -- full health does not clear this
        LedgerSet(Pawn, "bCanBeDamaged", false)
        if Weather and Weather:IsValid() then
            LedgerSet(Weather, "bCanTakeWeatherDamage", false)   --[[ GAME-SPECIFIC ]]
            LedgerSet(Weather, "bCanGetHitByLightning", false)   --[[ GAME-SPECIFIC ]]
        end
        state.applied = true
    elseif state.applied then
        LedgerRestore(Attribs, "bRainProtected"); LedgerRestore(Attribs, "bLightningProtected")
        LedgerRestore(Attribs, "bIsIncapacitated"); LedgerRestore(Pawn, "bCanBeDamaged")
        if Weather and Weather:IsValid() then
            LedgerRestore(Weather, "bCanTakeWeatherDamage"); LedgerRestore(Weather, "bCanGetHitByLightning")
        end
        state.applied = false
    end
end

RegisterKeyBind(Key.G, function() state.enabled = not state.enabled end)
-- Installed once and runs on or off: the restore branch needs the loop to keep ticking.
LoopInGameThreadWithDelay(250, function() pcall(EnforceGodMode) end)
```

**Damage-hook alternative** for a game with no health or attributes component reachable by reflection (confirm with a class dump): hook the damage `UFunction` and zero the amount while enabled. Nothing is written, so nothing needs restoring. `ReceiveAnyDamage` is declared on `Actor` (not `Pawn`) and is the Blueprint event raised after the engine has applied the damage, so zeroing its argument changes what script logic sees and does not undo damage already applied. Filter `Context:get()` to the player pawn, and prefer the flags strategy above when the game has a health component.

```lua
local preId, postId = RegisterHook(
    "/Script/Engine.Actor:ReceiveAnyDamage", --[[ GAME-SPECIFIC: actual damage UFunction ]]
    function(Context, DamageAmount, DamageType, InstigatedBy, DamageCauser)
        local self = Context:get()
        local pawn = UEHelpers.GetPlayer()
        local isPlayer = valid(self) and valid(pawn) and self:GetAddress() == pawn:GetAddress()
        if state.enabled and isPlayer and DamageAmount and DamageAmount.set then
            DamageAmount:set(0.0) -- RemoteUnrealParam:set() overrides the argument the function sees
        end
    end
)
```

## infinite health

A setter call gated on a comparison, not a one-shot write. Rules: the **setter**, never a raw write (as above); and **gate on the comparison**. The game re-asserts and drains health every frame, so a one-shot write does not hold, but `Health` is replicated, so writing every tick when already full is traffic for nothing. Call `SetHealth` only when `Health < MaxHealth`.

```lua
local function EnforceInfiniteHealth(enabled)
    if not enabled then return end
    local Pawn = UEHelpers.GetPlayer()
    if not (Pawn and Pawn:IsValid()) then return end
    local Attribs = Pawn.Attributes --[[ GAME-SPECIFIC; fall back to Pawn if no component ]]
    if not (Attribs and Attribs:IsValid()) then Attribs = Pawn end
    local okMax, maxHealth = pcall(function() return Attribs.MaxHealth end)
    local okCur, current = pcall(function() return Attribs.Health end)
    if not (okMax and okCur and type(maxHealth) == "number" and type(current) == "number") then return end
    if current < maxHealth then pcall(function() Attribs:SetHealth(maxHealth) end) end --[[ GAME-SPECIFIC setter ]]
end
LoopInGameThreadWithDelay(200, function() EnforceInfiniteHealth(healthCheatEnabled) end)
```

It does not touch `bCanBeDamaged`, protection flags or the incapacitated state; those are god mode. Nothing to restore: `Health` is a live stat the game drains and regenerates, so turning off just stops the loop.

## infinite stamina

Same shape, plus a buff wrinkle. The **setter** (`Attribs:SetStamina(x)` fires `OnStaminaUpdated`; the raw field does not). The **ceiling comes from the game**, not a cached `MaxStamina`: a buff field (a `MaxStaminaBuff`) can raise the real ceiling, usually exposed by an accessor such as `GetEffectiveMaxStamina()`. Topping up to the unbuffed maximum while buffed is a cap, not infinite stamina. Fall back to flat `MaxStamina` only when no accessor exists.

```lua
local function EnforceInfiniteStamina(enabled)
    if not enabled then return end
    local Pawn = UEHelpers.GetPlayer()
    if not (Pawn and Pawn:IsValid()) then return end
    local Attribs = Pawn.Attributes --[[ GAME-SPECIFIC ]]
    if not (Attribs and Attribs:IsValid()) then Attribs = Pawn end
    local okMax, ceiling = pcall(function() return Attribs:GetEffectiveMaxStamina() end) --[[ GAME-SPECIFIC ]]
    if not (okMax and type(ceiling) == "number") then
        okMax, ceiling = pcall(function() return Attribs.MaxStamina end)
    end
    local okCur, current = pcall(function() return Attribs.Stamina end)
    if not (okMax and okCur and type(ceiling) == "number" and type(current) == "number") then return end
    if current < ceiling then pcall(function() Attribs:SetStamina(ceiling) end) end --[[ GAME-SPECIFIC setter ]]
end
LoopInGameThreadWithDelay(200, function() EnforceInfiniteStamina(staminaCheatEnabled) end)
```

Nothing to restore. If the game also exposes a boolean it checks (an `InfiniteStamina`-style flag), flip it through the ledger with restore-on-disable, never a literal `false`.

## economy / currency (set / add money)

Target the game's own economy or currency manager resolved by reflection, never `CheatManager`, which many modern builds disable or strip. Resolve it through a GameState accessor such as `GameState:GetEconomyManager()` (GAME-SPECIFIC), with a plain-property fallback (`GameState.Economy`) and a class-name `FindFirstOf` fallback.

Prefer the manager's own `AddMoney`/`SetMoney` UFunctions over a raw write: a currency value is often mirrored into a save-game object by the game's own functions, so a raw write leaves the HUD's `OnRep_*` callback and the save mirror stale. Only when no UFunction resolves, write the property and invoke the matching `OnRep_*` by hand. Treat a standing "infinite money" toggle as a tracked, restorable effect: snapshot the balance on enable, restore on disable.

```lua
local function GetEconomyManager()
    local GS = UEHelpers.GetGameStateBase()
    if GS and GS:IsValid() then
        local ok, EM = pcall(function() return GS:GetEconomyManager() end) --[[ GAME-SPECIFIC ]]
        if ok and EM and EM:IsValid() then return EM end
        local okP, EP = pcall(function() return GS.Economy end) --[[ GAME-SPECIFIC ]]
        if okP and EP and EP:IsValid() then return EP end
    end
    local okF, Found = pcall(FindFirstOf, "EconomyManager") --[[ GAME-SPECIFIC class name ]]
    if okF and Found and Found:IsValid() then return Found end
end

local function GetMoney()
    local EM = GetEconomyManager()
    if not EM then return nil end
    local ok, money = pcall(function() return EM:GetMoney() end) --[[ GAME-SPECIFIC ]]
    if ok and money ~= nil then return money end
    local okP, pm = pcall(function() return EM.Money end)
    return okP and pm or nil
end

local function SetMoney(amount)
    local EM = GetEconomyManager()
    if not EM then return false end
    if pcall(function() EM:SetMoney(amount) end) then return true end --[[ GAME-SPECIFIC ]]
    local wrote = pcall(function() EM.Money = amount end)
    if wrote then pcall(function() EM:OnRep_Money() end) end --[[ GAME-SPECIFIC callback ]]
    return wrote
end

RegisterConsoleCommandHandler("setmoney", function(FullCommand, Parameters, OutputDevice)
    local amount = tonumber(Parameters[1])
    if not amount then OutputDevice:Log("Usage: setmoney <amount>") return true end
    OutputDevice:Log(SetMoney(amount) and string.format("Money set to %.0f", amount)
        or "Could not find the game's EconomyManager to set money on.")
    return true -- suppress default "unknown command" handling
end)

local infiniteMoneyEnabled, savedMoney, INFINITE = false, nil, 999999
local function SetInfiniteMoneyEnabled(enabled)
    infiniteMoneyEnabled = enabled
    if enabled then savedMoney = savedMoney or GetMoney()
    elseif savedMoney ~= nil then SetMoney(savedMoney); savedMoney = nil end
end
LoopInGameThreadWithDelay(1000, function() if infiniteMoneyEnabled then SetMoney(INFINITE) end end)
```

The scaffold `economy` feature adds an `AddMoney` path through the manager's add UFunction.

## item spawn / give item

Two strategies, in order:

1. **Give into the player's inventory**: resolve the inventory component by reflection (`Pawn.Inventory`, a fallback getter, or a class-name `FindFirstOf`) and call its own add UFunction (`AddItem`, `GiveItem`, `AddItemToInventory`; GAME-SPECIFIC name and arguments). A real grant through the game's object model, not a cheat command.
2. **Spawn a world actor** with `GameplayStatics:BeginDeferredActorSpawnFromClass` + `FinishSpawningActor`, the correct two-step sequence (deferred spawn lets you set properties before `BeginPlay`). Use when no inventory UFunction resolves or a physical drop is wanted.

```lua
local ADD_ITEM_FUNCTION_NAMES = { "AddItem", "GiveItem", "AddItemToInventory" } --[[ GAME-SPECIFIC: trim to the one confirmed name ]]

local function GetInventoryComponent()
    local Pawn = UEHelpers.GetPlayer()
    if Pawn and Pawn:IsValid() then
        local ok, Inv = pcall(function() return Pawn.Inventory end) --[[ GAME-SPECIFIC ]]
        if ok and Inv and Inv:IsValid() then return Inv end
        local okFn, InvFn = pcall(function() return Pawn:GetInventoryComponent() end)
        if okFn and InvFn and InvFn:IsValid() then return InvFn end
    end
    local okF, Found = pcall(FindFirstOf, "InventoryComponent") --[[ GAME-SPECIFIC ]]
    if okF and Found and Found:IsValid() then return Found end
end

local function GiveItemToInventory(ItemId, Count)
    local Inv = GetInventoryComponent()
    if not Inv then return false end
    for _, fn in ipairs(ADD_ITEM_FUNCTION_NAMES) do
        if pcall(function() Inv[fn](Inv, ItemId, Count or 1) end) then return true end
    end
    return false
end

local function SpawnItemActor(ItemClassPath) --[[ GAME-SPECIFIC: "/Game/Blueprints/BP_Item_X.BP_Item_X_C" ]]
    local Pawn = UEHelpers.GetPlayer()
    if not (Pawn and Pawn:IsValid()) then return nil end
    local World, GS = UEHelpers.GetWorld(), UEHelpers.GetGameplayStatics()
    if not (World and World:IsValid() and GS and GS:IsValid()) then return nil end

    local Class
    pcall(function() Class = StaticFindObject(ItemClassPath) end)
    if not (Class and Class:IsValid()) then pcall(function() Class = LoadClass(ItemClassPath) end) end
    if not (Class and Class:IsValid()) then return nil end

    local fwd, loc = Pawn:GetActorForwardVector(), Pawn:K2_GetActorLocation()
    local at = { X = loc.X + fwd.X * 150.0, Y = loc.Y + fwd.Y * 150.0, Z = loc.Z + 50.0 }
    local xf = { Translation = at, Rotation = { X = 0, Y = 0, Z = 0, W = 1 }, Scale3D = { X = 1, Y = 1, Z = 1 } }

    local deferred
    pcall(function() -- (WorldContext, Class, Transform, CollisionHandlingOverride, Owner, SpawnMethod)
        deferred = GS:BeginDeferredActorSpawnFromClass(World, Class, xf, 1, nil, 0)
    end)
    if not (deferred and deferred:IsValid()) then return nil end
    pcall(function() GS:FinishSpawningActor(deferred, xf, 0) end)
    return deferred
end
```

For a class that is not loaded, do not pass a path string to a soft-pointer parameter; use `LoadAsset` then `StaticFindObject` (`unreal.field-notes` 13). Spawning an arbitrary class can crash in its construction script (G35).

## teleport (to coordinates, save location and return)

One reflected call, `K2_SetActorLocation(NewLocation, bSweep, OutSweepHitResult, bTeleport)`, on the local pawn, not a CheatManager command. Two argument choices matter:

- `bSweep = false`: do not collide-test while moving. A sweep over any real distance strands the pawn at the first wall it crosses.
- `bTeleport = true`: marks a discontinuous jump so physics and replication do not rubber-band the actor back.

The destination is a plain table `{X=, Y=, Z=}`; UE4SS accepts a table for a struct parameter.

A common caveat says `K2_GetActorLocation()` returns an `FVector` valid only for the frame it was read, so copy `X/Y/Z` to plain numbers at once. `unreal.field-notes` 12 (verified in the UE4SS source) shows that a struct returned by a UFunction call is copied into a plain Lua table and stays valid across later calls; only a struct read as a property wraps live memory. Copying is harmless and cheap, so the snippet keeps it.

```lua
local function TeleportToCoords(x, y, z)
    local Pawn = UEHelpers.GetPlayer()
    if not (Pawn and Pawn:IsValid()) then return false end
    local ok = pcall(function() Pawn:K2_SetActorLocation({ X = x, Y = y, Z = z }, false, {}, true) end)
    pcall(function() -- zero velocity so momentum does not carry the player through geometry
        local Move = Pawn.CharacterMovement --[[ GAME-SPECIFIC ]]
        if Move and Move:IsValid() then
            Move:StopMovementImmediately()
            Move.Velocity = { X = 0, Y = 0, Z = 0 }
        end
    end)
    return ok
end

local SavedWaypoints = {} -- [name] = { X, Y, Z }

local function SaveWaypoint(name)
    local Pawn = UEHelpers.GetPlayer()
    if not (Pawn and Pawn:IsValid()) then return false end
    local ok, loc = pcall(function() return Pawn:K2_GetActorLocation() end)
    if not (ok and loc) then return false end
    SavedWaypoints[string.lower(name)] = { X = loc.X, Y = loc.Y, Z = loc.Z }
    return true
end

local function TeleportToWaypoint(name)
    local wp = SavedWaypoints[string.lower(name)]
    if not wp then return false end
    return TeleportToCoords(wp.X, wp.Y, wp.Z)
end

RegisterConsoleCommandHandler("tpsave", function(Full, Params, Out)
    local name = (Params[1] and tostring(Params[1])) or "default"
    Out:Log(SaveWaypoint(name) and ("Location '" .. name .. "' saved.") or "Could not save location: no valid player pawn.")
    return true
end)
RegisterConsoleCommandHandler("tpload", function(Full, Params, Out)
    local name = (Params[1] and tostring(Params[1])) or "default"
    if not TeleportToWaypoint(name) then Out:Log("Unknown location '" .. name .. "' (or teleport failed).") end
    return true
end)
RegisterConsoleCommandHandler("tp", function(Full, Params, Out)
    local x, y, z = tonumber(Params[1]), tonumber(Params[2]), tonumber(Params[3])
    if not (x and y and z) then Out:Log("Usage: tp <x> <y> <z>") return true end
    if not TeleportToCoords(x, y, z) then Out:Log("Teleport failed: no valid player pawn.") end
    return true
end)
```

The scaffold `teleport` feature wraps this in the standard `M.register(ctx)` contract and adds `tpback`, `tpload` with no name spelled as its own verb.
