--[[
    features/spawn-item.lua — drop-in item spawn / give item feature.

    SELF-CONTAINED: copy this file into a mod's Scripts/features/ folder and
    call `require("features.spawn-item").register(ctx)` from the mod's
    features loader. See FeatureCtx in the structured scaffold's main.lua for the `ctx` contract.

    Two real strategies, tried in the order below:
      1. Give directly into the local player's own inventory by resolving the
         inventory component via reflection (with fallbacks) and calling its
         OWN add/give UFunction — a real inventory grant through the game's
         own object model. This avoids CheatManager entirely, unlike a
         console cheat command.
      2. Spawn a world actor via BeginDeferredActorSpawnFromClass +
         FinishSpawningActor — the correct two-step UE spawn sequence, used
         when no inventory UFunction resolves, or when a mod author wants a
         physical world drop instead of a silent inventory grant.

    UE4SS Lua API used (RE-UE4SS/docs/lua-api/):
      - UEHelpers.GetPlayer(), UEHelpers.GetWorld(), UEHelpers.GetGameplayStatics()
      - global-functions/findfirstof.md
      - global-functions/staticfindobject.md -> StaticFindObject
      - global-functions/registerconsolecommandhandler.md
      - global-functions/registerkeybind.md (opt-in only)
]]

-- UEHelpers ships with UE4SS (Mods/shared), not with this mod; loaded through pcall so the module-reference check does not look for it under Scripts/.
local UEHelpersLoaded, UEHelpers = pcall(require, "UEHelpers")
assert(UEHelpersLoaded, "UEHelpers module not found (it ships with UE4SS in Mods/shared)")

local M = {}

local function Log(ctx, message)
    if ctx and ctx.log then
        ctx.log(message)
    else
        print("[spawn-item] " .. tostring(message) .. "\n")
    end
end

local function valid(o)
    if o == nil then return false end
    local ok, r = pcall(function() return o:IsValid() end)
    return ok and r == true
end

--- Resolve the local player's inventory component via reflection, with fallbacks for
--- games that expose it under a different property/getter name, or only as a standalone
--- object findable by class.
--- @return any|nil Inventory
local function GetInventoryComponent()
    local Pawn = UEHelpers.GetPlayer()
    if valid(Pawn) then
        local ok, Inventory = pcall(function() return Pawn.Inventory end) --[[ GAME-SPECIFIC: inventory component property name ]]
        if ok and valid(Inventory) then return Inventory end
        local okFn, InventoryFn = pcall(function() return Pawn:GetInventoryComponent() end) --[[ GAME-SPECIFIC: fallback getter name ]]
        if okFn and valid(InventoryFn) then return InventoryFn end
    end

    -- Fallback: a standalone inventory component object findable by class name.
    local okFind, Found = pcall(FindFirstOf, "InventoryComponent") --[[ GAME-SPECIFIC: inventory component class name ]]
    if okFind and valid(Found) then return Found end
    return nil
end

--[[ GAME-SPECIFIC: candidate names for the inventory's own add/give UFunction, tried in
     order until one both exists and does not error. Confirm the real one via a class
     dump before shipping and trim this list down to the single confirmed name. ]]
local ADD_ITEM_FUNCTION_NAMES = { "AddItem", "GiveItem", "AddItemToInventory" }

--[[ GAME-SPECIFIC: the largest stack the game accepts in one give call. ]]
local MAX_GIVE_COUNT = 9999

--- Strategy 1: give an item straight into the resolved inventory by calling the
--- inventory's OWN add/give UFunction via reflection. Not wired to a fixed-signature
--- console command by default because the exact function name and argument shape (item
--- row name vs. item id vs. item class, a count, an optional slot index) is
--- GAME-SPECIFIC — confirm both before shipping.
--- @param ItemId string|integer  #[[ GAME-SPECIFIC: item row name / id / class path, per the resolved UFunction's signature ]]
--- @param Count integer?
--- @return boolean Success
function M.give_item_to_inventory(ItemId, Count)
    Count = Count or 1
    local Inventory = GetInventoryComponent()
    if not Inventory then return false end

    for _, functionName in ipairs(ADD_ITEM_FUNCTION_NAMES) do
        if pcall(function() Inventory[functionName](Inventory, ItemId, Count) end) then
            return true
        end
    end
    return false
end

