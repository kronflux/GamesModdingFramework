--[[
    {{name}} — bootstrap loader
    Author: {{author}}

    Keep this file thin: it wires the core/ modules together (including
    core/help.lua's command registry — every command below registers through
    it so the `help` command it provides always stays accurate), loads config
    and keybinds, registers `selftest`, loads DEV-ONLY tooling
    (systems/dev.lua — see that file's own header before shipping this mod),
    loads any Scripts/features/*.lua modules via their M.register(ctx)
    contract, and wires one sample feature inline. Actual gameplay logic
    belongs in Scripts/systems/*.lua or
    Scripts/features/*.lua (drop-in modules copied in by unreal.scaffold's
    `features` input - see FeatureCtx below for the ctx contract), and small static data tables in Scripts/data/*.lua.

    Testing: see VERIFY.md for the full step-by-step, and run `help` in-game
    any time to see every command this mod currently registers.

    UE4SS Lua API used (see RE-UE4SS/docs/lua-api/):
      - global-functions/registerconsolecommandhandler.md -> RegisterConsoleCommandHandler
      - global-functions/registerhook.md                   -> RegisterHook
      - global-functions/executeingamethread.md            -> ExecuteInGameThread
      - global-functions/registerkeybind.md                -> RegisterKeyBind
      - global-functions/print.md                          -> print
    Shared helper module (shipped with UE4SS at
    Mods/shared/UEHelpers/UEHelpers.lua): required indirectly,
    through core/selftest.lua's built-in "uehelpers" check, and directly below
    for the sample feature.
]]

local MOD_NAME = "{{name}}"
local MOD_VERSION = "0.1.0"
local MOD_AUTHOR = "{{author}}"

local function BootLog(Message)
    print("[" .. MOD_NAME .. "] " .. tostring(Message) .. "\n")
end

---Loads one of this mod's own core/systems/data modules (dotted path relative
---to this mod's own Scripts/ folder, e.g. "core.util" -> Scripts/core/util.lua),
---reporting a specific, loud failure instead of leaving whoever hits it to
---guess why a `require` errored somewhere downstream.
---@param Name string
---@return any|nil
local function Need(Name)
    local Ok, ModuleOrError = pcall(require, Name)
    if Ok then return ModuleOrError end
    BootLog("FATAL: could not load module '" .. Name .. "'")
    BootLog("FATAL:   " .. tostring(ModuleOrError))
    return nil
end

local Util = Need("core.util")
local Config = Need("core.config")
local SelfTest = Need("core.selftest")
local Help = Need("core.help")
-- UEHelpers ships with UE4SS in Mods/shared; Need reports a load failure loudly.
local UEHelpers = Need("UEHelpers")

-- Every later section builds on these. Half-loading would leave `selftest` (or
-- worse, the sample feature) registered against a module that never loaded, so
-- bail out loudly instead of failing piecemeal later.
if not Util or not Config or not SelfTest or not Help or not UEHelpers then
    BootLog("FATAL: one or more core modules failed to load; mod is inert.")
    return
end

--------------------------------------------------------------------------------
--  Command registry — every command below registers through this, so `help`
--  (wired at the very end of this file, once every other command exists)
--  always lists exactly what's really registered.
--------------------------------------------------------------------------------

local Registry = Help.NewRegistry()

--------------------------------------------------------------------------------
--  Config
--------------------------------------------------------------------------------

local ModConfig = Config.Load()
Util.Log(string.format("Config: ExampleFeatureEnabled=%s, ExampleThreshold=%s",
    tostring(ModConfig.ExampleFeatureEnabled), tostring(ModConfig.ExampleThreshold)))

--------------------------------------------------------------------------------
--  Keybinds — read keybinds.json only. keybinds.json.example is documentation:
--  binding its keys by default could collide with the game's own keys, and
--  key binds are never assumed to be wanted. Copy it to keybinds.json to opt in.
--------------------------------------------------------------------------------

local function ReadFile(Path)
    local File = io.open(Path, "r")
    if File == nil then return nil end
    local Text = File:read("*a")
    File:close()
    return Text
end

-- Absolute paths in the mod folder: a bare name would be looked up in Binaries/Win64.
local KeybindsText = ReadFile(Util.ModPath("keybinds.json"))
local KeybindsSource = "keybinds.json"

local Keybinds = {}
if KeybindsText ~= nil then
    Keybinds = Util.ParseKeybindsJSON(KeybindsText)
    local BoundCount = 0
    for _ in pairs(Keybinds) do BoundCount = BoundCount + 1 end
    Util.Log(string.format("Keybinds loaded from %s (%d bound).", KeybindsSource, BoundCount))
else
    Util.Log("No keybinds.json; no keys bound. Copy keybinds.json.example to keybinds.json to bind keys.")
end

-- RegisterKeyBind (RE-UE4SS/docs/lua-api/global-functions/registerkeybind.md):
-- `Key` is a UE4SS global table of virtual-key codes, guarded here in case a
-- build ever loads this file before injecting it.
-- Key callbacks run on the UE4SS event-loop thread, not the game thread, so
-- every handler is deferred through ExecuteInGameThread (and guarded) before
-- it may touch a UObject.
---@param KeyName string
---@param Handler function
---@return boolean Bound
local function BindKey(KeyName, Handler)
    local KeyValue = type(Key) == "table" and Key[KeyName] or nil
    if KeyValue == nil then
        Util.Log(string.format(
            "Keybinds: '%s' is not a member of UE4SS's Key table; skipped.", tostring(KeyName)))
        return false
    end
    RegisterKeyBind(KeyValue, function()
        ExecuteInGameThread(function()
            Util.SafeCall(Handler, "keybind:" .. tostring(KeyName))
        end)
    end)
    return true
end

if type(Key) == "table" then
    for KeyName, Label in pairs(Keybinds) do
        BindKey(KeyName, function()
            Util.Log(string.format("Keybind %s -> %s", KeyName, Label))
            -- A real mod would dispatch Label to its own command/feature
            -- here (e.g. through a small name -> function registry in
            -- systems/); this template just reports that the bind fired.
        end)
    end
else
    Util.Log("Keybinds: UE4SS 'Key' table is not available; no keys bound.")
end

--------------------------------------------------------------------------------
--  Self-test
--------------------------------------------------------------------------------

-- RegisterConsoleCommandHandler (RE-UE4SS/docs/lua-api/global-functions/registerconsolecommandhandler.md),
-- through Registry so `help` lists it.
Registry.Register("selftest", function(FullCommand, Parameters, OutputDevice)
    Util.SafeCall(function() SelfTest.Run(OutputDevice) end, "selftest")
    -- true = handled, so the engine does not also report an unknown command.
    return true
end, "Run every registered in-game self-test check and report PASS/FAIL.")

--------------------------------------------------------------------------------
--  Features — Scripts/features/*.lua modules, wired via their M.register(ctx)
--  contract (FeatureCtx below is the ctx contract). List each copied-in module's dotted require path
--  here; a fresh scaffold has none yet, so this starts empty.
--------------------------------------------------------------------------------

local FEATURE_MODULES = {
    -- "features.noclip",
    -- "features.godmode",
    -- ... one entry per Scripts/features/<name>.lua file actually copied in.
}

---Shared ctx passed to every features/*.lua module's M.register(ctx) AND to
---systems/dev.lua's Dev.register(ctx) below — see FeatureCtx in main.lua
---for the base contract; ctx.config/ctx.feature_modules are additional fields
---only dev.lua's `devstatus` command reads.
local FeatureCtx = {
    log = Util.Log,
    register_command = function(Name, Handler, Description)
        Registry.Register(Name, Handler, Description)
    end,
    -- Handler runs on the game thread, guarded (see BindKey above).
    register_keybind = BindKey,
    -- The opt-in gate: features/*.lua modules never wire a keybind unless this
    -- is true ("whether keybinds are wanted" is a required,
    -- never-assumed question). Comes from config, defaulting to false.
    keybinds_enabled = ModConfig.KeybindsEnabled == true,
    command_prefix = "",
    config = ModConfig,
    feature_modules = FEATURE_MODULES,
}

for _, ModulePath in ipairs(FEATURE_MODULES) do
    local LoadOk, FeatureOrError = pcall(require, ModulePath)
    if LoadOk and type(FeatureOrError) == "table" and type(FeatureOrError.register) == "function" then
        local RegisterOk, RegisterErr = pcall(FeatureOrError.register, FeatureCtx)
        if RegisterOk then
            Util.Log("Feature loaded: " .. ModulePath)
        else
            Util.Log(string.format("Feature '%s' FAILED to register: %s", ModulePath, tostring(RegisterErr)))
        end
    else
        Util.Log(string.format("Feature '%s' FAILED to load: %s", ModulePath, tostring(FeatureOrError)))
    end
end

--------------------------------------------------------------------------------
--  Dev tooling (systems/dev.lua) — DEV/TESTING-ONLY. See that file's own
--  header before shipping this mod; the release-time dev-tooling pruning step
--  is where a real mod decides whether to delete it. Loaded the same
--  soft-optional way as the features above (never fatal if missing — deleting
--  Scripts/systems/dev.lua at release time needs no other change here).
--------------------------------------------------------------------------------

local DevOk, Dev = pcall(require, "systems.dev")
if DevOk and type(Dev) == "table" and type(Dev.register) == "function" then
    local DevRegisterOk, DevRegisterErr = pcall(Dev.register, FeatureCtx)
    if DevRegisterOk then
        Util.Log("Dev tooling loaded (systems/dev.lua) - DEV-ONLY, prune before release.")
    else
        Util.Log("Dev tooling FAILED to register: " .. tostring(DevRegisterErr))
    end
else
    Util.Log("Dev tooling not present (systems/dev.lua missing or already pruned); skipping.")
end

--------------------------------------------------------------------------------
--  Sample feature — safely hooking a UFunction and touching the game thread
--------------------------------------------------------------------------------

-- RegisterHook (RE-UE4SS/docs/lua-api/global-functions/registerhook.md) fires
-- whenever the named UFunction runs. The UFunction must already exist in
-- memory when RegisterHook is called, so the registration itself is wrapped in
-- pcall: a game/UE4SS build where it is missing must not take the rest of this
-- mod down with it.
Util.SafeCall(function()
    RegisterHook("/Script/Engine.PlayerController:ClientRestart", function(Context, NewPawn)
        if not ModConfig.ExampleFeatureEnabled then return end

        -- A RemoteUnrealParam (Context) is only valid while the hook callback
        -- runs, so resolve it to a UObject here and hand only that UObject to
        -- the deferred closure.
        local PlayerController = Context and Context:get()

        -- ExecuteInGameThread (RE-UE4SS/docs/lua-api/global-functions/executeingamethread.md):
        -- a hook callback is not guaranteed to already be on the game thread, so
        -- any UObject touch that must be safe is deferred through here, same as
        -- the CONTROL+F1 example in RE-UE4SS/docs/guides/creating-a-lua-mod.md.
        ExecuteInGameThread(function()
            Util.SafeCall(function()
                if Util.IsValid(PlayerController) then
                    Util.Log("Sample feature: PlayerController restarted -> " ..
                        tostring(PlayerController:GetFullName()))
                end
            end, "sample-feature")
        end)
    end)
end, "RegisterHook(ClientRestart)")

--------------------------------------------------------------------------------
--  Help — registered LAST so its listing covers every command above,
--  including the features/dev-tooling ones registered through Registry.
--------------------------------------------------------------------------------

Help.Register(Registry, "help")

BootLog("Loaded. Run 'help' in-game for the full list of available commands.")
BootLog(string.format("v%s | Author: %s", MOD_VERSION, MOD_AUTHOR))
