--[[
    features/teleport.lua — drop-in teleport: absolute coordinates, plus a
    save-location / return-to-saved-location pattern (named waypoints).

    SELF-CONTAINED: copy this file into a mod's Scripts/features/ folder and
    call `require("features.teleport").register(ctx)` from the mod's features
    loader. See FeatureCtx in the structured scaffold's main.lua for the `ctx` contract.

    Waypoints live in an in-memory table only — this module has no file I/O
    of its own (see core/config.lua in the lua-structured template if a host
    mod wants waypoints to persist across sessions).

    UE4SS Lua API used (RE-UE4SS/docs/lua-api/):
      - UEHelpers.GetPlayer()
      - UObject:K2_SetActorLocation(NewLocation, bSweep, OutSweepHitResult, bTeleport)
      - UObject:K2_GetActorLocation()
      - global-functions/registerconsolecommandhandler.md
      - global-functions/registerkeybind.md (opt-in only)
]]

-- UEHelpers ships with UE4SS (Mods/shared), not with this mod; loaded through pcall so the module-reference check does not look for it under Scripts/.
local UEHelpersLoaded, UEHelpers = pcall(require, "UEHelpers")
assert(UEHelpersLoaded, "UEHelpers module not found (it ships with UE4SS in Mods/shared)")

local M = {}

--- name -> { X = number, Y = number, Z = number }, in-memory only. Plain
--- numbers, never the struct returned by K2_GetActorLocation: copy its
--- fields once so the table is independent of the engine object and
--- survives across frames until `tpload` runs.
local Waypoints = {}

local DEFAULT_WAYPOINT = "default"

local function Log(ctx, message)
    if ctx and ctx.log then
        ctx.log(message)
    else
        print("[teleport] " .. tostring(message) .. "\n")
    end
end

--- Teleport the local player's pawn to absolute world coordinates (UU/cm).
--- K2_SetActorLocation(NewLocation, bSweep, OutSweepHitResult, bTeleport):
---   bSweep=false: don't collide-test against the world while moving — a
---   sweep across a long distance collides with everything in between and
---   strands the pawn at the first wall it crosses.
---   bTeleport=true: a discontinuous move, signals physics/replication this
---   is intentional (as opposed to a desync, which would try to rubber-band
---   the actor back to its old position).
--- The destination is passed as a plain Lua table {X=,Y=,Z=} — UE4SS accepts
--- a table in place of a reflected FVector for a struct parameter.
--- @return boolean
function M.teleport_to_coords(x, y, z)
    -- A NaN or infinite coordinate would put the pawn at an undefined location.
    for _, v in ipairs({ x, y, z }) do
        if type(v) ~= "number" or v ~= v or v == math.huge or v == -math.huge then return false end
    end

    local Pawn = UEHelpers.GetPlayer()
    if not (Pawn and Pawn:IsValid()) then return false end

    local targetLoc = { X = x, Y = y, Z = z }
    -- K2_SetActorLocation returns true when the move happened.
    local called, moved = pcall(function() return Pawn:K2_SetActorLocation(targetLoc, false, {}, true) end)
    local ok = called and moved == true
    if not ok then return false end

    -- Zero velocity after teleporting so momentum doesn't carry the pawn
    -- through geometry at the new location.
    pcall(function()
        local MovementComponent = Pawn.CharacterMovement --[[ GAME-SPECIFIC: movement component property name ]]
        if MovementComponent and MovementComponent:IsValid() then
            MovementComponent:StopMovementImmediately()
            MovementComponent.Velocity = { X = 0, Y = 0, Z = 0 }
        end
    end)
    return ok
end

--- Save the player's current location under `name` (default: "default") for
--- a later `tpload`/`tpback`. K2_GetActorLocation() hands back reflected
--- FVector userdata; its fields are read into plain numbers immediately so
--- the saved waypoint doesn't hold a reference that only stays valid for the
--- current frame.
--- @return boolean
function M.save_waypoint(name)
    name = name or DEFAULT_WAYPOINT
    local Pawn = UEHelpers.GetPlayer()
    if not (Pawn and Pawn:IsValid()) then return false end

    local ok, loc = pcall(function() return Pawn:K2_GetActorLocation() end)
    if not (ok and loc) then return false end

    Waypoints[name] = { X = loc.X, Y = loc.Y, Z = loc.Z }
    return true
end

