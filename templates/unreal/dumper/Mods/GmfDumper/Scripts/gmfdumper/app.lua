-- Wires the mod together: finds the native functions, loads the config, and registers the
-- console command and the key bind. Everything it needs from UE4SS comes through the
-- `api` table (the Lua globals), so the offline tests can pass a fake one.

local Config = require("gmfdumper.config")
local Fs = require("gmfdumper.fs")
local Manifest = require("gmfdumper.manifest")
local Runner = require("gmfdumper.runner")
local Steps = require("gmfdumper.steps")
local Tour = require("gmfdumper.tour")
local Levels = require("gmfdumper.levels")

local App = {}

App.VERSION = "0.1.0"
App.NATIVE_PREFIX = "GmfDumperNative_"
App.NATIVE_NAMES = {
    "Version", "WorkingDir", "BuildInfo", "MapName",
    "MakeDirs", "Move", "ListDir", "FileSize", "IsDir", "TreeStats",
    "LoadAllAssets", "FreeAllAssets", "HeldAssets",
    "DumpObjects", "GenerateCXX", "GenerateLuaTypes", "GenerateTMapOverrides", "GenerateBPSDK",
    "DumpReflection", "DumpNames", "DumpScripts", "DumpHooks", "DumpAssetRegistry", "DumpActors",
    "DumpRuntime", "DumpWorldValues", "DumpDataTables", "DumpDataAssets", "DumpConfigObjects", "DumpClassDefaults",
    "DumpAssetValues",
    "DumpWidgetTrees", "DumpGameplayTags", "ExeInfo", "EndProcess", "ListMaps", "DumpLevel", "ListLoadedMaps",
}

local function parent(path)
    return (path:gsub("[\\/]+$", ""):match("^(.*)[\\/][^\\/]+$"))
end

local function is_absolute(path)
    return path:match("^%a:[\\/]") ~= nil or path:match("^[\\/][\\/]") ~= nil
end

-- Collects the native functions the C++ part registered as globals. Returns nil and a
-- reason when the C++ part is missing or is a different version.
function App.find_native(api)
    local version_fn = rawget(api, App.NATIVE_PREFIX .. "Version")
    if type(version_fn) ~= "function" then
        return nil, "the native DLL is not loaded"
    end
    local ok, version = pcall(version_fn)
    if not ok or version ~= App.VERSION then
        return nil, string.format("native version %s does not match Lua version %s", tostring(version), App.VERSION)
    end
    local native = {}
    for _, name in ipairs(App.NATIVE_NAMES) do
        local fn = rawget(api, App.NATIVE_PREFIX .. name)
        if type(fn) == "function" then
            native[name] = fn
        end
    end
    return native
end

local function safe(fn, ...)
    local results = table.pack(pcall(fn, ...))
    if results[1] then
        return table.unpack(results, 2, results.n)
    end
    return nil
end

