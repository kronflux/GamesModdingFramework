-- The dump steps, in run order. Each step calls UE4SS's own dumper where one exists and a
-- native function otherwise, then reports the files it left in the run folder.

local collect = require("gmfdumper.collect")
local Levels = require("gmfdumper.levels")
local json = require("dkjson")

local Steps = {}

-- Steps that describe the level the player is in run first, before every asset is loaded.
-- Steps that describe data (tables, assets, configured defaults, UI) run while the assets
-- are loaded, so they cover the whole game and not only what the current level uses.
Steps.ORDER = {
    "world_actors", "world_meshes", "world_json", "runtime", "world_values",
    "load_assets",
    "objects", "usmap", "jmap", "tmap", "cxx", "uht", "luatypes", "bpsdk",
    "reflection", "names", "scripts", "hooks", "assets",
    "datatables", "data_assets", "asset_values", "config_objects", "class_defaults", "widgets", "gameplay_tags",
    "levels_loaded",
    "unload_assets",
    "containers", "environment",
}

-- The steps that describe the level the player is in. The map tour runs these again for
-- every map it opens, into World\<MapName> instead of World.
Steps.WORLD = { "world_actors", "world_meshes", "world_json", "runtime", "world_values" }

-- Where a step writes: the World folder can be redirected per map.
local function folder_for(ctx, folder)
    if folder == "World" and ctx.world_folder then
        return ctx.world_folder
    end
    return folder
end

local BOTH = { full = true, quick = true }
local FULL_ONLY = { full = true }

-- Calls a native function. Native functions return true, or nil and a message; a raised
-- error is turned into the same shape.
local function native_call(fn, ...)
    if not fn then
        return nil, "native function missing"
    end
    local results = table.pack(pcall(fn, ...))
    if not results[1] then
        return nil, tostring(results[2])
    end
    if not results[2] then
        return nil, tostring(results[3] or "native call failed")
    end
    return results[2]
end

-- How many assets the native part still holds pinned; 0 when it cannot say.
function Steps.held_assets(native)
    if not (native and native.HeldAssets) then
        return 0
    end
    local ok, count = pcall(native.HeldAssets)
    if ok and math.type(count) == "integer" then
        return count
    end
    return 0
end

