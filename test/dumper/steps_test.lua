local Fs = require("gmfdumper.fs")
local Manifest = require("gmfdumper.manifest")
local Runner = require("gmfdumper.runner")
local Steps = require("gmfdumper.steps")
local collect = require("gmfdumper.collect")

local tests = {}

-- A fake UE4SS install on the real disk: <root>\ue4ss is the working directory and
-- <root>\ue4ss\Mods the mods folder. The fake dump globals write the same file names the
-- real dumpers write.
local function world(t, options)
    options = options or {}
    local root = t.support.temp_dir("steps") .. "\\Funnel Runners"
    local working = root .. "\\Game\\Binaries\\Win64\\ue4ss"
    local mods = working .. "\\Mods"
    t.support.mkdir(mods .. "\\shared")
    t.support.write(working .. "\\UE4SS-settings.ini", "[Hooks]\nHookProcessInternal = 1\n; note\nHookLoadMap = 0\n[Other]\nX = 1\n")
    t.support.write(working .. "\\UE4SS.log", "log line\n")
    if options.paks ~= false then
        -- <root>\Content\Paks, where a game keeps its content files. The working folder
        -- here is <root>\ue4ss, so the fake project root needs a Binaries folder above it.
        t.support.mkdir(root .. "\\Game\\Content\\Paks\\~mods")
        t.support.write(root .. "\\Game\\Content\\Paks\\Game-Windows.pak", "12345")
        t.support.write(root .. "\\Game\\Content\\Paks\\~mods\\Mod_P.pak", "12")
    end

    local calls = {}
    local function called(name)
        calls[#calls + 1] = name
    end

    local api = {
        EngineTickAvailable = true,
        ProcessEventAvailable = false,
        DumpAllActors = function() called("DumpAllActors") t.support.write(working .. "\\1700000000-ue4ss_actor_data.csv", "a,b") end,
        DumpStaticMeshes = function() called("DumpStaticMeshes") t.support.write(working .. "\\1700000001-ue4ss_static_mesh_data.csv", "m") end,
        DumpAllObjects = function() called("DumpAllObjects") t.support.write(working .. "\\UE4SS_ObjectDump.txt", "objects") end,
        DumpUSMAP = function(bp) called("DumpUSMAP " .. tostring(bp)) t.support.write(working .. "\\Game-5.6-abc.usmap", "u") end,
        DumpJMAP = function(bp, skip) called("DumpJMAP " .. tostring(bp) .. " " .. tostring(skip)) t.support.write(working .. "\\Game-5.6-abc.jmap", "{}") end,
        GenerateSDK = function()
            called("GenerateSDK")
            t.support.mkdir(working .. "\\CXXHeaderDump")
            t.support.write(working .. "\\CXXHeaderDump\\Engine.hpp", "struct A {};")
        end,
        GenerateUHTCompatibleHeaders = function()
            called("GenerateUHTCompatibleHeaders")
            t.support.mkdir(working .. "\\UHTHeaderDump\\Engine\\Public")
            t.support.write(working .. "\\UHTHeaderDump\\Engine\\Public\\Actor.h", "class AActor;")
        end,
        GenerateLuaTypes = function()
            called("GenerateLuaTypes")
            t.support.mkdir(mods .. "\\shared\\types")
            t.support.write(mods .. "\\shared\\types\\Engine.lua", "---@meta")
        end,
    }
    for name, replacement in pairs(options.api or {}) do
        api[name] = replacement or nil
    end

    local native
    if options.native then
        local function writer(name, file)
            return function(target, ...)
                called(name)
                t.support.write(file and (target .. "\\" .. file) or target, name)
                return true
            end
        end
        local held = 0
        native = {
            LoadAllAssets = function() called("LoadAllAssets") held = 7 return true end,
            FreeAllAssets = function() called("FreeAllAssets") held = 0 return true end,
            HeldAssets = function() return held end,
            DumpActors = writer("DumpActors"),
            DumpObjects = writer("DumpObjects"),
            GenerateTMapOverrides = function(dir)
                called("GenerateTMapOverrides")
                t.support.write(dir .. "\\FModelTMapOverrides.json", "{}")
                t.support.write(dir .. "\\UAssetAPITMapOverrides.json", "{}")
                return true
            end,
            GenerateCXX = writer("GenerateCXX", "Engine.hpp"),
            GenerateLuaTypes = writer("GenerateLuaTypes", "Engine.lua"),
            GenerateBPSDK = function(dir)
                called("GenerateBPSDK")
                t.support.mkdir(dir .. "\\UE4SS_SDK")
                t.support.write(dir .. "\\UE4SS_SDK\\CMakeLists.txt", "x")
                return true
            end,
            DumpReflection = function(dir)
                called("DumpReflection")
                for _, name in ipairs({ "classes", "structs", "enums", "functions" }) do
                    t.support.write(dir .. "\\" .. name .. ".json", "{}")
                end
                return true
            end,
            DumpNames = writer("DumpNames"),
            DumpScripts = writer("DumpScripts"),
            DumpHooks = writer("DumpHooks", "hookable_functions.json"),
            DumpAssetRegistry = writer("DumpAssetRegistry"),
            DumpRuntime = writer("DumpRuntime"),
            DumpWorldValues = writer("DumpWorldValues"),
            DumpDataTables = function(dir)
                called("DumpDataTables")
                t.support.write(dir .. "\\_index.json", "{}")
                t.support.write(dir .. "\\DT_Items.json", "{}")
                t.support.write(dir .. "\\DT_Prices.json", "{}")
                return true
            end,
            DumpDataAssets = function(dir)
                called("DumpDataAssets")
                t.support.write(dir .. "\\data_assets.jsonl", "{}")
                t.support.write(dir .. "\\curves.jsonl", "{}")
                return true
            end,
            DumpConfigObjects = writer("DumpConfigObjects"),
            DumpClassDefaults = writer("DumpClassDefaults"),
            DumpWidgetTrees = writer("DumpWidgetTrees"),
            DumpGameplayTags = writer("DumpGameplayTags"),
            ListMaps = function() return "/Game/Maps/Lobby\n/Game/Maps/Menu\n" end,
            ListLoadedMaps = function() return "/Game/Maps/Lobby\n" end,
            DumpLevel = function(package, dir, min_free_mb)
                called("DumpLevel " .. package .. " " .. tostring(min_free_mb))
                t.support.mkdir(dir)
                t.support.write(dir .. "\\actors.json", "{}")
                t.support.write(dir .. "\\actor_values.jsonl", "{}")
                return "5"
            end,
        }
        for name, replacement in pairs(type(options.native) == "table" and options.native or {}) do
            native[name] = replacement
        end
    end

    local fs = Fs.new(nil)
    local run_dir = working .. "\\Dumps\\Game-5.6-test"
    fs.mkdirs(run_dir)
    local config = options.config or { levels = { enabled = true, maps = "auto", exclude = {}, pause_seconds = 1 } }
    local manifest
    local runner = Runner.new({
        steps = Steps.build({ api = api, native = native, config = config }),
        fs = fs,
        has_native = native ~= nil,
        -- Each scheduled call stands for one tick of the game between two steps.
        schedule = function(fn)
            called("tick")
            fn()
        end,
        log = function() end,
        make_run = function() return run_dir, {} end,
        make_manifest = function(dir, header, ids)
            manifest = Manifest.new(fs, dir, header, ids)
            return manifest
        end,
        make_context = function()
            return {
                fs = fs, working_dir = working, mods_dir = mods, config = config,
                api = api, native = native, state = {}, log = function() end,
            }
        end,
    })
    return {
        runner = runner, working = working, mods = mods, run_dir = run_dir, fs = fs, calls = calls,
        manifest = function() return manifest end,
        status = function(id) return manifest:get(id).status end,
        step = function(id) return manifest:get(id) end,
    }
end

local function index_of(list, prefix)
    for i, value in ipairs(list) do
        if value:sub(1, #prefix) == prefix then
            return i
        end
    end
    return nil
end

local LOOSE = { "%.usmap$", "%.jmap$", "%.csv$", "^ue4ss_objectdump%.txt$", "^cxxheaderdump$", "^uhtheaderdump$",
    "^ue4ss_sdk$", "tmapoverrides%.json$" }

local function assert_nothing_loose(t, w)
    for _, name in ipairs(w.fs.list(w.working)) do
        for _, pattern in ipairs(LOOSE) do
            t:no(name:lower():find(pattern), "left in working dir: " .. name)
        end
    end
end

function tests.step_list_matches_the_spec(t)
    local steps = Steps.build({ api = {}, native = nil, config = {} })
    t:eq(#steps, 29)
    t:eq(steps[1].id, "world_actors")
    t:eq(steps[6].id, "load_assets")
    t:eq(steps[23].id, "class_defaults")
    t:eq(steps[26].id, "levels_loaded")
    t:ok(steps[26].hold, "maps in memory are written before the game gets a tick")
    t:eq(steps[27].id, "unload_assets")
    t:eq(steps[29].id, "environment")
    local seen = {}
    for _, step in ipairs(steps) do
        t:no(seen[step.id], "step id used twice: " .. step.id)
        seen[step.id] = true
    end
end

-- AC-4
function tests.full_profile_without_native(t)
    local w = world(t)
    t:ok(w.runner:start({ profile = "full" }))
    for _, id in ipairs({ "objects", "usmap", "jmap", "cxx", "uht", "luatypes", "world_actors", "world_meshes",
        "environment", "hooks" }) do
        t:eq(w.status(id), "ok", id .. ": " .. tostring(w.step(id).error or w.step(id).reason))
    end
    for _, id in ipairs({ "world_json", "runtime", "world_values", "load_assets", "tmap", "reflection", "names",
        "scripts", "assets", "datatables", "data_assets", "config_objects", "class_defaults", "widgets", "gameplay_tags",
        "unload_assets" }) do
        t:eq(w.status(id), "skipped", id)
        t:eq(w.step(id).reason, "native unavailable", id)
    end
    t:eq(w.status("bpsdk"), "skipped")
    t:ok(w.fs.exists(w.run_dir .. "\\Objects\\UE4SS_ObjectDump.txt"))
    t:ok(w.fs.exists(w.run_dir .. "\\Mappings\\Game-5.6-abc.usmap"))
    t:ok(w.fs.exists(w.run_dir .. "\\Mappings\\Game-5.6-abc.jmap"))
    t:ok(w.fs.exists(w.run_dir .. "\\Headers\\CXX\\Engine.hpp"))
    t:ok(w.fs.exists(w.run_dir .. "\\Headers\\UHT\\Engine\\Public\\Actor.h"))
    t:ok(w.fs.exists(w.run_dir .. "\\LuaTypes\\Engine.lua"))
    t:ok(w.fs.exists(w.run_dir .. "\\World\\actors.csv"))
    t:ok(w.fs.exists(w.run_dir .. "\\World\\static_meshes.csv"))
    t:ok(w.fs.exists(w.run_dir .. "\\Environment\\UE4SS.log"))
    t:ok(w.fs.exists(w.mods .. "\\shared\\types\\Engine.lua"), "Lua types also copied to shared")
    t:eq(w.manifest().data.assets_force_loaded, false)
    assert_nothing_loose(t, w)
end

-- AC-1 offline half
function tests.full_profile_with_native(t)
    local w = world(t, { native = true })
    t:ok(w.runner:start({ profile = "full" }))
    for _, step in ipairs(w.manifest().data.steps) do
        t:eq(step.status, "ok", step.id .. ": " .. tostring(step.error or step.reason))
    end
    t:eq(w.manifest().data.assets_force_loaded, true)
    assert_nothing_loose(t, w)
    t:eq(#w.step("tmap").files, 2, "tmap reports only its two files")
    -- The one map in memory is written during the run, before the assets are released.
    t:eq(#w.step("levels_loaded").files, 2)
    t:ok(w.fs.exists(w.run_dir .. "\\Levels\\Lobby\\actors.json"))
    t:ok(index_of(w.calls, "DumpLevel /Game/Maps/Lobby 0") < index_of(w.calls, "FreeAllAssets"))
    t:eq(index_of(w.calls, "DumpLevel /Game/Maps/Menu 0"), nil, "a map that is not in memory waits for the end of the run")
    t:eq(#w.step("reflection").files, 4)
    t:eq(#w.step("hooks").files, 2)
    t:eq(#w.step("datatables").files, 1, "a folder of tables is one manifest entry")
    t:eq(w.step("datatables").files[1].dir, true)
    t:eq(w.step("datatables").files[1].count, 3)
    t:eq(#w.step("data_assets").files, 2)
    t:eq(w.step("world_values").files[1].path, "World/actor_values.jsonl")
    t:eq(w.step("runtime").files[1].path, "World/runtime.json")
    t:eq(w.step("config_objects").files[1].path, "Config/config_objects.jsonl")
    t:eq(w.step("class_defaults").files[1].path, "Reflection/class_defaults.jsonl")
    t:eq(w.step("widgets").files[1].path, "UI/widget_trees.json")
    t:eq(w.step("gameplay_tags").files[1].path, "Names/gameplay_tags.txt")
    t:eq(w.step("cxx").files[1].dir, true, "folder outputs are one entry")
    t:eq(w.step("cxx").files[1].count, 1)
    t:eq(w.step("objects").files[1].path, "Objects/UE4SS_ObjectDump.txt")
    t:no(index_of(w.calls, "DumpAllObjects"), "native object dump used instead of the Lua global")
end

function tests.world_steps_run_before_assets_are_loaded(t)
    local w = world(t, { native = true })
    w.runner:start({ profile = "full" })
    local load = index_of(w.calls, "LoadAllAssets")
    t:ok(index_of(w.calls, "DumpAllActors") < load)
    t:ok(index_of(w.calls, "DumpStaticMeshes") < load)
    t:ok(index_of(w.calls, "DumpActors") < load)
    t:ok(index_of(w.calls, "DumpRuntime") < load, "the runtime context describes the level being played")
    t:ok(index_of(w.calls, "DumpWorldValues") < load, "actor values are read before unrelated assets load")
    t:ok(index_of(w.calls, "DumpDataTables") > load, "tables are dumped while every asset is loaded")
    t:ok(index_of(w.calls, "DumpDataAssets") > load)
    t:ok(index_of(w.calls, "DumpWidgetTrees") > load)
    t:ok(index_of(w.calls, "DumpGameplayTags") > index_of(w.calls, "DumpConfigObjects"),
        "tags are written after the value dumps that collect them")
    t:ok(index_of(w.calls, "FreeAllAssets") > index_of(w.calls, "DumpGameplayTags"))
    t:ok(index_of(w.calls, "DumpObjects") > load)
    t:ok(index_of(w.calls, "FreeAllAssets") > index_of(w.calls, "DumpAssetRegistry"))
end

-- AC-6 offline half
function tests.quick_profile_never_loads_assets(t)
    local w = world(t, { native = true })
    w.runner:start({ profile = "quick" })
    t:no(index_of(w.calls, "LoadAllAssets"))
    t:no(index_of(w.calls, "FreeAllAssets"))
    t:eq(w.step("load_assets").reason, "not in profile")
    t:eq(w.step("unload_assets").reason, "not in profile")
    t:eq(w.manifest().data.assets_force_loaded, false)
    t:eq(w.status("objects"), "ok")
end

-- AC-3 with the real step list
function tests.failing_native_step_does_not_stop_later_steps(t)
    local w = world(t, { native = { DumpNames = function() return nil, "boom" end } })
    w.runner:start({ profile = "full" })
    t:eq(w.status("names"), "failed")
    t:eq(w.step("names").error, "boom")
    t:eq(w.status("scripts"), "ok")
    t:eq(w.status("unload_assets"), "ok", "assets are released after a failed middle step")
end

function tests.failed_load_skips_unload_and_keeps_going(t)
    local w = world(t, { native = { LoadAllAssets = function() return nil, "out of memory" end } })
    w.runner:start({ profile = "full" })
    t:eq(w.status("load_assets"), "failed")
    t:eq(w.manifest().data.assets_force_loaded, false)
    t:eq(w.status("objects"), "ok")
    t:eq(w.status("unload_assets"), "skipped")
    t:eq(w.step("unload_assets").reason, "assets were not loaded")
    t:no(index_of(w.calls, "FreeAllAssets"))
end

-- The engine collects garbage during a tick. In a real run a tick between two steps let
-- it remove loaded assets half way through, so later dumps lacked what earlier ones had.
function tests.the_game_gets_no_tick_while_assets_are_loaded(t)
    local w = world(t, { native = true })
    w.runner:start({ profile = "full" })
    local first, last = index_of(w.calls, "DumpAllActors"), index_of(w.calls, "FreeAllAssets")
    t:ok(first and last and first < last)
    t:ok(index_of(w.calls, "LoadAllAssets") > first)
    for i = first, last do
        t:no(w.calls[i] == "tick", "the game ticked between the first dump and the release, after " .. tostring(w.calls[i - 1]))
    end
    -- After the release the game gets its ticks again.
    local after = 0
    for i, entry in ipairs(w.calls) do
        if entry == "tick" and i > last then
            after = after + 1
        end
    end
    t:ok(after >= 2, "ticks after releasing: " .. after)
end

function tests.the_quick_profile_also_dumps_types_and_data_without_a_tick(t)
    local w = world(t, { native = true })
    w.runner:start({ profile = "quick" })
    local first, last = index_of(w.calls, "DumpAllActors"), index_of(w.calls, "DumpGameplayTags")
    for i = first, last do
        t:no(w.calls[i] == "tick", "tick inside the type and data dumps")
    end
end

function tests.load_assets_passes_the_mode_and_memory_floor(t)
    local seen
    local w = world(t, { native = { LoadAllAssets = function(mode, min_free_mb)
        seen = { mode = mode, min_free_mb = min_free_mb }
        return true
    end }, config = { load_assets = { mode = "all", min_free_memory_gb = 2.5 } } })
    w.runner:start({ only = { "load_assets" } })
    t:eq(seen.mode, "all")
    t:eq(seen.min_free_mb, 2560)
    t:eq(math.type(seen.min_free_mb), "integer", "the native side reads an integer")
end

function tests.load_assets_defaults_to_data_mode(t)
    local seen
    local w = world(t, { native = { LoadAllAssets = function(mode, min_free_mb)
        seen = { mode = mode, min_free_mb = min_free_mb }
        return true
    end } })
    w.runner:start({ only = { "load_assets" } })
    t:eq(seen.mode, "data")
    t:eq(seen.min_free_mb, 1536)
end

function tests.partial_load_is_recorded_and_released(t)
    -- The native loader stops at the memory limit: it reports failure but still holds
    -- the assets it loaded so far.
    local held = 0
    local w = world(t, { native = {
        LoadAllAssets = function() held = 5 return nil, "memory limit" end,
        HeldAssets = function() return held end,
        FreeAllAssets = function() held = 0 return true end,
    } })
    w.runner:start({ profile = "full" })
    t:eq(w.status("load_assets"), "failed")
    t:eq(w.step("load_assets").error, "memory limit")
    t:eq(w.manifest().data.assets_force_loaded, true, "the manifest says assets were loaded")
    t:eq(w.status("unload_assets"), "ok", "the held assets are released")
    t:eq(held, 0)
end

function tests.assets_left_by_an_earlier_run_can_be_released(t)
    local held = 3
    local w = world(t, { native = {
        HeldAssets = function() return held end,
        FreeAllAssets = function() held = 0 return true end,
    } })
    w.runner:start({ only = { "unload_assets" } })
    t:eq(w.status("unload_assets"), "ok")
    t:eq(held, 0)
end

function tests.leftover_from_a_crashed_run_is_restored_not_lost(t)
    -- A crash inside an earlier capture left a pre-existing file under its aside name.
    local w = world(t, { api = { DumpUSMAP = function() end } })
    t.support.write(w.working .. "\\Game-5.6-abc.usmap.gmf-aside", "older file")
    w.runner:start({ only = { "usmap" } })
    t:eq(w.status("usmap"), "failed", "nothing new was produced")
    t:eq(t.support.read(w.working .. "\\Game-5.6-abc.usmap"), "older file", "restored under its real name")
    t:no(w.fs.exists(w.working .. "\\Game-5.6-abc.usmap.gmf-aside"))
end

function tests.an_existing_aside_file_is_never_overwritten(t)
    local w = world(t)
    t.support.write(w.working .. "\\Game-5.6-abc.usmap", "current")
    t.support.write(w.working .. "\\Game-5.6-abc.usmap.gmf-aside", "older")
    w.runner:start({ only = { "usmap" } })
    t:eq(w.status("usmap"), "ok")
    t:eq(t.support.read(w.run_dir .. "\\Mappings\\Game-5.6-abc.usmap"), "u", "the new dump is collected")
    t:eq(t.support.read(w.working .. "\\Game-5.6-abc.usmap.gmf-aside"), "older", "the older aside file is untouched")
end

function tests.dumper_that_writes_nothing_is_failed(t)
    local w = world(t, { api = { DumpUSMAP = function() end } })
    w.runner:start({ only = { "usmap" } })
    t:eq(w.status("usmap"), "failed")
    t:eq(w.step("usmap").error, "no output found")
end

function tests.old_output_is_not_collected_and_is_put_back(t)
    local w = world(t, { api = { DumpUSMAP = function() end } })
    t.support.write(w.working .. "\\Game-5.6-abc.usmap", "old")
    w.runner:start({ only = { "usmap" } })
    t:eq(w.status("usmap"), "failed")
    t:eq(t.support.read(w.working .. "\\Game-5.6-abc.usmap"), "old", "the user's older file is restored")
    t:no(w.fs.exists(w.run_dir .. "\\Mappings\\Game-5.6-abc.usmap"))
end

function tests.old_output_does_not_block_a_new_one(t)
    local w = world(t)
    t.support.write(w.working .. "\\UE4SS_ObjectDump.txt", "old")
    w.runner:start({ only = { "objects" } })
    t:eq(w.status("objects"), "ok")
    t:eq(t.support.read(w.run_dir .. "\\Objects\\UE4SS_ObjectDump.txt"), "objects", "the new dump is collected")
end

function tests.raising_dumper_is_failed_with_its_message(t)
    local w = world(t, { api = { DumpJMAP = function() error("jmap exploded") end } })
    w.runner:start({ only = { "jmap", "usmap" } })
    t:eq(w.status("jmap"), "failed")
    t:ok(w.step("jmap").error:find("jmap exploded", 1, true))
    t:eq(w.status("usmap"), "ok")
end

function tests.missing_ue4ss_global_is_skipped(t)
    local w = world(t, { api = { DumpJMAP = false } })
    w.runner:start({ only = { "jmap" } })
    t:eq(w.status("jmap"), "skipped")
    t:ok(w.step("jmap").reason:find("DumpJMAP", 1, true))
end

function tests.config_reaches_the_dumpers(t)
    local w = world(t, { config = { include_blueprint_types = false, jmap_skip_property_values = true,
        also_write_shared_lua_types = false, disabled_steps = { "uht" } } })
    w.runner:start({ profile = "quick" })
    t:ok(index_of(w.calls, "DumpUSMAP false"))
    t:ok(index_of(w.calls, "DumpJMAP false true"))
    t:eq(w.step("uht").reason, "disabled")
    t:no(w.fs.exists(w.mods .. "\\shared\\types\\Engine.lua"), "shared copy turned off")
    t:ok(w.fs.exists(w.run_dir .. "\\LuaTypes\\Engine.lua"))
end

function tests.bpsdk_collects_a_manually_generated_sdk(t)
    local w = world(t)
    t.support.mkdir(w.working .. "\\UE4SS_SDK")
    t.support.write(w.working .. "\\UE4SS_SDK\\CMakeLists.txt", "x")
    w.runner:start({ only = { "bpsdk" } })
    t:eq(w.status("bpsdk"), "ok")
    t:ok(w.fs.exists(w.run_dir .. "\\SDK\\UE4SS_SDK\\CMakeLists.txt"))
    t:no(w.fs.exists(w.working .. "\\UE4SS_SDK"))
end

function tests.bpsdk_native_unavailable_falls_back_to_skip(t)
    local w = world(t, { native = { GenerateBPSDK = function() return nil, "not available in this build" end } })
    w.runner:start({ only = { "bpsdk" } })
    t:eq(w.status("bpsdk"), "skipped")
    t:ok(w.step("bpsdk").reason:find("Generate BP SDK", 1, true))
end

function tests.containers_lists_the_content_files(t)
    local w = world(t)
    w.runner:start({ only = { "containers" } })
    t:eq(w.status("containers"), "ok", tostring(w.step("containers").error or w.step("containers").reason))
    local data = require("dkjson").decode(t.support.read(w.run_dir .. "\\Assets\\containers.json"))
    t:eq(data.schema, "gmfdumper.containers/1")
    t:eq(data.count, 2)
    t:eq(data.total_bytes, 7)
    t:eq(data.files[1].path, "Game-Windows.pak")
    t:eq(data.files[1].bytes, 5)
    t:eq(data.files[2].path, "~mods/Mod_P.pak", "sub folders are listed with forward slashes")
end

function tests.containers_without_a_paks_folder_is_skipped(t)
    local w = world(t, { paks = false })
    w.runner:start({ only = { "containers" } })
    t:eq(w.status("containers"), "skipped")
    t:ok(w.step("containers").reason:find("Content\\Paks", 1, true), w.step("containers").reason)
end

function tests.hooks_state_file_holds_the_ini_values(t)
    local w = world(t)
    w.runner:start({ only = { "hooks" } })
    local text = t.support.read(w.run_dir .. "\\Hooks\\ue4ss_hooks.json")
    local data = require("dkjson").decode(text)
    t:eq(data.schema, "gmfdumper.ue4ss_hooks/1")
    t:eq(data.settings.HookProcessInternal, "1")
    t:eq(data.settings.HookLoadMap, "0")
    t:eq(data.settings.X, nil, "other sections are not read")
    t:eq(data.engine_tick_available, true)
    t:eq(data.process_event_available, false)
end

function tests.manifest_sizes_match_the_disk(t)
    local w = world(t, { native = true })
    w.runner:start({ profile = "full" })
    for _, step in ipairs(w.manifest().data.steps) do
        for _, file in ipairs(step.files) do
            local path = w.run_dir .. "\\" .. file.path:gsub("/", "\\")
            t:ok(w.fs.exists(path), "exists: " .. file.path)
            if file.dir then
                local bytes, count = w.fs.tree_stats(path)
                t:eq(file.bytes, bytes, file.path)
                t:eq(file.count, count, file.path)
            else
                t:eq(file.bytes, w.fs.size(path), file.path)
            end
        end
    end
end

function tests.relative_paths_use_forward_slashes(t)
    t:eq(collect.relative("C:\\a\\run", "C:\\a\\run\\Objects\\x.txt"), "Objects/x.txt")
    t:eq(collect.relative("C:\\a\\run", "c:\\A\\RUN\\Y"), "Y")
end

return tests
