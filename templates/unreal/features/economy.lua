--[[
    features/economy.lua — drop-in economy/currency cheat feature.

    SELF-CONTAINED: copy this file into a mod's Scripts/features/ folder and
    call `require("features.economy").register(ctx)` from the mod's features
    loader. See FeatureCtx in the structured scaffold's main.lua for the `ctx` contract.

    Resolves the game's own economy/currency manager via reflection (a
    GameState getter such as GetEconomyManager(), with fallbacks) and writes
    through its own UFunctions — this avoids native CheatManager, which many
    modern Unreal builds disable, strip, or gate behind a separate enabler
    mod. Prefers the manager's own AddMoney/SetMoney UFunctions over a raw
    property write: a currency value is frequently mirrored into a save-game
    object by the game's own Add/Set function, and a raw field write updates
    only the live in-memory value while OnRep/HUD and the save-game mirror
    both go stale. Falls back to a generic FindFirstOf economy/wallet object
    lookup when the game exposes no game-state-level accessor, and to a
    direct property write (re-invoking the matching OnRep_* handler by hand)
    only if no UFunction resolves.

    Infinite money is enforced as a tracked, restorable effect: the balance
    in place before the effect was enabled is snapshotted and written back
    when the effect is turned off, rather than being abandoned at whatever
    the enforcement loop last set it to.

    UE4SS Lua API used (RE-UE4SS/docs/lua-api/):
      - UEHelpers.GetGameStateBase()
      - global-functions/findfirstof.md
      - global-functions/delayedactions.md -> LoopInGameThreadWithDelay / CancelDelayedAction
      - global-functions/registerconsolecommandhandler.md
      - global-functions/registerkeybind.md (opt-in only)
]]

-- UEHelpers ships with UE4SS (Mods/shared), not with this mod; loaded through pcall so the module-reference check does not look for it under Scripts/.
local UEHelpersLoaded, UEHelpers = pcall(require, "UEHelpers")
assert(UEHelpersLoaded, "UEHelpers module not found (it ships with UE4SS in Mods/shared)")

local M = {}

local INFINITE_MONEY_VALUE = 999999
local infiniteMoneyEnabled = false
local enforceHandle = nil
local savedMoneyBeforeInfinite = nil -- ledger: balance before the effect, restored on disable

local function Log(ctx, message)
    if ctx and ctx.log then
        ctx.log(message)
    else
        print("[economy] " .. tostring(message) .. "\n")
    end
end

local function valid(o)
    if o == nil then return false end
    local ok, r = pcall(function() return o:IsValid() end)
    return ok and r == true
end

