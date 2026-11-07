--[[
    features/godmode.lua — drop-in god mode / invulnerability toggle feature.

    SELF-CONTAINED: copy this file into a mod's Scripts/features/ folder and
    call `require("features.godmode").register(ctx)` from the mod's features
    loader. See FeatureCtx in the structured scaffold's main.lua for the `ctx` contract.

    Four rules this file enforces:

      1. USE THE GAME'S SETTER, NEVER A RAW FIELD WRITE, for anything
         replicated. `Attribs.Health = x` skips OnRep_HealthChanged and the
         OnHealthChangedDelegate broadcast — the HUD and every remote client
         keep showing the old value. `Attribs:SetHealth(x)` fires it.
      2. GOD MODE IS MORE THAN HEALTH. Full health does not: stop the pawn
         from taking damage again next frame, protect it from environmental hazards,
         or stand a downed player back up. All of that has to be set too.
      3. DISABLING RESTORES FROM A LEDGER — NEVER A LITERAL true/false. The
         protection/incapacitation flags below are ALSO driven by the game
         itself (an equipment item, a temporary effect, the downed state), so
         there is no correct constant to write back on disable, only the
         value the field actually held before this mod touched it. A literal
         `false` is safe only when nothing else on the target game ever
         legitimately sets that same flag — do not assume that; assume it is
         shared and always restore from the ledger.
      4. RETRY, DON'T LATCH. The pawn/attributes component may not be valid
         yet (loading screen, respawn, level transition) — a flag that says
         "applied" must only be set once the write actually happened, and
         must be cleared on a level change, because the objects it describes
         are gone with the level.

    UE4SS Lua API used (RE-UE4SS/docs/lua-api/):
      - UEHelpers.GetPlayer() / UEHelpers.GetWorld()
      - global-functions/delayedactions.md  -> LoopInGameThreadWithDelay
      - global-functions/registerhook.md    -> RegisterHook (damage-hook strategy)
      - global-functions/registerconsolecommandhandler.md
      - global-functions/registerkeybind.md (opt-in only)
]]

-- UEHelpers ships with UE4SS (Mods/shared), not with this mod; loaded through pcall so the module-reference check does not look for it under Scripts/.
local UEHelpersLoaded, UEHelpers = pcall(require, "UEHelpers")
assert(UEHelpersLoaded, "UEHelpers module not found (it ships with UE4SS in Mods/shared)")

local M = {}

--------------------------------------------------------------------------------
--  Strategy switch
--------------------------------------------------------------------------------
--
-- "flags"       — the primary, preferred strategy (EnforceGodModeFlags below):
--                  set the game's own health/protection/incapacitation fields
--                  through their setters (or the ledger, for plain booleans
--                  with no setter) every tick. This is the more reliable
--                  strategy on most Character-based games and should be
--                  tried first.
-- "damage_hook" — fallback for a game with NO health/attributes component
--                 reachable via reflection at all: hook the damage-taking
--                 UFunction once and zero the incoming amount while enabled
--                 (InstallDamageHookOnce below). Use this only when
--                 feature-discovery.lua's `discoverclass` on the pawn turns up
--                 no health/attributes-shaped component to set flags on.
local GODMODE_STRATEGY = "flags"
--[[ GAME-SPECIFIC: confirm which strategy applies with feature-discovery.lua's
     discoverclass before shipping. Most Character-based games have an
     attributes/health component and want "flags"; a handful of arcade-style
     games with no such component need "damage_hook". ]]

--------------------------------------------------------------------------------
--  State
--------------------------------------------------------------------------------

local state = {
    enabled = false, -- user intent, set by the command/keybind handlers
    applied = false,  -- whether the "flags" strategy currently has writes in force
}

--------------------------------------------------------------------------------
--  Original-value ledger — rule 3. NO RESTORE PATH BELOW MAY CONTAIN A LITERAL.
--------------------------------------------------------------------------------
--
-- A minimal original-value ledger: snapshot a field's value on the FIRST
-- write only (a second write must never overwrite a genuine original with an
-- already-modified value), and only ever write a field back by handing back
-- what was snapshotted for it.
local ledger = {} -- [objectKey][fieldName] = originalValue