--- Teleport to a previously saved waypoint (default: "default", i.e. the
--- return-to-saved-point case). Returns false if `name` is unknown.
--- @return boolean
function M.load_waypoint(name)
    name = name or DEFAULT_WAYPOINT
    local wp = Waypoints[name]
    if not wp then return false end
    return M.teleport_to_coords(wp.X, wp.Y, wp.Z)
end

--- @param ctx table|nil  # see FeatureCtx in main.lua
function M.register(ctx)
    local prefix = ctx and ctx.command_prefix or ""

    local function TpHandler(FullCommand, Parameters, OutputDevice)
        local params = (type(Parameters) == "table") and Parameters or {}
        local x, y, z = tonumber(params[1]), tonumber(params[2]), tonumber(params[3])
        if not (x and y and z) then
            local msg = "Usage: tp <x> <y> <z>"
            if OutputDevice then OutputDevice:Log(msg) end
            Log(ctx, "tp: " .. msg)
            return true
        end
        local ok = M.teleport_to_coords(x, y, z)
        local msg = ok and string.format("Teleported to (%.1f, %.1f, %.1f)", x, y, z)
            or "Teleport failed: no valid player pawn."
        if OutputDevice then OutputDevice:Log(msg) end
        Log(ctx, msg)
        return true
    end

    local function TpSaveHandler(FullCommand, Parameters, OutputDevice)
        local params = (type(Parameters) == "table") and Parameters or {}
        local name = params[1] or DEFAULT_WAYPOINT
        local ok = M.save_waypoint(name)
        local msg = ok and ("Location '" .. name .. "' saved.") or "Could not save location: no valid player pawn."
        if OutputDevice then OutputDevice:Log(msg) end
        Log(ctx, msg)
        return true
    end

    local function TpLoadHandler(FullCommand, Parameters, OutputDevice)
        local params = (type(Parameters) == "table") and Parameters or {}
        local name = params[1] or DEFAULT_WAYPOINT
        local ok = M.load_waypoint(name)
        local msg = ok and ("Teleported to '" .. name .. "'.")
            or ("Unknown location '" .. name .. "' (or teleport failed).")
        if OutputDevice then OutputDevice:Log(msg) end
        Log(ctx, msg)
        return true
    end

    -- `tpback` is `tpload` with no name argument spelled out as its own
    -- command — the explicit "return to where I saved" verb for the common
    -- single-waypoint case, separate from the general named-waypoint form.
    local function TpBackHandler(FullCommand, Parameters, OutputDevice)
        return TpLoadHandler(FullCommand, {}, OutputDevice)
    end

    local tpCommand = prefix .. "tp"
    local tpSaveCommand = prefix .. "tpsave"
    local tpLoadCommand = prefix .. "tpload"
    local tpBackCommand = prefix .. "tpback"

    if ctx and ctx.register_command then
        ctx.register_command(tpCommand, TpHandler)
        ctx.register_command(tpSaveCommand, TpSaveHandler)
        ctx.register_command(tpLoadCommand, TpLoadHandler)
        ctx.register_command(tpBackCommand, TpBackHandler)
    else
        pcall(RegisterConsoleCommandHandler, tpCommand, TpHandler)
        pcall(RegisterConsoleCommandHandler, tpSaveCommand, TpSaveHandler)
        pcall(RegisterConsoleCommandHandler, tpLoadCommand, TpLoadHandler)
        pcall(RegisterConsoleCommandHandler, tpBackCommand, TpBackHandler)
    end

    if ctx and ctx.keybinds_enabled then
        local keyName = (ctx.keybind_defaults and ctx.keybind_defaults.teleport) or "T"
        local function KeybindHandler()
            if not M.load_waypoint(DEFAULT_WAYPOINT) then
                Log(ctx, "teleport: no saved location (or the move failed); use tpsave first.")
            end
        end
        if ctx.register_keybind then
            -- ctx.register_keybind runs the handler on the game thread.
            ctx.register_keybind(keyName, KeybindHandler)
        elseif type(Key) == "table" and Key[keyName] then
            -- Key callbacks run on the UE4SS event-loop thread; UObject work
            -- belongs on the game thread.
            pcall(RegisterKeyBind, Key[keyName], function() ExecuteInGameThread(KeybindHandler) end)
        end
    end

    Log(ctx, "teleport feature registered (commands: " .. tpCommand .. ", " .. tpSaveCommand ..
        ", " .. tpLoadCommand .. ", " .. tpBackCommand .. ")")
end

return M