--- Strategy 2: spawn a fresh world actor for the item in front of the player.
--- Full BeginDeferredActorSpawnFromClass/FinishSpawningActor sequence.
--- @param ItemClassPath string  #[[ GAME-SPECIFIC: full class path, e.g. "/Game/Blueprints/BP_Item_Whatever.BP_Item_Whatever_C" ]]
--- @return any|nil SpawnedActor
function M.spawn_item_actor(ItemClassPath)
    local Pawn = UEHelpers.GetPlayer()
    if not valid(Pawn) then return nil end

    local World = UEHelpers.GetWorld()
    local GameplayStatics = UEHelpers.GetGameplayStatics()
    if not (valid(World) and valid(GameplayStatics)) then return nil end

    if type(ItemClassPath) ~= "string" or ItemClassPath == "" then return nil end

    local SpawnClass = nil
    pcall(function() SpawnClass = StaticFindObject(ItemClassPath) end)
    if not valid(SpawnClass) and type(LoadAsset) == "function" then
        -- There is no LoadClass global in UE4SS. LoadAsset (game thread only)
        -- loads the Blueprint asset "<pkg>.BP_X"; its generated class
        -- "<pkg>.BP_X_C" is then found in memory. helpers/load-class.lua does
        -- the same with fuller error reporting.
        local assetPath = (ItemClassPath:gsub("_C$", ""))
        pcall(LoadAsset, assetPath)
        pcall(function() SpawnClass = StaticFindObject(ItemClassPath) end)
    end
    if not valid(SpawnClass) then return nil end

    local posOk, spawnLoc = pcall(function()
        local forward = Pawn:GetActorForwardVector()
        local loc = Pawn:K2_GetActorLocation()
        return { X = loc.X + forward.X * 150.0, Y = loc.Y + forward.Y * 150.0, Z = loc.Z + 50.0 }
    end)
    if not posOk then return nil end
    local transform = { Translation = spawnLoc, Rotation = { X = 0, Y = 0, Z = 0, W = 1 }, Scale3D = { X = 1, Y = 1, Z = 1 } }

    ---@type any
    local deferred = nil
    pcall(function()
        -- (WorldContext, Class, Transform, CollisionHandlingOverride, Owner, SpawnMethod)
        deferred = GameplayStatics:BeginDeferredActorSpawnFromClass(World, SpawnClass, transform, 1, nil, 0)
    end)
    if not valid(deferred) then return nil end

    local finished = pcall(function() GameplayStatics:FinishSpawningActor(deferred, transform, 0) end)
    if not finished then
        -- A deferred actor that never finished spawning is half-constructed;
        -- remove it rather than leaving it in the world.
        pcall(function() deferred:K2_DestroyActor() end)
        return nil
    end
    return deferred
end

--- @param ctx table|nil  # see FeatureCtx in main.lua
function M.register(ctx)
    local prefix = ctx and ctx.command_prefix or ""
    local giveCommand = prefix .. "giveitem"
    local spawnCommand = prefix .. "spawnitem"

    local function GiveHandler(FullCommand, Parameters, OutputDevice)
        local params = (type(Parameters) == "table") and Parameters or {}
        local itemId = params[1]
        local count = tonumber(params[2] or 1)
        local countOk = count ~= nil and count == math.floor(count) and count >= 1 and count <= MAX_GIVE_COUNT
        if not itemId or not countOk then
            local msg = string.format("Usage: giveitem <item-id> [count] (count: a whole number from 1 to %d)", MAX_GIVE_COUNT)
            if OutputDevice then OutputDevice:Log(msg) end
            Log(ctx, "giveitem: " .. msg)
            return true
        end

        if M.give_item_to_inventory(itemId, count) then
            local msg = "Gave " .. tostring(count) .. "x " .. tostring(itemId)
            if OutputDevice then OutputDevice:Log(msg) end
            Log(ctx, msg)
        else
            local msg = "Could not give '" .. tostring(itemId) .. "' (no resolvable inventory or add-item UFunction)."
            if OutputDevice then OutputDevice:Log(msg) end
            Log(ctx, msg)
        end
        return true
    end

    local function SpawnHandler(FullCommand, Parameters, OutputDevice)
        local params = (type(Parameters) == "table") and Parameters or {}
        local classPath = params[1]
        if not classPath then
            local msg = "Usage: spawnitem <full-class-path>"
            if OutputDevice then OutputDevice:Log(msg) end
            Log(ctx, "spawnitem: " .. msg)
            return true
        end

        local actor = M.spawn_item_actor(classPath)
        if actor then
            local msg = "Spawned: " .. classPath
            if OutputDevice then OutputDevice:Log(msg) end
            Log(ctx, msg)
        else
            local msg = "Failed to spawn '" .. tostring(classPath) .. "' (bad class path, or no valid player/world)."
            if OutputDevice then OutputDevice:Log(msg) end
            Log(ctx, msg)
        end
        return true
    end

    if ctx and ctx.register_command then
        ctx.register_command(giveCommand, GiveHandler)
        ctx.register_command(spawnCommand, SpawnHandler)
    else
        pcall(RegisterConsoleCommandHandler, giveCommand, GiveHandler)
        pcall(RegisterConsoleCommandHandler, spawnCommand, SpawnHandler)
    end

    -- No default keybind: both commands need an item id / class-path argument a bare
    -- keypress can't supply, so this feature is command-only. A host mod that wants a
    -- keybind can still wire one via ctx against a hardcoded item id in its own features
    -- loader.

    Log(ctx, "spawn-item feature registered (commands: " .. giveCommand .. ", " .. spawnCommand .. ")")
end

return M
