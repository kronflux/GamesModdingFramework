--[[
    features/feature-discovery.lua — DEV TOOL: enumerate hookable classes,
    functions, and properties on the current game's player controller/pawn/
    movement component at runtime, to help discover what cheat/feature
    patterns the recipes in unreal.cookbook.basic (noclip.lua, godmode.lua, etc.) in
    this same folder can target for the game a mod is being built against.

    SELF-CONTAINED: copy this file into a mod's Scripts/features/ folder and
    call `require("features.feature-discovery").register(ctx)` from the mod's
    features loader. See FeatureCtx in the structured scaffold's main.lua for the `ctx` contract.
    Intended as a development-time aid — a release checklist should ask
    "which dev commands to keep or remove"; this is exactly that kind of
    command, drop it before shipping unless the mod wants an in-game
    diagnostic command for end users too.

    Uses the real UE4SS reflection/object-model API (RE-UE4SS/docs/lua-api/):
      - FindFirstOf(shortClassName)         -> global-functions/findfirstof.md
      - UObject:GetClass()                  -> classes/uobject.md
      - UStruct:GetSuperStruct()            -> classes/ustruct.md
      - UStruct:ForEachFunction(callback)   -> classes/ustruct.md
      - UStruct:ForEachProperty(callback)   -> classes/ustruct.md
      - Property:GetClass()                 -> classes/property.md (discriminates property kind)
      - UEHelpers.GetPlayer(), UEHelpers.GetPlayerController()
]]

-- UEHelpers ships with UE4SS (Mods/shared), not with this mod; loaded through pcall so the module-reference check does not look for it under Scripts/.
local UEHelpersLoaded, UEHelpers = pcall(require, "UEHelpers")
assert(UEHelpersLoaded, "UEHelpers module not found (it ships with UE4SS in Mods/shared)")

local M = {}

local function Log(ctx, message)
    if ctx and ctx.log then
        ctx.log(message)
    else
        print("[feature-discovery] " .. tostring(message) .. "\n")
    end
end

local function Emit(ctx, OutputDevice, line)
    if OutputDevice then pcall(function() OutputDevice:Log(line) end) end
    Log(ctx, line)
end

--- Calls Class[method](Class, fn) on Class and on every super struct above it.
--- ForEachProperty and ForEachFunction visit only the members a struct declares
--- itself, so inherited members need this walk up the GetSuperStruct chain.
--- @param Class any  # a UClass
--- @param method string  # "ForEachProperty" or "ForEachFunction"
--- @param fn function
local function ForEachInChain(Class, method, fn)
    local Level = Class
    local depth = 0
    while Level and Level:IsValid() and depth < 64 do
        Level[method](Level, fn)
        local okSuper, super = pcall(function() return Level:GetSuperStruct() end)
        Level = okSuper and super or nil
        depth = depth + 1
    end
end

--- Enumerate every property on Obj's class via ForEachProperty, printing the
--- property's name and its own PropertyClass name (BoolProperty,
--- ObjectProperty, StructProperty, ArrayProperty, ...) so a reader can spot
--- likely health/stamina/movement/invincibility fields by name and kind.
--- @param label string  # e.g. "Pawn", "PlayerController", "CharacterMovement"
local function DumpProperties(ctx, OutputDevice, Obj, label)
    if not (Obj and Obj:IsValid()) then
        Emit(ctx, OutputDevice, string.format("[%s] not available (nil or invalid).", label))
        return
    end

    local ok = pcall(function()
        local Class = Obj:GetClass()
        if not (Class and Class:IsValid()) then return end

        Emit(ctx, OutputDevice, string.format("[%s] class: %s", label, Class:GetFName():ToString()))

        local count = 0
        ForEachInChain(Class, "ForEachProperty", function(Prop)
            local okName, name = pcall(function() return Prop:GetFName():ToString() end)
            local okKind, kindObj = pcall(function() return Prop:GetClass() end)
            local kind = "?"
            if okKind and kindObj then
                local okKindName, kindName = pcall(function() return kindObj:GetFName():ToString() end)
                if okKindName then kind = kindName end
            end
            if okName then
                count = count + 1
                Emit(ctx, OutputDevice, string.format("  [%s] property: %s (%s)", label, name, kind))
            end
        end)
        Emit(ctx, OutputDevice, string.format("[%s] %d properties.", label, count))
    end)
    if not ok then
        Emit(ctx, OutputDevice, string.format("[%s] property enumeration failed (pcall guard tripped).", label))
    end
end

--- Enumerate every UFunction on Obj's class via ForEachFunction, printing
--- just the name — enough to spot candidate damage/heal/teleport/cheat-manager
--- entry points to RegisterHook against or call directly.
--- @param label string
local function DumpFunctions(ctx, OutputDevice, Obj, label)
    if not (Obj and Obj:IsValid()) then return end

    local ok = pcall(function()
        local Class = Obj:GetClass()
        if not (Class and Class:IsValid()) then return end

        local count = 0
        ForEachInChain(Class, "ForEachFunction", function(Func)
            local okName, name = pcall(function() return Func:GetFName():ToString() end)
            if okName then
                count = count + 1
                Emit(ctx, OutputDevice, string.format("  [%s] function: %s", label, name))
            end
        end)
        Emit(ctx, OutputDevice, string.format("[%s] %d functions.", label, count))
    end)
    if not ok then
        Emit(ctx, OutputDevice, string.format("[%s] function enumeration failed (pcall guard tripped).", label))
    end
end

