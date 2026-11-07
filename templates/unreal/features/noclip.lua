--[[
    features/noclip.lua — drop-in noclip / fly toggle feature.

    SELF-CONTAINED: copy this file into a mod's Scripts/features/ folder and
    call `require("features.noclip").register(ctx)` from the mod's features
    loader (see FeatureCtx in the structured scaffold's main.lua for the full
    `ctx` contract this module — and every other features/*.lua module —
    follows).

    Implements the "noclip / fly" recipe from unreal.cookbook.basic as a
    self-contained, drop-in module. Both approaches below are UE4SS Lua
    patterns.

    TWO APPROACHES — pick ONE via NOCLIP_MODE below, per your target game's
    pawn architecture:

      "character"   (default) — the pawn's movement is driven by an
                      UCharacterMovementComponent (or a game-specific
                      equivalent). Flies the ACTUAL PAWN by forcing
                      MOVE_Flying, zero gravity, and no collision, and
                      RE-ENFORCES this every tick because the engine's own
                      movement code, a respawn, or a scripted sequence can
                      silently knock the pawn back to MOVE_Walking.

      "debugcamera" — the pawn does NOT use CharacterMovement (a vehicle,
                      a custom simulation pawn, a non-Character Actor), so
                      forcing a movement mode on it does nothing. Instead
                      this detaches the local player's VIEW into the
                      engine's own DebugCameraController free-cam via
                      UCheatManager:EnableDebugCamera() — a flying spectator
                      camera independent of the game pawn, including its
                      on-demand CheatManager creation (StaticConstructObject)
                      for games where CheatManager is nil by default.

    UE4SS Lua API used (RE-UE4SS/docs/lua-api/):
      - UEHelpers.GetPlayerController() / UEHelpers.GetPlayer()
      - global-functions/delayedactions.md    -> LoopInGameThreadWithDelay / CancelDelayedAction
      - global-functions/registerconsolecommandhandler.md
      - global-functions/registerkeybind.md   (opt-in only)
      - StaticFindObject / StaticConstructObject (on-demand CheatManager, "debugcamera" mode only)
]]

-- UEHelpers ships with UE4SS (Mods/shared), not with this mod; loaded through pcall so the module-reference check does not look for it under Scripts/.
local UEHelpersLoaded, UEHelpers = pcall(require, "UEHelpers")
assert(UEHelpersLoaded, "UEHelpers module not found (it ships with UE4SS in Mods/shared)")

local M = {}

--------------------------------------------------------------------------------
--  Mode select
--------------------------------------------------------------------------------

--[[ GAME-SPECIFIC: does the target pawn use UCharacterMovementComponent (or a
     game-specific movement component reachable the same way, e.g.
     GetMovementComponent())? If yes, leave this as "character". If the
     pawn is a vehicle/custom simulation actor where movement-mode tricks do
     nothing (confirm via feature-discovery.lua: does the pawn even have a
     movement component?), switch to "debugcamera". ]]
local NOCLIP_MODE = "character" -- "character" | "debugcamera"

local function Log(ctx, message)
    if ctx and ctx.log then
        ctx.log(message)
    else
        print("[noclip] " .. tostring(message) .. "\n")
    end
end

local function valid(o)
    if o == nil then return false end
    local ok, r = pcall(function() return o:IsValid() end)
    return ok and r == true
end

--------------------------------------------------------------------------------
--  APPROACH A: character-based fly, tick-enforced
--
--  MOVE_Flying IS 5, NOT 4. Per EMovementMode: None=0, Walking=1,
--  NavWalking=2, Falling=3, Swimming=4, Flying=5, Custom=6. A `4` here
--  silently drops the player into Swimming, which looks like flying (you
--  leave the ground) but behaves wrong — a real, easy-to-make off-by-one,
--  which is why the constant is named and asserted here rather than left
--  as a bare literal at the call site.
--------------------------------------------------------------------------------

local MOVE_WALKING = 1
local MOVE_FLYING  = 5

-- ECollisionEnabled::Type.
local COLLISION_NONE              = 0
local COLLISION_QUERY_AND_PHYSICS = 3

-- Fly speed in cm/s before the sprint boost. Overridable per mod via ctx.
local BASE_FLY_SPEED = 600.0
local SPRINT_BOOST   = 2.5 -- held LeftShift multiplier

--[[ GAME-SPECIFIC: world-bounds / kill-Z field names — on the pawn itself —
     that a game checks on tick and uses to kill or snap back an actor that
     strays outside the normal play volume. Flying above/outside the map
     without pushing these out first gets the player killed or teleported
     back mid-flight. A game may enforce fields such as KillZ limits and
     WorldBoundsMargin on the character every tick. Confirm your target's equivalent fields (if it has
     any at all — many games have none) via a ForEachProperty dump
     (feature-discovery.lua) before shipping; leave this table empty to skip
     the step entirely. ]]
local WORLD_BOUNDS_FIELDS = {
    -- { field = "KillZHeightOver",   far =  1.0e9 },
    -- { field = "KillZHeightUnder",  far = -1.0e9 },
    -- { field = "WorldBoundsMargin", far =  1.0e9 },
}

local state = {
    -- What the user asked for.
    enabled = false,

    -- GetFullName() of the pawn the enable transition was last pushed to, or
    -- nil when nothing is currently applied.
    --
    -- IMPORTANT: this key RECURS across level loads. GetFullName() embeds a
    -- per-class name index that resets when a level (re)loads, so replaying
    -- the same map can hand back a brand-new pawn with the IDENTICAL key. Do
    -- NOT treat `appliedTo == key` alone as proof the transition already ran
    -- on the pawn standing here — the tick below ALSO re-checks the engine's
    -- own MovementMode every time, which is what actually catches a
    -- respawned/reloaded pawn that this key comparison alone would miss.
    appliedTo = nil,

    -- Position to pin to while no fly-input key is held; nil while moving.
    -- Zero velocity alone is not enough to stop drift: the physics tick still
    -- integrates gravity/impulses even at GravityScale 0 on some builds, so
    -- the pawn is re-pinned to this captured point every idle frame instead.
    hoverLocation = nil,

    -- Saved-once-per-application originals, restored on disable. nil means
    -- "not yet captured for this application", NOT "original value is nil".
    savedGravity = nil,
    savedCollisionCaptured = false,
    savedCollision = nil,
    savedBounds = {}, -- [fieldName] = original value

    speedMultiplier = 1.0,
}

local function resolvePlayerController()
    local pc = UEHelpers.GetPlayerController()
    if not valid(pc) then return nil end
    return pc
end

local function resolveCharacter()
    local pc = resolvePlayerController()
    if not pc then return nil end
    local ok, pawn = pcall(function() return pc.Pawn end)
    if ok and valid(pawn) then return pawn end
    -- Fallback used while spectating / between possessions.
    local okAck, ack = pcall(function() return pc.AcknowledgedPawn end)
    if okAck and valid(ack) then return ack end
    return nil
end

--- Resolve the movement component with a game-specific fallback, needed
--- because not every target exposes the stock Character API names directly.
local function resolveMovement(pawn)
    local ok, mv = pcall(function() return pawn.CharacterMovement end)
    if ok and valid(mv) then return mv end

    --[[ GAME-SPECIFIC: some games rename or wrap the movement component
         behind a Blueprint-exposed getter instead of the stock
         `CharacterMovement` property (e.g. GetMovementComponent() on
         some targets, or a plain `CharacterMovementComponent` property name
         on others). Confirm the real name/getter for your target via
         feature-discovery.lua before relying on this fallback. ]]
    local okFn, mvFn = pcall(function() return pawn:GetMovementComponent() end)
    if okFn and valid(mvFn) then return mvFn end

    local okProp, mvProp = pcall(function() return pawn.CharacterMovementComponent end)
    if okProp and valid(mvProp) then return mvProp end

    return nil
end

--- Resolve the capsule/collision component, same fallback shape as above.
local function resolveCapsule(pawn)
    local ok, cap = pcall(function() return pawn.CapsuleComponent end)
    if ok and valid(cap) then return cap end

    --[[ GAME-SPECIFIC: fallback getter name for the capsule/collision
         component when the stock `CapsuleComponent` property is absent. ]]
    local okFn, capFn = pcall(function() return pawn:GetCapsuleComponent() end)
    if okFn and valid(capFn) then return capFn end

    return nil
end

local function pawnKey(pawn)
    local ok, n = pcall(function() return pawn:GetFullName() end)
    return ok and tostring(n) or tostring(pawn)
end

-- Custom CharacterMovementComponent subclasses can reject MOVE_Flying unless
-- NavAgentProps.bCanFly is set; nested-struct properties need a read/modify/
-- write-back to take effect. Harmless best-effort on components that don't
-- have this at all.
local function enableCanFly(mv)
    pcall(function()
        local nap = mv.NavAgentProps
        if nap ~= nil then
            nap.bCanFly = true
            mv.NavAgentProps = nap
        end
    end)
end

local function pushWorldBounds(pawn)
    for _, entry in ipairs(WORLD_BOUNDS_FIELDS) do
        if state.savedBounds[entry.field] == nil then
            local ok, orig = pcall(function() return pawn[entry.field] end)
            if ok then state.savedBounds[entry.field] = orig end
        end
        pcall(function() pawn[entry.field] = entry.far end)
    end
end

local function restoreWorldBounds(pawn)
    for field, orig in pairs(state.savedBounds) do
        if orig ~= nil then
            pcall(function() pawn[field] = orig end)
        end
    end
    state.savedBounds = {}
end

--- Forget every original saved for the current application.
local function clearSavedState()
    state.savedGravity = nil
    state.savedCollisionCaptured = false
    state.savedCollision = nil
    state.savedBounds = {}
end

--- Forget the applied pawn and everything saved for it.
local function clearAppliedState()
    state.appliedTo = nil
    state.hoverLocation = nil
    clearSavedState()
end

local function keyDown(pc, keyName)
    local ok, r = pcall(function() return pc:IsInputKeyDown({ KeyName = FName(keyName) }) end)
    return ok and r == true
end

-- Out-param scratch for K2_SetActorLocationAndRotation's FHitResult; reused
-- rather than allocated fresh every idle frame.
local sweepScratch = {}

--- Does the tick have anything to do? Both halves matter: `enabled` alone
--- would skip the RESTORE transition the instant `noclip off` is issued,
--- because that transition runs on `appliedTo` the tick AFTER enabled goes
--- false — an early-out on `enabled` alone would strand the player
--- weightless and collisionless while the feature reports OFF.
local function needsTick()
    return state.enabled or state.appliedTo ~= nil
end

local function applyEnableTransition(pawn, mv, capsule, key)
    -- Cleared inside the transition (not gated on the key comparison alone):
    -- a stale hoverLocation from a previous application would pin the new
    -- pawn to the OLD pawn's coordinates on the very next idle frame.
    state.hoverLocation = nil

    enableCanFly(mv)
    pcall(function() mv:SetMovementMode(MOVE_FLYING, 0) end)
    -- Belt-and-suspenders: some builds only honor the property write, others
    -- only the setter call. Both are cheap and idempotent.
    pcall(function() mv.MovementMode = MOVE_FLYING end)

    if not state.savedCollisionCaptured then
        -- CollisionEnabled is not a reflected property on the primitive
        -- component; the getter is the readable path.
        local ok, cur = pcall(function() return capsule:GetCollisionEnabled() end)
        state.savedCollision = ok and cur or nil
        state.savedCollisionCaptured = true
    end
    pcall(function() capsule:SetCollisionEnabled(COLLISION_NONE) end)

    if state.savedGravity == nil then
        local ok, cur = pcall(function() return mv.GravityScale end)
        state.savedGravity = ok and cur or 1.0
    end
    pcall(function() mv.GravityScale = 0.0 end)

    pushWorldBounds(pawn)

    state.appliedTo = key
end

local function applyDisableTransition(pawn, mv, capsule)
    pcall(function() mv:SetMovementMode(MOVE_WALKING, 0) end)
    pcall(function() mv.MovementMode = MOVE_WALKING end)
    pcall(function()
        capsule:SetCollisionEnabled(state.savedCollision or COLLISION_QUERY_AND_PHYSICS)
    end)
    pcall(function() mv.GravityScale = state.savedGravity or 1.0 end)
    pcall(function() mv.Velocity = { X = 0.0, Y = 0.0, Z = 0.0 } end)
    restoreWorldBounds(pawn)

    state.savedGravity = nil
    state.savedCollisionCaptured = false
    state.savedCollision = nil
end

--- Per-frame tick. Re-checks the engine's own MovementMode every call — not
--- just this module's `enabled` flag — because a respawn, a scripted
--- sequence, or the game's own movement code can knock the pawn out of
--- Flying without this module being told. Retries next tick (never latches
--- `appliedTo` early) if the movement/capsule components aren't resolvable
--- yet, so a pawn that spawns a frame late still gets picked up.
local function CharacterModeTick()
    if not needsTick() then return end

    local pawn = resolveCharacter()
    local mv = valid(pawn) and resolveMovement(pawn) or nil
    local capsule = valid(pawn) and resolveCapsule(pawn) or nil
    if not (valid(pawn) and valid(mv) and valid(capsule)) then
        -- While enabled, retry next tick. While disabled, the pawn that was
        -- flown is gone and there is nothing left to restore, so drop the
        -- applied state instead of carrying it into the next pawn.
        if not state.enabled then clearAppliedState() end
        return
    end

    local key = pawnKey(pawn)

    if state.enabled then
        local ok, currentMode = pcall(function() return mv.MovementMode end)
        -- Originals saved for a different pawn do not describe this one.
        if state.appliedTo ~= nil and state.appliedTo ~= key then clearSavedState() end
        if state.appliedTo ~= key or not ok or currentMode ~= MOVE_FLYING then
            applyEnableTransition(pawn, mv, capsule, key)
        end

        local pc = resolvePlayerController()
        if not pc then return end

        local boost = keyDown(pc, "LeftShift") and SPRINT_BOOST or 1.0
        local mult = state.speedMultiplier > 0 and state.speedMultiplier or 1.0
        local speed = BASE_FLY_SPEED * mult * boost
        pcall(function() mv.MaxFlySpeed = speed end)

        local okRot, rot = pcall(function() return pc.ControlRotation end)
        if not okRot or rot == nil then return end

        local pitch = rot.Pitch * math.pi / 180.0
        local yaw = rot.Yaw * math.pi / 180.0
        local forward = {
            X = math.cos(pitch) * math.cos(yaw),
            Y = math.cos(pitch) * math.sin(yaw),
            Z = math.sin(pitch),
        }
        local right = { X = -math.sin(yaw), Y = math.cos(yaw), Z = 0.0 }

        local vel = { X = 0.0, Y = 0.0, Z = 0.0 }
        local hasInput = false
        if keyDown(pc, "W") then
            vel.X = vel.X + forward.X * speed; vel.Y = vel.Y + forward.Y * speed; vel.Z = vel.Z + forward.Z * speed
            hasInput = true
        end
        if keyDown(pc, "S") then
            vel.X = vel.X - forward.X * speed; vel.Y = vel.Y - forward.Y * speed; vel.Z = vel.Z - forward.Z * speed
            hasInput = true
        end
        if keyDown(pc, "D") then
            vel.X = vel.X + right.X * speed; vel.Y = vel.Y + right.Y * speed
            hasInput = true
        end
        if keyDown(pc, "A") then
            vel.X = vel.X - right.X * speed; vel.Y = vel.Y - right.Y * speed
            hasInput = true
        end
        if keyDown(pc, "SpaceBar") then vel.Z = vel.Z + speed; hasInput = true end
        if keyDown(pc, "LeftControl") or keyDown(pc, "C") then vel.Z = vel.Z - speed; hasInput = true end

        if hasInput then
            pcall(function() mv.Velocity = vel end)
            state.hoverLocation = nil
        else
            pcall(function() mv.Velocity = { X = 0.0, Y = 0.0, Z = 0.0 } end)
            if state.hoverLocation == nil then
                local ok2, loc = pcall(function() return pawn:K2_GetActorLocation() end)
                if ok2 and loc ~= nil then
                    state.hoverLocation = { X = loc.X, Y = loc.Y, Z = loc.Z }
                end
            else
                local okR, curRot = pcall(function() return pawn:K2_GetActorRotation() end)
                if okR and curRot ~= nil then
                    pcall(function()
                        pawn:K2_SetActorLocationAndRotation(state.hoverLocation, curRot, false, sweepScratch, true)
                    end)
                end
            end
        end

    elseif state.appliedTo ~= nil then
        -- RESTORE transition. Only the pawn that was actually flown gets
        -- walked back — if the pawn changed while noclip was on, the one
        -- standing here was never touched by this module, so forcing it to
        -- Walking/QueryAndPhysics would fight the game for no reason.
        if state.appliedTo == key then
            applyDisableTransition(pawn, mv, capsule)
        end
        clearAppliedState()
    end
end

--------------------------------------------------------------------------------
--  APPROACH B: DebugCameraController free-cam fallback (non-Character pawns)
--
--  For pawns that do NOT use CharacterMovement, forcing a movement mode does
--  nothing observable. The engine's own DebugCameraController is a SEPARATE
--  flying spectator camera, independent of the game pawn, reachable through
--  UCheatManager:EnableDebugCamera(). CheatManager is frequently nil by
--  default; it is created ON DEMAND here via StaticConstructObject rather
--  than treated as unavailable. This is the one deliberate, scoped exception
--  to the general CheatManager-avoid policy of these templates (see godmode.lua,
--  economy.lua, spawn-item.lua) — Approach A above needs no CheatManager at
--  all, and this fallback exists only for pawns Approach A cannot reach.
--
--  WARNING — read before wiring this in: EnableDebugCamera() ends in the
--  engine's UPlayer::SwitchController, which reassigns the LocalPlayer's
--  active PlayerController to the debug controller. The ORIGINAL (game)
--  controller no longer owns the viewport while this is active: no HUD, no
--  pause menu, no game input reaches it. This is why DisableFreeCamNoclip
--  below is not optional cleanup — without a working exit path the player is
--  stuck in the free camera with a deaf game underneath it. Always expose a
--  toggle/keybind/command for the OFF path, never only the ON path.
--------------------------------------------------------------------------------

local freeCam = {
    originalController = nil, -- the game PlayerController to switch back to
}

local function ensureCheatManager(pc)
    local ok, existing = pcall(function() return pc.CheatManager end)
    if ok and valid(existing) then return existing end

    local okClass, cheatClass = pcall(function() return pc.CheatClass end)
    if not (okClass and valid(cheatClass)) then
        okClass, cheatClass = pcall(function()
            return StaticFindObject("/Script/Engine.CheatManager")
        end)
    end
    if not (okClass and valid(cheatClass)) then return nil end

    local madeOk, created = pcall(function() return StaticConstructObject(cheatClass, pc) end)
    if not (madeOk and valid(created)) then return nil end

    local assignOk = pcall(function() pc.CheatManager = created end)
    if not assignOk then return nil end

    -- Verify the assignment actually persisted (some builds silently reject
    -- it) rather than assuming success.
    local verifyOk, attached = pcall(function() return pc.CheatManager end)
    if verifyOk and valid(attached) then return attached end
    return nil
end

local function EnableFreeCamNoclip(ctx)
    local pc = resolvePlayerController()
    if not pc then
        Log(ctx, "noclip: no valid PlayerController.")
        return false
    end

    local cm = ensureCheatManager(pc)
    if not cm then
        Log(ctx, "noclip: CheatManager unavailable and could not be created on demand.")
        return false
    end

    freeCam.originalController = pc

    local ok = pcall(function() cm:EnableDebugCamera() end)
    if not ok then
        Log(ctx, "noclip: EnableDebugCamera() failed.")
        freeCam.originalController = nil
        return false
    end

    Log(ctx, "noclip (free-cam) ON — the game controller is deaf until this is turned OFF again.")
    return true
end

local function DisableFreeCamNoclip(ctx)
    -- While the free camera is active the local player's controller is the
    -- DebugCameraController, and DisableDebugCamera is called through ITS
    -- CheatManager (the game controller's own CheatManager is not the one
    -- holding the active session). Fall back to the resolvable player
    -- controller when no debug controller can be found.
    local okFind, debugController = pcall(FindFirstOf, "DebugCameraController")
    local pc = (okFind and valid(debugController)) and debugController or resolvePlayerController()
    if not valid(pc) then
        Log(ctx, "noclip: could not resolve the debug camera controller; free-cam is still ON.")
        return false
    end

    local cm = ensureCheatManager(pc)
    if not cm then
        Log(ctx, "noclip: no CheatManager on the debug camera controller; free-cam is still ON.")
        return false
    end

    local ok = pcall(function() cm:DisableDebugCamera() end)
    if not ok then
        -- State is kept so the toggle can try the OFF path again.
        Log(ctx, "noclip: DisableDebugCamera() failed; free-cam is still ON.")
        return false
    end

    freeCam.originalController = nil
    Log(ctx, "noclip (free-cam) OFF — control returned to the game.")
    return true
end

--------------------------------------------------------------------------------
--  Public toggle (dispatches to whichever mode is selected above)
--------------------------------------------------------------------------------

local function ToggleNoclip(ctx)
    if NOCLIP_MODE == "debugcamera" then
        if freeCam.originalController ~= nil then
            DisableFreeCamNoclip(ctx)
        else
            EnableFreeCamNoclip(ctx)
        end
        return
    end

    -- "character" mode: flip intent only; CharacterModeTick performs the
    -- actual engine writes and the restore, every frame, until it matches.
    state.enabled = not state.enabled
    Log(ctx, "noclip: " .. (state.enabled and "ON" or "OFF (restoring...)"))
end

local tickHandle = nil
local tickErrorLogged = false

local function StartCharacterModeTick()
    if tickHandle ~= nil then return end
    -- Per-frame, not the ~200-250ms interval used by godmode/health/stamina:
    -- noclip polls WASD and writes Velocity directly, so anything slower
    -- than a frame reads as visible input lag on a flight cheat, and the
    -- hover-pin re-stamp would visibly stutter at a slower cadence too.
    tickHandle = LoopInGameThreadWithDelay(16, function()
        local ok, err = pcall(CharacterModeTick)
        -- Log the first failure only: a tick that fails every frame would flood the log.
        if not ok and not tickErrorLogged then
            tickErrorLogged = true
            print("[noclip] tick error (further errors suppressed): " .. tostring(err) .. "\n")
        end
    end)
end

--------------------------------------------------------------------------------
--  Registration
--------------------------------------------------------------------------------

--- Wires this feature into the host mod.
--- @param ctx table|nil  # see FeatureCtx in main.lua for the contract; every
---   field is optional and this module degrades to raw UE4SS globals when a
---   field (or `ctx` itself) is missing, so it also works copied in standalone.
function M.register(ctx)
    if NOCLIP_MODE == "character" then
        StartCharacterModeTick()
    end

    local commandName = (ctx and ctx.command_prefix or "") .. "noclip"

    local function Handler(FullCommand, Parameters, OutputDevice)
        ToggleNoclip(ctx)
        return true -- suppress default "unknown command" handling
    end

    if ctx and ctx.register_command then
        ctx.register_command(commandName, Handler)
    else
        local ok = pcall(RegisterConsoleCommandHandler, commandName, Handler)
        if not ok then Log(ctx, "noclip: RegisterConsoleCommandHandler unavailable.") end
    end

    -- Keybind is opt-in ONLY: wire it if and only if the host mod explicitly
    -- enabled keybinds (ctx.keybinds_enabled). Never assume a key is wanted.
    if ctx and ctx.keybinds_enabled then
        local keyName = (ctx.keybind_defaults and ctx.keybind_defaults.noclip) or "B"
        if ctx.register_keybind then
            ctx.register_keybind(keyName, function() ToggleNoclip(ctx) end)
        elseif type(Key) == "table" and Key[keyName] then
            -- Key callbacks run on the UE4SS event-loop thread; hop to the game thread.
            pcall(RegisterKeyBind, Key[keyName], function()
                ExecuteInGameThread(function() ToggleNoclip(ctx) end)
            end)
        end
    end

    Log(ctx, "noclip feature registered (mode: " .. NOCLIP_MODE .. ", command: " .. commandName .. ")")
end

return M
