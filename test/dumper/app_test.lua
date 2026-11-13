local App = require("gmfdumper.app")
local json = require("dkjson")

local tests = {}

-- A fake UE4SS: a game folder on disk and the globals app.lua uses.
local function install(t, options)
    options = options or {}
    local root = t.support.temp_dir("app") .. "\\Funnel Runners"
    local working = root .. "\\StormEscape\\Binaries\\Win64\\ue4ss"
    local mod_dir = working .. "\\Mods\\GmfDumper"
    t.support.mkdir(mod_dir)
    t.support.mkdir(working .. "\\Mods\\shared")
    t.support.write(working .. "\\UE4SS-settings.ini",
        options.ini or "[ObjectDumper]\nLoadAllAssetsBeforeDumpingObjects = 0\n")
    t.support.write(working .. "\\UE4SS.log", "x")
    if options.config then
        t.support.write(mod_dir .. "\\config.lua", options.config)
    end

    local printed, handlers, binds, queue = {}, {}, {}, {}
    local api = {
        print = function(text) printed[#printed + 1] = text end,
        Key = { NUM_ZERO = 0x60 },
        ModifierKey = { CONTROL = 0x11 },
        UnrealVersion = { GetMajor = function() return 5 end, GetMinor = function() return 6 end },
        UE4SS = { GetVersion = function() return 3, 0, 1 end },
        ExecuteInGameThread = function(fn)
            if options.deferred then
                queue[#queue + 1] = fn
            else
                fn()
            end
        end,
        RegisterConsoleCommandGlobalHandler = function(name, fn) handlers[name] = fn end,
        RegisterKeyBind = function(key, modifiers, fn)
            binds[#binds + 1] = { key = key, modifiers = modifiers, fn = fn }
        end,
        IsKeyBindRegistered = function() return options.key_taken == true end,
        DumpAllObjects = function() t.support.write(working .. "\\UE4SS_ObjectDump.txt", "o") end,
        DumpUSMAP = function() t.support.write(working .. "\\G.usmap", "u") end,
    }
    for name, value in pairs(options.api or {}) do
        api[name] = value
    end
    local app = App.install({ api = api, mod_dir = mod_dir })
    return {
        app = app, api = api, working = working, printed = printed, handlers = handlers, binds = binds,
        queue = queue,
        text = function() return table.concat(printed) end,
        latest = function(root_name)
            local text = t.support.read(working .. "\\" .. (root_name or "Dumps") .. "\\latest.txt")
            return text and (text:gsub("%s+$", ""))
        end,
    }
end

local function drain(queue)
    local i = 1
    while queue[i] do
        queue[i]()
        i = i + 1
    end
end

local function manifest_of(t, w, root_name)
    local run_dir = w.latest(root_name)
    t:ok(run_dir, "latest.txt written")
    return json.decode(t.support.read(run_dir .. "\\manifest.json")), run_dir
end

function tests.install_registers_command_and_key(t)
    local w = install(t)
    t:ok(w.handlers.gmfdump, "command registered")
    t:eq(#w.binds, 1)
    t:eq(w.binds[1].key, 0x60)
    t:eq(w.binds[1].modifiers[1], 0x11)
    t:ok(w.text():find("native part not available", 1, true))
    t:eq(w.app.working_dir, w.working)
end

function tests.bare_command_runs_the_default_profile(t)
    local w = install(t)
    t:eq(w.handlers.gmfdump("gmfdump", {}, nil), true)
    local data, run_dir = manifest_of(t, w)
    t:eq(data.profile, "full")
    t:eq(data.game, "StormEscape")
    t:eq(data.engine_version, "5.6")
    t:eq(data.ue4ss_version, "3.0.1")
    t:eq(data.mod_version, "0.1.0")
    t:ok(run_dir:find("\\Dumps\\StormEscape%-5%.6%-%d%d%d%d%d%d%d%d%-%d%d%d%d%d%d$"), run_dir)
    t:ok(t.support.read(run_dir .. "\\gmfdumper.log"):find("run started", 1, true), "run log written")
    t:ok(data.finished)
end

function tests.a_manual_run_ends_with_run_complete(t)
    local w = install(t)
    w.handlers.gmfdump("gmfdump", {}, nil)
    local _, run_dir = manifest_of(t, w)
    local data = json.decode(t.support.read(run_dir .. "\\run_complete.json") or "")
    t:ok(data, "run_complete.json written")
    t:eq(data.schema, "gmfdumper.run_complete/1")
    t:eq(data.profile, "full")
    t:eq(data.produced, true)
    t:eq(data.native, false)
    t:eq(data.game_left_open, true, "a manual run never closes the game")
    t:eq(data.steps_failed, 0)
end

function tests.default_profile_and_output_root_come_from_config(t)
    local w = install(t, { config = 'return { default_profile = "quick", output_root = "Out" }' })
    w.handlers.gmfdump("gmfdump", { "gmfdump" }, nil)
    local data = manifest_of(t, w, "Out")
    t:eq(data.profile, "quick")
end

function tests.step_names_run_only_those_steps(t)
    local w = install(t)
    w.handlers.gmfdump("gmfdump", { "USMAP", "objects" }, nil)
    local data = manifest_of(t, w)
    t:eq(data.profile, "custom")
    local ok = 0
    for _, step in ipairs(data.steps) do
        if step.status == "ok" then
            ok = ok + 1
        else
            t:eq(step.reason, "not requested", step.id)
        end
    end
    t:eq(ok, 2)
end

function tests.unknown_word_is_reported_and_nothing_runs(t)
    local w = install(t)
    local replies = {}
    w.app.handle_command({ "bogus" }, function(m) replies[#replies + 1] = m end)
    t:ok(replies[1]:find("unknown step: bogus", 1, true), replies[1])
    t:eq(w.latest(), nil)
end

function tests.list_prints_all_steps(t)
    local w = install(t)
    local replies = {}
    w.app.handle_command({ "list" }, function(m) replies[#replies + 1] = m end)
    t:eq(#replies, 31, "one header line and 30 steps")
    t:ok(table.concat(replies, "\n"):find("tmap  (needs the native DLL)", 1, true))
    t:eq(w.latest(), nil, "list does not start a run")
end

function tests.load_assets_alone_also_unloads(t)
    local calls = {}
    local natives = {
        GmfDumperNative_Version = function() return "0.1.0" end,
        GmfDumperNative_LoadAllAssets = function() calls[#calls + 1] = "load" return true end,
        GmfDumperNative_FreeAllAssets = function() calls[#calls + 1] = "free" return true end,
    }
    local w = install(t, { api = natives })
    w.handlers.gmfdump("gmfdump", { "load_assets", "usmap" }, nil)
    t:eq(table.concat(calls, ","), "load,free")
    local data = manifest_of(t, w)
    t:eq(data.assets_force_loaded, true)
    t:eq(data.native_version, "0.1.0")
    t:ok(w.text():find("Restart the game", 1, true), "restart advice printed")
end

function tests.native_version_mismatch_disables_native(t)
    local w = install(t, { api = { GmfDumperNative_Version = function() return "9.9.9" end } })
    t:eq(w.app.native, nil)
    t:ok(w.text():find("does not match", 1, true))
end

function tests.second_command_during_a_run_is_refused(t)
    local w = install(t, { deferred = true })
    local replies = {}
    t:ok(w.app.handle_command({ "quick" }, function(m) replies[#replies + 1] = m end))
    w.app.handle_command({ "quick" }, function(m) replies[#replies + 1] = m end)
    t:ok(replies[1] and replies[1]:find("run in progress", 1, true), tostring(replies[1]))
    drain(w.queue)
    t:no(w.app.runner:is_running())
end

function tests.key_press_starts_a_run_on_the_game_thread(t)
    local w = install(t, { deferred = true })
    w.binds[1].fn()
    t:eq(w.latest(), nil, "nothing happens on the input thread")
    drain(w.queue)
    t:ok(w.latest(), "the run happened once the game thread ran the queue")
end

function tests.taken_key_is_not_registered_again(t)
    local w = install(t, { key_taken = true })
    t:eq(#w.binds, 0)
    t:ok(w.text():find("already taken", 1, true))
end

function tests.double_load_setting_is_warned_about(t)
    local w = install(t, { ini = "[ObjectDumper]\nLoadAllAssetsBeforeDumpingObjects = 1\n" })
    w.handlers.gmfdump("gmfdump", { "usmap" }, nil)
    t:ok(w.text():find("LoadAllAssetsBefore", 1, true))
end

function tests.config_warnings_are_logged(t)
    local w = install(t, { config = 'return { default_profile = "bogus" }' })
    t:ok(w.text():find("config: default_profile", 1, true))
end

function tests.command_handler_never_raises(t)
    local w = install(t, { api = { ExecuteInGameThread = function() error("no game thread") end } })
    t:eq(w.handlers.gmfdump("gmfdump", {}, nil), true)
    t:ok(w.text():find("could not start", 1, true), w.text())
    t:no(w.app.runner:is_running(), "a failed start does not block later commands")
end

function tests.every_step_of_a_default_run_ends_ok_or_skipped(t)
    local w = install(t)
    w.handlers.gmfdump("gmfdump", {}, nil)
    local data = manifest_of(t, w)
    t:eq(#data.steps, 30)
    for _, step in ipairs(data.steps) do
        t:ok(step.status == "ok" or step.status == "skipped", step.id .. " is " .. step.status)
    end
end

function tests.messages_after_a_run_stay_out_of_its_log(t)
    local w = install(t)
    w.handlers.gmfdump("gmfdump", { "usmap" }, nil)
    local _, run_dir = manifest_of(t, w)
    local before = t.support.read(run_dir .. "\\gmfdumper.log")
    w.app.handle_command({ "bogus" }, w.app.log)
    t:eq(t.support.read(run_dir .. "\\gmfdumper.log"), before)
end

return tests