local function valid(o)
    if o == nil then return false end
    local ok, r = pcall(function() return o:IsValid() end)
    return ok and r == true
end

-- Keyed by GetFullName() because UObject userdata cannot carry arbitrary Lua
-- fields and the Lua wrapper table for a given UObject is not stable across
-- lookups. See the level-change note below for this key's one real caveat.
local function ObjKey(obj)
    local ok, n = pcall(function() return obj:GetFullName() end)
    return ok and tostring(n) or tostring(obj)
end

--- Snapshot obj.field if nothing is cached for it yet, then write `value`.
local function LedgerSet(obj, field, value)
    if not valid(obj) then return false end
    local key = ObjKey(obj)
    local fields = ledger[key]
    if fields == nil then
        fields = {}
        ledger[key] = fields
    end
    if fields[field] == nil then
        local ok, current = pcall(function() return obj[field] end)
        -- A read that raised or returned nil is not cached — caching it would
        -- later write nil over a live value; none of the fields this file
        -- touches legitimately hold nil.
        if ok and current ~= nil then fields[field] = current end
    end
    -- Without a snapshot there is nothing to restore later, so the write is
    -- refused: a value that could never be put back must not be written.
    if fields[field] == nil then
        if next(fields) == nil then ledger[key] = nil end
        return false
    end
    return pcall(function() obj[field] = value end) == true
end

--- True when the ledger holds a snapshot for obj.field.
local function LedgerHas(obj, field)
    local fields = ledger[ObjKey(obj)]
    return fields ~= nil and fields[field] ~= nil
end

--- Write the cached original back and drop the entry. Writes NOTHING, and
--- returns false, when nothing was ever snapshotted for obj.field.
local function LedgerRestore(obj, field)
    if not valid(obj) then return false end
    local key = ObjKey(obj)
    local fields = ledger[key]
    if fields == nil then return false end
    local original = fields[field]
    if original == nil then return false end
    local ok = pcall(function() obj[field] = original end)
    if ok then
        fields[field] = nil
        if next(fields) == nil then ledger[key] = nil end
    end
    return ok == true
end

--- Drop the WHOLE ledger without writing anything back — for a level change,
--- when every object it points at (pawn, attributes component, weather
--- component) has already been destroyed with the level and writing to it
--- would raise.
local function LedgerDropAll()
    ledger = {}
end

--------------------------------------------------------------------------------
--  Level-change detection — rule 4 (the "clear applied-flags" half)
--------------------------------------------------------------------------------
--
-- UE4SS Lua has no dedicated "level changed" callback, so this is polled once
-- per enforcement tick: the world object's own identity (its GetFullName())
-- is the signal.
--
-- This is not just cleanup, it is a correctness requirement: GetFullName()'s
-- per-class name index RESETS on a level (re)load, so replaying the same map
-- can hand back a brand-new pawn with a key IDENTICAL to a pawn that was
-- destroyed with the previous level. A ledger entry left over from that old
-- pawn would then be silently applied to (or restored onto) an actor that
-- never actually had it.
local lastWorldKey = nil

local function CheckLevelChange()
    local ok, world = pcall(UEHelpers.GetWorld)
    if not (ok and valid(world)) then return end

    -- The name alone repeats when the same map reloads, so the object's
    -- address is part of the key: a new world object gets a new key even when
    -- its name is identical.
    local addrOk, address = pcall(function() return world:GetAddress() end)
    local key = ObjKey(world) .. "@" .. (addrOk and tostring(address) or "?")
    if key == lastWorldKey then return end

    local first = (lastWorldKey == nil)
    lastWorldKey = key
    if first then return end -- nothing applied yet on the very first tick

    -- Drop, don't restore: the ledger's objects are dead with the level, so a
    -- write to them would raise. state.applied = false makes the next tick
    -- re-apply god mode from scratch against the new level's pawn (if still
    -- enabled), which is exactly what a fresh snapshot should do.
    LedgerDropAll()
    state.applied = false
end

