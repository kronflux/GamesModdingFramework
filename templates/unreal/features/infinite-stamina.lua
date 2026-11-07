--[[
    features/infinite-stamina.lua — drop-in infinite stamina toggle feature.

    SELF-CONTAINED: copy this file into a mod's Scripts/features/ folder and
    call `require("features.infinite-stamina").register(ctx)` from the mod's
    features loader. See FeatureCtx in the structured scaffold's main.lua for the `ctx` contract.

    Two rules this file enforces:

      1. USE THE GAME'S SETTER, NEVER A RAW FIELD WRITE. `Stamina` is
         normally a replicated stat with its own broadcast (e.g.
         `OnStaminaUpdated`); writing `Attribs.Stamina = x` directly skips it,
         so the stamina bar in the HUD (and any remote client's view of it)
         never actually updates — only this mod's local read of the struct
         changes. `Attribs:SetStamina(x)` fires the broadcast; the field
         write does not.
      2. THE CEILING COMES FROM THE GAME, NOT A CACHED MaxStamina. A buff
         field (e.g. a `MaxStaminaBuff`) can raise the real ceiling above the
         base `MaxStamina`, and a game with such a buff typically exposes the
         combined value through its own accessor (e.g.
         `GetEffectiveMaxStamina()`). Topping up to the unbuffed maximum
         while a buff is active is a stamina CAP, not infinite stamina — it
         silently weakens the feature exactly when a buff is active. Always
         ask the game for the ceiling first; only fall back to a flat
         `MaxStamina` when no such accessor exists.

      Gated on the comparison (currentStamina < effectiveMax) rather than an
      unconditional per-tick SetStamina call: Stamina is a replicated field,
      so writing it every tick regardless of whether it changed is
      replication traffic for no reason on the overwhelmingly common tick
      where stamina is already full.

    Disabling: nothing to restore, for the same reason as infinite-health.lua
    — Stamina is a live gameplay stat the game continuously drains via
    sprinting/actions and refills via its own regen logic; this file owns no
    field the game doesn't also own.

    OPTIONAL, GAME-SPECIFIC: some games ALSO expose a dedicated boolean the
    game itself checks (e.g. an `InfiniteStamina`-style flag). If the target
    game has an equivalent flag, it is safe to flip it on alongside
    SetStamina — but disable it through a ledger (see godmode.lua's
    LedgerSet/LedgerRestore), NEVER a literal `false`, in case the target
    game ever drives that same flag for a reason unrelated to this mod.

    UE4SS Lua API used (RE-UE4SS/docs/lua-api/):
      - UEHelpers.GetPlayer()
      - global-functions/delayedactions.md -> LoopInGameThreadWithDelay
      - global-functions/registerconsolecommandhandler.md
      - global-functions/registerkeybind.md (opt-in only)
]]

-- UEHelpers ships with UE4SS (Mods/shared), not with this mod; loaded through pcall so the module-reference check does not look for it under Scripts/.
local UEHelpersLoaded, UEHelpers = pcall(require, "UEHelpers")
assert(UEHelpersLoaded, "UEHelpers module not found (it ships with UE4SS in Mods/shared)")

local M = {}

local state = { enabled = false }

local function valid(o)
    if o == nil then return false end
    local ok, r = pcall(function() return o:IsValid() end)
    return ok and r == true
end

--- Called every ~200ms via LoopInGameThreadWithDelay — enough for god mode/
--- health/stamina enforcement.
local function EnforceInfiniteStamina()
    if not state.enabled then return end

    local Pawn = UEHelpers.GetPlayer()
    if not valid(Pawn) then return end -- retry next tick

    local Attribs = Pawn.Attributes --[[ GAME-SPECIFIC: attributes component property
         name, e.g. UCharacterAttributesComponent reachable as pawn.Attributes.
         On a game with no such component, try Pawn.Stamina / Pawn.MaxStamina
         directly. ]]
    if not valid(Attribs) then Attribs = Pawn end -- fallback: flat stamina on the pawn

    -- Rule 2: the ceiling comes from the game's own accessor, which accounts
    -- for buffs a flat MaxStamina read would miss.
    local okMax, effectiveMax = pcall(function() return Attribs:GetEffectiveMaxStamina() end) --[[ GAME-SPECIFIC:
         getter name; NOT every game exposes a buffed-ceiling accessor — the
         fallback below covers that case, at the cost of the buff-vs-cap gap
         rule 2 describes. ]]
    if not (okMax and type(effectiveMax) == "number") then
        okMax, effectiveMax = pcall(function() return Attribs.MaxStamina end) --[[ GAME-SPECIFIC fallback ]]
    end
    if not (okMax and type(effectiveMax) == "number") then return end -- retry next tick

    local okCur, currentStamina = pcall(function() return Attribs.Stamina end) --[[ GAME-SPECIFIC ]]
    if not (okCur and type(currentStamina) == "number") then return end

    -- Gated on the comparison — see the header note on why, above.
    if currentStamina < effectiveMax then
        -- Rule 1: the SETTER, not the field, so OnStaminaUpdated fires and
        -- the HUD/remote clients see the refill immediately.
        local ok = pcall(function() Attribs:SetStamina(effectiveMax) end) --[[ GAME-SPECIFIC: setter name ]]
        if not ok then
            -- Fallback for a game with no SetStamina UFunction: write the
            -- field directly and call the OnRep_ handler by hand so at least
            -- the local HUD updates (does not fix remote clients).
            pcall(function() Attribs.Stamina = effectiveMax end)
            -- A UFunction is userdata, not a Lua function, so it cannot be
            -- tested with type(); the pcall absorbs a missing handler.
            pcall(function() Attribs:OnRep_StaminaChanged() end) --[[ GAME-SPECIFIC ]]
        end
    end

    --[[ OPTIONAL, GAME-SPECIFIC: if the target game also exposes a dedicated
         boolean the game itself checks (e.g. an `InfiniteStamina` field),
         flip it on here too — but only through a ledger with a
         restore-on-disable, exactly like godmode.lua's protection flags,
         never a literal `false` on disable:

             LedgerSet(Attribs, "InfiniteStamina", true)
         -- and on disable:
             LedgerRestore(Attribs, "InfiniteStamina")

         See godmode.lua for the full LedgerSet/LedgerRestore implementation —
         copy it in if this game needs the flag; most don't, since SetStamina
         gated on the ceiling above is sufficient on its own. ]]
end

local function Log(ctx, message)
    if ctx and ctx.log then
        ctx.log(message)
    else
        print("[infinite-stamina] " .. tostring(message) .. "\n")
    end
end

local function SetInfiniteStaminaEnabled(ctx, enabled)
    state.enabled = enabled and true or false
    Log(ctx, "infinite-stamina: " .. (state.enabled and "ON" or "OFF"))
end

local function ToggleInfiniteStamina(ctx)
    SetInfiniteStaminaEnabled(ctx, not state.enabled)
end

local tickInstalled = false

local function EnsureTickInstalled()
    if tickInstalled then return end
    tickInstalled = true
    LoopInGameThreadWithDelay(200, function() pcall(EnforceInfiniteStamina) end)
end

--- @param ctx table|nil  # see FeatureCtx in main.lua
function M.register(ctx)
    EnsureTickInstalled()

    local commandName = (ctx and ctx.command_prefix or "") .. "infstamina"
    local function Handler(FullCommand, Parameters, OutputDevice)
        ToggleInfiniteStamina(ctx)
        return true
    end

    if ctx and ctx.register_command then
        ctx.register_command(commandName, Handler)
    else
        pcall(RegisterConsoleCommandHandler, commandName, Handler)
    end

    if ctx and ctx.keybinds_enabled then
        local keyName = (ctx.keybind_defaults and ctx.keybind_defaults.infinite_stamina) or "N"
        if ctx.register_keybind then
            ctx.register_keybind(keyName, function() ToggleInfiniteStamina(ctx) end)
        elseif type(Key) == "table" and Key[keyName] then
            pcall(RegisterKeyBind, Key[keyName], function() ToggleInfiniteStamina(ctx) end)
        end
    end

    Log(ctx, "infinite-stamina feature registered (command: " .. commandName .. ")")
end

return M