-- A step whose whole job is one native function writing into one place of the run folder.
-- `file` names the one file the native function writes. Without it the function fills
-- the folder: every entry is listed, or with `as_folder` the folder is one manifest entry.
local function native_step(id, folder, file, function_name, as_folder)
    return {
        id = id,
        needs_native = true,
        profiles = BOTH,
        run = function(ctx)
            local dir = ctx.run_dir .. "\\" .. folder_for(ctx, folder)
            local made, mk_err = ctx.fs.mkdirs(dir)
            if not made then
                return nil, mk_err
            end
            local target = file and (dir .. "\\" .. file) or dir
            local ok, err = native_call(ctx.native[function_name], target)
            if not ok then
                return nil, err
            end
            if file or as_folder then
                return collect.entries(ctx.fs, ctx.run_dir, { target })
            end
            local paths = {}
            for _, name in ipairs(ctx.fs.list(dir)) do
                paths[#paths + 1] = dir .. "\\" .. name
            end
            table.sort(paths)
            return collect.entries(ctx.fs, ctx.run_dir, paths)
        end,
    }
end

-- A step that runs a UE4SS Lua global and collects what it wrote.
local function builtin_step(id, folder, global_name, matcher, source, rename, arguments)
    return {
        id = id,
        profiles = BOTH,
        run = function(ctx)
            local fn = ctx.api[global_name]
            if type(fn) ~= "function" then
                return "skip", global_name .. " is not available in this UE4SS build"
            end
            local source_dir = source and source(ctx) or ctx.working_dir
            return collect.capture(ctx.fs, ctx.run_dir, source_dir, matcher, ctx.run_dir .. "\\" .. folder_for(ctx, folder), function()
                fn(table.unpack(arguments and arguments(ctx) or {}))
            end, rename)
        end,
    }
end

local function fixed_name(name)
    return function()
        return name
    end
end

-- Reads one [Section] of an ini file into a table of key -> value strings.
local function read_ini_section(text, section)
    local values, current = {}, nil
    for line in (text or ""):gmatch("[^\r\n]+") do
        local header = line:match("^%s*%[([^%]]+)%]")
        if header then
            current = header
        elseif current == section and not line:match("^%s*[;#]") then
            local key, value = line:match("^%s*([%w_]+)%s*=%s*(.-)%s*$")
            if key then
                values[key] = value
            end
        end
    end
    return values
end
Steps.read_ini_section = read_ini_section

function Steps.build(env)
    local config = env.config or {}
    local has_native = env.native ~= nil
    local steps = {}

    steps.world_actors = builtin_step("world_actors", "World", "DumpAllActors",
        collect.name_matches("ue4ss_actor_data%.csv$"), nil, fixed_name("actors.csv"))

    steps.world_meshes = builtin_step("world_meshes", "World", "DumpStaticMeshes",
        collect.name_matches("ue4ss_static_mesh_data%.csv$"), nil, fixed_name("static_meshes.csv"))

    steps.world_json = native_step("world_json", "World", "actors.json", "DumpActors")

    steps.load_assets = {
        id = "load_assets",
        needs_native = true,
        profiles = FULL_ONLY,
        run = function(ctx)
            local settings = ctx.config.load_assets or {}
            local min_free_mb = math.floor((settings.min_free_memory_gb or 1.5) * 1024)
            local ok, err = native_call(ctx.native.LoadAllAssets, settings.mode or "data", min_free_mb)
            -- A load that stops half way, for example at the memory limit, still leaves
            -- assets pinned. Record that, so they are released and the user is told.
            if ok or Steps.held_assets(ctx.native) > 0 then
                ctx.state.assets_loaded = true
                ctx.manifest:header({ assets_force_loaded = true })
            end
            if not ok then
                return nil, err
            end
            return {}
        end,
    }

    if has_native then
        steps.objects = native_step("objects", "Objects", "UE4SS_ObjectDump.txt", "DumpObjects")
        steps.objects.needs_native = false
    else
        steps.objects = builtin_step("objects", "Objects", "DumpAllObjects",
            collect.name_is("UE4SS_ObjectDump.txt"), function(ctx)
                return ctx.object_dump_dir or ctx.working_dir
            end)
    end

    steps.usmap = builtin_step("usmap", "Mappings", "DumpUSMAP", collect.name_matches("%.usmap$"), nil, nil,
        function(ctx)
            return { ctx.config.include_blueprint_types ~= false }
        end)

    steps.jmap = builtin_step("jmap", "Mappings", "DumpJMAP", collect.name_matches("%.jmap$"), nil, nil,
        function(ctx)
            return { ctx.config.include_blueprint_types ~= false, ctx.config.jmap_skip_property_values == true }
        end)

    steps.tmap = native_step("tmap", "Mappings", nil, "GenerateTMapOverrides")
    -- The Mappings folder also holds the usmap and jmap; report only the two override files.
    do
        local run_native = steps.tmap.run
        steps.tmap.run = function(ctx)
            local files, err = run_native(ctx)
            if not files then
                return nil, err
            end
            local kept = {}
            for _, file in ipairs(files) do
                if file.path:find("TMapOverrides%.json$") then
                    kept[#kept + 1] = file
                end
            end
            if #kept == 0 then
                return nil, "no output found"
            end
            return kept
        end
    end

    if has_native then
        steps.cxx = native_step("cxx", "Headers\\CXX", nil, "GenerateCXX")
        steps.cxx.needs_native = false
        steps.cxx.run = function(ctx)
            local dir = ctx.run_dir .. "\\Headers\\CXX"
            local made, mk_err = ctx.fs.mkdirs(dir)
            if not made then
                return nil, mk_err
            end
            local ok, err = native_call(ctx.native.GenerateCXX, dir)
            if not ok then
                return nil, err
            end
            return collect.entries(ctx.fs, ctx.run_dir, { dir })
        end
    else
        steps.cxx = builtin_step("cxx", "Headers", "GenerateSDK", collect.name_is("CXXHeaderDump"), nil,
            fixed_name("CXX"))
    end

    steps.uht = builtin_step("uht", "Headers", "GenerateUHTCompatibleHeaders", collect.name_is("UHTHeaderDump"),
        nil, fixed_name("UHT"))

    steps.luatypes = {
        id = "luatypes",
        profiles = BOTH,
        run = function(ctx)
            local dir = ctx.run_dir .. "\\LuaTypes"
            local shared = ctx.mods_dir .. "\\shared"
            local files, err
            if ctx.native and ctx.native.GenerateLuaTypes then
                local made, mk_err = ctx.fs.mkdirs(dir)
                if not made then
                    return nil, mk_err
                end
                local ok, native_err = native_call(ctx.native.GenerateLuaTypes, dir)
                if not ok then
                    return nil, native_err
                end
                files, err = collect.entries(ctx.fs, ctx.run_dir, { dir })
            else
                local fn = ctx.api.GenerateLuaTypes
                if type(fn) ~= "function" then
                    return "skip", "GenerateLuaTypes is not available in this UE4SS build"
                end
                files, err = collect.capture(ctx.fs, ctx.run_dir, shared, collect.name_is("types"), ctx.run_dir,
                    function() fn() end, fixed_name("LuaTypes"))
            end
            if not files then
                return nil, err
            end
            if files[1].count == 0 then
                return nil, "no output found"
            end
            if ctx.config.also_write_shared_lua_types ~= false then
                local copied, copy_err = ctx.fs.copy_tree(dir, shared .. "\\types")
                if not copied then
                    ctx.log("luatypes: could not copy to Mods\\shared\\types: " .. tostring(copy_err))
                end
            end
            return files
        end,
    }

    steps.bpsdk = {
        id = "bpsdk",
        profiles = BOTH,
        run = function(ctx)
            local dir = ctx.run_dir .. "\\SDK"
            local native_err
            if ctx.native and ctx.native.GenerateBPSDK then
                local made, mk_err = ctx.fs.mkdirs(dir)
                if not made then
                    return nil, mk_err
                end
                local ok, err = native_call(ctx.native.GenerateBPSDK, dir, ctx.config.bpsdk_backend or "UE4SS")
                if ok then
                    return collect.entries(ctx.fs, ctx.run_dir, { dir .. "\\UE4SS_SDK" })
                end
                native_err = err
            end
            -- Without a native generator, collect an SDK the user generated with the
            -- "Generate BP SDK" button in the UE4SS window.
            local manual = ctx.working_dir .. "\\UE4SS_SDK"
            if ctx.fs.exists(manual) then
                local made, mk_err = ctx.fs.mkdirs(dir)
                if not made then
                    return nil, mk_err
                end
                local moved, move_err = ctx.fs.move(manual, dir .. "\\UE4SS_SDK")
                if not moved then
                    return nil, move_err
                end
                return collect.entries(ctx.fs, ctx.run_dir, { dir .. "\\UE4SS_SDK" })
            end
            if native_err and not native_err:find("not available", 1, true) then
                return nil, native_err
            end
            return "skip", 'no SDK found: click "Generate BP SDK" in the UE4SS window, then run "gmfdump bpsdk"'
        end,
    }

    steps.reflection = native_step("reflection", "Reflection", nil, "DumpReflection")
    steps.names = native_step("names", "Names", "fnames.csv", "DumpNames")
    steps.scripts = native_step("scripts", "Scripts", "bytecode.jsonl", "DumpScripts")

    steps.hooks = {
        id = "hooks",
        profiles = BOTH,
        run = function(ctx)
            local dir = ctx.run_dir .. "\\Hooks"
            local made, mk_err = ctx.fs.mkdirs(dir)
            if not made then
                return nil, mk_err
            end
            local settings = read_ini_section(ctx.fs.read(ctx.working_dir .. "\\UE4SS-settings.ini"), "Hooks")
            local state = {
                schema = "gmfdumper.ue4ss_hooks/1",
                settings = settings,
                engine_tick_available = ctx.api.EngineTickAvailable == true,
                process_event_available = ctx.api.ProcessEventAvailable == true,
            }
            local state_path = dir .. "\\ue4ss_hooks.json"
            local wrote, write_err = ctx.fs.write_atomic(state_path, json.encode(state, { indent = true }) .. "\n")
            if not wrote then
                return nil, write_err
            end
            local paths = { state_path }
            if ctx.native and ctx.native.DumpHooks then
                local ok, err = native_call(ctx.native.DumpHooks, dir)
                if not ok then
                    return nil, err
                end
                paths[#paths + 1] = dir .. "\\hookable_functions.json"
            end
            return collect.entries(ctx.fs, ctx.run_dir, paths)
        end,
    }

    steps.assets = native_step("assets", "Assets", "asset_registry.json", "DumpAssetRegistry")

    steps.runtime = native_step("runtime", "World", "runtime.json", "DumpRuntime")
    steps.world_values = native_step("world_values", "World", "actor_values.jsonl", "DumpWorldValues")
    steps.datatables = native_step("datatables", "DataTables", nil, "DumpDataTables", true)
    steps.data_assets = native_step("data_assets", "DataAssets", nil, "DumpDataAssets")
    steps.asset_values = native_step("asset_values", "Assets", "asset_values.jsonl", "DumpAssetValues")
    steps.asset_values.profiles = FULL_ONLY
    steps.config_objects = native_step("config_objects", "Config", "config_objects.jsonl", "DumpConfigObjects")
    steps.class_defaults = native_step("class_defaults", "Reflection", "class_defaults.jsonl", "DumpClassDefaults")
    steps.class_defaults.profiles = FULL_ONLY
    steps.widgets = native_step("widgets", "UI", "widget_trees.json", "DumpWidgetTrees")
    steps.gameplay_tags = native_step("gameplay_tags", "Names", "gameplay_tags.txt", "DumpGameplayTags")

    -- The game content files on disk, with sizes. Asset tools that read pak and IoStore
    -- containers need this list; it also records which content build the dump belongs to.
    steps.containers = {
        id = "containers",
        profiles = BOTH,
        run = function(ctx)
            local project = ctx.working_dir:match("^(.*)[\\/][Bb]inaries[\\/]")
            if not project then
                return "skip", "the game folder layout is not <Project>\\Binaries\\..."
            end
            local paks = project .. "\\Content\\Paks"
            if not ctx.fs.is_dir(paks) then
                return "skip", "no Content\\Paks folder at " .. paks
            end
            local files, total = {}, 0
            local function scan(dir, relative, depth)
                local names = ctx.fs.list(dir)
                table.sort(names)
                for _, name in ipairs(names) do
                    local path = dir .. "\\" .. name
                    local rel = relative == "" and name or (relative .. "/" .. name)
                    if ctx.fs.is_dir(path) then
                        if depth < 3 then
                            scan(path, rel, depth + 1)
                        end
                    else
                        local bytes = ctx.fs.size(path) or 0
                        total = total + bytes
                        files[#files + 1] = { path = rel, bytes = bytes }
                    end
                end
            end
            scan(paks, "", 0)
            local dir = ctx.run_dir .. "\\Assets"
            local made, mk_err = ctx.fs.mkdirs(dir)
            if not made then
                return nil, mk_err
            end
            local document = {
                schema = "gmfdumper.containers/1",
                folder = paks,
                total_bytes = total,
                count = #files,
                files = setmetatable(files, { __jsontype = "array" }),
            }
            local target = dir .. "\\containers.json"
            local wrote, write_err = ctx.fs.write_atomic(target,
                json.encode(document, { indent = true, keyorder = { "schema", "folder", "count", "total_bytes", "files", "path", "bytes" } }) .. "\n")
            if not wrote then
                return nil, write_err
            end
            return collect.entries(ctx.fs, ctx.run_dir, { target })
        end,
    }

    -- The maps that are in memory now, written as levels before the assets are released.
    -- The other maps follow after the run; see levels.lua.
    steps.levels_loaded = {
        id = "levels_loaded",
        needs_native = true,
        profiles = FULL_ONLY,
        run = function(ctx)
            local settings = ctx.config.levels
            if not (settings and settings.enabled) then
                return "skip", "levels.enabled is false"
            end
            if not (ctx.native.ListLoadedMaps and ctx.native.DumpLevel) then
                return "skip", "the native part has no level functions"
            end
            local levels = Levels.new({
                api = ctx.api, native = ctx.native, fs = ctx.fs, config = settings, log = ctx.log,
                min_free_mb = math.floor(((ctx.config.load_assets or {}).min_free_memory_gb or 1.5) * 1024),
            })
            -- Kept for the part that runs after the main run, so no map is written twice.
            ctx.state.levels = levels
            return levels:dump_loaded(ctx.run_dir)
        end,
    }

    steps.unload_assets = {
        id = "unload_assets",
        needs_native = true,
        profiles = FULL_ONLY,
        run = function(ctx)
            -- The native count also covers assets an earlier run left pinned.
            if not ctx.state.assets_loaded and Steps.held_assets(ctx.native) == 0 then
                return "skip", "assets were not loaded"
            end
            local ok, err = native_call(ctx.native.FreeAllAssets)
            if not ok then
                return nil, err
            end
            ctx.state.assets_loaded = false
            return {}
        end,
    }

    steps.environment = {
        id = "environment",
        profiles = BOTH,
        run = function(ctx)
            local dir = ctx.run_dir .. "\\Environment"
            local made, mk_err = ctx.fs.mkdirs(dir)
            if not made then
                return nil, mk_err
            end
            local paths = {}
            for _, name in ipairs({ "UE4SS-settings.ini", "UE4SS.log" }) do
                local from = ctx.working_dir .. "\\" .. name
                if ctx.fs.exists(from) and ctx.fs.copy(from, dir .. "\\" .. name) then
                    paths[#paths + 1] = dir .. "\\" .. name
                end
            end
            return collect.entries(ctx.fs, ctx.run_dir, paths)
        end,
    }

    local disabled = {}
    for _, id in ipairs(config.disabled_steps or {}) do
        disabled[id] = true
    end

    -- From the first dump to the last one that reads game objects, the game must not get
    -- a tick. The engine collects garbage in a tick: it would remove loaded assets the
    -- game itself does not use, and the level could change between two files that are
    -- meant to describe the same moment. Every step up to the release of the assets is
    -- marked `hold`, so the runner goes from one to the next without yielding.
    local ordered = {}
    local holding = true
    for _, id in ipairs(Steps.ORDER) do
        local step = steps[id]
        step.id = id
        step.disabled = disabled[id] or nil
        if id == "unload_assets" then
            holding = false
        end
        step.hold = holding or nil
        ordered[#ordered + 1] = step
    end
    return ordered
end

return Steps