--------------------------------------------------------------------------------
--  Strategy 1 (preferred): flags, via setters + the ledger
--------------------------------------------------------------------------------

local function EnforceGodModeFlags()
    local Pawn = UEHelpers.GetPlayer()
    if not valid(Pawn) then return end -- retry next tick

    local Attribs = Pawn.Attributes --[[ GAME-SPECIFIC: health/attributes component
         property name, e.g. UCharacterAttributesComponent reachable as
         pawn.Attributes. Confirm with feature-discovery.lua. ]]
    if not valid(Attribs) then return end -- retry next tick; never latch `applied` early

    -- Optional: a weather-protection component. nil is fine — every access
    -- below is guarded by `valid(Weather)`.
    local Weather = Pawn.WeatherComponent --[[ GAME-SPECIFIC: optional; omit this whole
         block on a game with no weather-damage system. ]]

    if state.enabled then
        -- Rule 1: the SETTER, never `Attribs.Health = x`, so OnRep_HealthChanged
        -- runs and the HUD/remote clients see the heal.
        local okMax, maxHealth = pcall(function() return Attribs.MaxHealth end) --[[ GAME-SPECIFIC ]]
        if okMax and type(maxHealth) == "number" then
            pcall(function() Attribs:SetHealth(maxHealth) end) --[[ GAME-SPECIFIC: setter name ]]
        end

        -- Rule 2: god mode is more than health. All six of the following are
        -- plain booleans with no dedicated setter on most targets, so they go
        -- through the ledger directly rather than a setter call.
        LedgerSet(Attribs, "bRainProtected", true)      --[[ GAME-SPECIFIC ]]
        LedgerSet(Attribs, "bLightningProtected", true) --[[ GAME-SPECIFIC ]]
        -- Full health does NOT stand a downed player back up — this field
        -- survives a health write completely untouched otherwise.
        LedgerSet(Attribs, "bIsIncapacitated", false)   --[[ GAME-SPECIFIC ]]
        LedgerSet(Pawn, "bCanBeDamaged", false)         -- AActor's own flag; usually stock

        if valid(Weather) then
            LedgerSet(Weather, "bCanTakeWeatherDamage", false) --[[ GAME-SPECIFIC ]]
            LedgerSet(Weather, "bCanGetHitByLightning", false) --[[ GAME-SPECIFIC ]]
        end

        -- Only set true once every write above has actually been attempted
        -- against valid, live objects — never latched ahead of the writes.
        state.applied = true

    elseif state.applied then
        -- Rule 3: RESTORE, never a literal. Each field is also legitimately
        -- driven by the game (equipment item, temporary effect, downed state);
        -- the ledger holds what it actually was before god mode touched it.
        -- `applied` is cleared only once every snapshotted field is back; a
        -- failed restore leaves it set so the next tick tries again.
        local allRestored = true
        local function restore(obj, field)
            if LedgerHas(obj, field) and not LedgerRestore(obj, field) then
                allRestored = false
            end
        end

        restore(Attribs, "bRainProtected")
        restore(Attribs, "bLightningProtected")
        restore(Attribs, "bIsIncapacitated")
        restore(Pawn, "bCanBeDamaged")

        if valid(Weather) then
            restore(Weather, "bCanTakeWeatherDamage")
            restore(Weather, "bCanGetHitByLightning")
        end

        if allRestored then state.applied = false end
    end
end

--------------------------------------------------------------------------------
--  Strategy 2 (fallback): damage-hook, for games with no health attribute
--------------------------------------------------------------------------------
--
-- No field is ever written by this strategy, so there is nothing to restore
-- on disable: the hook stays installed for the mod's lifetime and simply
-- stops zeroing damage the instant `state.enabled` goes false.
--
-- ReceiveAnyDamage is declared on Actor (not Pawn) and is the Blueprint event
-- the engine raises AFTER it has applied the damage. Setting the amount
-- argument to zero changes what script logic reading that argument sees; it
-- does not undo damage already applied, so this strategy is a fallback for
-- games whose damage handling lives in that event, and "flags" stays the default.
local damageHookInstalled = false

