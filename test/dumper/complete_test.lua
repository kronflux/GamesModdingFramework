local Fs = require("gmfdumper.fs")
local Manifest = require("gmfdumper.manifest")
local json = require("dkjson")

local tests = {}

local function complete(t, dir)
    local text = t.support.read(dir .. "\\run_complete.json")
    t:ok(text, "run_complete.json exists")
    local data, _, err = json.decode(text)
    t:ok(data, "run_complete.json decodes: " .. tostring(err))
    return data
end

function tests.finished_full_run_writes_counts_and_produced_true(t)
    local dir = t.support.temp_dir("complete")
    local m = Manifest.new(Fs.new(nil), dir, { profile = "full" }, { "a", "b", "c", "d" })
    m:set("a", { status = "ok" })
    m:set("b", { status = "ok" })
    m:set("c", { status = "skipped", reason = "not needed" })
    m:set("d", { status = "failed", error = "boom" })
    m:finish()
    t:ok(m:write_run_complete({ profile = "full", levels_ok = 21, levels_total = 22, native = true,
        game_left_open = false }))
    local data = complete(t, dir)
    t:eq(data.schema, "gmfdumper.run_complete/1")
    t:eq(data.profile, "full")
    t:eq(data.produced, true)
    t:eq(data.steps_ok, 2)
    t:eq(data.steps_failed, 1)
    t:eq(data.steps_skipped, 1)
    t:eq(data.levels_ok, 21)
    t:eq(data.levels_total, 22)
    t:eq(data.native, true)
    t:eq(data.game_left_open, false)
    t:ok(data.finished:match("^%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%d$"), "finished is a time")
end

function tests.run_that_produced_nothing_says_so(t)
    local dir = t.support.temp_dir("complete")
    local m = Manifest.new(Fs.new(nil), dir, { profile = "full" }, { "a", "b" })
    m:set("a", { status = "failed", error = "x" })
    m:set("b", { status = "skipped", reason = "y" })
    m:finish()
    t:ok(m:write_run_complete({ profile = "full", native = false, game_left_open = true }))
    local data = complete(t, dir)
    t:eq(data.produced, false)
    t:eq(data.steps_ok, 0)
    t:eq(data.levels_ok, 0)
    t:eq(data.levels_total, 0)
    t:eq(data.native, false)
    t:eq(data.game_left_open, true)
end

function tests.profile_comes_from_the_manifest_and_pending_steps_are_counted(t)
    local dir = t.support.temp_dir("complete")
    local m = Manifest.new(Fs.new(nil), dir, { profile = "custom" }, { "a", "b" })
    m:set("a", { status = "ok" })
    m:write_run_complete({})
    local data = complete(t, dir)
    t:eq(data.profile, "custom", "the same word manifest.json uses")
    t:eq(data.steps_pending, 1)
end

function tests.a_run_that_could_not_start_still_leaves_run_complete(t)
    local dir = t.support.temp_dir("complete")
    t:ok(Manifest.write_failed_run(Fs.new(nil), dir, { profile = "full", native = true, reason = "disk full" }))
    local data = complete(t, dir)
    t:eq(data.schema, "gmfdumper.run_complete/1")
    t:eq(data.produced, false)
    t:eq(data.steps_ok, 0)
    t:eq(data.native, true)
    t:eq(data.game_left_open, true)
    t:eq(data.reason, "disk full")
end

return tests