function App.install(options)
    local api = options.api
    local mod_dir = options.mod_dir
    local app = { run_log = nil }

    local function log(message)
        local line = "[GmfDumper] " .. tostring(message)
        api.print(line .. "\n")
        if app.run_log then
            local f = io.open(app.run_log, "ab")
            if f then
                f:write(os.date("%H:%M:%S "), tostring(message), "\n")
                f:close()
            end
        end
    end
    app.log = log

    local native, native_reason = App.find_native(api)
    app.native = native
    local fs = Fs.new(native)
    app.fs = fs

    local config = Config.load(mod_dir .. "\\config.lua", api.Key, api.ModifierKey)
    app.config = config
    for _, warning in ipairs(config.warnings) do
        log("config: " .. warning)
    end

    local mods_dir = options.mods_dir or parent(mod_dir)
    local working_dir = options.working_dir
        or (native and native.WorkingDir and safe(native.WorkingDir))
        or parent(mods_dir)
    working_dir = working_dir:gsub("[\\/]+$", "")
    app.working_dir = working_dir

    local output_root = config.output_root
    if not is_absolute(output_root) then
        output_root = working_dir .. "\\" .. output_root
    end
    app.output_root = output_root

    local function engine_version()
        local uv = api.UnrealVersion
        local major = uv and safe(uv.GetMajor)
        local minor = uv and safe(uv.GetMinor)
        if major and minor then
            return string.format("%d.%d", major, minor)
        end
        return "unknown"
    end

    local function ue4ss_version()
        local info = native and native.BuildInfo and safe(native.BuildInfo)
        if type(info) == "string" and info ~= "" then
            return info
        end
        local major, minor, hotfix = nil, nil, nil
        if api.UE4SS and api.UE4SS.GetVersion then
            major, minor, hotfix = safe(api.UE4SS.GetVersion)
        end
        if major then
            return string.format("%s.%s.%s", major, minor or 0, hotfix or 0)
        end
        return "unknown"
    end

    local function game_name()
        local project = working_dir:match("([^\\/]+)[\\/][Bb]inaries[\\/]")
        return project or "Game"
    end

    local steps = Steps.build({ api = api, native = native, config = config })
    app.steps = steps

    local runner = Runner.new({
        steps = steps,
        fs = fs,
        has_native = native ~= nil,
        schedule = function(fn)
            api.ExecuteInGameThread(fn)
        end,
        log = log,
        make_run = function()
            local name = string.format("%s-%s-%s", game_name(), engine_version(), os.date("%Y%m%d-%H%M%S"))
            name = name:gsub('[<>:"/\\|%?%*%%!]', "_")
            local run_dir = output_root .. "\\" .. name
            local made, err = fs.mkdirs(run_dir)
            if not made then
                return nil, err
            end
            app.run_log = run_dir .. "\\gmfdumper.log"
            -- Identifies the game build: "<path>|<bytes>|<link time>".
            local exe_path, exe_bytes, exe_time
            local exe_info = native and native.ExeInfo and safe(native.ExeInfo)
            if type(exe_info) == "string" then
                exe_path, exe_bytes, exe_time = exe_info:match("^(.*)|(%d+)|(%d+)$")
            end
            return run_dir, {
                game_exe = exe_path,
                game_exe_bytes = exe_bytes and math.tointeger(exe_bytes) or nil,
                game_exe_link_time = exe_time and math.tointeger(exe_time) or nil,
                mod_version = App.VERSION,
                native_version = native and App.VERSION or nil,
                game = game_name(),
                engine_version = engine_version(),
                ue4ss_version = ue4ss_version(),
                map = (native and native.MapName and safe(native.MapName)) or "unknown",
            }
        end,
        make_manifest = function(run_dir, header, ids)
            return Manifest.new(fs, run_dir, header, ids)
        end,
        make_context = function(_, request)
            if request and request.auto and config.auto_run.freeze_input then
                app.freeze_input()
            end
            local settings = fs.read(working_dir .. "\\UE4SS-settings.ini")
            local object_dumper = Steps.read_ini_section(settings, "ObjectDumper")
            local cxx = Steps.read_ini_section(settings, "CXXHeaderGenerator")
            if object_dumper.LoadAllAssetsBeforeDumpingObjects == "1"
                or cxx.LoadAllAssetsBeforeGeneratingCXXHeaders == "1" then
                log("warning: a LoadAllAssetsBefore* setting is 1 in UE4SS-settings.ini, so UE4SS will load "
                    .. "all assets again inside its own dumpers. Set them to 0 when using GmfDumper.")
            end
            return {
                fs = fs, working_dir = working_dir, mods_dir = mods_dir, config = config,
                api = api, native = native, state = {}, log = log,
                auto = request and request.auto or false,
                profile = request and not request.only and request.profile or nil,
            }
        end,
        -- A run that ends early still leaves run_complete.json, so nothing waits for it in
        -- vain. The game stays open: the run did not do what was asked.
        on_stopped = function(ctx, manifest, reason)
            pcall(manifest.write_run_complete, manifest, { native = native ~= nil, game_left_open = true, reason = reason })
            app.restore_input()
            app.run_log = nil
        end,
        on_start_failed = function(run_dir, reason, request)
            pcall(Manifest.write_failed_run, fs, run_dir, {
                profile = request and (request.only and "custom" or request.profile) or nil,
                native = native ~= nil, reason = reason,
            })
            app.restore_input()
            app.run_log = nil
        end,
        on_finish = function(ctx, manifest)
            fs.write_atomic(output_root .. "\\latest.txt", ctx.run_dir .. "\n")
            local quitting = ctx.auto and config.auto_run.quit_when_done
            local produced = manifest:counts().ok > 0
            if ctx.auto and not produced then
                -- Nothing was dumped. Closing the game now would hide that, and in "once"
                -- mode the marker would block the next attempt.
                quitting = false
                os.remove(app.auto_run_marker)
                log("the automatic run produced nothing, so the game stays open and the run will be tried "
                    .. "again on the next start. See manifest.json in the run folder for the reasons.")
            end
            if manifest.data.assets_force_loaded and not quitting then
                log("all assets were force-loaded during this run. Restart the game before playing on.")
            end

            local levels_run = nil
            local wrapped_up = false
            local function wrap_up()
                -- Runs once: a failure after the level dump or the tour has called it must not
                -- write the end-of-run file or close the game a second time.
                if wrapped_up then
                    return
                end
                wrapped_up = true
                app.touring = false
                -- The maps the step levels_loaded wrote count too when no level dump followed.
                local levels_source = levels_run or (ctx.state and ctx.state.levels)
                local levels_ok, levels_total = 0, 0
                for _, result in ipairs(levels_source and levels_source.results or {}) do
                    levels_total = levels_total + 1
                    levels_ok = levels_ok + (result.status == "ok" and 1 or 0)
                end
                -- The last file of the run: the framework waits for it before it collects.
                local written, problem = pcall(manifest.write_run_complete, manifest, {
                    profile = ctx.profile, levels_ok = levels_ok, levels_total = levels_total,
                    native = native ~= nil, game_left_open = not quitting,
                })
                if not written then
                    log("run_complete.json was not written: " .. tostring(problem))
                end
                if not quitting then
                    app.restore_input()
                end
                if quitting then
                    log("automatic run finished; closing the game")
                end
                -- Later messages belong to no run; keep them out of this run's log file.
                app.run_log = nil
                if quitting then
                    app.quit_game()
                end
            end

            -- Two things can follow a full run: the level dump, which loads every map as
            -- data, and the map tour, which travels to each map and is off unless asked
            -- for. Both are skipped for quick runs and runs of single steps.
            local after_run = native ~= nil and produced and ctx.profile == "full"
            local levels_wanted = after_run and config.levels.enabled and native.DumpLevel ~= nil
            local tour_wanted = after_run and config.map_tour.enabled
            if not levels_wanted and not tour_wanted then
                return wrap_up()
            end
            app.touring = true

            local function start_tour()
                local world_steps = {}
                for _, id in ipairs(Steps.WORLD) do
                    for _, step in ipairs(steps) do
                        if step.id == id and not step.disabled then
                            world_steps[#world_steps + 1] = step
                        end
                    end
                end
                local tour = Tour.new({
                    api = api, native = native, fs = fs, config = config.map_tour, log = log,
                    after = app.after, controller = app.player_controller, clock = os.clock,
                    world_steps = world_steps,
                    crash_file = mod_dir .. "\\map_tour_crashed.txt",
                    make_context = function(world_folder)
                        return {
                            fs = fs, working_dir = working_dir, mods_dir = mods_dir, config = config, api = api,
                            native = native, state = {}, log = log, run_dir = ctx.run_dir, world_folder = world_folder,
                        }
                    end,
                })
                local started, err = pcall(tour.start, tour, ctx.run_dir, wrap_up)
                if not started then
                    log("map tour failed: " .. tostring(err))
                    wrap_up()
                end
            end
            if levels_wanted then
                -- The step levels_loaded made this object when it wrote the maps in memory.
                local levels = ctx.state and ctx.state.levels or Levels.new({
                    api = api, native = native, fs = fs, config = config.levels, log = log,
                    min_free_mb = math.floor(config.load_assets.min_free_memory_gb * 1024),
                })
                levels.after = app.after
                levels_run = levels
                local started, err = pcall(levels.start, levels, ctx.run_dir, function()
                    if tour_wanted then
                        start_tour()
                    else
                        wrap_up()
                    end
                end)
                if not started then
                    log("levels failed: " .. tostring(err))
                    wrap_up()
                end
                return
            end
            return start_tour()
        end,
    })
    app.runner = runner

    -- Runs `fn` on the game thread after `seconds`. UE4SS builds differ in which timer
    -- functions they have and which hooks are active, so this tries the game-thread timer
    -- first and then the async timer followed by a hop to the game thread.
    local function after(seconds, fn)
        local ms = math.floor(seconds * 1000)
        local reason = "this UE4SS build has no delay function"
        if type(api.ExecuteInGameThreadWithDelay) == "function" then
            local ok, err = pcall(api.ExecuteInGameThreadWithDelay, ms, fn)
            if ok then
                return true
            end
            reason = tostring(err)
        end
        if type(api.ExecuteWithDelay) == "function" then
            local ok, err = pcall(api.ExecuteWithDelay, ms, function()
                pcall(api.ExecuteInGameThread, fn)
            end)
            if ok then
                return true
            end
            reason = tostring(err)
        end
        return false, reason
    end

    app.after = after

    local function valid(object)
        return object ~= nil and safe(function() return object:IsValid() end) == true
    end

    -- The controller of the local player, or nil. A game keeps several worlds loaded, each
    -- with objects that look right but do nothing; the controller that counts is the one
    -- with a player attached. UEHelpers, which ships with UE4SS, is the fallback.
    local function player_controller()
        if type(api.FindAllOf) == "function" then
            local controllers = safe(api.FindAllOf, "PlayerController")
            if type(controllers) == "table" then
                for _, controller in ipairs(controllers) do
                    if valid(controller) and valid(safe(function() return controller.Player end)) then
                        return controller
                    end
                end
            end
        end
        if type(api.require) == "function" then
            local ok, helpers = pcall(api.require, "UEHelpers")
            if ok and type(helpers) == "table" and type(helpers.GetPlayerController) == "function" then
                local found, controller = pcall(helpers.GetPlayerController)
                if found and valid(controller) and valid(safe(function() return controller.Player end)) then
                    return controller
                end
            end
        end
        return nil
    end

    app.player_controller = player_controller

    -- Stops movement and camera input for the local player. It does not block menus, and
    -- each dump step blocks the game thread anyway; this only keeps the player from
    -- wandering between steps. Best effort: a game without a player controller is left alone.
    function app.freeze_input()
        local controller = player_controller()
        if not controller then
            log("input not frozen: no local player controller was found")
            return false
        end
        local ok = pcall(function()
            controller:SetIgnoreMoveInput(true)
            controller:SetIgnoreLookInput(true)
        end)
        if ok then
            app.input_frozen = true
        end
        log(ok and "player movement and look input frozen for the run" or "input not frozen: the game refused the call")
        return ok
    end

    -- Gives input back after a run that does not close the game.
    function app.restore_input()
        if not app.input_frozen then
            return false
        end
        app.input_frozen = false
        local controller = player_controller()
        local ok = controller ~= nil and pcall(function()
            controller:ResetIgnoreMoveInput()
            controller:ResetIgnoreLookInput()
        end)
        log(ok and "player input restored" or "player input could not be restored; restart the game")
        return ok
    end

    -- Closes the game. First the way its own quit menu does, through the engine. The
    -- engine may ignore that, for example when the call reaches the wrong world, so a
    -- little later the process is ended directly if the native part is there to do it.
    -- Every file of the run is closed before this is called.
    function app.quit_game()
        local function force()
            if native and native.EndProcess then
                log("the game is still running; ending the process")
                pcall(native.EndProcess)
            else
                log("the game did not close by itself. The dump is complete; close the game by hand.")
            end
        end
        local function quit()
            local library = safe(api.StaticFindObject, "/Script/Engine.Default__KismetSystemLibrary")
            local controller = player_controller()
            local asked = valid(library) and controller ~= nil and pcall(function()
                -- QuitGame(WorldContextObject, SpecificPlayer, QuitPreference, bIgnorePlatformRestrictions)
                -- QuitPreference 0 is "Quit".
                library:QuitGame(controller, controller, 0, false)
            end)
            if not asked then
                log("the engine's QuitGame could not be called")
                force()
                return
            end
            -- If this timer ever fires, the game is still open.
            after(10, force)
        end
        -- A short pause lets UE4SS write its log before the game goes away.
        if not after(2, quit) then
            quit()
        end
    end

    local function start(request, reply)
        if app.touring then
            reply("could not start: the map tour of the last run is still going")
            return nil
        end
        local ok, err = runner:start(request)
        if not ok then
            reply("could not start: " .. tostring(err))
        end
        return ok
    end

    -- Handles the words after "gmfdump". `reply` prints one line to the caller.
    function app.handle_command(parts, reply)
        reply = reply or log
        local words = {}
        for _, part in ipairs(parts or {}) do
            local word = tostring(part):lower()
            if not (#words == 0 and word == "gmfdump") then
                words[#words + 1] = word
            end
        end

        if #words == 0 then
            return start({ profile = config.default_profile }, reply)
        end
        if #words == 1 and (words[1] == "full" or words[1] == "quick") then
            return start({ profile = words[1] }, reply)
        end
        if #words == 1 and words[1] == "list" then
            reply("native part: " .. (native and ("loaded, version " .. App.VERSION)
                or ("not available (" .. tostring(native_reason) .. ")")))
            for _, step in ipairs(steps) do
                local note = ""
                if step.needs_native and not native then
                    note = "  (needs the native DLL)"
                elseif step.disabled then
                    note = "  (disabled in config.lua)"
                elseif not step.profiles.quick then
                    note = "  (full profile only)"
                end
                reply("  " .. step.id .. note)
            end
            return true
        end
        if #words == 1 and words[1] == "help" then
            reply("gmfdump [full|quick|list|help|<step> ...]")
            return true
        end

        -- A list of step ids. Loading assets without releasing them would leave the game
        -- holding every asset, so the release step is added when it was left out.
        local only, has_load, has_unload = {}, false, false
        for _, word in ipairs(words) do
            only[#only + 1] = word
            has_load = has_load or word == "load_assets"
            has_unload = has_unload or word == "unload_assets"
        end
        if has_load and not has_unload then
            only[#only + 1] = "unload_assets"
        end
        return start({ only = only }, reply)
    end

    api.RegisterConsoleCommandGlobalHandler("gmfdump", function(_, command_parts, ar)
        local function reply(message)
            log(message)
            if ar then
                pcall(function()
                    ar:Log("[GmfDumper] " .. tostring(message))
                end)
            end
        end
        local ok, err = pcall(app.handle_command, command_parts, reply)
        if not ok then
            reply("command failed: " .. tostring(err))
        end
        return true
    end)

    local bind = config.keybind
    local key = api.Key and api.Key[bind.key]
    if key and api.RegisterKeyBind then
        local modifiers = {}
        for _, name in ipairs(bind.modifiers) do
            modifiers[#modifiers + 1] = api.ModifierKey[name]
        end
        local already = api.IsKeyBindRegistered and safe(api.IsKeyBindRegistered, key, modifiers)
        if already then
            log("key bind " .. bind.key .. " is already taken by another mod; use the gmfdump command")
        else
            api.RegisterKeyBind(key, modifiers, function()
                -- Key binds fire on UE4SS's input thread; the run must start on the game thread.
                local ok, err = pcall(api.ExecuteInGameThread, function()
                    app.handle_command({}, log)
                end)
                if not ok then
                    log("key bind failed: " .. tostring(err))
                end
            end)
        end
    end

    -- Automatic run: the mod starts a run by itself some seconds after the game starts.
    -- In "once" mode a marker file records that it happened. The marker is written when
    -- the run starts, not when it ends, so a run that crashes the game is not repeated on
    -- every launch.
    local marker = mod_dir .. "\\auto_run_done.txt"
    app.auto_run_marker = marker

    function app.auto_run_due()
        local mode = config.auto_run.mode
        if mode == "always" then
            return true
        end
        return mode == "once" and not fs.exists(marker)
    end

    -- Whether the automatic run may start on this map, and if not, why it waits.
    -- A game passes through startup screens before its menu; a dump taken there misses
    -- most of the game and describes a level nobody plays.
    function app.map_is_usable(map)
        if map == nil or map == "none" then
            return false, "the game has no local player yet"
        end
        local lowered = map:lower()
        for _, word in ipairs(config.auto_run.skip_maps) do
            if lowered:find(word, 1, true) then
                return false, "map " .. map .. " looks like a startup screen (auto_run.skip_maps has \"" .. word .. "\")"
            end
        end
        local wanted = config.auto_run.wait_for_map
        if wanted ~= "" and not lowered:find(wanted:lower(), 1, true) then
            return false, "map " .. map .. " is not the one asked for (auto_run.wait_for_map = \"" .. wanted .. "\")"
        end
        return true
    end

    local POLL_SECONDS = 2

    function app.begin_auto_run(state)
        state = state or { waited = 0, stable = 0 }
        -- With the native part the mod can see which map is loaded, and waits for a usable
        -- one that has stayed loaded for settle_seconds. Without it, the delay is all there is.
        if native and native.MapName then
            local map = safe(native.MapName)
            local usable, reason = app.map_is_usable(map)
            if map == state.map then
                state.stable = state.stable + POLL_SECONDS
            else
                state.map = map
                state.stable = 0
            end
            if usable and state.stable < config.auto_run.settle_seconds then
                usable, reason = false, "map " .. map .. " has to stay loaded for "
                    .. tostring(config.auto_run.settle_seconds) .. " seconds"
            end
            if not usable then
                if state.waited >= config.auto_run.max_wait_seconds then
                    log("automatic run: waited " .. tostring(state.waited) .. " seconds; starting anyway. Last reason: " .. reason)
                else
                    if reason ~= state.reason then
                        state.reason = reason
                        log("automatic run: waiting, " .. reason)
                    end
                    state.waited = state.waited + POLL_SECONDS
                    if after(POLL_SECONDS, function() app.begin_auto_run(state) end) then
                        return
                    end
                end
            end
        end
        if runner:is_running() then
            return
        end
        -- Without the marker a run that closes the game would repeat on every start, so
        -- the run does not begin unless the marker could be written.
        local marked, mark_err = fs.write_atomic(marker, "An automatic GmfDumper run started at "
            .. os.date("%Y-%m-%d %H:%M:%S") .. ".\r\nDelete this file to let the automatic run happen again.\r\n")
        if not marked and config.auto_run.mode == "once" then
            log("automatic run cancelled: could not write " .. marker .. ": " .. tostring(mark_err))
            return
        end
        log("automatic run starting, profile " .. config.default_profile)
        local ok, err = runner:start({ profile = config.default_profile, auto = true })
        if not ok then
            -- Nothing ran, so the one automatic run is not used up, and input that was
            -- frozen while the run was being set up is given back.
            os.remove(marker)
            app.restore_input()
            log("automatic run could not start: " .. tostring(err))
        end
    end

    if app.auto_run_due() then
        local delay = config.auto_run.delay_seconds
        local ok, err = after(delay, function() app.begin_auto_run() end)
        if ok then
            log(string.format("automatic run in %s seconds (auto_run.mode = \"%s\" in config.lua)", tostring(delay), config.auto_run.mode))
        else
            log("automatic run not scheduled: " .. tostring(err))
        end
    elseif config.auto_run.mode == "once" then
        log("automatic run already happened; delete Mods\\GmfDumper\\auto_run_done.txt to run it again")
    end

    log(string.format("ready, version %s, native part %s. Type: gmfdump", App.VERSION,
        native and "loaded" or ("not available (" .. tostring(native_reason) .. ")")))
    return app
end

return App
