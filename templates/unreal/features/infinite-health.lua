--[[
    features/infinite-health.lua — drop-in infinite health toggle feature.

    SELF-CONTAINED: copy this file into a mod's Scripts/features/ folder and
    call `require("features.infinite-health").register(ctx)` from the mod's
    features loader. See FeatureCtx in the structured scaffold's main.lua for the `ctx` contract.

    Two rules this file enforces:

      1. USE THE GAME'S SETTER, NEVER A RAW FIELD WRITE. `Health` is normally
         a replicated stat with an `OnRep_HealthChanged`-style broadcast tied
         to it; writing `Attribs.Health = x` directly skips that broadcast
         entirely — the HUD and every other client keep showing the OLD
         value, changed for nobody but this mod's own local read of the
         struct. `Attribs:SetHealth(x)` fires the broadcast; the field write
         does not. Every write in this file goes through the setter.
      2. GATE ON THE COMPARISON, not a one-shot write. The game re-asserts
         (and depletes) health every frame on its own, so a single write does
         not hold — but writing every tick unconditionally is also wasteful:
         it is a replicated field, so an unconditional per-tick write is
         replication traffic for no reason on the overwhelmingly common tick
         where health is already full. Only write when Health has actually
         drifted below MaxHealth.

    This file does NOT touch bCanBeDamaged, protection flags, or the
    incapacitated state — those belong to godmode.lua (see its header for why
    full health alone is not god mode). Keeping the two separate keeps each
    file's failure mode independent: a missing/renamed protection flag on the
    target game breaks god mode, not infinite health.

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
--- health/stamina enforcement (an input-driven feature like noclip needs a
--- tighter loop; this doesn't, since nothing here reads player input).
local function EnforceInfiniteHealth()
    if not state.enabled then return end

    local Pawn = UEHelpers.GetPlayer()
    if not valid(Pawn) then return end -- retry next tick

    local Attribs = Pawn.Attributes --[[ GAME-SPECIFIC: health/attributes component
         property name, e.g. UCharacterAttributesComponent reachable as
         pawn.Attributes. On a game with no such component, health may sit
         directly on the pawn instead — try Pawn.Health / Pawn.MaxHealth. ]]
    if not valid(Attribs) then Attribs = Pawn end -- fallback: flat health on the pawn itself

    local okMax, maxHealth = pcall(function() return Attribs.MaxHealth end) --[[ GAME-SPECIFIC ]]
    if not (okMax and type(maxHealth) == "number") then return end -- retry next tick

    local okCur, currentHealth = pcall(function() return Attribs.Health end) --[[ GAME-SPECIFIC ]]
    if not (okCur and type(currentHealth) == "number") then return end

    -- Rule 2: gated on the comparison. In the overwhelmingly common case
    -- (health already full) this is one read and one compare per tick and no
    -- replication traffic at all.
    if currentHealth < maxHealth then
        -- Rule 1: the SETTER, not the field, so OnRep_HealthChanged runs and
        -- the HUD/remote clients see the heal immediately.
        local ok = pcall(function() Attribs:SetHealth(maxHealth) end) --[[ GAME-SPECIFIC: setter name ]]
        if not ok then
            -- Fallback for a game with no SetHealth UFunction at all: write
            -- the field directly, then call the OnRep_ handler by hand so at
            -- least the LOCAL HUD updates (this does not fix remote clients —
            -- that needs an actual replicated setter/RPC on the target game).
            pcall(function() Attribs.Health = maxHealth end)
            -- A UFunction is userdata, not a Lua function, so it cannot be
            -- tested with type(); the pcall absorbs a missing handler.
            pcall(function() Attribs:OnRep_HealthChanged() end) --[[ GAME-SPECIFIC ]]
        end
    end

    -- Disabling: nothing to restore. Unlike godmode.lua's boolean protection
    -- flags (also driven by the game itself — see its ledger), Health is a
    -- live gameplay stat the game continuously drains via damage and refills
    -- via its own regen logic. This file owns no field the game doesn't also
    -- own, so turning `state.enabled` off simply stops this tick from calling
    -- SetHealth — there is no ledger and no restore-from-literal needed,
    -- because there is nothing left in a state the game didn't already put it in.
end

local function Log(ctx, message)
    if ctx and ctx.log then
        ctx.log(message)
    else
        print("[infinite-health] " .. tostring(message) .. "\n")
    end
end

local function SetInfiniteHealthEnabled(ctx, enabled)
    state.enabled = enabled and true or false
    Log(ctx, "infinite-health: " .. (state.enabled and "ON" or "OFF"))
end

local function ToggleInfiniteHealth(ctx)
    SetInfiniteHealthEnabled(ctx, not state.enabled)
end

local tickInstalled = false

local function EnsureTickInstalled()
    if tickInstalled then return end
    tickInstalled = true
    -- Installed ONCE and runs continuously; state.enabled gates the work
    -- inside EnforceInfiniteHealth, not whether the loop itself is running —
    -- there is no restore step here that needs the loop to keep going after
    -- disable (see the note above), but this still matches the same
    -- "register once, gate internally" shape used by godmode.lua so both
    -- files behave identically if copied together.
    local errorLogged = false
    LoopInGameThreadWithDelay(200, function()
        local ok, err = pcall(EnforceInfiniteHealth)
        -- Log the first failure only: a tick that fails every pass would flood the log.
        if not ok and not errorLogged then
            errorLogged = true
            print("[infinite-health] tick error (further errors suppressed): " .. tostring(err) .. "\n")
        end
    end)
end

--- @param ctx table|nil  # see FeatureCtx in main.lua
function M.register(ctx)
    EnsureTickInstalled()

    local commandName = (ctx and ctx.command_prefix or "") .. "infhealth"
    local function Handler(FullCommand, Parameters, OutputDevice)
        ToggleInfiniteHealth(ctx)
        return true
    end

    if ctx and ctx.register_command then
        ctx.register_command(commandName, Handler)
    else
        pcall(RegisterConsoleCommandHandler, commandName, Handler)
    end

    if ctx and ctx.keybinds_enabled then
        local keyName = (ctx.keybind_defaults and ctx.keybind_defaults.infinite_health) or "H"
        if ctx.register_keybind then
            ctx.register_keybind(keyName, function() ToggleInfiniteHealth(ctx) end)
        elseif type(Key) == "table" and Key[keyName] then
            pcall(RegisterKeyBind, Key[keyName], function() ToggleInfiniteHealth(ctx) end)
        end
    end

    Log(ctx, "infinite-health feature registered (command: " .. commandName .. ")")
end

return M
