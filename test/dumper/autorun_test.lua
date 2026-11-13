local App = require("gmfdumper.app")
local Config = require("gmfdumper.config")
local json = require("dkjson")

local tests = {}

-- A fake UE4SS with a timer queue. Delayed callbacks are collected and run by the test,
-- so no test waits in real time.
--
-- The fake game has two player controllers, as a real game with several loaded worlds
-- does: an inert one with no player, listed first, and the real one.
local function install(t, options)
    options = options or {}
    local root = t.support.temp_dir("auto") .. "\\Funnel Runners"
    local working = root .. "\\StormEscape\\Binaries\\Win64\\ue4ss"
    local mod_dir = working .. "\\Mods\\GmfDumper"
    t.support.mkdir(mod_dir)
    t.support.mkdir(working .. "\\Mods\\shared")
    t.support.write(working .. "\\UE4SS-settings.ini", "[ObjectDumper]\n")
    t.support.write(working .. "\\UE4SS.log", "x")
    if options.config then
        t.support.write(mod_dir .. "\\config.lua", options.config)
    end
    if options.marker then
        t.support.write(mod_dir .. "\\auto_run_done.txt", "earlier")
    end

    local printed, timers, calls = {}, {}, {}
    local function call(text)
        calls[#calls + 1] = text
    end
    local function make_controller(label, has_player)
        return {
            label = label,
            IsValid = function() return true end,
            Player = { IsValid = function() return has_player end },
            SetIgnoreMoveInput = function(_, value) call(label .. " move " .. tostring(value)) end,
            SetIgnoreLookInput = function(_, value) call(label .. " look " .. tostring(value)) end,
            ResetIgnoreMoveInput = function() call(label .. " reset move") end,
            ResetIgnoreLookInput = function() call(label .. " reset look") end,
        }
    end
    local inert = make_controller("inert", false)
    local real = make_controller("real", true)
    local library = {
        IsValid = function() return true end,
        QuitGame = function(_, context, player, preference, ignore)
            call(string.format("QuitGame %s %s %s", tostring(context == real and player == real), tostring(preference),
                tostring(ignore)))
        end,
    }
    local api = {
        print = function(text) printed[#printed + 1] = text end,
        Key = { NUM_ZERO = 0x60 },
        ModifierKey = { CONTROL = 0x11 },
        UnrealVersion = { GetMajor = function() return 5 end, GetMinor = function() return 6 end },
        ExecuteInGameThread = function(fn) fn() end,
        ExecuteInGameThreadWithDelay = function(ms, fn) timers[#timers + 1] = { ms = ms, fn = fn } end,
        RegisterConsoleCommandGlobalHandler = function() end,
        RegisterKeyBind = function() end,
        DumpUSMAP = function() t.support.write(working .. "\\G.usmap", "u") end,
        FindAllOf = function(name)
            if name ~= "PlayerController" or options.no_controller then
                return nil
            end
            return options.only_inert and { inert } or { inert, real }
        end,
        StaticFindObject = function(path)
            if path == "/Script/Engine.Default__KismetSystemLibrary" and not options.no_library then
                return library
            end
            return nil
        end,
        require = function(name) error("module not found: " .. name) end,
        GmfDumperNative_Version = function() return "0.1.0" end,
        GmfDumperNative_EndProcess = function() call("EndProcess") return true end,
    }
    for name, value in pairs(options.api or {}) do
        api[name] = value or nil
    end
    local app = App.install({ api = api, mod_dir = mod_dir })

    local w = { app = app, working = working, mod_dir = mod_dir, timers = timers, calls = calls, printed = printed }
    function w.text()
        return table.concat(printed)
    end
    -- Runs the timers queued so far, in order, including ones they queue themselves.
    function w.run_timers(limit)
        local i = w.next_timer or 1
        local last = limit and (i + limit - 1) or math.huge
        while timers[i] and i <= last do
            timers[i].fn()
            i = i + 1
        end
        w.next_timer = i
    end
    function w.manifest()
        local text = t.support.read(working .. "\\Dumps\\latest.txt")
        if not text then
            return nil
        end
        return json.decode(t.support.read((text:gsub("%s+$", "")) .. "\\manifest.json"))
    end
    function w.has(wanted)
        for _, entry in ipairs(calls) do
            if entry == wanted then
                return true
            end
        end
        return false
    end
    function w.marker()
        return t.support.read(mod_dir .. "\\auto_run_done.txt")
    end
    return w
end

function tests.default_config_schedules_one_run_after_the_delay(t)
    local w = install(t)
    t:eq(#w.timers, 1, "one timer queued at install")
    t:eq(w.timers[1].ms, 15000)
    t:eq(w.manifest(), nil, "nothing runs before the delay has passed")
    t:ok(w.text():find("automatic run in 15 seconds", 1, true))
    t:ok(w.text():find("ready, version", 1, true), "install completed")
end

function tests.the_automatic_run_dumps_freezes_and_quits(t)
    local w = install(t)
    w.run_timers(2)
    local data = w.manifest()
    t:ok(data, "a run happened")
    t:eq(data.profile, "full")
    t:ok(data.finished)
    t:ok(w.has("real move true") and w.has("real look true"), "input frozen: " .. table.concat(w.calls, "; "))
    t:ok(w.has("QuitGame true 0 false"), "the game was asked to quit")
    t:no(w.has("EndProcess"), "the process is not ended while the engine may still be quitting")
    t:ok(w.marker(), "marker written")
end

function tests.the_controller_with_a_player_is_used_not_the_first_one(t)
    local w = install(t)
    w.run_timers(2)
    for _, entry in ipairs(w.calls) do
        t:no(entry:find("^inert"), "the inert controller was used: " .. entry)
    end
end

function tests.quit_waits_for_the_run_to_finish(t)
    local w = install(t)
    w.run_timers(1)
    t:ok(w.manifest().finished, "the run is complete")
    t:no(w.has("QuitGame true 0 false"), "quit has not happened yet")
    t:eq(w.timers[2].ms, 2000, "quit is scheduled two seconds later")
end

function tests.a_game_that_ignores_quit_is_ended_ten_seconds_later(t)
    local w = install(t)
    w.run_timers(2)
    t:eq(w.timers[3].ms, 10000)
    t:no(w.has("EndProcess"))
    -- This timer only fires if the game is still open.
    w.run_timers(1)
    t:ok(w.has("EndProcess"))
    t:ok(w.text():find("still running", 1, true))
end

function tests.without_a_real_controller_the_process_is_ended_directly(t)
    local w = install(t, { only_inert = true })
    w.run_timers(2)
    t:ok(w.manifest().finished)
    t:ok(w.text():find("input not frozen", 1, true))
    t:no(w.has("QuitGame true 0 false"))
    t:ok(w.has("EndProcess"))
end

function tests.without_the_library_the_process_is_ended_directly(t)
    local w = install(t, { no_library = true })
    w.run_timers(2)
    t:ok(w.has("EndProcess"))
    t:ok(w.text():find("QuitGame could not be called", 1, true))
end

function tests.without_native_or_engine_quit_the_game_is_left_open(t)
    local w = install(t, { no_library = true, api = { GmfDumperNative_Version = false, GmfDumperNative_EndProcess = false } })
    w.run_timers(2)
    t:ok(w.manifest().finished)
    t:no(w.has("EndProcess"))
    t:ok(w.text():find("close the game by hand", 1, true))
end

function tests.once_mode_does_not_run_again(t)
    local w = install(t, { marker = true })
    t:eq(#w.timers, 0)
    t:ok(w.text():find("automatic run already happened", 1, true))
    t:eq(w.marker(), "earlier", "marker untouched")
end

function tests.always_mode_ignores_the_marker(t)
    local w = install(t, { marker = true, config = 'return { auto_run = { mode = "always", delay_seconds = 1 } }' })
    t:eq(#w.timers, 1)
    t:eq(w.timers[1].ms, 1000)
end

function tests.off_mode_schedules_nothing(t)
    local w = install(t, { config = 'return { auto_run = { mode = "off" } }' })
    t:eq(#w.timers, 0)
    t:no(w.text():find("automatic run", 1, true))
end

function tests.a_fractional_delay_does_not_break_the_mod(t)
    local w = install(t, { config = 'return { auto_run = { delay_seconds = 2.5 } }' })
    t:eq(w.timers[1].ms, 2500)
    t:ok(w.text():find("automatic run in 2.5 seconds", 1, true), w.text())
    t:ok(w.text():find("ready, version", 1, true), "install completed")
end

function tests.marker_is_written_when_the_run_starts(t)
    -- A run that crashes the game must not repeat on every launch, so the marker cannot
    -- wait for the end of the run.
    local marker_at_first_step
    local mod_dir
    local w = install(t, { api = { DumpUSMAP = function()
        local f = io.open(mod_dir .. "\\auto_run_done.txt", "rb")
        marker_at_first_step = f ~= nil
        if f then
            f:close()
        end
    end } })
    mod_dir = w.mod_dir
    w.run_timers(1)
    t:eq(marker_at_first_step, true)
end

function tests.a_run_that_cannot_start_does_not_use_up_the_marker(t)
    local w = install(t, { api = { ExecuteInGameThread = function() error("no game thread hook") end } })
    w.run_timers(1)
    t:eq(w.marker(), nil, "marker removed again")
    t:ok(w.text():find("automatic run could not start", 1, true))
    t:ok(w.has("real reset move") and w.has("real reset look"), "input frozen during setup is given back")
    t:no(w.has("QuitGame true 0 false"))
    t:no(w.has("EndProcess"), "the game is not closed: " .. table.concat(w.calls, "; "))
end

function tests.a_run_that_dumps_nothing_does_not_close_the_game(t)
    -- Every UE4SS dump function is missing and the native part has none either: all steps
    -- are skipped or fail, apart from the ones that need no game data.
    local w = install(t, { config = 'return { disabled_steps = { "hooks", "environment", "containers" } }',
        api = { DumpUSMAP = false } })
    w.run_timers(2)
    t:ok(w.manifest().finished)
    t:no(w.has("QuitGame true 0 false"))
    t:no(w.has("EndProcess"))
    t:eq(w.marker(), nil, "the automatic run is tried again next time")
    t:ok(w.text():find("produced nothing", 1, true))
    t:ok(w.has("real reset move"), "input is given back")
end

function tests.manual_runs_never_freeze_or_quit(t)
    local w = install(t, { config = 'return { auto_run = { mode = "off" } }' })
    w.app.handle_command({ "usmap" }, function() end)
    t:ok(w.manifest().finished)
    t:eq(#w.calls, 0, table.concat(w.calls, "; "))
    t:eq(#w.timers, 0)
end

function tests.input_is_restored_when_the_game_stays_open(t)
    local w = install(t, { config = 'return { auto_run = { quit_when_done = false } }' })
    w.run_timers(2)
    t:ok(w.manifest().finished)
    t:ok(w.has("real move true"))
    t:ok(w.has("real reset move") and w.has("real reset look"), table.concat(w.calls, "; "))
    t:no(w.has("QuitGame true 0 false"))
    t:ok(w.text():find("Restart the game before playing on", 1, true) or w.manifest().assets_force_loaded == false)
end

function tests.freeze_and_quit_can_be_turned_off(t)
    local w = install(t, { config = 'return { auto_run = { freeze_input = false, quit_when_done = false } }' })
    w.run_timers(2)
    t:ok(w.manifest().finished)
    t:eq(#w.calls, 0, table.concat(w.calls, "; "))
end

-- The tests below give the fake native part a MapName function, so the mod can see which
-- map is loaded. Timers fire every 2 seconds of fake time.
local function with_map(t, get_map, config)
    return install(t, { api = { GmfDumperNative_MapName = get_map }, config = config })
end

function tests.waits_while_there_is_no_local_player(t)
    local map = "none"
    local w = with_map(t, function() return map end, 'return { auto_run = { settle_seconds = 0 } }')
    w.run_timers(1)
    t:eq(w.manifest(), nil, "no run while there is no local player")
    t:eq(w.timers[2].ms, 2000, "checks again in two seconds")
    t:ok(w.text():find("no local player yet", 1, true))
    map = "/Game/Maps/Lobby.Lobby"
    w.run_timers(1)
    t:ok(w.manifest(), "the run starts once a player exists")
    t:eq(w.manifest().map, "/Game/Maps/Lobby.Lobby")
end

-- What happened in the first real test: 15 seconds after launch the game was still on its
-- shader compilation screen, and the dump was taken there.
function tests.does_not_run_on_a_startup_screen(t)
    local map = "/Game/StormEscape/Maps/lvl_ShaderCompilation.lvl_ShaderCompilation"
    local w = with_map(t, function() return map end, 'return { auto_run = { settle_seconds = 0 } }')
    w.run_timers(5)
    t:eq(w.manifest(), nil, "five checks on the shader screen start nothing")
    t:ok(w.text():find("looks like a startup screen", 1, true), w.text())
    map = "/Game/StormEscape/Maps/Lobby.Lobby"
    w.run_timers(1)
    t:eq(w.manifest().map, "/Game/StormEscape/Maps/Lobby.Lobby")
end

function tests.waits_for_the_map_to_settle(t)
    local map = "/Game/Maps/Lobby.Lobby"
    local w = with_map(t, function() return map end, 'return { auto_run = { settle_seconds = 6 } }')
    -- Checks at 0, 2 and 4 seconds of the same map: not settled yet.
    w.run_timers(3)
    t:eq(w.manifest(), nil)
    t:ok(w.text():find("has to stay loaded for 6 seconds", 1, true))
    -- The check at 6 seconds starts the run.
    w.run_timers(1)
    t:ok(w.manifest())
end

function tests.a_map_change_restarts_the_settle_time(t)
    local map = "/Game/Maps/Menu.Menu"
    local w = with_map(t, function() return map end, 'return { auto_run = { settle_seconds = 4 } }')
    w.run_timers(2)
    map = "/Game/Maps/Lobby.Lobby"
    w.run_timers(2)
    t:eq(w.manifest(), nil, "the new map has only been loaded for two seconds")
    w.run_timers(1)
    t:eq(w.manifest().map, "/Game/Maps/Lobby.Lobby")
end

function tests.wait_for_map_holds_out_for_the_named_map(t)
    local map = "/Game/Maps/MainMenu.MainMenu"
    local w = with_map(t, function() return map end,
        'return { auto_run = { settle_seconds = 0, wait_for_map = "lobby" } }')
    w.run_timers(4)
    t:eq(w.manifest(), nil)
    t:ok(w.text():find("is not the one asked for", 1, true))
    map = "/Game/Maps/Lobby.Lobby"
    w.run_timers(1)
    t:ok(w.manifest(), "the text is matched without regard to case")
end

function tests.gives_up_waiting_after_max_wait_and_runs_anyway(t)
    local w = with_map(t, function() return "none" end,
        'return { auto_run = { max_wait_seconds = 10, quit_when_done = false } }')
    w.run_timers(5)
    t:eq(w.manifest(), nil, "still waiting after 8 seconds")
    w.run_timers(1)
    t:ok(w.manifest(), "after 10 seconds the run starts without a usable map")
    t:ok(w.text():find("starting anyway", 1, true))
end

function tests.waiting_reason_is_logged_once_not_on_every_check(t)
    local w = with_map(t, function() return "none" end, nil)
    w.run_timers(6)
    local _, count = w.text():gsub("no local player yet", "")
    t:eq(count, 1)
end

function tests.new_auto_run_settings_are_validated(t)
    local config = Config.validate({ auto_run = { settle_seconds = -1, max_wait_seconds = "long", wait_for_map = 5,
        skip_maps = { "Shader", 7, "" } } })
    t:eq(config.auto_run.settle_seconds, 10)
    t:eq(config.auto_run.max_wait_seconds, 300)
    t:eq(config.auto_run.wait_for_map, "")
    t:eq(#config.auto_run.skip_maps, 1)
    t:eq(config.auto_run.skip_maps[1], "shader", "entries are compared in lower case")
    t:eq(#config.warnings, 5, table.concat(config.warnings, "; "))
    local defaults = Config.validate({})
    t:eq(#defaults.auto_run.skip_maps, 6)
    t:eq(defaults.load_assets.mode, "data")
    t:eq(defaults.load_assets.min_free_memory_gb, 1.5)
    local bad = Config.validate({ load_assets = { mode = "everything", min_free_memory_gb = -2, extra = true } })
    t:eq(bad.load_assets.mode, "data")
    t:eq(bad.load_assets.min_free_memory_gb, 1.5)
    t:eq(#bad.warnings, 3, table.concat(bad.warnings, "; "))
end

function tests.falls_back_to_the_async_timer(t)
    local async = {}
    local w = install(t, { api = {
        ExecuteInGameThreadWithDelay = function() error("EngineTick hook is not available") end,
        ExecuteWithDelay = function(ms, fn) async[#async + 1] = { ms = ms, fn = fn } end,
    } })
    t:eq(#async, 1, "the async timer was used")
    t:eq(async[1].ms, 15000)
    t:ok(w.text():find("automatic run in 15 seconds", 1, true))
end

function tests.missing_timer_functions_are_reported(t)
    local w = install(t, { api = { ExecuteInGameThreadWithDelay = false } })
    t:ok(w.text():find("automatic run not scheduled", 1, true))
    t:ok(w.text():find("ready, version", 1, true))
end

-- The whole chain with the map tour: automatic run, then each other map, then quit.
function tests.the_map_tour_follows_a_full_run_and_the_game_quits_after_it(t)
    local current, opened = "/Game/Maps/Menu.Menu", {}
    local pending, polls = nil, 0
    local w
    -- A level load takes a moment: the new map shows up one check after OpenLevel.
    local statics = { IsValid = function() return true end, OpenLevel = function(_, _, name)
        opened[#opened + 1] = name
        pending, polls = name .. "." .. name:match("([^/]+)$"), 1
    end }
    local function map_name()
        if pending then
            if polls <= 0 then
                current, pending = pending, nil
            else
                polls = polls - 1
            end
        end
        return current
    end
    local kismet = { IsValid = function() return true end, QuitGame = function() w.calls[#w.calls + 1] = "QuitGame" end }
    w = install(t, {
        config = 'return { auto_run = { settle_seconds = 0 }, map_tour = { enabled = true, settle_seconds = 0 } }',
        api = {
            FName = function(text) return text end,
            GmfDumperNative_MapName = map_name,
            GmfDumperNative_ListMaps = function() return "/Game/Maps/Lobby\n/Game/Maps/Menu\n/Engine/Maps/Entry" end,
            GmfDumperNative_DumpActors = function(file)
                local f = assert(io.open(file, "wb"))
                f:write(current)
                f:close()
                return true
            end,
            StaticFindObject = function(path)
                if path == "/Script/Engine.Default__GameplayStatics" then
                    return statics
                end
                return kismet
            end,
        },
    })
    -- Timer 1 starts the run. The run itself needs no timers; the tour then opens the lobby.
    w.run_timers(1)
    t:ok(w.manifest().finished, "the main run is complete")
    t:eq(table.concat(opened, ","), "/Game/Maps/Lobby", "the tour opened the one other map")
    t:no(w.has("QuitGame"), "the game is not closed while the tour is going")
    local replies = {}
    w.app.handle_command({ "quick" }, function(m) replies[#replies + 1] = m end)
    t:ok(replies[1] and replies[1]:find("map tour", 1, true), "a new run is refused during the tour")
    w.run_timers()
    local run_dir = (t.support.read(w.working .. "\\Dumps\\latest.txt"):gsub("%s+$", ""))
    local tour = json.decode(t.support.read(run_dir .. "\\World\\map_tour.json"))
    t:eq(#tour.maps, 2)
    t:eq(tour.maps[1].map, "/Game/Maps/Lobby")
    t:eq(tour.maps[1].status, "ok")
    t:eq(tour.maps[2].status, "skipped", "the menu was dumped by the main run")
    t:eq(t.support.read(run_dir .. "\\World\\Lobby\\actors.json"), "/Game/Maps/Lobby.Lobby")
    t:eq(t.support.read(run_dir .. "\\World\\actors.json"), "/Game/Maps/Menu.Menu", "the main run kept its own World folder")
    t:ok(w.has("QuitGame"), "the game closes after the tour")
end

function tests.the_map_tour_is_skipped_for_quick_and_single_step_runs(t)
    local opened = 0
    local w = install(t, {
        config = 'return { auto_run = { mode = "off" } }',
        api = {
            GmfDumperNative_ListMaps = function() return "/Game/Maps/Lobby" end,
            GmfDumperNative_MapName = function() return "/Game/Maps/Menu.Menu" end,
            StaticFindObject = function() return { IsValid = function() return true end, OpenLevel = function() opened = opened + 1 end } end,
        },
    })
    w.app.handle_command({ "quick" }, function() end)
    w.app.handle_command({ "usmap" }, function() end)
    w.run_timers()
    t:eq(opened, 0)
end

function tests.the_level_dump_follows_a_full_run_and_the_game_quits_after_it(t)
    local loaded = {}
    local w
    local library = {
        IsValid = function() return true end,
        QuitGame = function() w.calls[#w.calls + 1] = "QuitGame" end,
        CollectGarbage = function() end,
    }
    w = install(t, {
        config = 'return { auto_run = { settle_seconds = 0 } }',
        api = {
            GmfDumperNative_MapName = function() return "/Game/Maps/Menu.Menu" end,
            GmfDumperNative_ListMaps = function() return "/Game/Maps/Lobby\n/Game/Maps/Menu\n/Engine/Maps/Entry" end,
            GmfDumperNative_DumpLevel = function(package, _, min_free_mb)
                loaded[#loaded + 1] = package .. "|" .. tostring(min_free_mb)
                return "3"
            end,
            StaticFindObject = function() return library end,
        },
    })
    -- Timer 1 starts the run. The level dump then loads the first map and waits for a tick.
    w.run_timers(1)
    t:ok(w.manifest().finished, "the main run is complete")
    t:eq(table.concat(loaded, ","), "/Game/Maps/Lobby|1536", "the map loaded stays under the memory floor of load_assets")
    t:no(w.has("QuitGame"), "the game is not closed while levels are being dumped")
    local replies = {}
    w.app.handle_command({ "quick" }, function(m) replies[#replies + 1] = m end)
    t:ok(replies[1] ~= nil, "a new run is refused meanwhile")
    w.run_timers()
    t:eq(#loaded, 2, "the menu is loaded as data too; no map is opened")
    local run_dir = (t.support.read(w.working .. "\\Dumps\\latest.txt"):gsub("%s+$", ""))
    local levels = json.decode(t.support.read(run_dir .. "\\Levels\\levels.json"))
    t:eq(#levels.maps, 2)
    t:eq(levels.maps[1].status, "ok")
    t:eq(levels.maps[1].actors, 3)
    t:eq(t.support.read(run_dir .. "\\World\\map_tour.json"), nil, "the travelling tour is off unless asked for")
    t:ok(w.has("QuitGame"), "the game closes after the level dump")
end

function tests.the_map_tour_is_off_unless_asked_for(t)
    local opened = 0
    local w = install(t, {
        config = 'return { auto_run = { settle_seconds = 0, quit_when_done = false } }',
        api = {
            GmfDumperNative_ListMaps = function() return "/Game/Maps/Lobby" end,
            GmfDumperNative_MapName = function() return "/Game/Maps/Menu.Menu" end,
            StaticFindObject = function() return { IsValid = function() return true end, OpenLevel = function() opened = opened + 1 end } end,
        },
    })
    w.run_timers()
    t:ok(w.manifest().finished)
    t:eq(opened, 0)
end

function tests.auto_run_config_validation(t)
    local config = Config.validate({ auto_run = { mode = "sometimes", delay_seconds = -5, freeze_input = "yes", extra = 1 } })
    t:eq(config.auto_run.mode, "off", "an unreadable mode never starts a run")
    t:eq(config.auto_run.delay_seconds, 15)
    t:eq(config.auto_run.freeze_input, true)
    t:eq(config.auto_run.quit_when_done, true, "missing field takes its default")
    t:eq(#config.warnings, 4, table.concat(config.warnings, "; "))
    local defaults = Config.validate({})
    t:eq(defaults.auto_run.mode, "once")
    t:eq(#Config.validate({ auto_run = "on" }).warnings, 1)
end

return tests