-- True when the hooked actor is the local player's pawn.
local function IsPlayerPawn(Context)
    local ok, result = pcall(function()
        local actor = Context:get()
        local pawn = UEHelpers.GetPlayer()
        return valid(actor) and valid(pawn) and actor:GetAddress() == pawn:GetAddress()
    end)
    return ok and result == true
end

local function InstallDamageHookOnce()
    if damageHookInstalled then return end

    local ok = pcall(function()
        RegisterHook(
            "/Script/Engine.Actor:ReceiveAnyDamage", --[[ GAME-SPECIFIC: the actual damage
                 UFunction full name for the target game — confirm via
                 feature-discovery.lua's discoverclass or a ForEachFunction dump.
                 AnyDamage/PointDamage/RadialDamage are the three stock UE
                 damage entry points; hook whichever the target game actually
                 routes damage through. ]]
            function(Context, DamageAmount, DamageType, InstigatedBy, DamageCauser)
                if state.enabled and DamageAmount and DamageAmount.set and IsPlayerPawn(Context) then
                    -- RemoteUnrealParam:set() overrides the value the function
                    -- body sees for this call (see the note above).
                    DamageAmount:set(0.0)
                end
            end
        )
    end)
    -- Latch only on success, so a failed registration is retried on a later tick.
    damageHookInstalled = ok
end

--------------------------------------------------------------------------------
--  Tick — installed ONCE, runs continuously regardless of on/off state
--------------------------------------------------------------------------------
--
-- Deliberately NOT started/stopped by the toggle. If the loop were cancelled
-- the instant the user disables god mode, the `elseif state.applied then`
-- restore branch above would never get a chance to run — the flags would
-- stay stuck at their god-mode values forever. The loop has to keep running
-- after disable specifically so the restore step can happen.
local function Tick()
    CheckLevelChange()

    if GODMODE_STRATEGY == "damage_hook" then
        InstallDamageHookOnce()
        return -- nothing else to enforce per-tick; the hook gates on state.enabled itself
    end

    pcall(EnforceGodModeFlags)
end

local tickInstalled = false

local function EnsureTickInstalled()
    if tickInstalled then return end
    tickInstalled = true
    -- A ~200-250ms cadence is enough for god mode/health/stamina enforcement
    -- (an input-driven feature like noclip needs a tighter ~16ms loop; this
    -- doesn't, since nothing here reads player input).
    LoopInGameThreadWithDelay(250, function() pcall(Tick) end)
end

--------------------------------------------------------------------------------
--  Commands / registration
--------------------------------------------------------------------------------

local function Log(ctx, message)
    if ctx and ctx.log then
        ctx.log(message)
    else
        print("[godmode] " .. tostring(message) .. "\n")
    end
end

local function SetGodModeEnabled(ctx, enabled)
    state.enabled = enabled and true or false
    Log(ctx, "God Mode: " .. (state.enabled and "ENABLED" or "DISABLED"))
end

local function ToggleGodMode(ctx)
    SetGodModeEnabled(ctx, not state.enabled)
end

--- @param ctx table|nil  # see FeatureCtx in main.lua
function M.register(ctx)
    EnsureTickInstalled()

    local commandName = (ctx and ctx.command_prefix or "") .. "godmode"
    local function Handler(FullCommand, Parameters, OutputDevice)
        ToggleGodMode(ctx)
        return true
    end

    if ctx and ctx.register_command then
        ctx.register_command(commandName, Handler)
    else
        pcall(RegisterConsoleCommandHandler, commandName, Handler)
    end

    if ctx and ctx.keybinds_enabled then
        local keyName = (ctx.keybind_defaults and ctx.keybind_defaults.godmode) or "G"
        if ctx.register_keybind then
            ctx.register_keybind(keyName, function() ToggleGodMode(ctx) end)
        elseif type(Key) == "table" and Key[keyName] then
            pcall(RegisterKeyBind, Key[keyName], function() ToggleGodMode(ctx) end)
        end
    end

    Log(ctx, "godmode feature registered (command: " .. commandName .. ")")
end

return M
