local Fs = require("gmfdumper.fs")
local Levels = require("gmfdumper.levels")
local Config = require("gmfdumper.config")
local json = require("dkjson")

local tests = {}

-- A fake game whose native DumpLevel writes the two files a real one writes. Timers are
-- queued and run by the test.
local function make(t, options)
    options = options or {}
    local run_dir = t.support.temp_dir("levels") .. "\\run"
    local fs = Fs.new(nil)
    fs.mkdirs(run_dir)
    local log, timers, loaded, floors, collected = {}, {}, {}, {}, 0
    local native = {
        ListMaps = function()
            return table.concat(options.maps or {
                "/Engine/Maps/Entry", "/Game/Developers/Ann/lvl_Test", "/Game/Maps/Lobby",
                "/Game/Maps/L_VanScene", "/Game/Art/Fields/PLA_Field",
            }, "\n")
        end,
        ListLoadedMaps = function()
            return table.concat(options.in_memory or {}, "\n")
        end,
        DumpLevel = function(package, dir, min_free_mb)
            loaded[#loaded + 1] = package
            floors[#floors + 1] = min_free_mb
            if options.fails and options.fails[package] then
                return nil, options.fails[package]
            end
            if options.raises and options.raises[package] then
                error("native broke")
            end
            fs.mkdirs(dir)
            t.support.write(dir .. "\\actors.json", "{}")
            t.support.write(dir .. "\\actor_values.jsonl", package)
            return "12"
        end,
    }
    local library = { CollectGarbage = function() collected = collected + 1 end }
    local config = Config.validate({ levels = options.config }).levels
    local done = 0
    local levels = Levels.new({
        api = { StaticFindObject = function(path)
            t:eq(path, "/Script/Engine.Default__KismetSystemLibrary")
            return library
        end },
        native = native, fs = fs, config = config, min_free_mb = 1536,
        log = function(message) log[#log + 1] = message end,
        after = function(seconds, fn)
            if options.no_timers then
                return false
            end
            timers[#timers + 1] = { seconds = seconds, fn = fn }
            return true
        end,
    })
    local w = { levels = levels, log = log, timers = timers, loaded = loaded, floors = floors, run_dir = run_dir }
    function w.start()
        levels:start(run_dir, function() done = done + 1 end)
    end
    function w.drain()
        local i = 1
        while timers[i] do
            timers[i].fn()
            i = i + 1
        end
    end
    function w.done() return done end
    function w.collected() return collected end
    function w.result()
        local text = t.support.read(run_dir .. "\\Levels\\levels.json")
        return text and json.decode(text)
    end
    function w.by_map()
        local map = {}
        for _, entry in ipairs(w.result().maps) do
            map[entry.map] = entry
        end
        return map
    end
    function w.text() return table.concat(log, "\n") end
    return w
end

function tests.auto_plan_takes_every_map_outside_the_engine(t)
    local w = make(t)
    t:eq(table.concat(w.levels:plan(), ","),
        "/Game/Art/Fields/PLA_Field,/Game/Developers/Ann/lvl_Test,/Game/Maps/L_VanScene,/Game/Maps/Lobby")
end

function tests.excluded_words_and_a_given_list_narrow_the_plan(t)
    local w = make(t, { config = { exclude = { "Developers" } } })
    t:eq(#w.levels:plan(), 3)
    local listed = make(t, { config = { maps = { "/Game/Maps/Lobby.Lobby" } } })
    t:eq(table.concat(listed.levels:plan(), ","), "/Game/Maps/Lobby")
end

function tests.each_map_is_dumped_into_its_own_folder_and_recorded(t)
    local w = make(t, { maps = { "/Game/Maps/Lobby", "/Game/Maps/Plains" } })
    w.start()
    w.drain()
    t:eq(w.done(), 1, "the end is reported once")
    t:eq(table.concat(w.loaded, ","), "/Game/Maps/Lobby,/Game/Maps/Plains")
    local lobby = w.by_map()["/Game/Maps/Lobby"]
    t:eq(lobby.status, "ok")
    t:eq(w.floors[1], 1536, "a map is loaded only while this much memory stays free")
    t:eq(lobby.folder, "Levels/Lobby")
    t:eq(lobby.actors, 12)
    t:eq(#lobby.files, 2)
    t:eq(lobby.files[1].path, "Levels/Lobby/actors.json")
    t:eq(lobby.files[2].bytes, #"/Game/Maps/Lobby")
    t:eq(t.support.read(w.run_dir .. "\\Levels\\Plains\\actor_values.jsonl"), "/Game/Maps/Plains")
    t:ok(w.text():find("levels finished: 2 of 2 maps dumped", 1, true), w.text())
end

function tests.the_game_gets_a_tick_and_a_garbage_collection_between_maps(t)
    -- Each map brings its meshes and textures with it. Without a collection in between,
    -- every map would stay in memory until the last one is done.
    local w = make(t, { maps = { "/Game/Maps/A", "/Game/Maps/B" } })
    w.start()
    t:eq(#w.loaded, 1, "the second map waits for a timer")
    t:eq(w.collected(), 1)
    w.drain()
    t:eq(#w.loaded, 2)
    t:eq(w.collected(), 2)
end

function tests.a_map_that_fails_is_recorded_and_the_others_still_run(t)
    local w = make(t, {
        maps = { "/Game/Maps/A", "/Game/Maps/B", "/Game/Maps/C" },
        fails = { ["/Game/Maps/A"] = "the map package could not be loaded" },
        raises = { ["/Game/Maps/B"] = true },
    })
    w.start()
    w.drain()
    local maps = w.by_map()
    t:eq(maps["/Game/Maps/A"].status, "failed")
    t:eq(maps["/Game/Maps/A"].error, "the map package could not be loaded")
    t:eq(maps["/Game/Maps/B"].status, "failed")
    t:ok(maps["/Game/Maps/B"].error:find("native broke", 1, true))
    t:eq(maps["/Game/Maps/C"].status, "ok")
    t:eq(w.done(), 1)
end

function tests.the_map_is_recorded_as_running_before_it_is_loaded(t)
    local seen
    local w = make(t, { maps = { "/Game/Maps/A" } })
    local dump = w.levels.native.DumpLevel
    w.levels.native.DumpLevel = function(...)
        seen = w.by_map()["/Game/Maps/A"].status
        return dump(...)
    end
    w.start()
    t:eq(seen, "running")
end

function tests.maps_already_in_memory_are_dumped_first_and_not_loaded_again(t)
    -- A map the game holds during the main run can be gone, and not loadable again, by
    -- the time the other maps are loaded. So it is written while it is there.
    local w = make(t, {
        maps = { "/Game/Maps/A", "/Game/Maps/B", "/Engine/Maps/Entry" },
        in_memory = { "/Game/Maps/B", "/Engine/Maps/Entry", "/Game/Other/NotInThePlan" },
    })
    local files = w.levels:dump_loaded(w.run_dir)
    t:eq(table.concat(w.loaded, ","), "/Game/Maps/B", "only maps of the plan")
    t:eq(w.floors[1], 0, "a map in memory needs no memory to load")
    t:eq(#w.timers, 0, "no tick passes: the main run still holds its assets")
    t:eq(w.collected(), 0, "and nothing is collected under the main run")
    t:eq(w.by_map()["/Game/Maps/B"].status, "ok")
    t:eq(#files, 2, "the index is not reported: it changes after the run, and the manifest keeps sizes")
    t:eq(files[1].path, "Levels/B/actors.json")
    t:eq(files[2].path, "Levels/B/actor_values.jsonl")
    w.start()
    w.drain()
    t:eq(table.concat(w.loaded, ","), "/Game/Maps/B,/Game/Maps/A", "the rest follows after the run")
    t:eq(#w.result().maps, 2)
    t:eq(w.done(), 1)
    t:ok(w.text():find("levels finished: 2 of 2 maps dumped", 1, true), w.text())
end

function tests.a_map_that_failed_while_in_memory_is_tried_again_and_listed_once(t)
    local w = make(t, { maps = { "/Game/Maps/A" }, in_memory = { "/Game/Maps/A" }, fails = { ["/Game/Maps/A"] = "broken" } })
    local files = w.levels:dump_loaded(w.run_dir)
    t:eq(#files, 0)
    w.start()
    w.drain()
    t:eq(#w.loaded, 2)
    t:eq(#w.result().maps, 1)
    t:eq(w.result().maps[1].status, "failed")
end

function tests.nothing_in_memory_writes_nothing_yet(t)
    local w = make(t, { maps = { "/Game/Maps/A" } })
    t:eq(#w.levels:dump_loaded(w.run_dir), 0)
    t:eq(w.result(), nil)
end

function tests.two_maps_with_the_same_name_get_different_folders(t)
    local w = make(t, { maps = { "/Game/A/Field", "/Game/B/Field" } })
    w.start()
    w.drain()
    local maps = w.by_map()
    t:eq(maps["/Game/A/Field"].folder, "Levels/Field")
    t:eq(maps["/Game/B/Field"].folder, "Levels/Field_2")
end

function tests.without_timers_the_maps_still_all_run(t)
    local w = make(t, { maps = { "/Game/Maps/A", "/Game/Maps/B" }, no_timers = true })
    w.start()
    t:eq(#w.loaded, 2)
    t:eq(w.done(), 1)
end

function tests.no_maps_ends_cleanly_and_writes_nothing(t)
    local w = make(t, { maps = { "/Engine/Maps/Entry" } })
    w.start()
    t:eq(w.done(), 1)
    t:eq(w.result(), nil)
end

function tests.level_settings_are_validated(t)
    local defaults = Config.validate({})
    t:eq(defaults.levels.enabled, true)
    t:eq(defaults.levels.maps, "auto")
    t:eq(#defaults.levels.exclude, 0)
    t:eq(defaults.map_tour.enabled, false, "travelling to maps is opt-in")
    local config = Config.validate({ levels = { enabled = "yes", maps = 3, pause_seconds = -1, exclude = "x", extra = 1 } })
    t:eq(config.levels.enabled, false)
    t:eq(config.levels.maps, "auto")
    t:eq(config.levels.pause_seconds, 1)
    t:eq(#config.levels.exclude, 0)
    t:eq(#config.warnings, 5, table.concat(config.warnings, "; "))
end

return tests
