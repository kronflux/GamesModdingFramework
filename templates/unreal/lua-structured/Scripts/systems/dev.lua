--[[
    systems/dev.lua — DEV/TESTING-ONLY tooling. NOT for a shipped build.

    *** This whole file is dev-only. It exists to help YOU build and debug
    this mod (find class/property/function names, trigger dumps on demand,
    sanity-check the current pawn), not for end users to have in a released
    copy. It is exactly what a release-time dev-tooling pruning step removes
    (or keeps, if you explicitly choose to ship it): decide "which dev commands
    to keep or remove" before you ship. main.lua loads it optionally (pcall'd require), so deleting this
    file at release time is enough; nothing else needs to change. ***

    Follows the SAME M.register(ctx) contract as Scripts/features/*.lua (see
    FeatureCtx in main.lua and VERIFY.md), so main.lua wires it exactly like a
    feature module and its commands land in the same `help` registry.

    Wires:
      - `devstatus`  — this mod's config snapshot, engine/UE4SS version, and
        which Scripts/features/*.lua modules main.lua's features loader wired.
        (Not "list every mod UE4SS has loaded" — that enumeration is not part
        of the documented UE4SS Lua API surface this template uses; see
        RE-UE4SS/docs/lua-api/ if that ever changes.)
      - `devpawn`    — quick identity/location check on the local player's pawn.
      - `devdump`, `devdump_objects`, `devdump_actors`, `devdump_meshes`,
        `devdump_usmap`, `devdump_jmap` — on-demand triggers for UE4SS's real
        dump globals, each pcall-guarded so one failing dump can't take the
        others (or this mod) down. Same five dumps
        the GmfDumper helper mod wraps; these exist here too because that mod
        may not be deployed alongside this one.
      - `discoverfeatures` / `discoverclass` — required from
        Scripts/features/feature-discovery.lua (if that optional file was
        copied in) and registered here rather than reimplemented, so the
        class/function/property enumeration logic has exactly one copy.

    Real UE4SS Lua API used (see RE-UE4SS/docs/lua-api/):
      - global-functions/dumpallobjects.md    -> DumpAllObjects()
      - global-functions/dumpallactors.md     -> DumpAllActors()
      - global-functions/dumpstaticmeshes.md  -> DumpStaticMeshes()
      - global-functions/dumpusmap.md         -> DumpUSMAP([bool IncludeBlueprintGenerated])
      - global-functions/dumpjmap.md          -> DumpJMAP([bool IncludeBlueprintGenerated])
      - classes/unrealversion.md              -> UnrealVersion.GetMajor()/GetMinor()
      - classes/ue4ss.md                      -> UE4SS.GetVersion() (UE4SS 1.1+ only)
      - global-functions/registerconsolecommandhandler.md -> RegisterConsoleCommandHandler
    Shared helper module used below (shipped with UE4SS at
    Mods/shared/UEHelpers/UEHelpers.lua):
      - UEHelpers.GetPlayer() -> APawn
]]

-- UEHelpers ships with UE4SS (Mods/shared), not with this mod; loaded through pcall so the module-reference check does not look for it under Scripts/.
local UEHelpersLoaded, UEHelpers = pcall(require, "UEHelpers")
assert(UEHelpersLoaded, "UEHelpers module not found (it ships with UE4SS in Mods/shared)")

local Dev = {}

local function Log(ctx, message)
    if ctx and ctx.log then
        ctx.log(message)
    else
        print("[dev] " .. tostring(message) .. "\n")
    end
end

local function Emit(ctx, OutputDevice, line)
    if OutputDevice ~= nil then pcall(function() OutputDevice:Log(line) end) end
    Log(ctx, line)
end

---Registers Name (guarded, and through ctx.register_command when the caller
---supplied one, so it lands in main.lua's help registry too) exactly the way
---every features/*.lua module does.
local function RegisterCommand(ctx, prefix, name, handler)
    local fullName = prefix .. name
    if ctx and ctx.register_command then
        ctx.register_command(fullName, handler)
    else
        pcall(RegisterConsoleCommandHandler, fullName, handler)
    end
    return fullName
end

--------------------------------------------------------------------------------
--  devstatus — config + version + wired-features snapshot
--------------------------------------------------------------------------------

---Resolves "Major.Minor", guarded against a missing UnrealVersion class on
---very old UE4SS builds (mirrors GmfDumper's own GetEngineVersionString).
local function GetEngineVersionString()
    local Ok, Major, Minor = pcall(function()
        return UnrealVersion.GetMajor(), UnrealVersion.GetMinor()
    end)
    if Ok and Major ~= nil and Minor ~= nil then
        return string.format("%s.%s", tostring(Major), tostring(Minor))
    end
    return "unknown"
end

---Resolves the running UE4SS version, guarded because UE4SS.GetVersion() only
---exists in UE4SS 1.1+ (RE-UE4SS/docs/lua-api/classes/ue4ss.md).
local function GetUE4SSVersionString()
    if UE4SS == nil then
        return "unknown (pre-1.1, UE4SS global class not present)"
    end
    local Ok, Major, Minor, Hotfix = pcall(UE4SS.GetVersion)
    if Ok and Major ~= nil then
        return string.format("%s.%s.%s", tostring(Major), tostring(Minor), tostring(Hotfix))
    end
    return "unknown"
end

---@param ctx table|nil
---@param OutputDevice FOutputDevice|nil
local function RunDevStatus(ctx, OutputDevice)
    Emit(ctx, OutputDevice, "=== devstatus ===")
    Emit(ctx, OutputDevice, string.format("Unreal Engine version: %s", GetEngineVersionString()))
    Emit(ctx, OutputDevice, string.format("UE4SS version: %s", GetUE4SSVersionString()))
    Emit(ctx, OutputDevice, string.format("Keybinds enabled (ctx.keybinds_enabled): %s",
        tostring(ctx and ctx.keybinds_enabled or false)))

    if ctx and ctx.config then
        for Key, Value in pairs(ctx.config) do
            Emit(ctx, OutputDevice, string.format("Config: %s = %s", tostring(Key), tostring(Value)))
        end
    else
        Emit(ctx, OutputDevice, "Config: not passed to dev.lua's ctx (see FeatureCtx in main.lua).")
    end

    if ctx and ctx.feature_modules then
        Emit(ctx, OutputDevice, string.format("Wired Scripts/features/*.lua modules: %d", #ctx.feature_modules))
        for _, ModulePath in ipairs(ctx.feature_modules) do
            Emit(ctx, OutputDevice, "  - " .. tostring(ModulePath))
        end
    else
        Emit(ctx, OutputDevice, "Wired features: none passed to dev.lua's ctx.")
    end
    Emit(ctx, OutputDevice, "=== devstatus complete ===")
end

--------------------------------------------------------------------------------
--  devpawn — quick identity/location check on the local player's pawn
--------------------------------------------------------------------------------

---@param ctx table|nil
---@param OutputDevice FOutputDevice|nil
local function RunDevPawn(ctx, OutputDevice)
    local Pawn = UEHelpers.GetPlayer()
    if not (Pawn and Pawn:IsValid()) then
        Emit(ctx, OutputDevice, "devpawn: no valid player pawn yet (not in a match?).")
        return
    end

    local OkName, FullName = pcall(function() return Pawn:GetFullName() end)
    Emit(ctx, OutputDevice, "devpawn: " .. (OkName and FullName or "<name unavailable>"))

    -- K2_GetActorLocation() (RE-UE4SS/docs/lua-api/, same accessor
    -- features/teleport.lua reads FROM when saving a waypoint) returns an
    -- FVector-shaped table with .X/.Y/.Z.
    local OkLoc, Loc = pcall(function() return Pawn:K2_GetActorLocation() end)
    if OkLoc and Loc then
        Emit(ctx, OutputDevice, string.format("devpawn: location = (%.1f, %.1f, %.1f)",
            Loc.X or 0, Loc.Y or 0, Loc.Z or 0))
    else
        Emit(ctx, OutputDevice, "devpawn: could not read K2_GetActorLocation().")
    end

    Emit(ctx, OutputDevice, "devpawn: run 'discoverfeatures' for a full class/function/property dump.")
end

--------------------------------------------------------------------------------
--  devdump* — on-demand triggers for UE4SS's real dump globals
--------------------------------------------------------------------------------

---Each dump entry: a human label and the EXACT UE4SS global dump function
---(the same five dumps GmfDumper wraps; see this file's header).
local Dumps = {
    { Id = "objects", Label = "All Objects",    Fn = DumpAllObjects },
    { Id = "actors",  Label = "All Actors",     Fn = DumpAllActors },
    { Id = "meshes",  Label = "Static Meshes",  Fn = DumpStaticMeshes },
    { Id = "usmap",   Label = "USMAP Mapping",  Fn = DumpUSMAP },
    { Id = "jmap",    Label = "JMAP Reflection", Fn = DumpJMAP },
}

---Runs a single dump entry under pcall so a failure in one dumper never
---aborts the rest (and never crashes this mod).
local function RunDump(ctx, OutputDevice, DumpEntry)
    local Ok, ErrorOrResult = pcall(DumpEntry.Fn)
    if Ok then
        Emit(ctx, OutputDevice, string.format("devdump: %s - OK", DumpEntry.Label))
    else
        Emit(ctx, OutputDevice, string.format("devdump: %s - FAILED (%s)", DumpEntry.Label, tostring(ErrorOrResult)))
    end
    return Ok
end

local function RunAllDumps(ctx, OutputDevice)
    for _, DumpEntry in ipairs(Dumps) do
        RunDump(ctx, OutputDevice, DumpEntry)
    end
end

--------------------------------------------------------------------------------
--  register — wires every command above, plus (optionally) feature-discovery
--------------------------------------------------------------------------------

---@param ctx table|nil  # see FeatureCtx in main.lua for the base contract;
---  dev.lua additionally reads ctx.config (table) and ctx.feature_modules
---  (array of dotted module paths) for devstatus, both optional.
function Dev.register(ctx)
    local prefix = ctx and ctx.command_prefix or ""

    local statusCommand = RegisterCommand(ctx, prefix, "devstatus", function(FullCommand, Parameters, OutputDevice)
        local Ok, Err = pcall(RunDevStatus, ctx, OutputDevice)
        if not Ok then Emit(ctx, OutputDevice, "devstatus FAILED: " .. tostring(Err)) end
        return true
    end)

    local pawnCommand = RegisterCommand(ctx, prefix, "devpawn", function(FullCommand, Parameters, OutputDevice)
        local Ok, Err = pcall(RunDevPawn, ctx, OutputDevice)
        if not Ok then Emit(ctx, OutputDevice, "devpawn FAILED: " .. tostring(Err)) end
        return true
    end)

    local dumpAllCommand = RegisterCommand(ctx, prefix, "devdump", function(FullCommand, Parameters, OutputDevice)
        Emit(ctx, OutputDevice, string.format("devdump: running all %d dumps...", #Dumps))
        RunAllDumps(ctx, OutputDevice)
        return true
    end)

    local dumpCommandNames = { dumpAllCommand }
    for _, DumpEntry in ipairs(Dumps) do
        local name = RegisterCommand(ctx, prefix, "devdump_" .. DumpEntry.Id,
            function(FullCommand, Parameters, OutputDevice)
                RunDump(ctx, OutputDevice, DumpEntry)
                return true
            end)
        table.insert(dumpCommandNames, name)
    end

    -- feature-discovery.lua is an OPTIONAL copy-in file (see
    -- FeatureCtx in main.lua); require it defensively so a scaffold that
    -- never copied it in still loads the rest of dev.lua's tooling.
    -- When main.lua already wired it as a feature module (ctx.feature_modules
    -- lists it), registering it again here would duplicate its commands.
    local AlreadyWired = false
    if ctx and type(ctx.feature_modules) == "table" then
        for _, ModulePath in ipairs(ctx.feature_modules) do
            if ModulePath == "features.feature-discovery" then AlreadyWired = true end
        end
    end

    local DiscoveryOk, Discovery = false, nil
    if not AlreadyWired then
        DiscoveryOk, Discovery = pcall(require, "features.feature-discovery")
    end
    if AlreadyWired then
        Log(ctx, "dev.lua: feature-discovery is already wired as a feature module; not registering it again.")
    elseif DiscoveryOk and type(Discovery) == "table" and Discovery.register then
        local RegisterOk, RegisterErr = pcall(Discovery.register, ctx)
        if RegisterOk then
            Log(ctx, "dev.lua: feature-discovery wired (commands: discoverfeatures, discoverclass).")
        else
            Log(ctx, "dev.lua: feature-discovery failed to register: " .. tostring(RegisterErr))
        end
    else
        Log(ctx, "dev.lua: features/feature-discovery.lua not present; discoverfeatures/discoverclass skipped. " ..
            "Scaffold with the feature-discovery feature (unreal.scaffold features input) to add it.")
    end

    Log(ctx, string.format("dev.lua (DEV-ONLY, prune before release) registered: %s, %s, %s",
        statusCommand, pawnCommand, table.concat(dumpCommandNames, ", ")))
end

return Dev
