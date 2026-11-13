local Fs = require("gmfdumper.fs")
local Tour = require("gmfdumper.tour")
local Config = require("gmfdumper.config")
local json = require("dkjson")

local tests = {}

-- A fake game with several maps. OpenLevel makes the wanted map the current one after
-- `load_polls` checks, as a real level load takes a while. Timers are queued and run by
-- the test.
local function make(t, options)
    options = options or {}
    local run_dir = t.support.temp_dir("tour") .. "\\Funnel Runners\\run"
    local fs = Fs.new(nil)
    fs.mkdirs(run_dir)
    local game = { current = options.current or "/Game/Maps/Menu.Menu", opened = {}, polls_left = 0, pending = nil }
    local log, timers = {}, {}
    local native = {
        ListMaps = function()
            return table.concat(options.maps or {
                "/Engine/Maps/Entry", "/Game/Developers/Ann/lvl_Test", "/Game/Maps/Lobby", "/Game/Maps/Menu",
                "/Game/Maps/World/lvl_Plains", "/Game/Maps/lvl_ShaderCompilation", "/Game/Art/Fields/PLA_Field",
            }, "\n")
        end,
        MapName = function()
            if game.pending then
                if game.polls_left <= 0 then
                    game.current = game.pending .. "." .. game.pending:match("([^/]+)$")
                    game.pending = nil
                else
                    game.polls_left = game.polls_left - 1
                end
            end
            return game.current
        end,
    }
    local statics = {
        OpenLevel = function(_, context, name, absolute, level_options)
            game.opened[#game.opened + 1] = name
            t:eq(context, "controller")
            t:eq(absolute, true)
            t:eq(level_options, "")
            if options.never_loads and options.never_loads[name] then
                return
            end
            if options.open_raises and options.open_raises[name] then
                error("engine refused")
            end
            game.pending = name
            game.polls_left = options.load_polls or 1
        end,
    }
    local dumped = {}
    local function world_step(id, file, fail)
        return { id = id, run = function(ctx)
            if fail then
                return nil, "step broke"
            end
            local dir = ctx.run_dir .. "\\" .. ctx.world_folder
            ctx.fs.mkdirs(dir)
            t.support.write(dir .. "\\" .. file, game.current)
            dumped[#dumped + 1] = ctx.world_folder .. "\\" .. file
            return { { path = ctx.world_folder:gsub("\\", "/") .. "/" .. file, bytes = #game.current } }
        end }
    end
    local config = Config.validate({ map_tour = options.config or { settle_seconds = 0 } }).map_tour
    local done = 0
    local crash_file = t.support.temp_dir("tourmod") .. "\\map_tour_crashed.txt"
    if options.opening then
        t.support.write(crash_file .. ".opening", options.opening)
    end
    if options.crashed then
        t.support.write(crash_file, options.crashed)
    end
    local tour = Tour.new({
        crash_file = crash_file,
        api = { StaticFindObject = function() return statics end, FName = function(text) return text end },
        native = native, fs = fs, config = config,
        log = function(message) log[#log + 1] = message end,
        after = function(seconds, fn)
            timers[#timers + 1] = { seconds = seconds, fn = fn }
            return true
        end,
        controller = function()
            if options.no_controller then
                return nil
            end
            return "controller"
        end,
        clock = os.clock,
        world_steps = options.steps or { world_step("world_json", "actors.json"), world_step("runtime", "runtime.json") },
        make_context = function(world_folder)
            return { fs = fs, run_dir = run_dir, world_folder = world_folder }
        end,
    })
    local w = { crash_file = crash_file, tour = tour, game = game, log = log, timers = timers, dumped = dumped, run_dir = run_dir, world_step = world_step }
    function w.start()
        tour:start(run_dir, function() done = done + 1 end)
    end
    function w.drain(limit)
        local i = w.next_timer or 1
        local last = limit and (i + limit - 1) or 10000
        while timers[i] and i <= last do
            timers[i].fn()
            i = i + 1
        end
        w.next_timer = i
    end
    function w.done()
        return done
    end
    function w.result()
        local text = t.support.read(run_dir .. "\\World\\map_tour.json")
        return text and json.decode(text)
    end
    function w.text()
        return table.concat(log, "\n")
    end
    return w
end

local function by_map(result)
    local map = {}
    for _, entry in ipairs(result.maps) do
        map[entry.map] = entry
    end
    return map
end

function tests.auto_plan_takes_maps_folders_and_leaves_out_engine_and_excluded_maps(t)
    local w = make(t)
    local maps = w.tour:plan()
    t:eq(table.concat(maps, ","), "/Game/Maps/Lobby,/Game/Maps/Menu,/Game/Maps/World/lvl_Plains")
end

function tests.a_list_of_maps_is_used_as_given(t)
    local w = make(t, { config = { maps = { "/Game/Art/Fields/PLA_Field.PLA_Field", "/Game/Maps/Lobby" } } })
    t:eq(table.concat(w.tour:plan(), ","), "/Game/Art/Fields/PLA_Field,/Game/Maps/Lobby")
end

function tests.each_map_is_opened_dumped_into_its_own_folder_and_recorded(t)
    local w = make(t)
    w.start()
    w.drain()
    t:eq(w.done(), 1, "the tour reports its end once")
    t:eq(table.concat(w.game.opened, ","), "/Game/Maps/Lobby,/Game/Maps/World/lvl_Plains")
    local maps = by_map(w.result())
    t:eq(maps["/Game/Maps/Lobby"].status, "ok")
    t:eq(maps["/Game/Maps/Lobby"].folder, "World/Lobby")
    t:eq(#maps["/Game/Maps/Lobby"].files, 2)
    t:eq(maps["/Game/Maps/Lobby"].files[1].path, "World/Lobby/actors.json")
    t:eq(maps["/Game/Maps/World/lvl_Plains"].status, "ok")
    t:eq(t.support.read(w.run_dir .. "\\World\\Lobby\\actors.json"), "/Game/Maps/Lobby.Lobby", "dumped while that map was loaded")
    t:eq(t.support.read(w.run_dir .. "\\World\\lvl_Plains\\runtime.json"), "/Game/Maps/World/lvl_Plains.lvl_Plains")
    t:ok(w.text():find("map tour finished: 2 of 3 maps dumped", 1, true), w.text())
end

function tests.the_map_the_main_run_dumped_is_not_opened_again(t)
    local w = make(t)
    w.start()
    w.drain()
    local menu = by_map(w.result())["/Game/Maps/Menu"]
    t:eq(menu.status, "skipped")
    t:ok(menu.error:find("already dumped", 1, true))
end

function tests.a_map_is_dumped_only_after_it_has_settled(t)
    local w = make(t, { config = { settle_seconds = 4 }, maps = { "/Game/Maps/Lobby" }, load_polls = 0 })
    w.start()
    -- The first check sees the map; the check 2 seconds later is still waiting.
    w.drain(1)
    t:eq(#w.dumped, 0)
    w.drain(1)
    t:eq(#w.dumped, 2, "dumped once it has been loaded for 4 seconds")
end

function tests.a_map_that_never_loads_is_failed_and_the_tour_goes_on(t)
    local w = make(t, { config = { settle_seconds = 0, max_wait_seconds = 6 }, never_loads = { ["/Game/Maps/Lobby"] = true } })
    w.start()
    w.drain()
    local maps = by_map(w.result())
    t:eq(maps["/Game/Maps/Lobby"].status, "failed")
    t:ok(maps["/Game/Maps/Lobby"].error:find("did not finish loading in 6 seconds", 1, true), maps["/Game/Maps/Lobby"].error)
    t:eq(maps["/Game/Maps/World/lvl_Plains"].status, "ok")
    t:eq(w.done(), 1)
end

function tests.a_map_the_engine_refuses_is_failed_and_the_tour_goes_on(t)
    local w = make(t, { open_raises = { ["/Game/Maps/Lobby"] = true } })
    w.start()
    w.drain()
    local maps = by_map(w.result())
    t:eq(maps["/Game/Maps/Lobby"].status, "failed")
    t:ok(maps["/Game/Maps/Lobby"].error:find("engine refused", 1, true))
    t:eq(maps["/Game/Maps/World/lvl_Plains"].status, "ok")
end

function tests.the_map_is_recorded_as_running_before_it_is_opened(t)
    -- If the game dies while a map loads, the file on disk must already name that map.
    local seen
    local w
    w = make(t, { maps = { "/Game/Maps/Lobby" } })
    local open = w.tour.api.StaticFindObject().OpenLevel
    w.tour.api.StaticFindObject().OpenLevel = function(...)
        seen = by_map(w.result())["/Game/Maps/Lobby"].status
        return open(...)
    end
    w.start()
    t:eq(seen, "running")
end

function tests.scene_levels_are_left_out_of_the_auto_plan(t)
    -- A scene level has no player start; the game's menu game mode recursed without end on one.
    local w = make(t, { maps = { "/Game/Maps/L_LobbyVanScene", "/Game/Maps/Lobby" } })
    t:eq(table.concat(w.tour:plan(), ","), "/Game/Maps/Lobby")
end

function tests.a_map_that_killed_the_game_in_an_earlier_run_is_skipped(t)
    local w = make(t, { opening = "/Game/Maps/Lobby\n", crashed = "/Game/Maps/Old\n" })
    w.start()
    w.drain()
    local lobby = by_map(w.result())["/Game/Maps/Lobby"]
    t:eq(lobby.status, "skipped")
    t:ok(lobby.error:find("crashed", 1, true), lobby.error)
    t:eq(table.concat(w.game.opened, ","), "/Game/Maps/World/lvl_Plains")
    t:eq(t.support.read(w.crash_file), "/Game/Maps/Old\n/Game/Maps/Lobby\n")
    t:eq(t.support.read(w.crash_file .. ".opening"), "", "nothing is left marked as opening after a full tour")
    t:eq(w.done(), 1)
end

function tests.the_map_being_opened_is_marked_outside_the_run_folder(t)
    local seen
    local w = make(t, { maps = { "/Game/Maps/Lobby" } })
    local open = w.tour.api.StaticFindObject().OpenLevel
    w.tour.api.StaticFindObject().OpenLevel = function(...)
        seen = t.support.read(w.crash_file .. ".opening")
        return open(...)
    end
    w.start()
    t:eq(seen, "/Game/Maps/Lobby")
    w.drain()
    t:eq(t.support.read(w.crash_file .. ".opening"), "")
    t:eq(t.support.read(w.crash_file), nil, "a map that loaded is not listed as crashed")
end

function tests.one_failing_step_does_not_lose_the_other_files_of_a_map(t)
    local w = make(t, { maps = { "/Game/Maps/Lobby" } })
    w.tour.world_steps = { w.world_step("world_json", "actors.json"), w.world_step("runtime", "runtime.json", true) }
    w.start()
    w.drain()
    local lobby = by_map(w.result())["/Game/Maps/Lobby"]
    t:eq(lobby.status, "ok")
    t:eq(#lobby.files, 1)
    t:ok(lobby.error:find("runtime: step broke", 1, true), lobby.error)
end

function tests.no_maps_or_no_controller_ends_the_tour_cleanly(t)
    local empty = make(t, { maps = { "/Engine/Maps/Entry" } })
    empty.start()
    t:eq(empty.done(), 1)
    t:eq(empty.result(), nil, "nothing is written when there is nothing to visit")
    local w = make(t, { no_controller = true, maps = { "/Game/Maps/Lobby" } })
    w.start()
    w.drain()
    t:eq(w.done(), 1)
    t:eq(by_map(w.result())["/Game/Maps/Lobby"].status, "failed")
end

function tests.map_tour_settings_are_validated(t)
    local config = Config.validate({ map_tour = { enabled = "yes", maps = "everything", settle_seconds = -1, extra = 1 } })
    t:eq(config.map_tour.enabled, false, "an unreadable switch never opens maps")
    t:eq(config.map_tour.maps, "auto")
    t:eq(config.map_tour.settle_seconds, 6)
    t:eq(#config.warnings, 4, table.concat(config.warnings, "; "))
    local listed = Config.validate({ map_tour = { maps = { "/Game/Maps/Lobby", "Lobby", 5 } } })
    t:eq(#listed.map_tour.maps, 1)
    t:eq(#listed.warnings, 2)
    t:eq(Config.validate({}).map_tour.enabled, false, "travelling to maps is opt-in")
end

return tests