--- Walk the class hierarchy of Obj upward via GetSuperStruct(), printing each
--- level's name, so a reader can tell which fields/functions are inherited
--- from an engine base class (e.g. ACharacter, APawn) versus the game's own
--- derived Blueprint/native class.
--- @param label string
local function DumpHierarchy(ctx, OutputDevice, Obj, label)
    if not (Obj and Obj:IsValid()) then return end

    pcall(function()
        local Level = Obj:GetClass()
        local chain = {}
        while Level and Level:IsValid() do
            local okName, name = pcall(function() return Level:GetFName():ToString() end)
            table.insert(chain, okName and name or "?")
            local okSuper, super = pcall(function() return Level:GetSuperStruct() end)
            Level = okSuper and super or nil
        end
        Emit(ctx, OutputDevice, string.format("[%s] hierarchy: %s", label, table.concat(chain, " -> ")))
    end)
end

--- Runs the full discovery pass: resolves PlayerController, Pawn, and the
--- pawn's CharacterMovement component (GAME-SPECIFIC property name, same as
--- every other feature module in this folder), then dumps hierarchy,
--- functions, and properties for each.
function M.run_discovery(ctx, OutputDevice)
    Emit(ctx, OutputDevice, "=== feature-discovery: scanning current game objects ===")

    local PC = UEHelpers.GetPlayerController()
    DumpHierarchy(ctx, OutputDevice, PC, "PlayerController")
    DumpFunctions(ctx, OutputDevice, PC, "PlayerController")
    DumpProperties(ctx, OutputDevice, PC, "PlayerController")

    local Pawn = UEHelpers.GetPlayer()
    DumpHierarchy(ctx, OutputDevice, Pawn, "Pawn")
    DumpFunctions(ctx, OutputDevice, Pawn, "Pawn")
    DumpProperties(ctx, OutputDevice, Pawn, "Pawn")

    if Pawn and Pawn:IsValid() then
        local ok, MovementComponent = pcall(function() return Pawn.CharacterMovement end)
        --[[ GAME-SPECIFIC: movement component property name; usually "CharacterMovement" but
             confirm on the target game's pawn class — this scan is exactly how. ]]
        if ok and MovementComponent and MovementComponent:IsValid() then
            DumpHierarchy(ctx, OutputDevice, MovementComponent, "CharacterMovement")
            DumpProperties(ctx, OutputDevice, MovementComponent, "CharacterMovement")
        else
            Emit(ctx, OutputDevice, "[CharacterMovement] not found under Pawn.CharacterMovement on this game.")
        end
    end

    -- Also list every live instance of a class by short name, when given one
    -- as an argument (see M.register's "discoverclass" command) — useful for
    -- spotting a Cheat Manager, EconomyManager, or GameMode-equivalent class
    -- whose exact name isn't known yet.
    Emit(ctx, OutputDevice, "=== feature-discovery: scan complete ===")
end

--- Enumerate every live instance of `shortClassName`, printing each one's
--- full name. Complements M.run_discovery for classes that aren't reachable
--- from the player controller/pawn (e.g. a standalone EconomyManager).
--- @param shortClassName string
function M.discover_class(ctx, OutputDevice, shortClassName)
    local ok, instances = pcall(FindAllOf, shortClassName)
    if not ok or not instances then
        Emit(ctx, OutputDevice, string.format("discoverclass: no instances of '%s' found.", shortClassName))
        return
    end

    local count = 0
    for _, inst in ipairs(instances) do
        if inst and inst:IsValid() then
            count = count + 1
            local okFull, full = pcall(function() return inst:GetFullName() end)
            Emit(ctx, OutputDevice, string.format("  %s", okFull and full or "<unnamed>"))
        end
    end
    Emit(ctx, OutputDevice, string.format("discoverclass '%s': %d live instance(s).", shortClassName, count))
end

--- @param ctx table|nil  # see FeatureCtx in main.lua
function M.register(ctx)
    local prefix = ctx and ctx.command_prefix or ""
    local discoverCommand = prefix .. "discoverfeatures"
    local discoverClassCommand = prefix .. "discoverclass"

    local function DiscoverHandler(FullCommand, Parameters, OutputDevice)
        M.run_discovery(ctx, OutputDevice)
        return true
    end

    local function DiscoverClassHandler(FullCommand, Parameters, OutputDevice)
        local params = (type(Parameters) == "table") and Parameters or {}
        local shortClassName = params[1]
        if not shortClassName then
            Emit(ctx, OutputDevice, "Usage: " .. discoverClassCommand .. " <ShortClassName>")
            return true
        end
        M.discover_class(ctx, OutputDevice, shortClassName)
        return true
    end

    if ctx and ctx.register_command then
        ctx.register_command(discoverCommand, DiscoverHandler)
        ctx.register_command(discoverClassCommand, DiscoverClassHandler)
    else
        pcall(RegisterConsoleCommandHandler, discoverCommand, DiscoverHandler)
        pcall(RegisterConsoleCommandHandler, discoverClassCommand, DiscoverClassHandler)
    end

    -- No keybind by default: this is a dev diagnostic, not a gameplay toggle,
    -- and "never assume keybinds" applies here too — if a mod
    -- author wants one, ctx.keybinds_enabled + ctx.register_keybind still
    -- work exactly as in the other features/*.lua modules.
    if ctx and ctx.keybinds_enabled then
        local keyName = ctx.keybind_defaults and ctx.keybind_defaults.feature_discovery
        if keyName then
            local function KeybindHandler() M.run_discovery(ctx, nil) end
            if ctx.register_keybind then
                ctx.register_keybind(keyName, KeybindHandler)
            elseif type(Key) == "table" and Key[keyName] then
                -- Key callbacks run on the UE4SS event-loop thread; hop to the game thread.
                pcall(RegisterKeyBind, Key[keyName], function() ExecuteInGameThread(KeybindHandler) end)
            end
        end
    end

    Log(ctx, "feature-discovery feature registered (commands: " .. discoverCommand .. ", " .. discoverClassCommand .. ")")
end

return M