--[[ GAME-SPECIFIC: the largest balance the game's currency type holds (a 32-bit
     integer here); amounts beyond it would overflow the game's own field. ]]
local MAX_AMOUNT = 2147483647

--- True for a finite whole number within +/- MAX_AMOUNT (negative only when
--- allowNegative), so NaN, infinities, fractions and overflowing values never
--- reach the game.
local function validAmount(v, allowNegative)
    if type(v) ~= "number" or v ~= v or v == math.huge or v == -math.huge then return false end
    if v ~= math.floor(v) then return false end
    if v > MAX_AMOUNT then return false end
    if v < 0 and not (allowNegative and v >= -MAX_AMOUNT) then return false end
    return true
end

--- Resolve the game's own economy/wallet object via reflection — never through a
--- CheatManager, which many modern UE builds disable or strip outright.
local function GetEconomyManager()
    local GameState = UEHelpers.GetGameStateBase()
    if valid(GameState) then
        local ok, EconomyManager = pcall(function() return GameState:GetEconomyManager() end)
        --[[ GAME-SPECIFIC: accessor UFunction name; some games expose the economy object as a
             plain property (e.g. GameState.Economy) instead of a getter function — try that too. ]]
        if ok and valid(EconomyManager) then return EconomyManager end
        local okProp, EconomyProp = pcall(function() return GameState.Economy end) --[[ GAME-SPECIFIC: fallback property name ]]
        if okProp and valid(EconomyProp) then return EconomyProp end
    end

    -- Fallback: a standalone economy/wallet object findable by class name.
    local okFind, Found = pcall(FindFirstOf, "EconomyManager") --[[ GAME-SPECIFIC: economy object class name ]]
    if okFind and valid(Found) then return Found end
    return nil
end

--- Read the current currency balance straight off the economy object.
--- @return number|nil
function M.get_money()
    local EconomyManager = GetEconomyManager()
    if not EconomyManager then return nil end
    local ok, money = pcall(function() return EconomyManager:GetMoney() end) --[[ GAME-SPECIFIC: getter UFunction name ]]
    if ok and type(money) == "number" then return money end
    local okProp, propMoney = pcall(function() return EconomyManager.Money end) --[[ GAME-SPECIFIC: fallback property name ]]
    if okProp and type(propMoney) == "number" then return propMoney end
    return nil
end

--- Add to the player's currency through the economy object's OWN add UFunction, so
--- whatever OnRep/HUD update and save-game mirroring the game itself performs also
--- fires — the correct way to grant currency without desyncing state the game keeps
--- alongside the live value.
--- @param delta number
--- @return boolean Success
function M.add_money(delta)
    if not validAmount(delta, true) then return false end
    local EconomyManager = GetEconomyManager()
    if not EconomyManager then return false end
    if pcall(function() EconomyManager:AddMoney(delta) end) then return true end --[[ GAME-SPECIFIC: add UFunction name ]]

    -- No add UFunction resolved: fall back to a full set from the current balance.
    local current = M.get_money()
    if type(current) ~= "number" then return false end
    return M.set_money(current + delta)
end

--- Set the player's currency to an exact amount. Prefers the economy object's OWN set
--- UFunction (fires whatever OnRep/HUD/save-mirroring the game wires to it); only falls
--- back to a raw reflected property write, with the matching OnRep_* handler re-invoked
--- by hand, if no UFunction resolves.
--- @param amount number
--- @return boolean Success
function M.set_money(amount)
    if not validAmount(amount, false) then return false end
    local EconomyManager = GetEconomyManager()
    if not EconomyManager then return false end
    if pcall(function() EconomyManager:SetMoney(amount) end) then return true end --[[ GAME-SPECIFIC: set UFunction name ]]

    local wroteProp = pcall(function() EconomyManager.Money = amount end) --[[ GAME-SPECIFIC: money property name ]]
    if wroteProp then
        pcall(function() EconomyManager:OnRep_Money() end) --[[ GAME-SPECIFIC: replication callback, if the game defines one ]]
    end
    return wroteProp
end

--- Enable/disable the infinite-money enforcement loop. On enable, snapshots the current
--- balance into a ledger before overwriting it; on disable, restores that snapshot
--- instead of abandoning the balance at whatever the loop last set it to.
local function SetInfiniteMoneyEnabled(ctx, enabled)
    if enabled == infiniteMoneyEnabled then return end

    if enabled then
        -- Snapshot before the first write. With no readable balance there is
        -- nothing to restore on disable, so refuse to enable.
        if savedMoneyBeforeInfinite == nil then
            savedMoneyBeforeInfinite = M.get_money()
        end
        if savedMoneyBeforeInfinite == nil then
            Log(ctx, "infinite money: cannot read the current balance; not enabling.")
            return
        end
        infiniteMoneyEnabled = true
        if not enforceHandle then
            enforceHandle = LoopInGameThreadWithDelay(1000, function()
                if infiniteMoneyEnabled then M.set_money(INFINITE_MONEY_VALUE) end
            end)
        end
    else
        infiniteMoneyEnabled = false
        if enforceHandle then
            pcall(CancelDelayedAction, enforceHandle)
            enforceHandle = nil
        end
        if savedMoneyBeforeInfinite ~= nil then
            M.set_money(savedMoneyBeforeInfinite)
            savedMoneyBeforeInfinite = nil
        end
    end

    Log(ctx, "infinite money: " .. (enabled and "ON" or "OFF"))
end

--- @param ctx table|nil  # see FeatureCtx in main.lua
function M.register(ctx)
    local prefix = ctx and ctx.command_prefix or ""

    local function SetMoneyHandler(FullCommand, Parameters, OutputDevice)
        local params = (type(Parameters) == "table") and Parameters or {}
        local amount = tonumber(params[1])
        if amount == nil or not validAmount(amount, false) then
            local usage = string.format("Usage: setmoney <amount> (a whole number from 0 to %d)", MAX_AMOUNT)
            if OutputDevice then OutputDevice:Log(usage) end
            Log(ctx, "setmoney: " .. usage)
            return true
        end
        if M.set_money(amount) then
            local msg = string.format("Money set to %.0f", amount)
            if OutputDevice then OutputDevice:Log(msg) end
            Log(ctx, msg)
        else
            local msg = "Could not find the game's EconomyManager to set money on."
            if OutputDevice then OutputDevice:Log(msg) end
            Log(ctx, msg)
        end
        return true
    end

    local function AddMoneyHandler(FullCommand, Parameters, OutputDevice)
        local params = (type(Parameters) == "table") and Parameters or {}
        local delta = tonumber(params[1])
        if delta == nil or not validAmount(delta, true) then
            local usage = string.format("Usage: addmoney <amount> (a whole number from -%d to %d)", MAX_AMOUNT, MAX_AMOUNT)
            if OutputDevice then OutputDevice:Log(usage) end
            Log(ctx, "addmoney: " .. usage)
            return true
        end
        if M.add_money(delta) then
            local msg = string.format("Money +%.0f", delta)
            if OutputDevice then OutputDevice:Log(msg) end
            Log(ctx, msg)
        else
            local msg = "Could not find the game's EconomyManager to add money to."
            if OutputDevice then OutputDevice:Log(msg) end
            Log(ctx, msg)
        end
        return true
    end

    local function ToggleInfiniteMoneyHandler(FullCommand, Parameters, OutputDevice)
        SetInfiniteMoneyEnabled(ctx, not infiniteMoneyEnabled)
        return true
    end

    local setMoneyCommand = prefix .. "setmoney"
    local addMoneyCommand = prefix .. "addmoney"
    local infMoneyCommand = prefix .. "infmoney"

    if ctx and ctx.register_command then
        ctx.register_command(setMoneyCommand, SetMoneyHandler)
        ctx.register_command(addMoneyCommand, AddMoneyHandler)
        ctx.register_command(infMoneyCommand, ToggleInfiniteMoneyHandler)
    else
        pcall(RegisterConsoleCommandHandler, setMoneyCommand, SetMoneyHandler)
        pcall(RegisterConsoleCommandHandler, addMoneyCommand, AddMoneyHandler)
        pcall(RegisterConsoleCommandHandler, infMoneyCommand, ToggleInfiniteMoneyHandler)
    end

    if ctx and ctx.keybinds_enabled then
        local keyName = (ctx.keybind_defaults and ctx.keybind_defaults.economy) or "M"
        local function KeybindHandler() SetInfiniteMoneyEnabled(ctx, not infiniteMoneyEnabled) end
        if ctx.register_keybind then
            ctx.register_keybind(keyName, KeybindHandler)
        elseif type(Key) == "table" and Key[keyName] then
            -- Key callbacks run on the UE4SS event-loop thread; hop to the game thread.
            pcall(RegisterKeyBind, Key[keyName], function() ExecuteInGameThread(KeybindHandler) end)
        end
    end

    Log(ctx, "economy feature registered (commands: " .. setMoneyCommand .. ", " .. addMoneyCommand .. ", " .. infMoneyCommand .. ")")
end

return M
